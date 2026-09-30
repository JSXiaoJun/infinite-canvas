import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls, TransformControls } from "@react-three/drei";
import { Video as VideoIcon } from "lucide-react";
import { Component, forwardRef, memo, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { AnimationClip, AnimationMixer, BackSide, Box3, Bone, Camera, Color, EquirectangularReflectionMapping, Euler, Group, LoopOnce, LoopRepeat, Matrix4, Mesh, MeshBasicMaterial, MeshDepthMaterial, MeshNormalMaterial, MeshStandardMaterial, Object3D, OrthographicCamera, PerspectiveCamera, Plane, Quaternion, Raycaster, Scene, SkeletonHelper, SphereGeometry, SRGBColorSpace, Texture, TextureLoader, Vector2, Vector3, WebGLRenderer } from "three";
import type { Material } from "three";
import { GLTFLoader, SkeletonUtils } from "three-stdlib";

import { resolveDirectorBoneRotation } from "@/lib/director/director-animation-semantics";
import { cropDirectorCanvas, resolveDirectorFrameRect, resolveDirectorPixelCrop, type DirectorAspectRatio } from "@/lib/director/director-aspect-ratio";
import { directorStagePalette } from "@/lib/director/director-stage-palette";
import { directorGroundSettings } from "@/lib/director/director-ground";
import { directorPanoramaSphere, suspendDirectorPanoramaSphere } from "@/lib/director/director-panorama-sphere";
import { directorStageLocalCamera, directorStageLocalPoint, directorStageMatrix, directorStagePoint, directorStageTransform } from "@/lib/director/director-stage-transform";
import { suspendDirectorEditorOverlays } from "@/lib/director/director-editor-overlays";
import type { DirectorOrientation } from "@/lib/director/director-orientation-gizmo";
import { applyClaySceneMaterials } from "@/lib/director/director-clay-materials";
import { createDirectorTransaction, installDirectorTerminalListeners } from "@/lib/director/director-gesture-transaction";
import { emptyDirectorPlacementIntent, finiteDirectorGroundPoint, type DirectorGroundPoint, type DirectorPlacementIntent } from "@/lib/director/director-placement";
import { directorDiagnosticObjectKind } from "@/lib/director/director-diagnostics";
import { recordDirectorDiagnostic } from "@/lib/director/director-diagnostics-recorder";
import { directorCaptureInitial, directorCaptureUsable, directorLoadIdentity, directorLoadInitial, installDirectorContextListeners, reduceDirectorCapture, reduceDirectorLoad, releaseDirectorCapture, resolveDirectorDisplay, restoreDirectorCapture, upsertDirectorFailedLoad, type DirectorFailedLoads, type DirectorLoadSignal } from "@/lib/director/director-recovery";
import { disposeDirectorAdoptionFailure, disposeDirectorHelper, disposeDirectorMaterials, disposeDirectorModelResources, disposeDirectorObject3D, resolveDirectorLoadOwnership } from "@/lib/director/director-resources";
import { DIRECTOR_DEFAULT_ACTOR_URL, directorPoseBoneDeltas, directorTransformPathLength, finiteDirectorTransformKeyframes, interpolateDirectorTransform } from "@/lib/director/director-scene";
import { DIRECTOR_DEFAULT_VIEW_MODE, directorViewFramingKey, resolveDirectorActiveCamera, resolveDirectorCameraLocalFraming, resolveDirectorEffectiveViewport, resolveDirectorOrthographicFraming, resolveDirectorOrthographicFrustum, resolveDirectorViewFraming, resolveDirectorViewUp, type DirectorOrthographicFraming, type DirectorViewFraming, type DirectorViewMode } from "@/lib/director/director-view-modes";
import { DirectorViewToolbar } from "@/pages/director/components/director-view-toolbar";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl } from "@/services/image-storage";
import type { DirectorHumanoidBone, DirectorLight, DirectorObject, DirectorQuat, DirectorRenderMode, DirectorRig, DirectorScene, DirectorTransform, DirectorVec3 } from "@/types/director";

export type DirectorOrbitControls = ComponentRef<typeof OrbitControls>;

export type DirectorViewportHandle = {
    capture: (mode: DirectorRenderMode) => Promise<Blob>;
    recordVideo: (duration: number, fps: number) => Promise<Blob>;
    readCameraTransform: () => DirectorTransform | null;
    /** 只读放置意图。上下文不可用或从未产生合法点时返回空意图，绝不抛异常。 */
    readPlacementIntent: () => DirectorPlacementIntent;
};

type DirectorViewportProps = {
    scene: DirectorScene;
    selectedObjectId: string | null;
    selectedBone: string | null;
    transformMode: "translate" | "rotate" | "scale";
    renderMode: DirectorRenderMode;
    playhead: number;
    playing: boolean;
    /** 动画模式下显示演员与摄影机 Transform 关键帧形成的空间路径。 */
    showMotionPaths?: boolean;
    /** 取景模式。省略即自由视角，保持接线前的行为不变。 */
    viewMode?: DirectorViewMode;
    /** 提供该回调即在视口内渲染 3D/CAM 切换器；不提供则不显示，视口仍按 viewMode 取景。 */
    onViewModeChange?: (mode: DirectorViewMode) => void;
    onCaptureReadyChange?: (ready: boolean) => void;
    onSelectObject: (id: string | null) => void;
    onSelectBone: (bone: string | null) => void;
    onObjectTransform: (id: string, from: DirectorTransform, to: DirectorTransform) => void;
    onBoneTransform: (id: string, bone: string, rotation: DirectorQuat) => void;
    onActorRigReady: (id: string, rig: DirectorRig, animations: AnimationClip[]) => void;
};

type CaptureContext = { gl: WebGLRenderer; scene: Scene; camera: Camera; suspendDisplayMaterialOverride: () => () => void };

// 稳定空值：identity 不匹配时返回同一引用，避免下游 effect 依赖每次 render 都变化。
const emptyAnimations: AnimationClip[] = [];
const emptyRestRotations: Partial<Record<DirectorHumanoidBone, DirectorQuat>> = {};

// Canvas 配置必须是稳定引用：inline literal 每次父级 render 都是新对象，
// context lost 的 dispatch 触发重渲染后 R3F 会 configure 并在失效 context 上
// 重建 WebGLRenderer，抛 getMaxPrecision / autoReset。稳定后 lost 只显示 notice。
const directorCanvasGl = { antialias: true, preserveDrawingBuffer: true, alpha: false } as const;
const directorCanvasCamera = { position: [7.1, 3.8, 9.2] as [number, number, number], fov: 50, near: 0.05, far: 1200 } as const;
const directorCanvasDpr: [number, number] = [1, 1.5];
// 自由视角固定环绕焦点：free 是独立观察相机，不跟随 shot 摄影机的 target 走，
// 否则切换镜头/摄影机会连带把用户正在环绕的焦点也悄悄挪走。
const DIRECTOR_FREE_ORBIT_TARGET: DirectorVec3 = [0, 1, 0];

export const DirectorViewport = forwardRef<DirectorViewportHandle, DirectorViewportProps>(function DirectorViewport(props, ref) {
    // onViewModeChange 只服务 DOM 层的切换器，绝不进 Canvas 子树：它的身份每次父级
    // render 都可能变化，穿透到 memo 化的 Canvas 会触发 configure 重建 renderer。
    const { onViewModeChange, onCaptureReadyChange, ...sceneProps } = props;
    const captureContext = useRef<CaptureContext | null>(null);
    const shellRef = useRef<HTMLDivElement>(null);
    const [shellSize, setShellSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const shell = shellRef.current;
        if (!shell) return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setShellSize({ width: entry.contentRect.width, height: entry.contentRect.height });
        });
        observer.observe(shell);
        return () => observer.disconnect();
    }, []);
    const aspectRatio = props.scene.aspectRatio || "adaptive";
    const frame = resolveDirectorFrameRect(shellSize.width, shellSize.height, aspectRatio);
    // 地面点连同 owner canvas 一起记录：owner 不是当前 renderer 的 canvas 就是陈旧值。
    const groundRef = useRef<{ owner: HTMLCanvasElement; point: DirectorGroundPoint } | null>(null);
    const orbitControlsRef = useRef<DirectorOrbitControls | null>(null);
    const orbitOrientationListenerRef = useRef<(() => void) | null>(null);
    const [freeOrientation, setFreeOrientation] = useState<DirectorOrientation>([0, 0, 0, 1]);
    const [cameraOrientation, setCameraOrientation] = useState<DirectorOrientation>([0, 0, 0, 1]);
    const onCameraOrientation = useCallback((next: DirectorOrientation) => {
        setCameraOrientation((current) => current.every((value, index) => Math.abs(value - next[index]) < 0.002) ? current : next);
    }, []);
    /** pointermove 高频路径只写 ref，不触发 render；清空只允许由该点的 owner 发起。 */
    const onGroundPoint = useCallback((owner: HTMLCanvasElement, point: DirectorGroundPoint | null) => {
        if (point) {
            groundRef.current = { owner, point };
            return;
        }
        if (groundRef.current?.owner === owner) groundRef.current = null;
    }, []);
    const onOrbitControls = useCallback((controls: DirectorOrbitControls | null) => {
        orbitOrientationListenerRef.current?.();
        orbitOrientationListenerRef.current = null;
        orbitControlsRef.current = controls;
        if (!controls) return;
        const readOrientation = () => {
            const { x, y, z, w } = controls.object.quaternion;
            const next: DirectorOrientation = [x, y, z, w];
            setFreeOrientation((current) => current.every((value, index) => Math.abs(value - next[index]) < 0.002) ? current : next);
        };
        controls.addEventListener("change", readOrientation);
        orbitOrientationListenerRef.current = () => controls.removeEventListener("change", readOrientation);
        readOrientation();
    }, []);
    useEffect(() => () => orbitOrientationListenerRef.current?.(), []);
    const resetView = useCallback(() => {
        onViewModeChange?.("free");
        orbitControlsRef.current?.reset();
    }, [onViewModeChange]);
    // retryKey 变化会真正重建 Canvas 与 ErrorBoundary，而不是只换文案。
    const [retryKey, setRetryKey] = useState(0);
    // capture 可用性：上下文丢失期间不得再使用失效 renderer；恢复后需重新登记。
    const [capture, dispatchCapture] = useReducer(reduceDirectorCapture, directorCaptureInitial);
    const captureReady = directorCaptureUsable(capture);
    useEffect(() => {
        onCaptureReadyChange?.(captureReady);
    }, [captureReady, onCaptureReadyChange]);
    useEffect(() => () => onCaptureReadyChange?.(false), [onCaptureReadyChange]);
    const captureRef = useRef(capture);
    captureRef.current = capture;
    // 加载失败的对象 id -> 该对象自己的 retry；Canvas 内部无法呈现可操作提示，统一提到 DOM 层。
    const [failedLoads, setFailedLoads] = useState<DirectorFailedLoads>({});
    const onCaptureContext = useCallback((context: CaptureContext) => {
        captureContext.current = context;
        dispatchCapture("register");
    }, []);
    /** 子树卸载 / boundary 捕获：清掉指向已销毁 renderer 的引用并打回不可用。 */
    const releaseCapture = useCallback(() => {
        releaseDirectorCapture({
            clearContext: () => {
                captureContext.current = null;
            },
            onAvailability: dispatchCapture,
        });
        // 地面点与 controls 都属于已销毁的 renderer，必须一并作废。
        groundRef.current = null;
        orbitControlsRef.current = null;
    }, []);
    const retry = useCallback(() => {
        releaseCapture();
        setFailedLoads({});
        setRetryKey((value) => value + 1);
    }, [releaseCapture]);
    const onLoadStateChange = useCallback((id: string, signal: DirectorLoadSignal, retryLoad: () => void) => {
        setFailedLoads((current) => upsertDirectorFailedLoad(current, id, signal, retryLoad));
    }, []);
    // 稳定引用：否则新的监听 effect 会在每次父级 render 时摘除重装。
    const onContextLost = useCallback(() => {
        // 上下文丢失后相机与射线结果都不可信，旧地面点必须作废，恢复后需重新移动 pointer。
        groundRef.current = null;
        recordDirectorDiagnostic("DIRECTOR_VIEWPORT_CONTEXT_LOST");
        dispatchCapture("lost");
    }, []);
    const onContextRestored = useCallback(() => {
        recordDirectorDiagnostic("DIRECTOR_VIEWPORT_CONTEXT_RESTORED");
        dispatchCapture("restored");
    }, []);
    const failedIds = Object.keys(failedLoads);
    // 上下文失效时 renderer 不可用：capture/record/readCamera 必须明确失败而不是画出脏帧。
    const usableContext = () => {
        if (!directorCaptureUsable(captureRef.current)) return null;
        return captureContext.current;
    };
    useImperativeHandle(ref, () => ({
        capture: (mode) => captureFrame(usableContext(), mode, aspectRatio),
        recordVideo: (duration, fps) => recordCanvas(usableContext(), duration, fps, aspectRatio),
        readCameraTransform: () => {
            const camera = usableContext()?.camera;
            return camera ? directorStageLocalCamera(directorStageTransform(props.scene), { position: camera.position.toArray() as DirectorTransform["position"], rotation: [camera.rotation.x, camera.rotation.y, camera.rotation.z], scale: [1, 1, 1] }) : null;
        },
        readPlacementIntent: () => {
            const context = usableContext();
            if (!context) return emptyDirectorPlacementIntent;
            // owner 校验：上下文重建后，旧 renderer canvas 记录的点一律不采用。
            const tracked = groundRef.current;
            const pointer = tracked && tracked.owner === context.gl.domElement ? tracked.point : null;
            // 读实例当前世界系 target，再转回场景局部 XZ；平移/旋转/缩放后仍能按原坐标放置。
            const target = orbitControlsRef.current?.target;
            const localTarget = target ? directorStageLocalPoint(directorStageTransform(props.scene), target.toArray() as DirectorVec3) : null;
            return { pointer, orbitTarget: finiteDirectorGroundPoint(localTarget?.[0], localTarget?.[2]) };
        },
    }), [aspectRatio, props.scene]);

    return (
        // data-renderer-ready 直接来自 directorCaptureUsable：capture context 已登记且未 lost。
        // 这是真实就绪信号，供 E2E 在触发 context loss 前确定监听器已安装。
        <div ref={shellRef} className="director-viewport-shell" data-renderer-ready={directorCaptureUsable(capture) ? "true" : "false"}>
            <DirectorViewportErrorBoundary key={`boundary-${retryKey}`} onRelease={releaseCapture} onRetry={retry}>
                <DirectorCanvasSurface
                    key={`canvas-${retryKey}`}
                    {...sceneProps}
                    onCaptureContext={onCaptureContext}
                    onRelease={releaseCapture}
                    onContextLost={onContextLost}
                    onContextRestored={onContextRestored}
                    onLoadStateChange={onLoadStateChange}
                    onGroundPoint={onGroundPoint}
                    onOrbitControls={onOrbitControls}
                    onCameraOrientation={onCameraOrientation}
                />
            </DirectorViewportErrorBoundary>
            {aspectRatio !== "adaptive" && frame.width > 0 ? <div data-director-aspect-frame={aspectRatio} aria-label={`${aspectRatio} 画幅取景框`} className="pointer-events-none absolute rounded-xl border border-white/35" style={{ zIndex: 1, left: frame.x, top: frame.y, width: frame.width, height: frame.height, boxShadow: "0 0 0 100vmax rgba(0, 0, 0, 0.68)" }} /> : null}
            {/* 取景切换是纯视口状态：放在 DOM 层，不随 Canvas 重建而丢失。 */}
            {onViewModeChange ? <DirectorViewToolbar viewMode={props.viewMode ?? DIRECTOR_DEFAULT_VIEW_MODE} orientation={props.viewMode === "camera" ? cameraOrientation : freeOrientation} onViewModeChange={onViewModeChange} onResetView={resetView} /> : null}
            {capture.contextLost ? (
                <DirectorViewportNotice
                    title="3D 显示上下文已丢失"
                    description="浏览器回收了 WebGL 上下文。等待自动恢复，或立即重建视口。"
                    actionLabel="重建 3D 视口"
                    onAction={retry}
                />
            ) : null}
            {!capture.contextLost && failedIds.length ? (
                <DirectorViewportNotice
                    variant="corner"
                    title={`${failedIds.length} 个 3D 模型加载失败`}
                    description="已用占位人偶继续显示场景。可能是网络或模型地址不可用，重试将重新加载。"
                    actionLabel="重试加载"
                    onAction={() => {
                        // 重试触发新的 load generation，旧的晚到回调会被忽略并释放资源。
                        Object.values(failedLoads).forEach((retryLoad) => retryLoad());
                        setFailedLoads({});
                    }}
                />
            ) : null}
        </div>
    );
});

// onViewModeChange 被显式排除：切换器活在 DOM 层，Canvas 子树只需要 viewMode 取值。
type DirectorCanvasSurfaceProps = Omit<DirectorViewportProps, "onViewModeChange" | "onCaptureReadyChange"> & {
    onCaptureContext: (context: CaptureContext) => void;
    onRelease: () => void;
    onContextLost: () => void;
    onContextRestored: () => void;
    onLoadStateChange: (id: string, signal: DirectorLoadSignal, retry: () => void) => void;
    onGroundPoint: (owner: HTMLCanvasElement, point: DirectorGroundPoint | null) => void;
    onOrbitControls: (controls: DirectorOrbitControls | null) => void;
    onCameraOrientation: (orientation: DirectorOrientation) => void;
};

/**
 * Canvas 表面独立 memo。
 *
 * R3F 本地 CanvasImpl 的 layout effect 没有依赖数组，父级每次 rerender 都会 configure。
 * context lost 时 DirectorViewport 会 dispatchCapture 触发 rerender，若 Canvas 跟着重渲染，
 * configure 就会在已失效的 canvas 上重建 WebGLRenderer 并抛 getMaxPrecision / autoReset。
 * 隔离在 memo 子组件后，contextLost / failedLoads 这类外层状态变化不再穿透到 Canvas；
 * 只有 props 真的变化才重渲染，retryKey 变化仍由外层 key 触发真正 remount。
 */
const DirectorCanvasSurface = memo(function DirectorCanvasSurface(props: DirectorCanvasSurfaceProps) {
    const { onCaptureContext, onRelease, onContextLost, onContextRestored, onLoadStateChange, onGroundPoint, onOrbitControls, onCameraOrientation, ...sceneProps } = props;
    const onSelectObject = sceneProps.onSelectObject;
    const onPointerMissed = useCallback(() => onSelectObject(null), [onSelectObject]);

    return (
        <Canvas
            shadows
            frameloop="demand"
            dpr={directorCanvasDpr}
            camera={directorCanvasCamera}
            gl={directorCanvasGl}
            onPointerMissed={onPointerMissed}
        >
            <Suspense fallback={null}>
                <DirectorSceneContent
                    {...sceneProps}
                    onCaptureContext={onCaptureContext}
                    onRelease={onRelease}
                    onContextLost={onContextLost}
                    onContextRestored={onContextRestored}
                    onLoadStateChange={onLoadStateChange}
                    onGroundPoint={onGroundPoint}
                    onOrbitControls={onOrbitControls}
                    onCameraOrientation={onCameraOrientation}
                />
            </Suspense>
        </Canvas>
    );
});

/** 本地失败隔离：3D 视口异常只替换视口本身，不影响画布/项目其余部分。 */
class DirectorViewportErrorBoundary extends Component<{ children: ReactNode; onRelease: () => void; onRetry: () => void }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch() {
        // 只记录稳定错误码：原始 error / componentStack 可能带素材 URL 或正文，不落日志。
        recordDirectorDiagnostic("DIRECTOR_VIEWPORT_RENDER_FAILED");
        // 子树已被 React 卸载，capture context 指向已销毁的 renderer，必须同步释放。
        this.props.onRelease();
    }

    render() {
        if (!this.state.failed) return this.props.children;
        return (
            <DirectorViewportNotice
                title="3D 视口渲染失败"
                description="导演台其余面板仍可使用。可重试重建视口；若持续失败请检查显卡驱动或浏览器 WebGL 支持。"
                actionLabel="重试 3D 视口"
                onAction={() => {
                    this.setState({ failed: false });
                    this.props.onRetry();
                }}
            />
        );
    }
}

function DirectorViewportNotice({ title, description, actionLabel, onAction, variant = "cover" }: { title: string; description: string; actionLabel: string; onAction: () => void; variant?: "cover" | "corner" }) {
    return (
        <div className={`director-viewport-notice ${variant === "corner" ? "is-corner" : "is-cover"}`} role="alert">
            <div className="director-viewport-notice-title">{title}</div>
            <p className="director-viewport-notice-text">{description}</p>
            <button type="button" className="director-viewport-notice-action" onClick={onAction}>{actionLabel}</button>
        </div>
    );
}

function DirectorSceneContent({ scene, selectedObjectId, selectedBone, transformMode, renderMode, playhead, playing, showMotionPaths = false, viewMode = DIRECTOR_DEFAULT_VIEW_MODE, onSelectObject, onSelectBone, onObjectTransform, onBoneTransform, onActorRigReady, onCaptureContext, onRelease, onContextLost, onContextRestored, onLoadStateChange, onGroundPoint, onOrbitControls, onCameraOrientation }: DirectorCanvasSurfaceProps) {
    const { gl, camera, scene: threeScene, invalidate, set, size } = useThree();
    const orbitRef = useRef<DirectorOrbitControls>(null);
    const stage = directorStageTransform(scene);
    const stageMatrix = useMemo(() => directorStageMatrix(stage), [stage]);
    const [transforming, setTransforming] = useState(false);
    const displayClayRestoreRef = useRef<(() => void) | null>(null);
    const panoramaSphereRef = useRef<Mesh | null>(null);
    const panoramaSettings = directorPanoramaSphere(scene);
    const panoramaDisplayRef = useRef({ ...panoramaSettings, renderMode });
    panoramaDisplayRef.current = { ...panoramaSettings, renderMode };
    // 三台相机各司其职、互不共享：free 只由 OrbitControls 驱动，CAM/正交只在各自模式下
    // 由取景数据接管。切换 viewMode 只挪动「谁是活动相机」这个指针，任何一台的内部状态
    // 都不会因为切换而被读写——这是「切换不丢失/不污染任一相机状态」的唯一来源。
    const [freeCamera] = useState(() => {
        const instance = new PerspectiveCamera(directorCanvasCamera.fov, 1, directorCanvasCamera.near, directorCanvasCamera.far);
        instance.position.set(...directorCanvasCamera.position);
        return instance;
    });
    const [camCamera] = useState(() => new PerspectiveCamera(directorCanvasCamera.fov, 1, directorCanvasCamera.near, directorCanvasCamera.far));
    const [orthoCamera] = useState(() => new OrthographicCamera(-1, 1, 1, -1, 0.05, 500));
    // CAM 与正交轴向的取景解算都是纯函数：mode 不匹配时各自返回 null，互不冲突。
    // 活动相机不直接看 viewMode：CAM 取景失败必须回落 free，否则会露出从未写入的 camCamera。
    const camFraming = resolveDirectorViewFraming({ scene, mode: viewMode, playhead });
    const orthoFraming = resolveDirectorOrthographicFraming({ scene, mode: viewMode });
    const effectiveViewport = resolveDirectorEffectiveViewport({ mode: viewMode, framing: camFraming });
    useFrame(() => {
        if (viewMode !== "camera" || effectiveViewport.camera !== "camera") return;
        const { x, y, z, w } = camCamera.quaternion;
        onCameraOrientation([x, y, z, w]);
    });
    const actorMotionPaths = useMemo(() => showMotionPaths ? scene.objects.filter((object) => object.visible && (object.kind === "actor" || object.primitive === "character") && directorTransformPathLength(object.keyframes) > 0.001) : [], [scene.objects, showMotionPaths]);
    const cameraMotionPaths = useMemo(() => showMotionPaths ? scene.cameras.filter((item) => directorTransformPathLength(item.keyframes) > 0.001) : [], [scene.cameras, showMotionPaths]);
    const suspendDisplayMaterialOverride = useCallback(() => {
        const suspended = Boolean(displayClayRestoreRef.current);
        displayClayRestoreRef.current?.();
        displayClayRestoreRef.current = null;
        return () => {
            if (suspended) displayClayRestoreRef.current = applyClaySceneMaterials(threeScene);
        };
    }, [threeScene]);

    const readCaptureContext = useCallback((): CaptureContext => ({ gl, camera: camera as Camera, scene: threeScene, suspendDisplayMaterialOverride }), [camera, gl, suspendDisplayMaterialOverride, threeScene]);

    useEffect(() => {
        onCaptureContext(readCaptureContext());
    }, [onCaptureContext, readCaptureContext]);

    // 子树卸载（重试重建、boundary 捕获后 React 卸载）时同步释放：
    // 此后 captureContext 指向已销毁的 renderer，必须清空并打回不可用。
    // 单独 effect 且只依赖稳定的 onRelease，不会被 readCaptureContext 变化连带触发。
    useEffect(() => () => onRelease(), [onRelease]);

    // 上下文丢失/恢复监听绑定在 renderer 自己的 canvas 上，随 renderer 与重试精确摘除。
    useEffect(() => installDirectorContextListeners(gl.domElement, {
        onLost: onContextLost,
        // 恢复后 registered 会被置回 false，必须用当前 renderer 重新登记，
        // 否则 capture/record/readCameraTransform 会一直不可用。走与测试共用的序列 helper。
        onRestored: () => restoreDirectorCapture({
            readContext: readCaptureContext,
            onAvailability: onContextRestored,
            onRegister: onCaptureContext,
            invalidate,
        }),
    }), [gl, invalidate, onCaptureContext, onContextLost, onContextRestored, readCaptureContext]);

    /**
     * 地面拾取：renderer 自己的 canvas 上做 pointer 监听，再用真实 Raycaster 与
     * 变换后的场景局部 y=0 Plane 求交。不走 mesh onPointerMove（会被物体 stopPropagation 截断），
     * 也不做 DOM 像素伪换算；因此 pointer 悬停在物体上方时射线仍与地面相交。
     * 高频路径只写 ref，绝不 setState。
     */
    useEffect(() => {
        const canvasElement = gl.domElement;
        const raycaster = new Raycaster();
        const groundPlane = new Plane(new Vector3(0, 1, 0), 0).applyMatrix4(stageMatrix);
        const inverseStageMatrix = stageMatrix.clone().invert();
        const hit = new Vector3();
        const localHit = new Vector3();
        const ndc = new Vector2();

        const onPointerMove = (event: PointerEvent) => {
            const bounds = canvasElement.getBoundingClientRect();
            if (bounds.width <= 0 || bounds.height <= 0) return;
            ndc.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
            raycaster.setFromCamera(ndc, camera);
            // 射线与地面平行或背离时 intersectPlane 返回 null：保留上一个合法点，不写非法值。
            if (!raycaster.ray.intersectPlane(groundPlane, hit)) return;
            localHit.copy(hit).applyMatrix4(inverseStageMatrix);
            const point = finiteDirectorGroundPoint(localHit.x, localHit.z);
            if (point) onGroundPoint(canvasElement, point);
        };

        canvasElement.addEventListener("pointermove", onPointerMove, { passive: true });
        return () => {
            canvasElement.removeEventListener("pointermove", onPointerMove);
            // 这个 renderer 的 canvas 卸载后，它记录的地面点不得再被读到。
            onGroundPoint(canvasElement, null);
        };
    }, [camera, gl, onGroundPoint, stageMatrix]);

    // OrbitControls 的真实 target 只能从实例读；activeCamera.target 只是初始 prop。
    // 挂载期登记一次即可：drei 重建实例会连带重跑本 effect。
    useEffect(() => {
        onOrbitControls(orbitRef.current);
        return () => onOrbitControls(null);
    }, [onOrbitControls]);

    useEffect(() => {
        let cancelled = false;
        let texture: Texture | null = null;
        let sphere: Mesh | null = null;
        threeScene.background = new Color(scene.background);
        invalidate();
        if (scene.panorama?.url) {
            void resolveImageUrl(scene.panorama.storageKey, scene.panorama.url).then((url) => {
                if (cancelled) return;
                new TextureLoader().load(url, (loaded) => {
                    if (cancelled) { loaded.dispose(); return; }
                    loaded.mapping = EquirectangularReflectionMapping;
                    loaded.colorSpace = SRGBColorSpace;
                    texture = loaded;
                    threeScene.background = loaded;
                    const backdrop = new Mesh(new SphereGeometry(1, 64, 32), new MeshBasicMaterial({ map: loaded, side: BackSide, depthWrite: false, toneMapped: false }));
                    backdrop.userData.directorPanoramaSphere = true;
                    backdrop.raycast = () => {};
                    backdrop.renderOrder = -1000;
                    backdrop.scale.setScalar(panoramaDisplayRef.current.radius);
                    backdrop.rotation.y = panoramaDisplayRef.current.rotation * Math.PI / 180;
                    backdrop.visible = panoramaDisplayRef.current.renderMode === "beauty";
                    sphere = backdrop;
                    panoramaSphereRef.current = backdrop;
                    threeScene.add(backdrop);
                    invalidate();
                });
            });
        }
        return () => {
            cancelled = true;
            if (sphere) {
                threeScene.remove(sphere);
                if (panoramaSphereRef.current === sphere) panoramaSphereRef.current = null;
                sphere.geometry.dispose();
                (sphere.material as MeshBasicMaterial).dispose();
            }
            if (texture) {
                if (threeScene.background === texture) threeScene.background = new Color(scene.background);
                texture.dispose();
            }
        };
    }, [invalidate, scene.background, scene.panorama?.storageKey, scene.panorama?.url, threeScene]);

    useEffect(() => {
        threeScene.backgroundRotation.y = panoramaSettings.rotation * Math.PI / 180;
        if (panoramaSphereRef.current) {
            panoramaSphereRef.current.rotation.y = panoramaSettings.rotation * Math.PI / 180;
            panoramaSphereRef.current.scale.setScalar(panoramaSettings.radius);
            panoramaSphereRef.current.visible = renderMode === "beauty";
        }
        invalidate();
    }, [invalidate, panoramaSettings.radius, panoramaSettings.rotation, renderMode, threeScene]);

    useEffect(() => {
        const material = renderMode === "depth" ? new MeshDepthMaterial() : renderMode === "normal" ? new MeshNormalMaterial() : renderMode === "pose" ? new MeshBasicMaterial({ color: "#ffffff", wireframe: true }) : null;
        if (renderMode === "clay") displayClayRestoreRef.current = applyClaySceneMaterials(threeScene);
        threeScene.overrideMaterial = material;
        invalidate();
        return () => {
            if (threeScene.overrideMaterial === material) threeScene.overrideMaterial = null;
            displayClayRestoreRef.current?.();
            displayClayRestoreRef.current = null;
            material?.dispose();
        };
    }, [invalidate, renderMode, scene.objects, threeScene]);

    // 透视相机（free/CAM）的宽高比随容器尺寸变化；正交相机的半范围在自己的同步 effect 里
    // 按水平/竖直跨度与 aspect 同时拟合，这里只负责两台透视相机的 aspect + 投影矩阵。
    useEffect(() => {
        const aspect = size.width / Math.max(size.height, 1);
        freeCamera.aspect = aspect;
        freeCamera.updateProjectionMatrix();
        camCamera.aspect = aspect;
        camCamera.updateProjectionMatrix();
        invalidate();
    }, [camCamera, freeCamera, invalidate, size]);

    // 唯一决定「视口活动相机是谁」的入口：只挪动 state.camera 指针，从不读写另外两台
    // 相机对象的内部状态——这是「切换模式互不污染」的保证来源。
    // CAM 无合法取景时指针指向 freeCamera，取景恢复后再指回 camCamera。
    useEffect(() => {
        const next = effectiveViewport.camera === "orthographic" ? orthoCamera : effectiveViewport.camera === "camera" ? camCamera : freeCamera;
        set({ camera: next });
        invalidate();
    }, [camCamera, effectiveViewport.camera, freeCamera, invalidate, orthoCamera, set]);

    const stagePalette = directorStagePalette(scene.background);
    const ground = directorGroundSettings(scene);
    return (
        <>
            {/* CAM 与正交轴向的取景各自独立同步到专属相机对象，互不干扰；free 完全交给
                下面的 OrbitControls，这里不对它做任何写入。 */}
            <DirectorShotCameraSync camera={camCamera} framing={camFraming} />
            <DirectorOrthoCameraSync camera={orthoCamera} framing={orthoFraming} aspect={size.width / Math.max(size.height, 1)} />
            <ambientLight intensity={scene.environmentIntensity * 0.35} />
            <group position={stage.position} rotation={stage.rotation.map((degrees) => degrees * Math.PI / 180) as DirectorVec3} scale={stage.scale}>
            {scene.lights.map((light) => <DirectorLightView key={light.id} light={light} />)}
            {viewMode === "free" && renderMode === "beauty" ? scene.cameras.map((item) => <DirectorCameraAid key={item.id} item={item} scene={scene} playhead={playhead} stage={stage} active={item.id === resolveDirectorActiveCamera(scene)?.id} labelsVisible={scene.labelsVisible !== false} />) : null}
            {scene.gridVisible ? <Grid position={[0, 0, 0]} infiniteGrid fadeDistance={40} fadeStrength={5} cellSize={0.5} sectionSize={5} cellColor={stagePalette.cell} sectionColor={stagePalette.section} /> : null}
            {ground.visible ? <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, ground.height - 0.012, 0]}>
                <planeGeometry args={[120, 120]} />
                <meshStandardMaterial color={stagePalette.ground} roughness={0.92} transparent={ground.opacity < 1} opacity={ground.opacity} depthWrite={ground.opacity >= 1} />
            </mesh> : null}
            {actorMotionPaths.map((object) => <DirectorTransformPath key={`actor-path-${object.id}`} keyframes={object.keyframes} playhead={playhead} color="#61d2ad" />)}
            {cameraMotionPaths.map((item) => <DirectorTransformPath key={`camera-path-${item.id}`} keyframes={item.keyframes} playhead={playhead} color="#78a9ff" />)}
            {scene.objects.filter((item) => item.visible).map((object) => (
                <DirectorObjectView
                    key={object.id}
                    object={object}
                    selected={selectedObjectId === object.id}
                    selectedBone={selectedObjectId === object.id ? selectedBone : null}
                    showLabel={scene.labelsVisible !== false && (object.kind === "actor" || object.primitive === "character")}
                    transformMode={transformMode}
                    playhead={playhead}
                    onSelect={() => onSelectObject(object.id)}
                    onSelectBone={(bone) => { onSelectObject(object.id); onSelectBone(bone); }}
                    onTransforming={setTransforming}
                    onTransform={(from, to) => onObjectTransform(object.id, from, to)}
                    onBoneTransform={(bone, rotation) => onBoneTransform(object.id, bone, rotation)}
                    onActorRigReady={(rig, animations) => onActorRigReady(object.id, rig, animations)}
                    onLoadStateChange={onLoadStateChange}
                />
            ))}
            </group>
            {/* 只有有效 free 回落允许环绕：drei 只在 enabled 时调 controls.update()，CAM/正交下这是
                真正的锁定，不会有 controls 每帧把相机拽回自己 target 的回写竞争。
                camera 显式绑定 freeCamera：即使 state.camera 当前指向别的相机，也绝不会
                被这份环绕状态误伤。CAM 取景失败时 orbit 打开，用已有的自由视角，不改场景。 */}
            <OrbitControls ref={orbitRef} makeDefault camera={freeCamera} enabled={!transforming && effectiveViewport.orbit} target={DIRECTOR_FREE_ORBIT_TARGET} minDistance={0.6} maxDistance={80} />
        </>
    );
}

/** Editor-only camera position and frustum, deliberately excluded from captures. */
function DirectorCameraAid({ item, scene, playhead, stage, active, labelsVisible }: { item: DirectorScene["cameras"][number]; scene: DirectorScene; playhead: number; stage: NonNullable<DirectorScene["stageTransform"]>; active: boolean; labelsVisible: boolean }) {
    const framing = resolveDirectorCameraLocalFraming(scene, item, playhead);
    const transform = interpolateDirectorTransform(item.transform, item.keyframes, playhead);
    const localPosition = framing?.position ?? transform.position;
    const position = new Vector3(...localPosition);
    const target = new Vector3(...(framing?.target ?? item.target));
    const direction = target.clone().sub(position);
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, -1).applyEuler(new Euler(...transform.rotation));
    const up = framing?.up ?? resolveDirectorViewUp(transform.rotation, direction.toArray() as DirectorVec3);
    const orientation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(position, position.clone().add(direction), new Vector3(...up)));
    const distance = Math.min(2.5, Math.max(1.2, direction.length() * 0.3));
    const halfHeight = Math.tan((Math.min(120, Math.max(10, item.fov || 50)) * Math.PI) / 360) * distance;
    const halfWidth = halfHeight * 16 / 9;
    const corners: DirectorVec3[] = [[-halfWidth, halfHeight, -distance], [halfWidth, halfHeight, -distance], [halfWidth, -halfHeight, -distance], [-halfWidth, -halfHeight, -distance]];
    const segments: DirectorVec3[] = corners.flatMap((corner, index) => [[0, 0, 0] as DirectorVec3, corner, corner, corners[(index + 1) % 4]]);
    const worldPosition = new Vector3(...directorStagePoint(stage, localPosition));
    const [nearViewer, setNearViewer] = useState(false);
    useFrame(({ camera }) => {
        const next = camera.position.distanceTo(worldPosition) < 0.5;
        setNearViewer((current) => current === next ? current : next);
    });
    if (nearViewer || !framing) return null;
    return <group userData={{ directorEditorOnly: true }} position={localPosition} quaternion={orientation}>
        <Line segments points={segments} color={active ? "#5b9dc7" : "#3f6f8b"} lineWidth={1} transparent opacity={active ? 0.5 : 0.3} raycast={() => {}} />
        <Html center style={{ pointerEvents: "none" }}>
            <div className="flex flex-col items-center gap-0.5 whitespace-nowrap" style={{ color: "#fff", textShadow: "0 1px 3px #000, 0 0 5px #000" }}>
                {labelsVisible ? <span data-director-camera-label={item.id} style={{ fontSize: 12, fontWeight: 600 }}>{item.name}</span> : null}
                <VideoIcon size={25} color={active ? "#f7a815" : "#8ba5b6"} strokeWidth={2.8} aria-hidden />
            </div>
        </Html>
    </group>;
}

/** 起点、终点、路径点、方向与当前进度共用一条 Transform 关键帧路径。 */
function DirectorTransformPath({ keyframes, playhead, color }: { keyframes: DirectorObject["keyframes"]; playhead: number; color: string }) {
    const sorted = useMemo(() => finiteDirectorTransformKeyframes(keyframes).toSorted((left, right) => left.time - right.time), [keyframes]);
    const points = useMemo(() => sorted.map((keyframe) => keyframe.transform.position), [sorted]);
    const current = interpolateDirectorTransform(sorted[0].transform, sorted, playhead).position;
    const previous = points[points.length - 2];
    const end = points[points.length - 1];
    const direction = useMemo(() => {
        const vector = new Vector3(...end).sub(new Vector3(...previous));
        if (vector.lengthSq() < 1e-8) return [0, 0, 0, 1] as DirectorQuat;
        return new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), vector.normalize()).toArray() as DirectorQuat;
    }, [end, previous]);

    return <group>
        <Line points={points} color={color} lineWidth={2} />
        {points.map((point, index) => <mesh key={`${index}-${point.join("-")}`} position={point}>
            <sphereGeometry args={[index === 0 || index === points.length - 1 ? 0.11 : 0.075, 10, 8]} />
            <meshBasicMaterial color={index === 0 ? "#61d2ad" : index === points.length - 1 ? "#f08b6a" : color} />
        </mesh>)}
        <mesh position={end} quaternion={direction}>
            <coneGeometry args={[0.1, 0.28, 10]} />
            <meshBasicMaterial color={color} />
        </mesh>
        <mesh position={current}>
            <sphereGeometry args={[0.14, 12, 8]} />
            <meshBasicMaterial color="#f0d36a" />
        </mesh>
    </group>;
}

/**
 * CAM 取景：把 shot 摄影机的解算结果写进专属的机位相机对象。
 *
 * 这台相机独立持有，不是共享的视口默认相机：离开 CAM 模式后不需要任何快照/还原——
 * 没有人会在其他模式下碰它，回到 CAM 时上一次写入的状态原样还在，物理上不可能被污染。
 *
 * 只写这台相机对象，绝不触碰 DirectorScene：换一只眼睛看场景不是内容改动，
 * 因此不产生任何 undo/history 记录，也不会触发保存。
 */
function DirectorShotCameraSync({ camera, framing }: { camera: PerspectiveCamera; framing: DirectorViewFraming | null }) {
    const invalidate = useThree((state) => state.invalidate);
    const framingKey = directorViewFramingKey(framing);
    useEffect(() => {
        if (!framing) return;
        // up 必须先写：lookAt 用当前 camera.up 解基向量，顺序颠倒会丢掉荷兰角。
        camera.up.set(...framing.up);
        camera.position.set(...framing.position);
        camera.fov = framing.fov;
        camera.near = framing.near;
        camera.far = framing.far;
        camera.lookAt(...framing.target);
        camera.updateProjectionMatrix();
        invalidate();
        // framing 只通过 framingKey 参与依赖：草稿对象身份变化不触发无谓回写。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [framingKey, invalidate, camera]);
    return null;
}

/**
 * 正交轴向取景：把包围盒解算结果写进专属的正交相机对象，语义与 DirectorShotCameraSync
 * 完全对称——独立持有、无需快照还原、绝不碰 DirectorScene。
 *
 * 水平/竖直跨度由领域层给出；视口只传入运行时 aspect，半范围换算走
 * resolveDirectorOrthographicFrustum，同时装下两条轴，避免宽内容被裁切。
 */
function DirectorOrthoCameraSync({ camera, framing, aspect }: { camera: OrthographicCamera; framing: DirectorOrthographicFraming | null; aspect: number }) {
    const invalidate = useThree((state) => state.invalidate);
    const framingKey = framing ? [...framing.position, ...framing.target, ...framing.up, framing.horizontalSpan, framing.verticalSpan, framing.near, framing.far].map((value) => value.toFixed(4)).join("|") : "";
    useEffect(() => {
        if (!framing) return;
        const frustum = resolveDirectorOrthographicFrustum({ horizontalSpan: framing.horizontalSpan, verticalSpan: framing.verticalSpan, aspect });
        camera.up.set(...framing.up);
        camera.position.set(...framing.position);
        camera.left = frustum.left;
        camera.right = frustum.right;
        camera.top = frustum.top;
        camera.bottom = frustum.bottom;
        camera.near = framing.near;
        camera.far = framing.far;
        camera.lookAt(...framing.target);
        camera.updateProjectionMatrix();
        invalidate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [framingKey, aspect, invalidate, camera]);
    return null;
}

function DirectorObjectView({ object, selected, selectedBone, showLabel, transformMode, playhead, onSelect, onSelectBone, onTransforming, onTransform, onBoneTransform, onActorRigReady, onLoadStateChange }: { object: DirectorObject; selected: boolean; selectedBone: string | null; showLabel: boolean; transformMode: DirectorViewportProps["transformMode"]; playhead: number; onSelect: () => void; onSelectBone: (bone: string | null) => void; onTransforming: (value: boolean) => void; onTransform: (from: DirectorTransform, to: DirectorTransform) => void; onBoneTransform: (bone: string, rotation: DirectorQuat) => void; onActorRigReady: (rig: DirectorRig, animations: AnimationClip[]) => void; onLoadStateChange: (id: string, signal: DirectorLoadSignal, retry: () => void) => void }) {
    const [target, setTarget] = useState<Group | null>(null);
    const resolved = interpolateDirectorTransform(object.transform, object.keyframes, playhead);
    // 手势进行中冻结声明式 transform，交由 gizmo 直接改写 Object3D；终态后再由场景状态接管。
    const [frozen, setFrozen] = useState<DirectorTransform | null>(null);
    const transform = frozen || resolved;
    return (
        <>
            <group
                ref={setTarget}
                position={transform.position}
                rotation={transform.rotation}
                scale={transform.scale}
                onPointerDown={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
            >
                <DirectorObjectVisual object={object} selected={selected} selectedBone={selectedBone} playhead={playhead} onSelectBone={onSelectBone} onBoneTransform={onBoneTransform} onActorRigReady={onActorRigReady} onLoadStateChange={onLoadStateChange} />
                {showLabel ? <Html position={[0, 2.04, 0]} center style={{ pointerEvents: "none" }}>
                    <span data-director-actor-label={object.id} role="note" aria-label={`角色 ${object.name}`} style={{ color: "#fff", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", textShadow: "0 1px 3px #000, 0 0 5px #000" }}>{object.name}</span>
                </Html> : null}
            </group>
            {selected && target ? (
                <DirectorObjectGizmo
                    target={target}
                    transformMode={transformMode}
                    onFreeze={setFrozen}
                    onTransforming={onTransforming}
                    onTransform={onTransform}
                />
            ) : null}
        </>
    );
}

/** 变换手柄是编辑辅助：打上标记后，截图与白膜录制时由 suspendDirectorEditorOverlays 统一隐藏。 */
function markDirectorEditorOnly(controls: Object3D | null) {
    if (controls) controls.userData.directorEditorOnly = true;
}

function DirectorObjectGizmo({ target, transformMode, onFreeze, onTransforming, onTransform }: { target: Group; transformMode: DirectorViewportProps["transformMode"]; onFreeze: (transform: DirectorTransform | null) => void; onTransforming: (value: boolean) => void; onTransform: (from: DirectorTransform, to: DirectorTransform) => void }) {
    const transaction = useDirectorGizmoTransaction<DirectorTransform>({
        read: () => readObject3DTransform(target),
        restore: (snapshot) => applyObject3DTransform(target, snapshot),
        commit: onTransform,
        onActive: (active, snapshot) => {
            onFreeze(active ? snapshot : null);
            onTransforming(active);
        },
    });
    return (
        <TransformControls
            ref={markDirectorEditorOnly}
            object={target}
            mode={transformMode}
            size={0.8}
            onMouseDown={() => transaction.begin()}
            onMouseUp={() => transaction.end("commit")}
        />
    );
}

/**
 * gizmo 事务的统一接线：对象与骨骼共用，避免两套实现产生偏差。
 * 监听在挂载期间常驻安装（不以「当前是否有手势」为安装条件），
 * 非活跃时 end 自身是空操作。
 */
function useDirectorGizmoTransaction<TSnapshot>({ read, restore, commit, onActive }: { read: () => TSnapshot | null; restore: (snapshot: TSnapshot) => void; commit: (from: TSnapshot, to: TSnapshot) => void; onActive: (active: boolean, snapshot: TSnapshot | null) => void }) {
    const hooksRef = useRef({ read, restore, commit, onActive });
    useEffect(() => { hooksRef.current = { read, restore, commit, onActive }; }, [commit, onActive, read, restore]);

    const transaction = useMemo(() => createDirectorTransaction<TSnapshot>({
        read: () => hooksRef.current.read(),
        restore: (snapshot) => hooksRef.current.restore(snapshot),
        commit: (from, to) => hooksRef.current.commit(from, to),
        setActive: (active) => hooksRef.current.onActive(active, active ? hooksRef.current.read() : null),
        // stdlib 在 domElement.ownerDocument 上注册 pointerup，其 pointerUp({button:0})
        // 会 dispatch mouseUp 后清 dragging=false / axis=null。因此用真实事件走它自己的
        // 收尾通道，而不是写它的私有字段（.d.ts 中 dragging/axis 均为 private）。
        terminateDrag: () => document.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true })),
    }), []);

    useEffect(() => installDirectorTerminalListeners(transaction, {
        window,
        document,
        isHidden: () => document.visibilityState === "hidden",
    }), [transaction]);

    // 取消选中、删除对象、切换模型或卸载都必须回到快照并释放 transforming。
    useEffect(() => () => transaction.end("cancel"), [transaction]);

    return transaction;
}

function readObject3DTransform(target: Object3D): DirectorTransform {
    return { position: target.position.toArray() as DirectorVec3, rotation: [target.rotation.x, target.rotation.y, target.rotation.z], scale: target.scale.toArray() as DirectorVec3 };
}

function applyObject3DTransform(target: Object3D, transform: DirectorTransform) {
    target.position.set(...transform.position);
    target.rotation.set(...transform.rotation);
    target.scale.set(...transform.scale);
    target.updateMatrixWorld(true);
}

function DirectorObjectVisual({ object, selected, selectedBone, playhead, onSelectBone, onBoneTransform, onActorRigReady, onLoadStateChange }: { object: DirectorObject; selected: boolean; selectedBone: string | null; playhead: number; onSelectBone: (bone: string | null) => void; onBoneTransform: (bone: string, rotation: DirectorQuat) => void; onActorRigReady: (rig: DirectorRig, animations: AnimationClip[]) => void; onLoadStateChange: (id: string, signal: DirectorLoadSignal, retry: () => void) => void }) {
    if ((object.kind === "model" || object.kind === "actor" || object.primitive === "character") && (object.url || object.primitive === "character")) return <DirectorModel object={object} selected={selected} selectedBone={selectedBone} playhead={playhead} onSelectBone={onSelectBone} onBoneTransform={onBoneTransform} onActorRigReady={onActorRigReady} onLoadStateChange={onLoadStateChange} />;
    if (object.kind === "billboard" && object.url) return <DirectorBillboard object={object} selected={selected} />;
    const material = <meshStandardMaterial color={selected ? "#2f8cff" : object.color} userData={{ directorBaseColor: object.color }} roughness={0.68} metalness={0.05} />;
    return (
        <mesh castShadow={object.castShadow} receiveShadow={object.receiveShadow}>
            {object.primitive === "sphere" ? <sphereGeometry args={[0.6, 32, 24]} /> : object.primitive === "cylinder" ? <cylinderGeometry args={[0.5, 0.5, 1.2, 32]} /> : object.primitive === "plane" ? <planeGeometry args={[1.6, 1]} /> : <boxGeometry args={[1, 1, 1]} />}
            {material}
        </mesh>
    );
}

function DirectorModel({ object, selected, selectedBone, playhead, onSelectBone, onBoneTransform, onActorRigReady, onLoadStateChange }: { object: DirectorObject; selected: boolean; selectedBone: string | null; playhead: number; onSelectBone: (bone: string | null) => void; onBoneTransform: (bone: string, rotation: DirectorQuat) => void; onActorRigReady: (rig: DirectorRig, animations: AnimationClip[]) => void; onLoadStateChange: (id: string, signal: DirectorLoadSignal, retry: () => void) => void }) {
    const [load, dispatchLoad] = useReducer(reduceDirectorLoad, directorLoadInitial);
    const loadRef = useRef(load);
    loadRef.current = load;
    const loadGeneration = load.generation;
    const modelUrl = object.kind === "actor" || object.primitive === "character" ? DIRECTOR_DEFAULT_ACTOR_URL : object.url;
    // 展示身份 = generation + 解析输入。render 阶段用它屏蔽旧资源，
    // 因此 prop/retry 变化的第一次 render 就已卸下上一代 model，随后 cleanup 才 dispose。
    const identity = directorLoadIdentity({ generation: loadGeneration, url: modelUrl, storageKey: object.storageKey, kind: object.kind });
    type LoadedModel = { model: Object3D; rig: DirectorRig; animations: AnimationClip[]; restRotations: Partial<Record<DirectorHumanoidBone, DirectorQuat>> };
    const [loaded, setLoaded] = useState<{ identity: string; value: LoadedModel } | null>(null);
    const display = resolveDirectorDisplay(loaded, identity);
    const model = display?.model ?? null;
    const rig = display?.rig ?? null;
    const animations = display?.animations ?? emptyAnimations;
    const restRotations = display?.restRotations ?? emptyRestRotations;
    const setLoadPhase = useCallback((phase: "loading" | "ready" | "error") => {
        if (phase === "loading") dispatchLoad({ type: "start" });
        else dispatchLoad({ type: phase === "ready" ? "loaded" : "failed", generation: loadRef.current.generation });
    }, []);
    const mixerRef = useRef<AnimationMixer | null>(null);
    const ownedRef = useRef<{ model: Object3D | null; mixer: AnimationMixer | null }>({ model: null, mixer: null });
    const onActorRigReadyRef = useRef(onActorRigReady);
    const invalidate = useThree((state) => state.invalidate);
    // helper 只跟随「当前 identity 下真正要展示的 model」，不会挂在已卸下的旧 model 上。
    const helper = useMemo(() => {
        if (!model) return null;
        const skeleton = new SkeletonHelper(model);
        skeleton.userData.directorEditorOnly = true;
        return skeleton;
    }, [model]);
    useEffect(() => () => disposeDirectorHelper(helper), [helper]);

    // 把 loading/error/ready 报到 DOM 层，Canvas 内部无法呈现可操作提示。
    // 依赖必须收敛到稳定原始值：object 每次场景编辑都是新引用，
    // 若挂在 [object] 上会让下面的注销 effect 每次编辑都误报 unmounted，
    // 失败模型的重试入口会随之消失。
    const objectId = object.id;
    const objectKind = directorDiagnosticObjectKind(object);
    const retryLoad = useCallback(() => {
        recordDirectorDiagnostic("DIRECTOR_MODEL_LOAD_RETRY", { objectId, objectKind, attempt: loadRef.current.generation, userInitiated: true });
        dispatchLoad({ type: "retry" });
    }, [objectId, objectKind]);
    const onLoadStateChangeRef = useRef(onLoadStateChange);
    useEffect(() => { onLoadStateChangeRef.current = onLoadStateChange; }, [onLoadStateChange]);
    useEffect(() => {
        onLoadStateChangeRef.current(object.id, load.phase, retryLoad);
    }, [load.phase, object.id, retryLoad]);

    // 卸载（删除、隐藏分支、换 URL/kind、Canvas 重建）必须注销自己，避免通知残留陈旧条目。
    // 单独 effect 且只依赖 id：phase 变化不会反复注销重登。
    useEffect(() => () => onLoadStateChangeRef.current(object.id, "unmounted", retryLoad), [object.id, retryLoad]);
    const selectedBoneObject = selectedBone && rig?.boneMap[selectedBone as DirectorHumanoidBone] ? model?.getObjectByName(rig.boneMap[selectedBone as DirectorHumanoidBone]!) : null;
    const motion = object.motionClips?.find((item) => item.id === object.activeMotionClipId);
    const activeAnimation = motion ? animations.find((item) => item.name === motion.sourceAnimation) : undefined;
    const handleModelPointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
        if (!selected || !rig) return;
        let nearestBone: string | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        Object.entries(rig.boneMap).forEach(([bone, name]) => {
            if (!name) return;
            const target = model?.getObjectByName(name);
            if (!target) return;
            const distance = event.ray.distanceSqToPoint(target.getWorldPosition(new Vector3()));
            if (distance <= 0.12 ** 2 && distance < nearestDistance) {
                nearestBone = bone;
                nearestDistance = distance;
            }
        });
        if (!nearestBone) return;
        // 模型表面可能先于关节控制球被射线命中，用最近骨骼保证点击仍可选中。
        event.stopPropagation();
        onSelectBone(nearestBone);
    }, [model, onSelectBone, rig, selected]);

    useEffect(() => { onActorRigReadyRef.current = onActorRigReady; }, [onActorRigReady]);

    useEffect(() => {
        const generation = loadRef.current.generation;
        let active = true;
        // render 阶段已由 identity 屏蔽旧资源；这里再清一次作为防御，不作为安全性依据。
        setLoaded(null);
        setLoadPhase("loading");
        const failLoad = () => {
            if (!active || generation !== loadRef.current.generation) return;
            // 只记录稳定码与安全枚举：URL / storageKey / 原始 error 都不落日志。
            recordDirectorDiagnostic("DIRECTOR_MODEL_LOAD_FAILED", { objectId: object.id, objectKind: directorDiagnosticObjectKind(object), attempt: generation });
            setLoadPhase("error");
        };
        const loader = new GLTFLoader();
        void resolveMediaUrl(object.storageKey, modelUrl)
            .then((url) => {
                // 解析完成时已失效：不再发起无意义的网络加载。
                if (!active || generation !== loadRef.current.generation) return;
                loader.load(
                    url,
                    (gltf) => {
                        const ownership = resolveDirectorLoadOwnership({ active, generation, currentGeneration: loadRef.current.generation });
                        if (!ownership.adopt) {
                            // 未被采纳的晚到 source 必须释放，否则孤儿泄漏。
                            if (ownership.disposeSource) disposeDirectorObject3D(gltf.scene);
                            return;
                        }
                        // 采纳流程整体包裹：clone / normalize / rig 推断 / 材质替换 / mixer /
                        // setLoaded / onActorRigReady 任一步抛错都不得逃出，也不得留下半采纳资源。
                        let clone: Object3D | null = null;
                        let mixer: AnimationMixer | null = null;
                        try {
                            // clone 与 source 共享 geometry/material/texture。
                            // 采纳后 source 的 Object3D 层级可被 GC，共享 GPU 资源由 owned clone 持有，
                            // 最终只在 clone 的 cleanup 里释放一次；这里绝不 dispose source。
                            clone = SkeletonUtils.clone(gltf.scene);
                            normalizeModel(clone, object.castShadow, object.receiveShadow);
                            const nextRig = inferDirectorRig(
                                clone,
                                gltf.animations.map((clip) => clip.name),
                            );
                            if (object.kind === "actor" || object.primitive === "character") applyActorReferenceMaterial(clone, object.color);
                            mixer = new AnimationMixer(clone);
                            mixerRef.current = mixer;
                            ownedRef.current = { model: clone, mixer };
                            // 一次性写入带 identity 的展示记录，避免 model/rig/animations 之间出现中间态。
                            setLoaded({
                                identity,
                                value: { model: clone, rig: nextRig, animations: gltf.animations, restRotations: readRigRestRotations(clone, nextRig) },
                            });
                            setLoadPhase("ready");
                            onActorRigReadyRef.current(nextRig, gltf.animations);
                        } catch {
                            // 只记录稳定错误码：原始 error / URL / 素材正文都不落日志。
                            recordDirectorDiagnostic("DIRECTOR_MODEL_ADOPT_FAILED", { objectId: object.id, objectKind: directorDiagnosticObjectKind(object) });
                            // 先摘掉 owned 记录，避免 effect cleanup 二次释放同一批资源。
                            ownedRef.current = { model: null, mixer: null };
                            mixerRef.current = null;
                            setLoaded(null);
                            disposeDirectorAdoptionFailure({ clone, mixer, source: gltf.scene });
                            // 回到既有 error/retry/占位人偶路径。
                            failLoad();
                        }
                    },
                    undefined,
                    failLoad,
                );
            })
            // 地址解析失败与 GLTFLoader onError 走同一条 error/retry 通道。
            .catch(failLoad);
        return () => {
            active = false;
            // 替换/重试/卸载：释放本 generation 拥有的 clone 与 mixer（共享资源随之恰好释放一次）。
            const owned = ownedRef.current;
            ownedRef.current = { model: null, mixer: null };
            mixerRef.current = null;
            disposeDirectorModelResources({ model: owned.model, mixer: owned.mixer });
        };
    }, [identity, modelUrl, object.storageKey]);

    useEffect(() => {
        if (!model) return;
        model.traverse((child) => {
            const mesh = child as Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = object.castShadow;
            mesh.receiveShadow = object.receiveShadow;
        });
        invalidate();
    }, [invalidate, model, object.castShadow, object.receiveShadow]);

    useEffect(() => {
        if (!model || (object.kind !== "actor" && object.primitive !== "character")) return;
        updateActorReferenceColor(model, object.color);
        invalidate();
    }, [invalidate, model, object.color, object.kind]);

    useEffect(() => {
        if (!model || !mixerRef.current) return;
        const mixer = mixerRef.current;
        mixer.stopAllAction();
        if (!activeAnimation) return;
        mixer.clipAction(activeAnimation).setLoop(motion?.loop ? LoopRepeat : LoopOnce, motion?.loop ? Infinity : 1).play();
        return () => {
            mixer.stopAllAction();
        };
    }, [activeAnimation, model, motion?.loop]);

    useEffect(() => {
        if (!model || !mixerRef.current) return;
        if (activeAnimation && motion) {
            const localTime = Math.max(0, playhead - motion.start) * motion.playbackRate;
            const clipDuration = motion.duration || activeAnimation.duration;
            mixerRef.current.setTime(motion.loop && clipDuration > 0 ? localTime % clipDuration : localTime);
        }
        applyDirectorBoneTracks(model, object, playhead, rig, restRotations, Boolean(activeAnimation && motion));
        helper?.updateMatrixWorld(true);
        invalidate();
    }, [activeAnimation, helper, invalidate, model, motion, object.boneOverrides, object.boneTracks, object.pose, playhead, restRotations, rig]);

    useFrame(() => {
        if (selectedBoneObject && selected) selectedBoneObject.updateMatrixWorld(true);
    });

    if (!model) return <DirectorMannequin color={object.color} selected={selected} />;
    return <group onPointerDown={handleModelPointerDown}>
        <primitive object={model} />
        {selected && helper ? <primitive object={helper} /> : null}
        {selected && rig ? Object.entries(rig.boneMap).filter(([, name]) => Boolean(name)).map(([bone, name]) => {
            const fingerGroup = directorFingerGroup(bone);
            const selectedFingerGroup = directorFingerGroup(selectedBone);
            return <BoneController key={bone} bone={model.getObjectByName(name!)} selected={selectedBone === bone} dimmed={Boolean(fingerGroup && selectedFingerGroup && fingerGroup !== selectedFingerGroup)} onSelect={() => onSelectBone(bone)} />;
        }) : null}
        {selected && selectedBoneObject && selectedBone ? <DirectorBoneGizmo bone={selectedBoneObject} onCommit={(rotation) => onBoneTransform(selectedBone, rotation)} /> : null}
    </group>;
}

/** 骨骼 gizmo 与对象 gizmo 共用事务接线，取消时恢复骨骼 quaternion。 */
function DirectorBoneGizmo({ bone, onCommit }: { bone: Object3D; onCommit: (rotation: DirectorQuat) => void }) {
    const transaction = useDirectorGizmoTransaction<DirectorQuat>({
        read: () => bone.quaternion.toArray() as DirectorQuat,
        restore: (snapshot) => {
            bone.quaternion.fromArray(snapshot);
            bone.updateMatrixWorld(true);
        },
        commit: (_from, to) => onCommit(to),
        onActive: () => undefined,
    });
    return <TransformControls ref={markDirectorEditorOnly} object={bone} mode="rotate" size={0.55} onMouseDown={() => transaction.begin()} onMouseUp={() => transaction.end("commit")} />;
}

function DirectorMannequin({ color, selected }: { color: string; selected: boolean }) {
    const resolvedColor = selected ? new Color(color).lerp(new Color("#78a9ff"), 0.18).getStyle() : color;
    const joints: DirectorVec3[] = [[0, 1.72, 0], [0, 1.48, 0], [-0.3, 1.4, 0], [0.3, 1.4, 0], [-0.32, 1.05, 0], [0.32, 1.05, 0], [-0.33, 0.72, 0], [0.33, 0.72, 0], [-0.13, 0.88, 0], [0.13, 0.88, 0], [-0.13, 0.46, 0], [0.13, 0.46, 0], [-0.13, 0.05, 0], [0.13, 0.05, 0]];
    const bones: Array<[DirectorVec3, DirectorVec3]> = [[joints[0], joints[1]], [joints[1], joints[2]], [joints[1], joints[3]], [joints[2], joints[4]], [joints[4], joints[6]], [joints[3], joints[5]], [joints[5], joints[7]], [joints[1], [0, 0.92, 0]], [[0, 0.92, 0], joints[8]], [[0, 0.92, 0], joints[9]], [joints[8], joints[10]], [joints[10], joints[12]], [joints[9], joints[11]], [joints[11], joints[13]]];
    return <group>
        {bones.map(([from, to], index) => <LoadingBone key={`bone-${index}`} from={from} to={to} color={resolvedColor} baseColor={color} />)}
        {joints.map((position, index) => <mesh key={`joint-${index}`} position={position}><sphereGeometry args={[index === 0 ? 0.11 : 0.04, 12, 8]} /><meshBasicMaterial color={resolvedColor} userData={{ directorBaseColor: color }} transparent opacity={0.72} /></mesh>)}
    </group>;
}

function LoadingBone({ from, to, color, baseColor }: { from: DirectorVec3; to: DirectorVec3; color: string; baseColor: string }) {
    const start = useMemo(() => new Vector3(...from), [from]);
    const end = useMemo(() => new Vector3(...to), [to]);
    const direction = useMemo(() => end.clone().sub(start), [end, start]);
    const midpoint = useMemo(() => start.clone().add(end).multiplyScalar(0.5), [end, start]);
    const rotation = useMemo(() => new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.clone().normalize()), [direction]);
    return <mesh position={midpoint} quaternion={rotation}><cylinderGeometry args={[0.025, 0.025, direction.length(), 8]} /><meshBasicMaterial color={color} userData={{ directorBaseColor: baseColor }} transparent opacity={0.62} /></mesh>;
}

function BoneController({ bone, selected, dimmed, onSelect }: { bone: Object3D | undefined; selected: boolean; dimmed: boolean; onSelect: () => void }) {
    const ref = useRef<Group>(null);
    const visibleRef = useRef<Mesh>(null);
    const hitRef = useRef<Mesh>(null);
    const world = useMemo(() => new Vector3(), []);
    const local = useMemo(() => new Vector3(), []);
    const cameraWorld = useMemo(() => new Vector3(), []);
    const { camera, size } = useThree();
    useFrame(() => {
        if (!bone || !ref.current) return;
        const parent = ref.current.parent;
        if (!parent) return;
        // 控制点与模型根节点是兄弟关系，必须转换到控制点父级坐标，否则点击区域会与骨骼错位。
        bone.getWorldPosition(world);
        camera.getWorldPosition(cameraWorld);
        local.copy(world);
        parent.worldToLocal(local);
        ref.current.position.copy(local);
        const distance = cameraWorld.distanceTo(world);
        const visualPixels = selected ? 5 : dimmed ? 2.5 : 3.5;
        const hitPixels = selected ? 12 : 10;
        visibleRef.current?.scale.setScalar(screenPixelsToWorldRadius(camera, distance, visualPixels, size.height));
        hitRef.current?.scale.setScalar(screenPixelsToWorldRadius(camera, distance, hitPixels, size.height));
    });
    if (!bone) return null;
    const handlePointerDown = (event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); onSelect(); };
    return <group ref={ref} userData={{ directorEditorOnly: true }}>
        <mesh ref={visibleRef} onPointerDown={handlePointerDown} frustumCulled={false}>
            <sphereGeometry args={[1, 12, 8]} />
            <meshBasicMaterial color={selected ? "#f0b36a" : "#78a9ff"} depthTest={false} transparent opacity={selected ? 1 : dimmed ? 0.14 : 0.68} />
        </mesh>
        {/* 可视点保持小尺寸，透明球只负责提供稳定的点击面积。 */}
        <mesh ref={hitRef} onPointerDown={handlePointerDown} frustumCulled={false}>
            <sphereGeometry args={[1, 8, 6]} />
            <meshBasicMaterial transparent opacity={0} depthTest={false} />
        </mesh>
    </group>;
}

function screenPixelsToWorldRadius(camera: Camera, distance: number, pixels: number, viewportHeight: number) {
    const height = Math.max(1, viewportHeight);
    if (camera instanceof PerspectiveCamera) return (pixels * 2 * Math.max(0.01, distance) * Math.tan((camera.fov * Math.PI) / 360)) / (height * Math.max(0.01, camera.zoom));
    if (camera instanceof OrthographicCamera) return (pixels * (camera.top - camera.bottom)) / (height * Math.max(0.01, camera.zoom));
    return pixels * 0.001;
}

function directorFingerGroup(bone: string | null) {
    const match = bone?.match(/^(left|right)(Thumb|Index|Middle|Ring|Pinky)\d$/);
    return match ? `${match[1]}${match[2]}` : null;
}

function normalizeModel(root: Object3D, castShadow: boolean, receiveShadow: boolean) {
    root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(root, true);
    const size = bounds.getSize(new Vector3());
    const maxSize = Math.max(size.x, size.y, size.z, 0.001);
    root.scale.multiplyScalar(2 / maxSize);
    root.updateMatrixWorld(true);
    const centered = new Box3().setFromObject(root, true);
    const center = centered.getCenter(new Vector3());
    root.position.sub(center);
    root.position.y -= centered.min.y - center.y;
    root.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
    });
}

function applyActorReferenceMaterial(root: Object3D, color: string) {
    const material = new MeshStandardMaterial({ color, roughness: 0.74, metalness: 0.02 });
    const replaced: Material[] = [];
    root.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        // 被顶掉的原材质不再被任何 mesh 引用，必须释放，否则每次加载都泄漏一份。
        if (mesh.material) replaced.push(...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
        mesh.material = material;
        mesh.userData.directorActor = true;
        mesh.userData.directorActorMaterial = material;
    });
    disposeDirectorMaterials(replaced.filter((item) => item !== material));
}

function updateActorReferenceColor(root: Object3D, color: string) {
    root.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh || !mesh.userData.directorActor) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => {
            if (material instanceof MeshStandardMaterial) material.color.set(color);
        });
    });
}

function readRigRestRotations(root: Object3D, rig: DirectorRig) {
    return Object.fromEntries(Object.entries(rig.boneMap).flatMap(([bone, name]) => {
        const target = name ? root.getObjectByName(name) : null;
        return target ? [[bone, target.quaternion.toArray() as DirectorQuat]] : [];
    })) as Partial<Record<DirectorHumanoidBone, DirectorQuat>>;
}

function inferDirectorRig(root: Object3D, animationNames: string[]): DirectorRig {
    const names = new Map<string, string>();
    root.traverse((child) => { if (child instanceof Bone) names.set(normalizeBoneName(child.name), child.name); });
    const fingerPatterns = (side: "left" | "right", finger: "thumb" | "index" | "middle" | "ring" | "pinky", segment: 1 | 2 | 3) => [
        new RegExp(`^mixamorig${side}hand${finger}${segment}$`),
        new RegExp(`^${side}hand${finger}${segment}$`),
        new RegExp(`^${side}${finger}${segment}$`),
        new RegExp(`^${finger}0?${segment}${side === "left" ? "l" : "r"}$`),
    ];
    const patterns: Record<DirectorHumanoidBone, RegExp[]> = {
        root: [/^root$/, /armature/], hips: [/hips|pelvis/, /mixamorig.*hip/], spine: [/spine1?$|lowerback/], chest: [/spine2|chest|upperback/], neck: [/neck/], head: [/head/],
        leftShoulder: [/leftshoulder|shoulder_l|mixamorigleftshoulder/], leftUpperArm: [/leftupperarm|leftarm|upperarm_l|mixamorigleftarm/], leftLowerArm: [/leftforearm|leftlowerarm|forearm_l|mixamorigleftforearm/], leftHand: [/^lefthand$/, /^handl$/, /^mixamoriglefthand$/],
        leftThumb1: fingerPatterns("left", "thumb", 1), leftThumb2: fingerPatterns("left", "thumb", 2), leftThumb3: fingerPatterns("left", "thumb", 3),
        leftIndex1: fingerPatterns("left", "index", 1), leftIndex2: fingerPatterns("left", "index", 2), leftIndex3: fingerPatterns("left", "index", 3),
        leftMiddle1: fingerPatterns("left", "middle", 1), leftMiddle2: fingerPatterns("left", "middle", 2), leftMiddle3: fingerPatterns("left", "middle", 3),
        leftRing1: fingerPatterns("left", "ring", 1), leftRing2: fingerPatterns("left", "ring", 2), leftRing3: fingerPatterns("left", "ring", 3),
        leftPinky1: fingerPatterns("left", "pinky", 1), leftPinky2: fingerPatterns("left", "pinky", 2), leftPinky3: fingerPatterns("left", "pinky", 3),
        rightShoulder: [/rightshoulder|shoulder_r|mixamorigrightshoulder/], rightUpperArm: [/rightupperarm|rightarm|upperarm_r|mixamorigrightarm/], rightLowerArm: [/rightforearm|rightlowerarm|forearm_r|mixamorigrightforearm/], rightHand: [/^righthand$/, /^handr$/, /^mixamorigrighthand$/],
        rightThumb1: fingerPatterns("right", "thumb", 1), rightThumb2: fingerPatterns("right", "thumb", 2), rightThumb3: fingerPatterns("right", "thumb", 3),
        rightIndex1: fingerPatterns("right", "index", 1), rightIndex2: fingerPatterns("right", "index", 2), rightIndex3: fingerPatterns("right", "index", 3),
        rightMiddle1: fingerPatterns("right", "middle", 1), rightMiddle2: fingerPatterns("right", "middle", 2), rightMiddle3: fingerPatterns("right", "middle", 3),
        rightRing1: fingerPatterns("right", "ring", 1), rightRing2: fingerPatterns("right", "ring", 2), rightRing3: fingerPatterns("right", "ring", 3),
        rightPinky1: fingerPatterns("right", "pinky", 1), rightPinky2: fingerPatterns("right", "pinky", 2), rightPinky3: fingerPatterns("right", "pinky", 3),
        leftUpperLeg: [/leftupleg|leftthigh|thigh_l|mixamorigleftupleg/], leftLowerLeg: [/leftleg|leftcalf|calf_l|mixamorigleftleg/], leftFoot: [/leftfoot|foot_l|mixamorigleftfoot/], rightUpperLeg: [/rightupleg|rightthigh|thigh_r|mixamorigrightupleg/], rightLowerLeg: [/rightleg|rightcalf|calf_r|mixamorigrightleg/], rightFoot: [/rightfoot|foot_r|mixamorigrightfoot/],
    };
    const boneMap = Object.fromEntries(Object.entries(patterns).map(([bone, candidates]) => [bone, candidates.map((pattern) => [...names.entries()].find(([normalized]) => pattern.test(normalized))?.[1]).find(Boolean)]).filter(([, name]) => Boolean(name))) as DirectorRig["boneMap"];
    return { status: Object.keys(boneMap).length >= 8 ? "ready" : "unmapped", boneMap, animationNames };
}

function normalizeBoneName(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function applyDirectorBoneTracks(model: Object3D, object: DirectorObject, playhead: number, rig: DirectorRig | null, restRotations: Partial<Record<DirectorHumanoidBone, DirectorQuat>>, hasActiveMotion: boolean) {
    if (!rig) return;
    const poseDeltas = hasActiveMotion ? {} : directorPoseBoneDeltas(object.pose || "stand");
    Object.entries(rig.boneMap).forEach(([bone, name]) => {
        const target = name ? model.getObjectByName(name) : null;
        if (!target) return;
        const humanoidBone = bone as DirectorHumanoidBone;
        // hasActiveMotion 时 mixer 已写入 target.quaternion，直接作为动作层输入。
        const rotation = resolveDirectorBoneRotation({
            motion: hasActiveMotion ? target.quaternion.toArray() as DirectorQuat : null,
            rest: hasActiveMotion ? null : restRotations[humanoidBone] || null,
            poseDelta: hasActiveMotion ? null : poseDeltas[humanoidBone] || null,
            override: object.boneOverrides?.[humanoidBone] || null,
            keyframes: object.boneTracks?.find((item) => item.bone === bone)?.keyframes || null,
            time: playhead,
        });
        if (rotation) {
            target.quaternion.copy(new Quaternion(...rotation));
            return;
        }
        if (hasActiveMotion) return;
        const rest = restRotations[humanoidBone];
        if (rest) target.quaternion.copy(new Quaternion(...rest));
        const delta = poseDeltas[humanoidBone];
        if (delta) target.quaternion.multiply(new Quaternion(...delta));
    });
}

function DirectorBillboard({ object, selected }: { object: DirectorObject; selected: boolean }) {
    // 展示状态带 url 身份：只有与当前 object.url 匹配才交给 material，
    // 这样换 URL 的第一次 render 就卸下旧纹理，随后 cleanup 才 dispose。
    const [loaded, setLoaded] = useState<{ identity: string; value: Texture } | null>(null);
    const identity = object.url || "";
    const texture = resolveDirectorDisplay(loaded, identity);
    useEffect(() => {
        let active = true;
        let owned: Texture | null = null;
        setLoaded(null);
        // blob URL 刷新后失效，先按 storageKey 从本地存储换出新地址。
        void resolveImageUrl(object.storageKey, object.url!).then((url) => {
            if (!active) return;
            new TextureLoader().load(url, (next) => {
                // 晚到的回调：本组件已换 URL 或卸载，直接释放这张纹理。
                if (!active) {
                    next.dispose();
                    return;
                }
                owned = next;
                setLoaded({ identity, value: next });
            }, undefined, () => active && setLoaded(null));
        });
        return () => {
            active = false;
            owned?.dispose();
            owned = null;
        };
    }, [identity, object.storageKey, object.url]);
    return (
        <mesh castShadow={object.castShadow}>
            <planeGeometry args={[1.6, 1]} />
            <meshBasicMaterial map={texture || undefined} color={texture ? "#ffffff" : selected ? "#2f8cff" : object.color} userData={{ directorBaseColor: texture ? "#ffffff" : object.color }} toneMapped={false} />
        </mesh>
    );
}

function DirectorLightView({ light }: { light: DirectorLight }) {
    const position = light.transform.position;
    if (light.type === "ambient") return <ambientLight color={light.color} intensity={light.intensity} />;
    if (light.type === "point") return <pointLight position={position} color={light.color} intensity={light.intensity} castShadow={light.castShadow} />;
    if (light.type === "spot") return <spotLight position={position} color={light.color} intensity={light.intensity} angle={light.angle} penumbra={light.penumbra} castShadow={light.castShadow} />;
    return <directionalLight position={position} color={light.color} intensity={light.intensity} castShadow={light.castShadow} shadow-mapSize-width={1024} shadow-mapSize-height={1024} />;
}

async function captureFrame(context: CaptureContext | null, mode: DirectorRenderMode, aspectRatio: DirectorAspectRatio) {
    if (!context) throw new Error("3D 视口尚未就绪");
    const { gl, scene, camera } = context;
    const resumeDisplayMaterialOverride = context.suspendDisplayMaterialOverride();
    const previous = scene.overrideMaterial;
    const override = mode === "depth" ? new MeshDepthMaterial() : mode === "normal" ? new MeshNormalMaterial() : mode === "pose" ? new MeshBasicMaterial({ color: "#ffffff", wireframe: true }) : null;
    const restoreClayMaterials = mode === "clay" ? applyClaySceneMaterials(scene) : null;
    const resumeEditorOverlays = suspendDirectorEditorOverlays(scene);
    const resumePanoramaSphere = mode === "beauty" ? null : suspendDirectorPanoramaSphere(scene);
    try {
        scene.overrideMaterial = override;
        gl.render(scene, camera);
        return await canvasToBlob(cropDirectorCanvas(gl.domElement, aspectRatio));
    } finally {
        scene.overrideMaterial = previous;
        restoreClayMaterials?.();
        override?.dispose();
        resumeDisplayMaterialOverride();
        resumeEditorOverlays();
        resumePanoramaSphere?.();
        gl.render(scene, camera);
    }
}

async function recordCanvas(context: CaptureContext | null, duration: number, fps: number, aspectRatio: DirectorAspectRatio) {
    if (!context) throw new Error("3D 视口尚未就绪");
    if (!context.gl.domElement.captureStream || typeof MediaRecorder === "undefined") throw new Error("当前浏览器不支持视频录制，请导出帧序列");
    const resumeDisplayMaterialOverride = context.suspendDisplayMaterialOverride();
    const previousMaterial = context.scene.overrideMaterial;
    const restoreClayMaterials = applyClaySceneMaterials(context.scene);
    let cropFrame = 0;
    let stream: MediaStream | null = null;
    let stopTimer: number | null = null;
    let onRenderError: (() => void) | null = null;
    const resumeEditorOverlays = suspendDirectorEditorOverlays(context.scene);
    const resumePanoramaSphere = suspendDirectorPanoramaSphere(context.scene);
    try {
        context.scene.overrideMaterial = null;
        context.gl.render(context.scene, context.camera);
        const sourceCanvas = context.gl.domElement;
        const outputCanvas = aspectRatio === "adaptive" ? sourceCanvas : cropDirectorCanvas(sourceCanvas, aspectRatio);
        const crop = aspectRatio === "adaptive" ? null : resolveDirectorPixelCrop(sourceCanvas.width, sourceCanvas.height, aspectRatio);
        const outputContext = crop ? outputCanvas.getContext("2d") : null;
        if (crop && outputContext) {
            const draw = () => {
                outputContext.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, outputCanvas.width, outputCanvas.height);
                cropFrame = window.requestAnimationFrame(draw);
            };
            cropFrame = window.requestAnimationFrame(draw);
        }
        stream = outputCanvas.captureStream(fps);
        const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const chunks: Blob[] = [];
        // captureStream 依赖渲染循环持续产出新帧；异常立即停止，避免静默回写残缺视频。
        let renderError: Error | null = null;
        onRenderError = () => {
            renderError ??= new Error("白膜视频录制期间发生渲染错误，请重试");
            if (recorder.state !== "inactive") recorder.stop();
        };
        window.addEventListener("error", onRenderError);
        const result = new Promise<Blob>((resolve, reject) => {
            recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
            recorder.onerror = () => reject(new Error("白膜视频录制失败"));
            recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
        });
        recorder.start(250);
        stopTimer = window.setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, Math.max(250, duration * 1000 + 120));
        const blob = await result;
        if (renderError) throw renderError;
        const recorded = await probeRecordedDuration(blob);
        if (!Number.isFinite(recorded) || recorded < Math.max(0.25, duration * 0.5)) throw new Error("白膜视频时长异常，录制可能不完整，请重试");
        return blob;
    } finally {
        if (stopTimer !== null) window.clearTimeout(stopTimer);
        if (cropFrame) window.cancelAnimationFrame(cropFrame);
        if (onRenderError) window.removeEventListener("error", onRenderError);
        stream?.getTracks().forEach((track) => track.stop());
        restoreClayMaterials();
        context.scene.overrideMaterial = previousMaterial;
        resumeDisplayMaterialOverride();
        resumeEditorOverlays();
        resumePanoramaSphere();
        context.gl.render(context.scene, context.camera);
    }
}

async function probeRecordedDuration(blob: Blob) {
    // Chrome MediaRecorder 产出的 webm 不带时长头，loaded metadata 时 duration 是 Infinity，
    // 只有 seek 到末尾触发收尾后 duration 才是真实值；这是校验录制完整性的唯一途径。
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    try {
        video.src = url;
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("白膜视频无法解析"));
        });
        if (video.duration !== Infinity) return video.duration;
        await new Promise<void>((resolve) => {
            const finish = () => { video.removeEventListener("seeked", finish); resolve(); };
            video.addEventListener("seeked", finish);
            video.currentTime = 1e6;
            window.setTimeout(finish, 1000);
        });
        return video.duration;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function canvasToBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("3D 预览图导出失败"))), "image/png"));
}
