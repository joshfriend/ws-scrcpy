import { PACKET_FLAG_CONFIG } from '../../common/ScrcpyV4';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

// Packets arrive every 20 ms. Start a little behind to absorb network jitter,
// and skip ahead when the queue grows past MAX_LATENCY so delay cannot build up.
const START_LATENCY = 0.08;
const MAX_LATENCY = 0.3;

// Input events that grant the user activation an AudioContext needs to start.
const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'keydown', 'touchend'];

/**
 * Plays the Opus audio of a scrcpy v4 session (see ScrcpyV4Client) with
 * WebCodecs and Web Audio.
 *
 * Browsers only let audio start after a user gesture. {@link start} may be
 * called without one: playback then begins at the page's next click, tap, or
 * key press, and packets pushed before that are dropped.
 */
export class AudioPlayer {
    private context?: AudioContext;
    private decoder?: AudioDecoder;
    private nextTime = 0;

    public static isSupported(): boolean {
        return typeof AudioDecoder === 'function' && typeof AudioContext === 'function';
    }

    public start(): void {
        if (this.context) {
            return;
        }
        // Create and resume the context synchronously, in case this runs inside a user gesture.
        this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
        void this.context.resume();
        if (this.context.state !== 'running') {
            GESTURE_EVENTS.forEach((type) => document.addEventListener(type, this.onGesture, true));
        }
        const decoder = new AudioDecoder({
            output: (frame: AudioData) => this.play(frame),
            error: (error: DOMException) => {
                console.error('[AudioPlayer]', error.message);
                this.stop();
            },
        });
        decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS });
        this.decoder = decoder;
    }

    public stop(): void {
        this.removeGestureListeners();
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.decoder = undefined;
        void this.context?.close();
        this.context = undefined;
        this.nextTime = 0;
    }

    /** Takes one packet: scrcpy's 8-byte PTS and flags header followed by the Opus payload. */
    public push(packet: Uint8Array): void {
        const decoder = this.decoder;
        if (!decoder || packet.byteLength <= 8) {
            return;
        }
        if (packet[0] & PACKET_FLAG_CONFIG) {
            // The OpusHead config packet; the decoder is configured for it already.
            return;
        }
        const header = new DataView(packet.buffer, packet.byteOffset, 8);
        // The PTS is the low 61 bits; microseconds fit in a double for ~285 years.
        const timestamp = (header.getUint32(0) & 0x1fffffff) * 2 ** 32 + header.getUint32(4);
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: packet.subarray(8) }));
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
}
