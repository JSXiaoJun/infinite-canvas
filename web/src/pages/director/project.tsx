import { Button } from "antd";
import { useNavigate, useParams } from "react-router-dom";

import { DirectorWorkbench } from "@/pages/director/components/director-workbench";
import { useDirectorStore } from "@/stores/use-director-store";
import "./director.css";

export default function DirectorProjectPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    const hydrated = useDirectorStore((state) => state.hydrated);
    const scene = useDirectorStore((state) => state.scenes.find((item) => item.id === id) || null);
    const saveScene = useDirectorStore((state) => state.saveScene);

    if (!hydrated) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">正在加载场景…</main>;
    if (!scene)
        return (
            <main className="flex h-full flex-col items-center justify-center gap-4 bg-background text-sm text-stone-500">
                <p>场景不存在或已被删除</p>
                <Button onClick={() => navigate("/director")}>返回导演台</Button>
            </main>
        );

    return <DirectorWorkbench open scene={scene} onboardingScope="local" onChange={saveScene} onClose={() => navigate("/director")} />;
}
