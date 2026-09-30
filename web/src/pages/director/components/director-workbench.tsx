import { App, Button, ColorPicker, Dropdown, Input, InputNumber, Modal, Select, Slider, Switch } from "antd";
import type { MenuProps } from "antd";
import { ArrowLeft, Box, BoxSelect, Camera, Circle, Clock3, Cuboid, Eye, EyeOff, FileUp, Focus, Image as ImageIcon, LampDesk, Lightbulb, Plus, Redo2, Search, Sparkles, Trash2, Undo2, UserRound, Video, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { nanoid } from "nanoid";
import { Euler, Quaternion } from "three";
import type { AnimationClip } from "three";

import { DirectorOnboarding } from "@/pages/director/components/director-onboarding";
import { DirectorSceneInspector } from "@/pages/director/components/director-scene-inspector";
import { DirectorScreenshotGallery } from "@/pages/director/components/director-screenshot-gallery";
import { DirectorCameraScreenshotTabs, type DirectorCameraInspectorTab } from "@/pages/director/components/director-camera-screenshot-tabs";
import { DirectorCameraProperties } from "@/pages/director/components/director-camera-properties";
import { DirectorPanoramaAIModal } from "@/pages/director/components/director-panorama-ai-modal";
import { DirectorWorkbenchRail, type DirectorWorkbenchTab } from "@/pages/director/components/director-workbench-rail";
import { DirectorViewport, type DirectorViewportHandle } from "@/pages/director/components/director-viewport";
import { DirectorViewportDock } from "@/pages/director/components/director-viewport-dock";
import { DirectorSequencer } from "@/pages/director/components/director-sequencer";
import { DirectorGeneratePanel } from "@/pages/director/components/director-generate-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { compileDirectorPrompt } from "@/lib/director/director-prompt-compiler";
import { advanceDirectorPlayhead, resolveDirectorCameraAlignment, resolveDirectorCameraMoveKeyframes, resolveDirectorKeyframeRecord, resolveDirectorObjectTransformEdit, snapDirectorTime } from "@/lib/director/director-animation-semantics";
import { createDirectorTransaction, installDirectorTerminalListeners, type DirectorTransaction } from "@/lib/director/director-gesture-transaction";
import { DIRECTOR_MODES, directorModeCapabilities, type DirectorModeCapabilities } from "@/lib/director/director-modes";
import { resolveDirectorPlacement, resolveDirectorPlacementAnchor, snapDirectorGroundPosition } from "@/lib/director/director-placement";
import { DIRECTOR_ASPECT_RATIOS } from "@/lib/director/director-aspect-ratio";
import { generateDirectorPanorama } from "@/lib/director/director-panorama-generation";
import { createDirectorCameraFromPreset, DIRECTOR_CAMERA_PRESETS, type DirectorCameraPresetId } from "@/lib/director/director-camera-presets";
import { appendDirectorScreenshot, isDirectorOutputSnapshotCurrent, nextDirectorScreenshotName, shouldReinitializeDirectorSession } from "@/lib/director/director-session";
import { bindDirectorCameraFollow, removeDirectorCameraBindingsForObject, unbindDirectorCameraFollow } from "@/lib/director/director-camera-binding";
import { blocksDirectorShortcut, releaseDirectorFocusAfterPointer, resolveDirectorShortcut, type DirectorShortcutAction } from "@/lib/director/director-shortcuts";
import { applyDirectorUniformScale, createDirectorActor, createDirectorBillboard, createDirectorCamera, createDirectorLight, createDirectorModel, createDirectorObject, DIRECTOR_ACTOR_COLORS, directorBoneLabel, directorFocalLengthToFov, directorPoseLabel, interpolateDirectorTransform, removeDirectorSceneKeyframe, setDirectorSceneKeyframeEasing, toggleDirectorObjectVisibility, touchDirectorScene, upsertDirectorBoneKeyframe } from "@/lib/director/director-scene";
import { searchDirectorSceneItems } from "@/lib/director/director-scene-search";
import { uploadMediaFile } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useAssetStore, type ImageAsset } from "@/stores/use-asset-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useDirectorStore, type DirectorModelAsset } from "@/stores/use-director-store";
import { useDirectorWorkbenchStore } from "@/stores/use-director-workbench-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { DirectorCamera, DirectorCameraMove, DirectorHumanoidBone, DirectorKeyframeDeleteTarget, DirectorKeyframeEasing, DirectorLight, DirectorObject, DirectorPose, DirectorQuat, DirectorRenderMode, DirectorRig, DirectorScene, DirectorShot, DirectorShotSize, DirectorTransform, DirectorVec3 } from "@/types/director";

/** 导演台工作台：场景编辑直接写回导演台 store（localforage 持久化），关闭时截取封面。 */
export function DirectorWorkbench({ open, scene, onboardingScope, onClose, onChange }: { open: boolean; scene: DirectorScene | null; onboardingScope: string; onClose: () => void; onChange: (scene: DirectorScene) => void }) {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const viewportRef = useRef<DirectorViewportHandle>(null);
    const modelInputRef = useRef<HTMLInputElement>(null);
    const panoramaInputRef = useRef<HTMLInputElement>(null);
    const [panoramaUploading, setPanoramaUploading] = useState(false);
    const [panoramaHistoryOpen, setPanoramaHistoryOpen] = useState(false);
    const [panoramaAIOpen, setPanoramaAIOpen] = useState(false);
    const [panoramaAIBusy, setPanoramaAIBusy] = useState(false);
    const [panoramaAIStatus, setPanoramaAIStatus] = useState("");
    const [generateOpen, setGenerateOpen] = useState(false);
    const [draft, setDraft] = useState<DirectorScene | null>(null);
    const [history, setHistory] = useState<DirectorScene[]>([]);
    const [future, setFuture] = useState<DirectorScene[]>([]);
    const [captureBusy, setCaptureBusy] = useState(false);
    const [captureReady, setCaptureReady] = useState(false);
    const [recording, setRecording] = useState(false);
    const [onboardingRestartSignal, setOnboardingRestartSignal] = useState(0);
    const [navigationTab, setNavigationTab] = useState<DirectorWorkbenchTab>("scene");
    const [sceneSearch, setSceneSearch] = useState("");
    const [sceneInspectorView, setSceneInspectorView] = useState<"scene" | "shot">("scene");
    const [cameraInspectorTab, setCameraInspectorTab] = useState<DirectorCameraInspectorTab>("properties");
    const mode = useDirectorWorkbenchStore((state) => state.mode);
    const viewMode = useDirectorWorkbenchStore((state) => state.viewMode);
    const setViewMode = useDirectorWorkbenchStore((state) => state.setViewMode);
    const setMode = useDirectorWorkbenchStore((state) => state.setMode);
    const selectedObjectId = useDirectorWorkbenchStore((state) => state.selectedObjectId);
    const selectedLightId = useDirectorWorkbenchStore((state) => state.selectedLightId);
    const transformMode = useDirectorWorkbenchStore((state) => state.transformMode);
    const renderMode = useDirectorWorkbenchStore((state) => state.renderMode);
    const playhead = useDirectorWorkbenchStore((state) => state.playhead);
    const playing = useDirectorWorkbenchStore((state) => state.playing);
    const selectedBone = useDirectorWorkbenchStore((state) => state.selectedBone);
    const autoKey = useDirectorWorkbenchStore((state) => state.autoKey);
    const sequencerHeight = useDirectorWorkbenchStore((state) => state.sequencerHeight);
    const sequencerVisible = useDirectorWorkbenchStore((state) => state.sequencerVisible);
    const setSelectedObjectId = useDirectorWorkbenchStore((state) => state.setSelectedObjectId);
    const setSelectedLightId = useDirectorWorkbenchStore((state) => state.setSelectedLightId);
    const setTransformMode = useDirectorWorkbenchStore((state) => state.setTransformMode);
    const setRenderMode = useDirectorWorkbenchStore((state) => state.setRenderMode);
    const setPlayhead = useDirectorWorkbenchStore((state) => state.setPlayhead);
    const setPlaying = useDirectorWorkbenchStore((state) => state.setPlaying);
    const setSelectedBone = useDirectorWorkbenchStore((state) => state.setSelectedBone);
    const setAutoKey = useDirectorWorkbenchStore((state) => state.setAutoKey);
    const setSequencerHeight = useDirectorWorkbenchStore((state) => state.setSequencerHeight);
    const setSequencerVisible = useDirectorWorkbenchStore((state) => state.setSequencerVisible);
    const resetWorkbench = useDirectorWorkbenchStore((state) => state.reset);
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const modelAssets = useDirectorStore((state) => state.models);
    const addModelToStore = useDirectorStore((state) => state.addModel);
    const removeModelAsset = useDirectorStore((state) => state.removeModel);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const imageAssets = useMemo(() => assets.filter((asset): asset is ImageAsset => asset.kind === "image"), [assets]);

    // 模式决定显示什么：时间轴、关键帧、骨骼、摄影机工具与可选渲染视图都从这里派生。
    const capabilities = directorModeCapabilities(mode);
    const renderModeOptions = useMemo(() => DIRECTOR_RENDER_MODE_LABELS.filter((option) => capabilities.renderModes.includes(option.value)), [capabilities.renderModes]);

    const draftRef = useRef<DirectorScene | null>(null);
    const openRef = useRef(open);
    openRef.current = open;
    const sessionRef = useRef(new AbortController());
    useEffect(() => {
        const session = new AbortController();
        sessionRef.current = session;
        openRef.current = open;
        setPanoramaUploading(false);
        setPanoramaAIBusy(false);
        setCaptureBusy(false);
        if (!open) session.abort();
        return () => {
            openRef.current = false;
            session.abort();
        };
    }, [open, scene?.id]);
    const stagedRef = useRef<DirectorTransaction | null>(null);
    const initializedSceneIdRef = useRef<string | null>(null);
    const onChangeRef = useRef(onChange);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

    const closingRef = useRef(false);

    const writeDraft = useCallback((next: DirectorScene | null) => {
        draftRef.current = next;
        setDraft(next);
    }, []);

    /** 把当前 draft 写回导演台 store；store 由 localforage 持久化。 */
    const mirrorDraft = useCallback(() => {
        const current = draftRef.current;
        if (!current || initializedSceneIdRef.current !== current.id) return;
        onChangeRef.current(current);
    }, []);
    const commitDraft = mirrorDraft;

    const writeAndPublish = useCallback((next: DirectorScene) => {
        writeDraft(next);
        onChangeRef.current(next);
    }, [writeDraft]);

    // 会话初始化只认 scene id：同 id 的父级镜像回流不得重建会话。
    useEffect(() => {
        if (!open || !scene) return;
        if (!shouldReinitializeDirectorSession({ initializedSceneId: initializedSceneIdRef.current, nextSceneId: scene.id })) return;
        const next = structuredClone(scene);
        next.shots = next.shots.map((shot) => ({ ...shot, fps: shot.fps || 24 }));
        stagedRef.current?.end("cancel");
        initializedSceneIdRef.current = scene.id;
        writeDraft(next);
        setHistory([]);
        setFuture([]);
        resetWorkbench();
    }, [open, resetWorkbench, scene, writeDraft]);

    const activeShot = draft?.shots?.find((item) => item.id === draft.activeShotId) || draft?.shots?.[0] || null;
    const visibleSceneItems = useMemo(() => draft ? searchDirectorSceneItems(draft, sceneSearch) : [], [draft, sceneSearch]);
    const activeCamera = draft?.cameras?.find((item) => item.id === activeShot?.cameraId) || draft?.cameras?.[0] || null;
    const selectedObject = draft?.objects?.find((item) => item.id === selectedObjectId) || null;
    const selectedLight = draft?.lights?.find((item) => item.id === selectedLightId) || null;
    // 写入关键帧的目的时间用吸附值；取值/显示/手势起点一律用 raw playhead，
    // 否则处在两个帧格之间时 AutoKey OFF 的增量会从错误起点计算而产生漂移。
    const snappedPlayhead = snapDirectorTime(playhead, activeShot?.fps || 24);
    const selectedObjectRendered = selectedObject ? interpolateDirectorTransform(selectedObject.transform, selectedObject.keyframes, playhead) : null;

    useEffect(() => {
        if (!playing || !activeShot) return;
        let frame = 0;
        let last = performance.now();
        let pending = 0;
        const frameInterval = 1 / Math.max(1, Math.min(120, activeShot.fps || 24));
        const tick = (now: number) => {
            pending += Math.max(0, (now - last) / 1000);
            last = now;
            if (pending >= frameInterval) {
                const elapsed = Math.floor(pending / frameInterval) * frameInterval;
                pending -= elapsed;
                setPlayhead(advanceDirectorPlayhead(useDirectorWorkbenchStore.getState().playhead, elapsed, activeShot.duration));
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [activeShot, playing, setPlayhead]);

    const commit = useCallback((updater: (current: DirectorScene) => DirectorScene) => {
        // 普通提交前先终结暂存手势，避免新动作消费旧 base。
        stagedRef.current?.end("commit");
        const current = draftRef.current;
        if (!current) return;
        setHistory((items) => [...items.slice(-49), structuredClone(current)]);
        setFuture([]);
        writeAndPublish(touchDirectorScene(updater(current)));
    }, [writeAndPublish]);

    /** 暂存型手势（数值滑杆）：实时预览写草稿但不产生历史，也不镜像到项目。 */
    const stagedTransaction = useMemo(() => createDirectorTransaction<DirectorScene>({
        read: () => draftRef.current,
        // 取消：恢复快照且绝不发布被取消的值。
        restore: (snapshot) => writeDraft(snapshot),
        commit: (from) => {
            setHistory((items) => [...items.slice(-49), from]);
            setFuture([]);
            // 手势成功终态是真实 canonical 提交。
            commitDraft();
        },
        setActive: () => undefined,
    }), [commitDraft, writeDraft]);
    stagedRef.current = stagedTransaction;

    const stageGesture = useCallback((updater: (current: DirectorScene) => DirectorScene) => {
        const current = draftRef.current;
        if (!current) return;
        stagedTransaction.begin();
        writeDraft(touchDirectorScene(updater(current)));
    }, [stagedTransaction, writeDraft]);

    /** 无历史但持久的变化（标题、rig/motionClips 等）同样要镜像。 */
    const replaceWithoutHistory = useCallback((updater: (current: DirectorScene) => DirectorScene) => {
        const current = draftRef.current;
        if (current) writeAndPublish(touchDirectorScene(updater(current)));
    }, [writeAndPublish]);

    // 暂存手势的终止生命周期：常驻安装，非活跃时 end 为空操作。
    useEffect(() => installDirectorTerminalListeners(stagedTransaction, {
        window,
        document,
        isHidden: () => document.visibilityState === "hidden",
    }), [stagedTransaction]);

    // 切换选择/骨骼、关闭或卸载前必须先终止旧手势，不能让新选择消费旧 base。
    useEffect(() => () => stagedTransaction.end("cancel"), [open, selectedBone, selectedObjectId, stagedTransaction]);

    // 离开页面：active 预览由 end("commit") 完成真实提交，idle 只镜像。
    useEffect(() => {
        const onPageHide = () => {
            if (stagedTransaction.active()) stagedTransaction.end("commit");
            else mirrorDraft();
        };
        window.addEventListener("pagehide", onPageHide);
        return () => window.removeEventListener("pagehide", onPageHide);
    }, [mirrorDraft, stagedTransaction]);

    // 卸载兜底：只把最新 draft 镜像回项目，不制造新的 canonical revision。
    useEffect(() => () => {
        stagedRef.current?.end("cancel");
        mirrorDraft();
    }, [mirrorDraft]);

    const undo = () => {
        const previous = history.at(-1);
        if (!previous || !draft) return;
        setHistory((items) => items.slice(0, -1));
        setFuture((items) => [structuredClone(draft), ...items].slice(0, 50));
        writeAndPublish(previous);
    };
    const redo = () => {
        const next = future[0];
        if (!next || !draft) return;
        setFuture((items) => items.slice(1));
        setHistory((items) => [...items, structuredClone(draft)].slice(-50));
        writeAndPublish(next);
    };

    /**
     * 关闭统一入口：取消未结束的预览、写回当前 draft；场景有变化时趁视口仍在截取封面，再离开。
     * 封面上传在离开后继续进行，失败只提示，不影响已保存的场景。
     */
    const closeWorkbench = () => {
        if (closingRef.current) return;
        closingRef.current = true;
        stagedTransaction.end("cancel");
        mirrorDraft();
        void (async () => {
            const current = draftRef.current;
            const cover = current ? useDirectorStore.getState().covers[current.id] : undefined;
            if (current && captureReady && viewportRef.current && cover?.sceneUpdatedAt !== current.updatedAt) {
                try {
                    const beauty = await viewportRef.current.capture("beauty");
                    void uploadImage(beauty)
                        .then((image) => useDirectorStore.getState().setCover(current.id, { url: image.url, storageKey: image.storageKey, sceneUpdatedAt: current.updatedAt }))
                        .then(() => useAssetStore.getState().cleanupImages())
                        .catch(() => message.warning("导演台封面保存失败，下次关闭时会重试"));
                } catch {
                    message.warning("导演台截图失败，下次关闭时会重试");
                }
            }
            onClose();
        })();
    };

    const updateObject = (id: string, patch: Partial<DirectorObject>) => commit((current) => ({ ...current, objects: current.objects.map((item) => (item.id === id ? { ...item, ...patch } : item)) }));
    const updateLight = (id: string, patch: Partial<DirectorLight>) => commit((current) => ({ ...current, lights: current.lights.map((item) => (item.id === id ? { ...item, ...patch } : item)) }));
    const updateShot = (id: string, patch: Partial<DirectorShot>) => commit((current) => ({ ...current, shots: current.shots.map((item) => (item.id === id ? { ...item, ...patch } : item)) }));
    const removeObject = (id: string) => {
        commit((current) => ({ ...current, objects: current.objects.filter((item) => item.id !== id), cameras: current.cameras.map((camera) => removeDirectorCameraBindingsForObject(camera, id, current, playhead)) }));
        if (selectedObjectId === id) {
            setSelectedObjectId(null);
            setSelectedBone(null);
        }
    };
    const removeLight = (id: string) => {
        commit((current) => ({ ...current, lights: current.lights.filter((item) => item.id !== id) }));
        if (selectedLightId === id) setSelectedLightId(null);
    };
    const removeCamera = (id: string) => {
        if (!draft || draft.cameras.length <= 1) {
            message.warning("至少保留一台摄影机");
            return;
        }
        const fallback = draft.cameras.find((item) => item.id !== id);
        if (!fallback) return;
        commit((current) => ({
            ...current,
            cameras: current.cameras.filter((item) => item.id !== id),
            shots: current.shots.map((shot) => shot.cameraId === id ? { ...shot, cameraId: fallback.id } : shot),
        }));
    };

    /**
     * 所有「新增到场景」的唯一入口。
     * 在 commit 内读取一次 placement intent：因此模型上传等异步路径拿到的是
     * 「点击添加完成那一刻」的意图，而不是发起上传时捕获的过时坐标。
     * 锚点只提供 XZ，Y 严格保留构造器给定值，再交给 resolveDirectorPlacement 做碰撞避让。
     */
    const addObject = (object: DirectorObject) => {
        commit((current) => {
            const anchored = resolveDirectorPlacementAnchor({
                intent: viewportRef.current?.readPlacementIntent() ?? null,
                fallback: object.transform.position,
            });
            const position = resolveDirectorPlacement({ object: { ...object, transform: { ...object.transform, position: anchored } }, existing: current.objects, gridSnap: current.gridSnap });
            return { ...current, objects: [...current.objects, { ...object, transform: { ...object.transform, position } }] };
        });
        setSelectedObjectId(object.id);
    };

    const addPrimitive = (primitive: DirectorObject["primitive"], name: string) => addObject(createDirectorObject(primitive, name));

    const addActor = () => {
        const actorCount = draft?.objects.filter((item) => item.kind === "actor").length || 0;
        addObject(createDirectorActor(`演员 ${actorCount + 1}`, [0, 0, 0], DIRECTOR_ACTOR_COLORS[actorCount % DIRECTOR_ACTOR_COLORS.length]));
    };

    const addModelAsset = (asset: DirectorModelAsset) => addObject(createDirectorModel({ name: asset.title, assetId: asset.id, storageKey: asset.storageKey, url: asset.url, mimeType: asset.mimeType }));

    const setPanorama = (url: string, storageKey?: string, name?: string) => {
        commit((current) => ({ ...current, panorama: { url, storageKey, name, rotation: current.panorama?.rotation ?? 0 } }));
        setPanoramaHistoryOpen(false);
        setNavigationTab("panorama");
    };

    const uploadPanorama = async (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) { message.error("请选择图片文件"); return; }
        const signal = sessionRef.current.signal;
        setPanoramaUploading(true);
        try {
            const uploaded = await uploadImage(file);
            if (signal.aborted) return;
            addAsset({ kind: "image", title: file.name, coverUrl: uploaded.url, tags: ["全景图"], source: "导演台", data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType }, metadata: { source: "director-panorama" } });
            setPanorama(uploaded.url, uploaded.storageKey, file.name);
            message.success("全景图已加入场景和我的素材");
        } catch (error) {
            if (signal.aborted) return;
            message.error(error instanceof Error ? error.message : "全景图上传失败");
        } finally {
            if (!signal.aborted) setPanoramaUploading(false);
        }
    };

    const startPanoramaGeneration = (file: File) => {
        const sceneId = draftRef.current?.id;
        if (!sceneId || panoramaAIBusy) return;
        const model = effectiveConfig.imageModel || effectiveConfig.model;
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先配置图片模型");
            openConfigDialog(true);
            return;
        }
        const signal = sessionRef.current.signal;
        setPanoramaAIBusy(true);
        setPanoramaAIStatus("正在生成…");
        void generateDirectorPanorama({ file, config: effectiveConfig, sceneId, signal }).then((result) => {
            if (signal.aborted) return;
            const ratio = result.height > 0 ? result.width / result.height : 0;
            if (Math.abs(ratio - 2) > 0.08) message.warning("图片已生成，但不是 2:1 全景比例；在历史记录中选用前请检查效果");
            else message.success("全景图已生成，可在历史记录中选用");
            setPanoramaAIOpen(false);
        }).catch((error) => {
            if (signal.aborted) return;
            const text = error instanceof Error ? error.message : "全景图生成失败";
            setPanoramaAIStatus(text);
            message.error(text);
        }).finally(() => { if (!signal.aborted) setPanoramaAIBusy(false); });
    };

    /** 3D 模型只在导演台内使用，存到导演台自己的模型库（media_files），不进「我的素材」。 */
    const uploadModel = async (file?: File) => {
        if (!file || !/\.(glb|gltf)$/i.test(file.name)) return;
        try {
            const uploaded = await uploadMediaFile(file, "model");
            const asset = addModelToStore({ title: file.name.replace(/\.(glb|gltf)$/i, ""), url: uploaded.url, storageKey: uploaded.storageKey, bytes: uploaded.bytes, mimeType: uploaded.mimeType, fileName: file.name });
            addModelAsset(asset);
            message.success("3D 模型已加入场景和导演台模型库");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "3D 模型上传失败");
        }
    };

    const addBillboard = (asset: ImageAsset) => addObject(createDirectorBillboard(asset.title, asset.data.dataUrl, asset.data.storageKey, asset.id));

    const addCamera = () => {
        const camera = createDirectorCamera(`摄影机 ${draft?.cameras.length ? draft.cameras.length + 1 : 1}`);
        commit((current) => ({ ...current, cameras: [...current.cameras, camera] }));
        if (activeShot) updateShot(activeShot.id, { cameraId: camera.id });
    };

    const addPresetCamera = (presetId: DirectorCameraPresetId) => {
        const name = `机位 ${draft?.cameras.length ? draft.cameras.length + 1 : 1}`;
        const subject = draft?.objects.find((item) => item.id === selectedObjectId && (item.kind === "actor" || item.primitive === "character"))
            || draft?.objects.find((item) => item.kind === "actor" || item.primitive === "character");
        const target: DirectorVec3 = subject
            ? [subject.transform.position[0], subject.transform.position[1] + 1.2, subject.transform.position[2]]
            : activeCamera?.target || [0, 1, 0];
        const camera = createDirectorCameraFromPreset({ presetId, name, target, currentView: viewportRef.current?.readCameraTransform() });
        commit((current) => ({ ...current, cameras: [...current.cameras, camera], shots: current.shots.map((shot) => shot.id === current.activeShotId ? { ...shot, cameraId: camera.id } : shot) }));
        setSelectedObjectId(null);
        setSelectedLightId(null);
        setSceneInspectorView("shot");
        setViewMode("camera");
    };

    const addLight = (type: DirectorLight["type"] = "point", label = "灯光", position: DirectorVec3 = [2, 3, 2], intensity = 1.5) => {
        const light = createDirectorLight(type, `${label} ${draft?.lights.length ? draft.lights.length + 1 : 1}`, position, intensity);
        commit((current) => ({ ...current, lights: [...current.lights, light] }));
        setSelectedLightId(light.id);
    };

    const addLightMenuItems: MenuProps["items"] = [
        { key: "directional", icon: <Lightbulb className="size-3.5" />, label: "方向光", onClick: () => addLight("directional", "方向光", [4, 6, 4], 2.4) },
        { key: "point", icon: <Lightbulb className="size-3.5" />, label: "点光源", onClick: () => addLight("point", "点光源") },
        { key: "spot", icon: <Lightbulb className="size-3.5" />, label: "聚光灯", onClick: () => addLight("spot", "聚光灯", [2, 4, 2], 2) },
        { key: "ambient", icon: <LampDesk className="size-3.5" />, label: "环境光", onClick: () => addLight("ambient", "环境光", [0, 0, 0], 0.65) },
    ];
    const addObjectMenuItems: MenuProps["items"] = [
        { key: "actor", icon: <UserRound className="size-3.5" />, label: "演员", onClick: addActor },
        { key: "box", icon: <Box className="size-3.5" />, label: "立方体", onClick: () => addPrimitive("box", "立方体") },
        { key: "sphere", icon: <Circle className="size-3.5" />, label: "球体", onClick: () => addPrimitive("sphere", "球体") },
        { key: "cylinder", icon: <Cuboid className="size-3.5" />, label: "圆柱", onClick: () => addPrimitive("cylinder", "圆柱") },
        { key: "model", icon: <FileUp className="size-3.5" />, label: "上传模型", onClick: () => modelInputRef.current?.click() },
    ];

    const addShot = () => {
        if (!activeCamera) return;
        const shot: DirectorShot = { id: nanoid(), name: `镜头 ${(draft?.shots.length || 0) + 1}`, cameraId: activeCamera.id, duration: 5, fps: 24, shotSize: "medium", cameraMove: "static", prompt: "" };
        commit((current) => ({ ...current, shots: [...current.shots, shot], activeShotId: shot.id }));
        setPlayhead(0);
    };

    const addObjectKeyframe = () => {
        if (!selectedObject) return;
        // 取值用 raw playhead（视口真正渲染的时间），写入用 snapped 目的时间。
        const record = resolveDirectorKeyframeRecord({ base: selectedObject.transform, keyframes: selectedObject.keyframes, rawTime: playhead, snappedTime: snappedPlayhead });
        updateObject(selectedObject.id, { keyframes: record.keyframes });
    };

    const addCameraKeyframe = () => {
        if (!activeCamera) return;
        commit((current) => ({
            ...current,
            cameras: current.cameras.map((item) => item.id === activeCamera.id
                ? { ...item, keyframes: resolveDirectorKeyframeRecord({ base: item.transform, keyframes: item.keyframes, rawTime: playhead, snappedTime: snappedPlayhead }).keyframes }
                : item),
        }));
    };

    const recordSelectedKeyframe = () => {
        if (selectedObject && selectedBone) {
            const rotation = selectedObject.boneOverrides?.[selectedBone as DirectorHumanoidBone] || [0, 0, 0, 1] as DirectorQuat;
            updateObject(selectedObject.id, { boneTracks: upsertDirectorBoneKeyframe(selectedObject.boneTracks || [], selectedBone as DirectorHumanoidBone, snappedPlayhead, rotation) });
            return;
        }
        if (selectedObject) addObjectKeyframe();
        else addCameraKeyframe();
    };

    /**
     * 时间轴删除关键帧的唯一入口。
     *
     * 未命中（对象/摄影机/关键帧已不存在）时 removeDirectorSceneKeyframe 返回同一引用，
     * 此时不进 commit：不记历史、不产生修订、不触发保存。
     */
    const deleteKeyframe = useCallback((target: DirectorKeyframeDeleteTarget) => {
        const current = draftRef.current;
        if (!current || removeDirectorSceneKeyframe(current, target) === current) return;
        commit((scene) => removeDirectorSceneKeyframe(scene, target));
    }, [commit]);

    const setKeyframeEasing = useCallback((target: DirectorKeyframeDeleteTarget, easing: DirectorKeyframeEasing) => {
        const current = draftRef.current;
        if (!current || setDirectorSceneKeyframeEasing(current, target, easing) === current) return;
        commit((scene) => setDirectorSceneKeyframeEasing(scene, target, easing));
    }, [commit]);

    /**
     * 快捷键执行器。放在 ref 里：监听只在 open 变化时注册一次，
     * 但每次渲染都能拿到最新的选择、历史和 draft，避免闭包读到过期状态。
     *
     * 返回值表示「动作真的执行了」，只有执行了才 preventDefault：
     * 没有选中对象时的 Delete 仍然交还给浏览器。
     */
    const runShortcut = (action: DirectorShortcutAction): boolean => {
        switch (action.kind) {
            case "transform-mode":
                setTransformMode(action.mode);
                return true;
            case "delete-selected":
                if (selectedObject) {
                    removeObject(selectedObject.id);
                    return true;
                }
                if (selectedLight) {
                    removeLight(selectedLight.id);
                    return true;
                }
                return false;
            case "undo":
                if (!history.length) return false;
                undo();
                return true;
            case "redo":
                if (!future.length) return false;
                redo();
                return true;
            case "toggle-visibility":
                if (!selectedObject) return false;
                updateObject(selectedObject.id, { visible: !selectedObject.visible });
                return true;
            case "deselect":
                if (!selectedObjectId && !selectedLightId && !selectedBone) return false;
                setSelectedObjectId(null);
                setSelectedLightId(null);
                setSelectedBone(null);
                return true;
            case "toggle-play":
                setPlaying(!playing);
                return true;
        }
    };
    const runShortcutRef = useRef(runShortcut);
    runShortcutRef.current = runShortcut;

    // 导演台是全屏浮层，快捷键挂在 window；焦点落在任何交互控件内时交还给该控件，
    // 关键帧按钮再额外拦截自己的 Enter/Space/Delete/Backspace。
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            // 弹窗/抽屉打开时由它们接管 Escape 与文本输入快捷键。
            if (panoramaAIOpen || panoramaHistoryOpen || generateOpen) return;
            const action = resolveDirectorShortcut({
                key: event.key,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                isInteractiveTarget: blocksDirectorShortcut(event.target),
            });
            if (!action) return;
            if (runShortcutRef.current(action)) event.preventDefault();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [generateOpen, open, panoramaAIOpen, panoramaHistoryOpen]);

    /** 对象 transform 编辑的唯一入口：gizmo 与检查器共用同一套静态/动画语义。 */
    const handleObjectTransform = useCallback((id: string, from: DirectorTransform, to: DirectorTransform) => {
        commit((current) => ({
            ...current,
            objects: current.objects.map((item) => {
                if (item.id !== id) return item;
                const movedOnGround = Math.abs(to.position[0] - from.position[0]) > 1e-6 || Math.abs(to.position[2] - from.position[2]) > 1e-6;
                const edited = current.gridSnap && movedOnGround ? { ...to, position: snapDirectorGroundPosition(to.position, true) } : to;
                const edit = resolveDirectorObjectTransformEdit({ base: item.transform, keyframes: item.keyframes, rendered: from, edited, autoKey, time: snappedPlayhead });
                return { ...item, transform: edit.transform, keyframes: edit.keyframes };
            }),
        }));
    }, [autoKey, commit, snappedPlayhead]);

    const handleUniformScale = (id: string, value: number, stage: boolean) => {
        const write = stage ? stageGesture : commit;
        write((current) => ({ ...current, objects: current.objects.map((item) => item.id === id ? applyDirectorUniformScale(item, value) : item) }));
    };

    /** 骨骼写入语义：静态覆盖 + autoKey 时在吸附播放头补关键帧。gizmo 与数值编辑器共用。 */
    const writeBoneRotation = useCallback((id: string, bone: string, rotation: DirectorQuat, mode: "stage" | "commit") => {
        const write = mode === "stage" ? stageGesture : commit;
        write((current) => ({
            ...current,
            objects: current.objects.map((item) => item.id === id ? {
                ...item,
                boneOverrides: { ...item.boneOverrides, [bone]: rotation },
                boneTracks: autoKey ? upsertDirectorBoneKeyframe(item.boneTracks || [], bone as DirectorHumanoidBone, snappedPlayhead, rotation) : item.boneTracks,
            } : item),
        }));
    }, [autoKey, commit, snappedPlayhead, stageGesture]);

    const handleBoneTransform = useCallback((id: string, bone: string, rotation: DirectorQuat) => writeBoneRotation(id, bone, rotation, "commit"), [writeBoneRotation]);

    const handleActorRigReady = useCallback((id: string, rig: DirectorRig, animations: AnimationClip[]) => {
        replaceWithoutHistory((current) => ({
            ...current,
            objects: current.objects.map((item) => {
                if (item.id !== id) return item;
                const existing = item.motionClips || [];
                const motionClips = existing.length ? existing : animations.map((clip) => ({ id: nanoid(), name: clip.name || "动作片段", sourceAnimation: clip.name, start: 0, duration: Math.max(0.1, clip.duration), playbackRate: 1, loop: true }));
                return { ...item, rig, motionClips };
            }),
        }));
    }, [replaceWithoutHistory]);

    const applyCameraMove = () => {
        if (!activeCamera || !activeShot) return;
        const cameraId = activeCamera.id;
        const move = activeShot.cameraMove;
        const duration = activeShot.duration;
        commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === cameraId ? { ...item, keyframes: resolveDirectorCameraMoveKeyframes(item.keyframes, item.transform, cameraMoveTransform(item.transform, move), duration) } : item) }));
        message.success("已更新运镜首尾关键帧，可在动画模式继续编辑");
    };

    const alignCameraToView = () => {
        if (!activeCamera) return;
        const transform = viewportRef.current?.readCameraTransform();
        if (!transform) return;
        commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === activeCamera.id ? resolveDirectorCameraAlignment(item, transform, snappedPlayhead) : item) }));
        message.success("摄影机已对齐当前视图");
    };

    const openGenerate = () => {
        stagedTransaction.end("commit");
        setGenerateOpen(true);
    };

    /** 生成面板截图入口：必须在视口可截图时调用，且截图期间场景与镜头不能变化。 */
    const captureBeauty = async () => {
        const current = draftRef.current;
        if (!current || !activeShot || !viewportRef.current || !captureReady) throw new Error("视口尚未就绪，请稍后再试");
        const expected = { scene: current, shotId: activeShot.id };
        const beauty = await viewportRef.current.capture("beauty");
        if (!isDirectorOutputSnapshotCurrent(draftRef.current, expected)) throw new Error("截图期间场景或镜头已变化，请重试");
        return beauty;
    };

    const captureScreenshot = async () => {
        const signal = sessionRef.current.signal;
        const current = draftRef.current;
        const shot = current?.shots.find((item) => item.id === current.activeShotId) || current?.shots[0];
        if (captureBusy || !captureReady || !current || !shot || !viewportRef.current) return;
        setCaptureBusy(true);
        try {
            const beauty = await viewportRef.current.capture("beauty");
            if (signal.aborted || !openRef.current || draftRef.current?.id !== current.id) return;
            const uploaded = await uploadImage(beauty);
            const latest = draftRef.current;
            const latestShot = latest?.shots.find((item) => item.id === shot.id);
            if (signal.aborted || !openRef.current || !latest || latest.id !== current.id || !latestShot) return;
            const name = nextDirectorScreenshotName(latest.cameras.find((item) => item.id === latestShot.cameraId)?.name || "机位", latestShot.screenshots?.length || 0);
            const screenshot = { id: nanoid(), name, url: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, createdAt: new Date().toISOString() };
            addAsset({ kind: "image", title: name, coverUrl: uploaded.url, tags: ["导演台截图"], source: "导演台", data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType }, metadata: { source: "director-screenshot", sceneId: latest.id, shotId: shot.id } });
            commit((scene) => appendDirectorScreenshot(scene, { sceneId: current.id, shotId: shot.id, screenshot }));
            setSelectedObjectId(null);
            setSelectedLightId(null);
            setSceneInspectorView("shot");
            setCameraInspectorTab("screenshots");
            message.success("截图已保存到我的素材");
        } catch (error) {
            if (signal.aborted) return;
            message.error(error instanceof Error ? error.message : "截图失败，请重试");
        } finally {
            if (!signal.aborted) setCaptureBusy(false);
        }
    };

    const exportClayVideo = async () => {
        stagedTransaction.end("commit");
        const current = draftRef.current;
        if (!current || !activeShot || !viewportRef.current || recording) return;
        const expected = { scene: current, shotId: activeShot.id };
        setRecording(true);
        const wasPlaying = playing;
        const previousPlayhead = playhead;
        setPlayhead(0);
        setPlaying(true);
        try {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const clayVideo = await viewportRef.current.recordVideo(activeShot.duration, activeShot.fps);
            if (!isDirectorOutputSnapshotCurrent(draftRef.current, expected)) throw new Error("录制期间场景或镜头已变化，请重试");
            const stored = await uploadMediaFile(clayVideo, "director-clay");
            useDirectorStore.getState().addOutput({ sceneId: current.id, shotId: activeShot.id, shotName: activeShot.name, kind: "clay", status: "success", prompt: compileDirectorPrompt(current, activeShot), url: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType, width: stored.width, height: stored.height });
            setGenerateOpen(true);
            message.success("白膜视频已保存到生成结果");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "白膜视频导出失败");
        } finally {
            setPlaying(wasPlaying);
            setPlayhead(previousPlayhead);
            setRecording(false);
        }
    };

    if (!open || !draft || !activeShot) return null;

    const updateActiveCamera = (patch: Partial<DirectorCamera>) => activeCamera && commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === activeCamera.id ? { ...item, ...patch } : item) }));
    const handleFollowObject = (objectId: string) => {
        if (!activeCamera) return;
        commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === activeCamera.id
            ? objectId ? bindDirectorCameraFollow(item, current, objectId, playhead) : unbindDirectorCameraFollow(item, current, playhead)
            : item) }));
    };
    const shotInspector = <ShotInspector shot={activeShot} camera={activeCamera} cameras={draft.cameras} capabilities={capabilities} onUpdateShot={(patch) => updateShot(activeShot.id, patch)} onUpdateCamera={updateActiveCamera} onAddCameraKeyframe={addCameraKeyframe} onApplyCameraMove={applyCameraMove} onAlignCameraToView={alignCameraToView} onExportClay={() => void exportClayVideo()} recording={recording} showScreenshots={!capabilities.cameraTools} showCameraPosition={!capabilities.cameraTools} showCameraSelection={!capabilities.cameraTools} />;

    return (
        <div data-director-workbench="true" className="director-root flex h-full min-h-0 flex-col overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <header className="thin-scrollbar flex h-12 shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden border-b pr-2" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
                <div className="flex h-full w-[268px] shrink-0 items-center gap-2 border-r px-2 max-lg:w-[220px]" style={{ borderColor: theme.toolbar.border }}>
                    <IconButton label="返回场景列表" onClick={closeWorkbench}><ArrowLeft className="size-4" /></IconButton>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">3D导演台</span>
                </div>
                <Input aria-label="场景名称" variant="borderless" value={draft.title} className="max-w-36 font-medium" onChange={(event) => replaceWithoutHistory((current) => ({ ...current, title: event.target.value }))} />
                <span className="h-5 w-px" style={{ background: theme.toolbar.border }} />
                <IconButton label="撤销" disabled={!history.length} onClick={undo}><Undo2 className="size-4" /></IconButton>
                <IconButton label="重做" disabled={!future.length} onClick={redo}><Redo2 className="size-4" /></IconButton>
                <span className="h-5 w-px" style={{ background: theme.toolbar.border }} />
                {/* 一级模式切换：小屏也必须可达，因此不加 max-lg:hidden。 */}
                <nav className="director-mode-switch" aria-label="导演台模式">
                    {DIRECTOR_MODES.map((item) => (
                        <button
                            key={item.mode}
                            type="button"
                            data-mode={item.mode}
                            className={`director-mode-switch-button ${mode === item.mode ? "is-active" : ""}`}
                            aria-pressed={mode === item.mode}
                            title={item.hint}
                            onClick={(event) => {
                                setMode(item.mode);
                                // 焦点留在模式按钮上会让守卫吃掉 W/E/R/Delete。
                                releaseDirectorFocusAfterPointer(event);
                            }}
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>
                <span className="ml-auto shrink-0 text-[var(--fs-tiny)] opacity-55">自动保存在本地</span>
                <div className="flex shrink-0 items-center gap-1">
                    {onboardingScope ? <IconButton label="重新开始引导" onClick={() => setOnboardingRestartSignal((value) => value + 1)}><Lightbulb className="size-4" /></IconButton> : null}
                    <Select size="small" value={renderMode} className="w-24" options={renderModeOptions} onChange={setRenderMode} />
                    <Button size="small" icon={<Video className="size-3.5" />} loading={recording} onClick={() => void exportClayVideo()}>导出白膜</Button>
                    <Button size="small" type="primary" icon={<Wand2 className="size-3.5" />} onClick={openGenerate}>生成</Button>
                </div>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-[268px_minmax(0,1fr)_292px] max-lg:grid-cols-[220px_minmax(0,1fr)]">
                <aside className="flex min-h-0 overflow-hidden border-r" style={{ background: theme.node.panel, borderColor: theme.toolbar.border }}>
                    <DirectorWorkbenchRail active={navigationTab} onChange={(tab) => {
                        setNavigationTab(tab);
                        if (tab === "scene" || tab === "aspect" || tab === "panorama") {
                            setSelectedObjectId(null);
                            setSelectedLightId(null);
                            setSceneInspectorView("scene");
                        }
                    }} />
                    <div className="thin-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto">
                    {navigationTab === "scene" ? <>
                    <PanelTitle title="场景" action={<AddMenuButton label="添加场景对象" items={addObjectMenuItems} />} />
                    <div className="relative mx-2 mb-3">
                        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 opacity-55" aria-hidden />
                        <input type="search" data-canvas-no-zoom aria-label="搜索场景对象" placeholder="请输入搜索内容" value={sceneSearch} onChange={(event) => setSceneSearch(event.target.value)} onKeyDown={(event) => event.stopPropagation()} className="h-8 w-full rounded-lg border pl-8 pr-2 text-xs outline-none focus-visible:ring-2" style={{ background: theme.toolbar.itemHover, borderColor: theme.toolbar.border, color: theme.node.text }} />
                    </div>
                    <div className="px-2 pb-2">
                        {visibleSceneItems.map((item) => item.kind === "camera"
                            ? <SceneRow key={`camera-${item.id}`} active={sceneInspectorView === "shot" && activeShot.cameraId === item.id && !selectedObjectId && !selectedLightId} icon={<Camera />} label={item.name} onClick={() => { setSceneInspectorView("shot"); setSelectedObjectId(null); setSelectedLightId(null); updateShot(activeShot.id, { cameraId: item.id }); }} onDelete={() => removeCamera(item.id)} />
                            : item.kind === "object"
                                ? <SceneRow key={`object-${item.id}`} active={selectedObjectId === item.id} icon={item.object.kind === "actor" || item.object.primitive === "character" ? <UserRound /> : item.object.kind === "model" ? <BoxSelect /> : item.object.kind === "billboard" ? <ImageIcon /> : <Cuboid />} label={item.name} visible={item.object.visible} onVisibilityChange={() => commit((current) => toggleDirectorObjectVisibility(current, item.id))} onClick={() => { setSelectedLightId(null); setSelectedObjectId(item.id); }} onDelete={() => removeObject(item.id)} />
                                : <SceneRow key={`light-${item.id}`} active={selectedLightId === item.id} icon={<Lightbulb />} label={item.name} onClick={() => { setSelectedObjectId(null); setSelectedLightId(item.id); }} onDelete={() => removeLight(item.id)} />)}
                        {visibleSceneItems.length === 0 ? <p className="px-2 py-4 text-center text-xs opacity-55">未找到匹配的场景对象</p> : null}
                    </div>
                    </> : null}
                    {navigationTab === "actors" ? <>
                        <PanelTitle title="添加角色" />
                        <div className="px-2 pb-2">{draft.objects.filter((object) => object.kind === "actor" || object.primitive === "character").map((object) => <SceneRow key={object.id} active={selectedObjectId === object.id} icon={<UserRound />} label={object.name} visible={object.visible} onVisibilityChange={() => commit((current) => toggleDirectorObjectVisibility(current, object.id))} onClick={() => setSelectedObjectId(object.id)} onDelete={() => removeObject(object.id)} />)}</div>
                        <div className="px-2"><QuickAdd label="添加演员" icon={<UserRound />} onClick={addActor} /></div>
                    </> : null}
                    {navigationTab === "cameras" ? <>
                        <PanelTitle title="添加机位" />
                        <div className="grid grid-cols-2 gap-2 px-2 pb-3">
                            {DIRECTOR_CAMERA_PRESETS.map((preset) => <button key={preset.id} type="button" aria-label={preset.label} className="flex h-[72px] flex-col items-center justify-center gap-1 rounded-xl border text-xs transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2" style={{ borderColor: theme.toolbar.border }} onClick={(event) => { addPresetCamera(preset.id); releaseDirectorFocusAfterPointer(event); }}><Camera className="size-5" aria-hidden /><span>{preset.label}</span></button>)}
                        </div>
                    </> : null}
                    {navigationTab === "panorama" ? <>
                        <PanelTitle title="全景图" />
                        <div className="space-y-0.5 px-2 pb-3">
                            <PanoramaAction label={panoramaUploading ? "正在上传…" : "本地上传"} icon={<FileUp />} disabled={panoramaUploading} onClick={() => panoramaInputRef.current?.click()} />
                            <PanoramaAction label="历史记录" icon={<Clock3 />} onClick={() => setPanoramaHistoryOpen(true)} />
                            <PanoramaAction label={panoramaAIBusy ? "AI生成中…" : "AI生成"} icon={<Sparkles />} onClick={() => setPanoramaAIOpen(true)} />
                        </div>
                    </> : null}
                    {navigationTab === "aspect" ? <>
                        <PanelTitle title="选择画幅比例" />
                        <div className="grid grid-cols-2 gap-2 px-2 pb-3">
                            {DIRECTOR_ASPECT_RATIOS.map((ratio) => <button key={ratio} type="button" aria-label={ratio === "adaptive" ? "自适应" : ratio} aria-pressed={(draft.aspectRatio || "adaptive") === ratio} className="flex h-[72px] flex-col items-center justify-center gap-2 rounded-xl border text-xs transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2" style={{ borderColor: (draft.aspectRatio || "adaptive") === ratio ? theme.node.text : theme.toolbar.border }} onClick={(event) => { if ((draft.aspectRatio || "adaptive") !== ratio) commit((current) => ({ ...current, aspectRatio: ratio })); releaseDirectorFocusAfterPointer(event); }}><span className="flex size-6 items-center justify-center" aria-hidden><span className="block rounded-[2px] border" style={{ width: ratio === "9:16" || ratio === "3:4" ? 9 : ratio === "1:1" ? 16 : 20, height: ratio === "9:16" ? 20 : ratio === "3:4" ? 18 : ratio === "1:1" ? 16 : 11 }} /></span><span>{ratio === "adaptive" ? "自适应" : ratio}</span></button>)}
                        </div>
                    </> : null}
                    {navigationTab === "assets" ? <>
                        <PanelTitle title="3D 素材" />
                        <div className="px-2 pb-3"><QuickAdd label="上传模型" icon={<FileUp />} onClick={() => modelInputRef.current?.click()} />{modelAssets.map((asset) => <SceneRow key={asset.id} icon={<BoxSelect />} label={asset.title} onClick={() => addModelAsset(asset)} onDelete={() => removeModelAsset(asset.id)} />)}</div>
                        <PanelTitle title="素材图片立牌" />
                        <div className="px-2 pb-3">{imageAssets.slice(0, 30).map((asset) => <SceneRow key={asset.id} icon={<ImageIcon />} label={asset.title} onClick={() => addBillboard(asset)} />)}{imageAssets.length ? null : <p className="px-2 py-3 text-xs opacity-55">「我的素材」里还没有图片</p>}</div>
                    </> : null}
                    <input ref={modelInputRef} type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" className="hidden" onChange={(event) => { void uploadModel(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                    <input ref={panoramaInputRef} type="file" accept={"image/" + "*"} className="hidden" onChange={(event) => { void uploadPanorama(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                    </div>
                </aside>

                <main className="relative min-h-0 overflow-hidden" style={{ background: theme.canvas.background }}>
                    <DirectorViewport ref={viewportRef} scene={draft} selectedObjectId={selectedObjectId} selectedBone={selectedBone} transformMode={transformMode} renderMode={renderMode} playhead={playhead} playing={playing} showMotionPaths={sequencerVisible} viewMode={viewMode} onViewModeChange={setViewMode} onCaptureReadyChange={setCaptureReady} onSelectObject={setSelectedObjectId} onSelectBone={setSelectedBone} onObjectTransform={handleObjectTransform} onBoneTransform={handleBoneTransform} onActorRigReady={handleActorRigReady} />
                    <div className="pointer-events-none absolute left-3 top-3 text-[var(--fs-tiny)] font-medium text-white/70">{activeShot.name} · {activeCamera?.name || "无摄影机"} · {activeShot.duration}s</div>
                    <DirectorOnboarding scope={onboardingScope} open={open} restartSignal={onboardingRestartSignal} className="absolute right-3 top-3 z-[var(--z-popover)] w-[min(360px,calc(100%-24px))]" />
                    <DirectorViewportDock transformMode={transformMode} renderMode={renderMode} renderModes={capabilities.renderModes} onTransformModeChange={setTransformMode} onRenderModeChange={setRenderMode} onAddActor={addActor} onAddBox={() => addPrimitive("box", "立方体")} onAddLight={addLight} onAddCamera={addCamera} onAlignCamera={alignCameraToView} timelineOpen={sequencerVisible} onToggleTimeline={() => setSequencerVisible(!sequencerVisible)} captureBusy={captureBusy} captureReady={captureReady} onCapture={() => void captureScreenshot()} />
                </main>

                <aside className="thin-scrollbar min-h-0 overflow-y-auto border-l max-lg:col-span-2 max-lg:max-h-[40vh] max-lg:border-l-0 max-lg:border-t" style={{ background: theme.node.panel, borderColor: theme.toolbar.border }}>
                    {/* 摄影机模式下右栏固定显示 shot/camera 检查器：对齐视图与运镜是这个模式的主入口。 */}
                    {selectedObject && !capabilities.cameraTools ? <ObjectInspector object={selectedObject} rendered={selectedObjectRendered || selectedObject.transform} playhead={snappedPlayhead} selectedBone={selectedBone} capabilities={capabilities} onSelectBone={setSelectedBone} onUpdate={(patch) => updateObject(selectedObject.id, patch)} onTransformEdit={(edited) => handleObjectTransform(selectedObject.id, selectedObjectRendered || selectedObject.transform, edited)} onUniformScaleChange={(value, stage) => handleUniformScale(selectedObject.id, value, stage)} onUniformScaleCommit={() => stagedTransaction.end("commit")} onBoneRotationStage={(rotation) => selectedBone && writeBoneRotation(selectedObject.id, selectedBone, rotation, "stage")} onBoneRotationCommit={() => stagedTransaction.end("commit")} onAddKeyframe={recordSelectedKeyframe} onDelete={() => removeObject(selectedObject.id)} /> : selectedLight && !capabilities.cameraTools ? <LightInspector light={selectedLight} onUpdate={(patch) => updateLight(selectedLight.id, patch)} onDelete={() => removeLight(selectedLight.id)} /> : sceneInspectorView === "scene" && !capabilities.cameraTools ? <DirectorSceneInspector scene={draft} onChange={(patch) => commit((current) => ({ ...current, ...patch }))} /> : capabilities.cameraTools ? <DirectorCameraScreenshotTabs scene={draft} tab={cameraInspectorTab} onTabChange={setCameraInspectorTab}><DirectorCameraProperties camera={activeCamera} cameras={draft.cameras} shot={activeShot} objects={draft.objects} onUpdateCamera={updateActiveCamera} onSelectCamera={(cameraId) => updateShot(activeShot.id, { cameraId })} onFollowObject={handleFollowObject}>{shotInspector}</DirectorCameraProperties></DirectorCameraScreenshotTabs> : shotInspector}
                </aside>
            </div>

            <Modal title="选择全景图" open={panoramaHistoryOpen} onCancel={() => setPanoramaHistoryOpen(false)} footer={null} destroyOnHidden width={680} rootClassName="director-popup">
                <div className="grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto">
                    {imageAssets.map((asset) => <button key={asset.id} type="button" className="overflow-hidden rounded-lg border text-left transition hover:bg-black/5 dark:hover:bg-white/10" style={{ borderColor: theme.toolbar.border }} onClick={() => setPanorama(asset.data.dataUrl, asset.data.storageKey, asset.title)}>
                        <PanoramaHistoryThumbnail storageKey={asset.data.storageKey} fallback={asset.coverUrl || asset.data.dataUrl} />
                        <span className="block truncate p-2 text-xs">{asset.title}</span>
                    </button>)}
                </div>
                {imageAssets.length === 0 ? <p className="py-8 text-center text-xs opacity-60">「我的素材」里暂无图片，可先本地上传</p> : null}
            </Modal>
            <DirectorPanoramaAIModal open={panoramaAIOpen} busy={panoramaAIBusy} status={panoramaAIStatus} onClose={() => setPanoramaAIOpen(false)} onGenerate={startPanoramaGeneration} />
            <DirectorGeneratePanel open={generateOpen} scene={draft} shot={activeShot} onClose={() => setGenerateOpen(false)} onCapture={captureBeauty} />

            {/* 时间轴与一级工具模式解耦：底部按钮可在摆场等模式直接展开，不切走场景检查器。 */}
            {sequencerVisible ? <DirectorSequencer scene={draft} shot={activeShot} camera={activeCamera} objects={draft.objects} selectedObjectId={selectedObjectId} selectedBone={selectedBone} playhead={playhead} playing={playing} autoKey={autoKey} height={sequencerHeight} visible={true} onPlayToggle={() => setPlaying(!playing)} onPlayheadChange={setPlayhead} onAutoKeyChange={setAutoKey} onHeightChange={setSequencerHeight} onVisibilityChange={setSequencerVisible} onSelectObject={setSelectedObjectId} onSelectBone={setSelectedBone} onRecordKeyframe={recordSelectedKeyframe} onAddShot={addShot} onDeleteKeyframe={deleteKeyframe} onSetKeyframeEasing={setKeyframeEasing} onSelectShot={(id) => { commit((current) => ({ ...current, activeShotId: id })); setPlayhead(0); }} /> : null}
        </div>
    );
}

function ObjectInspector({ object, rendered, playhead, selectedBone, capabilities, onSelectBone, onUpdate, onTransformEdit, onUniformScaleChange, onUniformScaleCommit, onBoneRotationStage, onBoneRotationCommit, onAddKeyframe, onDelete }: { object: DirectorObject; rendered: DirectorTransform; playhead: number; selectedBone: string | null; capabilities: DirectorModeCapabilities; onSelectBone: (bone: string | null) => void; onUpdate: (patch: Partial<DirectorObject>) => void; onTransformEdit: (transform: DirectorTransform) => void; onUniformScaleChange: (value: number, stage: boolean) => void; onUniformScaleCommit: () => void; onBoneRotationStage: (rotation: DirectorQuat) => void; onBoneRotationCommit: () => void; onAddKeyframe: () => void; onDelete: () => void }) {
    const motionClips = object.motionClips || [];
    const activeMotionClip = motionClips.find((clip) => clip.id === object.activeMotionClipId);
    const mappedBones = Object.keys(object.rig?.boneMap || {}) as DirectorHumanoidBone[];
    const selectedBoneId = selectedBone as DirectorHumanoidBone | null;
    const selectedBoneRotation = selectedBoneId ? object.boneOverrides?.[selectedBoneId] || [0, 0, 0, 1] as DirectorQuat : null;
    const updateActiveMotion = (patch: Partial<NonNullable<DirectorObject["motionClips"]>[number]>) => activeMotionClip && onUpdate({ motionClips: motionClips.map((clip) => clip.id === activeMotionClip.id ? { ...clip, ...patch } : clip) });
    const applyPose = (pose: DirectorPose) => onUpdate({ pose, activeMotionClipId: undefined, boneOverrides: {} });
    const resetSelectedBone = () => {
        if (!selectedBoneId) return;
        const boneOverrides = { ...(object.boneOverrides || {}) };
        delete boneOverrides[selectedBoneId];
        onUpdate({ boneOverrides });
    };
    return <Inspector title={object.name} onTitleChange={(name) => onUpdate({ name })} onDelete={onDelete}>
        <TransformFields transform={rendered} onChange={onTransformEdit} />
        <Field label="统一缩放"><div className="flex items-center gap-2">
            <input aria-label="统一缩放滑杆" type="range" min={0.1} max={10} step={0.05} value={object.uniformScale ?? 1} className="min-w-0 flex-1 accent-cyan-400" onChange={(event) => onUniformScaleChange(Number(event.target.value), true)} onPointerUp={onUniformScaleCommit} onKeyUp={onUniformScaleCommit} onBlur={onUniformScaleCommit} />
            <InputNumber aria-label="统一缩放数值" size="small" controls={false} min={0.1} max={10} step={0.05} value={object.uniformScale ?? 1} className="w-[72px] shrink-0" onChange={(value) => { if (value !== null) onUniformScaleChange(value, false); }} />
        </div></Field>
        {object.kind === "actor" || object.primitive === "character"
            ? <Field label="角色颜色"><div className="director-actor-colors">{DIRECTOR_ACTOR_COLORS.map((color) => <button key={color} type="button" className={`director-actor-color ${object.color.toLowerCase() === color ? "is-active" : ""}`} style={{ background: color }} aria-label={`设置颜色 ${color}`} onClick={() => onUpdate({ color })} />)}<ColorPicker value={object.color} size="small" onChange={(_, color) => onUpdate({ color })} /></div></Field>
            : <Field label="颜色"><ColorPicker value={object.color} onChange={(_, color) => onUpdate({ color })} /></Field>}
        {/*
          骨骼与姿势入口：只在姿态/动画模式出现，且只对演员出现。
          规格要求「仅在演员选择时展示现有骨骼/姿势入口」——
          带动画的普通模型不是演员，不应拿到姿势预设与骨骼控制。
        */}
        {capabilities.bones && (object.kind === "actor" || object.primitive === "character") ? <>
            <section className="director-pose-section">
                <div className="director-inspector-section-title"><span>姿势预设</span><span>{directorPoseLabel(object.pose || "stand")}</span></div>
                <div className="director-pose-grid">{poseOptions.map((option) => <button key={option.value} type="button" className={`director-pose-button ${object.pose === option.value && !object.activeMotionClipId ? "is-active" : ""}`} title={option.label} onClick={() => applyPose(option.value)}>{option.label}</button>)}</div>
                <Button size="small" block onClick={() => applyPose("stand")}>重置姿态</Button>
            </section>
            <div className="flex items-center justify-between border-y py-2 text-[var(--fs-label)]"><span>角色绑定</span><span className="opacity-55">{object.rig?.status === "ready" ? `${mappedBones.length} 根骨骼` : "等待模型"}</span></div>
            {mappedBones.length ? <Field label="骨骼控制"><Select className="w-full" allowClear value={selectedBone || undefined} options={mappedBones.map((bone) => ({ label: directorBoneLabel(bone), value: bone }))} onChange={(bone) => onSelectBone(bone || null)} /></Field> : null}
            {selectedBoneId && selectedBoneRotation ? <><BoneRotationFields rotation={selectedBoneRotation} onChange={onBoneRotationStage} onChangeComplete={onBoneRotationCommit} /><Button size="small" block onClick={resetSelectedBone}>重置当前骨骼</Button></> : null}
            {/* 演员还没加载出模型时给一句解释，避免「动作片段」区域凭空消失。 */}
            {motionClips.length ? null : <div className="text-[var(--fs-tiny)] opacity-50">模型加载后会显示可用动作 Clip</div>}
        </> : null}
        {/* 动作片段是动画内容而非骨骼入口：任何带 Clip 的对象都能调，不限演员。 */}
        {motionClips.length ? <><Field label="动作片段"><Select className="w-full" value={object.activeMotionClipId || ""} options={[{ label: "静态姿势", value: "" }, ...motionClips.map((clip) => ({ label: clip.name, value: clip.id }))]} onChange={(activeMotionClipId) => onUpdate({ activeMotionClipId: activeMotionClipId || undefined })} /></Field>{activeMotionClip ? <div className="grid grid-cols-2 gap-2"><Field label="播放速度"><InputNumber className="w-full" min={0.1} max={4} step={0.1} value={activeMotionClip.playbackRate} onChange={(playbackRate) => updateActiveMotion({ playbackRate: playbackRate || 1 })} /></Field><Field label="循环"><Switch checked={activeMotionClip.loop} onChange={(loop) => updateActiveMotion({ loop })} /></Field></div> : null}</> : null}
        <Field label="可见"><Switch checked={object.visible} onChange={(visible) => onUpdate({ visible })} /></Field>
        <Field label="投射阴影"><Switch checked={object.castShadow} onChange={(castShadow) => onUpdate({ castShadow })} /></Field>
        {/* 记录关键帧属于动画模式；摆场与姿态模式不默认制造关键帧。 */}
        {capabilities.keyframes ? <>
            <Button block icon={<Focus className="size-3.5" />} onClick={onAddKeyframe}>{selectedBone ? `在 ${playhead.toFixed(1)}s 记录骨骼` : `在 ${playhead.toFixed(1)}s 记录关键帧`}</Button>
            <div className="text-[var(--fs-tiny)] opacity-50">Transform {object.keyframes.length} 个 · 骨骼 {object.boneTracks?.reduce((sum, track) => sum + track.keyframes.length, 0) || 0} 个</div>
        </> : null}
    </Inspector>;
}

function LightInspector({ light, onUpdate, onDelete }: { light: DirectorLight; onUpdate: (patch: Partial<DirectorLight>) => void; onDelete: () => void }) {
    return <Inspector title={light.name} onTitleChange={(name) => onUpdate({ name })} onDelete={onDelete}><Field label="类型"><Select className="w-full" value={light.type} options={[{ label: "方向光", value: "directional" }, { label: "点光源", value: "point" }, { label: "聚光灯", value: "spot" }, { label: "环境光", value: "ambient" }]} onChange={(type) => onUpdate({ type })} /></Field><Vec3Field label="位置" value={light.transform.position} onChange={(position) => onUpdate({ transform: { ...light.transform, position } })} /><Field label="颜色"><ColorPicker value={light.color} onChange={(_, color) => onUpdate({ color })} /></Field><Field label="强度"><InputNumber className="w-full" min={0} max={20} step={0.1} value={light.intensity} onChange={(value) => onUpdate({ intensity: value || 0 })} /></Field><Field label="投射阴影"><Switch checked={light.castShadow} onChange={(castShadow) => onUpdate({ castShadow })} /></Field></Inspector>;
}

function ShotInspector({ shot, camera, cameras, capabilities, onUpdateShot, onUpdateCamera, onAddCameraKeyframe, onApplyCameraMove, onAlignCameraToView, onExportClay, recording, showScreenshots = true, showCameraPosition = true, showCameraSelection = true }: { shot: DirectorShot; camera: DirectorCamera | null; cameras: DirectorScene["cameras"]; capabilities: DirectorModeCapabilities; onUpdateShot: (patch: Partial<DirectorShot>) => void; onUpdateCamera: (patch: Partial<DirectorCamera>) => void; onAddCameraKeyframe: () => void; onApplyCameraMove: () => void; onAlignCameraToView: () => void; onExportClay: () => void; recording: boolean; showScreenshots?: boolean; showCameraPosition?: boolean; showCameraSelection?: boolean }) {
    return <Inspector title={shot.name} onTitleChange={(name) => onUpdateShot({ name })}>
        {showCameraSelection ? <Field label="摄影机"><Select className="w-full" value={shot.cameraId} options={cameras.map((item) => ({ label: item.name, value: item.id }))} onChange={(cameraId) => onUpdateShot({ cameraId })} /></Field> : null}
        <div className="grid grid-cols-2 gap-2"><Field label="景别"><Select className="w-full" value={shot.shotSize} options={shotSizeOptions} onChange={(shotSize: DirectorShotSize) => onUpdateShot({ shotSize })} /></Field><Field label="帧率"><Select className="w-full" value={shot.fps} options={[24, 25, 30].map((fps) => ({ label: `${fps} fps`, value: fps }))} onChange={(fps: 24 | 25 | 30) => onUpdateShot({ fps })} /></Field></div>
        <Field label="运镜"><Select className="w-full" value={shot.cameraMove} options={cameraMoveOptions} onChange={(cameraMove: DirectorCameraMove) => onUpdateShot({ cameraMove })} /></Field>
        <Field label="时长"><InputNumber className="w-full" min={0.5} max={60} step={0.5} value={shot.duration} addonAfter="秒" onChange={(value) => onUpdateShot({ duration: value || 5 })} /></Field>
        <Field label="镜头意图"><Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} value={shot.prompt} placeholder="人物表演、动作、叙事目标…" onChange={(event) => onUpdateShot({ prompt: event.target.value })} /></Field>
        {camera ? <>{showCameraPosition ? <><Vec3Field label="摄影机位置" value={camera.transform.position} onChange={(position) => onUpdateCamera({ transform: { ...camera.transform, position } })} /><Vec3Field label="焦点" value={camera.target} onChange={(target) => onUpdateCamera({ target })} /></> : null}<Field label="焦距"><InputNumber className="w-full" min={12} max={200} value={camera.focalLength} addonAfter="mm" onChange={(focalLength) => onUpdateCamera({ focalLength: focalLength || 35, fov: directorFocalLengthToFov(focalLength || 35) })} /></Field><div className="grid grid-cols-2 gap-2"><Field label="光圈"><InputNumber className="w-full" min={0.7} max={32} step={0.1} value={camera.aperture} addonBefore="f/" onChange={(aperture) => onUpdateCamera({ aperture: aperture || 2.8 })} /></Field><Field label="焦点距离"><InputNumber className="w-full" min={0.1} max={200} step={0.1} value={camera.focusDistance} addonAfter="m" onChange={(focusDistance) => onUpdateCamera({ focusDistance: focusDistance || 5 })} /></Field></div><Button block icon={<Camera className="size-3.5" />} onClick={onAlignCameraToView}>摄影机对齐当前视图</Button><Button block icon={<Video className="size-3.5" />} onClick={onApplyCameraMove}>按运镜生成轨迹</Button>{capabilities.keyframes ? <Button block icon={<Focus className="size-3.5" />} onClick={onAddCameraKeyframe}>记录摄影机关键帧</Button> : null}<Button block type="primary" ghost icon={<Video className="size-3.5" />} loading={recording} onClick={onExportClay}>导出白膜视频</Button></> : null}
        {showScreenshots ? <DirectorScreenshotGallery screenshots={shot.screenshots || []} /> : null}
    </Inspector>;
}

function Inspector({ title, children, onTitleChange, onDelete }: { title: string; children: ReactNode; onTitleChange: (value: string) => void; onDelete?: () => void }) {
    return <div className="space-y-3 p-3"><div className="flex items-center gap-2"><Input variant="borderless" value={title} className="min-w-0 flex-1 px-0 font-medium" onChange={(event) => onTitleChange(event.target.value)} />{onDelete ? <IconButton label="删除" onClick={onDelete}><Trash2 className="size-4" /></IconButton> : null}</div>{children}</div>;
}

function TransformFields({ transform, onChange }: { transform: DirectorTransform; onChange: (transform: DirectorTransform) => void }) {
    return <><Vec3Field label="位置" value={transform.position} onChange={(position) => onChange({ ...transform, position })} /><Vec3Field label="旋转" value={transform.rotation} step={0.05} onChange={(rotation) => onChange({ ...transform, rotation })} /><Vec3Field label="缩放" value={transform.scale} step={0.1} onChange={(scale) => onChange({ ...transform, scale })} /></>;
}

function BoneRotationFields({ rotation, onChange, onChangeComplete }: { rotation: DirectorQuat; onChange: (rotation: DirectorQuat) => void; onChangeComplete: () => void }) {
    const initialDegrees = useMemo(() => {
        const euler = new Euler().setFromQuaternion(new Quaternion(...rotation), "XYZ");
        return [euler.x, euler.y, euler.z].map((value) => Number(((value * 180) / Math.PI).toFixed(1))) as DirectorVec3;
    }, [rotation]);
    const [degrees, setDegrees] = useState<DirectorVec3>(initialDegrees);
    const lastEmittedRotation = useRef<DirectorQuat | null>(null);
    useEffect(() => {
        if (lastEmittedRotation.current && sameDirectorQuaternion(rotation, lastEmittedRotation.current)) {
            lastEmittedRotation.current = null;
            return;
        }
        setDegrees(initialDegrees);
    }, [initialDegrees, rotation]);
    const updateAxis = (index: number, value: number) => {
        const next = degrees.map((entry, entryIndex) => entryIndex === index ? value : entry) as DirectorVec3;
        const radians = next.map((entry) => (entry * Math.PI) / 180) as DirectorVec3;
        const nextRotation = new Quaternion().setFromEuler(new Euler(radians[0], radians[1], radians[2], "XYZ")).toArray() as DirectorQuat;
        setDegrees(next);
        lastEmittedRotation.current = nextRotation;
        onChange(nextRotation);
    };
    return <Field label="骨骼旋转（局部角度 °）"><div className="space-y-1.5">
        {degrees.map((value, index) => <div key={index} className="grid grid-cols-[18px_minmax(0,1fr)_48px] items-center gap-2">
            <span className="text-[var(--fs-tiny)] font-medium opacity-65">{["X", "Y", "Z"][index]}</span>
            <Slider className="m-0" min={-180} max={180} step={1} value={value} onChange={(next) => updateAxis(index, Array.isArray(next) ? next[0] ?? 0 : next)} onChangeComplete={onChangeComplete} />
            <span className="text-right text-[var(--fs-tiny)] tabular-nums opacity-65">{value.toFixed(1)}°</span>
        </div>)}
    </div></Field>;
}

function sameDirectorQuaternion(left: DirectorQuat, right: DirectorQuat) {
    const directDistance = left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0);
    const inverseDistance = left.reduce((sum, value, index) => sum + Math.abs(value + right[index]), 0);
    return Math.min(directDistance, inverseDistance) < 0.0001;
}

function Vec3Field({ label, value, step = 0.1, onChange }: { label: string; value: DirectorVec3; step?: number; onChange: (value: DirectorVec3) => void }) {
    return <Field label={label}><div className="grid grid-cols-3 gap-1">{value.map((item, index) => <InputNumber key={index} className="w-full" size="small" step={step} value={Number(item.toFixed(2))} onChange={(next) => onChange(value.map((entry, itemIndex) => itemIndex === index ? next || 0 : entry) as DirectorVec3)} />)}</div></Field>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className="mb-1 block text-[var(--fs-label)] opacity-55">{label}</span>{children}</label>; }
function PanelTitle({ title, action }: { title: string; action?: ReactNode }) { return <div className="flex h-9 items-center px-3 text-[var(--fs-tiny)] font-semibold uppercase opacity-55"><span className="flex-1">{title}</span>{action}</div>; }
/**
 * 场景列表行。选择按钮点完必须释放焦点：
 *「点选对象 -> 按 Delete」是 delete-selected 快捷键的主流程，
 * 焦点留在按钮上会让守卫把 Delete 吃掉。
 */
function SceneRow({ active, icon, label, visible, onVisibilityChange, onClick, onDelete }: { active?: boolean; icon: ReactElement; label: string; visible?: boolean; onVisibilityChange?: () => void; onClick: () => void; onDelete?: () => void }) {
    return <div data-director-scene-row="true" className={`group flex h-8 w-full items-center gap-1 px-1 text-left text-xs transition ${active ? "bg-black/10 dark:bg-white/10" : "hover:bg-black/5 dark:hover:bg-white/5"}`}>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left" onClick={(event) => { onClick(); releaseDirectorFocusAfterPointer(event); }}>
            <span className="[&>svg]:size-3.5">{icon}</span>
            <span className={`truncate ${visible === false ? "opacity-45" : ""}`}>{label}</span>
        </button>
        {onVisibilityChange ? <button type="button" aria-label={`${visible ? "隐藏" : "显示"}${label}`} aria-pressed={!visible} title={visible ? "隐藏" : "显示"} className={`grid size-6 shrink-0 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10 ${visible ? "opacity-45 group-hover:opacity-100 focus-visible:opacity-100" : "opacity-75"}`} onClick={(event) => { event.stopPropagation(); onVisibilityChange(); releaseDirectorFocusAfterPointer(event); }}>{visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}</button> : null}
        {onDelete ? <button type="button" aria-label={`删除${label}`} title={`删除${label}`} className="grid size-6 shrink-0 place-items-center rounded opacity-60 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" onClick={(event) => { event.stopPropagation(); onDelete(); releaseDirectorFocusAfterPointer(event); }}><Trash2 className="size-3.5" /></button> : null}
    </div>;
}
function AddMenuButton({ label, items }: { label: string; items: MenuProps["items"] }) {
    return <Dropdown trigger={["click"]} placement="bottomRight" menu={{ items }}><button type="button" aria-label={label} title={label} className="grid size-8 shrink-0 place-items-center rounded-md transition hover:bg-black/5 dark:hover:bg-white/10"><Plus className="size-3.5" /></button></Dropdown>;
}
function QuickAdd({ label, icon, onClick }: { label: string; icon: ReactElement; onClick: () => void }) { return <button type="button" className="flex h-8 items-center gap-1.5 border px-2 text-[var(--fs-tiny)] transition hover:bg-black/5 dark:hover:bg-white/5" onClick={(event) => { onClick(); releaseDirectorFocusAfterPointer(event); }}><span className="[&>svg]:size-3.5">{icon}</span><span className="truncate">{label}</span></button>; }
function PanoramaAction({ label, icon, disabled, onClick }: { label: string; icon: ReactElement; disabled?: boolean; onClick: () => void }) { return <button type="button" disabled={disabled} className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition hover:bg-white/5 disabled:opacity-55" onClick={(event) => { onClick(); releaseDirectorFocusAfterPointer(event); }}><span className="[&>svg]:size-4">{icon}</span><span>{label}</span></button>; }
function PanoramaHistoryThumbnail({ storageKey, fallback }: { storageKey?: string; fallback: string }) {
    const [url, setUrl] = useState(fallback);
    useEffect(() => {
        let active = true;
        void resolveImageUrl(storageKey, fallback).then((resolved) => { if (active) setUrl(resolved); });
        return () => { active = false; };
    }, [storageKey, fallback]);
    return <img src={url} alt="" className="aspect-video w-full object-cover" />;
}
function IconButton({ label, disabled, children, onClick }: { label: string; disabled?: boolean; children: ReactNode; onClick: () => void }) { return <button type="button" aria-label={label} title={label} disabled={disabled} className="grid size-8 shrink-0 place-items-center rounded-md transition hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10" onClick={(event) => { onClick(); releaseDirectorFocusAfterPointer(event); }}>{children}</button>; }
const poseOptions: Array<{ label: string; value: DirectorPose }> = [
    { label: "站立", value: "stand" }, { label: "T 型", value: "t_pose" }, { label: "行走", value: "walk" }, { label: "跑步", value: "run" },
    { label: "坐姿", value: "sit" }, { label: "蹲下", value: "squat" }, { label: "单膝跪", value: "kneel_single" }, { label: "双膝跪", value: "kneel_double" },
    { label: "叉腰", value: "hands_hips" }, { label: "倚靠", value: "lean" }, { label: "鞠躬", value: "bow" }, { label: "思考", value: "think" },
    { label: "格斗", value: "fight" }, { label: "踢球", value: "kick" }, { label: "投掷", value: "throw" }, { label: "推进", value: "push" },
    { label: "招手", value: "wave" }, { label: "伸手", value: "reach" }, { label: "抱臂", value: "arms_crossed" }, { label: "看手机", value: "phone" },
];
const shotSizeOptions = [{ label: "大远景", value: "extreme_wide" }, { label: "远景", value: "wide" }, { label: "全身景", value: "full" }, { label: "中景", value: "medium" }, { label: "近景", value: "close_up" }, { label: "大特写", value: "extreme_close_up" }];
const cameraMoveOptions = [{ label: "固定", value: "static" }, { label: "推进", value: "push_in" }, { label: "拉远", value: "pull_out" }, { label: "左摇", value: "pan_left" }, { label: "右摇", value: "pan_right" }, { label: "上摇", value: "tilt_up" }, { label: "下摇", value: "tilt_down" }, { label: "左环绕", value: "orbit_left" }, { label: "右环绕", value: "orbit_right" }, { label: "手持", value: "handheld" }];
/** 渲染视图全集。实际可选项由当前模式的 capabilities.renderModes 过滤。 */
const DIRECTOR_RENDER_MODE_LABELS: Array<{ label: string; value: DirectorRenderMode }> = [
    { label: "预览", value: "beauty" },
    { label: "彩色白膜", value: "clay" },
    { label: "骨骼", value: "pose" },
    { label: "深度", value: "depth" },
    { label: "法线", value: "normal" },
];

function cameraMoveTransform(transform: DirectorTransform, move: DirectorCameraMove): DirectorTransform {
    const [x, y, z] = transform.position;
    const offsets: Record<DirectorCameraMove, DirectorVec3> = { static: [0, 0, 0], push_in: [0, 0, -2], pull_out: [0, 0, 2], pan_left: [-2, 0, 0], pan_right: [2, 0, 0], tilt_up: [0, 1.5, 0], tilt_down: [0, -1.2, 0], orbit_left: [-2.5, 0, -1.5], orbit_right: [2.5, 0, -1.5], handheld: [0.18, 0.08, -0.15] };
    const offset = offsets[move];
    return { ...transform, position: [x + offset[0], y + offset[1], z + offset[2]] };
}
