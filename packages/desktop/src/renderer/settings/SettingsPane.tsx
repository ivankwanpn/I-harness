import { useState, useCallback, useEffect, useRef } from "react"
import { ArrowLeft, FolderOpen, Search, Settings, Folders, Puzzle } from "lucide-react"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { useLocale, useText } from "../design/i18n.ts"
import { usePreferences, type Appearance } from "../design/preferences.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { ProjectSettings, WorkspaceSettings, type ProjectSettingsSelection } from "../projects/ProjectSettings.tsx"
import type { ProjectCatalogProps } from "../projects/ProjectManager.tsx"
import { ProjectExtensions } from "./ProjectExtensions.tsx"
import { ServerSettings } from "./ServerSettings.tsx"
import { NativeSettings } from "./NativeSettings.tsx"
import { AutoTitleSettings } from "./AutoTitleSettings.tsx"
import { CodeModeSettings } from "./CodeModeSettings.tsx"
import { ContextSubsystemSettings } from "./ContextSubsystemSettings.tsx"
import { InstructionSettings } from './InstructionSettings.tsx'
import { GlobalProviderDirectory } from "./GlobalProviderDirectory.tsx"
import { CodingPlans } from "./CodingPlans.tsx"
import { UsageStatistics, type UsageStatisticsRequest } from "./UsageStatistics.tsx"
import { NotificationsPane } from "./NotificationsPane.tsx"
import { ApplicationInformation } from "./ApplicationInformation.tsx"
import { TitleBar } from "../shell/TitleBar.tsx"
import { AgentSettings } from "./AgentSettings.tsx"
import { SubagentSettings } from "./SubagentSettings.tsx"
import { HookSettings } from "./HookSettings.tsx"
import { AgentShellSettings } from "./AgentShellSettings.tsx"
import { MemoryPane } from "../memory/MemoryPane.tsx"
import { ExtensionsSettings } from "./ExtensionsSettings.tsx"
import { findSettingsDestinations, readSettingsLocation, extensionTabForSearch, settingsAvailability, settingsDestinations, type SettingsSection, type SettingsLocation } from "./settings-navigation.ts"
import { SettingsDraftScope } from "./settings-drafts.tsx"
import { RuntimeLog } from "./RuntimeLog.tsx"
import { RetrySettings } from "./RetrySettings.tsx"
import { ModelWaitSettings } from "./ModelWaitSettings.tsx"
import { useUiStore } from "../shell/ui-store.ts"

export interface SettingsPaneProps {
  catalog?: Omit<ProjectCatalogProps, "bridge">
  onOpenProject?(project: ProjectCatalogProps["projects"][number]): void
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

interface RetainedPage { key: string; section: SettingsSection; workspace?: WorkspaceEntry; sessionId?: string; capabilities: Record<string, string[]>; extensionTab: SettingsLocation["extensionTab"] }
const retainedSections = new Set<SettingsSection>(["general", "models", "execution", "subagents", "extensions", "hooks", "memory"])

export function SettingsPane({ catalog, onOpenProject, workspace, sessionId, onClose, bridge, onSandboxChange, capabilities = {}, capabilitiesReady = Object.keys(capabilities).length > 0, onUseResource, onOpenConversation, active = true }: SettingsPaneProps) {
  const t = useText()
  const authoringRequest = useCallback((request: import("../../shared/bridge.ts").DesktopRequest) => {
    if (!bridge) return Promise.reject(new Error("Desktop connection unavailable"))
    return bridge.request(request)
  }, [bridge])
  const globalProviderRequest = useCallback((request: import("../../main/global-provider-settings.ts").GlobalProviderRequest) => authoringRequest(request), [authoringRequest])
  const codingPlansRequest = useCallback((request: import("../../shared/coding-plans.ts").CodingPlansRequest) => authoringRequest(request) as Promise<import("../../shared/coding-plans.ts").CodingPlansState>, [authoringRequest])
  const usageRequest = useCallback((request: UsageStatisticsRequest) => authoringRequest(request), [authoringRequest])
  const notificationRequest = useCallback((request: import("../../main/notification-history.ts").NotificationHistoryRequest) => authoringRequest(request) as Promise<import("../../main/notification-history.ts").NotificationHistoryView>, [authoringRequest])
  const notificationSubscribe = useCallback((listener: () => void) => bridge?.onEvent(event => { if (event.kind === "notifications/changed") listener() }) ?? (() => {}), [bridge])
  const openNotification = useCallback(async (target: { workspaceId: string; sessionId: string }) => {
    if (!onOpenConversation) throw new Error("Conversation navigation unavailable")
    await onOpenConversation(target)
  }, [onOpenConversation])
  const [location, setLocation] = useState(readSettingsLocation)
  const destination = useUiStore(state => state.settingsDestination)
  const [extensionScope, setExtensionScope] = useState<"shared" | "workspace">(() => {
    try { return ["skills", "commands", "resources", "plugins", "mcp"].includes(localStorage.getItem("ih:settings-section") ?? "") ? "workspace" : "shared" }
    catch { return "shared" }
  })
  const [projectSelection, setProjectSelection] = useState<ProjectSettingsSelection>()
  const [pages, setPages] = useState<RetainedPage[]>([])
  const [search, setSearch] = useState("")
  const [lastDestination, setLastDestination] = useState<typeof destination>()
  if (destination && destination !== lastDestination) {
    setLastDestination(destination)
    if (destination.section === "extensions") setExtensionScope("shared")
    setSearch("")
    setProjectSelection(undefined)
    setLocation(previous => ({ section: destination.section, extensionTab: destination.section === "extensions" ? "plugins" : previous.extensionTab }))
  }
  const [executionBindingRevisions, setExecutionBindingRevisions] = useState<Record<string, number>>({})
  const current = settingsDestinations.find(section => section.id === location.section) ?? settingsDestinations[0]!
  const tab = current.id
  const detail = tab === "projects" && projectSelection ? catalog?.projects.find(row => row.id === projectSelection.id) : undefined
  const projectPages = [
    { id: "general", label: "一般", icon: Settings },
    { id: "workspaces", label: "工作區", icon: Folders },
    { id: "extensions", label: "擴充功能", icon: Puzzle },
  ] as const
  const selectedProjectPage = projectPages.find(page => page.id === projectSelection?.page)
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (active && detail) backRef.current?.focus() }, [active, detail?.id])
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (active && scrollRef.current) scrollRef.current.scrollTop = 0 }, [active, tab, workspace?.id, detail?.id, projectSelection?.page])
  const [usageLabels, setUsageLabels] = useState<{ projects: Record<string, string>; workspaces: Record<string, string> }>({ projects: {}, workspaces: {} })
  useEffect(() => {
    if (!active || tab !== "usage" || !bridge) return
    let stale = false
    // Catalog labels are optional decoration; persisted IDs still identify deleted scopes.
    void Promise.allSettled([bridge.request({ kind: "projects/list" }), bridge.request({ kind: "workspace/list" })]).then(([projects, workspaces]) => {
      if (stale) return
      const labels = (value: unknown, key: "name" | "label") => Object.fromEntries((Array.isArray(value) ? value : []).filter(row => row && typeof row.id === "string" && typeof row[key] === "string").map(row => [row.id, row[key]]))
      setUsageLabels({ projects: labels(projects.status === "fulfilled" ? projects.value : undefined, "name"), workspaces: labels(workspaces.status === "fulfilled" ? workspaces.value : undefined, "label") })
    })
    return () => { stale = true }
  }, [active, tab, bridge])
  const capabilityContext = { workspaceId: workspace?.id, connected: !!bridge, capabilities, capabilitiesReady }
  const availability = settingsAvailability(current, capabilityContext)
  const reason = availability === "available" ? undefined : t(({ workspace: "請先選擇工作區以使用此設定。", connection: "等待工作區連線。", pending: "正在讀取工作區功能…", unsupported: "目前工作區後端未提供此功能。" } as const)[availability])
  const visible = findSettingsDestinations(search, t)
  const extensionWorkspace = extensionScope === "workspace" ? workspace : undefined
  const pageWorkspace = tab === "extensions" ? extensionWorkspace : workspace
  const pageKey = JSON.stringify([tab, tab === "extensions" ? extensionWorkspace?.id ?? "shared" : current.scope === "workspace" ? workspace?.id : "local"])
  // Keep each visited form under stable ancestors; hiding a page must not
  // replace the owner of an unsaved draft or a pending operation.
  if (active && !reason && retainedSections.has(tab)) {
    const page = pages.find(page => page.key === pageKey)
    if (!page) setPages(previous => [...previous, { key: pageKey, section: tab, workspace: pageWorkspace, sessionId, capabilities, extensionTab: location.extensionTab }])
    else if (tab === "extensions" && page.extensionTab !== location.extensionTab) setPages(previous => previous.map(row => row.key === pageKey ? { ...row, extensionTab: location.extensionTab } : row))
    else if (tab === "execution" && page.sessionId !== sessionId) setPages(previous => previous.map(page => page.key === pageKey ? { ...page, sessionId } : page))
  }
  useEffect(() => {
    try {
      localStorage.setItem("ih:settings-section", location.section)
      localStorage.setItem("ih:settings-extension-tab", location.extensionTab)
    } catch { /* The in-memory selection still works. */ }
  }, [location])
  const select = (section: SettingsSection) => {
    setLocation(previous => ({ section, extensionTab: section === "extensions" ? extensionTabForSearch(search) ?? previous.extensionTab : previous.extensionTab }))
  }
  const selectExtension = (extensionTab: SettingsLocation["extensionTab"]) => setLocation(previous => ({ ...previous, extensionTab }))
  const locale = useLocale(state => state.locale)
  const setLocale = useLocale(state => state.setLocale)
  const preferences = usePreferences()
  function renderContent(tab: SettingsSection, workspace: WorkspaceEntry | undefined, capabilities: Record<string, string[]>, pageActive: boolean, pageSessionId: string | undefined, extensionTab = location.extensionTab) {
    if (tab === "general") return <>
      <h2>{t("界面")}</h2>
      <SettingsGroup>
        <SettingsRow label={t("界面語言")} description={t("選擇應用界面的顯示語言。")} control={<select aria-label={t("語言")} value={locale} onChange={event => setLocale(event.target.value === "en" ? "en" : "zh-TW")}><option value="zh-TW">繁體中文</option><option value="en">English</option></select>} />
        <SettingsRow label={t("外觀")} control={<select aria-label={t("外觀")} value={preferences.appearance} onChange={event => preferences.update({ appearance: event.target.value as Appearance })}><option value="dark">{t("深色")}</option><option value="light">{t("淺色")}</option><option value="system">{t("跟隨系統")}</option></select>} />
        <SettingsRow label={t("文字大小")} control={<select aria-label={t("文字大小")} value={preferences.fontSize} onChange={event => preferences.update({ fontSize: Number(event.target.value) })}>{[13, 14, 16, 18].map(size => <option key={size} value={size}>{size}px</option>)}</select>} />
      </SettingsGroup>
      <div className="settings-preference-actions"><p className="muted">{t("外觀偏好只儲存在此電腦。")}</p><Button variant="secondary" size="small" onClick={() => preferences.update({ appearance: "dark", fontSize: 14 })}>{t("重設外觀偏好")}</Button></div>
      {bridge ? <><h2>{t("視窗與輸入")}</h2><NativeSettings bridge={bridge} section="window" /><AutoTitleSettings bridge={bridge} /><RetrySettings bridge={bridge} /><ModelWaitSettings bridge={bridge} /></> : null}
    </>
    if (tab === "log" && bridge && pageActive) return <RuntimeLog bridge={bridge} />
    if (tab === "notifications" && bridge && pageActive) return <><NativeSettings bridge={bridge} section="notifications" /><NotificationsPane request={notificationRequest} subscribe={notificationSubscribe} onOpenTarget={openNotification} /></>
    if (tab === "models" && bridge) return <GlobalProviderDirectory bridge={bridge} request={globalProviderRequest} showHeading={false} active={pageActive} />
    if (tab === "coding-plans" && bridge) return <CodingPlans request={codingPlansRequest} active={pageActive} onManageModels={() => select("models")} />
    if (tab === "usage" && bridge) return <UsageStatistics request={usageRequest} active={pageActive} projectLabels={usageLabels.projects} workspaceLabels={usageLabels.workspaces} />
    if (tab === "execution" && workspace && bridge) return <>
      {capabilities['desktop-instructions']?.includes('1') ? <InstructionSettings key={`instructions:${workspace.id}`} bridge={bridge} workspaceId={workspace.id} /> : null}
      {capabilities["desktop-context-subsystems"]?.includes("1") ? <ContextSubsystemSettings key={`context:${workspace.id}`} bridge={bridge} workspaceId={workspace.id} active={pageActive} /> : null}
      {capabilities["desktop-agent-settings"]?.includes("1") ? <AgentSettings key={workspace.id} bridge={bridge} workspaceId={workspace.id} onSandboxChange={onSandboxChange} onExecutionBindingSaved={() => setExecutionBindingRevisions(previous => ({ ...previous, [workspace.id]: (previous[workspace.id] ?? 0) + 1 }))} /> : null}
      {capabilities["desktop-agent-shell"]?.includes("1") ? <AgentShellSettings key={`shell:${workspace.id}`} bridge={bridge} workspaceId={workspace.id} refreshRevision={executionBindingRevisions[workspace.id] ?? 0} /> : null}
      {capabilities["desktop-code-mode-settings"]?.includes("1") ? <CodeModeSettings key={`code:${workspace.id}:${pageSessionId ?? ""}`} bridge={bridge} workspaceId={workspace.id} sessionId={pageSessionId} /> : null}
    </>
    if (tab === "subagents" && workspace && bridge) return <SubagentSettings key={workspace.id} bridge={bridge} workspaceId={workspace.id} />
    if (tab === "hooks" && workspace && bridge) return <HookSettings key={workspace.id} active={pageActive} bridge={bridge} workspaceId={workspace.id} onAuthoringRequest={capabilities["desktop-hook-authoring"]?.includes("1") ? authoringRequest : undefined} />
    if (tab === "extensions" && bridge) return <ExtensionsSettings bridge={bridge} workspaceId={workspace?.id} capabilities={workspace ? capabilities : undefined} active={pageActive} tab={extensionTab} onSelect={selectExtension} onUse={onUseResource} onAuthoringRequest={workspace && capabilities["desktop-resource-authoring"]?.includes("1") ? authoringRequest : undefined} />
    if (tab === "servers" && bridge && pageActive) return <ServerSettings bridge={bridge} workspaces={catalog?.workspaces ?? []} />
    if ((tab === "projects" || tab === "workspaces") && bridge && pageActive) {
      if (!catalog) return <p role="status">{t("正在讀取專案…")}</p>
      return tab === "projects" ? <ProjectSettings {...catalog} navigation={{ selection: projectSelection, onNavigate: setProjectSelection }} bridge={bridge} onOpen={onOpenProject}
        renderExtensions={project => <ProjectExtensions key={project.id} bridge={bridge} project={project} workspaces={catalog.workspaces} activeWorkspaceId={workspace?.id} onUse={onUseResource} />} />
        : <WorkspaceSettings {...catalog} bridge={bridge} />
    }
    if (tab === "memory" && workspace && bridge) return <MemoryPane key={workspace.id} active={pageActive} bridge={bridge} workspaceId={workspace.id} embedded onAuthoringRequest={capabilities["desktop-memory-authoring"]?.includes("1") ? authoringRequest : undefined} />
    if (tab === "about") return <>{bridge ? <ApplicationInformation bridge={bridge} /> : null}<SettingsGroup><SettingsRow label="I-harness" description={t("本機 Agent 工作台；使用既有後端執行任務。")} control={<span>MIT</span>} /><SettingsRow label="OpenCode · DeepSeek Harness" description={locale === "en" ? "Controls, forms, dialogs and recorded output views are adapted with their source and license notices." : "按鈕、表單、對話框與記錄輸出畫面保留來源及授權說明。"} control={<span>MIT</span>} /><SettingsRow label="ZCode" description={locale === "en" ? "Settings rows, tool summaries, captured diffs and native window controls retain Apache notices." : "設定列、工具摘要、記錄差異與視窗控制保留 Apache 授權說明。"} control={<span>Apache-2.0</span>} /></SettingsGroup></>
    return null
  }

  return <SettingsDraftScope owner={bridge ?? onClose}><section hidden={!active} inert={!active} style={active ? undefined : { display: "none" }} className="settings-pane" aria-label={t("設定")}>
    <nav className="settings-navigation" aria-label={t(detail ? "專案設定頁面" : "設定分類")}>
      {detail && projectSelection ? <>
        <button ref={backRef} type="button" className="row-button settings-back" onClick={() => setProjectSelection(undefined)}><ArrowLeft size={18} aria-hidden="true"/><span>{t("返回所有專案")}</span></button>
        <h2>{detail.name}</h2>
        <div className="settings-nav-group">{projectPages.map(({ id, label, icon: Icon }) => <button type="button" key={id} className="row-button"
          aria-current={projectSelection.page === id ? "page" : undefined} onClick={() => setProjectSelection({ id: detail.id, page: id })}>
          <Icon size={17} aria-hidden="true" /><span>{t(label)}</span>
        </button>)}</div>
      </> : <>
      <button type="button" className="row-button settings-back" onClick={onClose} aria-label={t("返回會話")} title={t("返回會話")}><ArrowLeft size={18} aria-hidden="true" /><span>{t("返回會話")}</span></button>
      <h2>{t("設定")}</h2>
      <label className="settings-search-field"><Search size={15} aria-hidden="true" /><input className="ih-control settings-search" type="search" aria-label={t("搜尋設定")} placeholder={t("搜尋設定")} value={search} onChange={event => setSearch(event.target.value)} /></label>
      {visible.length === 0 ? <div className="settings-search-empty"><p role="status" className="muted">{t("沒有符合的設定")}</p><Button variant="ghost" size="small" onClick={() => setSearch("")}>{t("清除搜尋")}</Button></div> : null}
      {(["基本設定", "Agent 設定", "本機資料"] as const).map(group => <div className="settings-nav-group" key={group}>
        {visible.some(section => section.group === group) ? <p>{t(group)}</p> : null}
        {visible.filter(section => section.group === group).map(({ id, label, icon: Icon }) => <button type="button" key={id} className="row-button" title={t(label)} aria-label={t(label)} aria-current={id === tab ? "page" : undefined} onClick={() => select(id)}><Icon size={17} aria-hidden="true" /><span>{t(label)}</span></button>)}
      </div>)}
      </>}
    </nav>
    <main className="settings-main">
      {bridge ? <TitleBar bridge={bridge} title={t("設定")} /> : null}
      <div className="settings-scroll" ref={scrollRef}><div className="settings-content">
        <header className="settings-page-heading">
          <div><h1>{detail?.name ?? t(current.label)}</h1><p className="settings-description">{t(detail && selectedProjectPage ? selectedProjectPage.label : current.description)}</p></div>
          {current.scope === "workspace" && workspace ? <span className="settings-page-context" title={workspace.path}><FolderOpen size={14} aria-hidden="true" /><span>{workspace.label}</span></span> : null}
        </header>
        {tab === "extensions" && workspace ? <label className="settings-scope-select">{t("設定範圍")}
          <select value={extensionScope} onChange={event => setExtensionScope(event.target.value === "workspace" ? "workspace" : "shared")}>
            <option value="shared">{t("所有專案共用")}</option><option value="workspace">{workspace.label} · {workspace.path}</option>
          </select></label> : null}
        {reason ? <p role="status" className="settings-capability-status muted">{reason}</p> : retainedSections.has(tab) ? null : renderContent(tab, workspace, capabilities, active, sessionId)}
        {pages.map(page => {
          const pageActive = active && !reason && page.key === pageKey
          return <div key={page.key} hidden={!pageActive} inert={!pageActive}>{renderContent(page.section, page.workspace, pageActive ? capabilities : page.capabilities, pageActive, page.sessionId, pageActive ? location.extensionTab : page.extensionTab)}</div>
        })}
      </div></div>
    </main>
  </section></SettingsDraftScope>
}
