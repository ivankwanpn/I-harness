import { expect, it, vi } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createSessionAssembly } from "../src/assembly.ts"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { clampOutputCap } from "@i-harness/llm-seam"
import { estimateContent } from "@i-harness/token-meter"
import { gcSpillStore } from "@i-harness/output-retention"

it("reports an actual yielded live cell while the agent turn is idle and drops it after completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-live-cells-"))
  const assembly = await createSessionAssembly({ workspace: root, sessionId: "owned", modelPolicy: "test-mock", sandbox: "danger-full-access", codeMode: { mode: "mixed" } })
  try {
    const result = await assembly.tools.execute({ name: "code_exec", args: { code: 'await yield_control(); text("done");', yield_time_ms: 2000 } })
    const output = result.output as { cell_id: string; status: string }
    expect(output.status).toBe("running")
    expect(typeof assembly.liveResources).toBe("function")
    expect(assembly.liveResources!().codeCells).toEqual([{ id: output.cell_id, status: "running" }])
    await assembly.tools.execute({ name: "code_wait", args: { cell_id: output.cell_id, yield_time_ms: 2000 } })
    expect(assembly.liveResources!().codeCells).toEqual([])
    expect(assembly.liveResources!().terminals).toEqual([])
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("mounts a Code Mode program against the assembly's actual tool registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-mode-"))
  let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
  try {
    assembly = await createSessionAssembly({ workspace: root, modelPolicy: "test-mock", sandbox: "danger-full-access", codeMode: { mode: "mixed" } } as Parameters<typeof createSessionAssembly>[0])
    const result = await assembly.tools.execute({ name: "code_exec", args: { code: 'const files = await tools.list_dir({path:"."}); text(files);' } })
    expect(result.output).toMatchObject({ status: "completed" })
    expect(assembly.session.events.some((event) => event.type === "code/dispatch" as string)).toBe(true)
  } finally { await assembly?.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("assembly disposal waits for a yielded cell's nested tool producer to settle", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-dispose-"))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered = false
  let aborted = false
  const assembly = await createSessionAssembly({ workspace: root, modelPolicy: "test-mock", codeMode: { mode: "only" }, sandbox: "danger-full-access", additionalTools: [{
    name: "held_read", description: "Held fixture", inputSchema: { type: "object", properties: {} }, isReadOnly: true,
    execute: async (_args, exec) => { entered = true; exec.abortSignal?.addEventListener("abort", () => { aborted = true }, { once: true }); await held; return "settled" },
  }] })
  try {
    expect((await assembly.tools.execute({ name: "code_exec", args: { code: 'text(await tools.held_read({}));', yield_time_ms: 0 } })).output).toMatchObject({ status: "running" })
    await vi.waitFor(() => expect(entered).toBe(true))
    let disposed = false
    const closing = assembly.dispose().then(() => { disposed = true })
    await vi.waitFor(() => expect(aborted).toBe(true))
    expect(disposed).toBe(false)
    release(); await closing
    expect(disposed).toBe(true)
    const length = assembly.session.events.length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(assembly.session.events).toHaveLength(length)
  } finally { release(); await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each(["off", "mixed", "only"] as const)("uses the %s tool surface in actual model requests and budget pricing", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-schemas-"))
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } }
  let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
  try {
    assembly = await createSessionAssembly({ workspace: root, model, sandbox: "danger-full-access", codeMode: { mode }, contextWindow: 100_000, maxOutputTokens: 100_000 })
    await assembly.agent.run("hello")
    const request = requests[0]!
    const names = request.tools.map(tool => tool.name)
    if (mode === "only") expect(names).toEqual(["code_exec", "code_status", "code_wait"])
    else { expect(names).toContain("list_dir"); expect(names.includes("code_exec")).toBe(mode === "mixed") }
    const overhead = Math.ceil(request.systemPrompt.length / 4) + Math.ceil(JSON.stringify(request.tools).length / 4)
    expect(request.maxOutputTokens).toBe(clampOutputCap(100_000, 100_000, overhead + estimateContent(request.messages)))
  } finally { await assembly?.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("prices a live Code Mode catalog after host tools change", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-overhead-"))
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } }
  const assembly = await createSessionAssembly({ workspace: root, model, codeMode: { mode: "only" }, contextWindow: 100_000, maxOutputTokens: 100_000 })
  try {
    assembly.tools.register({ name: "late_tool", description: "Late catalog payload ".repeat(400), inputSchema: { type: "object", properties: {} }, isReadOnly: true, execute: async () => "ok" })
    await assembly.agent.run("hello")
    const request = requests[0]!
    const overhead = Math.ceil(request.systemPrompt.length / 4) + Math.ceil(JSON.stringify(request.tools).length / 4)
    expect(request.tools[0]!.description).toContain("late_tool")
    expect(request.maxOutputTokens).toBe(clampOutputCap(100_000, 100_000, overhead + estimateContent(request.messages)))
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("retains Code Mode text in the host's unified spill root where existing GC can find it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-unified-spill-")), spillRoot = join(root, "owned-spills")
  const assembly = await createSessionAssembly({ workspace: root, modelPolicy: "test-mock", sandbox: "workspace-write", codeMode: { mode: "only" }, outputSpill: { spillRoot } })
  try {
    const result = (await assembly.tools.execute({ name: "code_exec", args: { code: 'text("x".repeat(20000));' } })).output as { textRetention: { path: string } }
    expect(dirname(result.textRetention.path)).toBe(spillRoot)
    expect((await stat(result.textRetention.path)).size).toBe(20000)
    expect(await gcSpillStore(spillRoot, { maxAgeMs: 0, maxTotalBytes: 0, now: Date.now() + 1000 })).toMatchObject({ removedFiles: 1, removedBytes: 20000 })
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})
