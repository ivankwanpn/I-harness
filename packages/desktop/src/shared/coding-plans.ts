/** Public Coding Plans IPC contract. Never contains OAuth tokens or authorization URLs. */
export interface CodingPlanAccount {
  id: string
  provider: "openai-codex"
  email?: string
  label?: string
  status: "connected" | "identity-only" | "reauth-required"
  models: { id: string; name: string }[]
  updatedAt?: number
}
export interface CodingPlansState {
  accounts: CodingPlanAccount[]
  login?: { status: "pending" | "failed"; message?: string }
  welcomePending: boolean
  message?: string
  openaiManagement?: OpenAiManagementState
}
export interface OpenAiManagementState {
  status: "disconnected" | "pending" | "connected" | "reauth-required"
  accountId?: string
  email?: string
  plan?: string
  login?: { userCode: string; verificationUrl: string }
  availableCount?: number
  creditBalance?: { balance?: string; unlimited?: boolean; hasCredits?: boolean }
  usageUpdatedAt?: number
  credits?: { id: string; status: string; resetType: string; title?: string; expiresAt?: number }[]
  windows?: { name: string; usedPercent: number; resetsAt?: number; limitSeconds?: number; scopeName?: string }[]
  pendingRedemption?: { requestId: string; creditId: string }
  outcome?: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed" | "unknown"
  message?: string
  models?: { id: string; name: string; inputModalities?: ("text" | "image")[]; contextWindow?: number }[]
}
export type CodingPlansRequest =
  | { kind: "desktop/coding-plans/state" | "desktop/coding-plans/cancel" | "desktop/coding-plans/welcome-dismiss" }
  | { kind: "desktop/coding-plans/start"; accountId?: string }
  | { kind: "desktop/coding-plans/refresh" | "desktop/coding-plans/signout"; accountId: string }
  | { kind: "desktop/coding-plans/management-refresh" }
  | { kind: "desktop/coding-plans/reset-credit"; accountId: string; creditId: string; confirmed: true }
