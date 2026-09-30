import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import { localForageStorage } from "@/lib/localforage-storage";
import { createDirectorSceneFromTemplate, type DirectorTemplateId } from "@/lib/director/director-templates";
import { useAssetStore } from "@/stores/use-asset-store";
import type { DirectorScene } from "@/types/director";

export type DirectorCover = { url: string; storageKey: string; sceneUpdatedAt: string };

/** 导演台生成记录。图片走 image-storage，视频/白膜走 file-storage，都只保存 storageKey 引用。 */
export type DirectorOutput = {
    id: string;
    sceneId: string;
    shotId: string;
    shotName: string;
    kind: "image" | "video" | "clay";
    status: "pending" | "success" | "failed";
    prompt: string;
    model?: string;
    url?: string;
    storageKey?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    error?: string;
    createdAt: string;
};

export type DirectorModelAsset = { id: string; title: string; url: string; storageKey: string; bytes: number; mimeType: string; fileName: string; createdAt: string };

type DirectorStore = {
    hydrated: boolean;
    scenes: DirectorScene[];
    covers: Record<string, DirectorCover>;
    outputs: DirectorOutput[];
    models: DirectorModelAsset[];
    createScene: (templateId: DirectorTemplateId) => string;
    saveScene: (scene: DirectorScene) => void;
    removeScene: (id: string) => void;
    setCover: (sceneId: string, cover: DirectorCover) => void;
    addOutput: (output: Omit<DirectorOutput, "id" | "createdAt">) => string;
    updateOutput: (id: string, patch: Partial<DirectorOutput>) => void;
    removeOutput: (id: string) => void;
    addModel: (model: Omit<DirectorModelAsset, "id" | "createdAt">) => DirectorModelAsset;
    removeModel: (id: string) => void;
};

/** 删除引用后交给统一的存储清理，它会扫描素材、画布与导演台数据。 */
const cleanupStorage = () => useAssetStore.getState().cleanupImages();

export const useDirectorStore = create<DirectorStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            scenes: [],
            covers: {},
            outputs: [],
            models: [],
            createScene: (templateId) => {
                const scene = createDirectorSceneFromTemplate(templateId, `场景 ${get().scenes.length + 1}`);
                set((state) => ({ scenes: [scene, ...state.scenes] }));
                return scene.id;
            },
            saveScene: (scene) => set((state) => ({ scenes: state.scenes.map((item) => (item.id === scene.id ? scene : item)) })),
            removeScene: (id) => {
                set((state) => {
                    const covers = { ...state.covers };
                    delete covers[id];
                    return { scenes: state.scenes.filter((item) => item.id !== id), covers, outputs: state.outputs.filter((item) => item.sceneId !== id) };
                });
                cleanupStorage();
            },
            setCover: (sceneId, cover) => set((state) => ({ covers: { ...state.covers, [sceneId]: cover } })),
            addOutput: (output) => {
                const id = nanoid();
                set((state) => ({ outputs: [{ ...output, id, createdAt: new Date().toISOString() }, ...state.outputs] }));
                return id;
            },
            updateOutput: (id, patch) => set((state) => ({ outputs: state.outputs.map((item) => (item.id === id ? { ...item, ...patch } : item)) })),
            removeOutput: (id) => {
                set((state) => ({ outputs: state.outputs.filter((item) => item.id !== id) }));
                cleanupStorage();
            },
            addModel: (model) => {
                const next = { ...model, id: nanoid(), createdAt: new Date().toISOString() };
                set((state) => ({ models: [next, ...state.models] }));
                return next;
            },
            removeModel: (id) => {
                set((state) => ({ models: state.models.filter((item) => item.id !== id) }));
                cleanupStorage();
            },
        }),
        {
            name: "infinite-canvas:director_store",
            storage: createJSONStorage(() => localForageStorage),
            partialize: ({ scenes, covers, outputs, models }) => ({ scenes, covers, outputs, models }),
            onRehydrateStorage: () => (state) => {
                // 生成请求不跨页面刷新续跑，残留的 pending 记录标记为已中断。
                const outputs = (state?.outputs || []).map((item) => (item.status === "pending" ? { ...item, status: "failed" as const, error: "页面刷新，生成已中断" } : item));
                useDirectorStore.setState({ hydrated: true, outputs });
            },
        },
    ),
);
