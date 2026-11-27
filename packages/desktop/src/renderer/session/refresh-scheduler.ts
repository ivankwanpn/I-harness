/** Coalesce event bursts into one in-flight read per active generation. */
export function createRefreshScheduler(refresh: () => Promise<unknown>, delay = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: object | undefined
  let dirty = false
  let disposed = false
  const schedule = (wait = delay) => {
    if (disposed) return
    dirty = true
    if (running || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      dirty = false
      const flight = {}
      running = flight
      void Promise.resolve().then(() => running === flight ? refresh() : undefined).catch(() => undefined).finally(() => {
        if (running !== flight) return
        running = undefined
        if (dirty) schedule()
      })
    }, wait)
  }
  const retire = () => {
    const interrupted = dirty || running !== undefined
    dirty = false
    clearTimeout(timer)
    timer = undefined
    running = undefined
    return interrupted
  }
  return {
    schedule,
    retire,
    dispose() {
      disposed = true
      retire()
    },
  }
}
