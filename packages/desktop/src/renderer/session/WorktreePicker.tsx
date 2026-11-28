import { useId, useRef, useState } from "react"
import { GitBranch } from "lucide-react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { GitWorktree, GitWorktreeList, WorktreeSelection } from "../../shared/worktrees.ts"
import { useLocale } from "../design/i18n.ts"

export function WorktreePicker({ bridge, workspaceId, projectId, selection, onChange, onReset, disabled }: {
  bridge: DesktopBridge
  workspaceId: string
  projectId: string
  selection?: WorktreeSelection
  onChange(next?: WorktreeSelection): void
  onReset?(): void
  disabled: boolean
}) {
  const english = useLocale(state => state.locale) === "en"
  const copy = (zh: string, en: string) => english ? en : zh
  const id = useId()
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState<GitWorktreeList>()
  const [state, setState] = useState<"loading" | "unavailable" | "ready">("loading")
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState("")
  const requestId = useRef(0)
  const label = selection?.mode === "create" ? copy("建立獨立工作樹", "New Git worktree")
    : selection?.mode === "existing" ? copy("使用既有工作樹", "Existing Git worktree") : copy("目前資料夾", "Current folder")

  async function refresh() {
    setState("loading")
    const ticket = ++requestId.current
    try {
      const result = await bridge.request({ kind: "desktop/worktrees/list", workspaceId, projectId }) as GitWorktreeList | undefined
      if (requestId.current !== ticket) return
      setChoices(result)
      setState(result ? "ready" : "unavailable")
    } catch {
      if (requestId.current === ticket) setState("unavailable")
    }
  }

  async function toggle() {
    if (open) { requestId.current++; setOpen(false); return }
    setOpen(true)
    await refresh()
  }

  async function setOffered(worktree: GitWorktree) {
    if (!worktree.workspaceId) return
    setChanging(true)
    setError("")
    try {
      const offered = worktree.offered === false
      await bridge.request({ kind: "desktop/worktrees/offer", workspaceId: worktree.workspaceId, projectId, offered })
      if (!offered && selection?.mode === "existing" && selection.path === worktree.path) onChange()
      await refresh()
    } catch {
      setError(copy("無法更新工作樹選項。", "Could not update the worktree choice."))
    } finally { setChanging(false) }
  }

  return <div className="composer-worktree">
    <button type="button" className="ghost-button" onClick={() => void toggle()} aria-expanded={open} aria-controls={id} aria-label={label} title={label}>
      <GitBranch size={14} aria-hidden="true" /> <span>{label}</span>
    </button>
    {open ? <div id={id} className="composer-worktree-choices">
      {state === "loading" ? <span role="status">{copy("正在讀取 Git 工作樹…", "Reading Git worktrees…")}</span> : null}
      {state === "unavailable" ? <span role="status">{copy("此資料夾暫無可用的 Git 工作樹。", "Git worktrees are unavailable for this folder.")}</span> : null}
      {onReset ? <button type="button" className="ghost-button" onClick={onReset}>
        {copy("重新選擇目錄並保留已建立的會話", "Choose a different directory and keep the created conversation")}
      </button> : null}
      {state === "ready" && choices ? <>
        <select aria-label={copy("會話工作目錄", "Session working directory")} disabled={disabled || changing}
          value={selection?.mode === "existing" ? selection.path : selection?.mode ?? "current"}
          onChange={event => {
            const value = event.target.value
            onChange(value === "create" ? { mode: "create" } : value === "current" ? undefined : { mode: "existing", path: value })
          }}>
          <option value="current">{copy("目前資料夾", "Current folder")} · {choices.source.branch ?? choices.source.head.slice(0, 8)}</option>
          <option value="create">{copy("建立獨立工作樹", "New Git worktree")}</option>
          {choices.worktrees.map(row => <option key={row.path} value={row.path} disabled={row.missing || row.locked || row.offered === false}>
            {row.branch ?? row.head.slice(0, 8)} · {row.path}{row.dirty ? copy(" · 有未提交變更", " · uncommitted changes") : ""}
          </option>)}
        </select>
        <small title={choices.source.path}>
          {choices.source.path}{choices.source.dirty ? copy(" · 有未提交變更", " · uncommitted changes") : ""}
        </small>
        {choices.worktrees.filter(row => row.workspaceId).map(row => <button key={row.path} type="button" disabled={disabled || changing}
          onClick={() => void setOffered(row)} className="ghost-button">
          {row.offered === false ? copy("恢復選用", "Offer for new conversations") : copy("停止選用", "Hide from new conversations")} · {row.branch ?? row.path}
        </button>)}
        {choices.worktrees.some(row => row.workspaceId) ? <small>{copy("停止選用會保留原有會話、分支與檔案。", "Hiding a worktree preserves its conversations, branch and files.")}</small> : null}
        {error ? <span role="alert">{error}</span> : null}
      </> : null}
    </div> : null}
  </div>
}

export function WorktreeIndicator({ bridge, workspaceId, path, onRelink }: { bridge: DesktopBridge; workspaceId: string; path: string; onRelink(): void }) {
  const english = useLocale(state => state.locale) === "en"
  const [details, setDetails] = useState<GitWorktree>()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  async function toggle() {
    setOpen(!open)
    if (open) return
    setError("")
    setDetails(undefined)
    setLoading(true)
    try { setDetails(await bridge.request({ kind: "desktop/worktrees/state", workspaceId }) as GitWorktree | undefined) }
    catch { /* The configured path remains available for recovery. */ }
    finally { setLoading(false) }
  }
  async function relink() {
    setError("")
    setLoading(true)
    try {
      await bridge.request({ kind: "desktop/worktrees/relink", workspaceId })
      setDetails(await bridge.request({ kind: "desktop/worktrees/state", workspaceId }) as GitWorktree | undefined)
      onRelink()
    } catch {
      setError(english ? "Git could not confirm the worktree's new path." : "Git 無法確認工作樹的新位置。")
    } finally { setLoading(false) }
  }
  return <div className="composer-worktree">
    <button type="button" className="ghost-button" onClick={() => void toggle()} aria-expanded={open}>
      <GitBranch size={14} aria-hidden="true" /> {details?.branch ?? (english ? "Git worktree" : "Git 工作樹")}
    </button>
    {open ? <div className="composer-worktree-choices">
      <small title={details?.path ?? path}>{details?.path ?? path}</small>
      <span role="status">{loading ? (english ? "Reading Git status…" : "正在讀取 Git 狀態…")
        : details ? details.dirty ? (english ? "Uncommitted changes" : "有未提交變更") : (english ? "Clean working tree" : "工作樹無未提交變更")
        : (english ? "Worktree status unavailable" : "工作樹狀態無法取得")}</span>
      {!loading && !details ? <button type="button" className="ghost-button" onClick={() => void relink()}>
        {english ? "Relink moved worktree" : "重新連結已移動的工作樹"}
      </button> : null}
      {error ? <span role="alert">{error}</span> : null}
    </div> : null}
  </div>
}
