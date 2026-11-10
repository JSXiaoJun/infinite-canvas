import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { createZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { withLocalProxy } from "@/stores/use-config-store";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = i18n.t("canvas.export.defaultProjectName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                collectStorageKeys(project).map(async (storageKey) => {
                    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                    if (!blob) return;
                    const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project, files };
        }),
    );

    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

export function hasDownloadableNodeMedia(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) return false;
    return Boolean(node.metadata?.images?.some((image) => image.content || image.storageKey) || node.metadata?.content || node.metadata?.storageKey);
}

export async function downloadCanvasNodes(nodes: CanvasNodeData[], fileName = i18n.t("canvas.export.defaultNodesName")) {
    const used = new Set<string>();
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || i18n.t("canvas.export.item");
        let name = `${safe}.${ext}`;
        for (let i = 2; used.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        used.add(name);
        return name;
    };
    const addFile = async (base: string, content?: string, storageKey?: string, mimeType?: string) => {
        const blob = await readNodeBlob(content, storageKey);
        if (!blob) return;
        zipFiles.push({ name: uniqueName(base, fileExtension(blob.type || mimeType || "", storageKey || content || "")), data: blob });
    };

    for (const node of nodes) {
        const base = node.title || node.type;
        if (node.type === CanvasNodeType.Image && node.metadata?.images?.length) {
            const multiple = node.metadata.images.length > 1;
            for (const [index, image] of node.metadata.images.entries()) {
                if (image.content || image.storageKey) await addFile(multiple ? `${base}-${index + 1}` : base, image.content, image.storageKey, image.mimeType);
            }
            continue;
        }
        if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
            await addFile(base, node.metadata?.content, node.metadata?.storageKey, node.metadata?.mimeType);
        }
    }

    if (!zipFiles.length) throw new Error(i18n.t("canvas.selection.downloadEmpty"));
    saveAs(await createZip(zipFiles), `${safeFileName(fileName)}.zip`);
    return zipFiles.length;
}

export async function exportCanvasNodes(nodes: CanvasNodeData[], fileName = i18n.t("canvas.export.defaultNodesName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const used = new Set<string>();
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || i18n.t("canvas.export.item");
        let name = `${safe}.${ext}`;
        for (let i = 1; used.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        used.add(name);
        return name;
    };

    await Promise.all(
        nodes.map(async (node) => {
            const title = node.title || node.type;
            const storageKey = node.metadata?.storageKey || "";
            if (storageKey) {
                const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                if (blob) return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            if (node.type === CanvasNodeType.Text) return void zipFiles.push({ name: uniqueName(title, "txt"), data: node.metadata?.content || node.metadata?.prompt || "" });
            const content = node.metadata?.content;
            if (content && content.startsWith("data:")) {
                const blob = await (await fetch(content)).blob();
                return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            zipFiles.push({ name: uniqueName(title, "json"), data: JSON.stringify(node, null, 2) });
        }),
    );

    const zip = await createZip(zipFiles);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

async function readNodeBlob(content?: string, storageKey?: string) {
    if (storageKey) {
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (blob) return blob;
    }
    if (!content || !/^(data:|blob:|https?:)/i.test(content)) return null;
    try {
        const response = await fetch(withLocalProxy(content));
        return response.ok ? await response.blob() : null;
    } catch {
        return null;
    }
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function safeFileName(value: string) {
    return value
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/[\r\n\t]+/g, " ")
        .trim();
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("avif")) return "avif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("quicktime")) return "mov";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("aac")) return "aac";
    if (mimeType.includes("flac")) return "flac";
    if (mimeType.includes("opus")) return "opus";
    if (mimeType.includes("pcm")) return "pcm";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
