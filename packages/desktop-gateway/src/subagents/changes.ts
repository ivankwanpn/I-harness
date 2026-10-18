import type { SessionAssembly, SessionService } from "@i-harness/session-executor"
export function createSubagentChanges(service: SessionService, options: { onChanged?: (parentSessionId: string) => void }) {
  const bindings = new Map<string, { assembly: SessionAssembly; off: () => void }>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false
  function cancelChanged(parentId: string) {
    clearTimeout(timers.get(parentId)); timers.delete(parentId)
  }
  function changed(parentId: string) {
    if (closed || timers.has(parentId)) return
    timers.set(parentId, setTimeout(() => {
      timers.delete(parentId)
      if (!closed) { try { options.onChanged?.(parentId) } catch { /* A disconnected UI cannot fail child execution or controls. */ } }
    }, 50))
  }
  function detach() {
    for (const parentId of timers.keys()) cancelChanged(parentId)
    for (const binding of bindings.values()) binding.off()
    bindings.clear()
  }
  function attach(assembly: SessionAssembly) {
    const parentId = assembly.sessionId
    if (closed || !parentId) return
    const previous = bindings.get(parentId)
    if (previous?.assembly === assembly) return
    bindings.delete(parentId); previous?.off(); cancelChanged(parentId)
    if (!assembly.onSubagentsChanged) { changed(parentId); return }
    const binding = { assembly, off: () => {} }
    bindings.set(parentId, binding)
    binding.off = assembly.onSubagentsChanged(change => {
      if (closed || bindings.get(parentId) !== binding) return
      if (change.kind === "closed") {
        bindings.delete(parentId); binding.off(); cancelChanged(parentId)
        changed(parentId)
      } else if (service.liveAssembly(parentId) === assembly) changed(parentId)
    })
    changed(parentId)
  }
  let offAssembly: () => void
  try { offAssembly = service.onAssembly(attach, { includeExisting: true }) }
  catch (error) { closed = true; detach(); throw error }
  function open(): void { if (closed) throw new Error("Subagent catalog closed") }
  return { open, changed, close() { closed = true; offAssembly(); detach() } }
}
