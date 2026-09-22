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

// ── commands seam (audit F05-6) ────────────────────────────────────────────
// Commands are dispatched through their own registry and their result goes back
// to the caller directly. There are TWO KINDS and a caller must be able to tell
// them apart, because they end in different places:
//
//   - HANDLER commands execute an action; their text is shown to the USER and
//     never enters model history. That is the original F05-6 invariant and it
//     still holds for this kind.
//   - PROMPT commands expand into text that goes INTO the conversation, on the
//     host's authority — Anthropic's `commands/*.md` are prompts, not handlers.
//     Spec 2026-09-17 §3 decision 1: the host sends it as a user message.
//
// Before 2026-09-17 both kinds were the same value (a bare string), which is
// precisely why a Markdown prompt from a plugin could not be carried at all:
// "hand this text to the model" and "show this text to the user" were the same
// `string`, so no type could express the difference.

export interface Command {
  name: string
  /** Optional human-readable summary for discovery UIs (DSH CommandDefinition
   * parity — the web command palette lists it as the hint next to the name). */
  description?: string
  /** Optional hint of the expected argument form (DSH parity). */
  argumentHints?: string
  execute(input: string, ctx: PluginContext): Promise<string>
}

/** A command that expands into prompt text for the conversation. */
export interface PromptCommand {
  name: string
  description?: string
  argumentHints?: string
  expand(input: string, ctx: PluginContext): string
}

/** What invoking a command produced. The `kind` is the whole point: a caller
 * holding only a NAME (what `parseCommandLine` yields) cannot know which kind it
 * will get, so the VALUE decides what the caller does with it. */
export type CommandOutcome =
  | { kind: "reply"; text: string }
  | { kind: "prompt"; text: string }

// The one command-name grammar (DSH COMMAND_NAME rule): lowercase first, then
// letters/digits/underscore/dash. parseCommandLine parses the same alphabet,
// so a name that fails it could be registered and listed but never executed —
// fail loud at registration instead.
const COMMAND_NAME_SRC = "[a-z][a-z0-9_-]*"
const COMMAND_NAME_RE = new RegExp(`^${COMMAND_NAME_SRC}$`)

/** A registered command, tagged so the two kinds cannot be confused. */
type RegisteredCommand =
  | { kind: "handler"; command: Command }
  | { kind: "prompt"; command: PromptCommand }

function assertCommandName(name: string): void {
  if (!COMMAND_NAME_RE.test(name)) {
    throw new TypeError(`command name "${name}" must match ^${COMMAND_NAME_SRC}$`)
  }
}

// `services.get` throws when the registry is missing, so the try/catch lazily
// creates the registry on first registration.
function registryForRegistration(ctx: PluginContext): Map<string, RegisteredCommand> {
  let registry: Map<string, RegisteredCommand>
  try {
    registry = ctx.services.get<Map<string, RegisteredCommand>>("commands/registry")
  } catch {
    registry = new Map()
    ctx.services.register("commands/registry", registry)
  }
  return registry
}

export function registerCommand(ctx: PluginContext, cmd: Command): void {
  assertCommandName(cmd.name)
  registryForRegistration(ctx).set(cmd.name, { kind: "handler", command: cmd })
}

/** Register a prompt-expanded command. Same grammar and same registry as
 * `registerCommand` — one name is one entry, last registration wins. */
export function registerPromptCommand(ctx: PluginContext, cmd: PromptCommand): void {
  assertCommandName(cmd.name)
  registryForRegistration(ctx).set(cmd.name, { kind: "prompt", command: cmd })
}

export async function runCommand(ctx: PluginContext, name: string, input: string): Promise<CommandOutcome> {
  let registry: Map<string, RegisteredCommand>
  try {
    registry = ctx.services.get<Map<string, RegisteredCommand>>("commands/registry")
  } catch {
    throw new Error(`unknown command: ${name}`)
  }
  const entry = registry.get(name)
  if (!entry) throw new Error(`unknown command: ${name}`)
  return entry.kind === "handler"
    ? { kind: "reply", text: await entry.command.execute(input, ctx) }
    : { kind: "prompt", text: entry.command.expand(input, ctx) }
}

/**
 * Build a PromptCommand from a plugin command's Markdown body.
 *
 * The input is STRUCTURAL on purpose: `plugin-registry` parses `commands/*.md`
 * and must not depend on this package (nor this one on it), so the two agree on
 * a shape rather than on a type import.
 *
 * Substitution is `$ARGUMENTS` ONLY (spec 2026-09-17 §2.3). Positional `$1`/`$2`
 * need a quoting-and-escaping grammar; `!` command substitution and `@` file
 * references are execution/read surfaces with their own security decisions.
 * Each is deliberately not supported rather than half-supported.
 */
export function createPromptCommand(desc: {
  name: string
  description?: string
  argumentHints?: string
  body: string
}): PromptCommand {
  return {
    name: desc.name,
    ...(desc.description !== undefined ? { description: desc.description } : {}),
    ...(desc.argumentHints !== undefined ? { argumentHints: desc.argumentHints } : {}),
    expand: (input: string): string => desc.body.replaceAll("$ARGUMENTS", input),
  }
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
  let registry: Map<string, RegisteredCommand>
  try {
    registry = ctx.services.get<Map<string, RegisteredCommand>>("commands/registry")
  } catch {
    return []
  }
  return [...registry.values()]
    .map((entry) => ({
      name: entry.command.name,
      ...(entry.command.description !== undefined ? { description: entry.command.description } : {}),
      ...(entry.command.argumentHints !== undefined ? { argumentHints: entry.command.argumentHints } : {}),
    }))
    .sort((left, right) => (left.name < right.name ? -1 : 1))
}

/** Names of all currently registered commands, name-sorted. Empty → []. */
export function listCommandNames(ctx: PluginContext): string[] {
  let registry: Map<string, RegisteredCommand>
  try {
    registry = ctx.services.get<Map<string, RegisteredCommand>>("commands/registry")
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
