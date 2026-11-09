/**
 * Shared definitions for `action=stream-v4`: a session with upstream
 * scrcpy-server v4.0 (video, audio and control) relayed over one WebSocket.
 *
 * Server to browser:
 * - text messages are JSON {@link ScrcpyV4Event}s.
 * - binary messages start with a {@link ScrcpyV4Channel} byte. Video and audio
 *   packets follow it with scrcpy's 8-byte PTS and flags header and the encoded
 *   payload (H.264 in Annex B for video, Opus for audio).
 *
 * Browser to server: binary messages are scrcpy v4 control messages, written
 * to the control socket unchanged.
 */

export const SCRCPY_V4_SERVER_VERSION = '4.0';
export const SCRCPY_V4_SERVER_FILE_NAME = `scrcpy-server-v${SCRCPY_V4_SERVER_VERSION}.jar`;

export enum ScrcpyV4Channel {
    VIDEO = 0,
    AUDIO = 1,
}

/** Bits of the first byte of a packet's 8-byte header. */
export const PACKET_FLAG_CONFIG = 0x40;
export const PACKET_FLAG_KEY_FRAME = 0x20;

export type ScrcpyV4Event =
    /** Sent once, before any packet. `audio` is false when the device cannot capture audio (before Android 11). */
    | { type: 'meta'; deviceName: string; videoCodec: string; audio: boolean }
    /** A new capture session, e.g. after rotation. `width` and `height` are the encoded video size. */
    | { type: 'session'; width: number; height: number }
    | { type: 'clipboard'; text: string };

/** Query parameters accepted by `action=stream-v4`, besides `udid`. */
export interface ScrcpyV4StreamOptions {
    /** Longest side of the encoded video, in pixels. 0 keeps the device resolution. */
    maxSize?: number;
    videoBitRate?: number;
    maxFps?: number;
    audio?: boolean;
}
