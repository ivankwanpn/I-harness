import { describe, expect, it } from "vitest"
import { assertSnapshotFresh } from "../src/version.ts"

describe("assertSnapshotFresh", () => {
  it("passes when mtime and size match", () => {
    expect(() => assertSnapshotFresh({ mtimeMs: 1000.7, size: 42 }, { mtimeMs: 1000.2, size: 42 })).not.toThrow()
  })
  it("passes when mtimes match after Math.floor (sub-ms drift ok)", () => {
    expect(() => assertSnapshotFresh({ mtimeMs: 1000.9, size: 7 }, { mtimeMs: 1000.1, size: 7 })).not.toThrow()
  })
  it("throws FS_STALE_VERSION on mtime mismatch", () => {
    let code = ""
    try {
      assertSnapshotFresh({ mtimeMs: 1000, size: 42 }, { mtimeMs: 1001.5, size: 42 })
      expect.unreachable("expected throw")
    } catch (err) {
      code = (err as { code?: string }).code ?? ""
      expect((err as Error).message).toMatch(/changed|stale/i)
    }
    expect(code).toBe("FS_STALE_VERSION")
  })
  it("throws FS_STALE_VERSION on size mismatch (even with same floored mtime)", () => {
    expect(() => assertSnapshotFresh({ mtimeMs: 1000.4, size: 42 }, { mtimeMs: 1000.6, size: 43 })).toThrow(/changed|stale/i)
  })
})
