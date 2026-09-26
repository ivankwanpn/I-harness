import { LightweightDiffPreview } from "../vendor/zcode/LightweightDiffPreview.tsx"
import { ReviewFileRow } from "../vendor/zcode/ReviewFileRow.tsx"
import { useText, type Message } from "../design/i18n.ts"

export type ReviewChangeStatus = "modified" | "added" | "deleted" | "untracked" | "renamed"

export interface ReviewChangeRow {
  path: string
  status: ReviewChangeStatus
  canDiff: boolean
  canPreview: boolean
}

export type ReviewChanges =
  | { kind: "ok"; files: ReviewChangeRow[]; truncated: boolean }
  | { kind: "unavailable"; reason: string }

export type ReviewText =
  | { kind: "text"; text: string; truncated: boolean; bytes: number }
  | { kind: "unavailable"; reason: string }

export interface ReviewPaneProps {
  changes?: ReviewChanges
  error?: string
  selected?: { path: string; mode: "diff" | "preview" }
  diff?: ReviewText
  preview?: ReviewText
  onSelect(path: string, mode: "diff" | "preview"): void
  onRefresh(): void
}

const STATUS_LABELS: Record<ReviewChangeStatus, Message> = {
  modified: "已修改",
  added: "已新增",
  deleted: "已刪除",
  untracked: "未追蹤",
  renamed: "已重新命名",
}

const CHANGE_REASONS: Record<string, Message> = {
  "not-git-repo": "不是 Git 工作區，無法列出變更",
  "git-missing": "找不到 Git，無法列出變更",
  "no-head": "儲存庫還沒有任何提交，無法比對",
}

const TEXT_REASONS: Record<string, Message> = {
  untracked: "未追蹤的檔案沒有 diff",
  binary: "二進位內容不顯示",
  deleted: "檔案已刪除",
  "no-diff": "沒有差異",
  "not-found": "找不到檔案",
  "no-head": "沒有可比較的提交",
  "not-git-repo": "不是 Git 工作區",
  "git-missing": "找不到 Git",
}

function TextBlock({ value, label }: { value: ReviewText; label: string }) {
  const t = useText()
  if (value.kind === "unavailable") {
    return <p className="notice">{TEXT_REASONS[value.reason] ? t(TEXT_REASONS[value.reason]!) : `${t("無法讀取")} (${value.reason})`}</p>
  }
  return (
    <div className="review-text">
      <p className="row-meta">
        {label}
        {value.truncated ? t("（已截斷，僅顯示前 {bytes} bytes）", { bytes: value.bytes }) : ""}
      </p>
      {label === "diff" ? <LightweightDiffPreview text={value.text} /> : <pre className="tool-output review-code">{value.text}</pre>}
    </div>
  )
}

/** Read-only result review: only what the host reported, with each
 * unavailable reason shown as itself. */
export function ReviewPane({ changes, error, selected, diff, preview, onSelect, onRefresh }: ReviewPaneProps) {
  const t = useText()
  return (
    <section className="review-view" aria-label={t("變更")}>
      <div className="review-head">
        <h3 className="review-title">{t("變更")}</h3>
        <button type="button" className="link-button" onClick={onRefresh}>{t("重新整理")}</button>
      </div>
      {error === undefined ? null : <p className="notice error-text">{error}</p>}
      {changes === undefined ? (
        <p className="muted">{t("正在讀取變更…")}</p>
      ) : changes.kind === "unavailable" ? (
        <p className="notice">{CHANGE_REASONS[changes.reason] ? t(CHANGE_REASONS[changes.reason]!) : `${t("無法讀取")} (${changes.reason})`}</p>
      ) : changes.files.length === 0 ? (
        <p className="muted">{t("工作區目前沒有未提交的變更")}</p>
      ) : (
        <>
          {changes.truncated ? <p className="notice">{t("變更列表已截斷，只顯示前 {count} 筆", { count: changes.files.length })}</p> : null}
          <ul className="task-list">
            {changes.files.map((row) => (
              <li key={row.path} className="task-row">
                <ReviewFileRow path={row.path} status={t(STATUS_LABELS[row.status])}
                  selected={selected?.path === row.path} disabled={!row.canDiff && !row.canPreview}
                  onSelect={() => onSelect(row.path, row.canDiff ? "diff" : "preview")} />
                {row.canPreview && row.canDiff ? (
                  <button type="button" className="link-button" onClick={() => onSelect(row.path, "preview")}>{t("預覽")}</button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {selected === undefined ? null : (
        <div className="review-detail">
          <p className="row-label">{selected.path}（{selected.mode === "diff" ? "diff" : t("預覽")}）</p>
          {selected.mode === "diff"
            ? diff === undefined ? <p className="muted">{t("正在讀取…")}</p> : <TextBlock value={diff} label="diff" />
            : preview === undefined ? <p className="muted">{t("正在讀取…")}</p> : <TextBlock value={preview} label={t("預覽")} />}
        </div>
      )}
    </section>
  )
}
