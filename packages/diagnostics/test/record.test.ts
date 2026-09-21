// packages/diagnostics/test/record.test.ts — TDD for `fromError`, the ONE
// derivation that fills the error half of a record (M3 §3.3; §3.5's force layer 2:
// `err` is DERIVED, never an arbitrary `Error` dropped in).
//
// WHY A SEPARATE FILE: diagnostics.test.ts owns the logger's three modes and
// carries the env/ambient teardown they need; this is a pure function over
// (unknown, Redactor) that wants none of that.
//
// THE REDACTOR HERE IS A LOCAL DOUBLE — T3 owns `createRedactor`, and T2's
// property is WHERE the derivation places the values (message and stack reach
// the redactor, the name never does), not which rules exist. T3 must emit the
// same `[REDACTED]` token, and swapping this double for the real factory is the
// one line that changes when it lands.
import { expect, it } from "vitest"
import { fromError, type Redactor } from "../src/index.ts"

/** The minimal double: ONE value rule, so a value that went through it is
 *  visible in the output. `seen`, when passed, records every value the
 *  derivation handed over — that array is the placement evidence below. */
function redactor(seen?: unknown[]): Redactor {
  return {
    redact: (value) => {
      seen?.push(value)
      return typeof value === "string" ? value.replace(/sk-live-[A-Za-z0-9]+/g, "[REDACTED]") : value
    },
    registerSecret: () => {},
    size: () => ({ rules: 1, secrets: 0 }),
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
