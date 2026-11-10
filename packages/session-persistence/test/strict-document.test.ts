import { expect, it, vi } from "vitest"
import { createDocuments } from "../src/coordinator/documents.ts"

it("document writes reject their own failures while the shared chain remains usable", async () => {
  const putDocument = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined)
  const report = vi.fn(), acquireLease = vi.fn()
  const docs = createDocuments({ putDocument, getDocument: async () => undefined }, { lockEnabled: false, acquireLease }, report)
  await expect(docs.putDocumentStrict("owned", { result: "complete" })).rejects.toThrow("disk full")
  await docs.putDocumentStrict("owned", { result: "later" })
  expect(putDocument).toHaveBeenCalledTimes(2)
  putDocument.mockRejectedValueOnce(new Error("legacy failure"))
  await expect(docs.putDocument("legacy", {})).rejects.toThrow("legacy failure")
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "legacy failure" }))
  await expect(docs.putDocument("legacy", { recovered: true })).resolves.toBeUndefined()
  await expect(docs.pendingWrites()).resolves.toBeUndefined()
})

it("strict operations use and release the existing document lease on rejection and later success", async () => {
  const release = vi.fn().mockResolvedValue(undefined)
  const acquireLease = vi.fn().mockResolvedValue({ release })
  const putDocument = vi.fn().mockRejectedValueOnce(new Error("write rejected under lease")).mockResolvedValue(undefined)
  const docs = createDocuments({ putDocument, getDocument: async () => undefined }, { lockEnabled: true, acquireLease }, vi.fn())
  await expect(docs.putDocumentStrict("result", { full: "executed" })).rejects.toThrow("write rejected under lease")
  await docs.putDocumentStrict("result", { full: "later" })
  expect(acquireLease.mock.calls).toEqual([["doc:result", expect.any(Function)], ["doc:result", expect.any(Function)]])
  expect(release).toHaveBeenCalledTimes(2)
  await expect(docs.pendingWrites()).resolves.toBeUndefined()
})
