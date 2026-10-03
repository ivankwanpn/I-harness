import { useRef, useState } from "react"
import { ApprovalCard } from "./ApprovalCard.tsx"
import { QuestionCard } from "./QuestionCard.tsx"
import { useText } from "../design/i18n.ts"
import type { PendingInteraction } from "./pending.ts"
import type { ApprovalRememberView } from "@i-harness/desktop-gateway/src/approval-rules.ts"
import type { RememberApprovalOptions } from "@i-harness/desktop-gateway/src/approval-rules.ts"

export type InteractionReply = {
  requestId: string
  decision: { kind: "approval"; approved: boolean; remember?: RememberApprovalOptions } | { kind: "question"; answer: string }
}

export interface PendingPanelProps {
  pending: PendingInteraction[]
  onReply(reply: InteractionReply): Promise<void>
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

export function PendingPanel({ pending, onReply }: PendingPanelProps) {
  const t = useText()
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const inFlight = useRef(new Set<string>())

  if (pending.length === 0) return null

  async function reply(row: PendingInteraction, decision: InteractionReply["decision"]): Promise<void> {
    if (inFlight.current.has(row.requestId)) return
    inFlight.current.add(row.requestId)
    setBusy((current) => ({ ...current, [row.requestId]: true }))
    setErrors((current) => ({ ...current, [row.requestId]: undefined }))
    try {
      await onReply({ requestId: row.requestId, decision })
    } catch (reason) {
      // The item stays: an unaccepted reply must never look accepted.
      setErrors((current) => ({ ...current, [row.requestId]: reason instanceof Error ? reason.message : String(reason) }))
    } finally {
      inFlight.current.delete(row.requestId)
      setBusy((current) => ({ ...current, [row.requestId]: false }))
    }
  }

  return (
    <section className="pending-panel" aria-label={t("待人處理")}>
      <h3 className="review-title">{t("待人處理")} · {pending.length}</h3>
      <ul className="task-list">
        {pending.map((row) => row.kind === "approval"
          ? (
            <li key={row.requestId} className="task-row">
              <ApprovalCard requestId={row.requestId} description={approvalText(row.payload, t("工具請求"))} details={approvalDetails(row.payload)} busy={busy[row.requestId] === true} interrupted={row.state === "interrupted"}
                remember={approvalRemember(row.payload)} onConfirm={(approved, remember) => { void reply(row, { kind: "approval", approved, ...(remember ? { remember } : {}) }) }} />
              {errors[row.requestId] ? <p role="alert" className="notice error-text">{errors[row.requestId]}</p> : null}
            </li>
          )
          : (() => {
              const { prompt, options } = questionShape(row.payload, t("代理提出問題"))
              return (
                <li key={row.requestId} className="task-row">
                  <QuestionCard requestId={row.requestId} prompt={prompt} options={options} busy={busy[row.requestId] === true} interrupted={row.state === "interrupted"} onAnswer={(answer) => { void reply(row, { kind: "question", answer }) }} />
                  {errors[row.requestId] ? <p role="alert" className="notice error-text">{errors[row.requestId]}</p> : null}
                </li>
              )
            })())}
      </ul>
    </section>
  )
}
