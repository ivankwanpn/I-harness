// M39 G1: case-017 — the M37b interaction matrix at REAL-PTY level, ONE run:
//   permission freeform reject + question + /btw + session picker + history.
//   The host surfaces approvals/questions through the REAL createApprovalBridge
//   (fake ctx — approval.test.ts parity) and the overlay seam path so these
//   five interactions prove end-to-end (surface → draw → key → decision).
//   Pacing: every interaction is marker-cued (host markers + wait-screen pins
//   + the fs exit gate "request-exit") — no cross-channel ordering assumed.

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import { expect, test } from "vitest"
import { spawnHost } from "./runner.ts"
import type { HostPty } from "./runner.ts"
import { VirtualTerminal } from "./virtual.ts"
import { runScenario } from "./referee.ts"
import type { Scene } from "./referee.ts"

const HOST_FILE = fileURLToPath(new URL("./host-017.ts", import.meta.url))

test(
  "case-017: interaction matrix (freeform reject / question / btw / picker / history)",
  async () => {
    const scene = parse(
      readFileSync(fileURLToPath(new URL("./case-017.yaml", import.meta.url)), "utf8"),
    ) as Scene

    const markerDir = mkdtempSync(join(tmpdir(), "tui-case-017-"))
    let runner: HostPty | undefined
    let off: (() => void) | undefined
    try {
      runner = spawnHost({
        hostFile: HOST_FILE,
        markerDir,
        cols: scene.size[0],
        rows: scene.size[1],
        extraArgv: ["017", `${scene.size[0]}x${scene.size[1]}`],
      })
      const virtual = new VirtualTerminal(scene.size[0], scene.size[1])
      off = runner.onData((d) => virtual.write(d))

      const result = await runScenario(scene, { runner, virtual, markerDir })
      expect(result.ok, result.ok ? "ok" : `scenario failed: ${result.error}`).toBe(true)
    } finally {
      off?.()
      if (runner !== undefined) {
        try {
          runner.pty.kill()
        } catch {
          /* already dead */
        }
      }
      rmSync(markerDir, { recursive: true, force: true })
    }
  },
  120_000,
)
