import { Input, InputNumber, Select } from "antd";
import type { ReactNode } from "react";

import { directorFovToFocalLength } from "@/lib/director/director-scene";
import type { DirectorCamera, DirectorObject, DirectorShot, DirectorVec3 } from "@/types/director";

type Props = {
    camera: DirectorCamera | null;
    cameras: DirectorCamera[];
    shot: DirectorShot;
    objects: DirectorObject[];
    onUpdateCamera: (patch: Partial<DirectorCamera>) => void;
    onSelectCamera: (cameraId: string) => void;
    onFollowObject: (objectId: string) => void;
    children: ReactNode;
};

export function DirectorCameraProperties({ camera, cameras, shot, objects, onUpdateCamera, onSelectCamera, onFollowObject, children }: Props) {
    if (!camera) return <div className="p-4 text-sm opacity-60">无可用机位</div>;
    const changePosition = (index: number, value: number | null) => {
        const position = camera.transform.position.map((entry, axis) => axis === index ? value ?? entry : entry) as DirectorVec3;
        onUpdateCamera({ transform: { ...camera.transform, position } });
    };
    const changeTarget = (index: number, value: number | null) => {
        const target = camera.target.map((entry, axis) => axis === index ? value ?? entry : entry) as DirectorVec3;
        onUpdateCamera({ target });
    };
    const changeFov = (value: number) => {
        const fov = Math.max(15, Math.min(90, value));
        onUpdateCamera({ fov, focalLength: directorFovToFocalLength(fov) });
    };
    const changeRotation = (index: number, value: number | null) => {
        if (value === null) return;
        const rotation = camera.transform.rotation.map((entry, axis) => axis === index ? value * Math.PI / 180 : entry) as DirectorVec3;
        onUpdateCamera({ transform: { ...camera.transform, rotation } });
    };
    const lookAtValue = camera.lookAtMode === "rotation" ? "rotation"
        : camera.lookAtMode !== "coordinates" && objects.some((item) => item.id === camera.lookAtObjectId) ? `object:${camera.lookAtObjectId}` : "coordinates";
    const followValue = objects.some((item) => item.id === camera.followObjectId) ? camera.followObjectId : "";
    return <div className="space-y-4 px-3 py-4">
        <Field label="名称"><Input size="small" variant="filled" value={camera.name} onChange={(event) => onUpdateCamera({ name: event.target.value })} /></Field>
        <Field label="切换机位"><Select size="small" variant="filled" className="w-full" value={shot.cameraId} options={cameras.map((item) => ({ label: item.name, value: item.id }))} onChange={onSelectCamera} /></Field>
        <AxisField label="位置" value={camera.transform.position} onChange={changePosition} />
        <Field label="跟随目标"><Select size="small" variant="filled" className="w-full" value={followValue} options={[{ label: "不跟随", value: "" }, ...objects.map((item) => ({ label: item.name, value: item.id }))]} onChange={onFollowObject} /></Field>
        <Field label="注视目标"><Select size="small" variant="filled" className="w-full" value={lookAtValue} options={[{ label: "手动坐标", value: "coordinates" }, { label: "手动旋转", value: "rotation" }, ...objects.map((item) => ({ label: item.name, value: `object:${item.id}` }))]} onChange={(value) => onUpdateCamera(value.startsWith("object:") ? { lookAtMode: "object", lookAtObjectId: value.slice(7) } : { lookAtMode: value as "coordinates" | "rotation", lookAtObjectId: undefined })} /></Field>
        {lookAtValue === "coordinates" ? <AxisField label="注视坐标" value={camera.target} onChange={changeTarget} /> : null}
        {lookAtValue === "rotation" ? <AxisField label="旋转" value={camera.transform.rotation.map((value) => value * 180 / Math.PI) as DirectorVec3} onChange={changeRotation} /> : null}
        <Field label="视野角度 (FOV)"><div className="flex items-center gap-2"><input aria-label="视野角度 (FOV)" className="min-w-0 flex-1 accent-cyan-500" type="range" min={15} max={90} step={1} value={Math.min(90, Math.max(15, camera.fov))} onChange={(event) => changeFov(Number(event.target.value))} /><InputNumber aria-label="FOV 数值" size="small" variant="filled" controls={false} min={15} max={90} step={1} className="w-16" value={Number(camera.fov.toFixed(1))} onChange={(value) => { if (value !== null) changeFov(value); }} /></div></Field>
        <details className="border-t pt-3 text-xs" style={{ borderColor: "var(--director-sequencer-border)" }}><summary className="cursor-pointer opacity-65">镜头高级参数</summary>{children}</details>
    </div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return <label className="block"><span className="mb-1 block text-xs opacity-55">{label}</span>{children}</label>;
}

function AxisField({ label, value, onChange }: { label: string; value: DirectorVec3; onChange: (axis: number, value: number | null) => void }) {
    return <div><div className="mb-1 text-xs opacity-55">{label}</div><div className="grid grid-cols-3 gap-1">{value.map((entry, axis) => <div key={axis} className="flex min-w-0 items-center rounded-md bg-white/5"><span className="pl-2 text-[10px] opacity-45">{["X", "Y", "Z"][axis]}</span><InputNumber aria-label={`${label} ${["X", "Y", "Z"][axis]}`} size="small" variant="borderless" controls={false} className="min-w-0 flex-1" step={0.1} value={Number(entry.toFixed(2))} onChange={(next) => onChange(axis, next)} /></div>)}</div></div>;
}
