import { CURRENT_FORMAT_VERSION, rewindCuts, isContextEventType, type SessionEvent, type SessionEventView } from "@i-harness/core-session"
import { randomUUID } from 'node:crypto'
import { createForkSessionController, assertForkControllerIssued, type ForkSessionController } from './fork-controller.ts'
import { createInlineForkHost } from './fork-inline-host.ts'
import { createForkOperation, readForkPrepareRequest, ForkOperationError, ForkPreparationError, type ForkOperation, type ForkSuccess, type ForkOutcome, type ForkPrepareResult } from './fork-contract.ts'
import { remapConversationSeed, SessionForkUnavailableError } from "./seed.ts"
export { materializeMissingImageAdmissions, remapSeedEvent, SessionForkUnavailableError } from "./seed.ts"
import type { SessionCoordinator } from "./index.ts"

/** Select a completed parent prefix; batch seed semantics live in seed.ts. */
export interface ForkSessionOptions {
  atSeq?: number
  title?: string
  workspaceId?: string
  controller?: ForkSessionController
}
const defaults = new WeakMap<SessionCoordinator, ForkSessionController>()
function controllerFor(coordinator: SessionCoordinator, supplied?: ForkSessionController): ForkSessionController {
  if (supplied) { assertForkControllerIssued(coordinator, supplied); return supplied }
  let controller = defaults.get(coordinator)
  if (!controller) { controller = createForkSessionController(coordinator, createInlineForkHost(coordinator)); defaults.set(coordinator, controller) }
  return controller
}
async function requireSuccess(controller: ForkSessionController, operation: ForkOperation, mode: 'begin'|'retry'): Promise<ForkSuccess> {
  let outcome: ForkOutcome
  try { outcome = await controller.execute({ operation, mode }) }
  catch (cause) {
    if (cause instanceof ForkOperationError) throw new ForkOperationError(operation, cause.kind, { cause: cause.cause, outcome: cause.outcome, hostError: cause.hostError })
    throw new ForkOperationError(operation, 'host', { cause })
  }
  if (outcome.kind !== 'ready' && outcome.kind !== 'adopted') throw new ForkOperationError(operation, 'outcome', { outcome })
  return outcome
}

export async function forkSession(
  coordinator: SessionCoordinator,
  sourceSessionId: string,
  options: ForkSessionOptions = {},
): Promise<ForkSuccess> {
  if (options.atSeq !== undefined
    && (!Number.isInteger(options.atSeq) || options.atSeq < 0)) {
    throw new TypeError("atSeq must be a non-negative integer")
  }

  const controller = controllerFor(coordinator, options.controller)
  const request = readForkPrepareRequest({ version: 1, sourceSessionId,
    selection: { kind: 'completed', ...(options.atSeq === undefined ? {} : { atSeq: options.atSeq }) },
    metadata: { ...(options.title === undefined ? {} : { title: options.title }), ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }) } })
  let result: ForkPrepareResult
  try { result = await controller.prepare(request) }
  catch (cause) { throw new ForkPreparationError('unavailable', undefined, { cause }) }
  if (result.kind !== 'prepared') throw new ForkPreparationError('unavailable', result)
  const operation = createForkOperation(result.prepared, { operationId: randomUUID(), targetSessionId: randomUUID(), createdAt: new Date().toISOString() })
  return requireSuccess(controller, operation, 'begin')
}

export function retryForkSession(coordinator: SessionCoordinator, operation: ForkOperation, options: { controller?: ForkSessionController } = {}): Promise<ForkSuccess> {
  return requireSuccess(controllerFor(coordinator, options.controller), operation, 'retry')
}

export function completedTurnPrefix(
  events: readonly SessionEventView[],
  sourceSessionId: string,
  atSeq: number | undefined,
  sourceFormat = CURRENT_FORMAT_VERSION,
  sourceHeader?: import('@i-harness/core-session').SessionView['header'],
): SessionEvent[] {
  let boundaryIndex = -1
  if (atSeq === undefined) {
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index]!.type === "turn/end") {
        boundaryIndex = index
        break
      }
    }
  } else {
    for (let index = 0; index < events.length; index++) {
      const event = events[index]!
      if (event.type === "turn/end" && (event.seq ?? index) >= atSeq) {
        boundaryIndex = index
        break
      }
    }
    if (boundaryIndex === -1 && atSeq > events.length - 1) {
      for (let index = events.length - 1; index >= 0; index--) {
        if (events[index]!.type === "turn/end") {
          boundaryIndex = index
          break
        }
      }
    }
  }

  if (boundaryIndex === -1) {
    throw new SessionForkUnavailableError(
      atSeq !== undefined && atSeq <= events.length - 1
        ? `session "${sourceSessionId}" has not completed the turn containing event ${String(atSeq)}`
        : `session "${sourceSessionId}" has no completed turn to fork from`,
    )
  }

  let cut = boundaryIndex + 1
  while (cut < events.length && events[cut]!.type !== "turn/start") cut++
  const prefix = events.slice(0, cut)
  // Positional replacements require their historical proof and cuts intact.
  // The central compiler refuses missing/out-of-boundary dependencies.
  if (events.some(event => event.type === 'compaction/replacement')) return remapConversationSeed({ sourceFormat, sourceHeader, source: events, retained: prefix })

  // M54 A3 (research G5): apply the SAME hidden-region semantics deriveMessages
  // uses on the source (core-session `rewindCuts`): a rewind/point marker hides
  // every event whose seq falls in [anchorSeq, markerSeq). The fork seed must
  // match what the model sees — pre-fix the prefix copied the hidden turns AND
  // the marker into the child, resurrecting turns the source no longer shows.
  //
  // Window extension: the rewind engine anchors at the hidden turn's FIRST
  // user/message (packages/rewind/src/types.ts:29-31; assembly.ts:320-323,
  // first-wins), and core-agent appends `turn/start` immediately before it
  // (core-agent/src/index.ts:180-182) — so the raw window starts AFTER the
  // hidden turn's own turn/start. Extend each window back to the turn/start
  // that opens the anchor turn: otherwise the child keeps an orphan turn/start
  // (two consecutive turn/start, or a trailing one that repairTurnTail closes
  // with a synthetic turn/end and loadOwned then rewrites into the child file),
  // and raw-log turnCount still counts the rewound turn.
  //
  // Marker decision (a): DROP the rewind/point markers. The child never had the
  // rewound turns, so a copied marker would assert a cut window over a region
  // the child's own log never contained — a phantom cut. `rewindCuts(child)`
  // must be [] (nothing to hide), not a window pointing at unrelated child
  // events once the child's own log is renumbered/appended to.
  //
  // Compaction markers (summary/reset/prune) are KEPT even inside a window:
  // they are not cuts, and deriveMessages applies their shadow/prune effects
  // INDEPENDENTLY of cut windows (core-session/src/index.ts:410-422, 426-428 —
  // "a rewind NEVER un-shadows a compaction's removed seqs"). Dropping an
  // in-window marker would un-shadow the kept events it names before cutFrom.
  //
  // The child is a FRESH session, so its log must satisfy loadOwned's
  // seq === index invariant: the kept events are renumbered 0..n-1 and the seq
  // references the projection reads (compaction summary/reset shadow sets and
  // session/title messageSeqs) are remapped into the child's coordinates — refs
  // into the dropped region disappear with the events they named.
  const cuts = rewindCuts({ formatVersion: CURRENT_FORMAT_VERSION, events: [...events] })
  const carriesMarker = prefix.some((event) => event.type === "rewind/point")
  if (cuts.length === 0 && !carriesMarker) return remapConversationSeed({ sourceFormat, sourceHeader, source: events, retained: prefix })
  const hidden = new Set<number>()
  for (const window of cuts) {
    let from = window.cutFrom
    // `<=`: when the anchor IS the turn/start, `from` stays there; when the
    // anchor is the turn's first user/message, `from` moves to that turn's
    // turn/start (the last turn/start at or before the anchor).
    for (const event of events) {
      if (event.seq !== undefined && event.seq <= window.cutFrom && event.type === "turn/start") from = event.seq
    }
    for (const event of events) {
      if (event.seq !== undefined && event.seq >= from && event.seq < window.markerSeq) hidden.add(event.seq)
    }
  }
  const isCompactionMarker = (type: SessionEvent["type"]): boolean =>
    type === "compaction/summary" || type === "compaction/reset" || type === "compaction/prune"
  const kept = prefix.filter((event) =>
    event.type !== "rewind/point"
    && !isContextEventType(event.type)
    && (isCompactionMarker(event.type) || event.seq === undefined || !hidden.has(event.seq)))
  if (kept.length === prefix.length) return remapConversationSeed({ sourceFormat, sourceHeader, source: events, retained: prefix })
  return remapConversationSeed({ sourceFormat, sourceHeader, source: events, retained: kept })
}
