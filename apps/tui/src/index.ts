// apps/tui — the tui command (M37a G4).
//
// This is THIN: the wheel's logic lives in @i-harness/tui (app loop + engine +
// embedded backend); here is only the host wiring — flags, capabilities probe,
// terminal init/teardown, stdin input bridge, stdout renderer, resize relay,
// and process lifecycle. Keep it that way.
//
// Usage: node --import tsx apps/tui/src/index.ts [--prompt <text>]
//                [--workspace <dir>] [--model <spec>] [--yes] [--resume <id>]
//
// M37a seams (see packages/tui/src/backend/embedded.ts module header):
//   - the session store is MOCK-ONLY (in-memory, per-process); --resume /
//     --model are accepted and ignored (TODO M38: wire the coordinator +
//     modelBuilder with settings/credentials like apps/cli/src/web.ts).
//   - capabilities: probeCapabilities() with a 2 s outer cap; a PTY / no-
//     answer terminal falls back to createUnknownCapabilities() (its
//     env-derived colorLevel still lands even without replies). The deep
//     probe-reply feed (raw stdin → ProbeClient) is M37b; stray OSC/DCS
//     replies are swallowed by tui-core's InputParser.
//   - Smoke caveat: an interactive run needs a REAL tty stdin. Under a pipe /
//     non-tty shell the raw-mode attach is skipped and the run stays alive on
//     the embedded stream (no keyboard, no way to quit) — by design; the
//     automated proof is packages/tui/test/harness (PTY cases 011/014).

import { pathToFileURL } from "node:url"
import { execSync } from "node:child_process"
import {
  attachInput,
  createRenderer,
  createTerminal,
  createUnknownCapabilities,
  makeGlyphs,
  probeCapabilities,
  resolvePalette,
} from "@i-harness/tui-core"
import type { InputEvent, TerminalCapabilityContext } from "@i-harness/tui-core"
import { createScrollbackEngine, defaultEmbeddedFactory, TuiApp } from "@i-harness/tui"
import type { BackendClient, InputSource } from "@i-harness/tui"

// ------------------------------------------------------------------ flags

export interface TuiFlags {
  prompt?: string
  workspace?: string
  model?: string
  yes: boolean
  resume?: string
}

export function parseFlags(argv: string[]): TuiFlags {
  const flags: TuiFlags = { yes: false }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--prompt": flags.prompt = argv[++i]; break
      case "--workspace": flags.workspace = argv[++i]; break
      case "--model": flags.model = argv[++i]; break
      case "--yes": flags.yes = true; break
      case "--resume": flags.resume = argv[++i]; break
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: tui [--prompt <text>] [--workspace <dir>] [--model <spec>]\n" +
          "           [--yes] [--resume <sessionId>]\n",
        )
        process.exit(0)
    }
  }
  return flags
}

// ------------------------------------------------------------------ stdout

let epipe = false

/** Write sink wrapper: EPIPE on a closed terminal is swallowed; anything else
 * rethrows. Mirrors packages/tui-core/test/harness/host-010.ts. */
function out(s: string): void {
  if (epipe) return
  try {
    process.stdout.write(s)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "EPIPE") epipe = true
    else throw e
  }
}

// ------------------------------------------------------------------ main

export async function runTui(flags: TuiFlags): Promise<number> {
  // M37a Windows fix (same as the M36 PTY harness): ConPTY converts the wire
  // stream with the console output codepage unless the console is UTF-8 —
  // multibyte TUI glyphs (❯ ◆ ⠼ …) would be mangled on a legacy codepage.
  if (process.platform === "win32") {
    try {
      execSync("chcp.com 65001>NUL", { stdio: "ignore" })
    } catch {
      /* best-effort; UTF-8 conhost is the common case */
    }
  }

  const workspace = flags.workspace ?? process.cwd()

  // Capabilities: the probe writes its queries to stdout; a PTY / no-answer
  // terminal resolves to the env-derived defaults (2 s outer cap on top of
  // the probe's own 500 ms deadline).
  const cap: TerminalCapabilityContext = await Promise.race([
    probeCapabilities(() => ({ write: (s) => process.stdout.write(s) })),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
  ])
    .then((c) => (c === "timeout" ? createUnknownCapabilities() : c))
    .catch(() => createUnknownCapabilities())

  // Backend: M37a mock-first — forceMock:true keeps the cyclic mock default.
  // TODO M38: --model → modelBuilder (settings+credentials seam like apps/cli
  // buildModelFor); --resume/storeRoot → coordinator loadMeta + seed.
  const base = await defaultEmbeddedFactory({
    workspace,
    prompt: flags.prompt ?? "",
    forceMock: true,
  })

  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 24
  const terminal = createTerminal({
    stream: { write: (s: string): boolean => { out(s); return true } },
    cap,
  })
  const renderer = createRenderer({ cols, rows, cap })
  const engine = createScrollbackEngine({ width: cols })

  // Input bridge: attachInput pushes parser events into a queue the TuiApp's
  // input pump drains; when the backend close()s (app quit path), the queue
  // closes so stop()/start() can resolve without a live keyboard.
  const inputQueue: InputEvent[] = []
  let inputWake: (() => void) | undefined
  let inputEnded = false
  const endInput = (): void => {
    inputEnded = true
    inputWake?.()
    inputWake = undefined
  }
  const input: InputSource = {
    async *next(): AsyncIterable<InputEvent> {
      for (;;) {
        while (inputQueue.length > 0) yield inputQueue.shift()!
        if (inputEnded) return
        await new Promise<void>((r) => {
          inputWake = r
        })
      }
    },
  }
  const backend: BackendClient = {
    ...base,
    close: async () => {
      endInput()
      await base.close()
    },
  }

  // Raw-mode attach — only possible on a real tty. On a non-tty stdin (pipes,
  // CI) skip the keyboard; the run stays alive on the backend stream.
  let attach: ReturnType<typeof attachInput> | undefined
  try {
    attach = attachInput({
      stdin: process.stdin,
      onEvent: (ev) => {
        inputQueue.push(ev)
        inputWake?.()
      },
      cap,
    })
    attach.start()
  } catch {
    // not a tty → no keyboard; the input pump is simply never wired
  }

  const app = new TuiApp({
    renderer,
    backend,
    engine,
    capabilities: cap,
    palette: resolvePalette(cap),
    glyphs: makeGlyphs(true),
    write: out,
    ...(attach !== undefined ? { input } : {}),
  })

  terminal.init()

  // Resize relay: stdout 'resize' → renderer re-grid + engine re-wrap; the
  // next frame is a full paint (renderer internal), zero-byte idle untouched.
  process.stdout.on("resize", () => {
    try {
      const c = process.stdout.columns ?? cols
      const r = process.stdout.rows ?? rows
      renderer.resize(c, r)
      engine.setWidth(c)
    } catch {
      /* mid-shutdown: ignore */
    }
  })

  // Lifecycle: the app quit path (Ctrl-Q / armed Ctrl-C) → backend.close →
  // input ended → start() resolves → graceful teardown. SIGINT/SIGTERM are
  // the first-graceful paths (raw mode means Ctrl-C never becomes SIGINT).
  const shutdown = (): void => {
    try { attach?.stop() } catch { /* already gone */ }
    try { terminal.teardown() } catch { /* already gone */ }
  }
  process.once("SIGINT", () => {
    shutdown()
    process.exit(130)
  })
  process.once("SIGTERM", () => {
    shutdown()
    process.exit(143)
  })

  await app.start()

  shutdown()
  return 0
}

// Entry guard: invoke runTui() only when this module is executed directly as
// the process entry point (e.g. `node --import tsx apps/tui/src/index.ts`),
// never when imported (tests, other modules). File-URL comparison — same
// pattern as apps/cli.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTui(parseFlags(process.argv.slice(2))).then((code) => process.exit(code))
}
