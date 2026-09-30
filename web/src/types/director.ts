import type { DirectorAspectRatio } from "@/lib/director/director-aspect-ratio";

export type DirectorVec3 = [number, number, number];
export type DirectorQuat = [number, number, number, number];

export type DirectorTransform = {
    position: DirectorVec3;
    rotation: DirectorVec3;
    scale: DirectorVec3;
};

export type DirectorPrimitiveKind = "box" | "sphere" | "cylinder" | "plane" | "character";
export type DirectorObjectKind = "primitive" | "model" | "actor" | "billboard";
export type DirectorPose = "neutral" | "stand" | "t_pose" | "walk" | "run" | "sit" | "squat" | "kneel_single" | "kneel_double" | "hands_hips" | "lean" | "bow" | "think" | "fight" | "kick" | "throw" | "push" | "wave" | "reach" | "arms_crossed" | "phone";
export type DirectorCameraMove = "static" | "push_in" | "pull_out" | "pan_left" | "pan_right" | "tilt_up" | "tilt_down" | "orbit_left" | "orbit_right" | "handheld";
export type DirectorShotSize = "extreme_wide" | "wide" | "full" | "medium" | "close_up" | "extreme_close_up";
export type DirectorRenderMode = "beauty" | "clay" | "depth" | "normal" | "pose";
export type DirectorKeyframeEasing = "step" | "linear" | "smooth";

export type DirectorKeyframe = {
    id: string;
    time: number;
    transform: DirectorTransform;
    easing?: DirectorKeyframeEasing;
};

export type DirectorFingerBone =
    | "leftThumb1" | "leftThumb2" | "leftThumb3" | "leftIndex1" | "leftIndex2" | "leftIndex3" | "leftMiddle1" | "leftMiddle2" | "leftMiddle3" | "leftRing1" | "leftRing2" | "leftRing3" | "leftPinky1" | "leftPinky2" | "leftPinky3"
    | "rightThumb1" | "rightThumb2" | "rightThumb3" | "rightIndex1" | "rightIndex2" | "rightIndex3" | "rightMiddle1" | "rightMiddle2" | "rightMiddle3" | "rightRing1" | "rightRing2" | "rightRing3" | "rightPinky1" | "rightPinky2" | "rightPinky3";

export type DirectorHumanoidBone = "root" | "hips" | "spine" | "chest" | "neck" | "head" | "leftShoulder" | "leftUpperArm" | "leftLowerArm" | "leftHand" | "rightShoulder" | "rightUpperArm" | "rightLowerArm" | "rightHand" | "leftUpperLeg" | "leftLowerLeg" | "leftFoot" | "rightUpperLeg" | "rightLowerLeg" | "rightFoot" | DirectorFingerBone;

export type DirectorBoneKeyframe = {
    id: string;
    time: number;
    rotation: DirectorQuat;
    easing?: DirectorKeyframeEasing;
};

export type DirectorBoneTrack = {
    bone: DirectorHumanoidBone;
    keyframes: DirectorBoneKeyframe[];
};

/**
 * 时间轴上一个可删除关键帧的定位信息。
 * 三类覆盖当前时间轴真正可见的关键帧轨道：对象 transform、对象骨骼、摄影机。
 */
export type DirectorKeyframeDeleteTarget =
    | { track: "object-transform"; objectId: string; keyframeId: string }
    | { track: "object-bone"; objectId: string; bone: DirectorHumanoidBone; keyframeId: string }
    | { track: "camera"; cameraId: string; keyframeId: string };

export type DirectorRig = {
    status: "unmapped" | "ready";
    boneMap: Partial<Record<DirectorHumanoidBone, string>>;
    animationNames: string[];
};

export type DirectorMotionClip = {
    id: string;
    name: string;
    sourceAnimation: string;
    start: number;
    duration: number;
    playbackRate: number;
    loop: boolean;
};

export type DirectorObject = {
    id: string;
    name: string;
    kind: DirectorObjectKind;
    primitive?: DirectorPrimitiveKind;
    transform: DirectorTransform;
    color: string;
    /** 独立的统一缩放倍率；旧场景缺省为 1，不抹平各轴比例。 */
    uniformScale?: number;
    visible: boolean;
    castShadow: boolean;
    receiveShadow: boolean;
    pose?: DirectorPose;
    rig?: DirectorRig;
    motionClips?: DirectorMotionClip[];
    activeMotionClipId?: string;
    boneOverrides?: Partial<Record<DirectorHumanoidBone, DirectorQuat>>;
    boneTracks?: DirectorBoneTrack[];
    sourceNodeId?: string;
    assetId?: string;
    storageKey?: string;
    url?: string;
    mimeType?: string;
    keyframes: DirectorKeyframe[];
};

export type DirectorCamera = {
    id: string;
    name: string;
    transform: DirectorTransform;
    target: DirectorVec3;
    /** 角色跟随以绑定帧的位置为锚；相机原有关键帧仍可叠加角色位移。 */
    followObjectId?: string;
    followAnchor?: DirectorVec3;
    /** 旧场景缺省为坐标注视。 */
    lookAtMode?: "coordinates" | "rotation" | "object";
    lookAtObjectId?: string;
    focalLength: number;
    fov: number;
    aperture: number;
    focusDistance: number;
    near: number;
    far: number;
    keyframes: DirectorKeyframe[];
};

export type DirectorLight = {
    id: string;
    name: string;
    type: "directional" | "point" | "spot" | "ambient";
    transform: DirectorTransform;
    color: string;
    intensity: number;
    angle?: number;
    penumbra?: number;
    castShadow: boolean;
};

export type DirectorShot = {
    id: string;
    name: string;
    cameraId: string;
    duration: number;
    fps: 24 | 25 | 30;
    shotSize: DirectorShotSize;
    cameraMove: DirectorCameraMove;
    prompt: string;
    previewNodeId?: string;
    depthNodeId?: string;
    normalNodeId?: string;
    screenshots?: DirectorScreenshot[];
};

export type DirectorScreenshot = {
    id: string;
    name: string;
    storageKey: string;
    url: string;
    width: number;
    height: number;
    createdAt: string;
};

export type DirectorScene = {
    id: string;
    version: 1;
    title: string;
    background: string;
    environmentIntensity: number;
    gridVisible: boolean;
    /** Snap new placement and XZ moves to the half-unit ground grid; absent means off. */
    gridSnap?: boolean;
    /** Optional for scenes saved before ground controls existed. */
    ground?: { visible: boolean; opacity: number; height: number };
    /** Whole stage transform; absent in older scenes means identity. Rotation is in degrees. */
    stageTransform?: { scale: number; position: DirectorVec3; rotation: DirectorVec3 };
    /** Editor overlays only; older scenes keep labels visible. */
    labelsVisible?: boolean;
    /** Missing in older saved scenes; treated as adaptive. */
    aspectRatio?: DirectorAspectRatio;
    /** Optional equirectangular backdrop; older scenes keep their solid color. */
    panorama?: { url: string; storageKey?: string; name?: string; rotation: number };
    /** Sphere controls remain available even before a panorama image is connected. */
    panoramaRotation?: number;
    panoramaRadius?: number;
    objects: DirectorObject[];
    cameras: DirectorCamera[];
    lights: DirectorLight[];
    shots: DirectorShot[];
    activeShotId: string;
    createdAt: string;
    updatedAt: string;
};

export type DirectorSceneOutput = {
    scene: DirectorScene;
    shot: DirectorShot;
    prompt: string;
    beauty: Blob;
    depth?: Blob;
    normal?: Blob;
    clayVideo?: Blob;
    clayVideoMimeType?: string;
};
