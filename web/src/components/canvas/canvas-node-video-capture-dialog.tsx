import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, Slider, Tooltip } from "antd";
import { Camera, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canDecodeFrames, decodeFrameAt, probeVideo, readVideoBytes, type FrameProbe, type VideoFrameHandle } from "@/lib/canvas/video-frame-decoder";

export type VideoCaptureSelection = { timeMs: number; dataUrl: string; title: string };
export type { VideoFrameHandle };

type VideoCaptureSource = { url: string; storageKey?: string };

/**
 * Frame-exact frame picker. Decoding runs through WebCodecs so stepping always lands on a real
 * frame; the native player is only used as a visual reference and is never the capture source.
 */
export function CanvasNodeVideoCaptureDialog({
    source,
    open,
    startTimeMs,
    onStartTimeApplied,
    onClose,
    onConfirm,
}: {
    source: VideoCaptureSource | null;
    open: boolean;
    startTimeMs?: number | null;
    onStartTimeApplied?: () => void;
    onClose: () => void;
    onConfirm: (selection: VideoCaptureSelection) => void;
}) {
    const { t } = useTranslation();
    const [probe, setProbe] = useState<FrameProbe | null>(null);
    const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
    const [times, setTimes] = useState<number[]>([]);
    const [index, setIndex] = useState(0);
    const [frame, setFrame] = useState<VideoFrameHandle | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pendingTimeRef = useRef<number | null>(null);
    // The parent rebuilds the source object every render, so the effect keys off the stable fields instead.
    const sourceUrl = source?.url ?? null;
    const sourceStorageKey = source?.storageKey ?? null;
    // Keep the callback latest without making it an effect dependency; the parent recreates it every render.
    const startTimeAppliedRef = useRef(onStartTimeApplied);
    startTimeAppliedRef.current = onStartTimeApplied;
    const previewRef = useRef<HTMLCanvasElement>(null);
    const requestRef = useRef(0);

    useEffect(() => {
        if (!open || !sourceUrl) return;
        let cancelled = false;
        // Set by the canvas when the native player was paused; consumed once the sample table is known.
        pendingTimeRef.current = typeof startTimeMs === "number" && startTimeMs > 0 ? startTimeMs : null;
        setProbe(null);
        setBuffer(null);
        setTimes([]);
        setIndex(0);
        setFrame(null);
        setError(null);
        void (async () => {
            try {
                const bytes = await readVideoBytes({ url: sourceUrl, storageKey: sourceStorageKey ?? undefined });
                if (cancelled) return;
                const result = await probeVideo(bytes);
                if (cancelled) return;
                if (!result.supported) {
                    setError(t("canvas.editors.captureUnsupported"));
                    setProbe(result);
                    return;
                }
                setBuffer(bytes);
                setProbe(result);
                const nextTimes = result.sampleTimesMs;
                setTimes(nextTimes);
                const pending = pendingTimeRef.current;
                if (pending !== null) {
                    pendingTimeRef.current = null;
                    setIndex(nearestFrameIndex(nextTimes, pending));
                    startTimeAppliedRef.current?.();
                }
            } catch {
                if (!cancelled) setError(t("canvas.editors.captureUnsupported"));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, sourceUrl, sourceStorageKey, startTimeMs, t]);

    // Decode sequentially so rapid stepping never runs two decodes at once for one node.
    useEffect(() => {
        if (!open || !buffer || !times.length) return;
        const token = (requestRef.current += 1);
        setBusy(true);
        void (async () => {
            try {
                const handle = await decodeFrameAt(buffer, times[index]);
                if (requestRef.current !== token) return;
                setFrame(handle);
                setError(null);
            } catch {
                if (requestRef.current === token) setError(t("canvas.editors.captureFrameFailed"));
            } finally {
                if (requestRef.current === token) setBusy(false);
            }
        })();
    }, [buffer, index, open, times, t]);

    useEffect(() => {
        const canvas = previewRef.current;
        if (!canvas || !frame) return;
        canvas.width = frame.width;
        canvas.height = frame.height;
        canvas.getContext("2d")?.drawImage(frame.canvas, 0, 0);
    }, [frame]);

    const step = useCallback(
        (delta: number) => {
            setIndex((current) => Math.min(times.length - 1, Math.max(0, current + delta)));
        },
        [times.length],
    );

    const exact = Boolean(buffer) && Boolean(times.length) && !error;
    const currentTimeMs = times[index] ?? 0;

    return (
        <Modal title={t("canvas.editors.captureTitle")} open={open && Boolean(source)} onCancel={onClose} footer={null} width={860} centered destroyOnHidden>
            <div className="space-y-4" data-canvas-no-zoom>
                <div className="grid min-h-[320px] place-items-center rounded-xl border bg-black/85 p-3">
                    {error ? <div className="px-6 text-center text-sm text-white/80">{error}</div> : exact && frame ? <canvas ref={previewRef} className="max-h-[52vh] max-w-full rounded-lg object-contain shadow-xl" /> : <Loader2 className="size-6 animate-spin text-white/70" />}
                </div>

                {exact ? (
                    <div className="space-y-3">
                        <div className="flex items-center gap-3">
                            <Tooltip title={t("canvas.editors.prevFrame")}>
                                <Button size="small" icon={<ChevronLeft className="size-4" />} disabled={index <= 0 || busy} onClick={() => step(-1)} />
                            </Tooltip>
                            <Slider className="flex-1" min={0} max={Math.max(0, times.length - 1)} value={index} disabled={busy} tooltip={{ formatter: (value) => formatTime(times[value ?? 0] ?? 0) }} onChange={(value) => setIndex(Number(value))} />
                            <Tooltip title={t("canvas.editors.nextFrame")}>
                                <Button size="small" icon={<ChevronRight className="size-4" />} disabled={index >= times.length - 1 || busy} onClick={() => step(1)} />
                            </Tooltip>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                            <span className="opacity-60">
                                {t("canvas.editors.framePosition", { current: index + 1, total: times.length })} · {formatTime(currentTimeMs)}
                                {probe?.supported && probe.fps ? ` · ${probe.fps.toFixed(2)} fps` : ""}
                            </span>
                            <div className="flex items-center gap-2">
                                <Button size="small" disabled={busy} onClick={() => setIndex(0)}>
                                    {t("canvas.editors.firstFrame")}
                                </Button>
                                <Button size="small" disabled={busy} onClick={() => setIndex(times.length - 1)}>
                                    {t("canvas.editors.lastFrame")}
                                </Button>
                                <Button type="primary" icon={<Camera className="size-4" />} loading={busy} onClick={() => (frame ? onConfirm({ timeMs: currentTimeMs, dataUrl: frame.canvas.toDataURL("image/jpeg", 0.92), title: formatTime(currentTimeMs) }) : undefined)}>
                                    {t("canvas.editors.captureThisFrame")}
                                </Button>
                            </div>
                        </div>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}

/** Index of the frame whose presentation time is closest to `timeMs`. */
function nearestFrameIndex(times: number[], timeMs: number) {
    let best = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let position = 0; position < times.length; position += 1) {
        const delta = Math.abs(times[position] - timeMs);
        if (delta < bestDelta) {
            bestDelta = delta;
            best = position;
        }
    }
    return best;
}

function formatTime(timeMs: number) {
    const totalSeconds = Math.max(0, timeMs) / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds - minutes * 60;
    return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}
