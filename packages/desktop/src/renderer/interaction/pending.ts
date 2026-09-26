/** One pending approval or question exactly as the host described it. */
export interface PendingInteraction {
  requestId: string
  sessionId: string
  kind: "approval" | "question"
  payload: unknown
  openedAt: number
}

export function upsertPending(list: PendingInteraction[], view: PendingInteraction): PendingInteraction[] {
  const index = list.findIndex((row) => row.requestId === view.requestId)
  if (index === -1) return [...list, view]
  return list.map((row, at) => at === index ? view : row)
}

export function removePending(list: PendingInteraction[], requestId: string): PendingInteraction[] {
  return list.filter((row) => row.requestId !== requestId)
}

export function pendingForSession(
  list: PendingInteraction[],
  sessionId: string | undefined,
): PendingInteraction[] {
  return sessionId === undefined ? [...list] : list.filter((row) => row.sessionId === sessionId)
}
