import { getMediaBlob } from "@/services/file-storage";

export const VIDEO_FRAME_COUNT = 4;
const VIDEO_FRAME_MAX_EDGE = 768;
const VIDEO_FRAME_QUALITY = 0.82;
const VIDEO_LOAD_TIMEOUT_MS = 15_000;
const VIDEO_SEEK_TIMEOUT_MS = 8_000;

export type VideoSource = { url: string; storageKey?: string };
export type VideoFrame = { dataUrl: string; timeSec: number };

/**
 * Evenly spaced sample points inside (0, duration), skipping the very first and last frame
 * (often black or a fade). Unknown / invalid durations collapse to a single frame at 0.
 */
export function frameTimestamps(durationSec: number, count = VIDEO_FRAME_COUNT): number[] {
    const total = Math.max(1, Math.floor(Number(count) || 1));
    if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
    return Array.from({ length: total }, (_, index) => (durationSec * (index + 1)) / (total + 1));
}

/** Read the video bytes. Local assets come from IndexedDB; everything else is fetched (blob: URLs included). */
export async function readVideoBlob(source: VideoSource, signal?: AbortSignal): Promise<Blob> {
    if (source.storageKey) {
        const stored = await getMediaBlob(source.storageKey);
        if (stored) return stored;
    }
    if (!source.url) throw new Error("empty video url");
    const response = await fetch(source.url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
}

function scaledSize(width: number, height: number) {
    const scale = Math.min(1, VIDEO_FRAME_MAX_EDGE / Math.max(width, height, 1));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function waitForEvent(video: HTMLVideoElement, event: "loadeddata" | "seeked", timeoutMs: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            video.removeEventListener(event, onDone);
            video.removeEventListener("error", onError);
            signal?.removeEventListener("abort", onAbort);
        };
        const onDone = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error("video decode failed"));
        };
        const onAbort = () => {
            cleanup();
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`video ${event} timeout`));
        }, timeoutMs);
        video.addEventListener(event, onDone, { once: true });
        video.addEventListener("error", onError, { once: true });
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Sample still frames client-side for image-only vision models. The blob is loaded through a local
 * object URL, so the canvas is never CORS-tainted. Throws if no frame could be decoded.
 */
export async function extractVideoFrames(blob: Blob, count = VIDEO_FRAME_COUNT, signal?: AbortSignal): Promise<VideoFrame[]> {
    const objectUrl = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
        const loaded = waitForEvent(video, "loadeddata", VIDEO_LOAD_TIMEOUT_MS, signal);
        video.src = objectUrl;
        await loaded;
        const { width, height } = scaledSize(video.videoWidth, video.videoHeight);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas 2d unavailable");

        const frames: VideoFrame[] = [];
        for (const timeSec of frameTimestamps(video.duration, count)) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            // Seeking to the current position fires no "seeked" event, so only wait when the time changes.
            if (Math.abs(video.currentTime - timeSec) > 0.001) {
                const seeked = waitForEvent(video, "seeked", VIDEO_SEEK_TIMEOUT_MS, signal);
                video.currentTime = timeSec;
                await seeked;
            }
            context.drawImage(video, 0, 0, width, height);
            frames.push({ dataUrl: canvas.toDataURL("image/jpeg", VIDEO_FRAME_QUALITY), timeSec });
        }
        if (!frames.length) throw new Error("no frames extracted");
        return frames;
    } finally {
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(objectUrl);
    }
}
