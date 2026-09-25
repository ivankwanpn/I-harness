import { describe, expect, it } from "vitest"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { encodeFrame, makeRequest } from "@i-harness/sdk"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href
const ENTRY = join(REPO_ROOT, "packages", "desktop-gateway", "src", "cli.ts")

function start(args: string[], cwd: string, configDir: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", TSX_LOADER, ENTRY, ...args], {
    cwd, env: { ...process.env, IH_CONFIG_DIR: configDir }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  })
}

function exited(child: ChildProcessWithoutNullStreams, timeoutMs = 10_000): Promise<number | null> {
  return Promise.race([
    new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("gateway did not exit")), timeoutMs)),
  ])
}

describe("desktop-gateway process lifecycle", () => {
  it("rejects a missing session-dir without printing protocol noise", async () => {
    const root = mkdtempSync(join(tmpdir(), "ih-desktop-lifecycle-"))
    const child = start([], root, root)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8") })
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8") })
    try {
      expect(await exited(child)).toBe(1)
      expect(stdout).toBe("")
      expect(stderr).toContain("--session-dir")
    } finally { child.kill(); rmSync(root, { recursive: true, force: true }) }
  }, 15_000)

  it("responds once to initialize and shutdown, then exits cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "ih-desktop-lifecycle-"))
    const workspace = join(root, "workspace")
    const sessions = join(root, "sessions")
    const config = join(root, "config")
    mkdirSync(workspace)
    mkdirSync(sessions)
    mkdirSync(config)
    writeFileSync(join(config, "settings.json"), JSON.stringify({ sandboxMode: "read-only" }), "utf8")
    const child = start(["--session-dir", sessions], workspace, config)
    let stdout = ""
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8") })
    try {
      child.stdin.write(encodeFrame(makeRequest(1, "initialize", {})))
      child.stdin.write(encodeFrame(makeRequest(2, "shutdown", {})))
      expect(await exited(child)).toBe(0)
      const frames = stdout.trim().split("\n").map((line) => JSON.parse(line) as { id?: number; result?: unknown })
      expect(frames.filter((frame) => frame.id === 1)).toHaveLength(1)
      expect(frames.filter((frame) => frame.id === 2)).toHaveLength(1)
      expect(frames.find((frame) => frame.id === 2)?.result).toEqual({ ok: true })
    } finally { child.kill(); rmSync(root, { recursive: true, force: true }) }
  }, 15_000)
})
