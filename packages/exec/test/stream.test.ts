import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { registerExec } from "../src/index.ts"

const stream = (onStdout: (chunk: Buffer) => void | "stop", maxBytes = 1024) => ({ stream: { maxBytes, onStdout } })
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const tree = "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});c.on('spawn',()=>process.stdout.write(String(c.pid)+'\\n'));setInterval(()=>{},1000)"

describe("registered bounded Exec stream", () => {
  it("forwards split UTF8 and CRLF unchanged and does not spill stdout", async () => {
    const exec = registerExec(createContext(), { spill: { maxOutputBytes: 1 } })
    const chunks: Buffer[] = []
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write(Buffer.from([0xe4,0xbd]));setTimeout(()=>process.stdout.write(Buffer.from([0xa0,13])),30);setTimeout(()=>process.stdout.write(Buffer.from([10])),60)" ] }, stream((b) => { chunks.push(Buffer.from(b)) }))
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0xe4,0xbd,0xa0,13,10]))
    expect(result.stdout).toBe("")
    expect(result.stdoutSpillPath).toBeUndefined()
    expect(result.stream?.bytesAdmitted).toEqual({ stdout: 5, stderr: 0 })
  })

  it("clips a crossing chunk against the combined stdout and stderr allowance", async () => {
    const chunks: Buffer[] = []
    const result = await registerExec(createContext()).run({ argv: [process.execPath, "-e", "process.stderr.write('err');setTimeout(()=>process.stdout.write('abcdef'),40);setInterval(()=>{},1000)" ], timeoutMs: 1000 }, stream((b) => { chunks.push(Buffer.from(b)) }, 7))
    expect(result.stderr).toBe("err")
    expect(Buffer.concat(chunks).toString()).toBe("abcd")
    expect(result.stream?.bytesAdmitted).toEqual({ stdout: 4, stderr: 3 })
    expect(result.stream?.bytesRead.stdout).toBeGreaterThanOrEqual(6)
    expect(result.stream?.stopReason).toBe("output-limit")
    expect(result.outputDiagnostics?.discardedOutputBytes).toBeGreaterThanOrEqual(2)
  })

  it.each(["stop", "throw", "abort"] as const)("awaits grandchild termination after consumer %s", async (cause) => {
    const exec = registerExec(createContext()), controller = new AbortController()
    let pid = 0
    const failure = new Error("observer failed")
    try {
      const pending = exec.run({ argv: [process.execPath, "-e", tree], abortSignal: controller.signal, timeoutMs: 3000 }, stream((b) => {
        pid = Number(b.toString().trim())
        if (cause === "throw") throw failure
        if (cause === "abort") { controller.abort(); return }
        return "stop"
      }))
      if (cause === "throw") await expect(pending).rejects.toBe(failure)
      else expect((await pending).stream?.stopReason).toBe(cause === "abort" ? "aborted" : "consumer")
      expect(pid).toBeGreaterThan(0)
      expect(alive(pid)).toBe(false)
    } finally { if (pid && alive(pid)) process.kill(pid) }
  }, 7000)

  it("returns a pre-aborted stream without spawning a side effect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stream-abort-")), marker = join(dir, "marker")
    const controller = new AbortController(); controller.abort()
    try {
      const result = await registerExec(createContext()).run({ argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`], abortSignal: controller.signal }, stream(() => {}))
      expect(result.stream?.stopReason).toBe("aborted")
      expect(result.stream?.bytesRead).toEqual({ stdout: 0, stderr: 0 })
      expect(existsSync(marker)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("distinguishes a timeout from an abort", async () => {
    const result = await registerExec(createContext()).run({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeoutMs: 100 }, stream(() => {}))
    expect(result.timedOut).toBe(true)
    expect(result.stream?.stopReason).toBe("timeout")
  })

  it("writes raw stdin without decoding and rejects mixed stdin before spawn", async () => {
    const exec = registerExec(createContext()), chunks: Buffer[] = []
    const argv = [process.execPath, "-e", "process.stdin.pipe(process.stdout)"]
    await exec.run({ argv, inputBytes: Buffer.from([0,255,13,10]) }, stream((b) => { chunks.push(Buffer.from(b)) }))
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0,255,13,10]))
    await expect(exec.run({ argv, input: "x", inputBytes: Buffer.from("y") }, stream(() => {}))).rejects.toThrow(/input/)
  })

  it("rejects invalid admission and promotion mixtures", async () => {
    const exec = registerExec(createContext()), argv = [process.execPath, "-e", ""]
    for (const maxBytes of [0, -1, NaN, Infinity, 1.5]) await expect(exec.run({ argv }, stream(() => {}, maxBytes))).rejects.toThrow(/maxBytes/)
    await expect(exec.run({ argv }, { ...stream(() => {}), backgroundAfterMs: 1 } as never)).rejects.toThrow(/promotion/)
    const aborted = new AbortController(); aborted.abort()
    await expect(exec.run({ argv, abortSignal: aborted.signal }, stream(() => {}, 0))).rejects.toThrow(/maxBytes/)
  })

  it('accepts the bounded derived UTF8 transport and rejects its next byte before spawn',async()=>{
    const exec=registerExec(createContext()),chunks:Buffer[]=[]
    const argv=[process.execPath,'-e',"let n=0;process.stdin.on('data',d=>n+=d.length);process.stdin.on('end',()=>process.stdout.write(String(n)))"]
    await exec.run({argv,inputBytes:Buffer.alloc(2*1024*1024,128)},stream((b)=>{chunks.push(b)}))
    expect(Buffer.concat(chunks).toString()).toBe('2097152')
    await expect(exec.run({argv,inputBytes:Buffer.alloc(2*1024*1024+1)},stream(()=>{}))).rejects.toThrow(/inputBytes/)
  })
})
