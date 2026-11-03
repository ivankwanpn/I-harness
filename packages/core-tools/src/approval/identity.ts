import type { PluginContext } from "@i-harness/core-plugin"
import type { ApprovalAuthorityProvider, ApprovalRememberView, PreparedApprovalProvider, PreparedApprovalInput, ToolCall } from "../types.ts"
import { approvalArgumentsSummary } from "./arguments.ts"

type ApprovalAnswerer = (req: { name: string; reason: string; command?: string; pathSummary?: string; argumentsSummary?: string; remember?: ApprovalRememberView }) => Promise<boolean>

// Each preparation captures its own authority and remembered approval validation.
export function captureApproval(ctx: PluginContext, preparedApprovalInput: PreparedApprovalInput, call: ToolCall) {
  let authorityProvider: ApprovalAuthorityProvider | undefined
  try { authorityProvider = ctx.services.get<ApprovalAuthorityProvider>("approval/authority") } catch { /* optional host capability */ }
  // Capture before a guardian/human can await. This service neither creates
  // grant candidates nor changes the existing approval decision.
  const authorityValidation = authorityProvider?.(preparedApprovalInput)
  let approvalValidation: (() => boolean) | undefined
  const askHuman = async (reason: string): Promise<void> => {
    let preparedApproval: ReturnType<PreparedApprovalProvider> | undefined
    let provider: PreparedApprovalProvider | undefined
    try { provider = ctx.services.get<PreparedApprovalProvider>("approval/prepared") } catch { /* optional */ }
    if (provider) preparedApproval = provider(preparedApprovalInput)
    approvalValidation = preparedApproval?.validate
    if (preparedApproval?.remembered === true) return
    let answerer: ApprovalAnswerer | null = null
    try {
      answerer = ctx.services.get<ApprovalAnswerer>("approval/answerer")
    } catch {
      answerer = null
    }
    if (!answerer) {
      throw new Error(`approval required but no answerer registered (fail closed): ${reason}`)
    }
    const args = call.args !== null && typeof call.args === "object" && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {}
    const command = typeof args.command === "string" ? args.command : undefined
    const pathSummary = typeof args.path === "string" ? args.path : undefined
    const ok = await answerer({ name: call.name, reason,
      ...(command !== undefined ? { command: command.length > 4000 ? `${command.slice(0, 4000)}… [truncated]` : command } : {}),
      ...(pathSummary !== undefined ? { pathSummary: pathSummary.slice(0, 1000) } : {}),
      argumentsSummary: approvalArgumentsSummary(call.args),
      ...(preparedApproval !== undefined ? { remember: preparedApproval.remember } : {}),
    })
    if (!ok) throw new Error(`denied by user: ${reason}`)
  }
  return { authorityValidation, get approvalValidation() { return approvalValidation }, askHuman }
}
