// @i-harness/tui — M46b G1: scroll streaming — the grok engine port
// (xai-grok-pager-render/src/input/mouse.rs, `MouseScrollState` +
// `ScrollConfig` + the constants at the module top; the delta Area-1 table).
//
// Semantics: discrete terminal wheel/trackpad events (SGR 64/65) become
// viewport line deltas through a STREAM model:
//   - streams: events are one gesture until an 80ms gap or a direction flip;
//   - normalization: per-terminal events-per-tick (One notch = ept events ×
//     lines-per-tick — ept=1 brands price one line per event, ept=3 brands
//     divide by 3 and price a notch only when ept events arrived);
//   - wheel promotion: first tick of events within 12ms → Wheel (fast click);
//     ept=1 terminals promote to Trackpad when the avg interval < 30ms;
//     an unclassified stream settles at finalize (gap): ≤2 events within
//     200ms on ept=1 → Wheel else Trackpad;
//   - interval acceleration (trackpad): 2.5× fast / 1.6× medium / 1× slow,
//     linear interp between bands, clamped to accel_max (3; VS-family windows
//     are widened because xterm.js embeds pace slower);
//   - per-flush cap: max(viewport/2, 6) (excess stays in the stream);
//   - coast taper: flush after input stops halves the remainder per tick with
//     a lines-per-tick floor, budgeted at ONE cap per stream (smooth coast);
//   - carry: sub-line fractional remainder only, across same-direction streams.
//
// DEVIATION (LOUD): grok gates event-bearing flushes on the 16ms redraw
// cadence (`GROK_SCROLL_CADENCE_MS`) and drives the drain from a dedicated
// scroll clock. Our loop has no scroll clock; its input pump coalesces
// repaints per microtask anyway, so `push()` flushes IMMEDIATELY whenever a
// flush would deliver lines (deterministic — a frozen/pinned test clock still
// scrolls) and `onTick()` keeps the cadence for the drain path (the loop's
// frame() tick routes through it; unit tests exercise timing math with an
// injected clock). The per-flush cap is the flood throttle in both paths.

// ------------------------------------------------------------------ constants (delta-mirrored)

export const GROK_SCROLL_GAP_MS = 80
export const GROK_SCROLL_CADENCE_MS = 16
export const GROK_WHEEL_LINES_PER_TICK = 3
export const GROK_TRACKPAD_LINES_PER_TICK = 3
export const GROK_WHEEL_TICK_DETECT_MAX_MS = 12
export const GROK_WHEEL_LIKE_MAX_DURATION_MS = 200
export const GROK_TRACKPAD_ACCEL_MAX = 3
export const GROK_TRACKPAD_DETECT_MAX_INTERVAL_MS = 30
export const GROK_MIN_DELTA_PER_FLUSH = 6
export const GROK_ACCEL_INTERVAL_FAST_MS = 8
export const GROK_ACCEL_INTERVAL_MEDIUM_MS = 20
export const GROK_ACCEL_MIN_INTERVAL_MS = 6
export const GROK_ACCEL_MULTIPLIER_FAST = 2.5
export const GROK_ACCEL_MULTIPLIER_MEDIUM = 1.6
export const GROK_ACCEL_HISTORY_SIZE = 6
export const GROK_MIN_LINES_PER_WHEEL_STREAM = 1

/** xterm.js embeds (VS Code and similar) emit scroll events more slowly than
 * native terminals — widened accel/trackpad windows + trackpad lines 15. */
function isVsEmbed(brand: string): boolean {
  return brand === "VsCode" || brand === "Cursor" || brand === "Windsurf"
}

/** Multiplexers that re-encode mouse into their own SGR stream — the outer
 * brand table then describes the wrong producer (conservative ept=1 shape). */
function multiplexerReencodes(multiplexer: string): boolean {
  return multiplexer === "tmux" || multiplexer === "screen" || multiplexer === "zellij" || multiplexer === "herdr"
}

/** The brand → events-per-tick profile table (delta Area 1; mouse.rs
 * `from_terminal_context`). `multiplexer` overrides with ept=1. Default
 * (unlisted brands incl. WindowsTerminal/Unknown) = 3. */
export function brandEventsPerTick(brand: string, multiplexer: string): number {
  if (multiplexerReencodes(multiplexer)) return 1
  switch (brand) {
    case "AppleTerminal": case "WarpTerminal": case "Alacritty": case "Rio": case "Foot":
    case "Ghostty": case "Kitty":
      return 3
    case "WezTerm": case "Iterm2": case "VsCode": case "Cursor": case "Windsurf": case "Zed":
      return 1
    default:
      return 3
  }
}

/** Wheel lines per tick: iTerm2/WezTerm = 1 (one event per notch pricing), the
 * default (all others incl. multiplexers) = 3. */
export function brandWheelLinesPerTick(brand: string, multiplexer: string): number {
  if (multiplexerReencodes(multiplexer)) return 1
  return brand === "Iterm2" || brand === "WezTerm" ? 1 : GROK_WHEEL_LINES_PER_TICK
}

/** Trackpad lines per tick: VS-family embeds 15 (they pace ~3× lower), else 3. */
export function brandTrackpadLinesPerTick(brand: string, multiplexer: string): number {
  if (multiplexerReencodes(multiplexer)) return GROK_TRACKPAD_LINES_PER_TICK
  return isVsEmbed(brand) ? 15 : GROK_TRACKPAD_LINES_PER_TICK
}

/** scroll_speed (1-100) → multiplier: 1→0.1×, 50→1.0× (default), 100→6.0×,
 * linear on both sides of 50. */
export function speedToMultiplier(speed: number): number {
  const s = Math.max(1, Math.min(100, speed))
  if (s <= 50) return 0.1 + (s - 1) * (0.9 / 49)
  return 1.0 + (s - 50) * (5.0 / 50)
}

// ------------------------------------------------------------------ config

export interface MouseStreamPrefs {
  /** 1-100 (50 = 1.0×). */
  speed: number
  mode: "auto" | "wheel" | "trackpad"
  /** 1-10 lines-per-tick override; undefined = the brand profile's own. */
  lines?: number
  invert: boolean
}

export interface ScrollStreamConfig {
  eventsPerTick: number
  wheelLinesPerTick: number
  trackpadLinesPerTick: number
  trackpadAccelMax: number
  mode: "auto" | "wheel" | "trackpad"
  wheelTickDetectMaxMs: number
  wheelLikeMaxMs: number
  invert: boolean
  accelFastMs: number
  accelMediumMs: number
  trackpadDetectMaxMs: number
  speedMultiplier: number
  viewportRows: number
}

/** Assembly: brand profile + the settings overrides (scroll_lines overrides
 * wheel+trackpad lines-per-tick together, like the grok knob). */
export function scrollStreamConfig(
  cap: { brand: string; multiplexer: string },
  prefs: MouseStreamPrefs,
  viewportRows = 24,
): ScrollStreamConfig {
  const vs = isVsEmbed(cap.brand) && !multiplexerReencodes(cap.multiplexer)
  return {
    eventsPerTick: brandEventsPerTick(cap.brand, cap.multiplexer),
    wheelLinesPerTick: prefs.lines ?? brandWheelLinesPerTick(cap.brand, cap.multiplexer),
    trackpadLinesPerTick: prefs.lines ?? brandTrackpadLinesPerTick(cap.brand, cap.multiplexer),
    trackpadAccelMax: GROK_TRACKPAD_ACCEL_MAX,
    mode: prefs.mode,
    wheelTickDetectMaxMs: GROK_WHEEL_TICK_DETECT_MAX_MS,
    wheelLikeMaxMs: GROK_WHEEL_LIKE_MAX_DURATION_MS,
    invert: prefs.invert,
    accelFastMs: vs ? 25 : GROK_ACCEL_INTERVAL_FAST_MS,
    accelMediumMs: vs ? 50 : GROK_ACCEL_INTERVAL_MEDIUM_MS,
    trackpadDetectMaxMs: vs ? 60 : GROK_TRACKPAD_DETECT_MAX_INTERVAL_MS,
    speedMultiplier: speedToMultiplier(prefs.speed),
    viewportRows,
  }
}

/** The per-flush cap: half the viewport, floored at 6 — tiny/unknown viewports
 * still move; a fixed cap exists so no single flush teleports the view. */
export function flushCapOf(cfg: ScrollStreamConfig): number {
  return Math.max(Math.floor(cfg.viewportRows / 2), GROK_MIN_DELTA_PER_FLUSH)
}

// ------------------------------------------------------------------ directions

export type ScrollDirection = "up" | "down"

function signOf(dir: ScrollDirection): 1 | -1 {
  return dir === "down" ? 1 : -1
}

// ------------------------------------------------------------------ engine

type StreamKind = "unknown" | "wheel" | "trackpad"

export interface ScrollUpdate {
  /** Whole lines to apply (negative = up). */
  lines: number
  /** Whether a stream is still active (the caller may schedule an onTick). */
  active: boolean
}

interface StreamState {
  start: number
  last: number
  dir: ScrollDirection
  events: number
  accumulated: number
  applied: number
  kind: StreamKind
  /** Rolling inter-event interval windows (>= 6ms batching filter). */
  intervals: number[]
  intervalSum: number
  /** Per-event accel-weighted accumulation (confirmed-trackpad demand). */
  accelWeighted: number
  eventsAtFlush: number
  coastSpent: number
  /** Gap-finalize bumped this stream over the 80ms seam. */
  finalized: boolean
}

export class ScrollStreamNormalizer {
  readonly config: ScrollStreamConfig
  /** Cadence for the drain path (ms). */
  readonly cadenceMs: number
  private stream: StreamState | undefined
  private lastRedrawAt = 0
  /** Sub-line fractional remainder carried across same-direction streams. */
  private carry = 0
  private carryDir: ScrollDirection | undefined
  private clock: () => number

  constructor(
    cap: { brand: string; multiplexer: string },
    prefs: MouseStreamPrefs,
    opts: { viewportRows?: number; cadenceMs?: number; now?: () => number } = {},
  ) {
    this.config = scrollStreamConfig(cap, prefs, opts.viewportRows ?? 24)
    this.cadenceMs = opts.cadenceMs ?? GROK_SCROLL_CADENCE_MS
    this.clock = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()))
  }

  /** Feed one wheel event. Returns the lines to apply (0 = nothing due yet). */
  push(dirIn: ScrollDirection, atMs?: number): ScrollUpdate {
    // The invert knob flips the direction BEFORE any stream math (grok's
    // `apply_direction` — the stream itself never sees the flip).
    const dir = this.config.invert ? (dirIn === "up" ? "down" : "up") : dirIn
    const now = atMs ?? this.clock()
    let lines = 0
    if (this.stream === undefined && this.carryDir !== dir) {
      // Direction change between streams resets the carry (the remainder was
      // for the other direction).
      this.carry = 0
      this.carryDir = dir
    }
    if (this.stream !== undefined) {
      const gap = now - this.stream.last
      if (gap > GROK_SCROLL_GAP_MS || this.stream.dir !== dir) {
        // Flip or gap: finalize the old stream (a flip cancels its backlog —
        // reversal must be instant, never preceded by a stale opposite jump).
        const cancel = this.stream.dir !== dir
        lines += this.finalize(now, cancel)
      }
    }
    if (this.stream === undefined) {
      this.stream = this.newStream(now, dir)
    }
    this.pushEvent(now, dir)
    // A wheel promotion (first tick ≤12ms) implies immediate flush in grok;
    // our push path flushes immediately regardless (header deviation), so the
    // promotion's only surviving role is pricing (kind switch).
    this.promote(now)
    lines += this.flush(now)
    return { lines, active: true }
  }

  /** Drain check: flush the tapered remainder + finalize at the 80ms gap.
   * The loop calls it on its frame tick while a stream is active. */
  onTick(atMs?: number): ScrollUpdate {
    const now = atMs ?? this.clock()
    if (this.stream === undefined) return { lines: 0, active: false }
    let lines = 0
    const s = this.stream
    const gap = now - s.last
    if (gap > GROK_SCROLL_GAP_MS && this.flushable(now) === 0) {
      lines = this.finalize(now, false)
      return { lines, active: false }
    }
    if (now - this.lastRedrawAt >= this.cadenceMs) {
      lines = this.flush(now)
    }
    return { lines, active: true }
  }

  hasActiveStream(): boolean {
    return this.stream !== undefined
  }

  reset(): void {
    this.stream = undefined
    this.carry = 0
    this.carryDir = undefined
  }

  // ------------------------------------------------------------------ internals

  private newStream(now: number, dir: ScrollDirection): StreamState {
    this.lastRedrawAt = now
    return {
      start: now,
      last: now,
      dir,
      events: 0,
      accumulated: 0,
      applied: 0,
      kind: "unknown",
      intervals: [],
      intervalSum: 0,
      accelWeighted: 0,
      eventsAtFlush: 0,
      coastSpent: 0,
      finalized: false,
    }
  }

  private pushEvent(now: number, dir: ScrollDirection): void {
    const s = this.stream!
    if (s.events > 0) {
      const interval = Math.max(0, now - s.last)
      if (interval >= GROK_ACCEL_MIN_INTERVAL_MS) {
        s.intervals.push(interval)
        s.intervalSum += interval
        if (s.intervals.length > GROK_ACCEL_HISTORY_SIZE) s.intervalSum -= s.intervals.shift()!
      }
    }
    s.last = now
    s.dir = dir
    s.events++
    s.accumulated += signOf(dir)
    s.accelWeighted += signOf(dir) * this.intervalAccel(s)
    if (this.confirmedTrackpad(s)) this.clampTrackpadDemand(s)
  }

  /** Auto-mode classification; returns true when a wheel promotion happened
   * this event (grok `just_promoted` — flush immediately on promotion). */
  private promote(now: number): boolean {
    const s = this.stream!
    if (this.config.mode !== "auto" || s.kind !== "unknown") return false
    const ept = this.config.eventsPerTick
    if (ept <= 1 && s.events > 2) {
      const avg = s.intervals.length > 0 ? s.intervalSum / s.intervals.length : undefined
      if (avg !== undefined && avg < this.config.trackpadDetectMaxMs) {
        s.kind = "trackpad"
        return false
      }
    }
    if (ept >= 2 && s.events >= ept && now - s.start <= this.config.wheelTickDetectMaxMs) {
      s.kind = "wheel"
      return true
    }
    return false
  }

  /** Stable classification at the gap: unknown → (ept=1 low event count, short
   * duration) wheel else trackpad; mode-forced kinks settle immediately. */
  private finalizeKind(): void {
    const s = this.stream!
    if (this.config.mode === "wheel") {
      s.kind = "wheel"
      return
    }
    if (this.config.mode === "trackpad") {
      s.kind = "trackpad"
      return
    }
    if (s.kind !== "unknown") return
    const duration = s.last - s.start
    if (this.config.eventsPerTick <= 1 && s.events <= 2 && duration <= this.config.wheelLikeMaxMs) {
      s.kind = "wheel"
    } else {
      s.kind = "trackpad"
    }
  }

  private intervalAccel(s: StreamState): number {
    if (s.intervals.length === 0) return 1
    const avg = s.intervalSum / s.intervals.length
    const { accelFastMs, accelMediumMs } = this.config
    let raw: number
    if (avg <= accelFastMs) raw = GROK_ACCEL_MULTIPLIER_FAST
    else if (avg <= accelMediumMs) {
      const t = (avg - accelFastMs) / (accelMediumMs - accelFastMs)
      raw = GROK_ACCEL_MULTIPLIER_FAST + t * (GROK_ACCEL_MULTIPLIER_MEDIUM - GROK_ACCEL_MULTIPLIER_FAST)
    } else raw = 1
    return Math.max(1, Math.min(raw, this.config.trackpadAccelMax))
  }

  private isWheelLike(s: StreamState): boolean {
    if (this.config.mode === "wheel") return true
    if (this.config.mode === "trackpad") return false
    return s.kind === "wheel" || (s.kind === "unknown" && this.config.eventsPerTick <= 1)
  }

  private confirmedTrackpad(s: StreamState): boolean {
    if (this.config.mode === "trackpad") return true
    if (this.config.mode === "wheel") return false
    return s.kind === "trackpad"
  }

  /** Lines-per-tick under the CURRENT kind (auto: wheel→wheel lines, trackpad
   * →trackpad lines, unknown→ ept≤1 priced as wheel else trackpad). */
  private linesPerTick(s: StreamState): number {
    if (this.config.mode === "wheel") return this.config.wheelLinesPerTick
    if (this.config.mode === "trackpad") return this.config.trackpadLinesPerTick
    switch (s.kind) {
      case "wheel": return this.config.wheelLinesPerTick
      case "trackpad": return this.config.trackpadLinesPerTick
      case "unknown": return this.config.eventsPerTick <= 1
        ? this.config.wheelLinesPerTick
        : this.config.trackpadLinesPerTick
    }
  }

  /** Final-line-unit pricing: confirmed trackpad accel-weights per event over
   * the normalized ept=3 divisor; wheel/unknown price the raw event count
   * over the terminal's real events-per-tick. Carry rides OUTSIDE every
   * multiplier (unit invariant). */
  private desiredLines(s: StreamState): number {
    const lpt = this.linesPerTick(s)
    const ept = this.confirmedTrackpad(s)
      ? 3 // normalized divisor for trackpad (all brands get the same rate)
      : this.config.eventsPerTick
    const base = this.confirmedTrackpad(s)
      ? s.accelWeighted
      : s.accumulated
    return base * (lpt / ept) * this.config.speedMultiplier + this.carry
  }

  /** Accumulation-time demand truncation for confirmed trackpad: the accel-
   * weighted total may not price past max(raw accel-free pricing, applied +
   * one flush cap) — a flood's excess never enters desired. */
  private clampTrackpadDemand(s: StreamState): void {
    const rate = (this.linesPerTick(s) / 3) * this.config.speedMultiplier
    if (rate <= 0) return
    const raw = Math.abs(s.accumulated) * rate
    const honorable = Math.abs(s.applied) + flushCapOf(this.config)
    const ceiling = Math.max(raw, honorable)
    if (Math.abs(s.accelWeighted) * rate > ceiling) {
      s.accelWeighted = Math.sign(s.accelWeighted || 1) * (ceiling / rate)
    }
  }

  /** Truncated desired minus applied, with the wheel-like minimum-line
   * substitution and the direction clamp. */
  private effectivePending(s: StreamState): number {
    let desired = Math.trunc(this.desiredLines(s))
    if (this.isWheelLike(s) && desired === 0 && s.accumulated !== 0) {
      desired = Math.sign(s.accumulated) * GROK_MIN_LINES_PER_WHEEL_STREAM
    }
    let delta = desired - s.applied
    if (s.accumulated > 0) delta = Math.max(0, delta)
    else if (s.accumulated < 0) delta = Math.min(0, delta)
    return delta
  }

  /** Whether a flush right now would deliver lines (the pending predicate;
   * no-op flushes leave lastRedrawAt stale). Coast flushes taper: half the
   * remainder per tick, floored at lines-per-tick, budgeted at one cap. */
  private flushable(_now: number): number {
    const s = this.stream!
    const pending = this.effectivePending(s)
    if (pending === 0) return 0
    const cap = flushCapOf(this.config)
    const coasting = s.events === s.eventsAtFlush
    const mag = coasting
      ? Math.min(
          Math.abs(pending),
          Math.max(Math.abs(pending) / 2, Math.abs(this.linesPerTick(s))),
          Math.max(0, cap - s.coastSpent),
        )
      : Math.min(Math.abs(pending), cap)
    return Math.sign(pending) * mag
  }

  /** Deliver the flushable delta; a no-op must return 0 and NOT advance the
   * redraw clock. `coast` flushes account against the one-cap budget. */
  private flush(now: number): number {
    const s = this.stream!
    const delta = this.flushable(now)
    if (delta === 0) return 0
    if (s.events === s.eventsAtFlush) s.coastSpent += Math.abs(delta)
    s.applied += delta
    s.eventsAtFlush = s.events
    this.lastRedrawAt = now
    return delta
  }

  /** Close the stream (gap/flip). Non-wheel streams settle the fractional
   * remainder into the carry; cap-induced integer backlog is discarded. */
  private finalize(now: number, cancelBacklog: boolean): number {
    const s = this.stream!
    this.finalizeKind()
    const desired = this.desiredLines(s)
    const lines = cancelBacklog ? 0 : this.flush(now)
    if (s.kind !== "wheel" && this.config.mode !== "wheel") {
      const remainder = desired - s.applied
      // fract() of an EXACT double (e.g. 1.0 - 1) can carry 1e-16 dust that
      // would flip the next trunc toward zero (a real head-lock bug: -1 +
      // dust → trunc → -0 → no flush). Anything below 1e-9 is zero.
      const rem = remainder - Math.trunc(remainder)
      this.carry = Math.abs(rem) < 1e-9 ? 0 : rem
    } else {
      this.carry = 0
    }
    this.stream = undefined
    return lines
  }
}

/** Alias export (the delta name) — the event-driven entry point. */
export type StreamNormalizer = ScrollStreamNormalizer
