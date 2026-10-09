import { useText } from "../design/i18n.ts"
import { ToolSummaryRow } from "../vendor/zcode/ToolSummaryRow.tsx"
import { ToolActivity } from "./ToolActivity.tsx"
import type { ActivityGroupRow } from "./activity-groups.ts"
import type { FileNavigation } from "./file-navigation.ts"

export function ActivityGroup({ row, expanded, isOpen, toggle, page, setPage, navigation, onPreview }: { row: ActivityGroupRow; expanded: boolean; isOpen(id: string): boolean; toggle(id: string): void; page: number; setPage(page: number): void; navigation?: FileNavigation; onPreview?(preview: {src:string;name:string}):void }) {
  const t = useText()
  const currentPage = Math.min(page, Math.floor((row.rows.length - 1) / 50))
  const name = t(row.family === "explore" ? "查閱" : row.family === "execute" ? "終端操作" : "檔案變更")
  return <div className="activity-group">
    <ToolSummaryRow name={name} status={t("{count} 項工具", { count: row.rows.length })} label={`${name} ${row.rows.length}`} expanded={expanded} onToggle={() => toggle(row.id)} />
    {expanded ? <div className="activity-group-children">
      {row.rows.slice(currentPage * 50, (currentPage + 1) * 50).map((tool) => <ToolActivity key={tool.id} name={tool.name} args={tool.args} output={tool.output} resultReceived={tool.resultReceived} isError={tool.isError} dispatched={tool.dispatched} cellId={tool.cellId} parentCallId={tool.parentCallId} resultRefs={tool.resultRefs} expanded={isOpen(tool.id)} onToggle={() => toggle(tool.id)} navigation={navigation} onPreview={onPreview} />)}
      {row.rows.length > 50 ? <div className="provider-actions"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("上一頁")}</button><span>{currentPage + 1} / {Math.ceil(row.rows.length / 50)}</span><button disabled={(currentPage + 1) * 50 >= row.rows.length} onClick={() => setPage(currentPage + 1)}>{t("下一頁")}</button></div> : null}
    </div> : null}
  </div>
}
