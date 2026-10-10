import { useMemo, useState } from "react"
import { FileDiff, WrapText } from "lucide-react"
import type { TimelineRow } from "../session/project.ts"
import type { FileNavigation } from "../session/file-navigation.ts"
import { RecordedFileLink } from "../session/RecordedFileLink.tsx"
import { recordedUnifiedDiff } from "../session/tool-presentation.ts"
import { LightweightDiffPreview } from "../vendor/zcode/LightweightDiffPreview.tsx"
import { useLocale } from "../design/i18n.ts"
import { buildSessionChanges } from "./session-changes.ts"
import "./session-changes.css"

export function SessionChangesPane({ rows, navigation, historyNotice }: { rows: readonly TimelineRow[]; navigation?: FileNavigation; historyNotice?: string }) {
  const en = useLocale(state => state.locale) === "en"
  const text = (zh: string, english: string) => en ? english : zh
  const model = useMemo(() => buildSessionChanges(rows), [rows])
  const [range, setRange] = useState<"latest" | "loaded">("latest")
  const [selectedId, setSelectedId] = useState<string>()
  const [wrap, setWrap] = useState(false)
  const [page, setPage] = useState(0)
  const entries = range === "latest" && model.latestTurnId ? model.entries.filter(entry => entry.turnId === model.latestTurnId) : model.entries
  const selected = entries.find(entry => entry.id === selectedId) ?? entries.at(-1)
  const pages = Math.max(1, Math.ceil(entries.length / 50)), currentPage = Math.min(page, pages - 1)
  const patch = selected ? recordedUnifiedDiff(selected.diff) : undefined
  return <section className="session-changes-pane" aria-label={text("會話變更", "Conversation changes")}>
    <header className="session-changes-header">
      <div><h3>{text("變更", "Changes")}</h3><p>{text("檢視會話記錄的檔案操作差異。", "Review file-operation diffs recorded in this conversation.")}</p></div>
      <select aria-label={text("變更範圍", "Change scope")} value={range} onChange={event => { setRange(event.target.value as "latest" | "loaded"); setSelectedId(undefined); setPage(0) }}>
        <option value="latest">{model.latestTurnId ? text("最近回合", "Latest turn") : text("已記錄變更", "Recorded changes")}</option>
        <option value="loaded">{text("已載入的會話記錄", "Loaded conversation records")}</option>
      </select>
    </header>
    <p className="session-changes-scope">{text("只顯示已記錄的檔案差異；同一檔案的多次操作分開保留。", "Recorded diffs only; repeated operations retain their own versions.")}</p>
    {historyNotice ? <p role="status" className="notice">{historyNotice}</p> : null}
    {!entries.length ? <div className="session-changes-empty"><FileDiff size={26} aria-hidden="true" /><p>{text("此範圍尚無已記錄的檔案變更", "No recorded file changes in this scope")}</p></div> : <>
      <div className="session-changes-count">{text("檔案", "Files")} {new Set(entries.map(entry => entry.diff.path)).size} · {text("操作", "Operations")} {entries.length}</div>
      <ul className="session-change-files">
        {entries.slice(currentPage * 50, (currentPage + 1) * 50).map((entry, index) => <li key={entry.id}>
          <button type="button" aria-label={text("查看變更 ", "Review change ") + entry.diff.path + " · " + (currentPage * 50 + index + 1)} aria-current={selected?.id === entry.id ? "true" : undefined} onClick={() => setSelectedId(entry.id)}>
            <FileDiff size={15} aria-hidden="true" /><span title={entry.diff.path}>{entry.diff.path}</span>
            <small>#{currentPage * 50 + index + 1}</small><span className="session-change-add">+{entry.diff.added}</span><span className="session-change-remove">−{entry.diff.deleted}</span>
          </button>
        </li>)}
      </ul>
      {pages > 1 ? <nav className="session-change-pagination" aria-label={text("變更列表分頁", "Changes pagination")}><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{text("上一頁", "Previous")}</button><span>{currentPage + 1} / {pages}</span><button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>{text("下一頁", "Next")}</button></nav> : null}
      {selected && patch ? <section className="session-change-detail" data-wrap={wrap} aria-label={text("選取的檔案差異", "Selected file diff")}>
        <header><strong>{selected.diff.path}</strong><RecordedFileLink args={{ path: selected.diff.path }} navigation={navigation} compact />
          <button type="button" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={14} />{text("換行", "Wrap")}</button></header>
        {selected.failed ? <p role="status" className="notice">{text("操作未完全成功；以下為已記錄的檔案差異。", "The operation did not fully succeed; these are its recorded diffs.")}</p> : null}
        {selected.diff.truncated ? <p className="notice">{text("記錄的差異已截斷", "The recorded diff is truncated")}</p> : null}
        <LightweightDiffPreview text={patch} />
      </section> : null}
    </>}
  </section>
}
