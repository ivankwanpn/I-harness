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
  /** Optional human-readable summary for discovery UIs (DSH CommandDefinition
   * parity — the web command palette lists it as the hint next to the name). */
  description?: string
  /** Optional hint of the expected argument form (DSH parity). */
  argumentHints?: string
  execute(input: string, ctx: PluginContext): Promise<string>
}

// The one command-name grammar (DSH COMMAND_NAME rule): lowercase first, then
// letters/digits/underscore/dash. parseCommandLine parses the same alphabet,
// so a name that fails it could be registered and listed but never executed —
// fail loud at registration instead.
const COMMAND_NAME_SRC = "[a-z][a-z0-9_-]*"
const COMMAND_NAME_RE = new RegExp(`^${COMMAND_NAME_SRC}$`)

// `services.get` throws when the registry is missing, so the try/catch lazily
// creates the registry on first registration.
export function registerCommand(ctx: PluginContext, cmd: Command): void {
  if (!COMMAND_NAME_RE.test(cmd.name)) {
    throw new TypeError(`command name "${cmd.name}" must match ^${COMMAND_NAME_SRC}$`)
  }
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

// ── M26-B14: ask_user_input 工具化 ──────────────────────────────────────────
import type { Tool } from "@i-harness/core-tools"

export interface AskUserInputToolDeps {
  /** 注入 seam（測試）；缺省 → ctx 版 askUser（無 provider 同步 NO_PROVIDER throw）。 */
  ask?: (q: UserQuestion) => Promise<string>
  /** 宣告給 guard-timeout 的 deadline；缺省 600_000（宿主題面 10 分未答 → TOOL_TIMEOUT 替換）。 */
  timeoutMs?: number
}

// B14：模型主動問使用者（codex request_user_input 吸收）。同 operator 只有一人——非並行安全。
// 回答不會進 session log 以外的新地方：答案作為 tool result 回傳（模型可看到）。
export function createAskUserInputTool(deps?: AskUserInputToolDeps): Tool {
  return {
    name: "ask_user_input",
    description:
      "Ask the human user a structured question and wait for their answer. Use this for decisions that need the user's preference (not for approvals — approvals use the approval flow).",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask (should be self-contained)." },
        options: { type: "array", items: { type: "string" }, maxItems: 10, description: "Suggested answers (the user may still answer freely)." },
      },
      required: ["question"],
    },
    timeoutMs: deps?.timeoutMs ?? 600_000,
    execute: async (args: { question: string; options?: string[] }) => {
      const ask = deps?.ask
      if (!ask) throw new Error("no user-questions provider is registered (NO_PROVIDER)") // 同步失敗 -> fail-closed
      const answer = await ask({
        id: `aiu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: args.question,
        ...(args.options !== undefined ? { options: args.options } : {}),
      })
      return { question: args.question, answer }
    },
  }
}

export function registerAskUserInput(ctx: PluginContext, registry: { register(t: Tool): void }): void {
  registry.register(createAskUserInputTool({ ask: (q) => askUser(ctx, q) }))
}

// ── C-region: command discovery + line parsing (DSH commands.{list,execute} Web 化) ──

/** Description of one command for discovery (never the handler or its input). */
export interface CommandDescriptor {
  name: string
  description?: string
  argumentHints?: string
}

/**
 * List the currently registered commands' descriptors (name + optional
 * description / argumentHints — never the handler), name-sorted. An empty
 * registry is a legal state and lists [] (unlike runCommand, whose
 * unknown-command case is fail-loud).
 */
export function listCommands(ctx: PluginContext): CommandDescriptor[] {
  let registry: Map<string, Command>
  try {
    registry = ctx.services.get<Map<string, Command>>("commands/registry")
  } catch {
    return []
  }
  return [...registry.values()]
    .map((cmd) => ({
      name: cmd.name,
      ...(cmd.description !== undefined ? { description: cmd.description } : {}),
      ...(cmd.argumentHints !== undefined ? { argumentHints: cmd.argumentHints } : {}),
    }))
    .sort((left, right) => (left.name < right.name ? -1 : 1))
}

/** Names of all currently registered commands, name-sorted. Empty → []. */
export function listCommandNames(ctx: PluginContext): string[] {
  let registry: Map<string, Command>
  try {
    registry = ctx.services.get<Map<string, Command>>("commands/registry")
  } catch {
    return []
  }
  return [...registry.keys()].sort()
}

// Syntax of a command line (DSH simplified): an optional leading slash, a
// lowercase name — the SAME grammar registerCommand rejects against, so a
// registered command can always be dispatched — then everything after the
// first whitespace run as the handler input. The optional slash serves the
// web palette (click-to-run "theme dark" vs typing "/theme dark").
const COMMAND_LINE_RE = new RegExp(`^[ \\t]*\\/?(${COMMAND_NAME_SRC})(?:[ \\t]+(.*))?$`)

/** One parsed command line. */
export interface ParsedCommandLine {
  /** Lowercase command name without the leading slash. */
  name: string
  /** Exact text after the command name, trimmed (the handler owns the grammar). */
  input: string
}

/**
 * Parse a candidate command line ("/theme dark" or "theme dark") into its
 * name + input pair. Undefined when the line is blank or its first token is
 * not a lowercase command name.
 */
export function parseCommandLine(line: string): ParsedCommandLine | undefined {
  const match = COMMAND_LINE_RE.exec(line)
  if (match === null) return undefined
  const name = match[1]
  if (name === undefined) return undefined
  return { name, input: (match[2] ?? "").trim() }
}
