import { useEffect, useRef, useState } from "react"
import type { SearchQuery } from "../../../../fs-search/src/search-types.ts"
import type { ProjectFileRoot, ProjectFileSelection, ProjectFilesRequester } from "../../../../desktop-gateway/src/project-files.ts"
import { absoluteReferencePath, type FileOpenTarget } from "../session/file-navigation.ts"
import { checkedContentSearchResult, checkedSearchCancel, projectContentMatch, referenceContentMatch, type ContentSearchMatch, type ContentSearchResult } from "./content-search-results.ts"
import { useProjectFilesText } from "./project-files-text.ts"
import { SearchText } from "./SearchText.tsx"

interface Props { roots: ProjectFileRoot[]; selection: ProjectFileSelection; request: ProjectFilesRequester; available: boolean; refresh: number; onOpen(target: FileOpenTarget): void }
interface SearchJob { requestId: string; selection: ProjectFileSelection; request: ProjectFilesRequester; scope: string; obsolete: boolean; settled: boolean; cancellation?: Promise<void> }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const PAGE_SIZE = 25

export function ProjectContentSearchPane({ roots, selection, request, available, refresh, onOpen }: Props) {
  const pf = useProjectFilesText()
  const [pattern, setPattern] = useState(""), [regex, setRegex] = useState(false), [caseSensitive, setCaseSensitive] = useState(true)
  const [before, setBefore] = useState("0"), [after, setAfter] = useState("0"), [includes, setIncludes] = useState(""), [excludes, setExcludes] = useState("")
  const [hidden, setHidden] = useState(false), [respectIgnore, setRespectIgnore] = useState(true), [multiline, setMultiline] = useState(false)
  const [encoding, setEncoding] = useState<NonNullable<SearchQuery["encoding"]>>("auto"), [engine, setEngine] = useState<NonNullable<SearchQuery["regexEngine"]>>("default")
  const [maxResults, setMaxResults] = useState("250"), [rootChoice, setRootChoice] = useState("all")
  const [referencePath, setReferencePath] = useState(""), [submittedReference, setSubmittedReference] = useState<string>()
  const [result, setResult] = useState<ContentSearchResult>(), [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [stopping, setStopping] = useState(false), [page, setPage] = useState(0)
  const active = useRef<SearchJob | undefined>(undefined), mounted = useRef(false)
  const scope = JSON.stringify([selection.workspaceId, selection.sessionId, selection.projectId, roots.map(root => root.workspaceId), refresh])
  const currentScope = useRef(scope)
  currentScope.current = scope
  function current(job: SearchJob) { return mounted.current && active.current === job && !job.obsolete && currentScope.current === job.scope }
  function cancel(job: SearchJob, visible = false): Promise<void> {
    if (job.settled) return Promise.resolve()
    if (visible && current(job)) setStopping(true)
    if (!job.cancellation) job.cancellation = (async () => {
      try { checkedSearchCancel(await job.request({ ...job.selection, kind: "desktop/project-files/content-cancel", requestId: job.requestId })) }
      catch (reason) { if (current(job)) { setError(errorText(reason)); setStopping(false) }; job.cancellation = undefined }
    })()
    return job.cancellation
  }
  useEffect(() => {
    mounted.current = true
    setResult(undefined); setSubmittedReference(undefined); setError(undefined); setBusy(false); setStopping(false); setPage(0)
    return () => {
      mounted.current = false
      const previous = active.current
      if (previous) { previous.obsolete = true; void cancel(previous); active.current = undefined }
    }
  }, [scope, available])

  function query(): SearchQuery {
    if (!pattern.length || pattern.length > 4096 || pattern.includes("\0")) throw new Error(pf("請輸入有效搜尋內容（最多 4096 字元）。"))
    const count = (text: string, min: number, max: number) => { const value = Number(text); if (!text.length || !Number.isInteger(value) || value < min || value > max) throw new Error(pf("搜尋數量或前後文行數超出範圍。")); return value }
    const globs = (text: string) => { const rows = text.split(/\r?\n/).filter(Boolean); if (rows.length > 16 || rows.some(row => row.length > 512 || /[\0\r]/.test(row)) || rows.join("").length > 4096) throw new Error(pf("路徑篩選最多 16 筆，每筆 512 字元。")); return rows }
    const includeGlobs = globs(includes), excludeGlobs = globs(excludes)
    if ([...includeGlobs, ...excludeGlobs].join("").length > 4096) throw new Error(pf("路徑篩選合計最多 4096 字元。"))
    return { pattern, mode: regex ? "regex" : "literal", case: caseSensitive ? "sensitive" : "insensitive", before: count(before, 0, 10), after: count(after, 0, 10), includes: includeGlobs, excludes: excludeGlobs, hidden, respectIgnore, regexEngine: engine, multiline, encoding, maxResults: count(maxResults, 1, 1000), maxResultBytes: 256 * 1024, timeoutMs: 30000 }
  }
  async function submit() {
    if (!available || !roots.length && !referencePath.length) return
    let options: SearchQuery
    try { options = query() } catch (reason) { setError(errorText(reason)); return }
    const reference = referencePath.length ? referencePath : undefined
    if (reference && !absoluteReferencePath(reference)) { setError(pf("參考位置需要絕對檔案或資料夾路徑。")); return }
    const workspaceIds = reference ? [] : rootChoice === "all" ? roots.map(root => root.workspaceId) : roots.filter(root => root.workspaceId === rootChoice).map(root => root.workspaceId)
    if (!reference && !workspaceIds.length) { setError(pf("此資料夾已移出目前專案。")); return }
    if (active.current) { active.current.obsolete = true; void cancel(active.current) }
    const job: SearchJob = { requestId: crypto.randomUUID(), selection: { ...selection }, request, scope, obsolete: false, settled: false }
    active.current = job
    setResult(undefined); setError(undefined); setBusy(true); setStopping(false); setPage(0)
    try {
      const reply = checkedContentSearchResult(await job.request({ ...job.selection, kind: "desktop/project-files/content-search", requestId: job.requestId, query: options, ...(reference ? { referencePath: reference } : { workspaceIds }) }))
      if (reply.roots.some(root => !workspaceIds.includes(root.workspaceId)) || reply.matches.some(match => reference ? projectContentMatch(match) : referenceContentMatch(match))) throw new Error("Invalid content search scope")
      if (current(job)) {
        setSubmittedReference(reference)
        setResult({ ...reply, matches: [...reply.matches].sort((left, right) => workspaceIds.indexOf(left.ref?.workspaceId ?? "") - workspaceIds.indexOf(right.ref?.workspaceId ?? "") || left.path.localeCompare(right.path, undefined, { numeric: true }) || left.line - right.line || (left.column ?? 0) - (right.column ?? 0)) })
      }
    } catch (reason) {
      if (current(job)) setError(errorText(reason))
      await cancel(job)
    } finally {
      job.settled = true
      if (current(job)) { setBusy(false); setStopping(false); active.current = undefined }
    }
  }
  const displayed = result?.matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? []
  const pages = Math.max(1, Math.ceil((result?.matches.length ?? 0) / PAGE_SIZE))
  const statusLabel = result ? ({ completed: pf("搜尋完成"), limited: pf("已達上限"), cancelled: pf("已取消"), "timed-out": pf("搜尋逾時"), error: pf("搜尋失敗") }[result.status]) : ""
  function hit(match: ContentSearchMatch, label: string, index: number) {
    const navigation = { line: match.line, column: match.column, endLine: match.endLine, endColumn: match.endColumn, revision: match.revision, encoding: match.encoding, readonly: match.readonly, external: match.external }
    return <li key={`${match.path}:${match.line}:${match.column}:${index}`}>
      <button type="button" className="content-search-hit" aria-label={label} onClick={() => { const click = { ...navigation, nonce: crypto.randomUUID() }; onOpen(referenceContentMatch(match) ? { reference: { ...match.reference }, navigation: click } : { ...match.ref, navigation: click }) }}>
        <span className="row-meta">{match.path}:{match.line}{match.textTruncated ? ` · ${pf("內容已截斷")}` : ""}{match.external ? ` · ${pf("專案外唯讀")}` : match.readonly ? ` · ${pf("唯讀")}` : ""}</span><pre><SearchText text={match.text} startLine={match.line} target={match} /></pre>
      </button>
      {match.context?.length ? <details><summary>{pf("前後文")}</summary>{match.context.map((line, contextIndex) => <pre key={`${line.line}:${contextIndex}`} className="content-search-context"><span>{line.line} </span>{line.text}{line.textTruncated ? ` · ${pf("內容已截斷")}` : ""}</pre>)}</details> : null}
    </li>
  }
  return <section className="project-content-search" aria-label={pf("專案內容搜尋")}>
    <form aria-label={pf("搜尋檔案內容")} onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="content-search-query">
        <input aria-label={pf("搜尋專案檔案內容")} placeholder={pf("輸入內容後按 Enter 搜尋")} maxLength={4096} value={pattern} onChange={event => setPattern(event.target.value)} />
        <button type="submit" disabled={!available || !roots.length && !referencePath.length || !pattern.length}>{pf("搜尋內容")}</button>
        {busy ? <button type="button" disabled={stopping} onClick={() => { if (active.current) void cancel(active.current, true) }}>{pf("停止搜尋")}</button> : null}
      </div>
      <div className="content-search-options">
        <label><input type="checkbox" checked={regex} onChange={event => setRegex(event.target.checked)} />{pf("正規表示式")}</label>
        <label><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} />{pf("區分大小寫")}</label>
        <label>{pf("搜尋資料夾")}<select disabled={!!referencePath.length} value={roots.some(root => root.workspaceId === rootChoice) ? rootChoice : "all"} onChange={event => setRootChoice(event.target.value)}><option value="all">{pf("目前專案所有資料夾")}</option>{roots.map(root => <option key={root.workspaceId} value={root.workspaceId}>{root.label} · {root.workspaceId}</option>)}</select></label>
      </div>
      <details className="content-search-advanced"><summary>{pf("進階搜尋選項")}</summary><div className="content-search-advanced-fields">
        <label>{pf("參考位置（唯讀）")}<input type="text" maxLength={4096} placeholder="C:/reference/folder" value={referencePath} onChange={event => setReferencePath(event.target.value)} /></label>
        <p className="row-meta">{pf("貼上絕對檔案或資料夾路徑；此搜尋只讀取參考位置，不會加入專案。")}</p>
        <label>{pf("包含路徑")}<textarea placeholder="src/**" value={includes} onChange={event => setIncludes(event.target.value)} /></label>
        <label>{pf("排除路徑")}<textarea placeholder="build/**" value={excludes} onChange={event => setExcludes(event.target.value)} /></label>
        <p className="row-meta">{pf("每行一個 glob；最多 16 筆。")}</p>
        <label>{pf("前文行數")}<input type="number" min={0} max={10} value={before} onChange={event => setBefore(event.target.value)} /></label>
        <label>{pf("後文行數")}<input type="number" min={0} max={10} value={after} onChange={event => setAfter(event.target.value)} /></label>
        <label>{pf("結果數量上限")}<input type="number" min={1} max={1000} value={maxResults} onChange={event => setMaxResults(event.target.value)} /></label>
        <label><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} />{pf("包含隱藏檔案")}</label>
        <label><input type="checkbox" checked={respectIgnore} onChange={event => setRespectIgnore(event.target.checked)} />{pf("專案忽略檔")}</label>
        <p className="row-meta">{pf("套用專案內 .gitignore、.ignore、.rgignore；固定排除 .git 與 node_modules。")}</p>
        <label><input type="checkbox" checked={multiline} onChange={event => setMultiline(event.target.checked)} />{pf("跨行搜尋")}</label>
        <label>{pf("正規表示式引擎")}<select value={engine} onChange={event => setEngine(event.target.value as typeof engine)}><option value="default">Rust regex</option><option value="pcre2">PCRE2</option></select></label>
        <label>{pf("內容編碼")}<select value={encoding} onChange={event => setEncoding(event.target.value as typeof encoding)}>{["auto", "utf8", "utf16le", "utf16be", "windows1252", "latin1"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      </div></details>
    </form>
    {!available ? <p role="status" className="notice">{pf("目前後端未提供專案內容搜尋。")}</p> : null}
    {busy ? <p role="status">{stopping ? pf("正在停止搜尋…") : pf("搜尋中…")}</p> : null}
    {error ? <p role="alert" className="notice error-text">{error}</p> : null}
    {result ? <>
      <div role="status" aria-label={pf("搜尋結果摘要")} className="content-search-summary">
        <strong>{statusLabel}{result.partial ? ` · ${pf("部分結果")}` : ""}{result.truncated ? ` · ${pf("結果已截斷")}` : ""}</strong>
        <p>{pf("已回傳 {count} 筆；本地第 {page}/{pages} 頁。", { count: String(result.matches.length), page: String(page + 1), pages: String(pages) })}</p>
        <p className="row-meta">{pf("候選 {candidate} · 已嘗試 {attempted} · 已讀取 {read} · 完整 {completed} · 已確認 EOF {eof} · 內容 {bytes} bytes", { candidate: String(result.stats.candidateFiles), attempted: String(result.stats.attemptedFiles), read: String(result.stats.readFiles), completed: String(result.stats.completedFiles), eof: String(result.stats.eofFiles), bytes: String(result.stats.inputBytes) })}</p>
        <p className="row-meta">{pf("實際篩選")}：{typeof result.filters.hidden === "boolean" && typeof result.filters.respectIgnore === "boolean" ? <>{pf(result.filters.hidden ? "包含隱藏檔案" : "排除隱藏檔案")} · {pf(result.filters.respectIgnore ? "套用專案忽略檔" : "不套用專案忽略檔")}</> : pf("未回報完整篩選設定")}</p>
        <details><summary>{pf("篩選與限制詳情")}</summary><pre>{JSON.stringify({ filters: result.filters, limits: result.limits }, null, 2)}</pre></details>
      </div>
      {result.error ? <p role="alert" className="notice error-text">{result.error}</p> : null}
      {result.reasons.length || result.diagnostics.length ? <ul className="content-search-diagnostics">{[...result.reasons, ...result.diagnostics].map((message, index) => <li key={index}>{message}</li>)}</ul> : null}
      {result.status === "completed" && !result.partial && !result.truncated && result.matches.length === 0 ? <p>{pf("沒有符合的內容。")}</p> : null}
      {result.partial || result.truncated ? <p className="notice">{pf("搜尋未涵蓋全部內容；請縮小範圍或重新搜尋。")}</p> : null}
      {roots.map(root => {
        const matches = displayed.filter(projectContentMatch).filter(match => match.ref.workspaceId === root.workspaceId)
        if (!matches.length) return null
        return <section key={root.workspaceId} className="content-search-root" aria-label={`${root.label} · ${root.workspaceId}`}><p className="row-label">{root.label} <span className="row-meta">{root.workspaceId}</span></p><ul>{matches.map((match, index) => hit(match, `${root.label}/${match.path}:${match.line}`, index))}</ul></section>
      })}
      {displayed.some(referenceContentMatch) ? <section className="content-search-root" aria-label={pf("唯讀參考位置")}><p className="row-label">{pf("唯讀參考位置")} · {submittedReference}</p><ul>{displayed.filter(referenceContentMatch).map((match, index) => hit(match, `${match.reference.path}:${match.line}`, index))}</ul></section> : null}
      {pages > 1 ? <nav className="content-search-pages" aria-label={pf("本地搜尋結果頁面")}><button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{pf("上一頁搜尋結果")}</button><span>{page + 1}/{pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>{pf("下一頁搜尋結果")}</button></nav> : null}
      <p className="row-meta">{pf("頁面僅切換本次已回傳結果；重新搜尋會讀取目前檔案。")}</p>
    </> : null}
  </section>
}
