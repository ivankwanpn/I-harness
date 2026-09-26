import { useRef } from "react"
import { useText } from "../design/i18n.ts"
export function ReviewResizeHandle({ width, onResize }: { width: number; onResize(width: number): void }) {
  const t = useText()
  const drag = useRef<{ x: number; width: number } | undefined>(undefined)
  return <div className="review-resizer" role="separator" aria-label={t("調整成果面板寬度")} aria-orientation="vertical" aria-valuenow={width} aria-valuemin={280} aria-valuemax={640} tabIndex={0}
    onPointerDown={(event) => { if (event.button !== 0) return; drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }}
    onPointerMove={(event) => { if (drag.current) onResize(drag.current.width + drag.current.x - event.clientX) }}
    onPointerUp={(event) => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
    onLostPointerCapture={() => { drag.current = undefined }}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") onResize(width + 20)
      else if (event.key === "ArrowRight") onResize(width - 20)
      else if (event.key === "Home") onResize(280)
      else if (event.key === "End") onResize(640)
      else return
      event.preventDefault()
    }} />
}
