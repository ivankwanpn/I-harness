import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { createSessionAssembly } from "../../../packages/session-executor/src/assembly.ts"
import { createSessionCoordinator } from "../../../packages/session-persistence/src/index.ts"
import { createJsonlBackend } from "../../../packages/session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../../../packages/session-executor/src/index.ts"
import type { ModelClient } from "../../../packages/llm-seam/src/index.ts"
import { runHeadless } from "../../../apps/cli/src/run.ts"

const distribution = process.argv[2] ?? "Ubuntu"
if (process.platform !== "win32") throw new Error("This qualification needs Windows and an installed WSL2 distribution")
mkdirSync(resolve(".tmp"), {recursive: true})
const root = mkdtempSync(resolve(".tmp/wsl-product-qualification-"))
process.env.IH_CONFIG_DIR = join(root, "config")
const work = join(root, "workspace"), sibling = join(root, "sibling"), reference = join(root, "reference")
for (const path of [work, sibling, reference]) mkdirSync(path)
writeFileSync(join(reference, "kept.txt"), "REFERENCE_ORIGINAL")
writeFileSync(join(sibling, "kept.txt"), "SIBLING_ORIGINAL")
const result: {date: string; root: string; cases: unknown[]; failure?: string} = {date: new Date().toISOString(), root, cases: []}
const save = () => writeFileSync(join(root, "qualification.json"), JSON.stringify(result, null, 2) + "\n")
const wslExecution = {distribution, networkAccess: false, workspaceDependencies: false}
async function test(name: string, work: () => Promise<unknown>) {
  const start = Date.now()
  try { const evidence = await work(); result.cases.push({name, passed: true, elapsedMs: Date.now() - start, evidence}); save(); console.log(`PASS ${name}`) }
  catch (error) { result.failure = error instanceof Error ? error.stack : String(error); result.cases.push({name, passed: false}); save(); throw error }
}
const assembly = await createSessionAssembly({workspace: work, sessionId: "real-wsl-main", modelPolicy: "test-mock", approveAll: true,
  sandbox: "workspace-write", windowsSandboxBackend: "wsl", wslExecution, codeMode: {mode: "mixed"}, webSearchMode: "disabled",
  executionAuthority: () => ({kind: "bound", revision: "owned-fixture", primaryRoot: work, roots: [work], references: [reference]}),
})
try {
  await test("actual registered Bash protects outside and reference writes", async () => {
    const command = "printf WORKSPACE_OK > result.txt; printf changed > ../sibling/kept.txt 2>/dev/null; printf changed > ../reference/kept.txt 2>/dev/null; printf BASH_OK"
    const output = (await assembly.tools.execute({name: "bash", args: {command}})).output as {stdout: string; exitCode: number}
    assert.equal(output.stdout, "BASH_OK"); assert.equal(output.exitCode, 0)
    assert.equal(readFileSync(join(work, "result.txt"), "utf8"), "WORKSPACE_OK")
    assert.equal(readFileSync(join(reference, "kept.txt"), "utf8"), "REFERENCE_ORIGINAL")
    assert.equal(readFileSync(join(sibling, "kept.txt"), "utf8"), "SIBLING_ORIGINAL")
    return {output, backend: await assembly.executionBackendStatus()}
  })
  await test("actual Code Mode uses Linux Agent Shell", async () => {
    const output = (await assembly.tools.execute({name: "code_exec", args: {code: 'text(await tools.shell({command:"uname -s; printf CODE_OK > code.txt"}));', yield_time_ms: 10000}})).output as {status: string}
    assert.equal(output.status, "completed", JSON.stringify(output))
    assert.equal(readFileSync(join(work, "code.txt"), "utf8"), "CODE_OK")
    return output
  })
  await test("actual WSL background job cancels and drains", async () => {
    const launched = (await assembly.tools.execute({name: "bash", args: {command: "printf READY; sleep 30", background: true}})).output as {job_id: string}
    assert.ok(launched.job_id)
    const interrupted = (await assembly.tools.execute({name: "job_kill", args: {job_id: launched.job_id}})).output
    const settled = (await assembly.tools.execute({name: "job_output", args: {job_id: launched.job_id, wait: true, timeout_ms: 10000}})).output as {status: string}
    assert.notEqual(settled.status, "running")
    return {launched, interrupted, settled}
  })
} finally { await assembly.dispose() }

await test("actual read-only assembly prevents project writes", async () => {
  const ro = await createSessionAssembly({workspace: work, sessionId: "real-wsl-ro", modelPolicy: "test-mock", approveAll: true,
    sandbox: "read-only", windowsSandboxBackend: "wsl", wslExecution})
  try {
    const output = (await ro.tools.execute({name: "bash", args: {command: "printf damaged > result.txt"}})).output as {exitCode: number}
    assert.notEqual(output.exitCode, 0); assert.equal(readFileSync(join(work, "result.txt"), "utf8"), "WORKSPACE_OK")
    return output
  } finally { await ro.dispose() }
})
await test("actual full access assembly permits owned sibling writes", async () => {
  const full = await createSessionAssembly({workspace: work, sessionId: "real-wsl-full", modelPolicy: "test-mock", approveAll: true,
    sandbox: "danger-full-access", windowsSandboxBackend: "wsl", wslExecution})
  try {
    const output = (await full.tools.execute({name: "bash", args: {command: "printf FULL_OK > ../sibling/full.txt"}})).output
    assert.equal(readFileSync(join(sibling, "full.txt"), "utf8"), "FULL_OK")
    return output
  } finally { await full.dispose() }
})
await test("full access refuses retained reference locks without host fallback", async () => {
  const full = await createSessionAssembly({workspace: work, sessionId: "real-wsl-full-reference", modelPolicy: "test-mock", approveAll: true,
    sandbox: "danger-full-access", windowsSandboxBackend: "wsl", wslExecution,
    executionAuthority: () => ({kind: "bound", revision: "locked-reference", primaryRoot: work, roots: [work], references: [reference]}),
  })
  try {
    let refusal: string | undefined
    try { await full.tools.execute({name: "bash", args: {command: "printf damaged > ../reference/kept.txt"}}) }
    catch (error) {refusal = error instanceof Error ? error.message : String(error)}
    assert.match(refusal ?? "", /reference/i)
    assert.equal(readFileSync(join(reference, "kept.txt"), "utf8"), "REFERENCE_ORIGINAL")
    return {refusal}
  } finally { await full.dispose() }
})
await test("actual headless CLI runtime routes model requested Bash to WSL", async () => {
  let step = 0
  const model: ModelClient = {async *stream() {
    if (step++ === 0) yield {type: "tool_call", call: {name: "bash", args: {command: "printf CLI_OK > cli.txt"}}}
    else yield {type: "text/chunk", text: "CLI_DONE"}
    yield {type: "end"}
  }}
  const output = await runHeadless("Controlled local qualification", {workspace: work, model, approveAll: true,
    sandbox: "workspace-write", windowsSandboxBackend: "wsl", wslExecution})
  assert.equal(output.exitCode, 0); assert.equal(readFileSync(join(work, "cli.txt"), "utf8"), "CLI_OK")
  return {exitCode: output.exitCode, finalText: output.finalText}
})
await test("actual child Code Mode registry inherits Linux execution", async () => {
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({sessionId: "parent"})
  let step = 0
  const child: ModelClient = {async *stream() {
    if (step++ === 0) yield {type: "tool_call", call: {name: "code_exec", args: {code: 'text(await tools.shell({command:"printf CHILD_OK > child.txt"}));', yield_time_ms: 10000}}}
    else yield {type: "text/chunk", text: "CHILD_DONE"}
    yield {type: "end"}
  }}
  const service = createSessionService({workspace: work, modelPolicy: "test-mock", coordinator, sessionFor: createDurableSessionLoader(coordinator),
    approveAll: true, sandbox: "workspace-write", windowsSandboxBackend: "wsl", wslExecution, codeMode: {mode: "only"},
    pluginAgents: [{name: "linux-probe", description: "Controlled child", systemPrompt: "Use Linux Bash", tools: ["shell", "code_exec", "code_wait"]}],
    roleSelectionFor: () => ({provider: "fixture", model: "child"}), allowSubagentModelSelection: true,
    resolveRoleModel: async () => ({status: "ready", binding: {client: child}}),
  })
  try {
    const parent = await service.assemblyFor("parent")
    const output = await parent.tools.get("spawn_agent")!.execute({task_name: "probe", agent_type: "linux-probe", message: "Run controlled fixture", fork_turns: "none", background: false}, {sessionId: "parent"})
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      try { if (readFileSync(join(work, "child.txt"), "utf8") === "CHILD_OK") return output } catch {}
      await new Promise(done => setTimeout(done, 100))
    }
    throw new Error("Actual child write did not arrive")
  } finally { await service.close(); await coordinator.close() }
})
save(); console.log(`Evidence: ${join(root, "qualification.json")}`)
