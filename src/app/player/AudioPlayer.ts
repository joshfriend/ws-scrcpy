import { ACTION } from '../../common/Action';
import { AudioStreamConfig } from '../../common/AudioStream';
import { TypedEmitter } from '../../common/TypedEmitter';

interface AudioPlayerEvents {
    /** The stream ended; `reason` is the server's explanation when there is one. */
    stopped: { reason: string };
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const CONFIG_PACKET_FLAG = 0x40;

// Packets arrive every 20 ms. Start a little behind to absorb network jitter,
// and skip ahead when the queue grows past MAX_LATENCY so delay cannot build up.
const START_LATENCY = 0.08;
const MAX_LATENCY = 0.3;

// Input events that grant the user activation an AudioContext needs to start.
const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'keydown', 'touchend'];

/**
 * Plays a device's audio from an `action=stream-audio` socket (see
 * ScrcpyAudioProxy) with WebCodecs and Web Audio.
 *
 * Browsers only let audio start after a user gesture. {@link start} may be
 * called without one: playback then begins at the page's next click, tap, or
 * key press, and audio received before that is dropped.
 */
export class AudioPlayer extends TypedEmitter<AudioPlayerEvents> {
    private ws?: WebSocket;
    private context?: AudioContext;
    private decoder?: AudioDecoder;
    private nextTime = 0;

    constructor(private readonly url: string) {
        super();
    }

    public static isSupported(): boolean {
        return typeof AudioDecoder === 'function' && typeof AudioContext === 'function';
    }

    /** Builds the audio socket URL on the same ws-scrcpy server as `serverUrl` (e.g. a proxy-adb URL). */
    public static buildUrl(serverUrl: string, udid: string): string {
        const url = new URL(serverUrl);
        url.search = '';
        url.searchParams.set('action', ACTION.STREAM_AUDIO);
        url.searchParams.set('udid', udid);
        return url.toString();
    }

    public start(): void {
        if (this.ws) {
            return;
        }
        // Create and resume the context synchronously, in case this runs inside a user gesture.
        this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
        void this.context.resume();
        if (this.context.state !== 'running') {
            GESTURE_EVENTS.forEach((type) => document.addEventListener(type, this.onGesture, true));
        }
        const ws = (this.ws = new WebSocket(this.url));
        ws.binaryType = 'arraybuffer';
        ws.onmessage = (event: MessageEvent) => this.onMessage(event.data);
        ws.onclose = (event: CloseEvent) => this.finish(event.reason);
    }

    public stop(): void {
        this.finish('');
    }

    private onGesture = (): void => {
        const context = this.context;
        if (!context || context.state === 'running') {
            this.removeGestureListeners();
            return;
        }
        void context.resume().then(() => {
            if (context.state === 'running') {
                this.removeGestureListeners();
            }
        });
    };

    private removeGestureListeners(): void {
        GESTURE_EVENTS.forEach((type) => document.removeEventListener(type, this.onGesture, true));
    }

    private onMessage(data: ArrayBuffer | string): void {
        if (typeof data === 'string') {
            const config = JSON.parse(data) as AudioStreamConfig;
            if (config.type === 'audio-config') {
                this.configure(config);
            }
            return;
        }
        const decoder = this.decoder;
        if (!decoder || data.byteLength <= 8) {
            return;
        }
        const header = new DataView(data, 0, 8);
        if (header.getUint8(0) & CONFIG_PACKET_FLAG) {
            // The OpusHead config packet; the decoder is configured for it already.
            return;
        }
        // The PTS is the low 61 bits; microseconds fit in a double for ~285 years.
        const timestamp = (header.getUint32(0) & 0x1fffffff) * 2 ** 32 + header.getUint32(4);
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: new Uint8Array(data, 8) }));
    }

    private configure(config: AudioStreamConfig): void {
        const decoder = new AudioDecoder({
            output: (frame: AudioData) => this.play(frame),
            error: (error: DOMException) => this.finish(`Audio decoder error: ${error.message}`),
        });
        decoder.configure({ codec: config.codec, sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS });
        this.decoder = decoder;
    }

    private play(frame: AudioData): void {
        const context = this.context;
        // A suspended context's clock stands still, so queuing would pile
        // frames onto the same instant; drop them until playback can start.
        if (!context || context.state !== 'running') {
            frame.close();
            return;
        }
        const buffer = context.createBuffer(frame.numberOfChannels, frame.numberOfFrames, frame.sampleRate);
        for (let channel = 0; channel < frame.numberOfChannels; channel++) {
            frame.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: 'f32-planar' });
        }
        frame.close();
        const now = context.currentTime;
        if (this.nextTime < now || this.nextTime > now + MAX_LATENCY) {
            this.nextTime = now + START_LATENCY;
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start(this.nextTime);
        this.nextTime += buffer.duration;
    }

    private finish(reason: string): void {
        if (!this.ws) {
            return;
        }
        const ws = this.ws;
        this.ws = undefined;
        this.removeGestureListeners();
        ws.onmessage = null;
        ws.onclose = null;
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.decoder = undefined;
        void this.context?.close();
        this.context = undefined;
        this.nextTime = 0;
        this.emit('stopped', { reason });
    }
}
