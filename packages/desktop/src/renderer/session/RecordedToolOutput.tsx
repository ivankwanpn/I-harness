/* SPDX-License-Identifier: MIT
 * Result-first typed cards and fallback disclosure patterns adapted from DSH
 * 0.2.0-rc.2 GenericToolCard/ToolRow/ui-primitives, using IH recorded shapes.
 * See TOOL_OUTPUT_SOURCES.md. File diffs use the existing Apache-2.0 preview.
 */
import { useMemo, useState, type ReactNode } from "react"
import { Check, Copy, WrapText } from "lucide-react"
import type { TextDiff } from "../../../../text-diff/src/index.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { LightweightDiffPreview } from "../vendor/zcode/LightweightDiffPreview.tsx"
import type { FileNavigation, ProjectFileNavigation } from "./file-navigation.ts"
import { OutputBlock } from "./OutputBlock.tsx"
import { CapturedValueBlock, RawRecordedData } from "./RawRecordedData.tsx"
import { RecordedFileLink } from "./RecordedFileLink.tsx"
import { formatRecordedValue, record, recordedDiffs, recordedUnifiedDiff, resultImages, safeRecordedUrl, stringField, toolFamily } from "./tool-presentation.ts"
import { useToolText } from "./tool-text.ts"
import type { ToolResultReference } from "./project.ts"
import { useOutputCopy } from "./useOutputCopy.ts"

function RecordedList({ label, rows, children }: { label: string; rows: unknown[]; children(row: unknown, index: number): ReactNode }) {
  const t = useToolText()
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(rows.length / 50)), current = Math.min(page, pages - 1)
  return <div className="tool-recorded-list" aria-label={label}>
    {rows.slice(current * 50, (current + 1) * 50).map((row, index) => <div key={current * 50 + index}>{children(row, current * 50 + index)}</div>)}
    {pages > 1 ? <div className="output-block-pagination">
      <Button size="small" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label={`${t("上一頁", "Previous page")} ${label}`}>{t("上一頁", "Previous")}</Button><span>{current + 1} / {pages}</span>
      <Button size="small" variant="ghost" disabled={current + 1 === pages} onClick={() => setPage(current + 1)} aria-label={`${t("下一頁", "Next page")} ${label}`}>{t("下一頁", "Next")}</Button>
    </div> : null}
  </div>
}

function RecordedChanges({ output, navigation }: { output: unknown; navigation?: FileNavigation }) {
  const t = useToolText(), row = record(output)
  const changes = useMemo(() => recordedDiffs(output), [output])
  return <div className="tool-recorded-changes">
    {changes.length ? <RecordedList label={t("記錄的檔案差異", "Recorded file diffs")} rows={changes}>{(_change, index) => {
      const change = changes[index]!
      return <RecordedDiff change={change} navigation={navigation} />
    }}</RecordedList> : <p className="tool-result-note">{t("這次操作未記錄檔案差異", "No file diff was recorded for this operation")}</p>}
    {typeof row?.rawPatch === "string" ? <OutputBlock label={t("原始 Patch 語法", "Raw patch syntax")} text={row.rawPatch} language="patch" /> : null}
    {Array.isArray(row?.errors) && row.errors.length ? <CapturedValueBlock label={t("檔案操作錯誤", "File operation errors")} value={row.errors} /> : null}
  </div>
}

function RecordedDiff({ change, navigation }: { change: TextDiff; navigation?: FileNavigation }) {
  const t = useToolText(), [wrap, setWrap] = useState(false)
  const patch = useMemo(() => recordedUnifiedDiff(change), [change])
  const { state, error, copy } = useOutputCopy(patch)
  const copyLabel = state === "copied" ? t("已複製差異", "Copied diff") : state === "pending" ? t("正在複製差異", "Copying diff") : t("複製差異", "Copy diff")
  return <section className="tool-recorded-diff" data-wrap={wrap} aria-label={`${t("記錄的差異", "Recorded diff")} ${change.path}`}>
    <div className="tool-diff-heading"><code>{change.path}</code><span className="tool-diff-added">+{change.added}</span><span className="tool-diff-deleted">−{change.deleted}</span><RecordedFileLink args={{ path: change.path }} navigation={navigation} compact />
      <div className="output-block-actions"><Button variant="ghost" size="small" icon={<WrapText size={14} />} aria-pressed={wrap} aria-label={`${t("自動換行差異", "Wrap diff")} ${change.path}`} onClick={() => setWrap(value => !value)}>{t("換行", "Wrap")}</Button>
        <Button variant="ghost" size="small" icon={state === "copied" ? <Check size={14} /> : <Copy size={14} />} aria-label={`${copyLabel} ${change.path}`} aria-busy={state === "pending"} disabled={state === "pending"} onClick={() => { void copy() }}>{state === "copied" ? t("已複製", "Copied") : t("複製", "Copy")}</Button></div>
    </div>
    {change.truncated ? <p className="tool-result-note">{t("記錄的差異已截斷", "The recorded diff is truncated")}</p> : null}
    <LightweightDiffPreview text={patch} />
    {error ? <p className="output-block-error" role="alert">{error}</p> : null}
  </section>
}

function RecordedSearch({ output, navigation }: { output: Record<string, unknown>; navigation?: FileNavigation }) {
  const t = useToolText()
  const matches = (Array.isArray(output.matches) ? output.matches : output.hits) as unknown[]
  const text = useMemo(() => matches.map(value => {
    if (typeof value === "string") return value
    const row = record(value)
    if (!row) return formatRecordedValue(value)
    if (typeof row.name === "string" && typeof row.description === "string") return `${row.name}\n${row.description}`
    const path = stringField(row, ["path"]), location = typeof row.line === "number" ? row.line : typeof row.startLine === "number" ? row.startLine : undefined, line = location === undefined ? "" : `:${location}`
    return `${typeof row.sourceId === "string" ? `${row.sourceId} · ` : ""}${path ?? ""}${line}\n${stringField(row, ["text", "snippet", "content"]) ?? formatRecordedValue(row)}`
  }).join("\n\n"), [matches])
  const partial = output.partial === true || output.truncated === true || output.status !== undefined && output.status !== "completed"
  return <div className="tool-search-result">
    <div className="tool-result-metadata"><span>{matches.length} {t("筆結果", "results")}</span>{output.partial === true ? <span>{t("部分結果", "Partial results")}</span> : null}{output.truncated === true ? <span>{t("結果已截斷", "Results truncated")}</span> : null}</div>
    {Array.isArray(output.reasons) && output.reasons.length ? <p className="tool-result-note">{output.reasons.filter(reason => typeof reason === "string").join(" · ")}</p> : null}
    {matches.length ? <>
      <OutputBlock label={t("搜尋結果", "Search results")} text={text} />
      {navigation ? <RecordedList label={t("搜尋檔案位置", "Search file locations")} rows={matches}>{value => {
        const row = record(value), path = typeof value === "string" ? value : stringField(row, ["path"])
        // Code Context reference paths are relative to their own source. The
        // file callback has no source mapping, so only the actual workspace
        // source can use the current owner's relative file route.
        if (!path || typeof row?.sourceId === "string" && row.sourceId !== "workspace") return null
        const firstLine = typeof row?.line === "number" ? row.line : typeof row?.startLine === "number" ? row.startLine : undefined
        const location: Omit<ProjectFileNavigation, "nonce"> | undefined = row && firstLine !== undefined && Number.isSafeInteger(firstLine) && firstLine > 0 ? {
          line: firstLine,
          ...(typeof row.column === "number" ? { column: row.column } : {}), ...(typeof row.endLine === "number" ? { endLine: row.endLine } : {}), ...(typeof row.endColumn === "number" ? { endColumn: row.endColumn } : {}),
          ...(typeof row.revision === "string" ? { revision: row.revision } : {}),
          ...(["auto", "utf8", "utf16le", "utf16be", "windows1252", "latin1"].includes(String(row.encoding)) ? { encoding: row.encoding as ProjectFileNavigation["encoding"] } : {}),
          ...(row.readonly === true ? { readonly: true } : {}), ...(row.external === true ? { external: true } : {}),
        } : undefined
        return <RecordedFileLink args={{ path }} navigation={navigation} location={location} />
      }}</RecordedList> : null}
    </> : <p className="tool-result-note">{partial ? t("本次記錄沒有回傳項目；搜尋未涵蓋全部內容。", "No items were returned in this record; search coverage is incomplete.") : t("沒有符合的內容。", "No matching content.")}</p>}
  </div>
}

function RecordedWeb({ output }: { output: Record<string, unknown> }) {
  const t = useToolText()
  const text = stringField(output, ["text", "content"]), sources = Array.isArray(output.sources) ? output.sources : []
  const url = safeRecordedUrl(output.url)
  return <div className="tool-web-result">
    {typeof output.title === "string" ? <p className="tool-result-title">{output.title}</p> : null}
    {typeof output.url === "string" ? url ? <a href={url} target="_blank" rel="noreferrer noopener">{output.url}</a> : <code>{output.url}</code> : null}
    {text !== undefined ? <OutputBlock label={t("網頁內容", "Web content")} text={text} truncated={output.truncated === true || output.bodyTruncated === true} defaultWrap /> : null}
    {sources.length ? <RecordedList label={t("網頁來源", "Web sources")} rows={sources}>{value => {
      const source = record(value)
      if (!source || typeof source.url !== "string") return <CapturedValueBlock label={t("來源記錄", "Source record")} value={value} />
      const href = safeRecordedUrl(source.url), title = stringField(source, ["title"]) || source.url
      return <div className="tool-web-source"><div>{href ? <a href={href} target="_blank" rel="noreferrer noopener">{title}</a> : <span>{title}</span>}{typeof source.publishedAt === "string" ? <span className="tool-result-note">{source.publishedAt}</span> : null}</div>
        {typeof source.snippet === "string" ? <p>{source.snippet.slice(0, 2000)}{source.snippet.length > 2000 ? "…" : ""}</p> : null}
      </div>
    }}</RecordedList> : null}
    {typeof output.notice === "string" ? <p className="tool-result-note">{output.notice}</p> : null}
    {output.truncated === true && text === undefined ? <p className="tool-result-note">{t("記錄的輸出已截斷", "The recorded output is truncated")}</p> : null}
  </div>
}

export function RecordedImages({ output, onPreview }: { output: unknown; onPreview?(preview: { src: string; name: string }): void }) {
  const t = useToolText()
  const images = useMemo(() => resultImages(output), [output])
  if (!images.length) return null
  const metadata = images.map(({ dataBase64, ...image }) => ({ ...image, bytes: Math.floor(dataBase64.length * 3 / 4) - (dataBase64.match(/=+$/)?.[0].length ?? 0) }))
  return <>
    <div className="tool-result-images">{images.map((image, index) => {
      const src = `data:${image.mediaType};base64,${image.dataBase64}`, name = image.name || `${t("圖片", "Image")} ${index + 1}`
      const thumbnail = <img src={src} alt={name} loading="lazy" decoding="async" />
      return onPreview ? <button key={index} type="button" className="tool-result-image-button" aria-label={name} onClick={() => onPreview({ src, name })}>{thumbnail}</button> : <div key={index} className="tool-result-image-button">{thumbnail}</div>
    })}</div>
    <CapturedValueBlock label={t("圖片資料", "Image metadata")} value={metadata} />
  </>
}

function RecordedReferences({ refs }: { refs: ToolResultReference[] }) {
  const t = useToolText()
  return <RecordedList label={t("保留的結果參照", "Retained result references")} rows={refs}>{value => <RecordedReference reference={value as ToolResultReference} />}</RecordedList>
}

function RecordedReference({ reference: ref }: { reference: ToolResultReference }) {
  const t = useToolText()
  const [open, setOpen] = useState(false)
  return <details className="tool-result-reference" open={open}><summary onClick={event => { event.preventDefault(); setOpen(value => !value) }}><span>{ref.label}</span> · <span>{ref.complete ? t("完整保留", "Complete capture") : t("部分保留", "Partial capture")} · {ref.bytes} / {ref.originalBytes} bytes</span></summary>
    {open ? <>
      <dl><dt>ID</dt><dd>{ref.id}</dd><dt>{t("修訂", "Revision")}</dt><dd>{ref.revision}</dd><dt>{t("工作區", "Workspace")}</dt><dd>{ref.workspaceId}</dd><dt>{t("會話", "Session")}</dt><dd>{ref.sessionId}</dd><dt>{t("呼叫", "Call")}</dt><dd>{ref.callId}</dd><dt>{t("到期時間記錄", "Recorded expiry")}</dt><dd>{ref.expiresAt}</dd></dl>
      {ref.source ? <CapturedValueBlock label={t("來源參照", "Source reference")} value={ref.source} /> : null}
    </> : null}
  </details>
}

export function RecordedToolOutput({ name, args, output, resultReceived, navigation, resultRefs, onPreview }: { name: string; args: unknown; output: unknown; resultReceived?: true; navigation?: FileNavigation; resultRefs?: ToolResultReference[]; onPreview?(preview: { src: string; name: string }): void }) {
  const t = useToolText(), row = record(output), family = toolFamily(name)
  const images = useMemo(() => resultImages(output), [output])
  let content: ReactNode, typed = false
  if (family === "command" && (typeof output === "string" || typeof row?.stdout === "string" || typeof row?.stderr === "string")) {
    typed = true
    const stdout = typeof output === "string" ? output : typeof row?.stdout === "string" ? row.stdout : undefined
    const stderr = typeof row?.stderr === "string" ? row.stderr : undefined, truncation = record(row?.truncated)
    const omitted = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    const stdoutOmitted = omitted(truncation?.stdoutBytes), stderrOmitted = omitted(truncation?.stderrBytes)
    // Shell's byte marker is present only after loss. Both zeros can mean an
    // upstream tail whose complete omitted size is unknown; never claim zero.
    const byteMarker = !!truncation && ("stdoutBytes" in truncation || "stderrBytes" in truncation)
    const unknownOmission = byteMarker && !(stdoutOmitted && stdoutOmitted > 0) && !(stderrOmitted && stderrOmitted > 0)
    content = <><div className="tool-result-metadata">{typeof row?.exitCode === "number" ? <span>{t("結束代碼", "Exit code")} {row.exitCode}</span> : null}{typeof row?.signal === "string" ? <span>Signal {row.signal}</span> : null}{row?.timedOut === true ? <span>{t("命令逾時", "Command timed out")}</span> : null}{typeof record(args)?.cwd === "string" ? <code>{String(record(args)!.cwd)}</code> : null}</div>
      {unknownOmission ? <p className="tool-result-note">{t("記錄的輸出已截斷；未回報完整省略數量。", "The recorded output is truncated; the complete omitted size was not reported.")}</p> : null}
      {stdoutOmitted && stdoutOmitted > 0 ? <p className="tool-result-note">stdout {t("省略", "omitted")} {stdoutOmitted} bytes</p> : null}
      {stderrOmitted && stderrOmitted > 0 ? <p className="tool-result-note">stderr {t("省略", "omitted")} {stderrOmitted} bytes</p> : null}
      {stdout !== undefined && (stdout.length > 0 || !stderr) ? <OutputBlock label="stdout" text={stdout} truncated={!!stdoutOmitted || truncation?.stdout === true || row?.truncated === true} /> : null}
      {stderr ? <OutputBlock label="stderr" text={stderr} truncated={!!stderrOmitted || truncation?.stderr === true || row?.truncated === true} /> : null}</>
  } else if (family === "write" && row) {
    typed = true; content = <RecordedChanges output={output} navigation={navigation} />
  } else if (family === "search" && (Array.isArray(row?.matches) || Array.isArray(row?.hits))) {
    typed = true; content = <RecordedSearch output={row} navigation={navigation} />
  } else if (family === "web" && row && (typeof row.text === "string" || typeof row.content === "string" || Array.isArray(row.sources))) {
    typed = true; content = <RecordedWeb output={row} />
  } else if (family === "code" && row && (typeof row.text === "string" || Array.isArray(row.cells))) {
    typed = true
    content = <>{typeof row.text === "string" ? <OutputBlock label={t("Code Mode 輸出", "Code Mode output")} text={row.text} truncated={row.truncated === true} /> : <CapturedValueBlock label={t("Code Mode 執行單元", "Code Mode cells")} value={row.cells} />}{typeof record(args)?.code === "string" ? <OutputBlock label={t("JavaScript 原始碼", "JavaScript source")} language="javascript" text={String(record(args)!.code)} /> : null}</>
  } else if ((family === "read" || family === "mcp") && (typeof row?.content === "string" || typeof row?.text === "string" || Array.isArray(row?.entries))) {
    typed = true
    content = Array.isArray(row?.entries) ? <OutputBlock label={t("目錄項目", "Directory entries")} text={row.entries.map(formatRecordedValue).join("\n")} /> : <OutputBlock label={t("檔案內容", "File content")} text={stringField(row, ["content", "text"])!} truncated={row?.truncated === true} />
  } else if (family === "mcp" && (Array.isArray(output) || Array.isArray(row?.content))) {
    const blocks = (Array.isArray(output) ? output : row!.content) as unknown[]
    const texts = blocks.flatMap(value => { const block = record(value), resource = record(block?.resource); return block?.type === "text" && typeof block.text === "string" ? [block.text] : block?.type === "resource" && typeof resource?.text === "string" ? [resource.text] : [] })
    typed = true; content = texts.length ? <OutputBlock label={t("MCP 內容", "MCP content")} text={texts.join("\n\n")} /> : images.length ? null : <CapturedValueBlock label={t("執行輸出", "Output")} value={output} />
  } else if (images.length) { typed = true; content = null }
  else if (output !== undefined) content = <CapturedValueBlock label={t("執行輸出", "Output")} value={output} />
  else content = <p className="tool-result-note">{resultReceived ? t("未記錄輸出內容", "No output body was recorded") : t("尚未回報結果", "No result recorded yet")}</p>
  const error = row?.error
  return <div className="tool-recorded-output">
    {error !== undefined && error !== null && error !== "" && typed ? <CapturedValueBlock label={t("錯誤記錄", "Recorded error")} value={error} /> : null}
    {content}
    <RecordedImages output={output} onPreview={onPreview} />
    {resultRefs?.length ? <RecordedReferences refs={resultRefs} /> : null}
    <RawRecordedData key={name} name={name} args={args} output={output} includeOutput={typed} />
  </div>
}
