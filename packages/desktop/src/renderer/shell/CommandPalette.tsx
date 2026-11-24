import { useEffect, useId, useMemo, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { ProjectFilesPaneProps } from "../review/ProjectFilesPane.tsx"
import { checkedFilePage, checkedProjectRoots } from "../review/project-file-responses.ts"
import type { ProjectFileTarget } from "../session/file-navigation.ts"
import type { HistorySelection } from "../session/SessionSearch.tsx"
import { displayError } from "../design/error-display.ts"
import { useLocale } from "../design/i18n.ts"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import "./command-palette.css"

export interface WorkbenchCommand {
  id: string
  label: string
  run(): void
}

interface Result extends WorkbenchCommand {
  group: "command" | "session" | "file"
  detail?: string
}

interface HistoryHit { sessionId: string; seq: number; snippet: string }

export interface CommandPaletteProps {
  bridge: DesktopBridge
  commands: WorkbenchCommand[]
  workspace?: { id: string; label: string }
  sessions: { id: string; title?: string }[]
  sessionSearch: boolean
  files?: Pick<ProjectFilesPaneProps, "selection" | "request">
  onConversation(id: string): void
  onHistory(target: HistorySelection): void
  onFile(ref: ProjectFileTarget): void
  onClose(): void
}

const MAX_RESULTS = 12
const matches = (label: string, query: string) => !query || label.toLowerCase().includes(query.toLowerCase())

export function CommandPalette(props: CommandPaletteProps) {
  const english = useLocale(state => state.locale) === "en"
  const [value, setValue] = useState("")
  const [focus, setFocus] = useState(0)
  const composing = useRef(false)
  const [asyncResults, setAsyncResults] = useState<{ key: string; hits: HistoryHit[]; files: FileMatch[]; errors: unknown[] }>()
  const listId = useId()
  const mode = value.startsWith(">") ? "command" : value.startsWith("#") ? "session" : value.startsWith("@") ? "file" : "all"
  const query = (mode === "all" ? value : value.slice(1)).trim()
  const workspaceId = props.workspace?.id
  const searchHistory = mode === "session" && !!query && !!workspaceId && props.sessionSearch
  const searchFiles = (mode === "file" || mode === "all") && !!query && !!props.files
  const { bridge } = props
  const requestFiles = props.files?.request
  const fileWorkspace = props.files?.selection.workspaceId
  const fileSession = props.files?.selection.sessionId
  const fileProject = props.files?.selection.projectId
  const selection = useMemo(() => fileWorkspace ? {
    workspaceId: fileWorkspace, sessionId: fileSession, projectId: fileProject,
  } : undefined, [fileWorkspace, fileSession, fileProject])
  const fileScope = JSON.stringify(selection ?? null)
  const key = JSON.stringify([workspaceId, mode, query, fileScope])
  const titles = useMemo(() => new Map(props.sessions.map(row => [row.id, row.title])), [props.sessions])
  const title = (id: string) => titles.get(id) ?? (english ? "Untitled conversation" : "未命名會話")

  useEffect(() => {
    if (!searchHistory && !searchFiles) return
    let active = true
    const timer = setTimeout(() => {
      const history = searchHistory && workspaceId ? bridge.request({
        kind: "desktop/session/search", workspaceId, query, limit: MAX_RESULTS,
      }).then(value => (value as { hits: HistoryHit[] }).hits) : Promise.resolve([])
      const files = searchFiles && requestFiles && selection ? findFiles(requestFiles, selection, query, () => active) : Promise.resolve([])
      void Promise.allSettled([history, files]).then(([h, f]) => {
        if (!active) return
        setAsyncResults({
          key, hits: h.status === "fulfilled" ? h.value : [], files: f.status === "fulfilled" ? f.value : [],
          errors: [h, f].flatMap(result => result.status === "rejected" ? [result.reason] : []),
        })
      })
    }, 160)
    return () => { active = false; clearTimeout(timer) }
  }, [bridge, key, workspaceId, query, selection, requestFiles, searchHistory, searchFiles])

  const current = asyncResults?.key === key ? asyncResults : undefined
  const results: Result[] = []
  if (mode === "all" || mode === "command") {
    results.push(...props.commands.filter(command => matches(command.label, query)).map(command => ({ ...command, group: "command" as const })))
  }
  if (mode === "all" || mode === "session") {
    const sessions = props.sessions.filter(row => matches(title(row.id), query)).slice(0, MAX_RESULTS)
    for (const row of sessions) {
      results.push({ id: "session:" + row.id, group: "session", label: title(row.id), detail: props.workspace?.label, run: () => props.onConversation(row.id) })
    }
    for (const hit of current?.hits ?? []) {
      if (workspaceId) results.push({
        id: JSON.stringify(["history", hit.sessionId, hit.seq]), group: "session", label: title(hit.sessionId),
        detail: hit.snippet, run: () => props.onHistory({ workspaceId, sessionId: hit.sessionId, seq: hit.seq }),
      })
    }
  }
  for (const result of current?.files ?? []) {
    results.push({
      id: JSON.stringify(["file", result.ref.workspaceId, result.ref.path]), group: "file", label: result.ref.path,
      detail: result.root, run: () => props.onFile(result.ref),
    })
  }
  const activeIndex = Math.min(focus, results.length - 1)
  function choose(result: Result) {
    props.onClose()
    result.run()
  }
  const groups = { command: english ? "Commands" : "命令", session: english ? "Conversations" : "會話", file: english ? "Files" : "檔案" }
  const label = english ? "Command center" : "命令中心"
  return <SettingsDialog title={label} closeLabel={english ? "Close" : "關閉"} initialFocusSelector=".command-palette input" className="command-palette" onClose={props.onClose}>
    <input className="zc-search-input" autoComplete="off" role="combobox" aria-label={label} aria-controls={listId}
      aria-expanded={true} aria-autocomplete="list" aria-activedescendant={activeIndex >= 0 ? listId + "-" + activeIndex : undefined}
      placeholder={english ? "Search commands, conversations or files" : "搜尋命令、會話或檔案"}
      onCompositionStart={() => { composing.current = true }}
      onKeyUp={() => { composing.current = false }}
      value={value} onChange={event => { setValue(event.target.value); setAsyncResults(undefined); setFocus(0) }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || activeIndex < 0) return
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          const next = (activeIndex + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length
          setFocus(next)
          document.getElementById(listId + "-" + next)?.scrollIntoView?.({ block: "nearest" })
        }
        if (event.key === "Enter") { event.preventDefault(); choose(results[activeIndex]!) }
      }} />
    <p className="muted command-palette-hint">{english ? "> Commands · # Conversation contents · @ Files" : "> 命令 · # 會話內容 · @ 檔案"}</p>
    {current?.errors.map((error, index) => <p className="error-text" role="status" key={index}>{displayError(error, { english }).summary}</p>)}
    {(searchHistory || searchFiles) && !current ? <p className="muted" role="status">{english ? "Searching…" : "正在搜尋…"}</p> : null}
    {!results.length && (!(searchFiles || searchHistory) || current) ? <p className="muted">{english ? "No results" : "沒有結果"}</p> : null}
    <ul id={listId} className="command-palette-results" role="listbox" aria-label={label}>
      {results.map((result, index) => <li role="presentation" key={result.id}>
        {results[index - 1]?.group !== result.group ? <h3>{groups[result.group]}</h3> : null}
        <button id={listId + "-" + index} type="button" role="option" tabIndex={-1} aria-selected={activeIndex === index}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => setFocus(index)} onClick={() => choose(result)}>
          <span>{result.label}</span>{result.detail ? <small>{result.detail}</small> : null}
        </button>
      </li>)}
    </ul>
  </SettingsDialog>
}

type FileMatch = { root: string; ref: ProjectFileTarget }
async function findFiles(request: NonNullable<CommandPaletteProps["files"]>["request"], selection: ProjectFilesPaneProps["selection"], query: string, active: () => boolean): Promise<FileMatch[]> {
  const roots = checkedProjectRoots(await request({ ...selection, kind: "desktop/project-files/roots" }))
  const hits: FileMatch[] = []
  for (const root of roots) {
    if (!active() || hits.length >= MAX_RESULTS) break
    const page = checkedFilePage(await request({
      ...selection, kind: "desktop/project-files/search", ref: { workspaceId: root.workspaceId, path: "" }, query, offset: 0,
    }))
    for (const entry of page.entries) {
      if (entry.kind !== "file") continue
      hits.push({ root: root.label, ref: { workspaceId: root.workspaceId, path: entry.path } })
      if (hits.length >= MAX_RESULTS) break
    }
  }
  return hits
}
