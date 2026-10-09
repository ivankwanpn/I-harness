import { FolderOpen, Folders, Plus, Puzzle, Search, Settings } from "lucide-react"
import { useText } from "../design/i18n.ts"

interface NavigationRailProps {
  surface: string
  onCreate(): void
  canCreate: boolean
  onOpenWorkspace?(): void
  onProjects?(): void
  onPlugins?(): void
  onSearch?(): void
  onSettings(): void
}

export function NavigationRail({ surface, onCreate, canCreate, onOpenWorkspace, onProjects, onPlugins, onSearch, onSettings }: NavigationRailProps) {
  const t = useText()
  return <nav className="navigation-rail" aria-label={t("主導覽")}>
    <div className="navigation-brand" aria-label="I-harness" title="I-harness">I</div>
    <button type="button" className="navigation-button" aria-label={t("新增會話")} title={t("新增會話")} disabled={!canCreate} onClick={onCreate}><Plus size={19} aria-hidden="true" /></button>
    {onOpenWorkspace ? <button type="button" className="navigation-button" aria-label={t("開啟工作區")} title={t("開啟工作區")} onClick={onOpenWorkspace}><FolderOpen size={18} aria-hidden="true" /></button> : null}
    {onProjects ? <button type="button" className="navigation-button" aria-label={t("管理專案")} title={t("管理專案")} aria-current={surface === "projects" ? "page" : undefined} onClick={onProjects}><Folders size={18} aria-hidden="true" /></button> : null}
    {onPlugins ? <button type="button" className="navigation-button" aria-label={t("插件市場")} title={t("插件市場")} aria-current={surface === "plugins" ? "page" : undefined} onClick={onPlugins}><Puzzle size={18} aria-hidden="true" /></button> : null}
    {onSearch ? <button type="button" className="navigation-button" aria-label={t("搜尋會話")} title={t("搜尋會話")} aria-current={surface === "search" ? "page" : undefined} onClick={onSearch}><Search size={18} aria-hidden="true" /></button> : null}
    <button type="button" className="navigation-button navigation-settings" aria-label={t("設定")} title={t("設定")} aria-current={surface === "settings" ? "page" : undefined} onClick={onSettings}><Settings size={19} aria-hidden="true" /></button>
  </nav>
}
