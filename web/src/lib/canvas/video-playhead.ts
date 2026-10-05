export type VideoPlayheadPosition = { timeMs: number; durationMs: number; paused: boolean; nodeId: string };

// A single node is on screen at a time, so one map is enough. Elements are plain refs and never keep React state alive.
const playheads = new Map<string, HTMLVideoElement>();

/** Register the native player of a video node so the capture dialog can read the exact paused position. */
export function registerVideoNodeElement(nodeId: string, element: HTMLVideoElement | null) {
    if (element) playheads.set(nodeId, element);
    else playheads.delete(nodeId);
}

/** Current paused position of a video node, or null when the node is not rendered. */
export function readVideoPlayhead(nodeId: string): VideoPlayheadPosition | null {
    const element = playheads.get(nodeId);
    if (!element) return null;
    const timeMs = element.currentTime * 1000;
    const durationMs = Number.isFinite(element.duration) ? element.duration * 1000 : 0;
    return { timeMs, durationMs, paused: element.paused, nodeId };
}
