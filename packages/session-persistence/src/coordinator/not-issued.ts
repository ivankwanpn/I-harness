/**
 * True when a failed mutation provably issued nothing: for example a torn
 * journal tail that must be repaired before any append can be encoded. The
 * caller still receives the error, but the attempt leaves no ambiguous durable
 * state and therefore must not poison the process read latch (S-03: the poison
 * had no exit and disabled every later spawn and cold read).
 */
export function notIssuedFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { notIssued?: unknown }).notIssued === true
}
