import { useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

export function ApplicationInformation({ bridge }: { bridge: DesktopBridge }) {
  const en = useLocale(state => state.locale) === "en"
  const [info, setInfo] = useState<{ version: string; electron?: string; node: string; platform: string; arch: string; packaged: boolean }>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const copyingRef = useRef(false)
  useEffect(() => {
    let active = true
    void bridge.request({ kind: "desktop/about/info" }).then(value => { if (active) setInfo(value as typeof info) }, reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge])
  return <><SettingsGroup>
    <SettingsRow label={en ? "Version" : "版本"} control={<span>{info?.version ?? "—"}</span>} />
    <SettingsRow label="Electron / Node.js" control={<span>{info ? `${info.electron ?? "—"} / ${info.node}` : "—"}</span>} />
    <SettingsRow label={en ? "Platform" : "平台"} control={<span>{info ? `${info.platform} · ${info.arch}` : "—"}</span>} />
    <SettingsRow label={en ? "Distribution" : "版本類型"} control={<span>{info ? info.packaged ? en ? "Local portable build" : "本機便攜版" : en ? "Development build" : "開發版" : "—"}</span>} />
    <SettingsRow label={en ? "Updates" : "更新方式"} description={en ? "Install a newer local build to update this version." : "以較新的本機版本替換目前版本。"} control={<span>{en ? "Manual" : "手動更新"}</span>} />
    <SettingsRow label={en ? "Diagnostic information" : "診斷資訊"} control={<button type="button" disabled={copying || !info} aria-busy={copying || undefined} onClick={() => {
      if (copyingRef.current) return
      copyingRef.current = true; setCopying(true); setCopied(false); setError(undefined)
      void bridge.request({ kind: "desktop/about/copy" }).then(() => setCopied(true), reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => { copyingRef.current = false; setCopying(false) })
    }}>{copying ? en ? "Copying…" : "複製中…" : copied ? en ? "Copied" : "已複製" : en ? "Copy" : "複製"}</button>} />
  </SettingsGroup>{error ? <p role="alert">{error}</p> : null}</>
}
