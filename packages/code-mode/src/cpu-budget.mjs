/** CPU must belong to this worker, never to every thread in the host process.
 * Node 22.18 lacks threadCpuUsage: retain a conservative local wall fallback.
 * Select once before execution; a later clock failure fails the cell closed. */
function localClock() {
  const thread = process.threadCpuUsage
  if (typeof thread === 'function') {
    const read = () => {
      const usage = thread.call(process), value = (usage.user + usage.system) / 1000
      if (!Number.isFinite(value) || value < 0) throw new Error('Thread CPU accounting unavailable')
      return value
    }
    try { read(); return read } catch { /* Unsupported native clock: conservative fallback. */ }
  }
  return () => performance.now()
}

export function createCpuBudget(limitMs) {
  const clock = localClock()
  let used = 0, start = 0, active = false
  return {
    begin() { start = clock(); active = true },
    end() {
      try { if (active) used += Math.max(0, clock() - start) }
      finally { active = false }
    },
    exceeded() { return used + (active ? Math.max(0, clock() - start) : 0) >= limitMs },
  }
}
