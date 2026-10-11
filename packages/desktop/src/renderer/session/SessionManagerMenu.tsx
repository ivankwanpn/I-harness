import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { listenForegroundEscape } from "../design/foreground-escape.ts"

/** The manager's two menus share placement and keyboard ownership. */
export function SessionManagerMenu({ id, label, anchor, initialFocusSelector = '[role^="menuitem"]:not(:disabled)', onClose, children }: {
  id: string
  label: string
  anchor: HTMLElement
  initialFocusSelector?: string
  onClose(restoreFocus?: boolean): void
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [position, setPosition] = useState({ left: 8, top: 8 })
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const place = () => {
      const target = anchor.getBoundingClientRect(), rect = element.getBoundingClientRect()
      const below = window.innerHeight - target.bottom - 8
      const top = below >= rect.height || below >= target.top - 8 ? target.bottom + 5 : target.top - rect.height - 5
      setPosition({ left: Math.max(8, Math.min(target.right - rect.width, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - rect.height - 8)) })
    }
    place()
    const preferred = element.querySelector<HTMLElement>(initialFocusSelector)
    const initial = preferred && !preferred.matches(":disabled") ? preferred : element.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')
    initial?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target) && !anchor.contains(event.target)) close.current(false)
    }
    const scroll = (event: Event) => {
      if (event.target instanceof Node && !element.contains(event.target)) close.current()
    }
    const escape = listenForegroundEscape(element, () => close.current(), undefined, () => close.current())
    document.addEventListener("pointerdown", outside)
    window.addEventListener("resize", place)
    window.addEventListener("scroll", scroll, true)
    return () => {
      document.removeEventListener("pointerdown", outside)
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", scroll, true)
      escape()
    }
  }, [anchor, initialFocusSelector])
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length
    event.preventDefault()
    items[next]?.focus()
  }
  return createPortal(<div ref={panel} id={id} role="menu" aria-label={label} className="session-manager-menu" style={position} onKeyDown={keyboard}>{children}</div>, document.body)
}
