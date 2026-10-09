import { useEffect, useRef, type RefObject } from "react"
import type { DesktopBridge, DesktopRequest } from "../../shared/bridge.ts"

type ShowRequest = Extract<DesktopRequest, { kind: "browser/show" }>
type VisibilityRequest = ShowRequest | { kind: "browser/hide"; workspaceId: string }
interface ViewportOwner { refresh(force?: boolean): void }
// A late receipt from a retired pane must restore the current pane's viewport.
const owners = new WeakMap<DesktopBridge, ViewportOwner>()
const overlaySelector = '[role="dialog"], [role="alertdialog"], [role="menu"], dialog[open]'

function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(parent)
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false
  }
  return true
}

function sameRequest(left: VisibilityRequest | undefined, right: VisibilityRequest): boolean {
  if (!left || left.kind !== right.kind || left.workspaceId !== right.workspaceId) return false
  if (left.kind === "browser/hide" || right.kind === "browser/hide") return true
  return left.id === right.id && left.bounds.x === right.bounds.x && left.bounds.y === right.bounds.y && left.bounds.width === right.bounds.width && left.bounds.height === right.bounds.height
}

/** Native WebContentsViews render above React. Visible renderer overlays own
 * the foreground, including legacy dialogs and portaled model/approval menus. */
export function useNativeBrowserViewport(bridge: DesktopBridge, workspaceId: string, viewport: RefObject<HTMLDivElement | null>, options: {
  tabId?: string
  visible: boolean
  onError(error: string | undefined): void
}): void {
  const current = useRef(options)
  current.current = options
  const mounted = useRef<ViewportOwner>(undefined)

  useEffect(() => {
    let active = true, revision = 0, serial = 0
    let desired: VisibilityRequest | undefined
    let frame: number | undefined
    const document = viewport.current?.ownerDocument ?? window.document
    const hideRequest = { kind: "browser/hide", workspaceId } as const
    const ownsViewport = () => active && owners.get(bridge) === owner
    const obstructed = () => !current.current.visible || !current.current.tabId || document.hidden || !viewport.current || !visible(viewport.current)
      || Array.from(document.querySelectorAll<HTMLElement>(overlaySelector)).some(visible)

    const send = (request: VisibilityRequest, force: boolean) => {
      if (!ownsViewport() || !force && sameRequest(desired, request)) return
      if (!sameRequest(desired, request)) revision++
      desired = request
      const sentRevision = revision, sentSerial = ++serial
      void bridge.request(request).then(() => {
        if (!ownsViewport() || revision !== sentRevision) {
          const latest = owners.get(bridge)
          if (latest) latest.refresh(true)
          else if (request.kind === "browser/show") void bridge.request(hideRequest).catch(() => undefined)
          return
        }
        if (sentSerial === serial) current.current.onError(undefined)
      }).catch((reason: unknown) => {
        if (ownsViewport() && sentRevision === revision && sentSerial === serial) current.current.onError(String(reason))
      })
    }
    const refresh = (force = false) => {
      if (!ownsViewport()) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (obstructed()) { send(hideRequest, force); return }
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (!ownsViewport()) return
        const bounds = viewport.current?.getBoundingClientRect()
        if (obstructed() || !bounds || bounds.width < 1 || bounds.height < 1) { send(hideRequest, force); return }
        send({ kind: "browser/show", workspaceId, id: current.current.tabId!, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }, force)
      })
    }
    const owner: ViewportOwner = { refresh }
    owners.set(bridge, owner)
    mounted.current = owner
    const layout = () => refresh(true)
    const resize = new ResizeObserver(layout)
    if (viewport.current) resize.observe(viewport.current)
    const overlays = new MutationObserver(() => refresh())
    overlays.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "hidden", "aria-hidden", "inert", "open", "class", "style"] })
    window.addEventListener("resize", layout)
    window.addEventListener("scroll", layout, true)
    document.addEventListener("visibilitychange", layout)
    refresh()
    return () => {
      active = false
      if (frame !== undefined) cancelAnimationFrame(frame)
      resize.disconnect(); overlays.disconnect()
      window.removeEventListener("resize", layout); window.removeEventListener("scroll", layout, true); document.removeEventListener("visibilitychange", layout)
      if (mounted.current === owner) mounted.current = undefined
      if (owners.get(bridge) !== owner) return
      owners.delete(bridge)
      void bridge.request(hideRequest).catch(() => undefined)
    }
  }, [bridge, workspaceId, viewport])

  useEffect(() => { mounted.current?.refresh() }, [options.tabId, options.visible])
}
