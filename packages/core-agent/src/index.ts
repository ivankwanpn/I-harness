import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append, deriveMessages } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient, LLMRequest } from "@i-harness/llm-seam"
import { assertMessagesFromLog } from "@i-harness/llm-seam"

export interface AgentConfig {
  systemPrompt: string
  maxTurns?: number
  signal?: AbortSignal
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
  reasoning: string[]
}

export interface Agent {
  run(task: string, signal?: AbortSignal): Promise<AgentResult>
  followup(message: string, signal?: AbortSignal): Promise<AgentResult>
}

export function createAgent(ctx: PluginContext, deps: AgentDeps & AgentConfig): Agent {
  const maxTurns = deps.maxTurns ?? 20
  // `steps`/`callSeq`/`reasoning` are shared across the agent's lifetime so a
  // followup continues the same step budget, call-id sequence and reasoning
  // trail as the original run.
  let steps = 0
  let callSeq = 0
  const reasoning: string[] = []

  async function runTurn(message: string, signal?: AbortSignal): Promise<AgentResult> {
    const abort = signal ?? deps.signal
    append(deps.session, { type: "turn/start" })
    append(deps.session, { type: "user/message", text: message })

    let needsContinuation = true
    while (needsContinuation) {
      if (abort?.aborted) throw new Error("agent aborted")
      steps += 1
      // Guard against an infinite tool-call loop: throw once steps exceed
      // the configured maximum (default 20).
      if (steps > maxTurns) throw new Error(`maxTurns exceeded: ${maxTurns}`)
      append(deps.session, { type: "step/start" })

      await ctx.emit("agent/pre-step", { task: message, session: deps.session })

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
        if (abort?.aborted) throw new Error("agent aborted")
        switch (ev.type) {
          case "text/chunk":
            stepText += ev.text
            break
          case "reasoning":
            reasoning.push(ev.text)
            break
          case "tool_call":
            callSeq += 1
            const callId = `call_${callSeq}`
            append(deps.session, { type: "tool/call", callId, name: ev.call.name, args: ev.call.args })
            const result = await deps.tools.execute({ name: ev.call.name, args: ev.call.args })
            if (abort?.aborted) throw new Error("agent aborted")
            append(deps.session, { type: "tool/result", callId, name: ev.call.name, output: result.output })
            // Observation seam: only completed dispatches are observed (after
            // the abort check) and only after the result is appended to the
            // log, so a listener-appended user message lands after the tool
            // result, keeping assistant(toolCalls) -> tool(result) ordering.
            // With no listener the emit is a no-op — behavior-preserving.
            await ctx.emit("agent/post-tool", {
              name: ev.call.name,
              args: ev.call.args,
              output: result.output,
              session: deps.session,
            })
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
    return { finalText, turns: steps, reasoning }
  }

  return {
    run: (task, signal) => runTurn(task, signal),
    followup: (message, signal) => runTurn(message, signal),
  }
}

export interface AgentRegistry {
  register(sessionId: string, agent: Agent): void
  get(sessionId: string): Agent | undefined
  remove(sessionId: string): void
  entries(): Map<string, Agent>
}

export function createAgentRegistry(): AgentRegistry {
  const agents = new Map<string, Agent>()
  return {
    register: (sessionId, agent) => {
      agents.set(sessionId, agent)
    },
    get: (sessionId) => agents.get(sessionId),
    remove: (sessionId) => {
      agents.delete(sessionId)
    },
    entries: () => agents,
  }
}
