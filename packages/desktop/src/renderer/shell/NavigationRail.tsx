import { Folders, Home, Plus, Puzzle, Search, Settings } from "lucide-react"
import type { Ref, PointerEventHandler } from "react"
import { useText } from "../design/i18n.ts"

interface NavigationRailProps {
  surface: string
  homeOpen: boolean
  homeButtonRef?: Ref<HTMLButtonElement>
  onHome(): void
  onCreate(): void
  canCreate: boolean
  onHomePointerEnter?: PointerEventHandler<HTMLButtonElement>
  onHomePointerLeave?: PointerEventHandler<HTMLButtonElement>
  onProjects?(): void
  onPlugins?(): void
  onSearch?(): void
  onSettings(): void
}

export function NavigationRail({ surface, homeOpen, homeButtonRef, onHome, onCreate, canCreate, onHomePointerEnter, onHomePointerLeave, onProjects, onPlugins, onSearch, onSettings }: NavigationRailProps) {
  const t = useText()
  return <nav className="navigation-rail" aria-label={t("主導覽")}>
    <button ref={homeButtonRef} type="button" className="navigation-button navigation-home" aria-label={t("首頁")} title={t("首頁")} aria-expanded={homeOpen} aria-controls="navigation-sidebar" onPointerEnter={onHomePointerEnter} onPointerLeave={onHomePointerLeave} onClick={onHome}><Home size={20} aria-hidden="true" /></button>
    <button type="button" className="navigation-button" aria-label={t("新增會話")} title={t("新增會話")} disabled={!canCreate} onClick={onCreate}><Plus size={19} aria-hidden="true" /></button>
    {onProjects ? <button type="button" className="navigation-button" aria-label={t("專案")} title={t("專案")} aria-current={surface === "projects" ? "page" : undefined} onClick={onProjects}><Folders size={18} aria-hidden="true" /></button> : null}
    {onPlugins ? <button type="button" className="navigation-button" aria-label={t("插件市場")} title={t("插件市場")} aria-current={surface === "plugins" ? "page" : undefined} onClick={onPlugins}><Puzzle size={18} aria-hidden="true" /></button> : null}
    {onSearch ? <button type="button" className="navigation-button" aria-label={t("搜尋會話")} title={t("搜尋會話")} aria-current={surface === "search" ? "page" : undefined} onClick={onSearch}><Search size={18} aria-hidden="true" /></button> : null}
    <button type="button" className="navigation-button navigation-settings" aria-label={t("設定")} title={t("設定")} aria-current={surface === "settings" ? "page" : undefined} onClick={onSettings}><Settings size={19} aria-hidden="true" /></button>
  </nav>
}
