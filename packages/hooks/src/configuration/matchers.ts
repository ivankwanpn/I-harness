import type { HandlerMatcher, HookEventName } from "../types.ts"
import { HookConfigError } from "../types.ts"
import type { LoadedHandler, HookRuntimeInput } from "../registry-types.ts"
import { claudeToolName } from "../claude.ts"

const TOOL_EVENTS = new Set<HookEventName>(["pre-tool", "post-tool", "permission"])

export function compileMatcher(matcher: HandlerMatcher | undefined): (name: string) => boolean {
  if (matcher === undefined) return () => true
  const exact = matcher.tool !== undefined
    ? (name: string): boolean => name === matcher.tool
    : undefined
  const regex = matcher.toolRegex !== undefined
    ? new RegExp(matcher.toolRegex, "i")
    : undefined
  if (exact === undefined && regex === undefined) throw new HookConfigError("handler matcher must define tool and/or toolRegex")
  return (name: string): boolean => (exact !== undefined ? exact(name) : regex!.test(name))
}

export function matches(handler: LoadedHandler, event: HookEventName, toolName?: string, input?: HookRuntimeInput): boolean {
  if (handler.spec.event !== event) return false
  const claude = handler.spec.claude
  if (claude !== undefined) {
    if (input?.nativeOnly || event === "prompt/submit" && input?.promptSubmission === false) return false
    const pattern = claude.matcher
    if (pattern === undefined || pattern === "" || pattern === "*") return true
    if (["UserPromptSubmit", "Stop"].includes(claude.event)) return true // Claude ignores matchers for these events.
    const subject = TOOL_EVENTS.has(event) && toolName !== undefined ? claudeToolName(toolName, input?.dialect) : input?.matchValue
    return subject !== undefined && new RegExp(pattern).test(subject)
  }
  if (input?.claudeOnly) return false
  if (!TOOL_EVENTS.has(event)) return true
  if (toolName === undefined) return true
  return compileMatcher(handler.spec.matcher)(toolName)
}
