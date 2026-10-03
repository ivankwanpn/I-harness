import { useEffect, useRef, useState } from "react"
import type { ProjectFileEntry, ProjectFilePage, ProjectFileRoot, ProjectFileSelection, ProjectFilesRequester } from "../../../../desktop-gateway/src/project-files.ts"
import type { FileOpenTarget } from "../session/file-navigation.ts"
import { checkedFilePage } from "./project-file-responses.ts"
import { ProjectContentSearchPane } from "./ProjectContentSearchPane.tsx"
import "./review-editor.css"
import { useProjectFilesText } from "./project-files-text.ts"

interface ExplorerProps { roots: ProjectFileRoot[]; selection: ProjectFileSelection; request: ProjectFilesRequester; onOpen(ref: FileOpenTarget): void; refresh: number; contentSearchAvailable?: boolean }
const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error)
const checkedPage = checkedFilePage
function Directory({ root, path, selection, request, onOpen, refresh, initialOpen = false }: Omit<ExplorerProps, "roots"> & { root: ProjectFileRoot; path: string; initialOpen?: boolean }) {
  const pf = useProjectFilesText()
  const [expanded, setExpanded] = useState(initialOpen), [page, setPage] = useState<ProjectFilePage>(), [error, setError] = useState<string>(), [busy, setBusy] = useState(false)
  const identity = JSON.stringify([selection, root.workspaceId, path, refresh, expanded])
  const current = useRef(identity)
  current.current = identity
  useEffect(() => () => { current.current = "" }, [])
  useEffect(() => {
    if (!expanded) return
    let current = true
    setPage(undefined); setError(undefined); setBusy(true)
    request({ ...selection, kind: "desktop/project-files/list", ref: { workspaceId: root.workspaceId, path }, offset: 0 }).then((value) => { if (current) setPage(checkedPage(value)) }).catch((error) => { if (current) setError(reasonOf(error)) }).finally(() => { if (current) setBusy(false) })
    return () => { current = false }
  }, [identity, expanded, request])
  async function more() {
    if (!page || page.nextOffset === null || busy) return
    setBusy(true)
    const before = identity
    try {
      const next = checkedPage(await request({ ...selection, kind: "desktop/project-files/list", ref: { workspaceId: root.workspaceId, path }, offset: page.nextOffset }))
      if (before === current.current) setPage((previous) => ({ ...next, entries: [...(previous?.entries ?? []), ...next.entries] }))
    } catch (error) { if (before === current.current) setError(reasonOf(error)) }
    finally { if (before === current.current) setBusy(false) }
  }
  return <li className="project-directory">
    <button type="button" className="link-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "▾" : "▸"} {path ? path.split("/").at(-1) : root.label}</button>
    {expanded ? <>
      {error ? <p role="alert" className="notice error-text">{error}</p> : null}
      {busy && !page ? <p role="status">{pf("正在讀取檔案…")}</p> : null}
      <ul>{page?.entries.map((entry) => entry.kind === "directory"
        ? <Directory key={entry.path} root={root} path={entry.path} selection={selection} request={request} onOpen={onOpen} refresh={refresh} />
        : <li key={entry.path}><button type="button" className="link-button" title={`${root.label}/${entry.path}`} onClick={() => onOpen({ workspaceId: root.workspaceId, path: entry.path })}>{entry.name}</button></li>)}</ul>
      {page?.nextOffset !== null && page?.nextOffset !== undefined ? <button type="button" disabled={busy} onClick={() => void more()}>{pf("載入更多檔案")}</button> : null}
      {page?.truncated ? <p className="notice">{pf("檔案掃描已達上限；請縮小檔名搜尋。")}</p> : null}
    </> : null}
  </li>
}
function FilenameExplorer({ roots, selection, request, onOpen, refresh }: ExplorerProps) {
  const pf = useProjectFilesText()
  const [query, setQuery] = useState(""), [results, setResults] = useState<Record<string, ProjectFilePage>>({}), [error, setError] = useState<string>()
  const identity = JSON.stringify([selection, roots, query, refresh])
  const current = useRef(identity), paging = useRef(new Set<string>())
  current.current = identity
  useEffect(() => () => { current.current = "" }, [])
  useEffect(() => {
    if (!query.trim()) return
    let current = true
    setResults({}); setError(undefined)
    Promise.all(roots.map(async (root) => [root.workspaceId, checkedPage(await request({ ...selection, kind: "desktop/project-files/search", ref: { workspaceId: root.workspaceId, path: "" }, query, offset: 0 }))] as const)).then((rows) => { if (current) setResults(Object.fromEntries(rows)) }).catch((error) => { if (current) setError(reasonOf(error)) })
    return () => { current = false }
  }, [identity, request])
  async function more(root: ProjectFileRoot) {
    const page = results[root.workspaceId]
    if (!page || page.nextOffset === null) return
    const before = identity, pageKey = `${before}:${root.workspaceId}:${page.nextOffset}`
    if (paging.current.has(pageKey)) return
    paging.current.add(pageKey)
    try {
      const next = checkedPage(await request({ ...selection, kind: "desktop/project-files/search", ref: { workspaceId: root.workspaceId, path: "" }, query, offset: page.nextOffset }))
      if (before === current.current) setResults((previous) => ({ ...previous, [root.workspaceId]: { ...next, entries: [...(previous[root.workspaceId]?.entries ?? []), ...next.entries] } }))
    } catch (error) { if (before === current.current) setError(reasonOf(error)) }
    finally { paging.current.delete(pageKey) }
  }
  return <>
    <input aria-label={pf("搜尋專案檔名")} placeholder={pf("搜尋檔名或相對路徑")} maxLength={512} value={query} onChange={(event) => setQuery(event.target.value)} />
    {error ? <p role="alert" className="notice error-text">{error}</p> : null}
    {!query.trim() ? <ul>{roots.map((root) => <Directory key={`${root.workspaceId}:${JSON.stringify(selection)}`} root={root} path="" initialOpen selection={selection} request={request} onOpen={onOpen} refresh={refresh} />)}</ul>
      : roots.map((root) => <div key={root.workspaceId}><p className="row-label">{root.label}</p><ul>{results[root.workspaceId]?.entries.map((entry: ProjectFileEntry) => <li key={entry.path}><button type="button" className="link-button" onClick={() => onOpen({ workspaceId: root.workspaceId, path: entry.path })}>{entry.path}</button></li>)}</ul>
        {results[root.workspaceId]?.nextOffset != null ? <button type="button" onClick={() => void more(root)}>{pf("載入更多搜尋結果")}</button> : null}
        {results[root.workspaceId]?.truncated ? <p className="notice">{pf("搜尋已達掃描上限。")}</p> : null}</div>)}
  </>
}
export function ProjectExplorer(props: ExplorerProps) {
  const pf = useProjectFilesText(), [mode, setMode] = useState<"filename" | "content">("filename")
  return <nav className={`project-explorer${mode === "content" ? " project-explorer-content" : ""}`} aria-label={pf("專案檔案樹")}>
    <div className="project-search-mode" aria-label={pf("專案搜尋類型")}><button type="button" aria-pressed={mode === "filename"} onClick={() => setMode("filename")}>{pf("檔案名稱")}</button><button type="button" aria-pressed={mode === "content"} onClick={() => setMode("content")}>{pf("檔案內容")}</button></div>
    <div hidden={mode !== "filename"}><FilenameExplorer {...props} /></div>
    {mode === "content" ? <ProjectContentSearchPane {...props} available={props.contentSearchAvailable === true} /> : null}
  </nav>
}
