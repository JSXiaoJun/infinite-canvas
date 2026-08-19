export const R2_ASSET_WORKER_URL = "https://upload.onlyzhuya.xyz";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const allowedTypes = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/x-m4a",
    "audio/ogg",
    "audio/aac",
]);

export async function uploadR2Asset(blob: Blob, signal?: AbortSignal) {
    if (!allowedTypes.has(blob.type)) throw new Error("R2 不支持当前图片、视频或音频格式");
    if (!blob.size || blob.size > MAX_UPLOAD_BYTES) throw new Error("参考素材为空或超过 100 MB 限制");

    let url = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch(`${R2_ASSET_WORKER_URL}/upload`, {
                method: "PUT",
                headers: { "Content-Type": blob.type, "X-File-Size": String(blob.size) },
                body: blob,
                signal,
            });
            const payload = (await response.json().catch(() => null)) as { url?: unknown; error?: unknown } | null;
            if (response.ok && typeof payload?.url === "string") {
                url = payload.url;
                break;
            }
            const message = typeof payload?.error === "string" ? payload.error : `R2 上传失败（HTTP ${response.status}）`;
            if ((response.status < 500 && response.status !== 429) || attempt === 2) throw new Error(message);
        } catch (error) {
            if (signal?.aborted || attempt === 2 || (error instanceof Error && !/fetch|network/i.test(error.message))) throw error;
        }
        await delay(500 * (attempt + 1), signal);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch(url, { method: "HEAD", cache: "no-store", signal }).catch(() => null);
        if (response?.ok && Number(response.headers.get("Content-Length")) === blob.size) return url;
        if (attempt === 2) throw new Error("R2 上传后的文件校验失败，请重试");
        await delay(500 * (attempt + 1), signal);
    }
    throw new Error("R2 上传后的文件校验失败，请重试");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
    });
}
