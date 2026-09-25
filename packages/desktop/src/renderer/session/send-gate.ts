import type { SessionModelState } from "@i-harness/sdk"
import type { SandboxState } from "../../main/sdk-runtime.ts"

/**
 * Send is allowed only when the host reported a wired sandbox AND a ready
 * model. Both are host claims; the UI never assumes either.
 */
export function sendGate(input: {
  model: SessionModelState | undefined
  sandbox: SandboxState | undefined
}): { canSend: boolean; reason?: string } {
  if (input.sandbox?.wired !== true) {
    return { canSend: false, reason: "沙箱尚未接線：宿主未回報可執行模式，送出已停用" }
  }
  if (input.model === undefined) return { canSend: false, reason: "模型狀態未知，送出已停用" }
  if (input.model.status !== "ready") return { canSend: false, reason: input.model.reason }
  return { canSend: true }
}
