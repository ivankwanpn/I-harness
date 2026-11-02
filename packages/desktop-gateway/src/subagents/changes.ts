import type { SessionAssembly, SessionService } from "@i-harness/session-executor"
import { onOriginalHostAssembly } from '../../../session-executor/src/host-assembly-observer.ts'
export function createSubagentChanges(service: SessionService, options: { onChanged?: (parentSessionId: string) => void }) {
  const bindings = new Map<string, { assembly: SessionAssembly; off: () => void }>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const managed = new Map<string,{owner:object;off:()=>void}>()
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
  try { offAssembly = onOriginalHostAssembly(service,attach,{ includeExisting: true }) }
  catch (error) { closed = true; detach(); throw error }
  const offManaged=service.onManagedRuntimeLifecycle?.(event=>{
    if(event.kind==='published'){
      const prior=managed.get(event.sessionId);prior?.off()
      const owner=event.owner,binding={owner,off:()=>{}}
      managed.set(event.sessionId,binding)
      try{binding.off=owner.subscribe(value=>{if(!closed&&managed.get(event.sessionId)===binding&&('type'in value)&&typeof value.type==='string'&&(value.type.startsWith('subagent/')||value.type.startsWith('team/')||value.type.startsWith('job/')))changed(event.sessionId)})}catch(error){managed.delete(event.sessionId);throw error}
      changed(event.sessionId)
    }else if(event.kind==='retiring'||event.kind==='removed'){
      const binding=managed.get(event.sessionId);if(binding?.owner===event.owner){managed.delete(event.sessionId);binding.off();cancelChanged(event.sessionId);changed(event.sessionId)}
    }
  },{includeExisting:true})
  function open(): void { if (closed) throw new Error("Subagent catalog closed") }
  return { open, changed, close() { closed = true; offAssembly();offManaged?.();for(const binding of managed.values())binding.off();managed.clear();detach() } }
}
