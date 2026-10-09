import { useMemo, useState } from "react"
import { OutputBlock } from "./OutputBlock.tsx"
import { formatRecordedValue } from "./tool-presentation.ts"
import { useToolText } from "./tool-text.ts"

export function CapturedValueBlock({ label, value }: { label: string; value: unknown }) {
  const text = useMemo(() => formatRecordedValue(value), [value])
  return <OutputBlock label={label} text={text} language={typeof value === "string" ? undefined : "JSON"} />
}

/** A durable activity record has no synthetic tool invocation fields. */
export function RawRecordedRecord({ value }: { value: unknown }) {
  const t = useToolText()
  const [open, setOpen] = useState(false)
  return <details className="tool-raw-details" open={open}>
    <summary onClick={event => { event.preventDefault(); setOpen(current => !current) }}>{t("原始記錄", "Raw record")}</summary>
    {open ? <div className="tool-raw-content"><CapturedValueBlock label={t("原始記錄資料", "Raw record data")} value={value} /></div> : null}
  </details>
}

/** Serialization is deferred until the reader requests the original record. */
export function RawRecordedData({ name, args, output, includeOutput }: { name: string; args: unknown; output: unknown; includeOutput: boolean }) {
  const t = useToolText()
  const [open, setOpen] = useState(false)
  return <details className="tool-raw-details" open={open}>
    <summary onClick={event => { event.preventDefault(); setOpen(value => !value) }}>{t("原始記錄", "Raw record")}</summary>
    {open ? <div className="tool-raw-content">
      <div className="tool-record-name">{t("工具", "Tool")}: <code>{name}</code></div>
      {args !== undefined ? <CapturedValueBlock label={t("呼叫參數", "Invocation arguments")} value={args} /> : <p className="tool-result-note">{t("未記錄呼叫參數", "No invocation arguments recorded")}</p>}
      {includeOutput ? <CapturedValueBlock label={t("原始輸出", "Raw output")} value={output} /> : null}
    </div> : null}
  </details>
}
