import { expect, it } from "vitest"
import { mkdtemp, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { append } from "@i-harness/core-session"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { createSessionAssembly } from "../src/assembly.ts"

it("enforces Plan Mode read-only admission when switched on in an existing Agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plan-admission-"))
  const assembly = await createSessionAssembly({ workspace: root, modelPolicy: "test-mock" })
  registerApprovalAnswerer(assembly.ctx, async () => ({ approved: true }))
  try {
    append(assembly.session, { type: "plan/mode", mode: "on" })
    await expect(assembly.tools.execute({ name: "write", args: { path: "blocked.txt", text: "blocked" } })).rejects.toThrow(/Plan Mode/)
    await expect(access(join(root, "blocked.txt"))).rejects.toThrow()
    await expect(assembly.tools.execute({ name: "list_dir", args: { path: "." } })).resolves.toBeDefined()
    append(assembly.session, { type: "plan/mode", mode: "off" })
    await assembly.tools.execute({ name: "write", args: { path: "allowed.txt", text: "allowed" } })
    await expect(access(join(root, "allowed.txt"))).resolves.toBeUndefined()
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})
