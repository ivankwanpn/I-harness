import { expect, it } from "vitest"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJsonlBackend } from "../src/index.ts"

it("distinguishes a missing document from an unreadable one", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-doc-read-"))
  const backend = createJsonlBackend(root)
  mkdirSync(join(root, "blocked.doc.jsonl"))
  await expect(backend.getDocument("blocked")).rejects.toThrow()
  await expect(backend.getDocument("absent")).resolves.toBeUndefined()
})
