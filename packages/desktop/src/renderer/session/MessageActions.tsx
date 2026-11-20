import { useEffect, useRef, useState } from "react"
import { Check, Copy, Gauge } from "lucide-react"
import { Button } from "../vendor/opencode/Button.tsx"
import { useToolText } from "./tool-text.ts"
import { useLocale } from "../design/i18n.ts"
import type { GenerationReading } from "./project.ts"

export function GenerationSpeed({ generation }: { generation: GenerationReading }) {
  const t = useToolText()
  const locale = useLocale(state => state.locale)
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  const speed = `${number.format(generation.outputTokens * 1000 / generation.generationMs)} tok/s`
  const sample = `${number.format(generation.outputTokens)} ${t("輸出 Token", "output tokens")} · ${number.format(generation.generationMs / 1000)} s · ${number.format(generation.measuredSteps)} ${t("個量測步驟", "measured steps")}`
  return <span className="message-generation-speed" title={sample} aria-label={`${t("Token 生成速度", "Token generation rate")} ${speed} · ${sample}`}><Gauge size={14} aria-hidden="true" />{speed}</span>
}

export function MessageActions({ text, generation }: { text: string; generation?: GenerationReading }) {
  const t=useToolText()
  const [state,setState]=useState<"idle"|"pending"|"copied">("idle")
  const [error,setError]=useState<string>()
  const epoch=useRef(0),feedback=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
  useEffect(()=>{
    epoch.current++;setState("idle");setError(undefined)
    if(feedback.current)clearTimeout(feedback.current)
    return()=>{epoch.current++;if(feedback.current)clearTimeout(feedback.current)}
  },[text])
  async function copy(){
    const captured=++epoch.current;setState("pending");setError(undefined)
    try{
      if(!navigator.clipboard?.writeText)throw new Error(t("剪貼簿不可用","Clipboard unavailable"))
      await navigator.clipboard.writeText(text)
      if(epoch.current!==captured)return
      setState("copied");feedback.current=setTimeout(()=>{if(epoch.current===captured)setState("idle")},1800)
    }catch(cause){if(epoch.current===captured){setState("idle");setError(`${t("複製失敗","Could not copy")}: ${cause instanceof Error?cause.message:String(cause)}`)}}
  }
  return <div className="message-actions">
    {generation ? <GenerationSpeed generation={generation} /> : null}
    <Button variant="ghost" size="small" icon={state==="copied"?<Check size={14}/>:<Copy size={14}/>} disabled={state==="pending"} aria-busy={state==="pending"} aria-label={state==="copied"?t("已複製回覆","Response copied"):t("複製回覆","Copy response")} onClick={()=>{void copy()}} />
    {error?<span role="alert" className="message-copy-error">{error}</span>:null}
  </div>
}
