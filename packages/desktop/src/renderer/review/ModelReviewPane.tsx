import { useEffect, useRef, useState } from "react"
import type { ModelReviewJob, ModelReviewRecord, ModelReviewTarget } from "@i-harness/desktop-gateway/src/model-review-contract.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale } from "../design/i18n.ts"
import "./model-review.css"

export function ModelReviewPane({ bridge, workspaceId, projectId, sessionId }: {
  bridge: DesktopBridge
  workspaceId: string
  projectId: string
  sessionId?: string
}) {
  const en = useLocale(state => state.locale) === "en"
  const t = (zh: string, english: string) => en ? english : zh
  const [kind, setKind] = useState<ModelReviewTarget["kind"]>("working")
  const [value, setValue] = useState("")
  const [records, setRecords] = useState<ModelReviewRecord[]>([])
  const [job, setJob] = useState<ModelReviewJob>()
  const [error, setError] = useState<string>()
  const [pollError, setPollError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [match, setMatch] = useState<boolean>()
  const [location, setLocation] = useState<{ file: number; line?: number }>()
  const selectedExcerpt = useRef<HTMLLIElement>(null)
  const scope = { workspaceId, projectId, ...(sessionId ? { sessionId } : {}) }
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))
  const read = (id: string) => bridge.request({ ...scope, kind: "desktop/model-review/read", id }) as Promise<ModelReviewJob>
  const compare = async (id: string) => {
    const result = await bridge.request({ ...scope, kind: "desktop/model-review/compare", id }) as { current: boolean }
    return result.current
  }

  useEffect(() => {
    let active = true
    void bridge.request({ ...scope, kind: "desktop/model-review/list" }).then(
      response => { if (active) setRecords(response as ModelReviewRecord[]) },
      reason => { if (active) report(reason) },
    )
    return () => { active = false }
  }, [bridge, workspaceId, projectId, sessionId, job?.status])

  useEffect(() => {
    if (job?.status !== "running") return
    const { id } = job
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = (interval = 800) => {
      timer = setTimeout(() => {
        void read(id).then(
          current => {
            if (!active) return
            setPollError(undefined)
            setJob(previous => previous?.id === id && previous.status === "running" ? current : previous)
            if (current.status === "running") refresh()
          },
          reason => {
            if (!active) return
            setPollError(reason instanceof Error ? reason.message : String(reason))
            refresh(Math.min(5000, interval * 2))
          },
        )
      }, interval)
    }
    refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [bridge, workspaceId, projectId, sessionId, job?.id, job?.status])

  useEffect(() => {
    if (job?.status !== "completed") return
    let active = true
    void compare(job.id).then(current => { if (active) setMatch(current) }, () => {})
    return () => { active = false }
  }, [bridge, workspaceId, projectId, sessionId, job?.id, job?.status])

  useEffect(() => {
    selectedExcerpt.current?.scrollIntoView?.({ block: "nearest" })
  }, [location])

  async function action(run: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    try { await run() } catch (reason) { report(reason) } finally { setBusy(false) }
  }

  function select(current: ModelReviewJob | undefined) {
    setJob(current)
    setPollError(undefined)
    setMatch(undefined)
    setLocation(undefined)
  }
  function prepare() {
    const target = kind === "base" ? { kind, branch: value.trim() }
      : kind === "commit" ? { kind, sha: value.trim() } : { kind }
    void action(async () => select(await bridge.request({ ...scope, kind: "desktop/model-review/prepare", target }) as ModelReviewJob))
  }
  function command(kind: "desktop/model-review/start" | "desktop/model-review/cancel") {
    if (!job) return
    const { id } = job
    void action(async () => {
      const current = await bridge.request({ ...scope, kind, id }) as ModelReviewJob
      setJob(previous => previous?.id === id ? current : previous)
    })
  }

  const targetLabel = (target: ModelReviewTarget) => target.kind === "working" ? t("未提交變更", "Working changes")
    : target.kind === "base" ? target.branch : target.sha
  const status = {
    prepared: t("已擷取變更", "Changes captured"),
    running: t("審查中…", "Reviewing…"),
    completed: t("審查完成", "Review completed"),
    cancelled: t("已取消", "Cancelled"),
    failed: t("審查失敗", "Review failed"),
  }
  const layer = {
    staged: t("已暫存", "Staged"),
    unstaged: t("未暫存", "Unstaged"),
    untracked: t("未追蹤", "Untracked"),
    committed: t("提交差異", "Commit diff"),
  }
  const fileStatus = {
    text: "",
    binary: t("二進位", "Binary"),
    omitted: t("超出審查額度", "Outside review budget"),
    unavailable: t("無法讀取", "Unavailable"),
  }
  const file = location ? job?.snapshot.files[location.file] : undefined
  const hasReadableChanges = job?.snapshot.files.some(row => row.text)

  return <section className="model-review" aria-label={t("模型審查", "Model review")}>
    {job?.status === "running" && pollError ? <p className="muted" role="status" title={pollError}>
      {t("暫時無法更新審查進度，正在重試。", "Unable to refresh review progress. Retrying…")}
    </p> : null}
    <div className="model-review-controls">
      <label>{t("審查目標", "Review target")}
        <select value={kind} disabled={busy} onChange={event => { setKind(event.target.value as ModelReviewTarget["kind"]); setValue("") }}>
          <option value="working">{t("未提交變更", "Working changes")}</option>
          <option value="base">{t("相對基準分支", "Relative to base branch")}</option>
          <option value="commit">{t("指定提交", "Specific commit")}</option>
        </select>
      </label>
      {kind !== "working" ? <label>{kind === "base" ? t("分支名稱", "Branch name") : t("提交 SHA", "Commit SHA")}
        <input type="text" value={value} maxLength={255} disabled={busy} onChange={event => setValue(event.target.value)} />
      </label> : null}
      <button type="button" disabled={busy || job?.status === "running" || (kind !== "working" && !value.trim())} onClick={prepare}>{t("擷取變更", "Capture changes")}</button>
      {records.length ? <label>{t("最近的審查", "Recent reviews")}
        <select value={job?.id ?? ""} disabled={busy} onChange={event => {
          const id = event.target.value
          if (id) void action(async () => select(await read(id)))
          else select(undefined)
        }}>
          <option value="">{t("選擇審查", "Select review")}</option>
          {records.map(record => <option key={record.id} value={record.id}>{targetLabel(record.target)} · {status[record.status]} · {new Date(record.startedAt).toLocaleString()}</option>)}
        </select>
      </label> : null}
    </div>
    {error ? <p role="alert" className="notice error-text">{error}</p> : null}
    {job ? <>
      <div className="model-review-status">
        <strong role="status">{status[job.status]}</strong>
        <span>{targetLabel(job.snapshot.target)}</span>
        <span title={job.snapshot.base}>{job.snapshot.base ? t("基準 ", "Base ") + job.snapshot.base.slice(0, 12) : t("初始提交", "Root commit")}</span>
        {job.snapshot.end ? <span title={job.snapshot.end}>{t("目標 ", "Target ") + job.snapshot.end.slice(0, 12)}</span> : null}
        {job.model ? <span>{job.model}</span> : null}
      </div>
      {match === false ? <p role="status" className="notice">{t("目前變更與這次審查的快照不同。", "Current changes differ from this review's snapshot.")}</p> : null}
      {job.snapshot.listingTruncated ? <p className="notice">{t("檔案清單超出上限，審查僅涵蓋下方列出的檔案。", "The file list exceeded its limit. Review covers the listed files only.")}</p> : null}
      {!hasReadableChanges ? <p className="notice">{t("此範圍沒有可供審查的文字變更。", "This scope contains no readable text changes.")}</p> : null}
      {job.status === "prepared" && hasReadableChanges ? <p>{t("開始後，下列快照會送至已設定的模型。", "Starting sends the captured excerpts to the configured model.")}</p> : null}
      <div className="model-review-controls">
        {job.status === "prepared" ? <button type="button" disabled={busy || !hasReadableChanges} onClick={() => command("desktop/model-review/start")}>{t("開始審查", "Start review")}</button> : null}
        {job.status === "running" ? <button type="button" disabled={busy} onClick={() => command("desktop/model-review/cancel")}>{t("取消審查", "Cancel review")}</button> : null}
        {job.status !== "running" ? <button type="button" disabled={busy} onClick={() => void action(async () => setMatch(await compare(job.id)))}>{t("核對目前變更", "Compare with current changes")}</button> : null}
      </div>
      {job.error ? <p role="alert" className="notice error-text">{job.error}</p> : null}
      {job.result ? <div>
        <p className="model-review-summary">{job.result.summary}</p>
        {job.result.findings.map((finding, index) => <article key={index} className="model-review-finding">
          <button type="button" onClick={() => setLocation({ file: finding.file, line: finding.line })}>{finding.title} · {job.snapshot.files[finding.file]?.path} ({t("快照第 ", "Excerpt line ")}{finding.line}{t(" 行", "")})</button>
          <p>{finding.detail}</p>
        </article>)}
      </div> : null}
      <details className="model-review-files" open={job.status === "prepared" || !!location}>
        <summary>{t("擷取的檔案", "Captured files")} ({job.snapshot.files.length})</summary>
        <p className="muted">{t("擷取範圍不包括子模組。重新命名以刪除及新增兩筆呈現。", "Submodules are excluded. Renames appear as a deletion and an addition.")}</p>
        <ul>{job.snapshot.files.map((row, index) => <li key={row.layer + ":" + row.path}>
          {row.text !== undefined ? <button type="button" onClick={() => setLocation({ file: index })}>{row.path}</button> : <span>{row.path}</span>}
          <span>{layer[row.layer]}{row.truncated ? t(" · 已截斷", " · Truncated") : fileStatus[row.disposition] && " · " + fileStatus[row.disposition]}</span>
        </li>)}</ul>
      </details>
      {file?.text !== undefined ? <section className="model-review-excerpt" aria-label={file.path}>
        <strong>{file.path} · {layer[file.layer]}</strong>
        <ol>{file.text.split("\n").map((line, index) => <li key={index} className={location?.line === index + 1 ? "highlighted" : undefined} ref={location?.line === index + 1 ? selectedExcerpt : undefined}><code>{line || " "}</code></li>)}</ol>
      </section> : null}
    </> : null}
  </section>
}
