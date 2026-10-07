import { nanoid } from "nanoid";

import { requestEdit } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export const DIRECTOR_PANORAMA_PROMPT = "以参考图中的主体、材质和光影为基础，将环境扩展成完整的 360 度等距柱状全景图。输出 2:1 比例的连续单幅画面，左右边缘自然无缝衔接，保持真实空间尺度；不要拼贴、边框、文字、水印或拍摄设备。";

type DirectorPanoramaGenerationInput = { file: File; config: AiConfig; sceneId: string; signal?: AbortSignal };

/** 浏览器直连图生图接口；结果写入本地图片存储并加入「我的素材」，由历史记录选用。 */
export async function generateDirectorPanorama({ file, config, sceneId, signal }: DirectorPanoramaGenerationInput) {
    if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
    const model = config.imageModel || config.model;
    if (!model) throw new Error("请先在配置中选择可用的图片模型");
    const source = await uploadImage(file);
    const reference: ReferenceImage = { id: nanoid(), name: file.name, type: source.mimeType, dataUrl: source.url, storageKey: source.storageKey };
    const [result] = await requestEdit({ ...config, channelMode: "local", model, imageModel: model, count: "1" }, DIRECTOR_PANORAMA_PROMPT, [reference], { signal });
    if (!result?.dataUrl) throw new Error("图片接口没有返回全景图");
    const image = await uploadImage(result.dataUrl);
    const name = `AI 全景图 · ${file.name}`;
    const id = useAssetStore.getState().addAsset({ kind: "image", title: name, coverUrl: image.url, tags: ["全景图", "AI生成"], source: "导演台", data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType }, metadata: { source: "director-panorama-ai", sceneId } });
    return { id, name, url: image.url, storageKey: image.storageKey, width: image.width, height: image.height };
}
