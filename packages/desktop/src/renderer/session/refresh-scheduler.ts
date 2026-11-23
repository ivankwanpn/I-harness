/** Coalesce event bursts and keep at most one background refresh in flight. */
export function createRefreshScheduler(refresh: () => Promise<unknown>, delay = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let dirty = false
  let disposed = false
  const schedule = (wait = delay) => {
    if (disposed) return
    dirty = true
    if (running || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      dirty = false
      running = true
      void Promise.resolve().then(refresh).catch(() => undefined).finally(() => {
        running = false
        if (dirty) schedule()
      })
    }, wait)
  }
  return {
    schedule,
    poll() { if (!running && timer === undefined) schedule() },
    dispose() {
      disposed = true
      dirty = false
      clearTimeout(timer)
    },
  }
}
