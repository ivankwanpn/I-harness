import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { registerExec } from "@i-harness/exec"
import { createToolRegistry } from '@i-harness/core-tools'
import { createFsSearchTools } from "../src/index.ts"

async function fixture(files: Record<string, string | Buffer>, body: (run: (kind: "grep" | "glob", args: Record<string, unknown>, signal?: AbortSignal) => Promise<any>, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "bounded-search-"))
  for (const [path, text] of Object.entries(files)) { const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, text) }
  const tools = createFsSearchTools({ exec: registerExec(createContext()), workspace: root })
  try { await body((kind, args, signal) => tools.find((t) => t.name === kind)!.execute(args, { abortSignal: signal }), root) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

// These tests spawn the real ripgrep through a registered Exec, so each one pays
// a process launch. Measured on 2026-10-05: this file takes 4.8s alone and 6.4s
// beside one sibling package, against vitest's 5s default — so the deadline, not
// the assertions, is what fails on a slower host. Every assertion is unchanged.
describe("bounded model searches through registered Exec", () => {
  it.each(['grep','glob'])('compacts pre-aborted %s metadata within the requested result cap without Exec',async(kind)=>{
    const ctx=createContext(),exec=registerExec(ctx),registry=createToolRegistry(ctx)
    let executions=0
    exec.run=async()=>{executions++;throw new Error('pre-aborted search launched Exec')}
    for(const tool of createFsSearchTools({exec})) registry.register(tool)
    const controller=new AbortController();controller.abort()
    const result=await registry.execute({name:kind,args:{pattern:'needle',maxResultBytes:4096,includes:Array(8).fill('漢'.repeat(512))}},{signal:controller.signal})
    expect(result.output).toMatchObject({status:'cancelled',partial:true,truncated:true,matches:[],reasons:expect.arrayContaining(['aborted','result-byte-limit']),filters:{filterPatternsTruncated:true}})
    expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThanOrEqual(4096)
    expect(executions).toBe(0)
  })
  it("distinguishes completed no-match from cancellation and validates regex with zero candidates", async () => {
    await fixture({}, async (run) => {
      expect(await run("grep", { pattern: "missing" })).toMatchObject({ status: "completed", matches: [], partial: false })
      expect(await run("grep", { pattern: "[" })).toMatchObject({ status: "error", matches: [], partial: true, error: expect.any(String) })
      const c = new AbortController(); c.abort()
      expect(await run("grep", { pattern: "missing" }, c.signal)).toMatchObject({ status: "cancelled", matches: [], partial: true, stats: { inputBytes: 0 } })
    })
  })

  it("preserves whitespace and reports editor UTF16 ranges after BOM and CRLF decoding", async () => {
    await fixture({ "text.txt": Buffer.from("\ufefffirst\r\n😀你  \t\r\n") }, async (run) => {
      const result = await run("grep", { pattern: "你" })
      expect(result.matches).toEqual([expect.objectContaining({ path: "text.txt", line: 2, text: "😀你  \t", column: 2, endLine: 2, endColumn: 3 })])
      expect(result.stats).toMatchObject({ candidateFiles: 1, attemptedFiles: 1, readFiles: 1, completedFiles: 1, eofFiles: 1, inputBytes: 22 })
    })
  })

  it("supports literal, case, contexts, typed filters and the engine hidden/ignore choices", async () => {
    await fixture({ "a.txt": "before\nA.B\nafter\n", "b.md": "a.b\n", ".hidden.txt": "a.b\n", ".ignore": "ignored.txt\n", "ignored.txt": "a.b\n" }, async (run) => {
      const result = await run("grep", { pattern: "a.b", mode: "literal", case: "insensitive", before: 1, after: 1, includes: ["a.txt"], excludes: ["b.*"] })
      expect(result.matches).toEqual([expect.objectContaining({ path: "a.txt", line: 2, text: "A.B", context: [{ line: 1, text: "before" }, { line: 3, text: "after" }] })])
      expect(result.filters).toMatchObject({ hidden: false, respectIgnore: true, ignorePolicy: "engine", ordering: "discovery/arrival" })
      expect((await run("grep", { pattern: "a.b", mode: "literal", case: "insensitive" })).matches.map((m: any) => m.path).sort()).toEqual(["a.txt", "b.md"])
      expect((await run("grep", { pattern: "a.b", mode: "literal", case: "insensitive", hidden: true, respectIgnore: false })).matches.map((m: any) => m.path).sort()).toEqual([".hidden.txt", "a.txt", "b.md", "ignored.txt"])
      expect((await run("glob", { pattern: "*.txt" })).matches.sort()).toEqual([".hidden.txt", "a.txt", "ignored.txt"])
    })
  })

  it("decodes UTF16 and supports actual PCRE2 multiline ranges", async () => {
    await fixture({ "wide.txt": Buffer.concat([Buffer.from([255,254]), Buffer.from("before\r\n😀你\r\nnext\r\n", "utf16le")]) }, async (run) => {
      const result = await run("grep", { pattern: "(?<=😀)你\\r?\\nnext", regexEngine: "pcre2", multiline: true })
      expect(result.matches).toEqual([expect.objectContaining({ path: "wide.txt", line: 2, column: 2, endLine: 3, endColumn: 4, text: "😀你\nnext", encoding: "utf16le" })])
    })
  })

  it('searches a near-boundary true Latin1 snapshot through bounded derived UTF8 stdin',async()=>{
    await fixture({'latin.txt':Buffer.concat([Buffer.from([128,13,10]),Buffer.alloc(1024*1024-3,233)])},async(run)=>{
      const result=await run('grep',{pattern:'\x80',encoding:'latin1'})
      expect(result.matches).toContainEqual(expect.objectContaining({path:'latin.txt',line:1,text:'\x80',column:0,endColumn:1,encoding:'latin1'}))
      expect(result).toMatchObject({status:'limited',reasons:expect.arrayContaining(['file-byte-limit']),stats:{inputBytes:1024*1024,eofFiles:0}})
      expect(result.stats.engineRawBytes).toBeLessThanOrEqual(1024*1024)
      expect(result.stats.runnerRawBytes).toBeLessThanOrEqual(1024*1024)
    })
  })

  it("returns an honest limited prefix at a per-file boundary without an extra read", async () => {
    await fixture({ "large.txt": Buffer.concat([Buffer.from("needle\n"), Buffer.alloc(1024 * 1024 - 7, 97)]) }, async (run) => {
      const result = await run("grep", { pattern: "needle" })
      expect(result.matches).toContainEqual(expect.objectContaining({ text: "needle" }))
      expect(result).toMatchObject({ status: "limited", partial: true, reasons: expect.arrayContaining(["file-byte-limit"]), stats: { inputBytes: 1024 * 1024, readFiles: 1, eofFiles: 0 } })
    })
  })

  it("stops retained rows within the combined result budget and default context allowance", async () => {
    await fixture({ "many.txt": Array.from({ length: 800 }, (_, i) => `needle ${i} ${"x".repeat(300)}`).join("\n") }, async (run) => {
      const result = await run("grep", { pattern: "needle", maxResults: 1000, maxResultBytes: 4096 })
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
      expect(result.matches.length).toBeGreaterThan(0)
      expect(result).toMatchObject({ status: "limited", partial: true, truncated: true, reasons: expect.arrayContaining(["result-byte-limit"]) })
      const normal = await run("grep", { pattern: "needle", maxResults: 1000 })
      expect(Buffer.byteLength(JSON.stringify(normal))).toBeLessThanOrEqual(32768)
      expect(normal.limits).toMatchObject({ maxResultBytes: 32768 })
    })
  })

  it("keeps an internal result stop limited while draining sibling readers", async () => {
    await fixture(Object.fromEntries(Array.from({length:12},(_,n)=>[`${n}.txt`,`needle ${n}\n${'x'.repeat(20000)}`])),async(run)=>{
      const result=await run('grep',{pattern:'needle',maxResults:1})
      expect(result).toMatchObject({status:'limited',partial:true,reasons:expect.arrayContaining(['result-count-limit'])})
      expect(result.reasons).not.toContain('aborted')
      expect(result.matches).toHaveLength(1)
    })
  })

  it("ignores inherited rg config and rejects raw flags and above-ceiling requests", async () => {
    await fixture({ "a.txt": "needle\n" }, async (run, root) => {
      writeFileSync(join(root, "rg-config"), "--glob=!*.txt\n")
      const old = process.env.RIPGREP_CONFIG_PATH
      process.env.RIPGREP_CONFIG_PATH = join(root, "rg-config")
      try {
        expect((await run("grep", { pattern: "needle", include: "*.txt" })).matches.length).toBe(1)
        for (const extra of [{ maxResults: 1001 }, { maxResultBytes: 262145 }, { timeoutMs: 30001 }, { flags: ["--pre=anything"] }]) expect(await run("grep", { pattern: "needle", ...extra })).toMatchObject({ status: "error", error: expect.any(String), matches: [] })
      } finally { if (old === undefined) delete process.env.RIPGREP_CONFIG_PATH; else process.env.RIPGREP_CONFIG_PATH = old }
    })
  })
}, 30_000)
