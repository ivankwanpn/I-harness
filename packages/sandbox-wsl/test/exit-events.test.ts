import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { expect, it } from "vitest"

it.skipIf(process.platform !== 'win32' || process.env.IH_WSL_INJECTED_EXIT_EVENTS !== '1')("exercises the original worker completion owner with injected dependencies", () => {
  const toWsl = (p: string) => execFileSync("wsl.exe", ["-d", "Ubuntu", "--exec", "wslpath", "-u", p], { encoding: "utf8" }).trim()
  const fixture = toWsl(resolve("test/exit_events_test.py"))
  const source = toWsl(process.env.IH_WSL_EVENT_SOURCE ?? resolve("worker/runner.py"))
  const result = execFileSync("wsl.exe", ["-d", "Ubuntu", "--exec", "python3", "-I", "-B", fixture, source], { encoding: "utf8", timeout: 15000 })
  expect(result).toContain('INJECTED_WORKER_HELPERS=11')
})

it.skipIf(process.platform !== 'win32' || process.env.IH_WSL_INJECTED_EXIT_EVENTS !== '1')("retires actual Prepared directory capabilities without replay", () => {
  const toWsl = (p: string) => execFileSync("wsl.exe", ["-d", "Ubuntu", "--exec", "wslpath", "-u", p], { encoding: "utf8" }).trim()
  const fixture = toWsl(resolve("test/prepared_retirement_test.py"))
  const source = toWsl(process.env.IH_WSL_EVENT_SOURCE ?? resolve("worker/runner.py"))
  const result = execFileSync("wsl.exe", ["-d", "Ubuntu", "--exec", "python3", "-I", "-B", fixture, source], { encoding: "utf8", timeout: 15000 })
  expect(result).toContain('INJECTED_PREPARED_RETIREMENT_CASES=7')
})

it.skipIf(process.platform !== 'win32' || process.env.IH_WSL_INJECTED_EXIT_EVENTS !== '1')("drives actual Worker.run with isolated injected transports and child", () => {
  const toWsl = (p: string) => execFileSync("wsl.exe", ["-d", "Ubuntu", "--exec", "wslpath", "-u", p], { encoding: "utf8" }).trim()
  const fixture = toWsl(resolve("test/exit_run_test.py"))
  const source = toWsl(process.env.IH_WSL_EVENT_SOURCE ?? resolve("worker/runner.py"))
  const result = execFileSync("wsl.exe", ["-d", "Ubuntu", "--exec", "python3", "-I", "-B", fixture, source], { encoding: "utf8", timeout: 15000 })
  expect(result).toContain('INJECTED_WORKER_RUN_CASES=9')
})
