import { afterEach, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { runHookHandler, sha256File } from "../src/index.ts"
import { resolveClaudeShell } from "../src/claude.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each(["timeout", "owner abort"] as const)("%s owns Bash descendants even after the launcher exits", async mode => {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-tree-")); roots.push(root)
  const script = join(root, "launcher.sh"), exited = join(root, "launcher-exiting"), effect = join(root, "descendant-effect"), release = join(root, "release")
  await writeFile(script, 'set -e\n(while [ ! -f "$RELEASE" ]; do sleep 0.02; done; printf later > "$EFFECT") &\nprintf exiting > "$EXITED"\nexit 0\n')
  const owner = new AbortController()
  const pending = runHookHandler({ id: "owned", event: "pre-tool", type: "command", command: { cmd: resolveClaudeShell("bash"), args: [script] },
    trust: { script, sha256: await sha256File(script) }, timeoutMs: mode === "timeout" ? 350 : 3000 }, { event: "pre-tool", tool: { name: "write", args: {} } }, root,
    { signal: owner.signal, env: { EXITED: exited, EFFECT: effect, RELEASE: release }, cwd: root }).then(() => "resolved", error => error)
  if (mode === "owner abort") {
    for (let index = 0; index < 300 && !existsSync(exited); index += 1) await new Promise(resolve => setTimeout(resolve, 10))
    expect(existsSync(exited)).toBe(true)
    owner.abort()
  }
  const disposition = await Promise.race([pending.then(() => "settled"), new Promise<string>(resolve => setTimeout(() => resolve("still-owned"), 1000))])
  await writeFile(release, "released")
  const error = await pending
  expect(error.message).toMatch(/timed out|aborted by owner/)
  // Release the effect only after the API says ownership is drained. A live
  // descendant then writes it, proving a premature timeout/abort disposition.
  await new Promise(resolve => setTimeout(resolve, 80))
  expect(disposition).toBe("settled")
  expect(existsSync(effect)).toBe(false)
})

it("normal completion waits for a descendant's output while retaining the launcher's actual exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-tree-normal-")); roots.push(root)
  await mkdir(join(root, "work"))
  const script = join(root, "launcher.sh")
  await writeFile(script, "(sleep 0.1; printf '%s' '{\"continue\":true}') &\nexit 0\n")
  expect(await runHookHandler({ id: "owned", event: "pre-tool", type: "command", command: { cmd: resolveClaudeShell("bash"), args: [script] },
    trust: { script, sha256: await sha256File(script) }, timeoutMs: 3000 }, { event: "pre-tool", tool: { name: "read", args: {} } }, root, { cwd: root })).toEqual({ continue: true })
})

it("preserves a native bare executable, case-insensitive PATH override and an intentional empty environment value", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-bare-command-")); roots.push(root)
  const script = join(root, "handler.cjs")
  await writeFile(script, "require('node:fs').readFileSync(0,'utf8');if(process.env.HOOK_EMPTY!=='')throw new Error('empty env lost');process.stdout.write('{\"continue\":true}')")
  expect(await runHookHandler({ id: "bare", event: "pre-tool", type: "command", command: { cmd: "node", args: [script] },
    trust: { script, sha256: await sha256File(script) }, timeoutMs: 3000 }, { event: "pre-tool", tool: { name: "read", args: {} } }, root,
    { cwd: root, env: { PaTh: dirname(process.execPath), PATHEXT: ".EXE;.CMD;.BAT", HOOK_EMPTY: "" } })).toEqual({ continue: true })
})

it.skipIf(process.platform !== "win32").each(["directory shadow", "relative PATH", "relative cwd"] as const)("native executable lookup retains %s behavior", async mode => {
  const temp = mode === "relative cwd" ? join(process.cwd(), ".tmp") : tmpdir()
  if (mode === "relative cwd") await mkdir(temp, { recursive: true })
  const root = await mkdtemp(join(temp, "ih-hook-lookup-")); roots.push(root)
  const cwd = mode === "relative cwd" ? relative(process.cwd(), root) : root
  const script = join(root, "handler.cjs")
  await writeFile(script, "require('node:fs').readFileSync(0,'utf8');if(process.env.HOOK_EMPTY!=='')throw new Error('empty env lost');process.stdout.write('{\"continue\":true}')")
  if (mode === "directory shadow") await mkdir(join(root, "node"))
  const path = mode === "relative PATH" ? relative(root, dirname(process.execPath)) : dirname(process.execPath)
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !["path", "pathext"].includes(name.toLowerCase()))), PATH: path, PATHEXT: ".EXE", HOOK_EMPTY: "" }
  // The native control supplies the same argv/cwd/environment, independent of
  // the hook resolver. Neither a directory nor a relative PATH blocks Node.
  const native = await new Promise<{ exitCode: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn("node", [script], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    child.on("error", reject)
    child.stdout.on("data", data => { stdout += data })
    child.on("close", exitCode => resolve({ exitCode, stdout }))
    child.stdin.end("{}")
  })
  expect(native).toEqual({ exitCode: 0, stdout: '{"continue":true}' })
  expect(await runHookHandler({ id: "lookup", event: "pre-tool", type: "command", command: { cmd: "node", args: [script], cwd },
    trust: { script, sha256: await sha256File(script) }, timeoutMs: 3000 }, { event: "pre-tool", tool: { name: "read", args: {} } }, root,
    { cwd: root, env: { PaTh: path, PATHEXT: ".EXE", HOOK_EMPTY: "" } })).toEqual({ continue: true })
})
