import { generationError } from '@i-harness/llm-seam'

/** Monotonic live expiry; wall facts permit conservative detectable cold checks. */
export function generationClock(startedAt: number, expiresAt: number, trustedAt: number, signal: AbortSignal, start?: { wall: number; monotonic: number }) {
  const wall = Date.now(), anchor = performance.now()
  if (![wall, startedAt, expiresAt, trustedAt].every(Number.isSafeInteger) || wall < trustedAt || !Number.isFinite(anchor) || anchor < 0) throw generationError('GENERATION_CLOCK_INVALID')
  if (start?.wall === startedAt && (!Number.isFinite(start.monotonic) || start.monotonic < 0 || start.monotonic > anchor)) throw generationError('GENERATION_CLOCK_INVALID')
  const liveStart = start?.wall === startedAt ? start : undefined
  const restoredAt = liveStart?.wall ?? Math.max(startedAt, wall, trustedAt), elapsedFrom = liveStart?.monotonic ?? anchor, cancel = new AbortController()
  let deadline = expiresAt, latest = restoredAt, invalid: Error | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false
  const invalidate = () => { invalid ??= generationError('GENERATION_CLOCK_INVALID'); cancel.abort(invalid); return latest }
  // Required issued settlements can retain this last trusted scalar even after
  // clock failure. New work must always call check, which refuses that failure.
  const now = () => {
    if (invalid) return latest
    const elapsed = performance.now() - elapsedFrom, value = restoredAt + Math.floor(elapsed)
    if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isSafeInteger(value) || value < latest) return invalidate()
    latest = value
    return value
  }
  const check = () => {
    signal.throwIfAborted()
    if (stopped) throw generationError('GENERATION_CLOSED')
    const current = now()
    if (invalid) throw invalid
    if (current >= deadline) throw generationError('GENERATION_EXPIRED')
  }
  const schedule = () => {
    const remaining = deadline - now()
    if (invalid) return
    if (remaining <= 0) { cancel.abort(generationError('GENERATION_EXPIRED')); return }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647))
    timer.unref?.()
  }
  schedule()
  return { now, check, signal: AbortSignal.any([signal, cancel.signal]), constrain(expires: number) {
    if (!Number.isSafeInteger(expires)) { invalidate(); throw invalid }
    deadline = Math.min(deadline, expires); if (timer) clearTimeout(timer); schedule()
  }, close() { stopped = true; if (timer) clearTimeout(timer) } }
}
