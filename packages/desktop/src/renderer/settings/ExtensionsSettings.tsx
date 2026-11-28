import { useEffect, useId, useRef, useState } from "react"
import { DESKTOP_CONFIGURATION_ID } from "@i-harness/desktop-gateway/src/host-protocol.ts"
import type { ResourceAuthoringRequestHandler } from "@i-harness/desktop-gateway/src/resources.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { McpSettings } from "./McpSettings.tsx"
import { PluginMarketplace } from "./PluginMarketplace.tsx"
import { ResourceSettings } from "./ResourceSettings.tsx"
import { useAuthoringText } from "./resource-authoring-text.ts"

const tabs = ["mcp", "plugins", "skills", "commands"] as const
export type ExtensionTab = (typeof tabs)[number]
const label = { mcp: "MCP 伺服器", plugins: "插件", skills: "技能", commands: "命令" } as const
const capability = { mcp: "desktop-mcp", plugins: "desktop-plugins", skills: "desktop-resources", commands: "desktop-resources" } as const
interface ExtensionsSettingsProps {
  bridge: DesktopBridge
  tab: ExtensionTab
  onSelect(tab: ExtensionTab): void
  workspaceId?: string
  capabilities?: Record<string, string[]>
  active?: boolean
  onUse?(prefix: string): void
  onAuthoringRequest?: ResourceAuthoringRequestHandler
  pluginQueryRequest?: { value: string; nonce: number }
}

export function ExtensionsSettings(props: ExtensionsSettingsProps) {
  return <ExtensionPanels key={props.workspaceId ?? DESKTOP_CONFIGURATION_ID} {...props} />
}

function ExtensionPanels({ bridge, tab, onSelect, workspaceId, capabilities, active = true, onUse, onAuthoringRequest, pluginQueryRequest }: ExtensionsSettingsProps) {
  const t = useAuthoringText()
  const id = useId()
  const scope = workspaceId ?? DESKTOP_CONFIGURATION_ID
  const [visited, setVisited] = useState<ReadonlySet<ExtensionTab>>(() => new Set([tab]))
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [pluginSearch, setPluginSearch] = useState<{ value: string; nonce: number }>()
  const supports = (kind: ExtensionTab) => !workspaceId || !capabilities || capabilities[capability[kind]]?.includes("1") === true
  useEffect(() => { setVisited(previous => previous.has(tab) ? previous : new Set([...previous, tab])) }, [tab])
  useEffect(() => { if (pluginQueryRequest) setPluginSearch(pluginQueryRequest) }, [pluginQueryRequest])
  function managePlugins(pluginId = "") {
    setPluginSearch(previous => ({ value: pluginId, nonce: (previous?.nonce ?? 0) + 1 }))
    onSelect("plugins")
  }
  return <div className="settings-resource-tabs extensions-settings">
    <div role="tablist" aria-label={t("擴充功能分類")} className="zc-pane-tabs ih-segments">
      {tabs.map((kind, index) => <button type="button" key={kind} role="tab" className="zc-pane-tab" id={`${id}-${kind}-tab`}
        ref={element => { buttons.current[index] = element }} aria-controls={`${id}-${kind}-panel`} aria-selected={kind === tab} tabIndex={kind === tab ? 0 : -1}
        onClick={() => onSelect(kind)} onKeyDown={event => {
          let next: number
          switch (event.key) {
            case "ArrowRight": next = (index + 1) % tabs.length; break
            case "ArrowLeft": next = (index + tabs.length - 1) % tabs.length; break
            case "Home": next = 0; break
            case "End": next = tabs.length - 1; break
            default: return
          }
          event.preventDefault(); onSelect(tabs[next]!); buttons.current[next]?.focus()
        }}>{t(label[kind])}</button>)}
    </div>
    {tabs.map(kind => {
      if (kind !== tab && !visited.has(kind)) return null
      const shown = active && tab === kind
      return <div key={kind} role="tabpanel" id={`${id}-${kind}-panel`} aria-labelledby={`${id}-${kind}-tab`} hidden={!shown} inert={!shown} tabIndex={0}>
        {!supports(kind) ? <p className="ih-empty-state">{t("此工作區的 Gateway 不支援{feature}。", { feature: t(label[kind]) })}</p>
          : kind === "mcp" ? <McpSettings bridge={bridge} workspaceId={scope} active={shown} />
          : kind === "plugins" ? <PluginMarketplace bridge={bridge} workspaceId={scope} queryRequest={pluginSearch} active={shown} initialInstalledOnly={!!workspaceId} embedded />
          : <>
            <p className="settings-description">{t(workspaceId ? "顯示此資料夾可用的資源及其來源。" : "列出本機共用設定與插件提供的資源。工作區可以提供同名版本。")}</p>
            <ResourceSettings bridge={bridge} workspaceId={scope} resourceKind={kind} active={shown} onUse={workspaceId ? onUse : undefined}
              onManagePlugins={supports("plugins") ? managePlugins : undefined} onAuthoringRequest={onAuthoringRequest ?? (workspaceId ? undefined : request => bridge.request(request))} />
          </>}
      </div>
    })}
  </div>
}
