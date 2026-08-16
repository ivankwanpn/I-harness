import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append, deriveMessages } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient, LLMRequest } from "@i-harness/llm-seam"
import { assertMessagesFromLog } from "@i-harness/llm-seam"

export interface AgentConfig {
  systemPrompt: string
  // NOTE: `model?: string` from the task brief collides with `AgentDeps.model`
  // (the ModelClient) under `AgentDeps & AgentConfig`, so the string selector
  // is dropped for M1 — the ModelClient IS the model configuration and the
  // `model` field of `LLMRequest` is not populated by the loop.
}

export interface AgentDeps {
  session: Session
  tools: ToolRegistry
  model: ModelClient
}

export interface AgentResult {
  finalText: string
  turns: number
}

export function createAgent(ctx: PluginContext, deps: AgentDeps & AgentConfig) {
  return {
    async run(task: string): Promise<AgentResult> {
      let turns = 0

      append(deps.session, { type: "turn/start" })
      append(deps.session, { type: "user/message", text: task })

      let needsContinuation = true
      while (needsContinuation) {
        turns += 1
        append(deps.session, { type: "step/start" })

        await ctx.emit("agent/pre-step", { task, session: deps.session })

        const messages = deriveMessages(deps.session)
        // Invariant at the seam (audit F01-3): the model may only ever see
        // messages that come from the session log. This passes trivially here
        // because the loop derives-and-rechecks from the log, but it is the
        // discipline point that keeps external producers honest.
        assertMessagesFromLog(messages, deps.session)

        const request: LLMRequest = {
          messages,
          tools: deps.tools.schemas(),
          systemPrompt: deps.systemPrompt,
        }

        let stepText = ""
        let toolCallsThisStep = 0
        for await (const ev of deps.model.stream(request)) {
          switch (ev.type) {
            case "text/chunk":
              stepText += ev.text
              break
            case "tool_call":
              append(deps.session, { type: "tool/call", name: ev.call.name, args: ev.call.args })
              const result = await deps.tools.execute({ name: ev.call.name, args: ev.call.args })
              append(deps.session, { type: "tool/result", name: ev.call.name, output: result.output })
              toolCallsThisStep += 1
              break
            case "error":
              throw new Error(`model stream error: ${ev.error.message}`)
            case "end":
              break
          }
        }

        if (stepText) append(deps.session, { type: "assistant/message", text: stepText })
        else if (toolCallsThisStep === 0) append(deps.session, { type: "assistant/message", text: "" })

        append(deps.session, { type: "step/end" })

        // Continuation: after a step with tool calls, run another step so the
        // model can produce its final message. A step without tool calls is a
        // final answer → loop ends (per-turn mock semantics).
        needsContinuation = toolCallsThisStep > 0
      }

      append(deps.session, { type: "turn/end" })
      const finalText = deriveMessages(deps.session).at(-1)?.content ?? ""
      return { finalText, turns }
    },
  }
}
