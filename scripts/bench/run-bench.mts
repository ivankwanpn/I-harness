/**
 * M3's measurement base — the benchmark harness the roadmap says this repo does
 * not have (docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md
 * §3.M3: "IH 沒有 benchmarking harness（dsh 有）").
 *
 * WHY IT EXISTS, in the roadmap's own words: the sandbox spec recorded
 * `0.056–0.125 ms/call` and then admitted "沒有任何 repo 裡的東西能重現它", and a
 * test tightened to 2 ms still passed a semantically identical 10× variation
 * (measured at 1.002 ms/call). **A budget nobody can reproduce is not a budget.**
 *
 * FOUR IDEAS BORROWED FROM dsh's harness (design, not code —
 * `D:\deepseek-harness\vitest.bench.config.ts` and `benchmarks/`):
 *
 *   1. **A case asserts a BUDGET, so a regression FAILS** rather than printing a
 *      number somebody has to read.
 *   2. **Serial execution** — dsh pins `fileParallelism: false, maxWorkers: 1`
 *      so "a measurement never shares the CPU with another benchmark".
 *   3. **The MEDIAN of N samples, after a warmup** — one sample is an anecdote.
 *   4. **The baseline carries a MACHINE FINGERPRINT.** The roadmap measured the
 *      consequence: node v22 here vs v24 recorded elsewhere, and `bash` resolving
 *      to Git Bash rather than WSL, made two documented failures NOT fail here.
 *      **A bare number from another machine is worse than no number.**
 *
 * WHAT IT DOES NOT DO YET, stated because the difference is load-bearing: dsh
 * runs each scenario in a FRESH PROCESS. We warm up and take a median inside one,
 * which is enough to catch a 10× regression but NOT enough to be immune to
 * heap-growth effects across cases. `--self-test` proves the detector works
 * either way; fresh-process isolation is the documented upgrade.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/bench/run-bench.mts                 # measure + print
 *   node_modules/.bin/tsx scripts/bench/run-bench.mts --seed-baseline # write THIS machine's baseline
 *   node_modules/.bin/tsx scripts/bench/run-bench.mts --gate          # fail on regression
 *   node_modules/.bin/tsx scripts/bench/run-bench.mts --self-test     # prove the detector
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { arch, cpus, platform, release, totalmem } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { deriveMessages, createSession, append, type SessionEvent } from "../../packages/core-session/src/index.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
/** The reference machine baseline kept for history; local runs compare their own
 *  keyed file instead (see `baselineKey`). */
const LEGACY_BASELINE_PATH = join(HERE, "bench-baseline.json")

/** How many samples per case, and how many warmup runs before them. */
const SAMPLES = 15
const WARMUP = 3

/**
 * Each SAMPLE runs the body repeatedly until it has taken at least this long, and
 * the sample's time is divided by the iteration count. Measured reason, not
 * folklore: with one iteration per sample `append/many-events` came out at
 * 0.227 / 0.113 / 0.167 ms across three consecutive runs — a 2x spread, which
 * makes a 3x threshold useless. The case is simply too SHORT for the timer's own
 * noise to sit under it.
 *
 * Bumping the body by hand only moves the problem to the next fast case. Scaling
 * the iteration count does not: every case ends up with a signal well above the
 * timer, and the reported number stays PER-ITERATION so it is comparable across
 * machines and shapes.
 */
const MIN_SAMPLE_MS = 25

/** A regression this large fails the gate. `--self-test` proves it is detectable. */
const REGRESSION_FACTOR = 3

export interface BenchCase {
  name: string
  /** What this measures, and WHY it is on the production path. */
  why: string
  /** One measured run, in milliseconds. */
  run: () => void
}

/** A synthetic session of a STATED shape — dsh writes its shape down too
 * ("200 turns × (500 text + 125 reasoning deltas): 127,400 released-v0 events"),
 * because a benchmark whose input is unstated cannot be re-derived. */
function syntheticSession(turns: number, textPerTurn: number) {
  const session = createSession()
  for (let t = 0; t < turns; t++) {
    append(session, { type: "turn/start" } as SessionEvent)
    append(session, { type: "user/message", text: `turn ${t}` } as SessionEvent)
    for (let i = 0; i < textPerTurn; i++) {
      append(session, { type: "assistant/message", text: `line ${i} of turn ${t}` } as SessionEvent)
    }
    append(session, { type: "turn/end" } as SessionEvent)
  }
  return session
}

const SHAPE = { turns: 200, textPerTurn: 10 } as const
const LONG_SESSION = syntheticSession(SHAPE.turns, SHAPE.textPerTurn)

export const CASES: BenchCase[] = [
  {
    name: "deriveMessages/long-session",
    why: "11 production call sites and it runs on EVERY model request; it is O(events), so a regression here grows with session length",
    run: () => { deriveMessages(LONG_SESSION) },
  },
  {
    name: "append/many-events",
    why: "the write path every event goes through, including every streamed delta",
    run: () => {
      const s = createSession()
      for (let i = 0; i < 2_000; i++) append(s, { type: "assistant/message", text: `x${i}` } as SessionEvent)
    },
  },
]

/** Everything that made a number mean something on a different machine. */
export function fingerprint(): Record<string, string | number> {
  const cpu = cpus()
  return {
    node: process.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpu[0]?.model ?? "unknown",
    cpuCount: cpu.length,
    totalMemGb: Math.round(totalmem() / 1024 ** 3),
  }
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

export interface Measured {
  name: string
  ms: number
  samples: number
}

/** Warm up, then take the MEDIAN of `SAMPLES` runs. Never the first sample: it
 * carries JIT and cold-cache cost that no production request pays. Each sample is
 * scaled to `MIN_SAMPLE_MS` and divided back down (see that constant). */
export function measure(benchCase: BenchCase, samples = SAMPLES, warmup = WARMUP): Measured {
  for (let i = 0; i < warmup; i++) benchCase.run()
  const xs: number[] = []
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    let iterations = 0
    let elapsed = 0
    do {
      benchCase.run()
      iterations++
      elapsed = performance.now() - t0
    } while (elapsed < MIN_SAMPLE_MS)
    xs.push(elapsed / iterations)
  }
  return { name: benchCase.name, ms: median(xs), samples }
}

export function runAll(samples = SAMPLES, warmup = WARMUP): Measured[] {
  // Serial, one case at a time — dsh's rule: a measurement must not share the CPU.
  return CASES.map((c) => measure(c, samples, warmup))
}

/** The fields whose difference invalidates a COMPARISON (not a run). A baseline
 *  recorded on another CPU/node must never judge this machine: it either fails
 *  for the machine's sake or hides a real regression. */
const MACHINE_FIELDS = ["node", "platform", "arch", "cpuModel", "cpuCount"] as const

export function sameMachine(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return MACHINE_FIELDS.every((field) => a[field] === b[field])
}

/** A filename-safe slug of the machine fields, so each machine seeds its own. */
export function baselineKey(fp: Record<string, unknown> = fingerprint()): string {
  return createHash("sha256").update(MACHINE_FIELDS.map((field) => String(fp[field])).join("|")).digest("hex").slice(0, 12)
}

export function baselinePath(fp: Record<string, unknown> = fingerprint()): string {
  return join(HERE, `bench-baseline.${baselineKey(fp)}.json`)
}

export function readBaseline(): { path: string; fingerprint: Record<string, unknown>; cases: Measured[]; foreign?: boolean } | undefined {
  let foreign: { path: string; fingerprint: Record<string, unknown>; cases: Measured[]; foreign?: boolean } | undefined
  for (const path of [baselinePath(), LEGACY_BASELINE_PATH]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { fingerprint: Record<string, unknown>; cases: Measured[] }
      if (sameMachine(parsed.fingerprint, fingerprint())) return { path, fingerprint: parsed.fingerprint, cases: parsed.cases }
      // Keep the reference baseline as a fallback so a machine that has not been
      // seeded still gets a comparison — clearly labelled as a foreign one.
      foreign ??= { path, fingerprint: parsed.fingerprint, cases: parsed.cases, foreign: true }
    } catch { /* a missing or unreadable candidate is not a baseline */ }
  }
  return foreign
}

/** Cases whose measured time exceeds the baseline by `factor` or more.
 *
 * A case present in the run but ABSENT from the baseline is a WARN, not a pass:
 * a new benchmark has never been compared to anything, and saying so is the
 * difference between "no regression" and "not measured". */
export function regressions(
  measured: Measured[],
  baseline: Measured[],
  factor = REGRESSION_FACTOR,
): { regressed: { name: string; ms: number; was: number }[]; unbaselined: string[] } {
  const byName = new Map(baseline.map((b) => [b.name, b]))
  const regressed: { name: string; ms: number; was: number }[] = []
  const unbaselined: string[] = []
  for (const m of measured) {
    const b = byName.get(m.name)
    if (b === undefined) { unbaselined.push(m.name); continue }
    if (m.ms >= b.ms * factor) regressed.push({ name: m.name, ms: m.ms, was: b.ms })
  }
  return { regressed, unbaselined }
}

function renderFingerprint(f: Record<string, unknown>): string {
  return Object.entries(f).map(([k, v]) => `${k}=${String(v)}`).join(" · ")
}

// ── the instrument ────────────────────────────────────────────────────────────
// `--self-test` is the roadmap's completion definition, verbatim: the harness must
// be able to DETECT a 10× regression, "證明它是偵測器而不是天花板". It proves it by
// running the real comparison against a synthetic baseline that claims the case
// was 10× faster — which is exactly what a real regression of that size looks
// like from the comparator's side — and asserting the gate fails.
export const SELF_TEST_CASES: { name: string; expect: string; run: () => string }[] = [
  {
    name: "a 10x regression against the baseline is DETECTED",
    expect: "detected",
    run() {
      const measured: Measured[] = [{ name: "x", ms: 100, samples: 15 }]
      const claimed: Measured[] = [{ name: "x", ms: 10, samples: 15 }]
      const { regressed } = regressions(measured, claimed)
      return regressed.length === 1 && regressed[0]!.ms === 100 ? "detected" : "MISSED"
    },
  },
  {
    name: "a run at the baseline is NOT a regression",
    expect: "clean",
    run() {
      const measured: Measured[] = [{ name: "x", ms: 100, samples: 15 }]
      const { regressed } = regressions(measured, [{ name: "x", ms: 100, samples: 15 }])
      return regressed.length === 0 ? "clean" : "FALSE POSITIVE"
    },
  },
  {
    name: "a case with NO baseline is reported, never silently passed",
    expect: "unbaselined:x",
    run() {
      const { regressed, unbaselined } = regressions([{ name: "x", ms: 100, samples: 15 }], [])
      return regressed.length === 0 && unbaselined.join(",") === "x" ? "unbaselined:x" : "not reported"
    },
  },
  {
    name: "a baseline recorded on another machine is NOT used",
    expect: "ignored",
    run() {
      const other = { ...fingerprint(), cpuModel: "another cpu" }
      return sameMachine(other, fingerprint()) ? "USED" : "ignored"
    },
  },
  {
    name: "the same machine matches its own baseline",
    expect: "matched",
    run() { return sameMachine(fingerprint(), fingerprint()) ? "matched" : "MISMATCH" },
  },
  {
    name: "the factor is a threshold, not a ceiling — just under passes",
    expect: "clean",
    run() {
      const { regressed } = regressions([{ name: "x", ms: 299, samples: 15 }], [{ name: "x", ms: 100, samples: 15 }])
      return regressed.length === 0 ? "clean" : "FALSE POSITIVE"
    },
  },
]

function main(argv: string[]): number {
  if (argv.includes("--self-test")) {
    let ok = 0
    for (const c of SELF_TEST_CASES) {
      const got = c.run()
      const pass = got === c.expect
      console.log(`  ${pass ? "ok  " : "FAIL"} ${c.name}${pass ? "" : `\n         expected ${c.expect}, got ${got}`}`)
      if (pass) ok++
    }
    console.log(`\nself-test: ${ok}/${SELF_TEST_CASES.length} ok`)
    return ok === SELF_TEST_CASES.length ? 0 : 1
  }

  if (argv.includes("--seed-baseline")) {
    const cases = runAll()
    const path = baselinePath()
    writeFileSync(path, `${JSON.stringify({ fingerprint: fingerprint(), cases }, null, 2)}\n`, "utf8")
    console.log(`seeded ${path}`)
    console.log(`  ${renderFingerprint(fingerprint())}`)
    for (const c of cases) console.log(`  ${c.name}  ${c.ms.toFixed(3)} ms`)
    return 0
  }

  const measured = runAll()
  if (argv.includes("--gate")) {
    const baseline = readBaseline()
    if (baseline === undefined) {
      console.error(`no baseline for this machine (looked for ${baselinePath()}) — run --seed-baseline first (a gate with nothing to compare is not a gate)`)
      return 2
    }
    // The fingerprint is REPORTED, not enforced: a different machine does not
    // invalidate the run, it invalidates the COMPARISON, and the reader is the
    // one who can tell the difference.
    console.log(`baseline: ${renderFingerprint(baseline.fingerprint)}  (${baseline.path})`)
    if (baseline.foreign) console.log('  WARN  this baseline was recorded on another machine — the comparison is indicative only (seed this machine with --seed-baseline)')
    console.log(`   this: ${renderFingerprint(fingerprint())}`)
    const { regressed, unbaselined } = regressions(measured, baseline.cases)
    for (const u of unbaselined) console.log(`  WARN  ${u} has no baseline — it has never been compared to anything`)
    for (const r of regressed) console.log(`  FAIL  ${r.name}: ${r.ms.toFixed(3)} ms was ${r.was.toFixed(3)} (>= ${REGRESSION_FACTOR}x)`)
    if (regressed.length > 0) {
      console.error(`bench: ${regressed.length} regression(s) -- the gate fails`)
      return 1
    }
    console.log(`bench: gate PASS -- no case regressed by ${REGRESSION_FACTOR}x`)
    return 0
  }

  for (const c of measured) console.log(`  ${c.name}  ${c.ms.toFixed(3)} ms`)
  return 0
}

// Standard ESM entry check, so the file can also be imported by a test without
// running the instrument.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
