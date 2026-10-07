import { expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AuthorityState } from "@i-harness/sandbox"
const pause = vi.hoisted(() => ({ target: "", entered: () => {}, wait: Promise.resolve() }))
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, async writeFile(...args: Parameters<typeof fs.writeFile>) {
    if (args[0] === pause.target) { pause.entered(); await pause.wait }
    return fs.writeFile(...args)
  } }
})
import { createSessionAssembly } from "../src/assembly.ts"

it("joins a filesystem write already past its final guard before acknowledging revocation", async () => {
  const parent = resolve(".tmp"); mkdirSync(parent, { recursive: true })
  const workspace = mkdtempSync(resolve(parent, "sandbox-redesign-fs-ack-"))
  pause.target = resolve(workspace, "in-flight")
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(yes => { entered = yes })
  pause.entered = entered
  pause.wait = new Promise<void>(yes => { release = yes })
  let state: AuthorityState = { kind: "unbound", revision: "1", workspaceRoot: workspace }
  const assembly = await createSessionAssembly({ sessionId: "fs-owner", workspace, modelPolicy: "test-mock", approveAll: true,
    sandbox: "danger-full-access", executionAuthority: () => state })
  try {
    const write = assembly.tools.execute({ name: "write", args: { path: pause.target, text: "already admitted write" } })
    await started
    state = { kind: "revoked", revision: "2", reason: "revoked during write" }
    let acknowledged = false
    const drain = assembly.reconcileExecutionAuthority().then(() => { acknowledged = true })
    await new Promise(yes => setTimeout(yes, 20))
    expect(acknowledged).toBe(false)
    release()
    await write
    await drain
    expect(readFileSync(pause.target, "utf8")).toBe("already admitted write")
    await expect(assembly.tools.execute({ name: "write", args: { path: resolve(workspace, "later"), text: "refused" } })).rejects.toThrow(/revoked/)
  } finally { release(); await assembly.dispose() }
})

it("ends an obsolete filesystem escalation prompt so revocation can acknowledge and a late approval cannot write", async () => {
  const parent = resolve(".tmp"); mkdirSync(parent, { recursive: true })
  const workspace = mkdtempSync(resolve(parent, "sandbox-redesign-fs-approval-"))
  let state: AuthorityState = { kind: "unbound", revision: "1", workspaceRoot: workspace }
  const assembly = await createSessionAssembly({ sessionId: "fs-owner", workspace, modelPolicy: "test-mock", approveAll: false,
    sandbox: "read-only", executionAuthority: () => state })
  let release!: (value: boolean) => void, entered!: () => void
  const started = new Promise<void>(yes => { entered = yes })
  const answer = new Promise<boolean>(yes => { release = yes })
  let call: Promise<unknown> | undefined
  try {
    assembly.ctx.services.register("approval/answerer", async (request: { reason: string }) => {
      if (!request.reason.startsWith("escalate sandbox")) return true
      entered(); return answer
    })
    const prepared = await assembly.tools.prepare({ name: "write", args: { path: "late-approval", text: "forbidden", sandbox_permissions: "workspace-write", justification: "controlled approval" } })
    call = assembly.tools.dispatch(prepared).catch(error => error)
    await started
    state = { kind: "revoked", revision: "2", reason: "withdrawn while awaiting approval" }
    const drain = assembly.reconcileExecutionAuthority()
    const acknowledged = await Promise.race([drain.then(() => true), new Promise<false>(yes => setTimeout(() => yes(false), 100))])
    release(true)
    await call; await drain
    expect(acknowledged).toBe(true)
    expect(existsSync(resolve(workspace, "late-approval"))).toBe(false)
  } finally { release(true); await call; await assembly.dispose() }
})
