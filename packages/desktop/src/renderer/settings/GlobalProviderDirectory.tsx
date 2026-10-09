import { useMemo } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { GlobalProviderRequest } from "../../main/global-provider-settings.ts"
import { ProviderDirectory } from "./ProviderDirectory.tsx"
import { SettingsDraftScope } from "./settings-drafts.tsx"

const scope = "__ih_global_settings__"

/** Reuses the full provider UI with a narrow global provider transport. */
export function GlobalProviderDirectory({ bridge, request, showHeading = true, active = true }: {
  bridge: DesktopBridge
  request(input: GlobalProviderRequest): Promise<unknown>
  showHeading?: boolean
  active?: boolean
}) {
  const globalBridge = useMemo<DesktopBridge>(() => ({
    ...bridge,
    async request(input) {
      switch (input.kind) {
        case "desktop/provider/directory": return request({ kind: "desktop/global-provider/directory" })
        case "desktop/provider/mutate": return request({ kind: "desktop/global-provider/mutate", command: input.command })
        case "desktop/provider/probe": return request({ kind: "desktop/global-provider/probe", id: input.id, token: input.token })
        case "desktop/provider/probe/cancel": return request({ kind: "desktop/global-provider/probe/cancel", token: input.token })
        default: throw new Error("Unsupported global provider operation")
      }
    },
  }), [bridge, request])
  return <SettingsDraftScope owner={bridge}><ProviderDirectory bridge={globalBridge} workspaceId={scope} showHeading={showHeading} active={active} /></SettingsDraftScope>
}
