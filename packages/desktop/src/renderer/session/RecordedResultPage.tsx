import { useEffect, useRef, useState } from "react"
import type { ResultPageQuery, ResultPageResult } from "@i-harness/sdk"
import type { RecordedResultReader } from "./result-pages.ts"
import { acceptedResultPage, resultRefIdentity } from "./result-page-view.ts"
import { OutputBlock } from "./OutputBlock.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { useToolText } from "./tool-text.ts"

type Ref = ResultPageQuery["ref"]
type Page = Exclude<ResultPageResult, {kind:"unavailable"}>
export function RecordedResultPage({ reader, primary, catalog }: {reader:RecordedResultReader;primary?:Ref;catalog?:Ref}) {
  const t = useToolText(), [selected,setSelected] = useState<"primary"|"catalog">(primary ? "primary" : "catalog")
  const ref = selected === "primary" ? primary : catalog
  return <div className="recorded-result-page">
    {primary && catalog ? <div className="output-block-pagination"><Button variant="ghost" size="small" aria-pressed={selected === "primary"} onClick={()=>setSelected("primary")}>{t("主要輸出","Primary output")}</Button><Button variant="ghost" size="small" aria-pressed={selected === "catalog"} onClick={()=>setSelected("catalog")}>{t("相依輸出目錄","Dependent output catalog")}</Button></div> : null}
    {ref ? <PageRead key={`${selected}:${resultRefIdentity(ref)}`} reader={reader} artifact={ref} catalog={selected === "catalog"} /> : null}
  </div>
}

/** One current page; replacing or switching discards the previous bytes. */
function PageRead({reader,artifact,catalog}:{reader:RecordedResultReader;artifact:Ref;catalog:boolean}) {
  const t = useToolText(), [page,setPage] = useState<Page>(), [busy,setBusy] = useState(false), [error,setError] = useState(false)
  const generation = useRef(0), lock = useRef(false)
  useEffect(()=>()=>{ generation.current++; lock.current = false },[])
  async function load(next = false) {
    if (lock.current) return
    const ticket = ++generation.current
    lock.current = true; setBusy(true); setError(false)
    const base = { ref: artifact, maxBytes: 16384 }
    let query: ResultPageQuery
    if (artifact.codec === "exec-frames-v1") {
      const cursor = next && page && "frames" in page ? page.nextCursor : null
      query = { ...base, textView: true, ...(cursor ? { cursor } : {}) }
    } else if (artifact.codec === "code-output-manifest-v1") {
      const cursor = next && page && "header" in page ? page.nextCursor : null
      query = { ...base, ...(cursor ? { cursor } : {}) }
    } else {
      const offset = next && page && "data" in page ? page.nextOffset ?? undefined : undefined
      query = { ...base, ...(offset !== undefined ? { offset } : {}) }
    }
    setPage(undefined)
    try {
      const result = await reader.readPage(query)
      if (ticket !== generation.current) return
      const accepted = acceptedResultPage(result,query)
      if (!accepted) { setError(true); return }
      setPage(accepted)
    } catch { if (ticket === generation.current) setError(true) }
    finally { if (ticket === generation.current) { lock.current=false;setBusy(false) } }
  }
  return <section aria-label={t("已保存輸出分頁","Saved output pages")}>
    <div className="output-block-pagination"><Button variant="ghost" size="small" disabled={busy} onClick={()=>{void load()}} aria-label={page ? t("重新讀取第一頁","Restart saved pages") : t("讀取已保存頁面","Read saved page")}>{page ? t("重新讀取第一頁","Restart saved pages") : t("讀取已保存頁面","Read saved page")}</Button>
      {page ? <Button variant="ghost" size="small" disabled={busy || page.eof} aria-label={t("下一個已保存頁面","Next saved page")} onClick={()=>{void load(true)}}>{t("下一頁","Next page")}</Button> : null}
    </div>
    {busy ? <p role="status" className="tool-result-note">{t("正在讀取已保存頁面…","Reading saved page…")}</p> : null}
    {error ? <p role="alert" className="output-block-error">{t("已保存頁面目前不可用，請重新嘗試。","Saved page unavailable. Please try again.")}</p> : null}
    {page ? <>
      <p className="tool-result-note">{catalog ? t("相依輸出目錄是編碼資料；參照不會自動開啟。","The dependent output catalog is encoded data; references are not opened automatically.") : t("此頁是已保存的編碼片段。","This page is a saved encoded fragment.")}</p>
      <div className="tool-result-metadata"><span>{artifact.codec}</span><span>{artifact.completeness}</span>
        {"frames" in page ? <span>{`${page.cursor.recordOffset}:${page.cursor.sliceOffset} → ${page.nextCursor ? `${page.nextCursor.recordOffset}:${page.nextCursor.sliceOffset}` : artifact.encodedBytes}`}</span>
          : "header" in page ? <span>{`${page.items.length} / ${page.footer.count} ${t("項","items")} · ${page.footer.status}`}</span>
          : <span>{`${page.offset} → ${page.nextOffset ?? artifact.encodedBytes} / ${artifact.encodedBytes} bytes`}</span>}
      </div>
      {"frames" in page ? page.frames.map((frame,index)=><div key={index} data-testid="retained-exec-frame" className="recorded-result-frame">
        <p className="tool-result-note">{frame.channel} · {t("框架","frame")} {frame.frame} · {t("位元組偏移","byte offset")} {frame.offset} · {frame.end ? t("框架結尾","frame end") : t("框架片段","frame slice")}</p>
        <OutputBlock label={t("原始位元組（base64）","Exact bytes (base64)")} text={frame.data} />
        {frame.text ? <OutputBlock label={t("已驗證 UTF-8 檢視","Verified UTF-8 view")} text={frame.text.text} /> : null}
      </div>)
        : "header" in page ? <div className="recorded-result-frames" data-testid="retained-code-output-page">
          <p className="tool-result-note">{page.header.cellId} · {page.header.sourceId}</p>
          {page.items.map(item => <p key={item.ordinal} className="tool-result-note" data-testid="retained-code-output-item">
            {item.ordinal} · {item.item.kind}{item.item.kind === "text" ? ` · ${item.item.retention.kind}` : ` · ${item.item.read}`} · seq {item.member.seq}
          </p>)}
          <p className="tool-result-note">{page.footer.status} · {page.footer.accepted} / {page.footer.count}{page.footer.truncated ? ` · ${t("已截斷","truncated")}` : ""}</p>
        </div>
        : <OutputBlock label={page.data.kind === "text" ? t("編碼文字片段","Encoded text fragment") : t("原始位元組（base64）","Exact bytes (base64)")} text={page.data.kind === "text" ? page.data.text : page.data.base64} />}
      {page.eof ? <p className="tool-result-note">{t("已到已保存內容結尾","End of saved content")}</p> : null}
    </> : null}
  </section>
}
