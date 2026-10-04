import { App, Button, Drawer, Empty, Image, Input, Segmented, Tooltip } from "antd";
import { Download, ImagePlus, RotateCcw, Trash2, Video, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";

import { ModelPicker } from "@/components/model-picker";
import { normalizeVideoResolutionValue, normalizeVideoSizeValue } from "@/components/video-settings-panel";
import { compileDirectorPrompt } from "@/lib/director/director-prompt-compiler";
import { requestEdit } from "@/services/api/image";
import { requestVideoGeneration, storeGeneratedVideo } from "@/services/api/video";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useDirectorStore, type DirectorOutput } from "@/stores/use-director-store";
import type { DirectorScene, DirectorShot } from "@/types/director";
import type { ReferenceImage } from "@/types/image";

type GenerateKind = "image" | "video";

/**
 * 导演台生成面板：以当前镜头构图截图为参考图，按编译后的提示词直连图片/视频接口。
 * 生成请求不依赖工作台存活，结果写入导演台 store，离开页面后回来仍可查看。
 */
export function DirectorGeneratePanel({ open, scene, shot, onClose, onCapture }: { open: boolean; scene: DirectorScene; shot: DirectorShot; onClose: () => void; onCapture: () => Promise<Blob> }) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const allOutputs = useDirectorStore((state) => state.outputs);
    const outputs = useMemo(() => allOutputs.filter((item) => item.sceneId === scene.id), [allOutputs, scene.id]);
    const [kind, setKind] = useState<GenerateKind>("image");
    const [prompt, setPrompt] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const promptShotRef = useRef<string | null>(null);

    // 每次打开或切换镜头时，用最新场景重新编译提示词；打开期间保留用户的手动修改。
    useEffect(() => {
        if (!open) {
            promptShotRef.current = null;
            return;
        }
        if (promptShotRef.current === shot.id) return;
        promptShotRef.current = shot.id;
        setPrompt(compileDirectorPrompt(scene, shot));
    }, [open, scene, shot]);

    const model = kind === "image" ? config.imageModel || config.model : config.videoModel || config.model;

    const submit = async () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请填写提示词");
            return;
        }
        if (!isAiConfigReady(config, model)) {
            message.warning(`请先配置${kind === "image" ? "图片" : "视频"}模型`);
            openConfigDialog(true);
            return;
        }
        setSubmitting(true);
        let reference: ReferenceImage;
        try {
            const beauty = await onCapture();
            const image = await uploadImage(beauty);
            reference = { id: nanoid(), name: `${shot.name}-构图.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
        } catch (error) {
            message.error(error instanceof Error ? error.message : "构图截图失败");
            setSubmitting(false);
            return;
        }
        setSubmitting(false);
        const requestConfig = kind === "image" ? imageConfig(config, model) : videoConfig(config, model, scene);
        void runGeneration({ kind, prompt: text, model, reference, config: requestConfig, sceneId: scene.id, shotId: shot.id, shotName: shot.name }).catch((error) => {
            message.error(error instanceof Error ? error.message : "生成失败");
        });
        message.success(kind === "image" ? "已开始生成图片" : "已提交视频任务，完成后会出现在列表中");
    };

    return (
        <Drawer title="生成" open={open} onClose={onClose} size={420} rootClassName="director-popup" destroyOnHidden={false}>
            <div className="flex h-full flex-col gap-3">
                <Segmented block value={kind} onChange={(value) => setKind(value as GenerateKind)} options={[{ label: "图片", value: "image", icon: <ImagePlus className="size-3.5" /> }, { label: "视频", value: "video", icon: <Video className="size-3.5" /> }]} />
                <ModelPicker config={config} value={model} capability={kind} fullWidth onChange={(value) => updateConfig(kind === "image" ? "imageModel" : "videoModel", value)} onMissingConfig={() => openConfigDialog(false)} />
                <div>
                    <div className="mb-1 flex items-center justify-between text-xs opacity-60">
                        <span>提示词（由场景自动编译，可修改）</span>
                        <Tooltip title="按当前场景重新编译">
                            <button type="button" aria-label="按当前场景重新编译" className="grid size-6 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10" onClick={() => setPrompt(compileDirectorPrompt(scene, shot))}><RotateCcw className="size-3.5" /></button>
                        </Tooltip>
                    </div>
                    <Input.TextArea value={prompt} autoSize={{ minRows: 5, maxRows: 10 }} onChange={(event) => setPrompt(event.target.value)} />
                </div>
                <p className="text-xs opacity-55">当前镜头「{shot.name}」的视口构图会作为参考图一起发送；尺寸、时长等参数沿用{kind === "image" ? "图片" : "视频"}页的设置。</p>
                <Button type="primary" icon={<Wand2 className="size-4" />} loading={submitting} onClick={() => void submit()}>生成{kind === "image" ? "图片" : "视频"}</Button>
                <div className="mt-2 text-sm font-medium">生成结果</div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4">
                    {outputs.length ? outputs.map((output) => <OutputCard key={output.id} output={output} />) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成结果" />}
                </div>
            </div>
        </Drawer>
    );
}

function OutputCard({ output }: { output: DirectorOutput }) {
    const removeOutput = useDirectorStore((state) => state.removeOutput);
    const [url, setUrl] = useState(output.url || "");
    const isImage = output.kind === "image";
    useEffect(() => {
        if (!output.storageKey) return;
        let active = true;
        void (isImage ? resolveImageUrl(output.storageKey, output.url) : resolveMediaUrl(output.storageKey, output.url)).then((resolved) => { if (active) setUrl(resolved); });
        return () => { active = false; };
    }, [isImage, output.storageKey, output.url]);
    const label = output.kind === "image" ? "图片" : output.kind === "video" ? "视频" : "白膜视频";
    const download = () => url && saveAs(url, `${output.shotName}-${label}.${isImage ? "png" : "mp4"}`);
    return (
        <div className="overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
            {output.status === "success" && url ? (isImage ? <Image src={url} alt={output.shotName} width="100%" className="object-contain" /> : <video src={url} controls className="block w-full" />) : <div className="grid aspect-video place-items-center px-3 text-center text-xs opacity-60">{output.status === "pending" ? "生成中…" : output.error || "生成失败"}</div>}
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate" title={output.prompt}>{output.shotName} · {label}{output.model ? ` · ${output.model}` : ""}</span>
                {output.status === "success" && url ? <button type="button" aria-label="下载" title="下载" className="grid size-6 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10" onClick={download}><Download className="size-3.5" /></button> : null}
                <button type="button" aria-label="删除" title="删除" className="grid size-6 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10" onClick={() => removeOutput(output.id)}><Trash2 className="size-3.5" /></button>
            </div>
        </div>
    );
}

/** 生成请求独立于面板生命周期运行，只通过 store 回写结果。 */
async function runGeneration(input: { kind: GenerateKind; prompt: string; model: string; reference: ReferenceImage; config: AiConfig; sceneId: string; shotId: string; shotName: string }) {
    const { addOutput, updateOutput } = useDirectorStore.getState();
    const id = addOutput({ sceneId: input.sceneId, shotId: input.shotId, shotName: input.shotName, kind: input.kind, status: "pending", prompt: input.prompt, model: input.model });
    try {
        if (input.kind === "image") {
            const [result] = await requestEdit(input.config, input.prompt, [input.reference]);
            if (!result?.dataUrl) throw new Error("图片接口没有返回结果");
            const image = await uploadImage(result.dataUrl);
            updateOutput(id, { status: "success", url: image.url, storageKey: image.storageKey, mimeType: image.mimeType, width: image.width, height: image.height });
            return;
        }
        const video = await storeGeneratedVideo(await requestVideoGeneration(input.config, input.prompt, [input.reference]));
        updateOutput(id, { status: "success", url: video.url, storageKey: video.storageKey, mimeType: video.mimeType, width: video.width, height: video.height });
    } catch (error) {
        updateOutput(id, { status: "failed", error: error instanceof Error ? error.message : "生成失败" });
        throw error;
    }
}

function imageConfig(config: AiConfig, model: string): AiConfig {
    return { ...config, channelMode: "local", model, imageModel: model, count: "1" };
}

/** 视频尺寸跟随场景画幅（自适应时沿用视频页设置），时长与清晰度沿用视频页设置。 */
function videoConfig(config: AiConfig, model: string, scene: DirectorScene): AiConfig {
    const ratio = scene.aspectRatio && scene.aspectRatio !== "adaptive" ? scene.aspectRatio : config.videoSize;
    return { ...config, channelMode: "local", model, videoModel: model, videoSize: normalizeVideoSizeValue(ratio), vquality: normalizeVideoResolutionValue(config.vquality) };
}
