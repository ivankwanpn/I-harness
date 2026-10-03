import { forwardRef, useEffect, useImperativeHandle, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
interface Command { name: string; description?: string; argumentHints?: string }
import type { PickerKeyboard } from "./ContextPicker.tsx"
export const SlashCommands = forwardRef<PickerKeyboard, { bridge: DesktopBridge; workspaceId: string; text: string; showCompact?: boolean; onSelect(name: string): void; workflows?: boolean }>(function SlashCommands({ bridge, workspaceId, text, showCompact = false, onSelect, workflows = false }, ref) {
  const t = useText()
  const prefix = /^\/([a-z0-9_-]*)$/.exec(text)?.[1]
  const [dismissed, setDismissed] = useState<string>()
  const active = prefix !== undefined && text !== dismissed
  const [index, setIndex] = useState(0)
  useEffect(() => { setIndex(0); if (prefix === undefined) setDismissed(undefined) }, [text, prefix])
  const [commands, setCommands] = useState<Command[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!active) return
    let mounted = true; let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const result = await bridge.request({ kind: "desktop/plugins/commands", workspaceId }) as Command[]
        if (mounted) { setCommands(Array.isArray(result) ? result.slice(0, 100) : []); setError(undefined) }
      } catch (reason) { if (mounted) setError(String(reason)) }
      if (mounted) timer = setTimeout(() => { void refresh() }, 500)
    }
    void refresh()
    return () => { mounted = false; clearTimeout(timer) }
  }, [bridge, workspaceId, active])
  const builtins: Command[] = [...(showCompact ? [{ name: "compact", description: t("壓縮目前會話上下文") }] : []), ...(workflows ? [{ name: "goal", description: "Goal / Plan" }, { name: "team", description: "Team" }, { name: "jobs", description: t("背景工作") }, { name: "reviews", description: t("代審") }, { name: "settings", description: t("設定") }] : [])]
  const matches = [...builtins, ...commands.filter((command) => !builtins.some((item) => item.name === command.name) && command.name !== "compact")].filter((command) => command.name.startsWith(prefix ?? "")).slice(0, 20)
  useImperativeHandle(ref, () => ({ key(key) {
    if (!active) return false
    if (key === "Escape") { setDismissed(text); return true }
    if (key === "ArrowDown" || key === "ArrowUp") { setIndex((old) => matches.length ? (old + (key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0); return true }
    if (key === "Enter" || key === "Tab") { const match = matches[Math.min(index, matches.length - 1)]; if (match) onSelect(match.name); return true }
    return false
  } }))
  if (!active) return null
  return <div className="slash-commands" aria-label={t("可用命令")}>
    {error ? <p role="alert">{error}</p> : matches.length === 0 ? <p className="muted">{t("沒有符合的已啟用命令")}</p> : <div role="listbox" aria-label={t("可用命令")}>{matches.map((command, i) => <button type="button" role="option" aria-selected={i === index} key={command.name} onClick={() => onSelect(command.name)}><strong>/{command.name}</strong><span>{command.description}</span><small>{command.argumentHints}</small></button>)}</div>}
  </div>
})
