import { useState } from "react"
import { PermissionCard } from "../vendor/zcode/PermissionCard.tsx"
import { useText } from "../design/i18n.ts"

/** A question the agent asked. Two things the card owes the user, both of which
 * it previously failed at:
 *
 * 1. `options` are SUGGESTIONS. The tool's own schema says so ("the user may still
 *    answer freely"), but the textarea was rendered ONLY when there were no
 *    options — so supplying suggestions silently removed the ability to answer in
 *    your own words. The textarea is now always present, and the two inputs are
 *    mutually exclusive (picking one clears the other) so what will be sent is
 *    never ambiguous.
 * 2. A user who is not ready to choose needs a way past the card that is not
 *    STOP. `onDefer` keeps the question and releases the agent, and the answer
 *    given later is delivered through the interrupted-recovery path. */
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
  const setSelected = (selected: string) => onDraftChange ? onDraftChange({ selected }) : setLocalSelected(selected)
  const setAnswer = (answer: string) => onDraftChange ? onDraftChange({ answer }) : setLocalAnswer(answer)
  // Free-form input wins when present; otherwise the chosen suggestion. The two
  // are kept mutually exclusive below, so this is a total order, not a tie-break.
  const typed = answer.trim()
  const chosen = typed.length > 0 ? answer : options.length > 0 && selected !== "" ? options[Number(selected)] : undefined
  return <div>
    {interrupted ? <><p className="notice">{t("等待期間已中斷")}</p><p className="notice">{t("回答會儲存為待續會話輸入，繼續會話時交給代理。")}</p></> : null}
    <PermissionCard requestId={requestId} title={prompt}
    preview={<textarea className="question-answer" aria-label={`${t("回答")} ${prompt}`} rows={3} value={answer}
      placeholder={options.length ? t("或自行輸入回答") : undefined} disabled={busy}
      onChange={(event) => { setAnswer(event.target.value); if (event.target.value !== "") setSelected("") }} />}
    options={options.map((label, index) => ({ id: String(index), label, description: "" }))}
    selectedId={typed.length > 0 ? "" : selected}
    onSelect={(id) => { setSelected(id); setAnswer("") }} responding={busy}
    confirmDisabled={chosen === undefined || chosen === ""}
    hint={t(options.length ? "選擇選項，或自行輸入後送出" : "填寫後按確認送出")}
    confirmLabel={t(busy ? "正在送出…" : interrupted ? "儲存回答" : "送出回答")}
    onConfirm={() => { if (chosen !== undefined && chosen !== "") onAnswer(chosen) }} />
    {onDefer && !interrupted ? <button type="button" className="link-button" disabled={busy}
      onClick={onDefer} aria-label={`${t("保留問題，稍後回答")} ${prompt}`}>{t("保留問題，稍後回答")}</button> : null}
  </div>
}
