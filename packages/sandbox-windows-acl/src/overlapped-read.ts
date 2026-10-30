type Outcome = { kind: 'data'; bytes: Buffer } | { kind: 'eof' } | { kind: 'aborted' } | { kind: 'error'; error: unknown }
type Submission = Outcome | { kind: 'pending' }
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
  const chunks: Buffer[] = []
  async function settlePending(): Promise<Outcome> {
    observer ??= api.observe()
    try { await observer.signalled } catch (error) {
      // A failed native registration may still own its callback/slot. Retire
      // that partial observer before another observation attempt; retain it if
      // retirement itself fails. The original I/O is still pending throughout.
      try { await observer.close(); observer = undefined } catch { /* retry debt */ }
      throw error
    }
    const outcome = api.result()
    pending = false
    await observer.close()
    observer = undefined
    return outcome
  }
  async function release(): Promise<void> {
    if (pending) await settlePending()
    if (observer) { await observer.close(); observer = undefined }
    if (!released) { api.release(); released = true }
  }
  function cleanupOnce(): Promise<void> {
    if (cleanup) return cleanup
    const attempt = release()
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
          if (result.kind === 'pending') {
            pending = true
            result = await settlePending()
          }
          if (result.kind === 'eof') break
          if (result.kind === 'aborted') throw new Error('read aborted')
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
