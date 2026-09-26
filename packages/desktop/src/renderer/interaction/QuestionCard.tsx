import { useState } from "react"
import { PermissionCard } from "../vendor/zcode/PermissionCard.tsx"
import { useText } from "../design/i18n.ts"
export function QuestionCard({ requestId, prompt, options, busy, onAnswer }: {
  requestId: string; prompt: string; options: string[]; busy: boolean; onAnswer(answer: string): void
}) {
  const t = useText()
  const [selected, setSelected] = useState("")
  const [answer, setAnswer] = useState("")
  const chosen = options.length ? options[Number(selected)] : answer
  return <PermissionCard requestId={requestId} title={prompt}
    preview={options.length ? undefined : <textarea className="question-answer" aria-label={`${t("回答")} ${prompt}`} rows={3} value={answer} disabled={busy} onChange={(event) => setAnswer(event.target.value)} />}
    options={options.map((label, index) => ({ id: String(index), label, description: "" }))}
    selectedId={selected} onSelect={setSelected} responding={busy}
    confirmDisabled={options.length ? selected === "" || chosen === undefined : !answer.trim()}
    hint={t("選擇後按確認送出")} confirmLabel={t(busy ? "正在送出…" : "送出回答")}
    onConfirm={() => { if (chosen !== undefined) onAnswer(chosen) }} />
}
