import type { SessionEvent } from "@i-harness/core-session"
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
  const { id } = await coordinator.create({
    ...(title !== undefined ? { title } : {}),
    ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
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
  return events.slice(0, cut)
}
