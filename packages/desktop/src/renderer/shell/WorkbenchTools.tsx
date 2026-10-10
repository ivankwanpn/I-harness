import { useState, type ReactNode } from "react"
import { PanelsTopLeft } from "lucide-react"
import { Button } from "../vendor/opencode/Button.tsx"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import { useLocale, useText } from "../design/i18n.ts"
import "./workbench-tools.css"

export interface WorkbenchTool {
  id: string
  label: string
  icon: ReactNode
  selected?: boolean
  open(): void
}

/** One named entry to the existing workspace tools. It creates no capability. */
export function WorkbenchTools({ groups }: { groups: { label: string; items: WorkbenchTool[] }[] }) {
  const en = useLocale(state => state.locale) === "en"
  const t = useText()
  const title = en ? "Workbench tools" : "工作台工具"
  const [open, setOpen] = useState(false)
  return <>
    <Button variant="ghost" size="small" className="header-action workbench-tools-trigger" icon={<PanelsTopLeft size={16} />} aria-label={title} title={title} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><span>{en ? "Tools" : "工具"}</span></Button>
    {open ? <SettingsDialog title={title} closeLabel={t("關閉")} initialFocusSelector=".workbench-tool-option" className="workbench-tool-menu" onClose={() => setOpen(false)}>
      {groups.filter(group => group.items.length).map(group => <section key={group.label} className="workbench-tool-group" aria-label={group.label}>
        <h3>{group.label}</h3>
        {group.items.map(item => <button key={item.id} type="button" className="workbench-tool-option" aria-pressed={item.selected} onClick={() => { item.open(); setOpen(false) }}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}
      </section>)}
    </SettingsDialog> : null}
  </>
}
