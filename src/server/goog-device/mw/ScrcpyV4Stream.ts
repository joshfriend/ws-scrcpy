import '../../../../vendor/Genymobile/scrcpy/scrcpy-server-v4.0.jar';

import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import WS from 'ws';
import { Mw, RequestParameters } from '../../mw/Mw';
import { ACTION } from '../../../common/Action';
import { AdbExtended } from '../adb';
import { AdbUtils } from '../AdbUtils';
import {
    SCRCPY_V4_SERVER_FILE_NAME,
    SCRCPY_V4_SERVER_VERSION,
    ScrcpyV4Channel,
    ScrcpyV4Event,
} from '../../../common/ScrcpyV4';

const TAG = '[ScrcpyV4Stream]';
const FILE_DIR = path.join(__dirname, 'vendor/Genymobile/scrcpy');
const DEVICE_PATH = `/data/local/tmp/${SCRCPY_V4_SERVER_FILE_NAME}`;

// The server needs a moment to start listening. Until it does, connections to
// the adb forward succeed and are closed right away, which is why scrcpy sends
// a dummy byte on the first socket of a forward tunnel.
const CONNECT_ATTEMPTS = 50;
const CONNECT_RETRY_MS = 100;

const DEVICE_NAME_LENGTH = 64;
const FRAME_HEADER_LENGTH = 12;
const SESSION_PACKET_FLAG = 0x80;
const AUDIO_CODEC_DISABLED = 0;
const AUDIO_CODEC_ERROR = 1;
const DEVICE_MESSAGE_CLIPBOARD = 0;
const DEVICE_MESSAGE_ACK_CLIPBOARD = 1;
const DEVICE_MESSAGE_UHID_OUTPUT = 2;

/** Reads exact byte counts from a socket. */
class SocketReader {
    private chunks: Buffer[] = [];
    private length = 0;
    private waiting?: () => void;
    private ended = false;

    constructor(socket: net.Socket) {
        socket.on('data', (data: Buffer) => {
            this.chunks.push(data);
            this.length += data.length;
            this.waiting?.();
        });
        socket.on('close', () => {
            this.ended = true;
            this.waiting?.();
        });
        socket.resume();
    }

    public async read(n: number): Promise<Buffer> {
        while (this.length < n) {
            if (this.ended) {
                throw new Error('socket closed');
            }
            await new Promise<void>((resolve) => (this.waiting = resolve));
            this.waiting = undefined;
        }
        const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
        const result = all.subarray(0, n);
        const rest = all.subarray(n);
        this.chunks = rest.length ? [rest] : [];
        this.length = rest.length;
        return result;
    }
}

type StreamOptions = {
    maxSize: number;
    videoBitRate: number;
    maxFps: number;
    audio: boolean;
};

function parseNonNegativeInt(value: string | null, fallback: number): number {
    const parsed = value === null ? NaN : parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Mirrors a device with upstream scrcpy-server v4.0: video, audio and control
 * in one session per WebSocket. Each viewer gets its own server instance (a
 * random scid), which exits when the viewer disconnects.
 *
 * Request: `?action=stream-v4&udid=<serial>[&max_size=][&video_bit_rate=][&max_fps=][&audio=false]`.
 * See src/common/ScrcpyV4.ts for the message format.
 */
export class ScrcpyV4Stream extends Mw {
    public static readonly TAG = TAG;

    private readonly scid = Math.floor(Math.random() * 0x7fffffff)
        .toString(16)
        .padStart(8, '0');
    private released = false;
    private serverProcess?: ChildProcess;
    private serverOutput = '';
    private sockets: net.Socket[] = [];
    private controlSocket?: net.Socket;
    private forwardPort?: number;

    public static processRequest(ws: WS, params: RequestParameters): ScrcpyV4Stream | undefined {
        const { action, url } = params;
        if (action !== ACTION.STREAM_SCRCPY_V4) {
            return;
        }
        const udid = url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, `${TAG} Invalid value "${udid}" for "udid" parameter`);
            return;
        }
        const options: StreamOptions = {
            maxSize: parseNonNegativeInt(url.searchParams.get('max_size'), 0),
            videoBitRate: parseNonNegativeInt(url.searchParams.get('video_bit_rate'), 8000000),
            maxFps: parseNonNegativeInt(url.searchParams.get('max_fps'), 60),
            audio: url.searchParams.get('audio') !== 'false',
        };
        return new ScrcpyV4Stream(ws, udid, options);
    }

    private constructor(ws: WS, private readonly udid: string, private readonly options: StreamOptions) {
        super(ws);
        this.name = `${TAG}{${udid}}`;
        this.start().catch((error: Error) => {
            this.fail(error.message);
        });
    }

    /** Control messages from the browser go to the device unchanged. */
    protected onSocketMessage(event: WS.MessageEvent): void {
        if (this.controlSocket && Buffer.isBuffer(event.data)) {
            this.controlSocket.write(event.data);
        }
    }

    private async start(): Promise<void> {
        await this.pushServer();
        if (this.released) {
            return;
        }
        this.forwardPort = await AdbUtils.forward(this.udid, `localabstract:scrcpy_${this.scid}`);
        this.startServer();

        // Sockets must be opened in this order: video, audio, control.
        const video = await this.connectFirst(this.forwardPort);
        const audio = this.options.audio ? await this.connect(this.forwardPort) : undefined;
        const control = await this.connect(this.forwardPort);
        if (this.released) {
            return;
        }
        this.controlSocket = control;

        const videoReader = new SocketReader(video);
        const deviceName = this.readDeviceName(await videoReader.read(DEVICE_NAME_LENGTH));
        const videoCodec = (await videoReader.read(4)).toString('latin1').replace(/\0/g, '');
        const audioReader = audio ? new SocketReader(audio) : undefined;
        let audioAvailable = false;
        if (audioReader) {
            const codec = (await audioReader.read(4)).readUInt32BE(0);
            audioAvailable = codec !== AUDIO_CODEC_DISABLED && codec !== AUDIO_CODEC_ERROR;
        }
        this.sendEvent({ type: 'meta', deviceName, videoCodec, audio: audioAvailable });

        video.once('close', () => this.fail(this.serverOutput.trim() || 'Video stream ended'));
        control.once('close', () => this.fail(this.serverOutput.trim() || 'Control stream ended'));
        void this.pumpVideo(videoReader);
        if (audioReader && audioAvailable) {
            void this.pumpAudio(audioReader);
        }
        void this.pumpDeviceMessages(new SocketReader(control));
    }

    private readDeviceName(data: Buffer): string {
        const end = data.indexOf(0);
        return data.subarray(0, end === -1 ? data.length : end).toString('utf8');
    }

    private async pumpVideo(reader: SocketReader): Promise<void> {
        try {
            for (;;) {
                const header = await reader.read(FRAME_HEADER_LENGTH);
                if (header[0] & SESSION_PACKET_FLAG) {
                    this.sendEvent({ type: 'session', width: header.readUInt32BE(4), height: header.readUInt32BE(8) });
                    continue;
                }
                const payload = await reader.read(header.readUInt32BE(8));
                this.sendPacket(ScrcpyV4Channel.VIDEO, header, payload);
            }
        } catch {
            // The socket closed; its close handler ends the session.
        }
    }

    private async pumpAudio(reader: SocketReader): Promise<void> {
        try {
            for (;;) {
                const header = await reader.read(FRAME_HEADER_LENGTH);
                const payload = await reader.read(header.readUInt32BE(8));
                this.sendPacket(ScrcpyV4Channel.AUDIO, header, payload);
            }
        } catch {
            // Audio ending on its own (e.g. capture failed) leaves video running.
        }
    }

    private async pumpDeviceMessages(reader: SocketReader): Promise<void> {
        try {
            for (;;) {
                const type = (await reader.read(1))[0];
                if (type === DEVICE_MESSAGE_CLIPBOARD) {
                    const length = (await reader.read(4)).readUInt32BE(0);
                    this.sendEvent({ type: 'clipboard', text: (await reader.read(length)).toString('utf8') });
                } else if (type === DEVICE_MESSAGE_ACK_CLIPBOARD) {
                    await reader.read(8);
                } else if (type === DEVICE_MESSAGE_UHID_OUTPUT) {
                    await reader.read(2);
                    await reader.read((await reader.read(2)).readUInt16BE(0));
                } else {
                    throw new Error(`Unknown device message type ${type}`);
                }
            }
        } catch {
            // The socket closed; its close handler ends the session.
        }
    }

    private sendPacket(channel: ScrcpyV4Channel, header: Buffer, payload: Buffer): void {
        if (this.ws.readyState !== this.ws.OPEN) {
            return;
        }
        const message = Buffer.allocUnsafe(1 + 8 + payload.length);
        message[0] = channel;
        header.copy(message, 1, 0, 8);
        payload.copy(message, 9);
        this.ws.send(message);
    }

    private sendEvent(event: ScrcpyV4Event): void {
        if (this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(event));
        }
    }

    private async pushServer(): Promise<void> {
        const client = AdbExtended.createClient();
        const transfer = await client.push(this.udid, path.join(FILE_DIR, SCRCPY_V4_SERVER_FILE_NAME), DEVICE_PATH);
        await new Promise<void>((resolve, reject) => {
            transfer.on('end', resolve);
            transfer.on('error', reject);
        });
    }

    private startServer(): void {
        const { maxSize, videoBitRate, maxFps, audio } = this.options;
        const args = [
            `scid=${this.scid}`,
            'log_level=warn',
            'tunnel_forward=true',
            'video_codec=h264',
            `max_size=${maxSize}`,
            `video_bit_rate=${videoBitRate}`,
            `max_fps=${maxFps}`,
            `audio=${audio}`,
            'audio_codec=opus',
            'cleanup=false',
        ];
        const command = `CLASSPATH=${DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_V4_SERVER_VERSION} ${args.join(
            ' ',
        )}`;
        const server = spawn('adb', ['-s', this.udid, 'shell', command], { stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = (data: Buffer) => {
            this.serverOutput = (this.serverOutput + data.toString()).slice(-2000);
        };
        server.stdout.on('data', collect);
        server.stderr.on('data', collect);
        server.on('error', (error: Error) => this.fail(`Failed to start scrcpy server: ${error.message}`));
        server.on('close', () => {
            this.serverProcess = undefined;
            this.fail(this.serverOutput.trim() || 'scrcpy server exited');
        });
        this.serverProcess = server;
    }

    /** Connects the first socket, retrying until the server's dummy byte shows it is listening. */
    private async connectFirst(port: number): Promise<net.Socket> {
        for (let attempt = 0; attempt < CONNECT_ATTEMPTS && !this.released; attempt++) {
            const socket = await this.tryConnectFirst(port);
            if (socket) {
                return socket;
            }
            await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
        }
        throw new Error(this.serverOutput.trim() || 'Timed out connecting to scrcpy server');
    }

    private tryConnectFirst(port: number): Promise<net.Socket | undefined> {
        return new Promise((resolve) => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            const onData = (data: Buffer) => {
                socket.off('data', onData);
                socket.off('close', onClose);
                socket.pause();
                if (data.length > 1) {
                    socket.unshift(data.subarray(1));
                }
                this.track(socket);
                resolve(socket);
            };
            const onClose = () => resolve(undefined);
            socket.on('data', onData);
            socket.once('close', onClose);
            socket.once('error', () => socket.destroy());
        });
    }

    private connect(port: number): Promise<net.Socket> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            socket.once('connect', () => {
                this.track(socket);
                resolve(socket);
            });
            socket.once('error', reject);
        });
    }

    private track(socket: net.Socket): void {
        socket.setNoDelay(true);
        socket.on('error', () => socket.destroy());
        this.sockets.push(socket);
        if (this.released) {
            socket.destroy();
        }
    }

    private fail(message: string): void {
        if (this.released) {
            return;
        }
        console.error(this.name, message);
        if (this.ws.readyState === this.ws.OPEN) {
            // Close reasons are limited to 123 bytes.
            this.ws.close(4005, Buffer.from(message).subarray(0, 123).toString());
        }
        this.release();
    }

    public release(): void {
        if (this.released) {
            return;
        }
        this.released = true;
        super.release();
        this.sockets.forEach((socket) => socket.destroy());
        // The server exits once its sockets close, but it never sees them if we
        // gave up before connecting, so stop it explicitly as well.
        spawn('adb', ['-s', this.udid, 'shell', `pkill -f scid=${this.scid}`], { stdio: 'ignore' });
        this.serverProcess?.kill();
        if (this.forwardPort) {
            spawn('adb', ['-s', this.udid, 'forward', '--remove', `tcp:${this.forwardPort}`], { stdio: 'ignore' });
        }
    }
}
