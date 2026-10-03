import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { createContext } from "../../core-plugin/src/index.ts"
import { createToolRegistry } from "@i-harness/core-tools"
import { createFsTools } from "../src/index.ts"

it("binds ordinary filesystem operations to the real non-symlink workspace and target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ih-fs-approval-"))
  try {
    const target = join(directory, "notes.txt"); writeFileSync(target, "old")
    const ctx = createContext(); const registry = createToolRegistry(ctx)
    const write = createFsTools({ workspace: directory }).find((tool) => tool.name === "write")!
    registry.register(write)
    const call = { name: "write", args: { path: "notes.txt", text: "new" } }
    const prepared = await registry.prepare(call)
    const identity = write.approvalIdentity?.(prepared.call.args)
    expect(identity?.binding).toContain("notes.txt")
    expect(identity?.executablePaths).toContain(process.execPath)
    await registry.dispatch(prepared)
    expect(readFileSync(target, "utf8")).toBe("new")
    expect(write.approvalIdentity?.({ path: "../outside.txt", text: "no" })).toBeUndefined()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
