import { useEffect, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
interface Command { name: string; description?: string; argumentHints?: string }
export function SlashCommands({ bridge, workspaceId, text, onSelect }: { bridge: DesktopBridge; workspaceId: string; text: string; onSelect(name: string): void }) {
  const t = useText()
  const prefix = /^\/([a-z0-9_-]*)$/.exec(text)?.[1]
  const active = prefix !== undefined
  const [commands, setCommands] = useState<Command[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!active) return
    let mounted = true; let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const result = await bridge.request({ kind: "desktop/plugins/commands", workspaceId }) as Command[]
        if (mounted) { setCommands(result); setError(undefined) }
      } catch (reason) { if (mounted) setError(String(reason)) }
      if (mounted) timer = setTimeout(() => { void refresh() }, 500)
    }
    void refresh()
    return () => { mounted = false; clearTimeout(timer) }
  }, [bridge, workspaceId, active])
  if (!active) return null
  const matches = commands.filter((command) => command.name.startsWith(prefix))
  return <div className="slash-commands" aria-label={t("可用命令")}>
    {error ? <p role="alert">{error}</p> : matches.length === 0 ? <p className="muted">{t("沒有符合的已啟用命令")}</p> : matches.slice(0, 20).map((command) => <button type="button" key={command.name} onClick={() => onSelect(command.name)}><strong>/{command.name}</strong><span>{command.description}</span><small>{command.argumentHints}</small></button>)}
  </div>
}
