import { ACTION } from '../../../common/Action';
import { ScrcpyV4Channel, ScrcpyV4Event, ScrcpyV4StreamOptions } from '../../../common/ScrcpyV4';
import { TypedEmitter } from '../../../common/TypedEmitter';
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import { ControlMessage } from '../../controlMessage/ControlMessage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { ScrollControlMessage } from '../../controlMessage/ScrollControlMessage';
import { TextControlMessage } from '../../controlMessage/TextControlMessage';
import { TouchControlMessage } from '../../controlMessage/TouchControlMessage';
import Position from '../../Position';

interface ScrcpyV4ClientEvents {
    meta: { deviceName: string; videoCodec: string; audio: boolean };
    session: { width: number; height: number };
    /** One H.264 packet in Annex B format, ready for a player's pushFrame(). */
    video: Uint8Array;
    /** One audio packet (8-byte header and Opus payload), ready for AudioPlayer.push(). */
    audio: Uint8Array;
    clipboard: string;
    disconnected: CloseEvent;
}

const TAG = '[ScrcpyV4Client]';
const INJECT_TEXT_MAX_LENGTH = 300;

function writePosition(buffer: Buffer, offset: number, position: Position): number {
    offset = buffer.writeInt32BE(position.point.x, offset);
    offset = buffer.writeInt32BE(position.point.y, offset);
    offset = buffer.writeUInt16BE(position.screenSize.width, offset);
    return buffer.writeUInt16BE(position.screenSize.height, offset);
}

/** scrcpy encodes scroll amounts in [-16, 16] as 16-bit fixed point over [-1, 1]. */
function scrollToFixedPoint(value: number): number {
    const normalized = Math.max(-1, Math.min(1, value / 16));
    return Math.max(-0x8000, Math.min(0x7fff, Math.round(normalized * 0x8000)));
}

/**
 * Serializes a ws-scrcpy control message in the scrcpy v4 wire format. Returns
 * undefined for messages v4 has no equivalent for (ws-scrcpy's own stream
 * parameters and file push commands): the v4 server stops at the first
 * message type it does not know, so those must never reach it.
 */
export function toScrcpyV4Buffer(message: ControlMessage): Buffer | undefined {
    if (message instanceof KeyCodeControlMessage) {
        return message.toBuffer();
    }
    if (message instanceof TextControlMessage) {
        let text = Buffer.from(message.text, 'utf8');
        if (text.length > INJECT_TEXT_MAX_LENGTH) {
            text = text.subarray(0, INJECT_TEXT_MAX_LENGTH);
        }
        const buffer = Buffer.alloc(1 + 4 + text.length);
        buffer.writeUInt8(message.type, 0);
        buffer.writeUInt32BE(text.length, 1);
        text.copy(buffer, 5);
        return buffer;
    }
    if (message instanceof TouchControlMessage) {
        const buffer = Buffer.alloc(32);
        let offset = buffer.writeUInt8(message.type, 0);
        offset = buffer.writeUInt8(message.action, offset);
        offset = buffer.writeBigInt64BE(BigInt(message.pointerId), offset);
        offset = writePosition(buffer, offset, message.position);
        offset = buffer.writeUInt16BE(Math.min(0xffff, Math.round(message.pressure * 0xffff)), offset);
        offset = buffer.writeInt32BE(0, offset); // action button: only used for mouse pointers
        buffer.writeInt32BE(message.buttons, offset);
        return buffer;
    }
    if (message instanceof ScrollControlMessage) {
        const buffer = Buffer.alloc(21);
        let offset = buffer.writeUInt8(message.type, 0);
        offset = writePosition(buffer, offset, message.position);
        offset = buffer.writeInt16BE(scrollToFixedPoint(message.hScroll), offset);
        offset = buffer.writeInt16BE(scrollToFixedPoint(message.vScroll), offset);
        buffer.writeInt32BE(0, offset);
        return buffer;
    }
    if (message instanceof CommandControlMessage) {
        switch (message.type) {
            case ControlMessage.TYPE_BACK_OR_SCREEN_ON:
                // v4 takes a key action: send a full press.
                return Buffer.from([message.type, 0, message.type, 1]);
            case ControlMessage.TYPE_EXPAND_NOTIFICATION_PANEL:
            case ControlMessage.TYPE_EXPAND_SETTINGS_PANEL:
            case ControlMessage.TYPE_COLLAPSE_PANELS:
            case ControlMessage.TYPE_ROTATE_DEVICE:
                return Buffer.from([message.type]);
            case ControlMessage.TYPE_GET_CLIPBOARD:
                return Buffer.from([message.type, 0]); // no copy key
            case ControlMessage.TYPE_SET_SCREEN_POWER_MODE:
                return message.toBuffer();
            case ControlMessage.TYPE_SET_CLIPBOARD: {
                // ws-scrcpy: type, paste, length, text. v4 adds an 8-byte sequence after the type.
                const legacy = message.toBuffer();
                const buffer = Buffer.alloc(legacy.length + 8);
                buffer.writeUInt8(message.type, 0);
                legacy.copy(buffer, 9, 1);
                return buffer;
            }
        }
    }
    return undefined;
}

/**
 * Browser side of `action=stream-v4` (see ScrcpyV4Stream on the server): one
 * WebSocket carrying a scrcpy v4 session's video, audio and control.
 */
export class ScrcpyV4Client extends TypedEmitter<ScrcpyV4ClientEvents> {
    private readonly ws: WebSocket;

    /** Builds the session URL on the same ws-scrcpy server as `serverUrl` (e.g. a proxy-adb URL). */
    public static buildUrl(serverUrl: string, udid: string, options: ScrcpyV4StreamOptions = {}): string {
        const url = new URL(serverUrl);
        url.search = '';
        url.searchParams.set('action', ACTION.STREAM_SCRCPY_V4);
        url.searchParams.set('udid', udid);
        if (options.maxSize !== undefined) {
            url.searchParams.set('max_size', String(options.maxSize));
        }
        if (options.videoBitRate !== undefined) {
            url.searchParams.set('video_bit_rate', String(options.videoBitRate));
        }
        if (options.maxFps !== undefined) {
            url.searchParams.set('max_fps', String(options.maxFps));
        }
        if (options.audio !== undefined) {
            url.searchParams.set('audio', String(options.audio));
        }
        return url.toString();
    }

    constructor(url: string) {
        super();
        const ws = (this.ws = new WebSocket(url));
        ws.binaryType = 'arraybuffer';
        ws.onmessage = (event: MessageEvent) => this.onMessage(event.data);
        ws.onclose = (event: CloseEvent) => this.emit('disconnected', event);
    }

    public sendEvent(message: ControlMessage): void {
        if (this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        const buffer = toScrcpyV4Buffer(message);
        if (buffer) {
            this.ws.send(buffer);
        } else {
            console.warn(TAG, 'Dropping a control message scrcpy v4 does not support:', message.toString());
        }
    }

    public stop(): void {
        this.ws.onmessage = null;
        this.ws.onclose = null;
        if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }

    private onMessage(data: ArrayBuffer | string): void {
        if (typeof data === 'string') {
            const event = JSON.parse(data) as ScrcpyV4Event;
            if (event.type === 'meta') {
                const { deviceName, videoCodec, audio } = event;
                this.emit('meta', { deviceName, videoCodec, audio });
            } else if (event.type === 'session') {
                this.emit('session', { width: event.width, height: event.height });
            } else if (event.type === 'clipboard') {
                this.emit('clipboard', event.text);
            }
            return;
        }
        const channel = new Uint8Array(data, 0, 1)[0];
        if (channel === ScrcpyV4Channel.VIDEO) {
            // A copy, not a view: players hand `.buffer` to the decoder.
            this.emit('video', new Uint8Array(data.slice(9)));
        } else if (channel === ScrcpyV4Channel.AUDIO) {
            this.emit('audio', new Uint8Array(data, 1));
        }
    }
}
