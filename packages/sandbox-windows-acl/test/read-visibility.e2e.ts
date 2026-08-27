import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createWindowsAclSandbox } from "../src/index.ts"

// Read-negation PIN — living documentation of a KNOWN LIMITATION, asserted on
// purpose: the windows-acl backend isolates WRITES (the denial dialect pinned
// in win32.e2e.ts) but the READ side is deliberately NOT isolated — a confined
// child can read anything the calling user could read outside the workspace.
// If read isolation ever ships, this assertion flips and the plan/docs must be
// revisited alongside it.
describe.skipIf(process.platform !== "win32")("read visibility (KNOWN LIMITATION — pin as living doc)", () => {
  let root: string
  let workspace: string
  let secret: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "i-harness-readvis-"))
    workspace = join(root, "ws")
    mkdirSync(workspace)
    secret = join(tmpdir(), "i-harness-readvis-secret.txt")
    writeFileSync(secret, "TOP-SECRET")
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(secret, { force: true })
  })

  it("confined child CAN read outside workspace (read side NOT isolated — by design)", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "workspace-write" })
    try {
      const confined = provider.confine(
        ["node", "-e", `const fs = require('node:fs'); console.log('READ: ' + fs.readFileSync(${JSON.stringify(secret)}, 'utf8'))`],
        { mode: "workspace-write", workspaceRoot: workspace, sessionId: "readvis-e2e" },
      )
      const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: "utf8", timeout: 30_000 })
      expect(result.stdout, `stderr: ${result.stderr}`).toContain("READ: TOP-SECRET")
      expect(result.status).toBe(0)
    } finally {
      provider.dispose()
    }
  })
})
