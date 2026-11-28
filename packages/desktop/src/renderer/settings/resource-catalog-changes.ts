import type { ResourceKind } from "@i-harness/desktop-gateway/src/resources.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"

interface ResourceChange { workspaceId?: string; kind?: ResourceKind }
type Listener = (change: ResourceChange) => void
const listeners = new WeakMap<DesktopBridge, Set<Listener>>()

export function onResourceChange(bridge: DesktopBridge, listener: Listener) {
  const observers = listeners.get(bridge) ?? new Set<Listener>()
  listeners.set(bridge, observers)
  observers.add(listener)
  return () => { observers.delete(listener) }
}

/** Shared files and plugin changes can affect every retained folder view. */
export function notifyResourceChange(bridge: DesktopBridge, change: ResourceChange) {
  listeners.get(bridge)?.forEach(listener => listener(change))
}
