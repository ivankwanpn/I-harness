import { useMemo, type ReactNode } from "react"
import type { RecordedResultEnvelope as ResultEnvelope } from "./project.ts"
import type { RecordedResultReader } from "./result-pages.ts"
import { RecordedResultPage } from "./RecordedResultPage.tsx"
import { resultRefIdentity } from "./result-page-view.ts"
import { OutputBlock } from "./OutputBlock.tsx"
import { CapturedValueBlock } from "./RawRecordedData.tsx"
import { resultImages } from "./tool-presentation.ts"
import { useToolText } from "./tool-text.ts"

/** Retained facts only: opening this view never resolves an artifact body. */
export function RecordedResultEnvelope({ envelope, onPreview, renderInline, resultReader }: { resultReader?: RecordedResultReader; envelope: ResultEnvelope; onPreview?(preview: {src:string;name:string}):void; renderInline?(value: unknown):ReactNode }) {
  const t = useToolText(), retention = envelope.retention
  const dispatch = envelope.execution.dispatch
  const completeness = retention.kind === "artifact" ? retention.ref.completeness : undefined
  const primary = retention.kind === "artifact" ? retention.ref : undefined
  const catalog = envelope.dependencies?.kind === "artifact-set" ? envelope.dependencies.ref : undefined
  const identity = JSON.stringify([resultReader?.workspaceId,resultReader?.sessionId,primary && resultRefIdentity(primary),catalog && resultRefIdentity(catalog)])
  return <div className="tool-result-envelope">
    <div className="tool-result-metadata"><span>{dispatch === "not-dispatched" ? t("未派發", "Not dispatched") : dispatch === "dispatched" ? t("已派發", "Dispatched") : t("派發狀態未知", "Dispatch unknown")}</span>
      <span>{retention.kind === "inline" ? t("輸出保存在記錄中", "Output saved in record") : retention.kind === "artifact" ? t("輸出已保存", "Output saved") : t("輸出保存不可用", "Output retention unavailable")}</span>
      {completeness ? <span>{completeness === "complete" ? t("完整保留", "Complete capture") : t("部分保留", "Partial capture")} · {completeness}</span> : null}
    </div>
    {retention.kind === "inline" ? renderInline ? renderInline(retention.value) : <CapturedValueBlock label={t("執行輸出", "Output")} value={retention.value} /> : <>
      <OutputBlock label={t("輸出預覽", "Output preview")} text={envelope.preview} />
      {retention.kind === "artifact" ? <CapturedValueBlock label={t("輸出保存參照", "Output retention reference")} value={retention.ref} /> : <p className="tool-result-note">{t("保存原因", "Retention reason")}: {retention.reason}{retention.observedEncodedBytes !== undefined ? ` · ${retention.observedEncodedBytes} bytes` : ""}</p>}
    </>}
    {envelope.dependencies ? <CapturedValueBlock label={t("相依輸出保存記錄", "Dependent output retention record")} value={envelope.dependencies} /> : null}
    {resultReader && (primary || catalog) ? <RecordedResultPage key={identity} reader={resultReader} primary={primary} catalog={catalog} /> : null}
    <RecordedImages output={{images:envelope.media}} onPreview={onPreview} />
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
