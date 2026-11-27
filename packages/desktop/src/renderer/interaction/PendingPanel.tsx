import { useRef, useState, useSyncExternalStore } from "react"
import { Square } from "lucide-react"
import { ApprovalCard } from "./ApprovalCard.tsx"
import { QuestionCard } from "./QuestionCard.tsx"
import { useLocale, useText } from "../design/i18n.ts"
import { displayError } from "../design/error-display.ts"
import type { PendingInteraction } from "./pending.ts"
import type { ApprovalRememberView } from "@i-harness/desktop-gateway/src/approval-rules.ts"
import type { RememberApprovalOptions } from "@i-harness/desktop-gateway/src/approval-rules.ts"
import { interactionDrafts, interactionDraftKey } from "./interaction-drafts.ts"
import { Button } from "../vendor/opencode/Button.tsx"

export type InteractionReply = {
  requestId: string
  decision: { kind: "approval"; approved: boolean; remember?: RememberApprovalOptions } | { kind: "question"; answer: string } | { kind: "question"; deferred: true }
}

export interface PendingPanelProps {
  draftOwner?: object
  workspaceId?: string
  pending: PendingInteraction[]
  onReply(reply: InteractionReply): Promise<void>
  onStop?(): void | boolean | Promise<void | boolean>
}

function approvalText(payload: unknown, fallback: string): string {
  const record = payload !== null && typeof payload === "object" ? payload as { name?: unknown; reason?: unknown } : {}
  const name = typeof record.name === "string" ? record.name : fallback
  const reason = typeof record.reason === "string" ? record.reason : undefined
  return reason === undefined ? name : `${name}：${reason}`
}

function approvalDetails(payload: unknown): string | undefined {
  const record = payload !== null && typeof payload === "object" ? payload as { command?: unknown; argumentsSummary?: unknown; pathSummary?: unknown } : {}
  if (typeof record.argumentsSummary === "string") return record.argumentsSummary
  if (typeof record.command === "string") return record.command
  return typeof record.pathSummary === "string" ? record.pathSummary : undefined
}

function approvalCommand(payload: unknown): string | undefined {
  const command = (payload as { command?: unknown } | null)?.command
  return typeof command === "string" && command.trim() ? command : undefined
}

function approvalRemember(payload: unknown): ApprovalRememberView | undefined {
  const value = (payload as { remember?: unknown } | null)?.remember
  if (!value || typeof value !== "object" || typeof (value as ApprovalRememberView).available !== "boolean") return undefined
  return value as ApprovalRememberView
}

function questionShape(payload: unknown, fallback: string): { prompt: string; options: string[] } {
  const record = payload !== null && typeof payload === "object" ? payload as { prompt?: unknown; options?: unknown } : {}
  return {
    prompt: typeof record.prompt === "string" ? record.prompt : fallback,
    options: Array.isArray(record.options) ? record.options.filter((row): row is string => typeof row === "string") : [],
  }
}

export function PendingPanel({ draftOwner, workspaceId, pending, onReply, onStop }: PendingPanelProps) {
  const t = useText()
  const english = useLocale(state => state.locale) === "en"
  const fallback = useRef({})
  const stopFlight = useRef(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string>()
  const store = interactionDrafts(draftOwner ?? fallback.current)
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const key = (row: PendingInteraction) => interactionDraftKey(workspaceId, row.sessionId, row.requestId)
  const replyError = (row: PendingInteraction) => {
    const error = store.get(key(row)).error
    return error ? <p role="alert" className="ih-interaction-banner error-text">{displayError(error, { english }).summary}</p> : null
  }

  if (pending.length === 0) return null

  async function reply(row: PendingInteraction, decision: InteractionReply["decision"]): Promise<void> {
    const identity = key(row), submitted = store.get(identity)
    if (submitted.busy) return
    store.update(identity, { busy: true, error: undefined })
    try {
      await onReply({ requestId: row.requestId, decision })
      store.accepted(identity, submitted)
    } catch (reason) {
      // The item stays: an unaccepted reply must never look accepted.
      store.update(identity, { busy: false, error: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  async function stop(): Promise<void> {
    if (!onStop || stopFlight.current) return
    stopFlight.current = true
    setStopping(true)
    setStopError(undefined)
    try { await onStop() }
    catch (reason) { setStopError(reason instanceof Error ? reason.message : String(reason)) }
    finally { stopFlight.current = false; setStopping(false) }
  }

  return (
    <section className="pending-panel" aria-label={t("待人處理")}>
      <header className="ih-pending-heading">
        <h3>{t("待人處理")}{pending.length > 1 ? ` · ${pending.length}` : ""}</h3>
        {onStop ? <Button size="small" variant="danger" className="ih-interaction-stop" icon={<Square size={11} fill="currentColor" />}
          loading={stopping} loadingLabel={t("正在停止…")} onClick={() => { void stop() }}>{t("停止執行")}</Button> : null}
      </header>
      {stopError ? <p role="alert" className="ih-interaction-banner error-text">{displayError(stopError, { english }).summary}</p> : null}
      <ul className="task-list">
        {pending.map((row) => row.kind === "approval"
          ? (
            <li key={row.requestId} className="task-row">
              <ApprovalCard requestId={row.requestId} description={approvalText(row.payload, t("工具請求"))} command={approvalCommand(row.payload)} details={approvalDetails(row.payload)} busy={store.get(key(row)).busy} interrupted={row.state === "interrupted"}
                remember={approvalRemember(row.payload)} onConfirm={(approved, remember) => { void reply(row, { kind: "approval", approved, ...(remember ? { remember } : {}) }) }} />
              {replyError(row)}
            </li>
          )
          : (() => {
              const { prompt, options } = questionShape(row.payload, t("代理提出問題"))
              return (
                <li key={row.requestId} className="task-row">
                  <QuestionCard requestId={row.requestId} prompt={prompt} options={options} draft={store.get(key(row))} onDraftChange={patch => store.update(key(row), patch)} busy={store.get(key(row)).busy} interrupted={row.state === "interrupted"} onAnswer={(answer) => { void reply(row, { kind: "question", answer }) }} onDefer={() => { void reply(row, { kind: "question", deferred: true }) }} />
                  {replyError(row)}
                </li>
              )
            })())}
      </ul>
    </section>
  )
}
