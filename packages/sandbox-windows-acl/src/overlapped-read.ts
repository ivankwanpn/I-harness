type Outcome = { kind: 'data'; bytes: Buffer } | { kind: 'eof' } | { kind: 'aborted'; error?: unknown } | { kind: 'error'; error: unknown }
type Submission = Outcome | { kind: 'pending' } | { kind: 'unknown'; error: unknown }
export interface ReadBoundary {
  submit(): Submission
  observe(): { signalled: Promise<void>; close(): Promise<void> }
  result(): Outcome
  cancel(): void
  release(): void
}

/** Owns exactly one outstanding read; release follows read and callback ACK. */
export function createReadOwner(api: ReadBoundary) {
  let pending = false
  let observer: ReturnType<ReadBoundary['observe']> | undefined
  let cancelled = false
  let released = false
  let operation: Promise<Buffer> | undefined
  let cleanup: Promise<void> | undefined
  let acknowledged: Outcome | undefined
  let unknownSubmission = false
  const chunks: Buffer[] = []
  function retain(outcome: Outcome): Outcome {
    acknowledged = outcome.kind === 'aborted' && outcome.error === undefined
      ? { kind: 'aborted', error: new Error('read aborted') } : outcome
    return acknowledged
  }
  function withPrimary(error: unknown): unknown {
    const primary = acknowledged?.kind === 'error' || acknowledged?.kind === 'aborted' ? acknowledged : undefined
    if (!primary || error === primary.error) return error
    if (error instanceof AggregateError && error.errors[0] === primary.error) return error
    return new AggregateError([primary.error, error], 'native read failed and cleanup is incomplete', { cause: primary.error })
  }
  async function settlePending(): Promise<Outcome> {
    observer ??= api.observe()
    try { await observer.signalled } catch (error) {
      // A failed native registration may still own its callback/slot. Retire
      // that partial observer before another observation attempt; retain it if
      // retirement itself fails. The original I/O is still pending throughout.
      try { await observer.close(); observer = undefined } catch { /* retry debt */ }
      throw error
    }
    const outcome = retain(api.result())
    pending = false
    try { await observer.close() } catch (error) { throw withPrimary(error) }
    observer = undefined
    return outcome
  }
  async function release(): Promise<void> {
    if (unknownSubmission) throw new Error('read submission outcome unknown; native storage remains owned')
    if (pending) await settlePending()
    if (observer) { await observer.close(); observer = undefined }
    if (!released) { api.release(); released = true }
  }
  function cleanupOnce(): Promise<void> {
    if (cleanup) return cleanup
    const attempt = release().catch(error => { throw withPrimary(error) })
    cleanup = attempt
    void attempt.finally(() => { if (cleanup === attempt) cleanup = undefined }).catch(() => {})
    return attempt
  }
  function readAll(): Promise<Buffer> {
    if (operation) return operation
    operation = (async () => {
      try {
        while (!cancelled) {
          let result = api.submit()
          if (result.kind === 'unknown') {
            unknownSubmission = true
            pending = true
            throw result.error
          }
          if (result.kind === 'pending') {
            pending = true
            result = await settlePending()
          } else result = retain(result)
          if (result.kind === 'eof') break
          if (result.kind === 'aborted') throw result.error
          if (result.kind === 'error') throw result.error
          if (result.bytes.length === 0) throw new Error('zero-length successful pipe read')
          chunks.push(Buffer.from(result.bytes))
        }
        if (cancelled) throw new Error('read cancelled')
        await cleanupOnce()
        return Buffer.concat(chunks)
      } catch (error) {
        if (pending) { try { api.cancel() } catch { /* original read remains owned */ } }
        throw error
      }
    })()
    return operation
  }
  async function cancel(): Promise<void> {
    cancelled = true
    if (pending) api.cancel()
    if (operation) await operation.catch(() => {})
    await cleanupOnce()
  }
  async function cleanupAfterOperation(): Promise<void> {
    if (operation) await operation.catch(() => {})
    await cleanupOnce()
  }
  return { readAll, cancel, cleanup: cleanupAfterOperation }
}
