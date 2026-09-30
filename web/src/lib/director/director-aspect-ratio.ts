export const DIRECTOR_ASPECT_RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export type DirectorAspectRatio = typeof DIRECTOR_ASPECT_RATIOS[number];

export function isDirectorAspectRatio(value: unknown): value is DirectorAspectRatio {
    return DIRECTOR_ASPECT_RATIOS.some((ratio) => ratio === value);
}

export function directorAspectRatioValue(ratio: DirectorAspectRatio): number | null {
    if (ratio === "adaptive") return null;
    const [width, height] = ratio.split(":").map(Number);
    return width / height;
}

export type DirectorFrameRect = { x: number; y: number; width: number; height: number };

/** The centered preview frame and exported crop use the same normalized geometry. */
export function resolveDirectorFrameRect(width: number, height: number, ratio: DirectorAspectRatio, fill = 0.82): DirectorFrameRect {
    const aspect = directorAspectRatioValue(ratio);
    if (!aspect || width <= 0 || height <= 0) return { x: 0, y: 0, width, height };
    const maxWidth = width * fill;
    const maxHeight = height * fill;
    const frameWidth = Math.min(maxWidth, maxHeight * aspect);
    const frameHeight = frameWidth / aspect;
    return { x: (width - frameWidth) / 2, y: (height - frameHeight) / 2, width: frameWidth, height: frameHeight };
}

export function resolveDirectorPixelCrop(width: number, height: number, ratio: DirectorAspectRatio): DirectorFrameRect {
    const frame = resolveDirectorFrameRect(width, height, ratio);
    if (ratio === "adaptive") return frame;
    return { x: Math.round(frame.x), y: Math.round(frame.y), width: Math.max(1, Math.round(frame.width)), height: Math.max(1, Math.round(frame.height)) };
}

/** Uses the same crop for still captures and the first frame of video recording. */
export function cropDirectorCanvas(source: HTMLCanvasElement, aspectRatio: DirectorAspectRatio): HTMLCanvasElement {
    if (aspectRatio === "adaptive") return source;
    const crop = resolveDirectorPixelCrop(source.width, source.height, aspectRatio);
    const output = document.createElement("canvas");
    output.width = crop.width;
    output.height = crop.height;
    const context = output.getContext("2d");
    if (!context) throw new Error("无法创建画幅裁切画布");
    context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return output;
}
