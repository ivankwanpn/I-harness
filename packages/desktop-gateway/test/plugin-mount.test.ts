import { expect, it, vi } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { pluginExtensions, expandPluginPrompt } from "../src/plugin-mount.ts"
it("expands an enabled plugin command into the durable model prompt", async () => {
  const report = vi.fn()
  const service = createSessionService({
    workspace: process.cwd(), modelPolicy: "test-mock", mockScript: [{ role: "assistant", text: "done" }],
    extensionsFor: async (id) => pluginExtensions({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [], commandDescriptors: [{ name: "hello", body: "Explain $ARGUMENTS" }] }, process.cwd(), id, report),
    transformPrompt: expandPluginPrompt,
  })
  try {
    await service.submit("s", "/hello this code", new AbortController().signal)
    expect(service.liveSession("s")?.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "user/message", text: "Explain this code" })]))
    expect(report).toHaveBeenCalledWith([])
  } finally { await service.close() }
})
