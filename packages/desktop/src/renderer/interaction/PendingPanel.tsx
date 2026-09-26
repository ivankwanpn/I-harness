import { useState } from "react"
import type { PendingInteraction } from "./pending.ts"

export type InteractionReply = {
  requestId: string
  decision: { kind: "approval"; approved: boolean } | { kind: "question"; answer: string }
}

export interface PendingPanelProps {
  pending: PendingInteraction[]
  onReply(reply: InteractionReply): Promise<void>
}

function approvalText(payload: unknown): string {
  const record = payload !== null && typeof payload === "object" ? payload as { name?: unknown; reason?: unknown } : {}
  const name = typeof record.name === "string" ? record.name : "工具請求"
  const reason = typeof record.reason === "string" ? record.reason : undefined
  return reason === undefined ? name : `${name}：${reason}`
}

function questionShape(payload: unknown): { prompt: string; options: string[] } {
  const record = payload !== null && typeof payload === "object" ? payload as { prompt?: unknown; options?: unknown } : {}
  return {
    prompt: typeof record.prompt === "string" ? record.prompt : "代理提出問題",
    options: Array.isArray(record.options) ? record.options.filter((row): row is string => typeof row === "string") : [],
  }
}

export function PendingPanel({ pending, onReply }: PendingPanelProps) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [answers, setAnswers] = useState<Record<string, string>>({})

  if (pending.length === 0) return null

  async function reply(row: PendingInteraction, decision: InteractionReply["decision"]): Promise<void> {
    setBusy(row.requestId)
    setError(undefined)
    try {
      await onReply({ requestId: row.requestId, decision })
    } catch (reason) {
      // The item stays: an unaccepted reply must never look accepted.
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className="pending-panel" aria-label="待人處理">
      <h3 className="review-title">待人處理</h3>
      {error === undefined ? null : <p className="notice error-text">{error}</p>}
      <ul className="task-list">
        {pending.map((row) => row.kind === "approval"
          ? (
            <li key={row.requestId} className="task-row">
              <span className="row-label">{approvalText(row.payload)}</span>
              <span className="row-meta">
                <button type="button" className="primary-button" disabled={busy === row.requestId}
                  onClick={() => { void reply(row, { kind: "approval", approved: true }) }}>
                  批准
                </button>
                <button type="button" className="primary-button" disabled={busy === row.requestId}
                  onClick={() => { void reply(row, { kind: "approval", approved: false }) }}>
                  拒絕
                </button>
              </span>
            </li>
          )
          : (() => {
              const { prompt, options } = questionShape(row.payload)
              return (
                <li key={row.requestId} className="task-row">
                  <span className="row-label">{prompt}</span>
                  <span className="row-meta">
                    {options.length === 0
                      ? (
                        <>
                          <input
                            aria-label={`回答 ${prompt}`}
                            value={answers[row.requestId] ?? ""}
                            onChange={(event) => {
                              setAnswers((current) => ({ ...current, [row.requestId]: event.target.value }))
                            }}
                          />
                          <button type="button" className="primary-button" disabled={busy === row.requestId}
                            onClick={() => { void reply(row, { kind: "question", answer: answers[row.requestId] ?? "" }) }}>
                            送出回答
                          </button>
                        </>
                      )
                      : options.map((option) => (
                        <button key={option} type="button" className="primary-button" disabled={busy === row.requestId}
                          onClick={() => { void reply(row, { kind: "question", answer: option }) }}>
                          {option}
                        </button>
                      ))}
                  </span>
                </li>
              )
            })())}
      </ul>
    </section>
  )
}
