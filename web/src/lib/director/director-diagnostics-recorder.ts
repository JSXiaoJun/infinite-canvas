import { formatDirectorDiagnosticCode, projectDirectorDiagnostic, type DirectorDiagnosticCode, type DirectorDiagnosticFields } from "@/lib/director/director-diagnostics";

/**
 * 导演台故障事件的唯一记录入口。
 * 项目没有诊断上报服务，只写浏览器控制台；只输出固定 message 与安全 code/字段。
 */

/** 去重窗口：同一 code+字段组合在窗口内只记一次，避免高频路径刷屏。 */
const DEDUPE_WINDOW_MS = 1500;
const lastSeen = new Map<string, number>();

export function recordDirectorDiagnostic(code: DirectorDiagnosticCode, fields: DirectorDiagnosticFields = {}): boolean {
    const event = projectDirectorDiagnostic(code, fields);
    if (!event) return false;
    const signature = formatDirectorDiagnosticCode(event);
    const timestamp = performance.now();
    const previous = lastSeen.get(signature);
    if (previous !== undefined && timestamp - previous < DEDUPE_WINDOW_MS) return false;
    lastSeen.set(signature, timestamp);
    const log = event.level === "error" ? console.error : event.level === "warning" ? console.warn : console.info;
    log(`[director] ${signature}`, event.message);
    return true;
}
