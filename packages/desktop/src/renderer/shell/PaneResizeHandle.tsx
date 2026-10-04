import { useEffect, useRef, type PointerEvent } from "react"

export function PaneResizeHandle({ side, label, width, min, max, defaultWidth, onResize }: {
  side: "left" | "right"; label: string; width: number; min: number; max: number; defaultWidth: number; onResize(width: number): void
}) {
  const drag = useRef<{ x: number; width: number; pointerId: number; element: HTMLDivElement } | undefined>(undefined)
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)))
  function finish() {
    const current = drag.current
    drag.current = undefined
    if (!current) return
    if (current.element.isConnected && current.element.hasPointerCapture?.(current.pointerId)) current.element.releasePointerCapture(current.pointerId)
    delete document.documentElement.dataset.paneResizing
  }
  useEffect(() => finish, [])
  function move(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    onResize(clamp(current.width + (event.clientX - current.x) * (side === "left" ? 1 : -1)))
  }
  return <div className={`pane-resizer ${side === "left" ? "sidebar-resizer" : "review-resizer"}`} role="separator" aria-label={label} aria-orientation="vertical" aria-valuenow={width} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
    onPointerDown={event => {
      if (event.button !== 0 || event.isPrimary === false || drag.current) return
      event.preventDefault()
      event.currentTarget.focus()
      const actual = event.currentTarget.parentElement?.getBoundingClientRect().width
      drag.current = { x: event.clientX, width: actual && actual > 0 ? actual : width, pointerId: event.pointerId, element: event.currentTarget }
      document.documentElement.dataset.paneResizing = side
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }}
    onPointerMove={move} onPointerUp={event => { move(event); finish() }} onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={() => onResize(clamp(defaultWidth))}
    onKeyDown={event => {
      if (event.key === "Escape" && drag.current) { onResize(clamp(drag.current.width)); finish(); event.stopPropagation() }
      else if (event.key === "ArrowLeft") onResize(clamp(width + (side === "left" ? -20 : 20)))
      else if (event.key === "ArrowRight") onResize(clamp(width + (side === "left" ? 20 : -20)))
      else if (event.key === "Home") onResize(min)
      else if (event.key === "End") onResize(max)
      else if (event.key === "Enter") onResize(clamp(defaultWidth))
      else return
      event.preventDefault()
    }} />
}
