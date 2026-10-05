import { parseMp4, type Mp4Sample, type Mp4TrackInfo } from "@/lib/canvas/mp4-demux";
import { getMediaBlob } from "@/services/file-storage";

const DECODE_TIMEOUT_MS = 20_000;
// Guard against pathological files: decoding a whole long clip for one frame is not worth it.
const MAX_DECODE_SAMPLES = 6_000;

export type VideoFrameHandle = { canvas: HTMLCanvasElement; width: number; height: number };

export type FrameProbe =
    // sampleTimesMs are the container presentation timestamps, so the picker uses real frame timing.
    | { supported: true; width: number; height: number; frameCount: number; durationSec: number; fps: number; sampleTimesMs: number[] }
    | { supported: false };

let supportCache: Promise<boolean> | null = null;

/** Cached capability check: whether this browser can decode frames exactly with WebCodecs. */
export function canDecodeFrames(): Promise<boolean> {
    if (!supportCache) {
        supportCache = (async () => {
            if (typeof VideoDecoder === "undefined") return false;
            try {
                const result = await VideoDecoder.isConfigSupported({ codec: "avc1.42001f", codedWidth: 320, codedHeight: 180 });
                return Boolean(result.supported);
            } catch {
                return false;
            }
        })();
    }
    return supportCache;
}

/** Read the bytes for a canvas video node. Local assets live in IndexedDB; remote ones are fetched. */
export async function readVideoBytes(source: { url: string; storageKey?: string }, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (source.storageKey) {
        const stored = await getMediaBlob(source.storageKey);
        if (stored) return stored.arrayBuffer();
    }
    if (!source.url) throw new Error("empty video url");
    const response = await fetch(source.url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
}

/** Whether this clip can be demuxed and decoded frame-exactly. */
export async function probeVideo(buffer: ArrayBuffer): Promise<FrameProbe> {
    if (!(await canDecodeFrames())) return { supported: false };
    const track = resolveTrack(buffer);
    if (!track) return { supported: false };
    const supported = await isTrackSupported(track);
    if (!supported) return { supported: false };
    const durationSec = track.durationSec;
    return { supported: true, width: track.codedWidth, height: track.codedHeight, frameCount: track.samples.length, durationSec, fps: durationSec > 0 ? track.samples.length / durationSec : 0, sampleTimesMs: frameTimes(track) };
}

/** Frame timestamps in milliseconds, ordered as stored in the container. */
export function frameTimes(track: Mp4TrackInfo) {
    return track.samples.map((sample) => sample.cts / 1000);
}

/**
 * Decode the frame whose presentation time is closest to `timeMs`. Starts from the previous
 * keyframe so inter-frame dependencies are satisfied, then returns exactly that frame.
 */
export async function decodeFrameAt(buffer: ArrayBuffer, timeMs: number, signal?: AbortSignal): Promise<VideoFrameHandle> {
    const track = resolveTrack(buffer);
    if (!track) throw new Error("unsupported container");
    const config = trackConfig(track);
    if (!(await VideoDecoder.isConfigSupported(config).then((result) => result.supported).catch(() => false))) throw new Error("unsupported codec");

    const targetUs = Math.max(0, timeMs) * 1000;
    const index = nearestSampleIndex(track.samples, targetUs);
    const keyIndex = previousKeyframeIndex(track.samples, index);
    let settle: (value: VideoFrame | Error) => void = () => undefined;
    const decoder = new VideoDecoder({
        output: (output) => {
            if (output.timestamp >= track.samples[index].cts) settle(output);
            else output.close();
        },
        error: (error) => settle(new Error(error.message)),
    });
    decoder.configure(config);

    try {
        const frame = await new Promise<VideoFrame>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("decode timeout")), DECODE_TIMEOUT_MS);
            const onAbort = () => done(new Error("aborted"));
            const done = (value: VideoFrame | Error) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                if (value instanceof Error) reject(value);
                else resolve(value);
            };
            settle = done;
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
                for (let position = keyIndex; position <= index; position += 1) {
                    const sample = track.samples[position];
                    decoder.decode(new EncodedVideoChunk({ type: sample.isSync ? "key" : "delta", timestamp: sample.cts, duration: sampleDurationUs(track, position), data: sampleBytes(buffer, sample) }));
                }
            } catch (error) {
                done(error instanceof Error ? error : new Error(String(error)));
            }
        });
        return toHandle(frame);
    } finally {
        if (decoder.state !== "closed") decoder.close();
    }
}

function resolveTrack(buffer: ArrayBuffer): Mp4TrackInfo | null {
    const parsed = parseMp4(buffer);
    if (!parsed) return null;
    return parsed.tracks.find((track) => track.samples.length > 0 && track.samples.length <= MAX_DECODE_SAMPLES) || null;
}

async function isTrackSupported(track: Mp4TrackInfo) {
    try {
        const result = await VideoDecoder.isConfigSupported(trackConfig(track));
        return Boolean(result.supported);
    } catch {
        return false;
    }
}

function trackConfig(track: Mp4TrackInfo): VideoDecoderConfig {
    return { codec: track.codec, codedWidth: track.codedWidth, codedHeight: track.codedHeight, description: toAnnexBDescription(track.description) };
}

function nearestSampleIndex(samples: Mp4Sample[], targetUs: number) {
    let best = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let index = 0; index < samples.length; index += 1) {
        const delta = Math.abs(samples[index].cts - targetUs);
        if (delta < bestDelta) {
            bestDelta = delta;
            best = index;
        }
        if (samples[index].cts > targetUs && delta > bestDelta) break;
    }
    return best;
}

function previousKeyframeIndex(samples: Mp4Sample[], index: number) {
    for (let position = index; position >= 0; position -= 1) {
        if (samples[position].isSync) return position;
    }
    return 0;
}

function sampleDurationUs(track: Mp4TrackInfo, index: number) {
    const current = track.samples[index];
    const next = track.samples[index + 1];
    if (next) return Math.max(0, next.dts - current.dts);
    const previous = track.samples[index - 1];
    return previous ? Math.max(0, current.dts - previous.dts) : 0;
}

function sampleBytes(buffer: ArrayBuffer, sample: Mp4Sample) {
    return new Uint8Array(buffer, sample.offset, sample.size).slice();
}

/**
 * avcC/hvcC records describe samples with a 4-byte length prefix. WebCodecs accepts that layout
 * directly, so the description is passed through unchanged; only its ownership is copied.
 */
function toAnnexBDescription(description: Uint8Array) {
    return description.slice();
}

function toHandle(frame: VideoFrame): VideoFrameHandle {
    const canvas = document.createElement("canvas");
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    const context = canvas.getContext("2d");
    if (!context) {
        frame.close();
        throw new Error("canvas 2d unavailable");
    }
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    frame.close();
    return { canvas, width: canvas.width, height: canvas.height };
}
