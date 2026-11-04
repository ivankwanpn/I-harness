import { expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HEADER_READ_MAX_BYTES, assertHeaderLineReadable, headerLineBytes } from "../src/backend/header-limit.ts"
import { createJsonlBackend } from "../src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../src/backend-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"

it("accepts a header that fits the readable window", () => {
  expect(headerLineBytes("{}")).toBe(3)
  expect(() => assertHeaderLineReadable("x".repeat(HEADER_READ_MAX_BYTES - 1))).not.toThrow()
})

it("rejects a header that could be written but never read back", () => {
  let thrown: unknown
  try { assertHeaderLineReadable("x".repeat(HEADER_READ_MAX_BYTES)) }
  catch (error) { thrown = error }
  expect(thrown).toMatchObject({ code: "SESSION_HEADER_TOO_LARGE", limit: HEADER_READ_MAX_BYTES })
})

it("refuses the oversized header at the backend write", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-header-limit-"))
  const backend = createJsonlBackend(root)
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: "s" })
    await expect(backend.updateMeta("s", { title: "x".repeat(HEADER_READ_MAX_BYTES + 1024) })).rejects.toMatchObject({ code: "SESSION_HEADER_TOO_LARGE" })
  } finally {
    await coordinator.close()
  }
})
