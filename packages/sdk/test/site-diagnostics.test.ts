// packages/sdk/test/site-diagnostics.test.ts — R15: the captured INSTANCE net
// over this package's real diagnostics sites.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases, so nothing asserted that a PACKAGE site routes to the
// phase/level it declares — measured, flipping one site's `warn`→`error` turned 0
// tests red. Only a package can drive its own site, so the net lives here.
//
// WHY A NEW FILE: `server.test.ts:468-486` already traverses the
// `params`-not-an-object path, but what it asserts is that `console.warn` WAS
// called — true only while NO instance is installed. The installed slot is MODULE
// state, so putting these cases there would let the file's own order decide which
// assertion holds. A new file is a new worker, and that file stays untouched.
//
// Covered: both sites are the AMBIENT-HANDLE shape (`const d = diagnosticsFor("sdk")`)
// in `src/server.ts`'s `captureClientInfo`:
//   - `:224` — `initialize` whose `params` is present but not an object.
//   - `:230` — `initialize` whose `params.clientInfo` is present but not an object
//     (no case anywhere had ever SENT a non-object `clientInfo`).
// Together they give phase `sdk` its first asserting observer (M79 Task 4).
//
// Discipline is COPIED from `packages/diagnostics/test/diagnostics.test.ts:47-55`
// (the capture stream) and `:59-68` (the teardown): the ambient slot is MODULE
// state, so a leaked instance would choose the next case's mode.
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  createDiagnostics,
  currentDiagnostics,
  installDiagnostics,
  type DiagnosticRecord,
  type Redactor,
} from "@i-harness/diagnostics"
import type { SessionService } from "@i-harness/session-executor"
import { createSdkServer } from "../src/server.ts"
import { decodeFrame, encodeFrame, makeRequest, type RpcSuccess } from "../src/protocol.ts"

/** The identity redactor: these cases are about the ROUTING (phase/level), and
 *  the real scans are their own task. */
const passthrough: Redactor = {
  redact: (value) => value,
  registerSecret: () => {},
  size: () => ({ rules: 0, secrets: 0 }),
}

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
  currentDiagnostics()?.close()
})

/** The smallest double the `initialize` → `close` path accepts: `onAssembly` at
 *  construction, and the unsubscribe it returns at `close()`. Nothing on
 *  `initialize` touches the service, so the session-method surface
 *  server.test.ts's `makeStubService` fills in is not needed here. */
function makeStubService(): SessionService {
  return { onAssembly: () => () => {} } as unknown as SessionService
}

it("initialize's non-object params report is the ambient handle's, at phase sdk / level warn", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const { stream, lines } = captureStream()
  installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

  const server = createSdkServer(makeStubService())
  try {
    // The identity is informational, so the handshake SUCCEEDS with nothing
    // captured — and the site says so on the record instead of the console.
    const reply = await server.handleLine(encodeFrame(makeRequest(1, "initialize", "not-an-object")))

    expect((decodeFrame(reply!) as RpcSuccess).result).toMatchObject({ name: "i-harness", protocolVersion: 3 })
    expect(server.clientInfo()).toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "sdk", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("params is not an object")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    await server.close()
  }
})

it("initialize's non-object clientInfo report is the ambient handle's, at phase sdk / level warn", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const { stream, lines } = captureStream()
  installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

  // `initialize` is first-wins (`server.ts:384`), so this case needs its own
  // server: a shared one would ignore the params under test.
  const server = createSdkServer(makeStubService())
  try {
    const reply = await server.handleLine(encodeFrame(makeRequest(1, "initialize", { clientInfo: 42 })))

    expect((decodeFrame(reply!) as RpcSuccess).result).toMatchObject({ name: "i-harness", protocolVersion: 3 })
    expect(server.clientInfo()).toBeUndefined() // never the string "42"
    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "sdk", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("clientInfo is not an object")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    await server.close()
  }
})
