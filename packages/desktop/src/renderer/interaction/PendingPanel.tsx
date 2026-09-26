import { useRef, useState } from "react"
import { ApprovalCard } from "./ApprovalCard.tsx"
import { useText } from "../design/i18n.ts"
import type { PendingInteraction } from "./pending.ts"

export type InteractionReply = {
  requestId: string
  decision: { kind: "approval"; approved: boolean } | { kind: "question"; answer: string }
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
  const [answers, setAnswers] = useState<Record<string, string>>({})
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
              <ApprovalCard requestId={row.requestId} description={approvalText(row.payload, t("工具請求"))} busy={busy[row.requestId] === true}
                onConfirm={(approved) => { void reply(row, { kind: "approval", approved }) }} />
              {errors[row.requestId] ? <p role="alert" className="notice error-text">{errors[row.requestId]}</p> : null}
            </li>
          )
          : (() => {
              const { prompt, options } = questionShape(row.payload, t("代理提出問題"))
              return (
                <li key={row.requestId} className="task-row">
                  <span className="row-label">{prompt}</span>
                  <span className="row-meta">
                    {options.length === 0
                      ? (
                        <>
                          <input
                            aria-label={`${t("回答")} ${prompt}`}
                            value={answers[row.requestId] ?? ""}
                            onChange={(event) => {
                              setAnswers((current) => ({ ...current, [row.requestId]: event.target.value }))
                            }}
                          />
                          <button type="button" className="primary-button" disabled={busy[row.requestId] === true || !(answers[row.requestId] ?? "").trim()}
                            onClick={() => { void reply(row, { kind: "question", answer: answers[row.requestId] ?? "" }) }}>
                            {t("送出回答")}
                          </button>
                        </>
                      )
                      : options.map((option) => (
                        <button key={option} type="button" className="primary-button" disabled={busy[row.requestId] === true}
                          onClick={() => { void reply(row, { kind: "question", answer: option }) }}>
                          {option}
                        </button>
                      ))}
                  </span>
                  {errors[row.requestId] ? <p role="alert" className="notice error-text">{errors[row.requestId]}</p> : null}
                </li>
              )
            })())}
      </ul>
    </section>
  )
}
