import { onExecutionEvent, type PluginContext } from "@i-harness/core-plugin"
import { committedFactSeqs } from "@i-harness/core-session"
import { isManagedExecutionDomain, type ManagedExecutionDomain } from "@i-harness/core-session/internal/execution"
import { scanMentionedSkillNames, SKILL_MENTION_PLUGIN, type SkillRegistry } from "@i-harness/skills"
import { isManagedExecutionAttachment, type ManagedExecutionAttachment } from "../../session-persistence/src/execution-internal.ts"
import { actionFeedbackFacts } from "./lifecycle/action-facts.ts"

/** Attach the original skill feedback producer to one managed execution domain. */
export function mountOwnedSkillMentions(options: { ctx: PluginContext; execution: ManagedExecutionAttachment; domain: ManagedExecutionDomain; registry: SkillRegistry }) {
  const { ctx, execution, domain, registry } = options
  if (!isManagedExecutionAttachment(execution) || !isManagedExecutionDomain(domain, ctx) || domain.identity !== execution.identity || domain.owner !== execution.owner) throw new TypeError("Original managed execution domain required")
  let lastMentionTask: string | undefined, closed = false, closeFlight: Promise<void> | undefined
  const pending = new Set<Promise<void>>()
  onExecutionEvent(ctx, "agent/pre-step", payload => {
    if (closed) return
    const input = payload as { task?: unknown; domain?: unknown; signal?: AbortSignal }
    if (input.domain !== domain) return
    domain.assertCurrent()
    if (typeof input.task !== "string" || input.task === lastMentionTask) return
    const task = input.task, names = scanMentionedSkillNames(task, registry)
    if (!names.length) return
    const work = (async () => {
      committedFactSeqs(await actionFeedbackFacts(execution.owner, input.signal).feedback({ type: "user/message", text: `[skill mention] Load the ${names.map(name => `"${name}"`).join(", ")} skill(s) with skill_get before proceeding.`, source: { kind: "plugin", plugin: SKILL_MENTION_PLUGIN }, internal: true }))
      domain.assertCurrent()
      lastMentionTask = task
    })()
    pending.add(work)
    void work.then(() => pending.delete(work), () => pending.delete(work))
    return work
  })
  return { close(): Promise<void> {
    if (closeFlight) return closeFlight
    closed = true
    closeFlight = Promise.allSettled([...pending]).then(() => undefined)
    return closeFlight
  } }
}
