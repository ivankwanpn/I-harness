// R-C7: ACP (Agent Client Protocol v1) server — automation subset.
//
// createAcpServer({ service, coordinator?, version?, autoApprove? }) builds an
// official-@agentclientprotocol/sdk agent app (AgentApp) and wires:
//   initialize              → protocolVersion + agentInfo + capabilities
//   session/new             → fresh session id (coordinator-backed when given, else in-memory)
//   session/list            → sessions (coordinator's list ∪ session/new-created)
//   session/resume          → {} (unknown ids fail closed)
//   session/close           → {} (v0 no-op; documented v1 hook: flush/lease release)
//   session/prompt          → await service.submit (turn drains), stopReason
//                             "end_turn"; "cancelled" on abort
//   session/cancel (notif)  → aborts the in-flight submit of that session (no-op idle)
//
// v0 permission face (decided):
//   autoApprove (default true) = "allow-once" — prompts are admitted without a
//   client round-trip; the session/request_permission flow is NOT called.
//   autoApprove false = prompts REFUSED (fail-closed), since there is no
//   request/approval round-trip in v0. v1 hook point: guardian/approval wiring
//   + client-side session/request_permission (AgentContext.request).
//
// v0 drop-set (documented omissions): MCP servers on session/new, per-session
// cwd (session service is created with the CLI workspace), session/update
// notification mirroring (session events), session/delete, session/fork,
// session/set_mode, session/set_config_option, terminal/fs/elicitation
// client-method calling, authentication methods.

import { agent, PROTOCOL_VERSION, type AgentApp } from "@agentclientprotocol/sdk"
import { randomUUID } from "node:crypto"
import type { SessionService } from "@i-harness/session-executor"
import type { SessionCoordinator } from "@i-harness/session-persistence"

export const ACP_SERVER_NAME = "i-harness"
/** ACP v1 wire protocol version (the SDK's negotiated version). */
export const ACP_PROTOCOL_VERSION: number = PROTOCOL_VERSION

export interface AcpServerOptions {
  /** C-region session service; session/prompt submits here. */
  service: SessionService
  /** Session persistence — when given, session/new/list/resume are coordinator-backed. */
  coordinator?: SessionCoordinator
  /** Server info version (defaults to "0.1.0"). */
  version?: string
  /** v0 permission face: true = allow-once admission (default), false = refuse prompts. */
  autoApprove?: boolean
}

/** The SDK agent app (official ACP v1 implementation). Wire it to stdio with
 * `server.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))`
 * or compose in-process with `client({ ... }).connectWith(server, op)` (tests). */
export type AcpServer = AgentApp

export function createAcpServer(opts: AcpServerOptions): AcpServer {
  const version = opts.version ?? "0.1.0"
  const autoApprove = opts.autoApprove ?? true
  /** sessionId → cwd, sessions created through session/new (v0 keeps cwd for
   * list; the service itself always runs on the CLI workspace). */
  const known = new Map<string, string>()
  /** sessionId → in-flight session/prompt abort controller. */
  const inflight = new Map<string, AbortController>()

  async function sessionExists(sessionId: string): Promise<boolean> {
    if (known.has(sessionId)) return true
    if (opts.coordinator === undefined) return false
    try {
      await opts.coordinator.profile(sessionId)
      return true
    } catch {
      return false
    }
  }

  const app = agent({ name: ACP_SERVER_NAME })

  app.onRequest("initialize", (ctx) => {
    // ACP: echo the client's version when supported, else advertise ours.
    // v1 only: PROTOCOL_VERSION regardless of what the client asked.
    void ctx.params // client may request anything; we support exactly v1
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentInfo: { name: ACP_SERVER_NAME, version },
      agentCapabilities: {
        sessionCapabilities: { list: {}, close: {}, resume: {} },
      },
    }
  })

  app.onRequest("session/new", async (ctx) => {
    const { cwd } = ctx.params
    const sessionId =
      opts.coordinator !== undefined
        ? (await opts.coordinator.create()).id
        : randomUUID()
    known.set(sessionId, cwd)
    return { sessionId }
  })

  app.onRequest("session/list", async () => {
    const persisted = opts.coordinator !== undefined ? await opts.coordinator.list() : []
    const ids = [...new Set([...known.keys(), ...persisted])]
    return {
      sessions: ids.map((sessionId) => ({
        sessionId,
        // v0: cwd tracked for sessions created here; coordinator-adopted
        // sessions report the harness workspace (the service never moves cwd).
        cwd: known.get(sessionId) ?? process.cwd(),
      })),
    }
  })

  app.onRequest("session/resume", async (ctx) => {
    const { sessionId, cwd } = ctx.params
    if (!(await sessionExists(sessionId))) {
      throw new Error(`unknown session: ${sessionId}`)
    }
    known.set(sessionId, cwd)
    return {}
  })

  app.onRequest("session/close", async (ctx) => {
    const { sessionId } = ctx.params
    if (!(await sessionExists(sessionId))) {
      throw new Error(`unknown session: ${sessionId}`)
    }
    // v0: no-op success — no host-side resource to release per session beyond
    // the service assembly (which idles). v1 hook: flush + lease release.
    return {}
  })

  app.onRequest("session/prompt", async (ctx) => {
    const { sessionId, prompt } = ctx.params
    if (!autoApprove) {
      throw new Error(
        "ACP v0 permission face: autoApprove is false — prompt refused before admission (no request_permission round-trip in v0)",
      )
    }
    if (!(await sessionExists(sessionId))) {
      throw new Error(`unknown session: ${sessionId}`)
    }
    const text = extractPromptText(prompt)
    if (text === "") {
      throw new Error("session/prompt requires at least one text content block (v0)")
    }
    const controller = new AbortController()
    const onRequestAbort = (): void => controller.abort()
    ctx.signal.addEventListener("abort", onRequestAbort)
    inflight.set(sessionId, controller)
    try {
      await opts.service.submit(sessionId, text, controller.signal)
      return { stopReason: "end_turn" as const }
    } catch (error) {
      if (controller.signal.aborted || ctx.signal.aborted) {
        // session/cancel (or connection drop) aborted the turn — ACP stop reason
        return { stopReason: "cancelled" as const }
      }
      throw error
    } finally {
      inflight.delete(sessionId)
      ctx.signal.removeEventListener("abort", onRequestAbort)
    }
  })

  app.onNotification("session/cancel", (ctx) => {
    // v0: cancel is a no-op when idle; when a submit is in flight it is
    // aborted (the prompt handler then answers stopReason "cancelled").
    inflight.get(ctx.params.sessionId)?.abort()
  })

  return app
}

/** v0 prompt text: concatenated text content blocks; everything else
 * (resource links, images, tool calls…) is not admitted in v0 (documented). */
function extractPromptText(prompt: Array<{ type?: string; text?: string }>): string {
  return prompt
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
}
