import { useText } from "../design/i18n.ts"
import { PaneResizeHandle } from "../shell/PaneResizeHandle.tsx"
export function ReviewResizeHandle({ width, min = 280, max = 1200, onResize }: { width: number; min?: number; max?: number; onResize(width: number): void }) {
  const t = useText()
  return <PaneResizeHandle side="right" label={t("調整成果面板寬度")} width={width} min={min} max={max} defaultWidth={360} onResize={onResize} />
}
