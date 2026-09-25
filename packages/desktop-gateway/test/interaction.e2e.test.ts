import { describe, expect, it } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { createSdkServer } from "@i-harness/sdk/server"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import type { ApprovalRequest } from "@i-harness/interaction"
import { createDesktopRouter, createGatewayWrite } from "../src/router.ts"
import { createInteractionBridge } from "../src/interaction.ts"

describe("Desktop interaction over the SDK-compatible stream", () => {
  it("settles pending interaction on SDK session/cancel and rejects a late answer", async () => {
    const frames: RpcMessage[] = []
    const send = (frame: RpcMessage) => { frames.push(frame) }
    const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", mockScript: [] })
    const interaction = createInteractionBridge(send)
    const off = service.onAssembly((assembly) => interaction.attach(assembly))
    const handlers = { interaction }
    const base = createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) })
    const router = createDesktopRouter(base, send, handlers)
    try {
      await router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      const assembly = await service.assemblyFor("s1")
      const answer = assembly.ctx.services.get<(request: ApprovalRequest) => Promise<boolean>>("approval/answerer")
      const waiting = answer({ name: "write", reason: "edit" })
      const { requestId } = interaction.pending("s1")[0]!
      await router.handleLine(encodeFrame(makeRequest(2, "session/cancel", { sessionId: "s1" })))
      expect(await waiting).toBe(false)
      expect(interaction.pending("s1")).toEqual([])
      await router.handleLine(encodeFrame(makeRequest(3, "desktop/interaction/reply", {
        requestId, sessionId: "s1", decision: { kind: "approval", approved: true },
      })))
      expect(isRpcSuccess(frames.find((frame) => "id" in frame && frame.id === 3))).toBe(false)
    } finally {
      interaction.close(); off(); await router.close(); await service.close()
    }
  })

  it("advertises a wired bridge and routes pending and reply to a real assembly", async () => {
    const frames: RpcMessage[] = []
    const send = (frame: RpcMessage) => { frames.push(frame) }
    const service = createSessionService({
      workspace: process.cwd(), modelPolicy: "test-mock",
      mockScript: [{ role: "assistant", text: "ok" }],
    })
    const interaction = createInteractionBridge(send)
    const off = service.onAssembly((assembly) => interaction.attach(assembly))
    const handlers = {
      sandboxState: () => ({ mode: "workspace-write", source: "settings", wired: true }),
      interaction,
    } as const
    const base = createSdkServer(service, { onWrite: createGatewayWrite(send, handlers as never) })
    const router = createDesktopRouter(base, send, handlers as never)
    try {
      await router.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      const init = frames.find((frame) => "id" in frame && frame.id === 1)
      expect(isRpcSuccess(init)).toBe(true)
      if (!isRpcSuccess(init)) throw new Error("initialize failed")
      expect((init.result as { capabilities: Record<string, string[]> }).capabilities["desktop-interaction"]).toEqual(["1"])

      const assembly = await service.assemblyFor("s1")
      const answer = assembly.ctx.services.get<(request: ApprovalRequest) => Promise<boolean>>("approval/answerer")
      const waiting = answer({ name: "write", reason: "edit one file" })
      expect(frames.some((frame) => "method" in frame && frame.method === "desktop/interaction/request")).toBe(true)

      await router.handleLine(encodeFrame(makeRequest(2, "desktop/interaction/pending", { sessionId: "s1" })))
      const pendingReply = frames.find((frame) => "id" in frame && frame.id === 2)
      expect(isRpcSuccess(pendingReply)).toBe(true)
      if (!isRpcSuccess(pendingReply)) throw new Error("pending failed")
      const pending = pendingReply.result as Array<{ requestId: string; sessionId: string }>
      expect(pending).toHaveLength(1)
      expect(pending[0]?.sessionId).toBe("s1")

      await router.handleLine(encodeFrame(makeRequest(3, "desktop/interaction/reply", {
        requestId: pending[0]!.requestId,
        sessionId: "s1",
        decision: { kind: "approval", approved: false },
      })))
      const reply = frames.find((frame) => "id" in frame && frame.id === 3)
      expect(isRpcSuccess(reply)).toBe(true)
      expect(await waiting).toBe(false)
      expect(interaction.pending()).toEqual([])
    } finally {
      interaction.close()
      off()
      await router.close()
      await service.close()
    }
  })
})
