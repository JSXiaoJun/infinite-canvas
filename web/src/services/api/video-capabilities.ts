import { modelCapabilityOf, modelOptionName, resolveModelChannel, type AiConfig, type VideoModelCapabilitiesCache, type VideoModelCapabilityConfig } from "@/stores/use-config-store";

type CapabilityResponse = {
    data?: Array<{
        id?: unknown;
        capabilities?: {
            durations?: unknown;
            resolutions?: unknown;
        };
    }>;
};

const YYAPI_CAPABILITY_URL = import.meta.env.DEV ? "/__yyapi/model-capabilities" : "https://media.yyapi.cloud/v1/model-capabilities";

export function videoCapabilityRequest(config: AiConfig, model: string | undefined) {
    const value = model || config.videoModel || config.model;
    const selectedModel = modelOptionName(value).trim();
    const channel = resolveModelChannel(config, value);
    return {
        enabled: isYyapiBaseUrl(channel.baseUrl) && modelCapabilityOf(config, value) === "video" && Boolean(selectedModel),
        model: selectedModel,
    };
}

export function getVideoModelCapabilities(config: AiConfig, model: string | undefined) {
    const request = videoCapabilityRequest(config, model);
    if (!request.enabled) return null;
    const capabilities = config.yyapiVideoCapabilities || {};
    return capabilities[request.model] || Object.entries(capabilities).find(([id]) => id.toLowerCase() === request.model.toLowerCase())?.[1] || null;
}

export async function fetchYyapiVideoCapabilities() {
    const response = await fetch(YYAPI_CAPABILITY_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
    });
    if (!response.ok) throw new Error(`Capability request failed (${response.status})`);
    return normalizeCapabilityResponse((await response.json()) as CapabilityResponse);
}

export function constrainVideoConfig(config: AiConfig, capabilities: VideoModelCapabilityConfig | null) {
    if (!capabilities) return config;
    const duration = Math.floor(Number(config.videoSeconds));
    const currentResolution = normalizeResolutionKey(config.vquality);
    const supportedResolution = capabilities.resolutions.find((value) => normalizeResolutionKey(value) === currentResolution);
    return {
        ...config,
        videoSeconds: capabilities.durations.length && !capabilities.durations.includes(duration) ? String(capabilities.durations[0]) : config.videoSeconds,
        vquality: capabilities.resolutions.length && !supportedResolution ? capabilities.resolutions[0] : config.vquality,
    };
}

export function isYyapiBaseUrl(baseUrl: string) {
    try {
        const hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
        return hostname === "yyapi.cloud" || hostname.endsWith(".yyapi.cloud");
    } catch {
        return false;
    }
}

function normalizeCapabilityResponse(payload: CapabilityResponse) {
    const models: VideoModelCapabilitiesCache = {};
    for (const item of payload.data || []) {
        const id = typeof item.id === "string" ? item.id.trim() : "";
        if (!id) continue;
        const durations = Array.isArray(item.capabilities?.durations)
            ? Array.from(new Set(item.capabilities.durations.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 60))).sort((a, b) => a - b)
            : [];
        const resolutions = Array.isArray(item.capabilities?.resolutions)
            ? Array.from(new Set(item.capabilities.resolutions.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim())))
            : [];
        models[id] = { durations, resolutions };
    }
    return models;
}

function normalizeResolutionKey(value: string) {
    const normalized = value.trim().toLowerCase();
    if (["auto", "high", "medium"].includes(normalized)) return "720";
    if (normalized === "low") return "480";
    return normalized.replace(/p$/, "");
}
