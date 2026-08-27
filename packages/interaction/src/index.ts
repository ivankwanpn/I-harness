import type { PluginContext } from "@i-harness/core-plugin"

// ── approval seam (audit F05-5) ────────────────────────────────────────────

export interface ApprovalRequest {
  name: string
  reason: string
  // M22: echo-consent 承載（全 optional——向後相容）
  command?: string
  argv?: string[]
  dangerClass?: "extreme" | "dangerous" | "none"
  pathSummary?: string
}

export interface ApprovalDecision {
  approved: boolean
}

export type ApprovalAnswerer = (req: ApprovalRequest) => Promise<ApprovalDecision>

// The seam contract between interaction and core-tools is a boolean-returning
// answerer (audit F05-5, fail-closed): core-tools checks `if (!ok) throw`.
// Normalize AT the service boundary so a host implementing the richer
// `{ approved }` decision shape can never accidentally fail-open by returning
// a truthy object (a user denial would be ignored and the tool would execute).
export function registerApprovalAnswerer(ctx: PluginContext, fn: ApprovalAnswerer): void {
  ctx.services.register("approval/answerer", async (req: ApprovalRequest) => (await fn(req)).approved)
}

// ── questions seam (audit F05-5) ───────────────────────────────────────────

export interface UserQuestion {
  id: string
  prompt: string
  options?: string[]
}

export interface QuestionProvider {
  ask(q: UserQuestion): Promise<string>
}

export function registerQuestionProvider(ctx: PluginContext, provider: QuestionProvider): void {
  ctx.services.register("questions/provider", provider)
}

// Not async on purpose: a missing provider must throw synchronously so callers
// that guard the call (fail-closed, audit F05-5) see the error without awaiting.
// The registered provider's `ask` still returns a Promise.
export function askUser(ctx: PluginContext, q: UserQuestion): Promise<string> {
  let provider: QuestionProvider
  try {
    provider = ctx.services.get<QuestionProvider>("questions/provider")
  } catch {
    throw new Error("no user-questions provider is registered (NO_PROVIDER)")
  }
  return provider.ask(q)
}

// ── commands seam (audit F05-6: results never enter model history) ─────────
// Commands are UI-plane operations. They are dispatched through their own
// registry and their results are returned to the caller directly; they never
// feed the model's message history.

export interface Command {
  name: string
  execute(input: string, ctx: PluginContext): Promise<string>
}

// `services.get` throws when the registry is missing, so the try/catch lazily
// creates the registry on first registration.
export function registerCommand(ctx: PluginContext, cmd: Command): void {
  let registry: Map<string, Command>
  try {
    registry = ctx.services.get<Map<string, Command>>("commands/registry")
  } catch {
    registry = new Map()
    ctx.services.register("commands/registry", registry)
  }
  registry.set(cmd.name, cmd)
}

export async function runCommand(ctx: PluginContext, name: string, input: string): Promise<string> {
  let registry: Map<string, Command>
  try {
    registry = ctx.services.get<Map<string, Command>>("commands/registry")
  } catch {
    throw new Error(`unknown command: ${name}`)
  }
  const cmd = registry.get(name)
  if (!cmd) throw new Error(`unknown command: ${name}`)
  return cmd.execute(input, ctx)
}
