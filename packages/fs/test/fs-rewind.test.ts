import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { createFsTools, type RewindCapture } from "../src/index.ts"

const utf8 = (s: string) => new TextEncoder().encode(s)
const H = (s: string) => createHash("sha256").update(utf8(s)).digest("hex")

// A capture sink that records every take — the test asserts the exact
// (path, before) tuples the write pipeline replayed (spec §2 channel). The
// recorded `before` decodes to text so Buffer-vs-Uint8Array identity quirks
// never leak into the assertions.
function makeSink() {
  const takes: { path: string; before: string | null }[] = []
  const sink: RewindCapture = {
    take(path, beforeBytes) {
      const text = beforeBytes === null ? null : new TextDecoder().decode(beforeBytes)
      takes.push({ path, before: text })
      return { blobId: text === null ? null : H(text), isNewFile: text === null }
    },
  }
  return { takes, sink }
}

describe("fs rewind capture", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "i-harness-rewind-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("write: wraps the overwrite (pre-read) and reports preImageRef", async () => {
    await writeFile(join(dir, "a.txt"), "original")
    const { takes, sink } = makeSink()
    const write = createFsTools({ workspace: dir, rewind: sink }).find((t) => t.name === "write")!
    const out = (await write.execute({ path: "a.txt", text: "new" }, {})) as { preImageRef?: string; isNewFile?: boolean }
    expect(out.preImageRef).toBe(H("original"))
    expect(out.isNewFile).toBe(false)
    expect(takes).toEqual([{ path: "a.txt", before: "original" }])
  })

  it("write: new file → isNewFile true, no preImageRef", async () => {
    const { takes, sink } = makeSink()
    const write = createFsTools({ workspace: dir, rewind: sink }).find((t) => t.name === "write")!
    const out = (await write.execute({ path: "fresh.txt", text: "hi" }, {})) as { preImageRef?: string; isNewFile?: boolean }
    expect(out.preImageRef).toBeUndefined()
    expect(out.isNewFile).toBe(true)
    expect(takes).toEqual([{ path: "fresh.txt", before: null }])
  })

  it("edit: captures the loaded pre-image right before the write", async () => {
    await writeFile(join(dir, "b.txt"), "foo bar")
    const { takes, sink } = makeSink()
    const edit = createFsTools({ workspace: dir, rewind: sink }).find((t) => t.name === "edit")!
    const out = (await edit.execute({ path: "b.txt", old_string: "bar", new_string: "baz" }, {})) as { preImageRef?: string; isNewFile?: boolean }
    expect(out.preImageRef).toBe(H("foo bar"))
    expect(out.isNewFile).toBe(false)
    expect(takes).toEqual([{ path: "b.txt", before: "foo bar" }])
  })

  it("apply_patch: add reports isNewFile; update reports preImageRef; delete reports preImageRef", async () => {
    await writeFile(join(dir, "u.txt"), "old")
    const { takes, sink } = makeSink()
    const patch = createFsTools({ workspace: dir, rewind: sink }).find((t) => t.name === "apply_patch")!

    const upd = (await patch.execute({
      patch_content: `*** Begin Patch\n*** Update File: u.txt\n@@\n-old\n+new\n*** End Patch\n`,
    }, {})) as { ok: boolean; applied: { path: string; action: string; preImageRef?: string; isNewFile?: boolean }[] }
    expect(upd.ok).toBe(true)
    expect(upd.applied).toEqual([{ path: "u.txt", action: "updated", preImageRef: H("old") }])

    const add = (await patch.execute({
      patch_content: `*** Begin Patch\n*** Add File: added.txt\n+content\n*** End Patch\n`,
    }, {})) as { ok: boolean; applied: { path: string; action: string; preImageRef?: string; isNewFile?: boolean }[] }
    expect(add.ok).toBe(true)
    expect(add.applied).toEqual([{ path: "added.txt", action: "added", isNewFile: true }])

    const del = (await patch.execute({
      patch_content: `*** Begin Patch\n*** Delete File: u.txt\n*** End Patch\n`,
    }, {})) as { ok: boolean; applied: { path: string; action: string; preImageRef?: string; isNewFile?: boolean }[] }
    expect(del.ok).toBe(true)
    // the deleted file's pre-image is the POST-update content — the patch
    // writer normalizes to a trailing newline ("new" → "new\n")
    expect(del.applied).toEqual([{ path: "u.txt", action: "deleted", preImageRef: H("new\n") }])

    expect(takes).toEqual([
      { path: "u.txt", before: "old" },
      { path: "added.txt", before: null },
      { path: "u.txt", before: "new\n" },
    ])
  })

  it("outside-workspace absolute write is NOT captured (untracked, honest)", async () => {
    const outside = join(dir, "..", `outside-${Math.random().toString(36).slice(2)}.txt`)
    const { takes, sink } = makeSink()
    const write = createFsTools({ workspace: dir, rewind: sink }).find((t) => t.name === "write")!
    try {
      await write.execute({ path: outside, text: "x" }, {})
      expect(takes).toEqual([])
    } finally {
      const { rm } = await import("node:fs/promises")
      await rm(outside, { force: true })
    }
  })

  it("path normalization: sub-directory keys use forward slashes", async () => {
    await mkdir(join(dir, "sub"))
    await writeFile(join(dir, "sub/n.txt"), "v")
    const { takes, sink } = makeSink()
    const edit = createFsTools({ workspace: dir, rewind: sink }).find((t) => t.name === "edit")!
    await edit.execute({ path: "sub/n.txt", old_string: "v", new_string: "w" }, {})
    expect(takes[0]!.path).toBe("sub/n.txt")
  })

  it("withOUT rewind wired: result has NO rewind fields (additive only)", async () => {
    await writeFile(join(dir, "a.txt"), "x")
    const write = createFsTools({ workspace: dir }).find((t) => t.name === "write")!
    const out = (await write.execute({ path: "a.txt", text: "y" }, {})) as { preImageRef?: string; isNewFile?: boolean }
    expect(out).toEqual({ ok: true })
  })
})
