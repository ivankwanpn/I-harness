import { useState, useCallback } from "react"
import { ArrowLeft, Settings, Palette, Bell, Server, Folder, Info, Brain, Puzzle, Shield } from "lucide-react"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { useLocale, useText } from "../design/i18n.ts"
import { usePreferences, type Appearance } from "../design/preferences.ts"
import { useUiStore } from "../shell/ui-store.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { NativeSettings } from "./NativeSettings.tsx"
import { AutoTitleSettings } from "./AutoTitleSettings.tsx"
import { CodeModeSettings } from "./CodeModeSettings.tsx"
import { ContextSubsystemSettings } from './ContextSubsystemSettings.tsx'
import { DiagnosticsPane } from "./DiagnosticsPane.tsx"
import { GlobalProviderDirectory } from "./GlobalProviderDirectory.tsx"
import { NotificationsPane } from "./NotificationsPane.tsx"
import { ApplicationInformation } from "./ApplicationInformation.tsx"
import { SessionManager, type ManageSession } from "../session/SessionManager.tsx"
import { TitleBar } from "../shell/TitleBar.tsx"
import { AgentSettings } from "./AgentSettings.tsx"
import { SubagentSettings } from "./SubagentSettings.tsx"
import { HookSettings } from "./HookSettings.tsx"
import { McpSettings } from "./McpSettings.tsx"
import { ResourceSettings } from "./ResourceSettings.tsx"
import { AgentShellSettings } from "./AgentShellSettings.tsx"
import { MemoryPane } from "../memory/MemoryPane.tsx"
import { PluginMarketplace } from "./PluginMarketplace.tsx"

const sections = [
  { id: "general", label: "一般", icon: Settings, group: "基本設定" },
  { id: "appearance", label: "外觀", icon: Palette, group: "基本設定" },
  { id: "notifications", label: "通知", icon: Bell, group: "基本設定" },
  { id: "models", label: "模型與提供商", icon: Server, group: "Agent 設定" },
  { id: "execution", label: "執行與上下文", icon: Shield, group: "Agent 設定", capability: "desktop-agent-settings" },
  { id: 'context-subsystems', label: '上下文與檢索', icon: Brain, group: 'Agent 設定', capability: 'desktop-context-subsystems' },
  { id: "subagents", label: "子代理", icon: Brain, group: "Agent 設定", capability: "desktop-subagents" },
  { id: "hooks", label: "Hooks 信任", icon: Shield, group: "Agent 設定", capability: "desktop-hooks" },
  { id: "mcp", label: "MCP 伺服器", icon: Server, group: "Agent 設定", capability: "desktop-mcp" },
  { id: "skills", label: "技能", icon: Brain, group: "Agent 設定", capability: "desktop-resources" },
  { id: "commands", label: "命令", icon: Server, group: "Agent 設定", capability: "desktop-resources" },
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

export function SettingsPane({ workspace, sessionId, sessionManagement, onMemory, onClose, bridge, onManageSession, onRewindComplete, onSandboxChange, capabilities = {}, onUseResource, onOpenConversation }: { workspace?: WorkspaceEntry; sessionId?: string; sessionManagement?: Pick<import("../session/SessionManager.tsx").SessionManagerProps, "onBatch" | "projects" | "currentOwners" | "executionWorkspace">; onMemory?: () => void; onClose(): void; bridge?: DesktopBridge; onManageSession?: ManageSession; onRewindComplete?: (sessionId: string) => void; onSandboxChange?(mode: "read-only" | "workspace-write" | "danger-full-access"): void; capabilities?: Record<string, string[]>; onUseResource?(prefix: string): void; onOpenConversation?(target: { workspaceId: string; sessionId: string; projectId?: string }): Promise<void> }) {
  const t = useText()
  const authoringRequest = useCallback((request: import("../../shared/bridge.ts").DesktopRequest) => {
    if (!bridge) return Promise.reject(new Error("Desktop connection unavailable"))
    return bridge.request(request)
  }, [bridge])
  const globalProviderRequest = useCallback((request: import("../../main/global-provider-settings.ts").GlobalProviderRequest) => authoringRequest(request), [authoringRequest])
  const notificationRequest = useCallback((request: import("../../main/notification-history.ts").NotificationHistoryRequest) => authoringRequest(request) as Promise<import("../../main/notification-history.ts").NotificationHistoryView>, [authoringRequest])
  const notificationSubscribe = useCallback((listener: () => void) => bridge?.onEvent(event => { if (event.kind === "sdk/notification" && (event.method === "desktop/interaction/request" || event.method === "desktop/interaction/closed")) listener() }) ?? (() => {}), [bridge])
  const openNotification = useCallback(async (target: { workspaceId: string; sessionId: string }) => {
    if (!onOpenConversation) throw new Error("Conversation navigation unavailable")
    await onOpenConversation(target)
  }, [onOpenConversation])
  const [selectedTab, setTab] = useState<Section>(readSection)
  const [search, setSearch] = useState("")
  const [pluginQuery, setPluginQuery] = useState("")
  const available = sections
  const unavailableReason = (section: typeof sections[number]) => !("capability" in section) ? undefined : !workspace ? t("請先選擇工作區以使用此設定。") : !bridge ? t("等待工作區連線。") : !capabilities[section.capability]?.includes("1") ? t("目前工作區後端未提供此功能。") : undefined
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
        {visible.filter((section) => section.group === group).map((section) => { const { id, label, icon: Icon } = section; const reason = unavailableReason(section); return <div key={id}><button className="row-button" title={reason ?? t(label)} aria-label={t(label)} aria-disabled={!!reason} aria-current={id === tab ? "page" : undefined} onClick={() => select(id)}><Icon size={17} aria-hidden="true" /><span>{t(label)}</span></button>{reason ? <small className="muted">{reason}</small> : null}</div> })}
      </div>)}
    </nav>
    <main className="settings-main">
    {bridge ? <TitleBar bridge={bridge} title={t("設定")} /> : null}
    <div className="settings-scroll"><div className="settings-content">
      <h1>{t(current.label)}</h1>
      {unavailableReason(current) ? <p role="status" className="muted">{unavailableReason(current)}</p> : tab === "general" ? <>
        <SettingsGroup>
          <SettingsRow label={t("界面語言")} description={t("選擇應用界面的顯示語言。")} control={<select aria-label={t("語言")} value={locale} onChange={(event) => setLocale(event.target.value === "en" ? "en" : "zh-TW")}><option value="zh-TW">繁體中文</option><option value="en">English</option></select>} />
        </SettingsGroup>
        {bridge ? <><NativeSettings bridge={bridge} section="window" /><AutoTitleSettings bridge={bridge} /></> : null}
        {bridge && workspace && capabilities["desktop-agent-shell"]?.includes("1") ? <AgentShellSettings bridge={bridge} workspaceId={workspace.id} /> : null}
      </> : tab === "appearance" ? <>
        <SettingsGroup>
          <SettingsRow label={t("外觀")} control={<select aria-label={t("外觀")} value={preferences.appearance} onChange={(event) => preferences.update({ appearance: event.target.value as Appearance })}><option value="dark">{t("深色")}</option><option value="light">{t("淺色")}</option><option value="system">{t("跟隨系統")}</option></select>} />
          <SettingsRow label={t("文字大小")} control={<select aria-label={t("文字大小")} value={preferences.fontSize} onChange={(event) => preferences.update({ fontSize: Number(event.target.value) })}>{[13, 14, 16, 18].map((size) => <option key={size} value={size}>{size}px</option>)}</select>} />
          <SettingsRow label={t("顯示側欄")} control={<input type="checkbox" aria-label={t("顯示側欄")} checked={!preferences.sidebarCollapsed} onChange={(event) => preferences.update({ sidebarCollapsed: !event.target.checked })} />} />
          <SettingsRow label={t("成果檢查")} control={<input type="checkbox" aria-label={t("成果檢查")} checked={reviewOpen} onChange={toggleReview} />} />
        </SettingsGroup>
        <p className="muted">{t("外觀偏好只儲存在此電腦。")}</p>
        <button className="primary-button" onClick={preferences.reset}>{t("重設外觀偏好")}</button>
      </> : tab === "notifications" ? bridge ? <><NativeSettings bridge={bridge} section="notifications" /><NotificationsPane request={notificationRequest} subscribe={notificationSubscribe} onOpenTarget={openNotification} /></> : null
      : tab === "models" ? bridge ? <GlobalProviderDirectory bridge={bridge} request={globalProviderRequest} showHeading={false} /> : <p className="muted">{t("尚未開啟工作區")}</p>
      : tab === "execution" && workspace && bridge ? <><AgentSettings key={workspace.id} bridge={bridge} workspaceId={workspace.id} onSandboxChange={onSandboxChange} />{capabilities["desktop-code-mode-settings"]?.includes("1") ? <CodeModeSettings key={`code:${workspace.id}:${sessionId ?? ""}`} bridge={bridge} workspaceId={workspace.id} sessionId={sessionId} /> : null}{capabilities["desktop-environment-diagnostics"]?.includes("1") ? <DiagnosticsPane key={`diagnostics:${workspace.id}:${sessionId ?? ""}`} bridge={bridge} workspaceId={workspace.id} sessionId={sessionId} /> : null}</>
      : tab === "subagents" && workspace && bridge ? <SubagentSettings key={workspace.id} bridge={bridge} workspaceId={workspace.id} />
      : tab === 'context-subsystems' && workspace && bridge ? <ContextSubsystemSettings key={workspace.id} bridge={bridge} workspaceId={workspace.id} />
      : tab === "hooks" && workspace && bridge ? <HookSettings key={workspace.id} bridge={bridge} workspaceId={workspace.id} onAuthoringRequest={capabilities["desktop-hook-authoring"]?.includes("1") ? authoringRequest : undefined} />
      : tab === "mcp" && workspace && bridge ? <McpSettings key={workspace.id} bridge={bridge} workspaceId={workspace.id} />
      : (tab === "skills" || tab === "commands") && workspace && bridge ? <ResourceSettings key={`${workspace.id}:${tab}`} resourceKind={tab} bridge={bridge} workspaceId={workspace.id} onAuthoringRequest={capabilities["desktop-resource-authoring"]?.includes("1") ? authoringRequest : undefined} onUse={onUseResource} onManagePlugins={capabilities["desktop-plugins"]?.includes("1") ? (id) => { setPluginQuery(id ?? ""); select("plugins") } : undefined} />
      : tab === "memory" && workspace && bridge ? <MemoryPane key={workspace.id} bridge={bridge} workspaceId={workspace.id} embedded onAuthoringRequest={capabilities["desktop-memory-authoring"]?.includes("1") ? authoringRequest : undefined} />
      : tab === "plugins" && workspace && bridge ? <PluginMarketplace key={`${workspace.id}:${pluginQuery}`} initialQuery={pluginQuery} bridge={bridge} workspaceId={workspace.id} embedded />
      : tab === "workspace" ? <>
        {workspace && bridge && onManageSession ? <SessionManager key={workspace.id} bridge={bridge} workspaceId={workspace.id} onManage={onManageSession} onRewindComplete={onRewindComplete} {...sessionManagement} /> : null}
        {workspace ? <SettingsGroup><SettingsRow label={workspace.label} description={workspace.path} control={onMemory ? <button className="primary-button" onClick={onMemory}>{t("工作區記憶")}</button> : null} /></SettingsGroup> : <p className="muted">{t("尚未開啟工作區")}</p>}
      </> : <>{bridge ? <ApplicationInformation bridge={bridge} /> : null}<SettingsGroup><SettingsRow label="I-harness Desktop" description={t("本機 Agent 工作台；使用既有後端執行任務。") } control={<span>MIT</span>} /><SettingsRow label={t("第三方 UI 程式碼")} description={t("部分介面改編自 ZCode，依 Apache-2.0 保留授權與來源說明。") } control={<span>Apache-2.0</span>} /></SettingsGroup></>}
    </div></div></main>
  </section>
}
