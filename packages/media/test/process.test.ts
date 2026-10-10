import { expect, it } from "vitest"
import { runMediaProcess } from "../src/process.ts"

it("bounds decoder stdout before accumulating arbitrary output", async () => {
  await expect(runMediaProcess(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(4096))"], { maxBytes: 128, timeoutMs: 5000 })).rejects.toThrow("byte limit")
})
it("cancels a running process and waits for termination", async () => {
  const controller = new AbortController()
  const result = runMediaProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { maxBytes: 128, timeoutMs: 5000, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await expect(result).rejects.toThrow("cancelled")
})
it("times out a stalled decoder", async () => {
  await expect(runMediaProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { maxBytes: 128, timeoutMs: 80 })).rejects.toThrow("time limit")
})
