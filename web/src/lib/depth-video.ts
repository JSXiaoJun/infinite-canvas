import type { FaceLandmarker, NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

import i18n from "@/i18n";

export const depthVideoModes = ["depth", "pose", "depth-pose", "face", "all"] as const;
export type DepthVideoMode = (typeof depthVideoModes)[number];
export type DepthVideoProgress = { stage: "loading" | "processing"; percent: number };

const modeLayers: Record<DepthVideoMode, { depth: boolean; pose: boolean; face: boolean }> = {
    depth: { depth: true, pose: false, face: false },
    pose: { depth: false, pose: true, face: false },
    "depth-pose": { depth: true, pose: true, face: false },
    face: { depth: false, pose: false, face: true },
    all: { depth: true, pose: true, face: true },
};

const DEPTH_MODEL = "onnx-community/depth-anything-v2-small";
// Depth Anything V2 resizes its input to 518px internally, so larger depth inputs only cost time.
const DEPTH_INPUT_EDGE = 518;
const FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const MAX_PEOPLE = 4;
const POSE_LINE_COLOR = "#38bdf8";
const POSE_JOINT_COLOR = "#f97316";
const FACE_POINT_COLOR = "#4ade80";

type DepthEstimator = (image: HTMLCanvasElement) => Promise<{ depth: { toCanvas: () => CanvasImageSource } }>;
type PoseModel = { landmarker: PoseLandmarker; connections: { start: number; end: number }[] };

let depthTask: Promise<DepthEstimator> | undefined;
let faceTask: Promise<FaceLandmarker> | undefined;
let poseTask: Promise<PoseModel> | undefined;
// MediaPipe VIDEO mode requires timestamps to keep increasing for the lifetime of each landmarker, across runs.
let mediapipeClock = 0;

function retryable<T>(task: Promise<T>, reset: () => void) {
    return task.catch((error) => {
        reset();
        throw error;
    });
}

function loadDepth(onProgress: (percent: number) => void) {
    depthTask ??= retryable(
        (async () => {
            const { pipeline } = await import("@huggingface/transformers");
            const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> } }).gpu;
            const adapter = await gpu?.requestAdapter().catch(() => null);
            const webgpu = Boolean(adapter?.features.has("shader-f16"));
            const estimator = await pipeline("depth-estimation", DEPTH_MODEL, {
                device: webgpu ? "webgpu" : "wasm",
                dtype: webgpu ? "fp16" : "q8",
                progress_callback: (info) => {
                    if (info.status === "progress_total") onProgress(Math.round(info.progress));
                },
            });
            return estimator as unknown as DepthEstimator;
        })(),
        () => (depthTask = undefined),
    );
    return depthTask;
}

async function createLandmarker<T>(create: (delegate: "GPU" | "CPU") => Promise<T>) {
    return create("GPU").catch(() => create("CPU"));
}

function loadFace() {
    faceTask ??= retryable(
        (async () => {
            const { FaceLandmarker } = await import("@mediapipe/tasks-vision");
            return createLandmarker((delegate) => FaceLandmarker.createFromOptions({ wasmLoaderPath, wasmBinaryPath }, { baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate }, runningMode: "VIDEO", numFaces: MAX_PEOPLE }));
        })(),
        () => (faceTask = undefined),
    );
    return faceTask;
}

function loadPose() {
    poseTask ??= retryable(
        (async () => {
            const { PoseLandmarker } = await import("@mediapipe/tasks-vision");
            const landmarker = await createLandmarker((delegate) => PoseLandmarker.createFromOptions({ wasmLoaderPath, wasmBinaryPath }, { baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate }, runningMode: "VIDEO", numPoses: MAX_PEOPLE }));
            return { landmarker, connections: PoseLandmarker.POSE_CONNECTIONS };
        })(),
        () => (poseTask = undefined),
    );
    return poseTask;
}

function createCanvas(width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function drawPoses(context: CanvasRenderingContext2D, poses: NormalizedLandmark[][], connections: PoseModel["connections"], width: number, height: number) {
    const visible = (point?: NormalizedLandmark) => Boolean(point && (point.visibility ?? 1) > 0.5);
    const size = Math.max(2, Math.round(Math.max(width, height) / 360));
    context.lineWidth = size;
    context.lineCap = "round";
    context.strokeStyle = POSE_LINE_COLOR;
    context.fillStyle = POSE_JOINT_COLOR;
    for (const pose of poses) {
        context.beginPath();
        for (const { start, end } of connections) {
            if (!visible(pose[start]) || !visible(pose[end])) continue;
            context.moveTo(pose[start].x * width, pose[start].y * height);
            context.lineTo(pose[end].x * width, pose[end].y * height);
        }
        context.stroke();
        for (const point of pose.filter(visible)) {
            context.beginPath();
            context.arc(point.x * width, point.y * height, size * 1.5, 0, Math.PI * 2);
            context.fill();
        }
    }
}

function drawFaces(context: CanvasRenderingContext2D, faces: NormalizedLandmark[][], width: number, height: number) {
    const size = Math.max(2, Math.round(Math.max(width, height) / 480));
    context.fillStyle = FACE_POINT_COLOR;
    for (const face of faces) {
        for (const point of face) context.fillRect(point.x * width - size / 2, point.y * height - size / 2, size, size);
    }
}

/** Convert a video frame by frame in the browser and return an mp4 that keeps the original audio track. */
export async function convertDepthVideo(file: Blob, mode: DepthVideoMode, preview: HTMLCanvasElement, onProgress: (progress: DepthVideoProgress) => void, signal: AbortSignal): Promise<Blob> {
    if (typeof VideoEncoder === "undefined") throw new Error(i18n.t("depthVideo.webCodecsUnsupported"));
    const layers = modeLayers[mode];
    onProgress({ stage: "loading", percent: 0 });
    // Face capture runs before pose and depth, both when loading and for every frame.
    const face = layers.face ? await loadFace() : undefined;
    const pose = layers.pose ? await loadPose() : undefined;
    const depth = layers.depth ? await loadDepth((percent) => onProgress({ stage: "loading", percent })) : undefined;
    signal.throwIfAborted();

    const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, QUALITY_HIGH } = await import("mediabunny");
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error(i18n.t("depthVideo.noVideoTrack"));
        const width = Math.max(2, Math.floor(track.displayWidth / 2) * 2);
        const height = Math.max(2, Math.floor(track.displayHeight / 2) * 2);
        const depthScale = Math.min(1, DEPTH_INPUT_EDGE / Math.max(width, height));
        const frame = createCanvas(width, height);
        const frameContext = frame.getContext("2d")!;
        const depthInput = createCanvas(Math.max(1, Math.round(width * depthScale)), Math.max(1, Math.round(height * depthScale)));
        const depthContext = depthInput.getContext("2d", { willReadFrequently: true })!;
        preview.width = width;
        preview.height = height;
        const context = preview.getContext("2d")!;
        const clockStart = mediapipeClock + 1000;

        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const conversion = await Conversion.init({
            input,
            output,
            video: {
                allowTransformationMetadata: false,
                quality: QUALITY_HIGH,
                processedWidth: width,
                processedHeight: height,
                process: async (sample) => {
                    sample.draw(frameContext, 0, 0, width, height);
                    mediapipeClock = Math.max(mediapipeClock + 1, clockStart + Math.round(sample.timestamp * 1000));
                    const faces = face?.detectForVideo(frame, mediapipeClock).faceLandmarks ?? [];
                    const poses = pose?.landmarker.detectForVideo(frame, mediapipeClock).landmarks ?? [];
                    if (depth) {
                        depthContext.drawImage(frame, 0, 0, depthInput.width, depthInput.height);
                        const result = await depth(depthInput);
                        context.drawImage(result.depth.toCanvas(), 0, 0, width, height);
                    } else {
                        context.drawImage(frame, 0, 0);
                    }
                    if (pose) drawPoses(context, poses, pose.connections, width, height);
                    drawFaces(context, faces, width, height);
                    return preview;
                },
            },
        });
        if (!conversion.isValid) throw new Error(i18n.t("depthVideo.unsupportedVideo"));
        conversion.onProgress = (progress) => onProgress({ stage: "processing", percent: Math.min(100, Math.round(progress * 100)) });
        const cancel = () => void conversion.cancel();
        signal.addEventListener("abort", cancel, { once: true });
        try {
            await conversion.execute();
        } finally {
            signal.removeEventListener("abort", cancel);
        }
        signal.throwIfAborted();
        return new Blob([output.target.buffer!], { type: "video/mp4" });
    } finally {
        input.dispose();
    }
}
