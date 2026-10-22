import { Blend, Download, FileVideo, FolderPlus, Layers, PersonStanding, ScanFace, Sparkles, Square, Upload, Wand2 } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { App, Button, Empty, Progress, Typography } from "antd";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { convertDepthVideo, depthVideoModes, type DepthVideoMode, type DepthVideoProgress } from "@/lib/depth-video";
import { formatBytes } from "@/lib/image-utils";
import { cn } from "@/lib/utils";
import { uploadMediaFile } from "@/services/file-storage";
import { useAssetStore } from "@/stores/use-asset-store";

const modeIcons: Record<DepthVideoMode, typeof Layers> = { depth: Layers, pose: PersonStanding, "depth-pose": Blend, face: ScanFace, all: Sparkles };

export default function DepthVideoPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const addAsset = useAssetStore((state) => state.addAsset);
    const [file, setFile] = useState<File>();
    const [sourceUrl, setSourceUrl] = useState("");
    const [mode, setMode] = useState<DepthVideoMode>("all");
    const [progress, setProgress] = useState<DepthVideoProgress>();
    const [result, setResult] = useState<{ blob: Blob; url: string; mode: DepthVideoMode }>();
    const [error, setError] = useState("");
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const previewRef = useRef<HTMLCanvasElement>(null);
    const abortRef = useRef<AbortController>(null);
    const running = Boolean(progress);

    useEffect(() => () => URL.revokeObjectURL(sourceUrl), [sourceUrl]);
    useEffect(() => () => (result ? URL.revokeObjectURL(result.url) : undefined), [result]);
    useEffect(() => () => abortRef.current?.abort(), []);

    const selectFile = (next?: File) => {
        if (!next || running) return;
        if (!next.type.startsWith("video/")) {
            message.warning(t("depthVideo.unsupportedFile"));
            return;
        }
        setFile(next);
        setSourceUrl(URL.createObjectURL(next));
        setResult(undefined);
        setError("");
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        selectFile(event.dataTransfer.files[0]);
    };

    const start = async () => {
        if (!file || !previewRef.current) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setResult(undefined);
        setError("");
        setProgress({ stage: "loading", percent: 0 });
        try {
            const blob = await convertDepthVideo(file, mode, previewRef.current, setProgress, controller.signal);
            setResult({ blob, url: URL.createObjectURL(blob), mode });
            message.success(t("depthVideo.done"));
        } catch (reason) {
            if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            abortRef.current = null;
            setProgress(undefined);
        }
    };

    const resultName = () => `${(file?.name || "video").replace(/\.[^.]+$/, "")}-${result?.mode}.mp4`;

    const saveToAssets = async () => {
        if (!result) return;
        const stored = await uploadMediaFile(new File([result.blob], resultName(), { type: "video/mp4" }), "video");
        addAsset({
            kind: "video",
            title: resultName(),
            coverUrl: "",
            tags: [],
            source: t("depthVideo.title"),
            data: { url: stored.url, storageKey: stored.storageKey, width: stored.width || 0, height: stored.height || 0, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "depth-video-page", mode: result.mode },
        });
        message.success(t("common.addedToAssets"));
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[420px_minmax(0,1fr)] lg:overflow-hidden">
                <section className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("depthVideo.title")}</h1>
                    <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{t("depthVideo.description")}</p>

                    <div className="mt-6 space-y-5">
                        <div>
                            <div className="mb-2 text-base font-semibold">{t("depthVideo.source")}</div>
                            <div
                                role="button"
                                tabIndex={0}
                                aria-disabled={running}
                                className={cn(
                                    "flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center text-sm transition-colors",
                                    dragging ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 hover:border-stone-500 dark:border-stone-700 dark:hover:border-stone-500",
                                    running && "cursor-not-allowed opacity-60",
                                )}
                                onClick={() => !running && fileInputRef.current?.click()}
                                onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && !running && fileInputRef.current?.click()}
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    setDragging(true);
                                }}
                                onDragLeave={() => setDragging(false)}
                                onDrop={handleDrop}
                            >
                                {file ? <FileVideo className="size-6 text-stone-500" /> : <Upload className="size-6 text-stone-500" />}
                                {file ? (
                                    <span className="max-w-full break-all">
                                        {file.name} · {formatBytes(file.size)}
                                    </span>
                                ) : (
                                    <span className="text-stone-500 dark:text-stone-400">{t("depthVideo.dropHint")}</span>
                                )}
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="video/*"
                                className="hidden"
                                onChange={(event) => {
                                    selectFile(event.target.files?.[0]);
                                    event.target.value = "";
                                }}
                            />
                        </div>

                        <div>
                            <div className="mb-2 text-base font-semibold">{t("depthVideo.mode")}</div>
                            <div className="grid grid-cols-2 gap-2">
                                {depthVideoModes.map((item) => {
                                    const Icon = modeIcons[item];
                                    return (
                                        <button
                                            key={item}
                                            type="button"
                                            disabled={running}
                                            aria-pressed={mode === item}
                                            onClick={() => setMode(item)}
                                            className={cn(
                                                "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                                                item === "all" && "col-span-2",
                                                mode === item ? "border-stone-900 bg-stone-100 dark:border-stone-100 dark:bg-stone-900" : "border-stone-200 hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600",
                                            )}
                                        >
                                            <span className="flex items-center gap-2 text-sm font-medium">
                                                <Icon className="size-4" />
                                                {t(`depthVideo.modes.${item}.title`)}
                                            </span>
                                            <span className="text-xs text-stone-500 dark:text-stone-400">{t(`depthVideo.modes.${item}.description`)}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="space-y-2">
                            {running ? (
                                <Button block size="large" danger icon={<Square className="size-4" />} onClick={() => abortRef.current?.abort()}>
                                    {t("depthVideo.cancel")}
                                </Button>
                            ) : (
                                <Button block size="large" type="primary" disabled={!file} icon={<Wand2 className="size-4" />} onClick={() => void start()}>
                                    {t("depthVideo.start")}
                                </Button>
                            )}
                            {progress ? (
                                <div>
                                    <Progress percent={progress.percent} size="small" />
                                    <div className="text-xs text-stone-500 dark:text-stone-400">{t(`depthVideo.stage.${progress.stage}`, { percent: progress.percent })}</div>
                                </div>
                            ) : null}
                            <p className="text-xs text-stone-500 dark:text-stone-400">{t("depthVideo.notice")}</p>
                        </div>
                    </div>
                </section>

                <section className="flex min-h-80 flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <span className="text-base font-semibold">{t(running ? "depthVideo.processing" : result ? "depthVideo.result" : "depthVideo.preview")}</span>
                        {result && !running ? (
                            <div className="flex gap-1">
                                <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void saveToAssets()}>
                                    {t("common.addToAssets")}
                                </Button>
                                <Button size="small" icon={<Download className="size-3.5" />} onClick={() => saveAs(result.blob, resultName())}>
                                    {t("common.download")}
                                </Button>
                            </div>
                        ) : null}
                    </div>
                    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-stone-100 dark:bg-stone-900">
                        <canvas ref={previewRef} className={cn("max-h-full max-w-full object-contain", !running && "hidden")} />
                        {running ? null : result ? (
                            <video key={result.url} src={result.url} controls className="max-h-full max-w-full object-contain" />
                        ) : error ? (
                            <Typography.Paragraph className="!mb-0 max-w-md p-6 text-center !text-sm !text-red-500 dark:!text-red-300">{t("depthVideo.failed", { error })}</Typography.Paragraph>
                        ) : sourceUrl ? (
                            <video key={sourceUrl} src={sourceUrl} controls className="max-h-full max-w-full object-contain" />
                        ) : (
                            <Empty description={t("depthVideo.empty")} />
                        )}
                    </div>
                </section>
            </main>
        </div>
    );
}
