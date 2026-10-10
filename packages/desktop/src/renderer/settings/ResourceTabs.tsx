import { useEffect, useId, useRef, useState, type ComponentProps } from "react"
import type { ResourceKind } from "@i-harness/desktop-gateway/src/resources.ts"
import { useText } from "../design/i18n.ts"
import { ResourceSettings } from "./ResourceSettings.tsx"

export function ResourceTabs({ resourceKind, onSelect, active = true, ...props }: Omit<ComponentProps<typeof ResourceSettings>, "resourceKind" | "active"> & { resourceKind: ResourceKind; onSelect(kind: ResourceKind): void; active?: boolean }) {
  const t = useText()
  const id = useId()
  const [visited, setVisited] = useState<ReadonlySet<ResourceKind>>(() => new Set([resourceKind]))
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const kinds = ["skills", "commands"] as const
  useEffect(() => { setVisited(previous => previous.has(resourceKind) ? previous : new Set([...previous, resourceKind])) }, [resourceKind])
  function select(kind: ResourceKind) {
    setVisited(previous => previous.has(kind) ? previous : new Set([...previous, kind]))
    onSelect(kind)
  }
  return <div className="settings-resource-tabs">
    <div role="tablist" aria-label={t("資源分類")} className="zc-pane-tabs">
      {kinds.map((kind, index) => <button key={kind} ref={element => { buttons.current[index] = element }} type="button" role="tab" className="zc-pane-tab" id={`${id}-${kind}-tab`} aria-controls={`${id}-${kind}-panel`} aria-selected={resourceKind === kind} tabIndex={resourceKind === kind ? 0 : -1} onClick={() => select(kind)} onKeyDown={event => {
        let next: number
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = (index + 1) % kinds.length
        else if (event.key === "Home") next = 0
        else if (event.key === "End") next = kinds.length - 1
        else return
        event.preventDefault(); select(kinds[next]!); buttons.current[next]?.focus()
      }}>{t(kind === "skills" ? "技能" : "命令")}</button>)}
    </div>
    {kinds.map(kind => visited.has(kind) || kind === resourceKind ? <div key={kind} role="tabpanel" id={`${id}-${kind}-panel`} aria-labelledby={`${id}-${kind}-tab`} hidden={resourceKind !== kind} tabIndex={0}>
      <ResourceSettings {...props} resourceKind={kind} active={active && resourceKind === kind} />
    </div> : null)}
  </div>
}
