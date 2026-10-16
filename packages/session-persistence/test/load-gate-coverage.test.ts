// THE LOAD-GATE COVERAGE GUARD — catches the NEXT unregistered durable event
// type before it can make any session unloadable.
//
// WHY THIS EXISTS: `guardIgnorable` (src/format/validation.ts) refuses any event type
// outside KNOWN_EVENT_TYPES ∪ registered with
//   SessionFormatUnsupportedError: unknown event type '<type>' without ignorable marker
// so a durable event type with a producer but no registration makes every
// session that recorded one unloadable. That defect has now shipped FOUR times:
//
//   1. `rewind/point`      (M53 G1)  — refused every session with a rewind applied
//   2. `sandbox/mode`      (M1 B)    — latent only because it had no producer
//   3. `operator/run-end`  (M3)      — the CLI run-end record
//   4. `model/retry`       (v0.1.11) — a retry inside a child session made that
//                                      child's log unloadable, so delegation
//                                      failed outright (see
//                                      test/model-retry-event.test.ts)
//
// Cases 1-3 each got their own per-type test file AFTER the fact, and that did
// not prevent case 4. A per-instance test cannot guard a CLASS. This one asserts
// the class invariant directly:
//
//   every event type a PRODUCTION source file can append durably
//   must be ADMITTED by the load gate.
//
// It reads sources rather than executing them, which is deliberate: the point is
// to notice a NEW type at the moment it is written, on any machine, without
// needing the new producer to be reachable in a test. This repo already treats
// source-level enumeration as a first-class instrument (scripts/audit/
// check-reachability.mjs, core-tools' catalog generator/verifier), so it is
// idiomatic here.
//
// WHAT IT CANNOT SEE (stated so a green run is not over-read):
//   - append sites whose `type` is not a plain string literal (a variable or
//     template literal). No such site exists in the tree today; if one is added,
//     this guard goes blind to it. It asserts the literal-typed subset only.
//   - whether the registered type is actually correct/complete — only that it is
//     admitted. Payload fidelity is each producer's own tests' business.
import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative, sep } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
/** packages/session-persistence/test → repository root. */
const ROOT = join(HERE, "..", "..", "..")
const PACKAGES = join(ROOT, "packages")
const PERSISTENCE_SRC = join(PACKAGES, "session-persistence", "src", "format", "registry.ts")

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "test", "tests", ".tmp", "dist", "out", "__pycache__"].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Production durable-append sites: `append(session, { type: "X" ... })`. */
function productionAppends(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const expressions = [
    /(?:append|appendSynthetic|appendDomain)\s*\(\s*[^,()]+,\s*\{\s*type:\s*["']([^"']+)["']/g,
    /\b(?:admit|feedback|lifecycle|usage|call|record|result|captureResult|capture|auditAssistant)\s*\(\s*\{\s*type:\s*["']([^"']+)["']/g,
  ]
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src")
    if (!existsSync(src) || !statSync(src).isDirectory()) continue
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, "utf8")
      let m: RegExpExecArray | null
      for(const re of expressions)while ((m = re.exec(text)) !== null) {
        const where = `${relative(ROOT, file).split(sep).join("/")}:${text.slice(0, m.index).split("\n").length}`
        const list = found.get(m[1]) ?? []
        list.push(where)
        found.set(m[1], list)
      }
    }
  }
  return found
}

/** The gate's allowlist, read from the one place that declares it. */
function admittedTypes(): Set<string> {
  const src = readFileSync(PERSISTENCE_SRC, "utf8")
  const start = src.indexOf("const KNOWN_EVENT_TYPES")
  const builtinBlock = src.slice(start, src.indexOf("])", start))
  const admitted = new Set([...builtinBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]))
  for (const m of src.matchAll(/registerEventType\("([^"]+)"\)/g)) admitted.add(m[1])
  return admitted
}

describe("load-gate coverage: no durable producer may be unloadable", () => {
  it("every production durable event type is admitted by the load gate", () => {
    const appended = productionAppends()
    const admitted = admittedTypes()
    // Sanity: the scan must actually see a population, or a green result is
    // meaningless (an empty scan trivially passes).
    expect(appended.size).toBeGreaterThan(20)
    expect(admitted.size).toBeGreaterThan(20)

    const unadmitted = [...appended.keys()].filter((t) => !admitted.has(t)).sort()
    expect(unadmitted, [
      "These event types have a PRODUCTION durable producer but are NOT admitted by",
      "session-persistence's load gate, so any session log carrying one cannot be",
      "loaded (SessionFormatUnsupportedError: unknown event type ... without",
      "ignorable marker). Register each with `registerEventType(...)` in",
      "packages/session-persistence/src/format/registry.ts — or, if it must not be durable,",
      "stop appending it (see `publishTransient` for the transient path).",
      "",
      `unadmitted: ${unadmitted.join(", ")}`,
      `producers:  ${unadmitted.map((t) => `${t} -> ${appended.get(t)!.join(", ")}`).join("\n            ")}`,
    ].join("\n")).toEqual([])
  })

  it("registers `model/retry` (the v0.1.11 regression this guard was added for)", () => {
    // A direct pin so the specific regression cannot silently return even if the
    // scan above is ever weakened.
    expect(admittedTypes().has("model/retry")).toBe(true)
  })
})
