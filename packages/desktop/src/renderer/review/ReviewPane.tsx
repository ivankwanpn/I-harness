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

const STATUS_LABELS: Record<ReviewChangeStatus, string> = {
  modified: "已修改",
  added: "已新增",
  deleted: "已刪除",
  untracked: "未追蹤",
  renamed: "已重新命名",
}

const CHANGE_REASONS: Record<string, string> = {
  "not-git-repo": "不是 Git 工作區，無法列出變更",
  "git-missing": "找不到 Git，無法列出變更",
  "no-head": "儲存庫還沒有任何提交，無法比對",
}

const TEXT_REASONS: Record<string, string> = {
  untracked: "未追蹤的檔案沒有 diff",
  binary: "二進位內容不顯示",
  deleted: "檔案已刪除",
  "no-diff": "沒有差異",
  "not-found": "找不到檔案",
  "no-head": "沒有可比較的提交",
  "not-git-repo": "不是 Git 工作區",
  "git-missing": "找不到 Git",
}

function unreachable(reason: string): string {
  return `無法讀取（${reason}）`
}

function TextBlock({ value, label }: { value: ReviewText; label: string }) {
  if (value.kind === "unavailable") {
    return <p className="notice">{TEXT_REASONS[value.reason] ?? unreachable(value.reason)}</p>
  }
  return (
    <div className="review-text">
      <p className="row-meta">
        {label}
        {value.truncated ? `（已截斷，僅顯示前 ${value.bytes} bytes）` : ""}
      </p>
      <pre className="tool-output review-code">{label === "diff"
        ? value.text.split("\n").map((line, index) => <span key={index} className={line.startsWith("@@") ? "diff-hunk" : line.startsWith("+") && !line.startsWith("+++") ? "diff-added" : line.startsWith("-") && !line.startsWith("---") ? "diff-removed" : undefined}>{line}{"\n"}</span>)
        : value.text}</pre>
    </div>
  )
}

/** Read-only result review: only what the host reported, with each
 * unavailable reason shown as itself. */
export function ReviewPane({ changes, error, selected, diff, preview, onSelect, onRefresh }: ReviewPaneProps) {
  return (
    <section className="review-view" aria-label="變更">
      <div className="review-head">
        <h3 className="review-title">變更</h3>
        <button type="button" className="link-button" onClick={onRefresh}>重新整理</button>
      </div>
      {error === undefined ? null : <p className="notice error-text">{error}</p>}
      {changes === undefined ? (
        <p className="muted">正在讀取變更…</p>
      ) : changes.kind === "unavailable" ? (
        <p className="notice">{CHANGE_REASONS[changes.reason] ?? unreachable(changes.reason)}</p>
      ) : changes.files.length === 0 ? (
        <p className="muted">工作區目前沒有未提交的變更</p>
      ) : (
        <>
          {changes.truncated ? <p className="notice">變更列表已截斷，只顯示前 {changes.files.length} 筆</p> : null}
          <ul className="task-list">
            {changes.files.map((row) => (
              <li key={row.path} className="task-row">
                <button
                  type="button"
                  className="row-button"
                  disabled={!row.canDiff && !row.canPreview}
                  onClick={() => onSelect(row.path, row.canDiff ? "diff" : "preview")}
                >
                  <span className="row-label">{row.path}</span>
                  <span className="row-meta">{STATUS_LABELS[row.status]}</span>
                </button>
                {row.canPreview && row.canDiff ? (
                  <button type="button" className="link-button" onClick={() => onSelect(row.path, "preview")}>預覽</button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {selected === undefined ? null : (
        <div className="review-detail">
          <p className="row-label">{selected.path}（{selected.mode === "diff" ? "diff" : "預覽"}）</p>
          {selected.mode === "diff"
            ? diff === undefined ? <p className="muted">正在讀取…</p> : <TextBlock value={diff} label="diff" />
            : preview === undefined ? <p className="muted">正在讀取…</p> : <TextBlock value={preview} label="預覽" />}
        </div>
      )}
    </section>
  )
}
