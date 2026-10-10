import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react"
import { useUiStore } from "./ui-store.ts"
import { useNarrowSidebar } from "./use-narrow-sidebar.ts"
import { listenForegroundEscape } from "../design/foreground-escape.ts"

/** A single retained slot owns docking, temporary Home preview and narrow drawers. */
export function useSidebarNavigation(managementModalOpen = false) {
  const drawer = useNarrowSidebar()
  const surface = useUiStore(state => state.surface)
  const collapsed = useUiStore(state => state.sidebarCollapsed)
  const [mode, setMode] = useState<"home" | "project">("home")
  const [preview, setPreview] = useState(false)
  const homeButton = useRef<HTMLButtonElement>(null)
  const opening = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dismissal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const managementModal = useRef(managementModalOpen)
  managementModal.current = managementModalOpen
  const cancelTimers = useCallback(() => {
    clearTimeout(opening.current); clearTimeout(dismissal.current)
    opening.current = undefined; dismissal.current = undefined
  }, [])
  const closeTemporary = useCallback(() => {
    cancelTimers(); setPreview(false); drawer.setOpen(false)
  }, [cancelTimers, drawer.setOpen])
  useEffect(() => {
    cancelTimers(); setPreview(false)
    if (surface !== "conversation") drawer.setOpen(false)
    return cancelTimers
  }, [surface, cancelTimers, drawer.setOpen])
  useEffect(() => { closeTemporary() }, [drawer.narrow, closeTemporary])
  useEffect(() => {
    if (managementModalOpen) cancelTimers()
  }, [managementModalOpen, cancelTimers])
  const temporary = drawer.narrow ? drawer.open : preview
  useEffect(() => {
    if (!temporary || managementModalOpen) return
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null
      if (!managementModal.current && target && !drawer.container.current?.contains(target) && !homeButton.current?.contains(target)) closeTemporary()
    }
    // The narrow drawer owns focus trapping and restoration. A mouse preview
    // leaves focus in the conversation until the user moves it into the panel.
    const removeKeys = drawer.narrow ? undefined : listenForegroundEscape(drawer.container.current, () => { closeTemporary(); homeButton.current?.focus() })
    document.addEventListener("pointerdown", outside, true)
    return () => { removeKeys?.(); document.removeEventListener("pointerdown", outside, true) }
  }, [temporary, managementModalOpen, drawer.narrow, drawer.container, closeTemporary])
  function enterHome(event: PointerEvent) {
    clearTimeout(dismissal.current)
    if (managementModal.current || event.pointerType === "touch" || drawer.narrow || !collapsed || surface !== "conversation") return
    clearTimeout(opening.current)
    opening.current = setTimeout(() => { setPreview(true); opening.current = undefined }, 180)
  }
  function leaveRegion() {
    // The portaled manager owns focus while #root is inert. Retain its sidebar
    // trigger until it returns focus, including any already queued hover timer.
    if (managementModal.current) { cancelTimers(); return }
    clearTimeout(opening.current); opening.current = undefined
    clearTimeout(dismissal.current)
    dismissal.current = setTimeout(() => {
      dismissal.current = undefined
      if (!managementModal.current && !drawer.container.current?.contains(document.activeElement)) setPreview(false)
    }, 160)
  }
  function enterPanel() { clearTimeout(dismissal.current); dismissal.current = undefined }
  function homeClick() {
    const alreadyDocked = mode === "home" && !collapsed && surface === "conversation"
    closeTemporary(); setMode("home"); useUiStore.getState().setSurface("conversation")
    if (drawer.narrow) drawer.setOpen(!(drawer.open && mode === "home"))
    else useUiStore.getState().update({ sidebarCollapsed: alreadyDocked })
  }
  function toggle() {
    closeTemporary()
    if (drawer.narrow) drawer.setOpen(!drawer.open)
    else useUiStore.getState().update({ sidebarCollapsed: !collapsed })
  }
  function collapse() {
    closeTemporary()
    if (!drawer.narrow && !preview) useUiStore.getState().update({ sidebarCollapsed: true })
  }
  function openProject() {
    closeTemporary(); setMode("project"); useUiStore.getState().setSurface("conversation")
    if (drawer.narrow) drawer.setOpen(true)
    else useUiStore.getState().update({ sidebarCollapsed: false })
  }
  return { ...drawer, mode: preview ? "home" as const : mode, preview, temporary, homeButton, homeClick, enterHome, leaveRegion, enterPanel, closeTemporary, toggle, collapse, openProject }
}
