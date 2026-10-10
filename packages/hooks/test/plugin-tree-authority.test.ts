import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as hooks from "../src/index.ts"
import { sha256ClaudePluginTree } from "../src/claude.ts"

it("rechecks the same bounded plugin content at synchronous dispatch and asynchronous hook loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-tree-authority-"))
  try {
    await mkdir(join(root, "hooks"))
    await writeFile(join(root, "hooks", "hooks.json"), '{"hooks":{}}')
    await writeFile(join(root, "startup.sh"), "echo startup")
    const first = await sha256ClaudePluginTree(root)
    expect(hooks.sha256ClaudePluginTreeSync(root)).toBe(first)
    await writeFile(join(root, "startup.sh"), "echo changed")
    const changed = hooks.sha256ClaudePluginTreeSync(root)
    expect(changed).not.toBe(first)
    expect(await sha256ClaudePluginTree(root)).toBe(changed)
    await mkdir(join(root, ".git"))
    await writeFile(join(root, ".git", "HEAD"), "unrelated bookkeeping")
    expect(hooks.sha256ClaudePluginTreeSync(root)).toBe(changed)
  } finally { await rm(root, { recursive: true, force: true }) }
})
