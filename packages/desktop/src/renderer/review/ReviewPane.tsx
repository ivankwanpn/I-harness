import { LightweightDiffPreview } from "../vendor/zcode/LightweightDiffPreview.tsx"
import { ReviewFileRow } from "../vendor/zcode/ReviewFileRow.tsx"
import { useText, type Message } from "../design/i18n.ts"
import { useState } from "react"
import { SourceFileEditor, type ReviewSaveResult } from "./SourceFileEditor.tsx"
import "./review-editor.css"

export type ReviewChangeStatus = "modified" | "added" | "deleted" | "untracked" | "renamed"

export interface ReviewChangeRow {
  path: string
  status: ReviewChangeStatus
  canDiff: boolean
  canPreview: boolean
  staged?: boolean
  unstaged?: boolean
}

export type ReviewChanges =
  | { kind: "ok"; files: ReviewChangeRow[]; truncated: boolean }
  | { kind: "unavailable"; reason: string }

export type ReviewText =
  | { kind: "text"; text: string; truncated: boolean; bytes: number; revision?: string }
  | { kind: "unavailable"; reason: string }

export interface ReviewPaneProps {
  changes?: ReviewChanges
  error?: string
  selected?: { path: string; mode: "diff" | "preview" }
  diff?: ReviewText
  preview?: ReviewText
  onSelect(path: string, mode: "diff" | "preview"): void
  onRefresh(): void
  onSaveFile?(path: string, text: string, expectedRevision: string): Promise<ReviewSaveResult>
  onStage?(path: string): Promise<ReviewGitResult>
  onUnstage?(path: string): Promise<ReviewGitResult>
  onCommit?(message: string): Promise<ReviewCommitResult>
}

export type ReviewGitResult = { kind: "ok" } | { kind: "unavailable"; reason: string }
export type ReviewCommitResult = { kind: "committed"; commit: string } | { kind: "unavailable"; reason: string }

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

/** Workspace review with explicit human source edits and local Git actions. */
export function ReviewPane({ changes, error, selected, diff, preview, onSelect, onRefresh, onSaveFile, onStage, onUnstage, onCommit }: ReviewPaneProps) {
  const t = useText()
  const [sourcePath, setSourcePath] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState<string>()
  const [committed, setCommitted] = useState<string>()
  const stagedCount = changes?.kind === "ok" ? changes.files.filter((row) => row.staged).length : 0

  async function mutate(operation: () => Promise<ReviewGitResult | ReviewCommitResult>) {
    if (busy) return
    setBusy(true)
    setMutationError(undefined)
    setCommitted(undefined)
    try {
      const result = await operation()
      if (result.kind === "unavailable") {
        setMutationError(result.reason === "outside-workspace" ? t("索引包含工作區外的變更，請先在該儲存庫處理。")
          : result.reason === "no-changes" ? t("沒有已暫存的變更")
          : result.reason === "not-found" ? t("找不到檔案")
          : t("Git 操作失敗，請檢查本機 Git 設定後重試。"))
      } else {
        if (result.kind === "committed") { setMessage(""); setCommitted(result.commit) }
        onRefresh()
      }
    } catch (reason) { setMutationError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return (
    <section className="review-view" aria-label={t("變更")}>
      <div className="review-head">
        <h3 className="review-title">{t("變更")}</h3>
        <button type="button" className="link-button" onClick={onRefresh}>{t("重新整理")}</button>
      </div>
      {error === undefined ? null : <p className="notice error-text">{error}</p>}
      {mutationError === undefined ? null : <p role="alert" className="notice error-text">{mutationError}</p>}
      {committed === undefined ? null : <p role="status" className="row-meta">{t("已建立本機提交 {commit}", { commit: committed.slice(0, 8) })}</p>}
      {onSaveFile ? <form className="review-source-open" onSubmit={(event) => { event.preventDefault(); if (sourcePath.trim()) onSelect(sourcePath.trim(), "preview") }}>
        <input aria-label={t("來源檔案路徑")} placeholder="src/file.ts" value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} />
        <button type="submit" className="link-button" disabled={!sourcePath.trim()}>{t("開啟檔案")}</button>
      </form> : null}
      {changes === undefined ? (
        <p className="muted">{t("正在讀取變更…")}</p>
      ) : changes.kind === "unavailable" ? (
        <p className="notice">{CHANGE_REASONS[changes.reason] ? t(CHANGE_REASONS[changes.reason]!) : `${t("無法讀取")} (${changes.reason})`}</p>
      ) : changes.files.length === 0 ? (
        <p className="muted">{t("工作區目前沒有未提交的變更")}</p>
      ) : (
        <>
          {changes.truncated ? <p className="notice">{t("變更列表已截斷，只顯示前 {count} 筆", { count: changes.files.length })}</p> : null}
          <ul className="task-list review-files">
            {changes.files.map((row) => (
              <li key={row.path} className="task-row">
                <ReviewFileRow path={row.path} status={t(STATUS_LABELS[row.status])}
                  selected={selected?.path === row.path} disabled={!row.canDiff && !row.canPreview}
                  onSelect={() => onSelect(row.path, row.canDiff ? "diff" : "preview")} />
                <div className="review-file-actions">
                  {row.staged !== undefined ? <span className="row-meta">{row.staged ? t("已暫存") : t("未暫存")}{row.staged && row.unstaged ? ` · ${t("未暫存")}` : ""}</span> : null}
                  {row.canPreview && row.canDiff ? <button type="button" className="link-button" onClick={() => onSelect(row.path, "preview")}>{onSaveFile ? t("編輯") : t("預覽")}</button> : null}
                  {onStage && row.unstaged ? <button type="button" className="link-button" aria-label={t("暫存 {path}", { path: row.path })} disabled={busy} onClick={() => void mutate(() => onStage(row.path))}>+</button> : null}
                  {onUnstage && row.staged ? <button type="button" className="link-button" aria-label={t("取消暫存 {path}", { path: row.path })} disabled={busy} onClick={() => void mutate(() => onUnstage(row.path))}>−</button> : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {selected === undefined ? null : (
        <div className="review-detail">
          <p className="row-label">{selected.path}（{selected.mode === "diff" ? "diff" : t("預覽")}）</p>
          {onSaveFile ? <nav className="review-mode-tabs" aria-label={selected.path}>
            <button type="button" className="link-button" aria-current={selected.mode === "diff" ? "true" : undefined} onClick={() => onSelect(selected.path, "diff")}>{t("差異")}</button>
            <button type="button" className="link-button" aria-current={selected.mode === "preview" ? "true" : undefined} onClick={() => onSelect(selected.path, "preview")}>{t("編輯")}</button>
          </nav> : null}
          {selected.mode === "diff"
            ? diff === undefined ? <p className="muted">{t("正在讀取…")}</p> : <TextBlock value={diff} label="diff" />
            : onSaveFile ? null
            : preview === undefined ? <p className="muted">{t("正在讀取…")}</p> : <TextBlock value={preview} label={t("預覽")} />}
          {onSaveFile ? <div hidden={selected.mode !== "preview"}><SourceFileEditor path={selected.path} value={preview} onSave={onSaveFile} onReload={(path) => onSelect(path, "preview")} /></div> : null}
        </div>
      )}
      {onCommit ? <form className="review-commit" onSubmit={(event) => { event.preventDefault(); if (message.trim() && stagedCount > 0) void mutate(() => onCommit(message)) }}>
        <span className="row-meta">{t("已暫存 {count} 個檔案", { count: stagedCount })}</span>
        <label>{t("提交訊息")}<textarea value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} /></label>
        <button type="submit" disabled={busy || stagedCount === 0 || !message.trim()}>{t("提交已暫存變更")}</button>
      </form> : null}
    </section>
  )
}
