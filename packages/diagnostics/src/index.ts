// packages/diagnostics/src/index.ts — the structured logger, and the ambient
// instance a host installs (M3 spec §3.3; the rulings are the W6 plan's §0.3).
//
// ONE RULE SHAPES EVERYTHING HERE: with `I_HARNESS_LOG` unset and nothing
// installed, a call has to be BYTE-IDENTICAL to the plain console call it
// replaces — same function, same single argument, message untouched. Thirty test
// files spy on the console and compare text (95 assertion sites), so "no log
// configured" cannot mean "quieter": it has to mean the same bytes, or the
// migration of the call sites reddens tests it was told not to touch.
//
// So there are two channels, and the switch between them is not the level:
//
//   unset                      -> console.warn/error, message verbatim
//   I_HARNESS_LOG=stderr       -> one JSONL record per call, on stderr
//   I_HARNESS_LOG=<path>       -> the same line, appended to that file
//   a `stream` in the options  -> the same line, on that stream (wins over the env)
//
// `level` filters the RECORD only. It never reroutes, and never silences, the
// console channel: the messages a human reads today stay exactly as they are.
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { DiagnosticPhase, DiagnosticRecord, Level, Redactor } from "./record.ts"

export type { DiagnosticPhase, DiagnosticRecord, Level, RedactedError, Redactor } from "./record.ts"

// The error DERIVATION is a value, so it cannot ride the `export type` list above
// — and with the exports map exposing only ".", this entry is the only way in.
export { fromError } from "./record.ts"

/** What a call site holds. `child(phase)` binds the phase once, so the site does
 *  not spell it at every call. */
export interface Diagnostics {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  child(phase: DiagnosticPhase): Diagnostics
  close(): void
}

const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"]
const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** The phase of the instance's own handle, until a `child(...)` binds a narrower
 *  one. Every entry that constructs an instance today is the CLI — its `run`,
 *  `sdk` and `acp` subcommands included — and a host that is not the CLI binds
 *  the phase at its own call sites. */
const ROOT_PHASE: DiagnosticPhase = "cli"

/** A sink writes one already-serialised JSONL line. */
interface Sink {
  write(line: string): void
  close(): void
}

/** One record per line, `JSON.stringify(...) + "\n"` — the line convention the
 *  telemetry sink already uses (`packages/telemetry/src/jsonl.ts`). */
function streamSink(stream: NodeJS.WritableStream): Sink {
  return {
    write: (line) => { stream.write(line) },
    // The stream is the CALLER's: whoever passed one closes it.
    close: () => {},
  }
}

/** `=stderr`, resolved PER WRITE rather than captured at construction: a host
 *  builds its instance early, and a test that replaces `process.stderr.write`
 *  afterwards still has to see the record. */
function stderrSink(): Sink {
  return {
    write: (line) => { process.stderr.write(line) },
    close: () => {},
  }
}

/** `=<path>`: append, creating the parent directory on the first write. No open
 *  descriptor is kept — one `appendFileSync` per record means nothing is
 *  buffered, so the line survives a crash, which is the case a diagnostics log
 *  exists for (`packages/output-retention/src/index.ts` is the sync-write
 *  precedent).
 *
 *  A sink failure is REPORTED ONCE and then disables the sink. It is not
 *  re-routed to the console: the console channel is verbatim, and the record is
 *  the copy that has been through the redactor, so re-routing on failure would
 *  leak exactly what the redactor removed. Falling silent is the other half of
 *  the rule — a logger that cannot write says so once, and never takes the host
 *  down for it. */
function pathSink(path: string): Sink {
  let prepared = false
  let broken = false
  return {
    write: (line) => {
      if (broken) return
      try {
        if (!prepared) { mkdirSync(dirname(path), { recursive: true }); prepared = true }
        appendFileSync(path, line)
      } catch (err) {
        broken = true
        console.error(`[i-harness] diagnostics: cannot append to ${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    close: () => {},
  }
}

/** The mode switch. An EMPTY value is unset: `I_HARNESS_LOG=` is the shell's
 *  idiom for clearing a variable for one command, and treating "" as a path
 *  would turn it into an ENOENT report at the first record. */
function sinkFromEnv(value: string | undefined): Sink | null {
  if (!value) return null
  if (value === "stderr") return stderrSink()
  return pathSink(value)
}

/** The pre-existing call, reproduced: the level names the console function, and
 *  the message goes through UNTOUCHED as the only argument. `data` is dropped
 *  rather than appended — a second argument would change every comparison the
 *  console-spying tests make. */
function delegate(level: Level, msg: string): void {
  if (level === "debug") console.debug(msg)
  else if (level === "info") console.info(msg)
  else if (level === "warn") console.warn(msg)
  else console.error(msg)
}

/** ONE object per constructed logger, shared by every handle it hands out:
 *  `child(phase)` is a VIEW of the instance, not a separate lifetime — one sink,
 *  one close. */
interface Instance {
  runId: string
  minRank: number
  redactor: Redactor
  sink: Sink | null
  closed: boolean
  /** ONE handle per phase. The ambient path calls `child(phase)` on every
   *  record, so building a view each time would allocate an object — and a
   *  WeakMap entry — on every logged call, for no gain. A view is PURE (it holds
   *  only this instance and the phase), so a retained one can never go stale: it
   *  belongs to one instance, and the ambient path looks the INSTANCE up first. */
  handles: Map<DiagnosticPhase, Diagnostics>
}

/** handle -> instance, so a close can detach the right ambient slot without the
 *  public handle carrying a visible back-pointer. */
const INSTANCES = new WeakMap<object, Instance>()

function toRecord(inst: Instance, phase: DiagnosticPhase, level: Level, msg: string, data?: Record<string, unknown>): DiagnosticRecord {
  const rec: DiagnosticRecord = { ts: Date.now(), level, run: inst.runId, phase, msg: String(inst.redactor.redact(msg)) }
  // The redactor returns the shape it was given (that is its contract), so this
  // cast marks the interface's boundary rather than asserting anything.
  if (data !== undefined) rec.data = inst.redactor.redact(data) as Record<string, unknown>
  return rec
}

function makeHandle(inst: Instance, phase: DiagnosticPhase): Diagnostics {
  const memo = inst.handles.get(phase)
  if (memo) return memo
  const methods = {} as Pick<Diagnostics, Level>
  for (const level of LEVELS) {
    methods[level] = (msg: string, data?: Record<string, unknown>): void => {
      // No sink: the unset mode, i.e. delegation. It happens even after close() —
      // a console-mode instance owns no resource, and silencing it at teardown
      // would change bytes at the one moment every existing spy is still
      // watching.
      if (!inst.sink) { delegate(level, msg); return }
      // A closed sink takes no further records: writing to it would either throw
      // (the path mode) or resurrect output after the host declared the run over.
      if (inst.closed) return
      if (RANK[level] < inst.minRank) return
      inst.sink.write(`${JSON.stringify(toRecord(inst, phase, level, msg, data))}\n`)
    }
  }
  const handle: Diagnostics = {
    ...methods,
    child: (p) => makeHandle(inst, p),
    close: () => { detach(inst) },
  }
  INSTANCES.set(handle, inst)
  inst.handles.set(phase, handle)
  return handle
}

/** The teardown: release the sink, and detach the instance if it is the
 *  installed one. A child detaches too — children are views of one instance.
 *  Guarded, so a second close (or a close after the uninstaller already
 *  detached) is a no-op rather than a double release. */
function detach(inst: Instance): void {
  if (inst.closed) return
  inst.closed = true
  inst.sink?.close()
  if (installed && INSTANCES.get(installed) === inst) installed = undefined
}

/**
 * Build one logger.
 *
 * `redactor` is REQUIRED — no default, no `undefined` overload — so an
 * un-redacted instance cannot be built (M3 §3.5, force layer 1). The guard below
 * is the same rule for a caller the typechecker never sees (plain JS, a harness
 * that skips `tsc`): it refuses rather than defaulting, so the property does not
 * depend on the language the caller is written in.
 */
export function createDiagnostics(opts: { stream?: NodeJS.WritableStream; level?: Level; runId: string; redactor: Redactor }): Diagnostics {
  if (!opts.redactor) {
    throw new TypeError("createDiagnostics: `redactor` is required by construction (no default, no `undefined` overload)")
  }
  const inst: Instance = {
    runId: opts.runId,
    minRank: RANK[opts.level ?? "debug"],
    redactor: opts.redactor,
    // An explicit stream wins over the environment: the caller that passes one
    // has already decided (a test, or a host with its own destination), and
    // re-reading the env here would make the argument a suggestion.
    sink: opts.stream ? streamSink(opts.stream) : sinkFromEnv(process.env.I_HARNESS_LOG),
    closed: false,
    handles: new Map(),
  }
  return makeHandle(inst, ROOT_PHASE)
}

/** The installed instance. This is MODULE state, and the cost is stated rather
 *  than hidden (plan §0.3): it is per process — one instance at a time, which is
 *  what a process-wide console always was — so installing and detaching have to
 *  be paired. A host's teardown calls its instance's close(), which detaches;
 *  the uninstaller below is the same discipline for a caller that holds none.
 *
 *  A second install replaces the first, and the first instance's close() then
 *  detaches nothing (the slot is no longer its own). Pairing is the caller's
 *  contract; enforcing it here would mean refusing a legitimate re-install. */
let installed: Diagnostics | undefined

/** The ambient handles, one stable object per phase: a call site may hold one at
 *  module scope (`const d = diagnosticsFor("run")`), so handing out a fresh
 *  object per call would put an allocation on a call path for no gain. */
const ambient = new Map<DiagnosticPhase, Diagnostics>()

/** A call site's handle. WHY IT RESOLVES PER CALL: the site holds it at module
 *  scope, evaluated at import time — before any host entry body has run, and
 *  therefore before an instance could be installed. A handle that captured the
 *  instance at creation would capture `undefined` in every real process and pin
 *  every site to console delegation forever, so each call re-reads the slot. */
export function diagnosticsFor(phase: DiagnosticPhase): Diagnostics {
  let h = ambient.get(phase)
  if (!h) {
    h = ambientHandle(phase)
    ambient.set(phase, h)
  }
  return h
}

function ambientHandle(phase: DiagnosticPhase): Diagnostics {
  const methods = {} as Pick<Diagnostics, Level>
  for (const level of LEVELS) {
    methods[level] = (msg: string, data?: Record<string, unknown>): void => {
      const d = currentDiagnostics()
      if (!d) { delegate(level, msg); return }
      // Deliberately NOT `d?.child(phase)[level](...) ?? delegate(...)`: these
      // methods return void, so the optional call would read `undefined` on both
      // branches and the console line would fire even when an instance handled
      // the record.
      //
      // For an instance this module built, `child(phase)` is a memoized view —
      // a map lookup, not an allocation, per record (a foreign implementation's
      // `child` is its own business).
      d.child(phase)[level](msg, data)
    }
  }
  return {
    ...methods,
    child: (p) => diagnosticsFor(p),
    close: () => {
      // The ambient handle owns nothing. A teardown closes the INSTANCE a host
      // installed; closing a call site's handle must not detach a host's
      // instance on its behalf.
    },
  }
}

/** The installed instance, or `undefined` when none is. */
export function currentDiagnostics(): Diagnostics | undefined {
  return installed
}

/** Install `d` as this process's logger; the returned function detaches it. The
 *  discipline is identity-based, so an uninstaller cannot detach an instance
 *  that replaced its own. */
export function installDiagnostics(d: Diagnostics): () => void {
  // An ambient handle resolves THROUGH this slot, so installing one would route
  // every call back into itself. It is never needed either: that behaviour is
  // already the default.
  if (isAmbient(d)) {
    throw new TypeError("installDiagnostics: refusing to install an ambient handle (it would route diagnosticsFor back into itself)")
  }
  installed = d
  return () => { if (installed === d) installed = undefined }
}

function isAmbient(d: Diagnostics): boolean {
  for (const h of ambient.values()) if (h === d) return true
  return false
}
