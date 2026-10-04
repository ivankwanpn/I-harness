import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionService } from "../src/service.ts"
import { registerCodeMode } from "@i-harness/code-mode"
import type { CodeModeConfig } from "@i-harness/code-mode"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"

it("adopts the current saved mode in new parent and child environments while preserving a live parent cell", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-mode-live-"))
  let saved: CodeModeConfig = { mode: "off" }
  const requests: LLMRequest[] = []
  const modes: string[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text: "done" }; yield { type: "end" } } }
  const service = createSessionService({ workspace: root, sandbox: "danger-full-access", model, codeMode: () => saved,
    codeModeFactory: (ctx, registry, options) => { modes.push(options.config!.mode!); return registerCodeMode(ctx, registry, options) },
    pluginAgents: [{ name: "probe", description: "Read fixture", systemPrompt: "Read only", tools: ["list_dir"] }],
  })
  try {
    const off = await service.assemblyFor("off-parent")
    expect(off.executionState!()).toMatchObject({ codeMode: "off" })
    expect(off.tools.get("code_exec")).toBeUndefined()
    saved = { mode: "only" }
    await off.tools.get("spawn_agent")!.execute({ task_name: "child", agent_type: "probe", message: "read", fork_turns: "none", background: false }, { sessionId: "off-parent" })
    expect(requests[0]!.tools.map(tool => tool.name)).toEqual(["code_exec", "code_status", "code_wait"])
    expect(modes).toEqual(["only"])
    expect(off.executionState!().codeMode).toBe("off")
    const parent = await service.assemblyFor("new-parent")
    expect(parent.executionState!().codeMode).toBe("only")
    const result = await parent.tools.execute({ name: "code_exec", args: { code: "await yield_control(); await new Promise(r=>setTimeout(r,20000));", yield_time_ms: 1000 } })
    const id = (result.output as { cell_id: string }).cell_id
    saved = { mode: "off" }
    const next = await service.assemblyFor("next-parent")
    expect(next.executionState!().codeMode).toBe("off")
    expect(parent.executionState!().codeMode).toBe("only")
    expect(parent.liveResources!().codeCells).toEqual([{ id, status: "running" }])
    await parent.stopCodeCell!(id)
    expect(parent.liveResources!().codeCells).toEqual([])
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)
