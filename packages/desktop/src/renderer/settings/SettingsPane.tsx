import { useState, useCallback, useEffect } from "react"
import { ArrowLeft } from "lucide-react"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { useLocale, useText } from "../design/i18n.ts"
import { usePreferences, type Appearance } from "../design/preferences.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { ResourceKind } from "@i-harness/desktop-gateway/src/resources.ts"
import { NativeSettings } from "./NativeSettings.tsx"
import { AutoTitleSettings } from "./AutoTitleSettings.tsx"
import { CodeModeSettings } from "./CodeModeSettings.tsx"
import { ContextSubsystemSettings } from "./ContextSubsystemSettings.tsx"
import { GlobalProviderDirectory } from "./GlobalProviderDirectory.tsx"
import { NotificationsPane } from "./NotificationsPane.tsx"
import { ApplicationInformation } from "./ApplicationInformation.tsx"
import { TitleBar } from "../shell/TitleBar.tsx"
import { AgentSettings } from "./AgentSettings.tsx"
import { SubagentSettings } from "./SubagentSettings.tsx"
import { HookSettings } from "./HookSettings.tsx"
import { McpSettings } from "./McpSettings.tsx"
import { ResourceTabs } from "./ResourceTabs.tsx"
import { AgentShellSettings } from "./AgentShellSettings.tsx"
import { MemoryPane } from "../memory/MemoryPane.tsx"
import { PluginMarketplace } from "./PluginMarketplace.tsx"
import { findSettingsDestinations, readSettingsLocation, resourceKindForSearch, settingsAvailability, settingsDestinations, type SettingsSection } from "./settings-navigation.ts"
import { SettingsDraftScope } from "./settings-drafts.tsx"

export interface SettingsPaneProps {
  workspace?: WorkspaceEntry
  sessionId?: string
  onClose(): void
  bridge?: DesktopBridge
  onSandboxChange?(mode: "read-only" | "workspace-write" | "danger-full-access"): void
  capabilities?: Record<string, string[]>
  capabilitiesReady?: boolean
  active?: boolean
  onUseResource?(prefix: string): void
  onOpenConversation?(target: { workspaceId: string; sessionId: string; projectId?: string }): Promise<void>
}

interface RetainedPage { key: string; section: SettingsSection; workspace?: WorkspaceEntry; sessionId?: string; capabilities: Record<string, string[]>; resourceKind: ResourceKind }
const retainedSections = new Set<SettingsSection>(["general", "models", "execution", "subagents", "resources", "hooks", "mcp", "memory", "plugins"])

export function SettingsPane({ workspace, sessionId, onClose, bridge, onSandboxChange, capabilities = {}, capabilitiesReady = Object.keys(capabilities).length > 0, onUseResource, onOpenConversation, active = true }: SettingsPaneProps) {
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
  const [location, setLocation] = useState(readSettingsLocation)
  const [pages, setPages] = useState<RetainedPage[]>([])
  const [search, setSearch] = useState("")
  const [pluginQueryRequest, setPluginQueryRequest] = useState<{ workspaceId: string; value: string; nonce: number }>()
  const [executionBindingRevisions, setExecutionBindingRevisions] = useState<Record<string, number>>({})
  const current = settingsDestinations.find(section => section.id === location.section) ?? settingsDestinations[0]!
  const tab = current.id
  const capabilityContext = { workspaceId: workspace?.id, connected: !!bridge, capabilities, capabilitiesReady }
  const availability = settingsAvailability(current, capabilityContext)
  const reason = availability === "available" ? undefined : t(({ workspace: "請先選擇工作區以使用此設定。", connection: "等待工作區連線。", pending: "正在讀取工作區功能…", unsupported: "目前工作區後端未提供此功能。" } as const)[availability])
  const visible = findSettingsDestinations(search, t)
  const pageKey = JSON.stringify([tab, current.scope === "workspace" ? workspace?.id : "local"])
  // Keep each visited form under stable ancestors; hiding a page must not
  // replace the owner of an unsaved draft or a pending operation.
  if (active && !reason && retainedSections.has(tab)) {
    const page = pages.find(page => page.key === pageKey)
    if (!page) setPages(previous => [...previous, { key: pageKey, section: tab, workspace, sessionId, capabilities, resourceKind: location.resourceKind }])
    else if (tab === "execution" && page.sessionId !== sessionId) setPages(previous => previous.map(page => page.key === pageKey ? { ...page, sessionId } : page))
  }
  useEffect(() => {
    try {
      localStorage.setItem("ih:settings-section", location.section)
      localStorage.setItem("ih:settings-resource-kind", location.resourceKind)
    } catch { /* The in-memory selection still works. */ }
  }, [location])
  const select = (section: SettingsSection) => {
    const resourceKind = section === "resources" ? resourceKindForSearch(search) ?? location.resourceKind : location.resourceKind
    setLocation({ section, resourceKind })
    if (section === "resources") setPages(previous => previous.map(page => page.section === "resources" && page.workspace?.id === workspace?.id ? { ...page, resourceKind } : page))
  }
  const selectResourceKind = (resourceKind: ResourceKind) => {
    setLocation(previous => ({ ...previous, resourceKind }))
    setPages(previous => previous.map(page => page.key === pageKey ? { ...page, resourceKind } : page))
  }
  const locale = useLocale(state => state.locale)
  const setLocale = useLocale(state => state.setLocale)
  const preferences = usePreferences()
  function renderContent(tab: SettingsSection, workspace: WorkspaceEntry | undefined, capabilities: Record<string, string[]>, pageActive: boolean, pageSessionId: string | undefined, resourceKind = location.resourceKind) {
    if (tab === "general") return <>
      <h2>{t("界面")}</h2>
      <SettingsGroup>
        <SettingsRow label={t("界面語言")} description={t("選擇應用界面的顯示語言。")} control={<select aria-label={t("語言")} value={locale} onChange={event => setLocale(event.target.value === "en" ? "en" : "zh-TW")}><option value="zh-TW">繁體中文</option><option value="en">English</option></select>} />
        <SettingsRow label={t("外觀")} control={<select aria-label={t("外觀")} value={preferences.appearance} onChange={event => preferences.update({ appearance: event.target.value as Appearance })}><option value="dark">{t("深色")}</option><option value="light">{t("淺色")}</option><option value="system">{t("跟隨系統")}</option></select>} />
        <SettingsRow label={t("文字大小")} control={<select aria-label={t("文字大小")} value={preferences.fontSize} onChange={event => preferences.update({ fontSize: Number(event.target.value) })}>{[13, 14, 16, 18].map(size => <option key={size} value={size}>{size}px</option>)}</select>} />
      </SettingsGroup>
      <div className="settings-preference-actions"><p className="muted">{t("外觀偏好只儲存在此電腦。")}</p><Button variant="secondary" size="small" onClick={() => preferences.update({ appearance: "dark", fontSize: 14 })}>{t("重設外觀偏好")}</Button></div>
      {bridge ? <><h2>{t("視窗與輸入")}</h2><NativeSettings bridge={bridge} section="window" /><AutoTitleSettings bridge={bridge} /></> : null}
    </>
    if (tab === "notifications" && bridge && pageActive) return <><NativeSettings bridge={bridge} section="notifications" /><NotificationsPane request={notificationRequest} subscribe={notificationSubscribe} onOpenTarget={openNotification} /></>
    if (tab === "models" && bridge) return <GlobalProviderDirectory bridge={bridge} request={globalProviderRequest} showHeading={false} active={pageActive} />
    if (tab === "execution" && workspace && bridge) return <>
      {capabilities["desktop-context-subsystems"]?.includes("1") ? <ContextSubsystemSettings key={`context:${workspace.id}`} bridge={bridge} workspaceId={workspace.id} active={pageActive} /> : null}
      {capabilities["desktop-agent-settings"]?.includes("1") ? <AgentSettings key={workspace.id} bridge={bridge} workspaceId={workspace.id} onSandboxChange={onSandboxChange} onExecutionBindingSaved={() => setExecutionBindingRevisions(previous => ({ ...previous, [workspace.id]: (previous[workspace.id] ?? 0) + 1 }))} /> : null}
      {capabilities["desktop-agent-shell"]?.includes("1") ? <AgentShellSettings key={`shell:${workspace.id}`} bridge={bridge} workspaceId={workspace.id} refreshRevision={executionBindingRevisions[workspace.id] ?? 0} /> : null}
      {capabilities["desktop-code-mode-settings"]?.includes("1") ? <CodeModeSettings key={`code:${workspace.id}:${pageSessionId ?? ""}`} bridge={bridge} workspaceId={workspace.id} sessionId={pageSessionId} /> : null}
    </>
    if (tab === "subagents" && workspace && bridge) return <SubagentSettings key={workspace.id} bridge={bridge} workspaceId={workspace.id} />
    if (tab === "hooks" && workspace && bridge) return <HookSettings key={workspace.id} active={pageActive} bridge={bridge} workspaceId={workspace.id} onAuthoringRequest={capabilities["desktop-hook-authoring"]?.includes("1") ? authoringRequest : undefined} />
    if (tab === "mcp" && workspace && bridge) return <McpSettings key={workspace.id} active={pageActive} bridge={bridge} workspaceId={workspace.id} />
    if (tab === "memory" && workspace && bridge) return <MemoryPane key={workspace.id} active={pageActive} bridge={bridge} workspaceId={workspace.id} embedded onAuthoringRequest={capabilities["desktop-memory-authoring"]?.includes("1") ? authoringRequest : undefined} />
    if (tab === "resources" && workspace && bridge) return <ResourceTabs bridge={bridge} workspaceId={workspace.id} resourceKind={resourceKind} onSelect={selectResourceKind} active={pageActive} onAuthoringRequest={capabilities["desktop-resource-authoring"]?.includes("1") ? authoringRequest : undefined} onUse={onUseResource} onManagePlugins={capabilities["desktop-plugins"]?.includes("1") ? id => { setPluginQueryRequest(previous => ({ workspaceId: workspace.id, value: id ?? "", nonce: (previous?.nonce ?? 0) + 1 })); select("plugins") } : undefined} />
    if (tab === "plugins" && workspace && bridge) return <PluginMarketplace key={workspace.id} queryRequest={pluginQueryRequest?.workspaceId === workspace.id ? pluginQueryRequest : undefined} bridge={bridge} workspaceId={workspace.id} embedded />
    if (tab === "about") return <>{bridge ? <ApplicationInformation bridge={bridge} /> : null}<SettingsGroup><SettingsRow label="I-harness" description={t("本機 Agent 工作台；使用既有後端執行任務。")} control={<span>MIT</span>} /><SettingsRow label="OpenCode · DeepSeek Harness" description={locale === "en" ? "Controls, forms, dialogs and recorded output views are adapted with their source and license notices." : "按鈕、表單、對話框與記錄輸出畫面保留來源及授權說明。"} control={<span>MIT</span>} /><SettingsRow label="ZCode" description={locale === "en" ? "Settings rows, tool summaries, captured diffs and native window controls retain Apache notices." : "設定列、工具摘要、記錄差異與視窗控制保留 Apache 授權說明。"} control={<span>Apache-2.0</span>} /></SettingsGroup></>
    return null
  }

  return <SettingsDraftScope owner={bridge ?? onClose}><section hidden={!active} inert={!active} style={active ? undefined : { display: "none" }} className="settings-pane" aria-label={t("設定")}>
    <nav className="settings-navigation" aria-label={t("設定分類")}>
      <button type="button" className="row-button settings-back" onClick={onClose} aria-label={t("返回會話")} title={t("返回會話")}><ArrowLeft size={18} aria-hidden="true" /><span>{t("返回會話")}</span></button>
      <h2>{t("設定")}</h2>
      <input className="settings-search" type="search" aria-label={t("搜尋設定")} placeholder={t("搜尋設定")} value={search} onChange={event => setSearch(event.target.value)} />
      {visible.length === 0 ? <div className="settings-search-empty"><p role="status" className="muted">{t("沒有符合的設定")}</p><Button variant="ghost" size="small" onClick={() => setSearch("")}>{t("清除搜尋")}</Button></div> : null}
      {(["基本設定", "Agent 設定", "本機資料"] as const).map(group => <div className="settings-nav-group" key={group}>
        {visible.some(section => section.group === group) ? <p>{t(group)}</p> : null}
        {visible.filter(section => section.group === group).map(({ id, label, icon: Icon }) => <button type="button" key={id} className="row-button" title={t(label)} aria-label={t(label)} aria-current={id === tab ? "page" : undefined} onClick={() => select(id)}><Icon size={17} aria-hidden="true" /><span>{t(label)}</span></button>)}
      </div>)}
    </nav>
    <main className="settings-main">
      {bridge ? <TitleBar bridge={bridge} title={t("設定")} /> : null}
      <div className="settings-scroll"><div className="settings-content">
        <h1>{t(current.label)}</h1>
        <p className="settings-description">{t(current.description)}</p>
        {reason ? <p role="status" className="settings-capability-status muted">{reason}</p> : retainedSections.has(tab) ? null : renderContent(tab, workspace, capabilities, active, sessionId)}
        {pages.map(page => {
          const pageActive = active && !reason && page.key === pageKey
          return <div key={page.key} hidden={!pageActive} inert={!pageActive}>{renderContent(page.section, page.workspace, pageActive ? capabilities : page.capabilities, pageActive, page.sessionId, pageActive ? location.resourceKind : page.resourceKind)}</div>
        })}
      </div></div>
    </main>
  </section></SettingsDraftScope>
}
