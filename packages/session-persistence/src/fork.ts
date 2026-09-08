import { CURRENT_FORMAT_VERSION, rewindCuts, type SessionEvent } from "@i-harness/core-session"
import type { SessionCoordinator } from "./index.ts"

export interface ForkSessionOptions {
  atSeq?: number
  title?: string
  workspaceId?: string
}

export interface ForkSessionResult {
  sessionId: string
  seedLength: number
  title?: string
}

export class SessionForkUnavailableError extends Error {
  readonly code = "fork-unavailable" as const

  constructor(message: string) {
    super(message)
    this.name = "SessionForkUnavailableError"
  }
}

export async function forkSession(
  coordinator: SessionCoordinator,
  sourceSessionId: string,
  options: ForkSessionOptions = {},
): Promise<ForkSessionResult> {
  if (options.atSeq !== undefined
    && (!Number.isInteger(options.atSeq) || options.atSeq < 0)) {
    throw new TypeError("atSeq must be a non-negative integer")
  }

  const [{ session }, profile] = await Promise.all([
    coordinator.load(sourceSessionId),
    coordinator.profile(sourceSessionId),
  ])
  const prefix = completedTurnPrefix(session.events, sourceSessionId, options.atSeq)
  const title = options.title ?? profile.meta.title
  const workspaceId = options.workspaceId ?? profile.meta.workspaceId
  const { id } = await coordinator.create({
    ...(title !== undefined ? { title } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    parentSession: sourceSessionId,
    seedLength: prefix.length,
  })
  if (prefix.length > 0) await coordinator.append(id, prefix)
  return {
    sessionId: id,
    seedLength: prefix.length,
    ...(title !== undefined ? { title } : {}),
  }
}

export function completedTurnPrefix(
  events: readonly SessionEvent[],
  sourceSessionId: string,
  atSeq: number | undefined,
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

  // M54 A3 (research G5): apply the SAME hidden-region semantics deriveMessages
  // uses on the source (core-session `rewindCuts`): a rewind/point marker hides
  // every event whose seq falls in [anchorSeq, markerSeq). The fork seed must
  // match what the model sees — pre-fix the prefix copied the hidden turns AND
  // the marker into the child, resurrecting turns the source no longer shows.
  //
  // Marker decision (a): DROP the rewind/point markers. The child never had the
  // rewound turns, so a copied marker would assert a cut window over a region
  // the child's own log never contained — a phantom cut. `rewindCuts(child)`
  // must be [] (nothing to hide), not a window pointing at unrelated child
  // events once the child's own log is renumbered/appended to.
  //
  // The child is a FRESH session, so its log must satisfy loadOwned's
  // seq === index invariant: the kept events are renumbered 0..n-1 and the seq
  // references the projection reads (compaction summary/reset shadow sets and
  // session/title messageSeqs) are remapped into the child's coordinates — refs
  // into the dropped region disappear with the events they named.
  const cuts = rewindCuts({ formatVersion: CURRENT_FORMAT_VERSION, events: [...events] })
  const carriesMarker = prefix.some((event) => event.type === "rewind/point")
  if (cuts.length === 0 && !carriesMarker) return prefix
  const isHidden = (seq: number | undefined): boolean =>
    seq !== undefined && cuts.some((window) => window.cutFrom <= seq && seq < window.markerSeq)
  const kept = prefix.filter((event) => event.type !== "rewind/point" && !isHidden(event.seq))
  if (kept.length === prefix.length) return prefix
  const renumbered = new Map<number, number>()
  for (const [index, event] of kept.entries()) {
    if (event.seq !== undefined) renumbered.set(event.seq, index)
  }
  return kept.map((event, index) => remapSeedEvent(event, index, renumbered))
}

// M54 A3: renumber one seed event into the child's coordinates, remapping the
// seq references the projection consumes. A reference into a dropped (hidden)
// region has no child-side target and is dropped with it.
function remapSeedEvent(event: SessionEvent, index: number, renumbered: ReadonlyMap<number, number>): SessionEvent {
  const remap = (seqs: number[]): number[] =>
    seqs.flatMap((seq) => {
      const mapped = renumbered.get(seq)
      return mapped === undefined ? [] : [mapped]
    })
  if (event.type === "compaction/summary") return { ...event, seq: index, shadowedSeqs: remap(event.shadowedSeqs) }
  if (event.type === "compaction/reset") return { ...event, seq: index, removedSeqs: remap(event.removedSeqs ?? []) }
  if (event.type === "session/title") return { ...event, seq: index, messageSeqs: remap(event.messageSeqs) }
  return { ...event, seq: index }
}
