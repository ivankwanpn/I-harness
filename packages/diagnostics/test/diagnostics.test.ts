// packages/diagnostics/test/diagnostics.test.ts — TDD for the logger's three
// modes, the ambient instance, the phase binding, and the by-construction redactor.
//
// The cases below encode the W6 plan's §0.3 rulings, so they are written as the
// rulings read: an unset `I_HARNESS_LOG` is BYTE-IDENTICAL to the plain console
// call it replaces (function AND argument list — 95 assertions across 30 test
// files compare exactly that), `level` filters the RECORD and never the console
// channel, and no instance without a redactor can be built.
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  createDiagnostics,
  currentDiagnostics,
  diagnosticsFor,
  installDiagnostics,
  type DiagnosticRecord,
  type Redactor,
} from "../src/index.ts"

/** The real scans are Task 3's; these cases are about the sink and the ambient
 *  routing, so the redactor here is the identity. */
const passthrough: Redactor = {
  redact: (value) => value,
  registerSecret: () => {},
  size: () => ({ rules: 0, secrets: 0 }),
}

/** A redactor with ONE rule, enough to see that the seam is wired: every
 *  "SECRET" inside a string — and inside the values of a flat object — becomes
 *  "[REDACTED]". */
const masking: Redactor = {
  redact: (value) => {
    const scrub = (v: unknown) => (typeof v === "string" ? v.replaceAll("SECRET", "[REDACTED]") : v)
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v)]))
    }
    return scrub(value)
  },
  registerSecret: () => {},
  size: () => ({ rules: 1, secrets: 0 }),
}

/** The stream shape packages/telemetry/test/telemetry.test.ts uses: a write
 *  method, and whatever it was handed kept verbatim. */
function captureStream(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = []
  const stream = { write: (s: string) => { lines.push(s); return true } } as unknown as NodeJS.WritableStream
  return { stream, lines }
}

function parsed(lines: string[]): DiagnosticRecord[] {
  return lines.map((l) => JSON.parse(l) as DiagnosticRecord)
}

const ENV = "I_HARNESS_LOG"

beforeEach(() => { delete process.env[ENV] })

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[ENV]
  // The ambient slot is MODULE state, so a case that leaks an installed instance
  // would choose the next case's mode. close() detaches (that is itself under
  // test below); it is the teardown discipline the hosts will follow.
  currentDiagnostics()?.close()
})

// --------------------------------------------------------------- unset = console
it("unset and nothing installed: a call is exactly the plain console call", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const error = vi.spyOn(console, "error").mockImplementation(() => {})

  diagnosticsFor("cli").warn("x")
  // `data` must NOT arrive as a second console argument: today's call sites pass
  // one, and a spy comparing arguments sees the difference.
  diagnosticsFor("run").warn("with data", { k: 1 })
  diagnosticsFor("session").error("y")

  expect(warn.mock.calls).toEqual([["x"], ["with data"]])
  expect(error.mock.calls).toEqual([["y"]])
})

it("the level threshold filters the record and never the console channel", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  // A threshold ABOVE the call's level, on an instance with no sink: the
  // structured half of the design is not even in play, and the console half is
  // untouched. This is what keeps a settings-level change from silently
  // deleting output that 30 test files assert on.
  installDiagnostics(createDiagnostics({ runId: "r", level: "error", redactor: passthrough }))

  diagnosticsFor("cli").warn("still console.warn")

  expect(warn.mock.calls).toEqual([["still console.warn"]])
})

it("a redacting instance still delegates the console message VERBATIM", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  // The unset mode is byte-identical by ruling (§0.2/§0.3), so it is NOT the
  // redacted channel; a redactor in the constructor changes the records, not the
  // human-readable line that exists today. Stated as a case because it is the
  // sharpest thing a reader can misread about this module.
  installDiagnostics(createDiagnostics({ runId: "r", redactor: masking }))

  diagnosticsFor("cli").warn("key=SECRET")

  expect(warn.mock.calls).toEqual([["key=SECRET"]])
})

it("level drops a below-threshold RECORD from a structured sink", () => {
  const { stream, lines } = captureStream()
  installDiagnostics(createDiagnostics({ stream, runId: "r", level: "warn", redactor: passthrough }))

  diagnosticsFor("cli").debug("dropped")
  diagnosticsFor("cli").info("dropped")
  diagnosticsFor("cli").warn("kept")
  diagnosticsFor("cli").error("kept")

  expect(parsed(lines).map((r) => r.msg)).toEqual(["kept", "kept"])
})

// ------------------------------------------------------------ installed instance
it("an installed instance writes one JSONL record per call and never touches console", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const { stream, lines } = captureStream()
  const d = createDiagnostics({ stream, runId: "run-1", redactor: passthrough })
  const uninstall = installDiagnostics(d)
  expect(currentDiagnostics()).toBe(d)

  diagnosticsFor("cli").warn("boom")
  uninstall()

  expect(lines).toHaveLength(1)
  const rec = parsed(lines)[0]!
  expect(rec).toMatchObject({ level: "warn", run: "run-1", phase: "cli", msg: "boom" })
  expect(typeof rec.ts).toBe("number")
  expect(rec.ts).toBeGreaterThan(0)
  expect(warn).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
})

it("the record's msg and data are redacted before they are written", () => {
  const { stream, lines } = captureStream()
  installDiagnostics(createDiagnostics({ stream, runId: "r", redactor: masking }))

  diagnosticsFor("cli").warn("key=SECRET", { token: "SECRET" })

  expect(parsed(lines)[0]).toMatchObject({ msg: "key=[REDACTED]", data: { token: "[REDACTED]" } })
})

// ------------------------------------------------------------------- env modes
it("I_HARNESS_LOG=stderr puts the JSONL record on process.stderr", () => {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  process.env[ENV] = "stderr"
  installDiagnostics(createDiagnostics({ runId: "run-2", redactor: passthrough }))

  diagnosticsFor("cli").info("to stderr")

  // Only OUR line is parsed: the test runner writes to the same stderr object.
  const ours = write.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('"phase":"cli"'))
  expect(ours).toHaveLength(1)
  expect(JSON.parse(ours[0]!)).toMatchObject({ level: "info", run: "run-2", phase: "cli", msg: "to stderr" })
  expect(warn).not.toHaveBeenCalled()
})

it("I_HARNESS_LOG='' counts as unset: delegation, not a path", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  // A pipeline that exports the variable EMPTY must get the unset behaviour;
  // reading "" as a path would make the first record an ENOENT report instead.
  process.env[ENV] = ""
  installDiagnostics(createDiagnostics({ runId: "run-5", redactor: passthrough }))

  diagnosticsFor("cli").warn("x")

  expect(warn.mock.calls).toEqual([["x"]])
  expect(error).not.toHaveBeenCalled()
})

it("I_HARNESS_LOG=<path> appends JSONL, creating the parent directory", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-"))
  try {
    const file = join(root, "nested", "diagnostics.jsonl")
    process.env[ENV] = file
    installDiagnostics(createDiagnostics({ runId: "run-4", redactor: passthrough }))

    diagnosticsFor("cli").warn("first")
    diagnosticsFor("run").error("second")

    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    expect(parsed(lines).map((r) => [r.msg, r.phase])).toEqual([["first", "cli"], ["second", "run"]])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --------------------------------------------------------- install / teardown
it("after the uninstaller runs, a call falls back to console delegation", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const { stream, lines } = captureStream()
  const uninstall = installDiagnostics(createDiagnostics({ stream, runId: "r", redactor: passthrough }))

  uninstall()

  expect(currentDiagnostics()).toBeUndefined()
  diagnosticsFor("cli").warn("x")
  expect(warn.mock.calls).toEqual([["x"]])
  expect(lines).toHaveLength(0)
})

it("close() on the installed instance ends its records and detaches it", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const { stream, lines } = captureStream()
  const d = createDiagnostics({ stream, runId: "r", redactor: passthrough })
  installDiagnostics(d)
  diagnosticsFor("cli").warn("before close")

  d.close()

  expect(currentDiagnostics()).toBeUndefined()
  diagnosticsFor("cli").warn("after close")
  expect(parsed(lines).map((r) => r.msg)).toEqual(["before close"])
  expect(warn.mock.calls).toEqual([["after close"]])
})

it("a console-mode instance keeps delegating after close()", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  // No stream and an unset env: the DELEGATION mode. close() ends a record
  // stream, and there is no stream here to end — while silencing the human line
  // at teardown would change bytes at the one moment the existing spies are
  // still watching. T4's close-ordering leans on this.
  const d = createDiagnostics({ runId: "r", redactor: passthrough })

  d.warn("before close")
  d.close()
  d.warn("after close")

  expect(warn.mock.calls).toEqual([["before close"], ["after close"]])
})

it("the ambient path follows the installed instance, with no stale view across a swap", () => {
  const a = captureStream()
  const b = captureStream()
  const first = installDiagnostics(createDiagnostics({ stream: a.stream, runId: "A", redactor: passthrough }))
  diagnosticsFor("cli").warn("one")

  first()
  installDiagnostics(createDiagnostics({ stream: b.stream, runId: "B", redactor: passthrough }))
  diagnosticsFor("cli").warn("two")

  expect(parsed(a.lines).map((r) => [r.run, r.msg])).toEqual([["A", "one"]])
  expect(parsed(b.lines).map((r) => [r.run, r.msg])).toEqual([["B", "two"]])
})

it("installing the ambient handle itself is refused rather than routed back into it", () => {
  // `diagnosticsFor` resolves THROUGH the installed slot; installing one of its
  // handles would make that resolution route to itself (unbounded recursion) and
  // would look like a normal install at the call site.
  expect(() => installDiagnostics(diagnosticsFor("cli"))).toThrow(TypeError)
  expect(currentDiagnostics()).toBeUndefined()
})

// ---------------------------------------------------------------- phase binding
it("child(phase) binds the phase, on the instance and on the ambient handle", () => {
  const { stream, lines } = captureStream()
  const d = createDiagnostics({ stream, runId: "r", redactor: passthrough })
  installDiagnostics(d)

  d.child("mount").warn("from the instance")
  diagnosticsFor("cli").child("turn").warn("from the ambient handle")

  expect(parsed(lines).map((r) => [r.msg, r.phase])).toEqual([
    ["from the instance", "mount"],
    ["from the ambient handle", "turn"],
  ])
})

it("child(phase) hands back the same view, so a per-record call allocates nothing", () => {
  // The ambient path calls `child(phase)` on EVERY record, so a fresh handle per
  // call would allocate an object — and a back-pointer entry — per logged call.
  // Pinned as a property, because that is what the cost requirement was.
  const d = createDiagnostics({ stream: captureStream().stream, runId: "r", redactor: passthrough })
  expect(d.child("run")).toBe(d.child("run"))
  expect(d.child("run")).not.toBe(d.child("turn"))
})

// ------------------------------------------------------------- the unconstructible
it("a redactor is required by construction: the call does not compile, and does not run", () => {
  // @ts-expect-error `redactor` has no default and no `undefined` overload: an
  // un-redacted instance must be unconstructible (M3 §3.5, force layer 1). The
  // runtime half of the same rule is what a JS caller — the typechecker never
  // sees one — gets instead.
  expect(() => createDiagnostics({ runId: "r" })).toThrow(TypeError)
})
