// 需要“先上传 R2、再用在线 URL 发 JSON”的图片模型。
// 只有这里列出的模型会走该分支；其他模型保持原来的 multipart /images/edits。
// 不提供界面开关，新增模型时直接改这个列表即可。
const REFERENCE_URL_MODELS = new Set(["seedream-5-pro", "seedream-5-lite"]);

export function requiresReferenceUrls(model: string) {
    return REFERENCE_URL_MODELS.has(model.trim().toLowerCase());
}
