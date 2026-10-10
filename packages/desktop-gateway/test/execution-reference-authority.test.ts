import { expect, it } from "vitest"
import { mkdirSync, mkdtempSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createSessionAssembly } from "@i-harness/session-executor"
import type { ExecService } from "@i-harness/exec"
import type { AuthorityState } from "@i-harness/sandbox"
import { approvalPolicyIdentity } from "../src/approval-policy-identity.ts"

it("shares trusted reference restrictions between filesystem, remembered approvals and full-access processes", async () => {
  const parent = resolve(".tmp"); mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(resolve(parent, "sandbox-redesign-reference-"))
  const workspace = resolve(root, "workspace"), reference = resolve(root, "reference")
  mkdirSync(workspace); mkdirSync(reference)
  let state: AuthorityState = { kind: "unbound", revision: "refs-1", workspaceRoot: workspace, references: [] }
  const assembly = await createSessionAssembly({ sessionId: "reference-owner", workspace, modelPolicy: "test-mock", approveAll: true,
    sandbox: "danger-full-access", executionAuthority: () => state })
  const identity = () => approvalPolicyIdentity(assembly, { workspace, sandbox: "danger-full-access", approval: "dangerous", project: () => undefined,
    executionAuthority: () => state, hookConfigs: [], grantPaths: [], pluginAuthority: {} })
  try {
    const before = identity()!
    state = { ...state, revision: "refs-2", references: [reference] }
    expect(identity()?.revision).not.toBe(before.revision)
    const target = resolve(reference, "forbidden")
    await expect(assembly.tools.get("write")!.execute({ path: target, text: "forbidden" }, {})).rejects.toThrow(/Readonly reference/)
    expect(existsSync(target)).toBe(false)
    const exec = assembly.ctx.services.get<ExecService>("exec/service")
    await expect(exec.run({ argv: [process.execPath, "-e", "process.exit(0)"] })).rejects.toThrow(/denyPaths|reference|requirements/)
    state = { kind: "revoked", revision: "refs-3", reason: "project removed" }
    expect(identity()).toBeUndefined()
    await expect(exec.run({ argv: [process.execPath, "-e", "process.exit(0)"] })).rejects.toThrow(/revoked/)
  } finally { await assembly.dispose() }
})
