import { Tooltip } from "antd";
import { Dropdown } from "antd";

import { Bone, Box, Camera, Clapperboard, Compass, Crosshair, Layers, Lightbulb, LoaderCircle, Move3D, Palette, Rotate3D, Scaling, UserRound } from "lucide-react";
import type { ReactNode } from "react";

import { releaseDirectorFocusAfterPointer } from "@/lib/director/director-shortcuts";
import type { DirectorRenderMode } from "@/types/director";

type DirectorViewportDockProps = {
    transformMode: "translate" | "rotate" | "scale";
    renderMode: DirectorRenderMode;
    /** 当前模式允许的渲染视图。dock 只展示这些，避免成为绕过模式门控的第二条路径。 */
    renderModes: DirectorRenderMode[];
    onTransformModeChange: (mode: DirectorViewportDockProps["transformMode"]) => void;
    onRenderModeChange: (mode: DirectorRenderMode) => void;
    onAddActor: () => void;
    onAddBox: () => void;
    onAddLight: () => void;
    onAddCamera: () => void;
    onAlignCamera: () => void;
    timelineOpen: boolean;
    onToggleTimeline: () => void;
    captureBusy: boolean;
    captureReady: boolean;
    onCapture: () => void;
};

/** 渲染视图按钮的展示顺序与图标。实际可见项由 renderModes 过滤。 */
const RENDER_VIEW_BUTTONS: Array<{ mode: DirectorRenderMode; label: string; icon: ReactNode }> = [
    { mode: "beauty", label: "构图预览", icon: <Camera /> },
    { mode: "clay", label: "彩色白膜", icon: <Palette /> },
    { mode: "pose", label: "骨骼视图", icon: <Bone /> },
    { mode: "depth", label: "深度视图", icon: <Layers /> },
    { mode: "normal", label: "法线视图", icon: <Compass /> },
];

const TRANSFORM_BUTTONS = [
    { mode: "translate", label: "移动", shortcut: "V", icon: <Move3D /> },
    { mode: "rotate", label: "旋转", shortcut: "R", icon: <Rotate3D /> },
    { mode: "scale", label: "缩放", shortcut: "F", icon: <Scaling /> },
] as const;

export function DirectorViewportDock({ transformMode, renderMode, renderModes, onTransformModeChange, onRenderModeChange, onAddActor, onAddBox, onAddLight, onAddCamera, onAlignCamera, timelineOpen, onToggleTimeline, captureBusy, captureReady, onCapture }: DirectorViewportDockProps) {
    const activeTransform = TRANSFORM_BUTTONS.find((item) => item.mode === transformMode) ?? TRANSFORM_BUTTONS[0];
    return (
        <nav className="director-viewport-dock" aria-label="导演台视口工具">
            <Dropdown
                trigger={["click"]}
                placement="topLeft"
                menu={{
                    selectable: true,
                    selectedKeys: [transformMode],
                    items: TRANSFORM_BUTTONS.map((item) => ({
                        key: item.mode,
                        icon: item.icon,
                        label: <span className="flex min-w-24 items-center justify-between gap-5"><span>{item.label}</span><span className="text-xs opacity-60">{item.shortcut}</span></span>,
                        onClick: ({ domEvent }) => {
                            onTransformModeChange(item.mode);
                            releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement });
                        },
                    })),
                }}
            >
                <button type="button" className="director-viewport-dock-button is-active" aria-label={activeTransform.label} aria-haspopup="menu" title={`${activeTransform.label} (${activeTransform.shortcut})`}>
                    {activeTransform.icon}
                </button>
            </Dropdown>
            <button type="button" className="director-viewport-dock-button disabled:opacity-40" aria-label="截图" disabled={captureBusy || !captureReady} title={captureBusy ? "正在保存截图" : captureReady ? "截图" : "视口加载中"} onClick={(event) => { onCapture(); releaseDirectorFocusAfterPointer(event); }}>{captureBusy ? <LoaderCircle className="animate-spin" /> : <Camera />}</button>
            <button type="button" className={`director-viewport-dock-button ${timelineOpen ? "is-active" : ""}`} aria-label="动画时间轴" aria-pressed={timelineOpen} onClick={(event) => { onToggleTimeline(); releaseDirectorFocusAfterPointer(event); }}><Clapperboard /></button>
            <DockDivider />
            <DockButton label="添加演员" onClick={onAddActor}><UserRound /></DockButton>
            <DockButton label="添加立方体" onClick={onAddBox}><Box /></DockButton>
            <DockButton label="添加灯光" onClick={onAddLight}><Lightbulb /></DockButton>
            <DockButton label="添加摄影机" onClick={onAddCamera}><Camera /></DockButton>
            <DockButton label="摄影机对齐当前视图" onClick={onAlignCamera}><Crosshair /></DockButton>
            <DockDivider />
            {RENDER_VIEW_BUTTONS.filter((item) => renderModes.includes(item.mode)).map((item) => (
                <DockButton key={item.mode} label={item.label} active={renderMode === item.mode} onClick={() => onRenderModeChange(item.mode)}>{item.icon}</DockButton>
            ))}
        </nav>
    );
}

/**
 * Dock 按钮。
 *
 * 鼠标点完后释放焦点：这个 dock 承载 V/R/F 变换工具，焦点留在按钮上会让
 * 交互控件守卫吃掉这三个键。规则集中在 releaseDirectorFocusAfterPointer。
 */
function DockButton({ label, active, children, onClick }: { label: string; active?: boolean; children: ReactNode; onClick: () => void }) {
    return (
        <Tooltip title={label} placement="top">
            <button
                type="button"
                className={`director-viewport-dock-button ${active ? "is-active" : ""}`}
                aria-label={label}
                aria-pressed={active}
                onClick={(event) => {
                    onClick();
                    releaseDirectorFocusAfterPointer(event);
                }}
            >
                {children}
            </button>
        </Tooltip>
    );
}

function DockDivider() {
    return <span className="director-viewport-dock-divider" aria-hidden />;
}
