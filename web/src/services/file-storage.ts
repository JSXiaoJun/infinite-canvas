import localforage from "localforage";
import { nanoid } from "nanoid";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };
export type MediaUploadOptions = { signal?: AbortSignal; timeoutMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
const MEDIA_META_TIMEOUT_MS = 10_000;

export async function uploadMediaFile(input: string | Blob, prefix = "file", options?: MediaUploadOptions): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await fetchMediaBlob(input, options) : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            video.onloadedmetadata = null;
            video.onerror = null;
            resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        };
        const timer = setTimeout(done, MEDIA_META_TIMEOUT_MS);
        video.onloadedmetadata = done;
        video.onerror = done;
        video.preload = "metadata";
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            audio.onloadedmetadata = null;
            audio.onerror = null;
            resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        };
        const timer = setTimeout(done, MEDIA_META_TIMEOUT_MS);
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.preload = "metadata";
        audio.src = url;
    });
}

async function fetchMediaBlob(url: string, options?: MediaUploadOptions) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, options?.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS);
    options?.signal?.addEventListener("abort", abort, { once: true });
    try {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Media download failed (${response.status})`);
        return response.blob();
    } catch (error) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        throw error;
    } finally {
        clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", abort);
    }
}
