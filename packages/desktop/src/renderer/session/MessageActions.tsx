import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "../vendor/opencode/Button.tsx"
import { useToolText } from "./tool-text.ts"

export function MessageActions({text}:{text:string}) {
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
  return <div className="message-actions"><Button variant="ghost" size="small" icon={state==="copied"?<Check size={14}/>:<Copy size={14}/>} disabled={state==="pending"} aria-busy={state==="pending"} aria-label={state==="copied"?t("已複製回覆","Response copied"):t("複製回覆","Copy response")} onClick={()=>{void copy()}} />{error?<span role="alert" className="message-copy-error">{error}</span>:null}</div>
}
