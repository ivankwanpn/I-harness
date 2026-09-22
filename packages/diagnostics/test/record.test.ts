// packages/diagnostics/test/record.test.ts — TDD for `fromError` (the ONE
// derivation that fills the error half of a record) and for the logger boundary
// that CALLS it (M3 §3.3; §3.5's force layer 2: `err` is DERIVED, never an
// arbitrary `Error` dropped in).
//
// WHY A SEPARATE FILE: diagnostics.test.ts owns the logger's three modes and
// carries the env/ambient teardown they need; this is a pure function over
// (unknown, Redactor) that wants none of that — and the boundary cases at the end
// are here because the harness they need lives in this file.
//
// THE REDACTOR HERE IS THE REAL FACTORY (T3), wrapped so the wrapper does ONE
// thing the factory will not: record the values the derivation handed over
// (`seen`). T2's property is WHERE the derivation places them — message and stack
// reach the redactor, the name never does — and this file was written against a
// rule-less double only because the factory did not exist yet. With the factory in
// place the `[REDACTED]` assertions below stopped being evidence about a double and
// became integration evidence: dropping the `sk-` rule reddens two cases here (the
// exact-equality ones — measured, not assumed). The four adapter rows carry the
// header form, so the `Bearer` rule covers them too and a single-rule mutation
// leaves them green; those two cases are what pin the shape scan from this file.
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  createDiagnostics,
  createRedactor,
  currentDiagnostics,
  diagnosticsFor,
  fromError,
  installDiagnostics,
  type DiagnosticRecord,
  type Redactor,
} from "../src/index.ts"

/** The real factory behind a recording proxy. `seen`, when passed, collects every
 *  value the derivation handed over — that array is the placement evidence below.
 *  The proxy adds no rules of its own: it forwards, so nothing here can mask a
 *  secret the factory would have written. */
function redactor(seen?: unknown[]): Redactor {
  const real = createRedactor()
  return {
    redact: (value, key) => {
      seen?.push(value)
      return real.redact(value, key)
    },
    registerSecret: (value) => { real.registerSecret(value) },
    size: () => real.size(),
  }
}

const SECRET = "sk-live-ABC123"
const TOKEN = "[REDACTED]"

// ------------------------------------------------- the measured leak fixtures
/** The four llm adapters build the SAME shape, one line each —
 *  `` `${provider} request failed: ${response.status} ${await response.text()}` `` —
 *  and the response body is what can echo the credential back. Each row is the
 *  message that line produces. Sites re-read 2026-09-22 (line numbers rot):
 *  packages/llm-openai-compatible/src/index.ts:128, packages/llm-openai/src/index.ts:141,
 *  packages/llm-anthropic/src/index.ts:167, packages/llm-gemini/src/index.ts:163.
 *  The openai-compatible row is the task brief's fixture, verbatim. */
const ADAPTER_LEAKS = [
  { provider: "openai-compatible", message: 'openai-compatible request failed: 401 {"error":"bad key","echo":"Authorization: Bearer sk-live-ABC123"}' },
  { provider: "openai", message: 'openai request failed: 401 {"error":"bad key","echo":"Authorization: Bearer sk-live-ABC123"}' },
  { provider: "anthropic", message: 'anthropic request failed: 401 {"error":"bad key","echo":"Authorization: Bearer sk-live-ABC123"}' },
  { provider: "gemini", message: 'gemini request failed: 401 {"error":"bad key","echo":"Authorization: Bearer sk-live-ABC123"}' },
] as const

it.each(ADAPTER_LEAKS)("$provider: the measured request-failed leak loses the credential from message AND stack", ({ message }) => {
  const err = new Error(message)

  const out = fromError(err, redactor())

  expect(out.message).not.toContain(SECRET)
  expect(out.message).toContain(TOKEN)
  // V8's stack puts the message on its FIRST LINE, so a stack that reached the
  // record unredacted would carry the same secret — and the token can only be
  // in it by way of the redactor. Neither assertion below is vacuous.
  expect(out.stack).toBeDefined()
  expect(out.stack).not.toContain(SECRET)
  expect(out.stack).toContain(TOKEN)
  expect(out.name).toBe("Error")
  // Derived, never rewritten: the caught Error keeps its bytes. The console
  // channel prints verbatim by ruling (§0.2), so redacting the live object in
  // place would change human-readable output that 30 test files assert on.
  expect(err.message).toBe(message)
})

// -------------------------------------------------------------- the placement
it("message and stack are derived THROUGH the redactor, and the name is not", () => {
  const seen: unknown[] = []
  const err = new Error("boom sk-live-ABC123")
  err.name = "ProviderRequestError"
  const rawMessage = err.message
  const rawStack = err.stack

  const out = fromError(err, redactor(seen))

  // Placement, not just output: the two fields that can carry a provider body
  // were handed over — the message always, the stack when the runtime has one.
  expect(seen).toHaveLength(2)
  expect(seen).toContain(rawMessage)
  expect(seen).toContain(rawStack)
  // A class name is not a value to scan: it is the field a reader groups
  // records by, and `RedactedError`'s contract redacts message and stack only.
  expect(seen).not.toContain("ProviderRequestError")
  expect(out.name).toBe("ProviderRequestError")
  expect(out.message).toBe("boom [REDACTED]")
  expect(out.stack).toContain(TOKEN)
})

// ---------------------------------------------------------- the non-Error throw
it("a thrown string still derives a record: the message is stringified and redacted, the name says what was thrown, and no stack is invented", () => {
  // Every catch in this tree sees `unknown`, and a throw is not required to be
  // an Error. `failureReport` (`apps/cli/src/run.ts:253`) is the precedent for
  // the message half — `err instanceof Error ? err.message : String(err)` —
  // and `typeof` is the name half: a record should say a STRING was thrown
  // rather than claim the "Error" class it never had.
  const out = fromError("sk-live-ABC123 leaked", redactor())

  expect(out).toEqual({ name: "string", message: "[REDACTED] leaked" })
  expect("stack" in out).toBe(false)
})

it("an Error with no stack derives no stack field — the record never says \"undefined\"", () => {
  // `stack?` is optional in the interface: a runtime that dropped it (a
  // serialized or resumed error) must produce an ABSENT field, not
  // `String(redactor.redact(undefined))` — writing "undefined" into a log is
  // the record telling a lie about what the error had.
  const err = new Error("boom")
  err.stack = undefined

  const out = fromError(err, redactor())

  expect(out).toEqual({ name: "Error", message: "boom" })
  expect("stack" in out).toBe(false)
})

// ------------------------------------------------------ the logger boundary
// `record.err` has exactly ONE writer: the logger derives it from whatever a
// catch clause holds, so a caller can never hand in a constructed
// `RedactedError` (§3.5's force layer 2, enforced at the API) — and the console
// channel does not learn that `err` exists at all.

const ENV = "I_HARNESS_LOG"

beforeEach(() => { delete process.env[ENV] })

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[ENV]
  // The ambient slot is MODULE state: an instance left installed would choose
  // the next case's mode (diagnostics.test.ts's teardown discipline).
  currentDiagnostics()?.close()
})

function capture(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = []
  const stream = { write: (s: string) => { lines.push(s); return true } } as unknown as NodeJS.WritableStream
  return { stream, lines }
}

function parsed(lines: string[]): DiagnosticRecord[] {
  return lines.map((l) => JSON.parse(l) as DiagnosticRecord)
}

it("a record given a caught value carries a DERIVED err: message and stack through the redactor, name preserved", () => {
  const { stream, lines } = capture()
  installDiagnostics(createDiagnostics({ stream, runId: "r", redactor: redactor() }))
  const err = new Error('openai-compatible request failed: 401 {"error":"bad key","echo":"Authorization: Bearer sk-live-ABC123"}')

  // The AMBIENT path, i.e. the shape every migrated site uses — so this case
  // also guards the third argument's forwarding through `child(phase)`.
  diagnosticsFor("run").error("provider call failed", { model: "m" }, err)

  const rec = parsed(lines)[0]!
  expect(rec.msg).toBe("provider call failed")
  const derived = rec.err
  expect(derived?.name).toBe("Error")
  expect(derived?.message).not.toContain(SECRET)
  expect(derived?.message).toContain(TOKEN)
  expect(derived?.stack).not.toContain(SECRET)
  expect(derived?.stack).toContain(TOKEN)
})

it("unset mode with data AND err: the console channel still gets exactly ONE verbatim argument", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  // Delegation is the byte-identity mechanism (§0.2), and what the 95 existing
  // assertions compare is the whole argument LIST — so a third argument passed
  // through to the console, or a second one, shows up here.
  diagnosticsFor("run").error("boom sk-live-ABC123", { key: "x" }, new Error("caught"))

  expect(error.mock.calls).toEqual([["boom sk-live-ABC123"]])
})

it("no caught value: the record carries no err key at all", () => {
  const { stream, lines } = capture()
  installDiagnostics(createDiagnostics({ stream, runId: "r", redactor: redactor() }))

  diagnosticsFor("run").warn("plain", { key: "x" })

  // `err !== undefined` is the guard, not a nicety: deriving unconditionally
  // would write `{ name: "undefined", message: "undefined" }` into EVERY record.
  // (`JSON.stringify` cannot show the finer difference `err: undefined` vs. no
  // key, so the wire shape is what is pinned here.)
  expect("err" in parsed(lines)[0]!).toBe(false)
})
