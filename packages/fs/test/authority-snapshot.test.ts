import { expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createFsTools } from "../src/index.ts"

it("retains the host base-authority token through the asynchronous filesystem policy ladder", async () => {
  const parent = resolve(".tmp"); mkdirSync(parent, { recursive: true })
  const workspace = mkdtempSync(resolve(parent, "sandbox-redesign-fs-authority-"))
  const token = Object.freeze({})
  const tools = createFsTools({ workspace, sandboxPolicy: () => ({ mode: "workspace-write", workspaceRoot: workspace, authoritySnapshot: token }),
    writeGuard: (_path, _mode, captured) => { if (captured !== token) throw new Error("Base authority lost"); return { ok: true } },
  })
  await tools.find(tool => tool.name === "write")!.execute({ path: "allowed", text: "bound" }, {})
  expect(readFileSync(resolve(workspace, "allowed"), "utf8")).toBe("bound")
})
