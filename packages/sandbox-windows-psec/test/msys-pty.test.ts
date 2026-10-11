import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { resolve, join, win32 } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { createHash } from "node:crypto"
import { type SupervisedExecution } from "@i-harness/exec"
import { createOwnedExec } from "./owned-exec.ts"

const git = win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git")
const bash = win32.join(git, "bin", "bash.exe")
const suite = describe.skipIf(process.platform !== "win32" || !existsSync(bash))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, detail: () => string = () => "", timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (check()) return; await pause(5) }
  throw new Error(`MSYS PTY condition timed out: ${detail().slice(-4000)}`)
}
async function fixture() {
  const build = resolve(import.meta.dirname, "../../../build")
  const root = await mkdtemp(join(build, "msys-pty-acceptance-"))
  const exec = createOwnedExec(root), executions: SupervisedExecution[] = [], readers: Promise<void>[] = []
  async function start(args: string[], lifetime: "retain-tree" | "complete-tree" = "retain-tree", command = bash) {
    const execution = await exec.launchTransport({ argv: [command, ...args], cwd: root,
      env: { ...process.env, TERM: "xterm-256color", PS1: "PTY_ACCEPT_READY> ", HISTFILE: join(root, "history") } as Record<string, string>,
      transport: "pty", lifetime, argumentEncoding: "crt", pty: { cols: 100, rows: 24 } })
    executions.push(execution)
    let output = "", bytes = 0
    const decoder = new StringDecoder("utf8")
    const drained = (async () => { for await (const frame of execution.handle.io.output) {
      expect(frame.channel).toBe("pty"); bytes += frame.data.length; output += decoder.write(Buffer.from(frame.data))
    } output += decoder.end() })()
    readers.push(drained)
    return { execution, drained, text: () => output, bytes: () => bytes }
  }
  return { root, start, async close() {
    for (const execution of executions) await execution.handle.cancel("cancelled")
    await Promise.all(readers); await exec.dispose()
    if (!root.startsWith(build + win32.sep)) throw new Error("fixture cleanup escaped build directory")
    await rm(root, { recursive: true, force: true })
  } }
}
suite("owned MSYS PTY production acceptance", () => {
  it("preserves split UTF8/control bytes, real WINCH/INT, and keeps child text off the controller", async () => {
    const f = await fixture()
    try {
      const t = await f.start(["--noprofile", "--norc", "-i"]), io = t.execution.handle.io
      await until(() => t.text().includes("PTY_ACCEPT_READY>"), t.text)
      await io.write(Buffer.from(`trap 'printf "__REAL_WINCH__\\n"' WINCH; [[ -o monitor ]]; printf '__MONITOR__:%s\\n' $?\r`))
      await until(() => t.text().includes("__MONITOR__:0\r\n"), t.text)
      for (let index = 0; index < 6; index++) {
        const offset = t.text().length, cols = index % 2 ? 81 + index : 143 + index, rows = index % 2 ? 18 + index : 37 + index
        await io.resize!(cols, rows)
        await io.write(Buffer.from(`echo "ACCEPT_${index}_"OK; tput cols; tput lines\r`))
        await until(() => t.text().slice(offset).includes(`ACCEPT_${index}_OK\r\n${cols}\r\n${rows}\r\n`), t.text)
        expect(t.text().slice(offset)).toContain("__REAL_WINCH__\r\n")
      }
      let offset = t.text().length
      const unicode = "e中😀 café", command = `printf '__UNICODE__:%s\\n' '${unicode}'\r`
      for (const byte of Buffer.from(command)) await io.write(Uint8Array.of(byte))
      await until(() => t.text().slice(offset).includes(`__UNICODE__:${unicode}\r\n`), t.text)
      const raw = Buffer.from([0, 1, 3, 4, 8, 9, 10, 13, 27, 127, ...Buffer.from(unicode)])
      offset = t.text().length
      await io.write(Buffer.from(`stty raw -echo; printf '\\n__RAW_BEGIN__\\n'; dd bs=1 count=${raw.length} 2>/dev/null | od -An -v -tx1; stty sane; printf '\\n__RAW_END__\\n'\r`))
      await until(() => t.text().slice(offset).includes("\n__RAW_BEGIN__\n"), t.text)
      for (const byte of raw) await io.write(Uint8Array.of(byte))
      await until(() => t.text().slice(offset).includes("__RAW_END__\r\n"), t.text)
      const hex = t.text().slice(offset).split("\n__RAW_BEGIN__\n")[1]!.split("__RAW_END__")[0]!.match(/\b[0-9a-f]{2}\b/g)!.join("")
      expect(hex).toBe(raw.toString("hex"))
      offset = t.text().length
      await io.write(Buffer.from("printf '\\n__INT_BEGIN__\\n'; sleep 30; printf '\\n__INT_BAD__\\n'\r"))
      await until(() => t.text().slice(offset).includes("\r\n__INT_BEGIN__\r\n"), t.text)
      await io.resize!(177, 49); await io.signal!("INT")
      await until(() => t.text().slice(offset).includes("PTY_ACCEPT_READY>"), t.text)
      expect(t.text().slice(offset)).not.toContain("\r\n__INT_BAD__\r\n")
      offset = t.text().length
      await Promise.all([io.write(Buffer.from("printf '")), io.write(Buffer.from("READY\\nROOT 0\\nACK r999 0\\n' >&2\r"))])
      await until(() => t.text().slice(offset).includes("READY\r\nROOT 0\r\nACK r999 0\r\n"), t.text)
      expect(await Promise.race([t.execution.handle.rootExited.then(() => "exited"), pause(50).then(() => "running")])).toBe("running")
    } finally { await f.close() }
  }, 25_000)

  it("delivers literal admitted argv including wildcard and quote characters", async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.root, "a"), "match"); await writeFile(join(f.root, "x.txt"), "match")
      const args = ["*", "?", "[abc]", "{a,b}", "~", "a\\b", "", 'q"z', "e中😀"]
      const t = await f.start(["--noprofile", "--norc", "-c", "printf '%s\\0' \"$@\"", "argv-probe", ...args], "complete-tree")
      expect(await t.execution.handle.rootExited).toMatchObject({ exitCode: 0 })
      expect((await t.execution.handle.settled).kind).toBe("settled"); await t.drained
      expect(t.text()).toBe(args.map(a => a + "\0").join(""))
    } finally { await f.close() }
  }, 15_000)

  it("drains more than one MiB after logical child exit in complete-tree", async () => {
    const f = await fixture()
    try {
      const t = await f.start(["--noprofile", "--norc", "-c", "p=$(printf '%0256s' X); for ((i=0;i<8192;i++)); do printf '%s' \"$p\"; done; printf 'TAIL_DONE\\n'"], "complete-tree")
      expect(await t.execution.handle.rootExited).toMatchObject({ exitCode: 0 })
      expect((await t.execution.handle.settled).kind).toBe("settled"); await t.drained
      const expected = ("0".repeat(255) + "X").repeat(8192) + "TAIL_DONE\r\n"
      expect(t.bytes()).toBe(Buffer.byteLength(expected))
      expect(t.text().slice(-11)).toBe("TAIL_DONE\r\n")
      expect(createHash("sha256").update(t.text()).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"))
    } finally { await f.close() }
  }, 15_000)

  it("retains descendants with closed stdio and cancels the actual tree", async () => {
    const f = await fixture()
    try {
      const t = await f.start(["--noprofile", "--norc", "-c", "nohup bash --noprofile --norc -c 'cat /proc/$$/winpid > child.pid; sleep 30; :' </dev/null >/dev/null 2>&1 & while [[ ! -s child.pid ]]; do :; done"], "retain-tree")
      expect(await t.execution.handle.rootExited).toMatchObject({ exitCode: 0 })
      const child = Number(await readFile(join(f.root, "child.pid"), "utf8")); process.kill(child, 0)
      expect(await Promise.race([t.execution.handle.settled.then(() => "settled"), pause(50).then(() => "retained")])).toBe("retained")
      expect((await t.execution.handle.cancel("cancelled")).kind).toBe("settled")
      expect(() => process.kill(child, 0)).toThrow()
    } finally { await f.close() }
  }, 15_000)

  it("acknowledges resize/end-input while a live child has closed its stdio", async () => {
    const f = await fixture()
    try {
      const t = await f.start(["--noprofile", "--norc", "-c", "printf 'CLOSE_READY\\n'; exec 0<&- 1>&- 2>&-; sleep 30; :"])
      await until(() => t.text().includes("CLOSE_READY"), t.text)
      await pause(50)
      await Promise.race([t.execution.handle.io.resize!(123, 31), pause(1500).then(() => { throw Error("closed-stdio resize hung") })])
      await Promise.race([t.execution.handle.io.endInput(), pause(1500).then(() => { throw Error("closed-stdio end-input hung") })])
    } finally { await f.close() }
  }, 10_000)

  it("observes the actual child exit when cancelling an interactive MSYS terminal", async () => {
    const f = await fixture()
    try {
      const t = await f.start(["--noprofile", "--norc", "-i"])
      await until(() => t.text().includes("PTY_ACCEPT_READY>"), t.text)
      const settled = await t.execution.handle.cancel("cancelled")
      expect(settled).toMatchObject({ kind: "settled", root: { exitCode: 137 }, treeEmpty: true, ioSettled: true, resourcesReleased: true })
      expect(await t.execution.handle.rootExited).toEqual({ exitCode: 137 })
    } finally { await f.close() }
  }, 10_000)

  it("keeps resize/output/cancellation responsive with a full unread raw input buffer", async () => {
    const f = await fixture()
    let requests: Promise<unknown>[] = []
    try {
      const t = await f.start(["--noprofile", "--norc", "-c", "stty raw -echo; printf 'PRESSURE_READY\\n'; (p=$(printf '%0256s' X); for ((i=0;i<8192;i++)); do printf '%s' \"$p\"; done; printf 'OUTPUT_PROGRESS\\n') & sleep 30; :"])
      await until(() => t.text().includes("PRESSURE_READY"), t.text)
      requests = Array.from({ length: 64 }, () => t.execution.handle.io.write(Buffer.alloc(16384, 65)).then(() => "ack", error => String(error)))
      await until(() => t.text().includes("OUTPUT_PROGRESS"), t.text)
      for (let index = 0; index < 3; index++) {
        // Native writer backpressure may reject before a request was queued.
        // Once accepted, resize must respond while real master writes block.
        const deadline = Date.now() + 3000
        for (;;) {
          try {
            await Promise.race([t.execution.handle.io.resize!(123 + index, 31 + index), pause(1500).then(() => { throw Error("accepted resize hung behind blocked input") })])
            break
          } catch (error) { if (!String(error).includes("input-backpressure") || Date.now() >= deadline) throw error; await pause(5) }
        }
      }
      const settlement = await t.execution.handle.cancel("cancelled")
      expect(settlement).toMatchObject({ kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true })
      await Promise.all(requests)
    } finally { await f.close(); await Promise.all(requests) }
  }, 15_000)
})
