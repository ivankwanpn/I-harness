import { useState } from "react"
import { PermissionCard } from "../vendor/zcode/PermissionCard.tsx"
import { useText } from "../design/i18n.ts"
export function QuestionCard({ requestId, prompt, options, busy, interrupted, draft, onDraftChange, onAnswer }: {
  requestId: string; prompt: string; options: string[]; busy: boolean; interrupted?: boolean; draft?: { selected: string; answer: string }; onDraftChange?(patch: { selected?: string; answer?: string }): void; onAnswer(answer: string): void
}) {
  const t = useText()
  const [localSelected, setLocalSelected] = useState("")
  const [localAnswer, setLocalAnswer] = useState("")
  const selected = draft?.selected ?? localSelected, answer = draft?.answer ?? localAnswer
  const setSelected = (selected: string) => onDraftChange ? onDraftChange({ selected }) : setLocalSelected(selected)
  const setAnswer = (answer: string) => onDraftChange ? onDraftChange({ answer }) : setLocalAnswer(answer)
  const chosen = options.length ? options[Number(selected)] : answer
  return <div>
    {interrupted ? <><p className="notice">{t("等待期間已中斷")}</p><p className="notice">{t("回答會儲存為待續會話輸入，繼續會話時交給代理。")}</p></> : null}
    <PermissionCard requestId={requestId} title={prompt}
    preview={options.length ? undefined : <textarea className="question-answer" aria-label={`${t("回答")} ${prompt}`} rows={3} value={answer} disabled={busy} onChange={(event) => setAnswer(event.target.value)} />}
    options={options.map((label, index) => ({ id: String(index), label, description: "" }))}
    selectedId={selected} onSelect={setSelected} responding={busy}
    confirmDisabled={options.length ? selected === "" || chosen === undefined : !answer.trim()}
    hint={t(options.length ? "選擇後按確認送出" : "填寫後按確認送出")} confirmLabel={t(busy ? "正在送出…" : interrupted ? "儲存回答" : "送出回答")}
    onConfirm={() => { if (chosen !== undefined) onAnswer(chosen) }} />
  </div>
}
