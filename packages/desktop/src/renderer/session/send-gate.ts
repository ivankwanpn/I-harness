import type { SessionModelState } from "@i-harness/sdk"
import type { SandboxState } from "../../main/sdk-runtime.ts"
import type { Message } from "../design/i18n.ts"

/**
 * Send is allowed only when the host reported a wired sandbox AND a ready
 * model. Both are host claims; the UI never assumes either.
 */
export function sendGate(input: {
  model: SessionModelState | undefined
  sandbox: SandboxState | undefined
  connection: "online" | "offline" | "connecting" | "reconnecting"
}, t: (message: Message) => string = (message) => message): { canSend: boolean; reason?: string } {
  if (input.connection === "connecting" || input.connection === "reconnecting") return { canSend: false, reason: t("正在連線，送出暫時停用") }
  if (input.connection === "offline") {
    return { canSend: false, reason: t("SDK 連線已中斷，送出已停用") }
  }
  if (input.sandbox?.wired !== true) {
    return { canSend: false, reason: t("沙箱尚未接線：宿主未回報可執行模式，送出已停用") }
  }
  if (input.model === undefined) return { canSend: false, reason: t("模型狀態未知，送出已停用") }
  if (input.model.status !== "ready") return { canSend: false, reason: input.model.reason }
  return { canSend: true }
}
