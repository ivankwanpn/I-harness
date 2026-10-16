import { expect, it } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFsTools } from "../src/index.ts"

it("bounds final JSON file pages, reconstructs UTF8 and refuses changed source digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "range-read-"))
  try {
    const text = '你好🙂"\n'.repeat(15000), path = join(root, "large.txt")
    await writeFile(path, text)
    const tool = createFsTools({ workspace: root, readPolicy: { maxOutputBytes: 64000 } }).find(t => t.name === "read")!
    let offset = 0, digest: string | undefined, reconstructed = ""
    for (;;) {
      const page = await tool.execute({ path, offset_bytes: offset, max_output_bytes: 4096, digest }, {} as any) as any
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
      expect(page.content).not.toContain("�")
      reconstructed += page.content; digest = page.digest
      if (!page.truncated) break
      expect(page.next_offset_bytes).toBeGreaterThan(offset); offset = page.next_offset_bytes
    }
    expect(reconstructed).toBe(text)
    const boundary = await tool.execute({ path, offset_bytes: 1 }, {} as any)
    expect(boundary).toMatchObject({ code: "FS_AMBIGUOUS_EDIT" })
    await writeFile(path, "changed")
    expect(await tool.execute({ path, digest }, {} as any)).toMatchObject({ code: "FS_STALE_VERSION" })
    expect(await tool.execute({ path }, {} as any)).toEqual({ content: "changed" })
    const refused = await tool.execute({ path: "../" + "x".repeat(100000), max_output_bytes: 1024 }, {} as any)
    expect(Buffer.byteLength(JSON.stringify(refused))).toBeLessThanOrEqual(1024)
    expect(refused).toMatchObject({ code: "FS_NOT_FOUND" })
    const legacy = createFsTools({ workspace: root }).find(t => t.name === "read")!
    await writeFile(path, text)
    expect(await legacy.execute({ path }, {} as any)).toEqual({ content: text })
    const signal = AbortSignal.abort(new Error("stopped"))
    await expect(tool.execute({ path }, { abortSignal: signal } as any)).rejects.toThrow("stopped")
  } finally { await rm(root, { recursive: true, force: true }) }
})
