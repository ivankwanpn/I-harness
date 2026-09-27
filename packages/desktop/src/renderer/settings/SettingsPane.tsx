import { useState } from "react"
import { ArrowLeft, Settings, Palette, Bell, Server, Folder, Info, Brain, Puzzle, Shield } from "lucide-react"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { useLocale, useText } from "../design/i18n.ts"
import { usePreferences, type Appearance } from "../design/preferences.ts"
import { useUiStore } from "../shell/ui-store.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { NativeSettings } from "./NativeSettings.tsx"
import { ProviderDirectory } from "./ProviderDirectory.tsx"
import { SessionManager, type ManageSession } from "../session/SessionManager.tsx"
import { TitleBar } from "../shell/TitleBar.tsx"
import { AgentSettings } from "./AgentSettings.tsx"
import { MemoryPane } from "../memory/MemoryPane.tsx"
import { PluginMarketplace } from "./PluginMarketplace.tsx"

const sections = [
  { id: "general", label: "一般", icon: Settings, group: "基本設定" },
  { id: "appearance", label: "外觀", icon: Palette, group: "基本設定" },
  { id: "notifications", label: "通知", icon: Bell, group: "基本設定" },
  { id: "models", label: "模型與提供商", icon: Server, group: "Agent 設定" },
  { id: "execution", label: "執行與上下文", icon: Shield, group: "Agent 設定", capability: "desktop-agent-settings" },
  { id: "memory", label: "記憶", icon: Brain, group: "Agent 設定", capability: "desktop-memory" },
  { id: "plugins", label: "插件", icon: Puzzle, group: "Agent 設定", capability: "desktop-plugins" },
  { id: "workspace", label: "工作區", icon: Folder, group: "本機資料" },
  { id: "about", label: "關於", icon: Info, group: "本機資料" },
] as const
type Section = typeof sections[number]["id"]
function readSection(): Section {
  try { return sections.find((section) => section.id === localStorage.getItem("ih:settings-section"))?.id ?? "general" }
  catch { return "general" }
}

export function SettingsPane({ workspace, onMemory, onClose, bridge, onManageSession, onRewindComplete, capabilities = {} }: { workspace?: WorkspaceEntry; onMemory?: () => void; onClose(): void; bridge?: DesktopBridge; onManageSession?: ManageSession; onRewindComplete?: (sessionId: string) => void; capabilities?: Record<string, string[]> }) {
  const t = useText()
  const [selectedTab, setTab] = useState<Section>(readSection)
  const [search, setSearch] = useState("")
  const available = sections.filter((section) => !("capability" in section) || (workspace && bridge && capabilities[section.capability]?.includes("1")))
  const current = available.find((section) => section.id === selectedTab) ?? available[0]!
  const tab = current.id
  const visible = available.filter((section) => `${t(section.label)} ${t(section.group)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const select = (section: Section) => {
    setTab(section)
    try { localStorage.setItem("ih:settings-section", section) } catch { /* The in-memory selection still works. */ }
  }
  const locale = useLocale((state) => state.locale)
  const setLocale = useLocale((state) => state.setLocale)
  const preferences = usePreferences()
  const reviewOpen = useUiStore((state) => state.reviewOpen)
  const toggleReview = useUiStore((state) => state.toggleReview)
  return <section className="settings-pane" aria-label={t("設定")}>
    <nav className="settings-navigation" aria-label={t("設定分類")}>
      <button className="row-button settings-back" onClick={onClose} aria-label={t("返回會話")} title={t("返回會話")}><ArrowLeft size={18} aria-hidden="true" /><span>{t("返回會話")}</span></button>
      <h2>{t("設定")}</h2>
      <input className="settings-search" type="search" aria-label={t("搜尋設定")} placeholder={t("搜尋設定")} value={search} onChange={(event) => setSearch(event.target.value)} />
      {(["基本設定", "Agent 設定", "本機資料"] as const).map((group) => <div className="settings-nav-group" key={group}>
        {visible.some((section) => section.group === group) ? <p>{t(group)}</p> : null}
        {visible.filter((section) => section.group === group).map(({ id, label, icon: Icon }) => <button key={id} className="row-button" title={t(label)} aria-label={t(label)} aria-current={id === tab ? "page" : undefined} onClick={() => select(id)}><Icon size={17} aria-hidden="true" /><span>{t(label)}</span></button>)}
      </div>)}
    </nav>
    <main className="settings-main">
    {bridge ? <TitleBar bridge={bridge} title={t("設定")} /> : null}
    <div className="settings-scroll"><div className="settings-content">
      <h1>{t(current.label)}</h1>
      {tab === "general" ? <>
        <SettingsGroup>
          <SettingsRow label={t("語言")} control={<select aria-label={t("語言")} value={locale} onChange={(event) => setLocale(event.target.value === "en" ? "en" : "zh-TW")}><option value="zh-TW">繁體中文</option><option value="en">English</option></select>} />
        </SettingsGroup>
        {bridge ? <NativeSettings bridge={bridge} section="window" /> : null}
      </> : tab === "appearance" ? <>
        <SettingsGroup>
          <SettingsRow label={t("外觀")} control={<select aria-label={t("外觀")} value={preferences.appearance} onChange={(event) => preferences.update({ appearance: event.target.value as Appearance })}><option value="dark">{t("深色")}</option><option value="light">{t("淺色")}</option><option value="system">{t("跟隨系統")}</option></select>} />
          <SettingsRow label={t("文字大小")} control={<select aria-label={t("文字大小")} value={preferences.fontSize} onChange={(event) => preferences.update({ fontSize: Number(event.target.value) })}>{[13, 14, 16, 18].map((size) => <option key={size} value={size}>{size}px</option>)}</select>} />
          <SettingsRow label={t("顯示側欄")} control={<input type="checkbox" aria-label={t("顯示側欄")} checked={!preferences.sidebarCollapsed} onChange={(event) => preferences.update({ sidebarCollapsed: !event.target.checked })} />} />
          <SettingsRow label={t("成果檢查")} control={<input type="checkbox" aria-label={t("成果檢查")} checked={reviewOpen} onChange={toggleReview} />} />
        </SettingsGroup>
        <p className="muted">{t("外觀偏好只儲存在此電腦。")}</p>
        <button className="primary-button" onClick={preferences.reset}>{t("重設外觀偏好")}</button>
      </> : tab === "notifications" ? bridge ? <NativeSettings bridge={bridge} section="notifications" /> : null
      : tab === "models" ? workspace && bridge ? <ProviderDirectory key={workspace.id} bridge={bridge} workspaceId={workspace.id} showHeading={false} /> : <p className="muted">{t("尚未開啟工作區")}</p>
      : tab === "execution" && workspace && bridge ? <AgentSettings key={workspace.id} bridge={bridge} workspaceId={workspace.id} />
      : tab === "memory" && workspace && bridge ? <MemoryPane key={workspace.id} bridge={bridge} workspaceId={workspace.id} embedded />
      : tab === "plugins" && workspace && bridge ? <PluginMarketplace key={workspace.id} bridge={bridge} workspaceId={workspace.id} embedded />
      : tab === "workspace" ? <>
        {workspace && bridge && onManageSession ? <SessionManager key={workspace.id} bridge={bridge} workspaceId={workspace.id} onManage={onManageSession} onRewindComplete={onRewindComplete} /> : null}
        {workspace ? <SettingsGroup><SettingsRow label={workspace.label} description={workspace.path} control={onMemory ? <button className="primary-button" onClick={onMemory}>{t("工作區記憶")}</button> : null} /></SettingsGroup> : <p className="muted">{t("尚未開啟工作區")}</p>}
      </> : <SettingsGroup><SettingsRow label="I-harness Desktop" description={t("本機 Agent 工作台；使用既有後端執行任務。") } control={<span>MIT</span>} /><SettingsRow label={t("第三方 UI 程式碼")} description={t("部分介面改編自 ZCode，依 Apache-2.0 保留授權與來源說明。") } control={<span>Apache-2.0</span>} /></SettingsGroup>}
    </div></div></main>
  </section>
}
