import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { DesktopBridge } from "../shared/bridge.ts"

const WindowVisibility = createContext(true)

export function WindowVisibilityProvider({ bridge, children }: { bridge: DesktopBridge; children: ReactNode }) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    let active = true
    let sawEvent = false
    const off = bridge.onEvent(event => {
      if (!active || event.kind !== "window/state" || typeof event.visible !== "boolean") return
      sawEvent = true
      setVisible(event.visible)
    })
    void bridge.request({ kind: "window/state" }).then(reply => {
      if (!active || sawEvent || !reply || typeof reply !== "object" || !("visible" in reply)) return
      if (typeof reply.visible === "boolean") setVisible(reply.visible)
    }).catch(() => { /* The DOM visibility check also supports bridges without native state. */ })
    return () => { active = false; off() }
  }, [bridge])

  return <WindowVisibility.Provider value={visible}>{children}</WindowVisibility.Provider>
}

export function useWindowVisibility(): boolean {
  return useContext(WindowVisibility)
}
