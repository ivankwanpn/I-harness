import { useEffect, useState } from "react"
import type { HistoryRange, SessionListEntry } from "@i-harness/sdk"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale } from "../design/i18n.ts"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import type { HistorySelection } from "./SessionSearch.tsx"

export function ConversationBranches({ bridge, workspaceId, sessionId, sessions, onSelect, onHistory, onClose }: {
  bridge: DesktopBridge
  workspaceId: string
  sessionId: string
  sessions: readonly SessionListEntry[]
  onSelect(id: string): void
  onHistory?(target: HistorySelection): void
  onClose(): void
}) {
  const english = useLocale(state => state.locale) === "en"
  const [sourcePoint, setSourcePoint] = useState<number>()
  const byId = new Map(sessions.map(row => [row.id, row]))
  const current = byId.get(sessionId)
  const parent = current?.forkParentId && current.forkParentId !== sessionId ? byId.get(current.forkParentId) : undefined
  const children = sessions.filter(row => row.forkParentId === sessionId && row.id !== sessionId)
  useEffect(() => {
    if (!parent) return
    let active = true
    void bridge.request({ kind: "session/history", workspaceId, sessionId, afterSeq: 0, limit: 1 }).then(value => {
      const seed = (value as HistoryRange).events?.[0]
      if (active && seed?.type === "conversation/seed-manifest" && seed.selection.kind === "completed") {
        setSourcePoint(seed.selection.atSeq)
      }
    }).catch(() => { /* A missing source point leaves the parent available. */ })
    return () => { active = false }
  }, [bridge, workspaceId, sessionId, parent?.id])
  const untitled = english ? "Untitled conversation" : "未命名會話"
  const go = (id: string) => { onClose(); onSelect(id) }
  return <SettingsDialog title={english ? "Conversation branches" : "會話分支"} closeLabel={english ? "Close" : "關閉"}
    initialFocusSelector=".conversation-branches .row-button" className="conversation-branches" onClose={onClose}>
    <p>{english ? "Current conversation" : "目前會話"} · {current?.title ?? untitled}</p>
    {parent ? <section aria-label={english ? "Source conversation" : "來源會話"}>
      <button type="button" className="row-button" onClick={() => go(parent.id)}>{english ? "Source" : "來源"} · {parent.title ?? untitled}</button>
      {sourcePoint !== undefined && onHistory ? <button type="button" className="link-button" onClick={() => {
        onClose()
        onHistory({ workspaceId, sessionId: parent.id, seq: sourcePoint })
      }}>{english ? "Go to branch point" : "前往分叉位置"}</button> : null}
    </section> : current?.forkParentId ? <p className="muted">{english ? "Source conversation is currently unavailable." : "來源會話目前無法讀取。"}</p> : null}
    {children.length ? <ul className="session-list" aria-label={english ? "Child branches" : "子分支"}>
      {children.map(row => <li key={row.id}><button type="button" className="row-button" onClick={() => go(row.id)}>{row.title ?? untitled}</button></li>)}
    </ul> : <p className="muted">{english ? "No visible child branches." : "目前沒有可見的子分支。"}</p>}
  </SettingsDialog>
}
