import { expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { registerExec } from "@i-harness/exec"
import { createFsSearchTools } from "@i-harness/fs-search"
import { createLocalExecutionBackends } from "@i-harness/sandbox-local"
import { assertExecutionAuthority, compileExecutionPolicy } from "@i-harness/sandbox-policy"
import type { SandboxExecutionPolicy } from "@i-harness/sandbox"
import { createScopedExec } from "../src/scoped-exec.ts"
import { rmWorkspaceSync } from "./helpers.ts"

function fixture() {
  const parent = resolve(".tmp")
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, "sandbox-redesign-scoped-"))
  const workspace = join(root, "workspace"), outside = join(root, "outside"), privateTemp = join(root, "private-temp")
  for (const path of [workspace, outside, privateTemp]) mkdirSync(path)
  const backends = createLocalExecutionBackends({ legacyPrivateTempRoot: privateTemp })
  const authority = { kind: "unbound" as const, revision: "scoped-fixture", workspaceRoot: workspace }
  const raw = registerExec(createContext(), { workspaceRoot: workspace, execution: {
    defaultOwner: { sessionId: "scoped-fixture" },
    selectBackend: (policy, transport) => backends.select(policy, transport),
    resolvePolicy: (owner, requested) => compileExecutionPolicy({ mode: requested?.mode ?? "danger-full-access", owner, authority }),
    validateAuthority: policy => assertExecutionAuthority(policy, compileExecutionPolicy({ mode: policy.mode, owner: policy.owner, authority })),
    dispose: () => backends.dispose(),
  } })
  return { root, workspace, outside, raw, async dispose() { await raw.dispose(); rmWorkspaceSync(root) } }
}

it("refuses a confined background lifetime before launch while retaining an approved full-access command", async () => {
  const f = fixture()
  const exec = createScopedExec(f.raw, f.workspace, () => ({ mode: "workspace-write", workspaceRoot: f.workspace }))
  const target = join(f.outside, "target.txt")
  const argv = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'approved')`]
  try {
    if (process.platform === "win32") {
      await expect(exec.runBackground({ argv })).rejects.toThrow(/retained-tree|retain-tree|requirements/i)
      expect(existsSync(target)).toBe(false)
    }
    expect(await exec.run({ argv, sandbox: { mode: "danger-full-access", workspaceRoot: f.workspace } })).toMatchObject({ exitCode: 0 })
    expect(readFileSync(target, "utf8")).toBe("approved")
  } finally { await f.dispose() }
}, 30_000)

it("applies current scoped policy to streaming helpers", async () => {
  const f = fixture()
  let policy: SandboxExecutionPolicy = { mode: "danger-full-access", workspaceRoot: f.workspace }
  const exec = createScopedExec(f.raw, f.workspace, () => policy)
  try {
    const chunks: Buffer[] = []
    const ran = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"] }, {
      stream: { maxBytes: 1024, onStdout: bytes => { chunks.push(Buffer.from(bytes)) } },
    })
    expect(ran.exitCode).toBe(0)
    expect(Buffer.concat(chunks).toString()).toBe(f.workspace)
    policy = { mode: "read-only", workspaceRoot: f.workspace }
    if (process.platform === "win32") {
      await expect(exec.runBackground({ argv: [process.execPath, "-e", ""] })).rejects.toThrow(/retained-tree|retain-tree|requirements/i)
    }
  } finally { await f.dispose() }
}, 30_000)

it("streams the selected confined executable through the transport backend", async () => {
  const f = fixture()
  const exec = createScopedExec(f.raw, f.workspace, () => ({ mode: "read-only", workspaceRoot: f.workspace }))
  const chunks: Buffer[] = []
  try {
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write('confined')"] }, {
      stream: { maxBytes: 1024, onStdout: bytes => { chunks.push(Buffer.from(bytes)) } },
    })
    expect(Buffer.concat(chunks).toString()).toBe("confined")
    expect(result.exitCode).toBe(0)
  } finally { await f.dispose() }
}, 30_000)

it("scopes the public transport entrance to the same standing policy and cwd", async () => {
  const f = fixture()
  const exec = createScopedExec(f.raw, f.workspace, () => ({ mode: "read-only", workspaceRoot: f.workspace }))
  try {
    const execution = await exec.launchTransport({ argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
      transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" })
    const output: Buffer[] = []
    await execution.handle.io.endInput()
    for await (const frame of execution.handle.io.output) output.push(Buffer.from(frame.data))
    expect(Buffer.concat(output).toString()).toBe(f.workspace)
    expect(execution.policy.mode).toBe("read-only")
    expect((await execution.handle.settled).kind).toBe("settled")
  } finally { await f.dispose() }
}, 30_000)

it("searches under live read-only then workspace-write policy through a public backend", async () => {
  const f = fixture()
  writeFileSync(join(f.workspace, "one.txt"), "needle\n")
  let mode: SandboxExecutionPolicy["mode"] = "read-only"
  const exec = createScopedExec(f.raw, f.workspace, () => ({ mode, workspaceRoot: f.workspace }))
  const [, grep] = createFsSearchTools({ exec, workspace: f.workspace })
  try {
    const readonly = await grep!.execute({ pattern: "needle" }, {})
    expect(readonly, JSON.stringify(readonly)).toMatchObject({ status: "completed", matches: [expect.objectContaining({ path: "one.txt", text: "needle" })] })
    mode = "workspace-write"
    const allowed = await grep!.execute({ pattern: "needle" }, {})
    expect(allowed).toMatchObject({ status: "completed", matches: [expect.objectContaining({ path: "one.txt", text: "needle" })] })
  } finally { await f.dispose() }
}, 30_000)
