/** Upstream scrcpy-server release used for audio, vendored next to the video server. */
export const AUDIO_SERVER_VERSION = '4.0';
export const AUDIO_SERVER_FILE_NAME = `scrcpy-server-v${AUDIO_SERVER_VERSION}.jar`;

/** scrcpy codec id for Opus ("opus" as a big-endian u32). */
export const AUDIO_CODEC_OPUS = 0x6f707573;

/** First message on an `action=stream-audio` socket. */
export type AudioStreamConfig = {
    type: 'audio-config';
    codec: 'opus';
};
