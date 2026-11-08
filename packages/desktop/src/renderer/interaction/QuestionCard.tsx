import { useState } from "react"
import { Check, MessageCircleQuestion, Pencil } from "lucide-react"
import { useText } from "../design/i18n.ts"
import "./question-card.css"

/** A question the agent asked. Suggestions are shortcuts, never the only
 * answer: the custom row is always available, and it and the numbered choices
 * stay mutually exclusive so what will be sent is never ambiguous. */
export function QuestionCard({ requestId, prompt, options, busy, interrupted, draft, onDraftChange, onAnswer, onDefer }: {
  requestId: string; prompt: string; options: string[]; busy: boolean; interrupted?: boolean
  draft?: { selected: string; answer: string }; onDraftChange?(patch: { selected?: string; answer?: string }): void
  onAnswer(answer: string): void
  onDefer?(): void
}) {
  const t = useText()
  const [localSelected, setLocalSelected] = useState("")
  const [localAnswer, setLocalAnswer] = useState("")
  const selected = draft?.selected ?? localSelected, answer = draft?.answer ?? localAnswer
  const setSelected = (next: string) => onDraftChange ? onDraftChange({ selected: next }) : setLocalSelected(next)
  const setAnswer = (next: string) => onDraftChange ? onDraftChange({ answer: next }) : setLocalAnswer(next)
  const typed = answer.trim()
  const chosen = typed.length > 0 ? answer : options.length > 0 && selected !== "" ? options[Number(selected)] : undefined
  const submit = () => { if (chosen !== undefined && chosen !== "" && !busy) onAnswer(chosen) }
  return <div className="ih-question-card" aria-busy={busy} data-request-id={requestId}>
    <div className="ih-question-head">
      <span className="ih-question-icon" aria-hidden="true"><MessageCircleQuestion size={17} /></span>
      <div className="ih-question-heading">
        <p className="ih-question-eyebrow">{t("代理提出問題")}</p>
        <h2 className="ih-question-title">{prompt}</h2>
      </div>
    </div>
    {interrupted ? <div className="ih-question-banner" role="status">
      <strong>{t("等待期間已中斷")}</strong>
      <span>{t("回答會儲存為待續會話輸入，繼續會話時交給代理。")}</span>
    </div> : null}
    <div className="ih-question-options" role="radiogroup" aria-label={prompt}>
      {options.map((label, index) => <label key={`${label}:${index}`} className="ih-question-option" data-selected={selected === String(index) ? "" : undefined}>
        <input type="radio" name={`question-${requestId}`} value={index} checked={selected === String(index)} disabled={busy}
          onChange={() => { setSelected(String(index)); setAnswer("") }} />
        <span className="ih-question-number" aria-hidden="true">{selected === String(index) ? <Check size={12} /> : index + 1}</span>
        <span className="ih-question-option-label">{label}</span>
      </label>)}
      <label className={`ih-question-custom${selected === "custom" || typed.length > 0 ? " is-active" : ""}`}>
        <input type="radio" name={`question-${requestId}`} value="custom" aria-label={t("其他")} checked={selected === "custom" || typed.length > 0} disabled={busy}
          onChange={() => setSelected("custom")} />
        <span className="ih-question-number" aria-hidden="true"><Pencil size={12} /></span>
        <span className="ih-question-other-label">{t("其他")}</span>
        <textarea className="ih-question-answer" aria-label={`${t("回答")} ${prompt}`} rows={1} value={answer}
          placeholder={t("請輸入回答")} disabled={busy}
          onFocus={() => setSelected("custom")}
          onChange={(event) => { setAnswer(event.target.value); setSelected("custom") }}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit() } }} />
      </label>
    </div>
    <div className="ih-question-footer">
      <p className="ih-question-hint">{t(options.length ? "選擇選項，或自行輸入後送出" : "填寫後按確認送出")}</p>
      <div className="ih-question-actions">
        {onDefer && !interrupted ? <button type="button" className="ih-question-secondary" disabled={busy}
          onClick={onDefer} aria-label={`${t("保留問題，稍後回答")} ${prompt}`}>{t("保留問題，稍後回答")}</button> : null}
        <button type="button" className="ih-question-primary" disabled={busy || chosen === undefined || chosen === ""}
          onClick={submit}>{t(busy ? "正在送出…" : interrupted ? "儲存回答" : "送出回答")}</button>
      </div>
    </div>
  </div>
}
