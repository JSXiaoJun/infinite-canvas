import { useEffect, useState } from "react";
import { App, Button } from "antd";
import { Clapperboard, Plus, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { DirectorTemplateModal } from "@/pages/director/components/director-template-modal";
import { resolveImageUrl } from "@/services/image-storage";
import { useDirectorStore, type DirectorCover } from "@/stores/use-director-store";
import type { DirectorScene } from "@/types/director";
import "./director.css";

export default function DirectorPage() {
    const navigate = useNavigate();
    const hydrated = useDirectorStore((state) => state.hydrated);
    const scenes = useDirectorStore((state) => state.scenes);
    const createScene = useDirectorStore((state) => state.createScene);
    const [templateOpen, setTemplateOpen] = useState(false);

    return (
        <main className="director-root h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">3D 预演 · 分镜构图 · 生成参考</p>
                        <h1 className="mt-3 text-3xl font-semibold">导演台</h1>
                    </div>
                    <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={() => setTemplateOpen(true)}>
                        新建场景
                    </Button>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">正在加载场景…</section>
                ) : scenes.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {scenes.map((scene) => <SceneCard key={scene.id} scene={scene} />)}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <Clapperboard className="size-8 text-stone-400" />
                        <h2 className="mt-4 text-xl font-medium">还没有导演台场景</h2>
                        <p className="mt-3 max-w-md text-sm text-stone-500">在 3D 场景里摆放演员、道具、灯光和机位，设计镜头与运镜，再把构图作为参考生成图片或视频。</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={() => setTemplateOpen(true)}>
                            新建场景
                        </Button>
                    </section>
                )}
            </div>
            <DirectorTemplateModal open={templateOpen} onClose={() => setTemplateOpen(false)} onSelect={(templateId) => navigate(`/director/${createScene(templateId)}`)} />
        </main>
    );
}

function SceneCard({ scene }: { scene: DirectorScene }) {
    const { modal } = App.useApp();
    const navigate = useNavigate();
    const cover = useDirectorStore((state) => state.covers[scene.id]);
    const removeScene = useDirectorStore((state) => state.removeScene);
    const confirmRemove = () =>
        modal.confirm({
            title: "删除场景",
            content: `确定删除「${scene.title}」吗？场景、封面和生成结果都会一起删除，且无法恢复。`,
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => removeScene(scene.id),
        });

    return (
        <article className="group cursor-pointer overflow-hidden rounded-2xl bg-[#f1eee8] transition hover:bg-[#ebe6dc] dark:bg-white/5 dark:hover:bg-white/10" onClick={() => navigate(`/director/${scene.id}`)}>
            <SceneCover cover={cover} />
            <div className="flex items-end justify-between gap-3 p-4">
                <div className="min-w-0">
                    <h2 className="truncate text-lg font-semibold">{scene.title}</h2>
                    <p className="mt-1 text-xs text-stone-500">
                        {scene.shots.length} 个镜头 · {scene.objects.length} 个对象 · {new Date(scene.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </p>
                </div>
                <Button
                    type="text"
                    size="small"
                    shape="circle"
                    icon={<Trash2 className="size-4" />}
                    aria-label={`删除${scene.title}`}
                    onClick={(event) => {
                        event.stopPropagation();
                        confirmRemove();
                    }}
                />
            </div>
        </article>
    );
}

function SceneCover({ cover }: { cover?: DirectorCover }) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        if (!cover) return;
        let active = true;
        void resolveImageUrl(cover.storageKey, cover.url).then((resolved) => active && setUrl(resolved));
        return () => {
            active = false;
        };
    }, [cover]);
    return (
        <div className="grid aspect-video place-items-center">
            {cover && url ? <img src={url} alt="" className="size-full object-cover" /> : <Clapperboard className="size-8 text-stone-400" aria-hidden />}
        </div>
    );
}
