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
    AUDIO_CODEC_OPUS,
    AUDIO_SERVER_FILE_NAME,
    AUDIO_SERVER_VERSION,
    AudioStreamConfig,
} from '../../../common/AudioStream';

const TAG = '[ScrcpyAudioProxy]';
const FILE_DIR = path.join(__dirname, 'vendor/Genymobile/scrcpy');
const DEVICE_PATH = `/data/local/tmp/${AUDIO_SERVER_FILE_NAME}`;

// The server needs a moment to start listening. Until it does, connections to
// the adb forward succeed and are closed right away, which is why scrcpy sends
// a dummy byte on the first socket of a forward tunnel.
const CONNECT_ATTEMPTS = 50;
const CONNECT_RETRY_MS = 100;

const CODEC_DISABLED = 0;
const CODEC_ERROR = 1;
const FRAME_HEADER_LENGTH = 12;

/**
 * Streams device audio to the browser.
 *
 * The video stream uses ws-scrcpy's own scrcpy-server fork, which predates
 * scrcpy's audio support. Rather than replacing it, this starts a second,
 * audio-only instance of upstream scrcpy-server (`video=false control=false`)
 * next to it, so audio stays optional and cannot break video.
 *
 * Request: `?action=stream-audio&udid=<serial>`.
 *
 * The first message is a JSON {@link AudioStreamConfig}. Every following
 * binary message is one scrcpy media packet: its 8-byte PTS and flags header
 * followed by the encoded payload. The socket closes with code 4005 and the
 * server output as the reason when audio cannot be captured (for example on
 * Android 10 and older).
 */
export class ScrcpyAudioProxy extends Mw {
    public static readonly TAG = TAG;

    private readonly scid = Math.floor(Math.random() * 0x7fffffff)
        .toString(16)
        .padStart(8, '0');
    private released = false;
    private serverProcess?: ChildProcess;
    private serverOutput = '';
    private socket?: net.Socket;
    private forwardPort?: number;

    public static processRequest(ws: WS, params: RequestParameters): ScrcpyAudioProxy | undefined {
        const { action, url } = params;
        if (action !== ACTION.STREAM_AUDIO) {
            return;
        }
        const udid = url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, `${TAG} Invalid value "${udid}" for "udid" parameter`);
            return;
        }
        return new ScrcpyAudioProxy(ws, udid);
    }

    private constructor(ws: WS, private readonly udid: string) {
        super(ws);
        this.name = `${TAG}{${udid}}`;
        this.start().catch((error: Error) => {
            this.fail(error.message);
        });
    }

    protected onSocketMessage(): void {
        // The audio stream is one-way.
    }

    private async start(): Promise<void> {
        await this.pushServer();
        if (this.released) {
            return;
        }
        this.forwardPort = await AdbUtils.forward(this.udid, `localabstract:scrcpy_${this.scid}`);
        this.startServer();
        const socket = await this.connect(this.forwardPort);
        if (this.released) {
            socket.destroy();
            return;
        }
        this.socket = socket;
        this.pipe(socket);
    }

    private async pushServer(): Promise<void> {
        const client = AdbExtended.createClient();
        const transfer = await client.push(this.udid, path.join(FILE_DIR, AUDIO_SERVER_FILE_NAME), DEVICE_PATH);
        await new Promise<void>((resolve, reject) => {
            transfer.on('end', resolve);
            transfer.on('error', reject);
        });
    }

    private startServer(): void {
        const args = [
            `scid=${this.scid}`,
            'log_level=warn',
            'tunnel_forward=true',
            'video=false',
            'control=false',
            'audio=true',
            'audio_codec=opus',
            'send_device_meta=false',
            'cleanup=false',
        ];
        const command = `CLASSPATH=${DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${AUDIO_SERVER_VERSION} ${args.join(
            ' ',
        )}`;
        const server = spawn('adb', ['-s', this.udid, 'shell', command], { stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = (data: Buffer) => {
            this.serverOutput = (this.serverOutput + data.toString()).slice(-2000);
        };
        server.stdout.on('data', collect);
        server.stderr.on('data', collect);
        server.on('error', (error: Error) => this.fail(`Failed to start audio server: ${error.message}`));
        server.on('close', () => {
            this.serverProcess = undefined;
            this.fail(this.serverOutput.trim() || 'Audio server exited');
        });
        this.serverProcess = server;
    }

    private async connect(port: number): Promise<net.Socket> {
        for (let attempt = 0; attempt < CONNECT_ATTEMPTS && !this.released; attempt++) {
            const socket = await this.tryConnect(port);
            if (socket) {
                return socket;
            }
            await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
        }
        throw new Error(this.serverOutput.trim() || 'Timed out connecting to audio server');
    }

    /** Resolves with a socket once the server's dummy byte arrives, or undefined if it is not listening yet. */
    private tryConnect(port: number): Promise<net.Socket | undefined> {
        return new Promise((resolve) => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            const onData = (data: Buffer) => {
                socket.off('data', onData);
                socket.off('close', onClose);
                socket.pause();
                if (data.length > 1) {
                    socket.unshift(data.subarray(1));
                }
                resolve(socket);
            };
            const onClose = () => resolve(undefined);
            socket.on('data', onData);
            socket.once('close', onClose);
            socket.once('error', () => socket.destroy());
        });
    }

    private pipe(socket: net.Socket): void {
        let buffer = Buffer.alloc(0);
        let codec: number | undefined;
        socket.on('data', (data: Buffer) => {
            buffer = buffer.length ? Buffer.concat([buffer, data]) : data;
            if (codec === undefined) {
                if (buffer.length < 4) {
                    return;
                }
                codec = buffer.readUInt32BE(0);
                buffer = buffer.subarray(4);
                if (codec === CODEC_DISABLED || codec === CODEC_ERROR) {
                    // The server explains why on its output, then exits.
                    socket.destroy();
                    return;
                }
                if (codec !== AUDIO_CODEC_OPUS) {
                    this.fail(`Unexpected audio codec 0x${codec.toString(16)}`);
                    return;
                }
                const config: AudioStreamConfig = { type: 'audio-config', codec: 'opus' };
                this.ws.send(JSON.stringify(config));
            }
            while (buffer.length >= FRAME_HEADER_LENGTH) {
                const size = buffer.readUInt32BE(8);
                if (buffer.length < FRAME_HEADER_LENGTH + size) {
                    break;
                }
                const packet = Buffer.concat([
                    buffer.subarray(0, 8),
                    buffer.subarray(FRAME_HEADER_LENGTH, FRAME_HEADER_LENGTH + size),
                ]);
                buffer = buffer.subarray(FRAME_HEADER_LENGTH + size);
                if (this.ws.readyState === this.ws.OPEN) {
                    this.ws.send(packet);
                }
            }
        });
        socket.once('close', () => {
            // Give the server a moment to exit, so the close reason can carry
            // its explanation (e.g. "not supported before Android 11").
            setTimeout(() => this.fail(this.serverOutput.trim() || 'Audio stream ended'), 1000);
        });
        socket.once('error', (error: Error) => this.fail(error.message));
        socket.resume();
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
        this.socket?.destroy();
        // The server exits once its socket closes, but it never sees one if we
        // gave up before connecting, so stop it explicitly as well.
        spawn('adb', ['-s', this.udid, 'shell', `pkill -f scid=${this.scid}`], { stdio: 'ignore' });
        this.serverProcess?.kill();
        if (this.forwardPort) {
            spawn('adb', ['-s', this.udid, 'forward', '--remove', `tcp:${this.forwardPort}`], { stdio: 'ignore' });
        }
    }
}
