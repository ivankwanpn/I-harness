import { useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

export function AutoTitleSettings({ bridge }: { bridge: DesktopBridge }) {
  const en = useLocale(state => state.locale) === "en"
  const [enabled, setEnabled] = useState<boolean>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const generation = useRef(0)
  const lock = useRef(false)
  useEffect(() => {
    const own = ++generation.current
    setEnabled(undefined); setError(undefined)
    void bridge.request({ kind: "desktop/global-preferences/state" }).then(value => {
      if (own !== generation.current) return
      if (!value || typeof (value as { enabled?: unknown }).enabled !== "boolean") throw new Error("Automatic title preference unavailable")
      setEnabled((value as { enabled: boolean }).enabled)
    }).catch(reason => { if (own === generation.current) setError(String(reason)) })
    return () => { generation.current++ }
  }, [bridge])
  return <><SettingsGroup><SettingsRow label={en ? "Automatic conversation titles" : "自動產生會話標題"}
    description={en ? "Applies to the next title generation. Existing conversation titles are retained." : "套用到下一次標題產生，既有會話標題會保留。"}
    control={<input type="checkbox" aria-label={en ? "Automatic conversation titles" : "自動產生會話標題"} checked={enabled === true} disabled={enabled === undefined || busy} onChange={event => {
      if (lock.current) return
      const own = ++generation.current
      lock.current = true; setBusy(true); setError(undefined)
      void bridge.request({ kind: "desktop/global-preferences/configure", autoTitle: event.target.checked }).then(value => {
        if (own !== generation.current) return
        if (!value || typeof (value as { enabled?: unknown }).enabled !== "boolean") throw new Error("Automatic title preference unavailable")
        setEnabled((value as { enabled: boolean }).enabled)
      }).catch(reason => { if (own === generation.current) setError(String(reason)) }).finally(() => { lock.current = false; if (own === generation.current) setBusy(false) })
    }} />} /></SettingsGroup>{error ? <p role="alert" className="notice error-text">{error}</p> : null}</>
}
