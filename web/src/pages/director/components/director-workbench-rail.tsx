import { Boxes, Camera, GalleryHorizontal, Layers3, RectangleHorizontal, UserRound } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export type DirectorWorkbenchTab = "scene" | "actors" | "cameras" | "panorama" | "aspect" | "assets";

const tabs = [
    { id: "scene", label: "场景", icon: Layers3 },
    { id: "actors", label: "添加角色", icon: UserRound },
    { id: "cameras", label: "添加机位", icon: Camera },
    { id: "panorama", label: "全景图", icon: GalleryHorizontal },
    { id: "aspect", label: "选择画幅比例", icon: RectangleHorizontal },
    { id: "assets", label: "素材", icon: Boxes },
] as const;

export function DirectorWorkbenchRail({ active, onChange }: { active: DirectorWorkbenchTab; onChange: (tab: DirectorWorkbenchTab) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <nav aria-label="导演台工作区" className="flex w-12 shrink-0 flex-col items-center gap-2 border-r px-1.5 py-3" style={{ borderColor: theme.toolbar.border }}>
            {tabs.map(({ id, label, icon: Icon }) => (
                <button
                    key={id}
                    type="button"
                    aria-label={label}
                    aria-pressed={active === id}
                    title={label}
                    onClick={() => onChange(id)}
                    className="flex size-9 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2"
                    style={{ background: active === id ? theme.toolbar.itemHover : "transparent", color: active === id ? theme.node.text : theme.node.muted }}
                >
                    <Icon className="size-4" aria-hidden />
                </button>
            ))}
        </nav>
    );
}
