// @i-harness/tui-core — TUI renderer layer (M36).
// Surface frozen at G4: createRenderer / createTerminal / attachInput /
// probeCapabilities / resolveScreenMode / createUnknownCapabilities /
// InputParser / WriterPump / resolvePalette+quantizeColor / GlyphSet+makeGlyphs
// / wcwidth+clusterWidth.
// Runtime dependencies: none (grid/wcwidth/glyphs/ansi/render/theme/terminal
// /input/probe/screen-mode/output are self-contained).

import { createRenderer } from "./renderer.ts"
import type { Renderer, RendererOptions } from "./renderer.ts"
import { initSequence, teardownSequence, TeardownGuard } from "./terminal/index.ts"
import { InputParser } from "./input/index.ts"
import type { InputEvent } from "./input/index.ts"
import { probeCapabilities } from "./probe/index.ts"
import { createUnknownCapabilities } from "./types.ts"
import type { TerminalCapabilityContext } from "./types.ts"
import { WriterPump } from "./output/index.ts"
import type { WriterLike, WriterStats } from "./output/index.ts"
import { resolveScreenMode } from "./screen-mode/index.ts"
import type { ScreenMode, ScreenModeResolution } from "./screen-mode/index.ts"
import { resolvePalette, quantizeColor } from "./theme/index.ts"
import type { Palette, Rgb, ThemeKind } from "./theme/index.ts"
import { makeGlyphs, GLYPHS } from "./glyphs/index.ts"
import type { GlyphSet } from "./glyphs/index.ts"
import { wcwidth, clusterWidth } from "./wcwidth/index.ts"
import type { DiffFrame } from "./grid/index.ts"

export { createRenderer }
export type { Renderer, RendererOptions, DiffFrame }

// ------------------------------------------------------------------ terminal

export interface TerminalHandles {
  /** Writes initSequence(cap) via stream.write; returns the bytes written. */
  init(): string
  /** One-shot teardown: writes teardownSequence(cap) via stream.write exactly
   * once (TeardownGuard — repeat calls return "" and write nothing). */
  teardown(): string
}

export interface CreateTerminalOptions {
  stream: { write(s: string): boolean }
  cap?: TerminalCapabilityContext
}

export function createTerminal(opts: CreateTerminalOptions): TerminalHandles {
  if (
    opts === null || typeof opts !== "object" ||
    opts.stream === null || typeof opts.stream !== "object" ||
    typeof opts.stream.write !== "function"
  ) {
    throw new TypeError("createTerminal: stream.write(s) is required")
  }
  const cap = opts.cap ?? createUnknownCapabilities()
  const guard = new TeardownGuard(teardownSequence(cap))
  return {
    init(): string {
      const bytes = initSequence(cap)
      opts.stream.write(bytes)
      return bytes
    },
    teardown(): string {
      if (!guard.invoke()) return "" // idempotent: already torn down
      const bytes = guard.sequence
      opts.stream.write(bytes)
      return bytes
    },
  }
}

// ------------------------------------------------------------------ input

export interface TtyStream {
  isTTY?: boolean
  setRawMode?(mode: boolean): unknown
  on(event: string, cb: (chunk: unknown) => void): unknown
  off(event: string, cb: (chunk: unknown) => void): unknown
}

export interface AttachInputOptions {
  /** process.stdin shape: { isTTY, setRawMode, on/off, read }. */
  stdin: TtyStream
  onEvent: (ev: InputEvent) => void
  cap?: TerminalCapabilityContext
}

export interface InputAttach {
  /** Sets raw mode, starts pushing stdin bytes into InputParser. */
  start(): void
  /** Unsets raw mode, stops feeding (repeat calls are no-ops). */
  stop(): void
}

export function attachInput(opts: AttachInputOptions): InputAttach {
  if (
    opts === null || typeof opts !== "object" ||
    opts.stdin === null || typeof opts.stdin !== "object" ||
    typeof opts.onEvent !== "function"
  ) {
    throw new TypeError("attachInput: stdin (tty stream) and onEvent are required")
  }
  const stdin = opts.stdin
  if (typeof stdin.on !== "function" || typeof stdin.off !== "function") {
    throw new TypeError("attachInput: stdin must be a stream (on/off required)")
  }
  const cap = opts.cap ?? createUnknownCapabilities()
  const parser = new InputParser()
  const onData = (chunk: unknown): void => {
    const data: Uint8Array | string =
      typeof chunk === "string" ? chunk
      : chunk instanceof Uint8Array ? chunk
      : new Uint8Array(0)
    for (const ev of parser.push(data, cap)) opts.onEvent(ev)
  }
  let running = false
  return {
    start(): void {
      if (running) return
      if (stdin.isTTY === false || typeof stdin.setRawMode !== "function") {
        throw new TypeError("attachInput: start() requires a tty stdin (isTTY && setRawMode)")
      }
      stdin.on("data", onData)
      stdin.setRawMode(true)
      running = true
    },
    stop(): void {
      if (!running) return
      stdin.setRawMode?.(false)
      stdin.off("data", onData)
      running = false
    },
  }
}

// ------------------------------------------------------------------ re-exports

export { probeCapabilities }
export { createUnknownCapabilities }
export type { TerminalCapabilityContext }
export { InputParser }
export type { InputEvent }
export { WriterPump }
export type { WriterLike, WriterStats }
export { resolveScreenMode }
export type { ScreenMode, ScreenModeResolution }
export { resolvePalette, quantizeColor }
export type { Palette, Rgb, ThemeKind }
export { makeGlyphs, GLYPHS }
export type { GlyphSet }
export { wcwidth, clusterWidth }
