import { describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { createLocalExecutionBackends } from "../src/index.ts"
import type { ProcessSpec, TransportExecutionHandle } from "@i-harness/sandbox"

const run = async (handle: TransportExecutionHandle) => {
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  for await (const frame of handle.io.output) {
    if (frame.channel === "stdout") chunks.push(Buffer.from(frame.data))
    if (frame.channel === "stderr") errors.push(Buffer.from(frame.data))
  }
  const settlement = await handle.release()
  expect(settlement.kind).toBe("settled")
  return { text: Buffer.concat(chunks).toString(), stderr: Buffer.concat(errors).toString(), settlement }
}

describe("real legacy restricted child", () => {
  it.skipIf(process.platform !== "win32")("preserves exact TEMP/TMP/marker and confines writes to the declared owned root", async () => {
    const parent = resolve(process.cwd(), "../..", ".tmp")
    const fixture = mkdtempSync(join(parent, "sandbox-redesign-legacy-"))
    const project = join(fixture, "project")
    const outside = join(fixture, "outside")
    mkdirSync(project); mkdirSync(outside)
    const allowed = join(project, "allowed.txt")
    const denied = join(outside, "denied.txt")
    const local = createLocalExecutionBackends({ legacyPrivateTempRoot: outside })
    const owner = { sessionId: "legacy-control" }
    const authority = { kind: "bound" as const, revision: "fixture-r1", primaryRoot: project,
      roots: [project], references: [outside] }
    const env = { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", MARKER: "exact-child-value",
      TEMP: outside, TMP: outside }
    const spec = (script: string): ProcessSpec => ({ argv: [process.execPath, "-e", script], cwd: project,
      env, owner, transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" })
    try {
      const readOnly = compileExecutionPolicy({ mode: "read-only", owner, authority })
      const readScript = `const fs=require('node:fs');console.log(JSON.stringify({marker:process.env.MARKER,temp:process.env.TEMP,tmp:process.env.TMP,localappdata:process.env.LOCALAPPDATA??null,project:fs.existsSync(${JSON.stringify(project)})}))`
      const reader = await local.select(readOnly, "pipe").prepare(spec(readScript), readOnly)
      const readable = await run(await reader.commit(() => {}))
      expect(JSON.parse(readable.text.trim())).toEqual({ marker: "exact-child-value", temp: outside,
        tmp: outside, localappdata: null, project: true })
      const cmd = join(env.SystemRoot, "System32", "cmd.exe")
      const shell = await local.select(readOnly, "pipe").prepare({ ...spec(""),
        argv: [cmd, "/d", "/s", "/c", "echo shell-ready"] }, readOnly)
      const shellResult = await run(await shell.commit(() => {}))
      expect(shellResult.text).toContain("shell-ready")
      const cmdSpec = (raw: string): ProcessSpec => ({ ...spec(""),
        argv: [cmd, "/d", "/s", "/c", raw], argumentEncoding: "cmd-verbatim" })
      const quoted = await local.select(readOnly, "pipe").prepare(cmdSpec('echo "alpha beta"'), readOnly)
      expect((await run(await quoted.commit(() => {}))).text).toContain('"alpha beta"')
      const empty = await local.select(readOnly, "pipe").prepare(cmdSpec(""), readOnly)
      expect((await run(await empty.commit(() => {}))).stderr).not.toContain("windows-acl-run:")
      const blocked = join(project, "readonly redirect.txt")
      const redirect = await local.select(readOnly, "pipe").prepare(cmdSpec(`echo blocked > "${blocked}"`), readOnly)
      await run(await redirect.commit(() => {}))
      expect(existsSync(blocked)).toBe(false)

      const writable = compileExecutionPolicy({ mode: "workspace-write", owner, authority })
      const writeScript = `const fs=require('node:fs');for(const [name,path] of Object.entries({allowed:${JSON.stringify(allowed)},denied:${JSON.stringify(denied)}})){try{fs.writeFileSync(path,'owned');console.log(name+':OK')}catch{console.log(name+':DENIED')}};console.log('TEMP='+process.env.TEMP)`
      const writer = await local.select(writable, "pipe").prepare(spec(writeScript), writable)
      const result = await run(await writer.commit(() => {}))
      expect(result.text).toContain("allowed:OK")
      expect(result.text).toContain("denied:DENIED")
      expect(result.text).toContain(`TEMP=${outside}`)
      expect(readFileSync(allowed, "utf8")).toBe("owned")
      expect(existsSync(denied)).toBe(false)
      const unicodeTarget = join(project, "雪 空.txt")
      const unicode = await local.select(writable, "pipe").prepare(cmdSpec(`echo unicode-ok > "${unicodeTarget}"`), writable)
      await run(await unicode.commit(() => {}))
      expect(readFileSync(unicodeTarget, "utf8")).toContain("unicode-ok")
      const forbiddenCmd = await local.select(writable, "pipe").prepare(cmdSpec(`echo denied > "${denied}"`), writable)
      await run(await forbiddenCmd.commit(() => {}))
      expect(existsSync(denied)).toBe(false)
    } finally {
      await local.dispose()
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 60_000)
})
