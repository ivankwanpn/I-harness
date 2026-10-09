import { useEffect, useRef, useState } from "react"
import type { HookAuthoringRequest, HookAuthoringRequestHandler } from "@i-harness/desktop-gateway/src/hook-authoring.ts"
import type { LocalResourceSource } from "@i-harness/desktop-gateway/src/effective-local-inputs.ts"
import { useAuthoringText } from "./resource-authoring-text.ts"
import { useSettingsDraft, useSettingsDraftMap } from "./settings-drafts.tsx"

interface Document { body: string; revision: string | null }
export function HookAuthoringEditor({ workspaceId, request, onSaved, active = true }: { workspaceId: string; request: HookAuthoringRequestHandler; onSaved(): void; active?: boolean }) {
  const t = useAuthoringText(), [source, setSource] = useSettingsDraft<LocalResourceSource>(["hooks", workspaceId, "source"], "workspace")
  const [name, setName] = useSettingsDraft(["hooks", workspaceId, source, "script-name"], "")
  const [config, setConfig] = useState<Document>(), [script, setScript] = useState<Document>(), [loadedName, setLoadedName] = useState("")
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [digest, setDigest] = useState<string>()
  const [configComparison, setConfigComparison] = useState<Document>(), [scriptComparison, setScriptComparison] = useState<Document>()
  const drafts = useSettingsDraftMap<Document>(["hooks", workspaceId, "drafts"]), version = useRef(0), lock = useRef(false)
  const scope = `${workspaceId}:${source}`
  const scopeRef = useRef(scope)
  if (scopeRef.current !== scope) { scopeRef.current = scope; ++version.current }
  useEffect(() => {
    let active = true
    const token = ++version.current
    const release = () => { active = false; ++version.current }
    lock.current = true; setBusy(true); setConfig(undefined); setScript(undefined); setLoadedName(""); setDigest(undefined); setError(undefined); setConfigComparison(undefined); setScriptComparison(undefined)
    const draft = drafts.get(`${scope}:config`)
    if (draft) { setConfig(draft); lock.current = false; setBusy(false); return release }
    void request({ kind: "desktop/hooks/read-config", workspaceId, source }).then(value => { if (active && version.current === token) setConfig(value as Document) }).catch(reason => { if (active && version.current === token) setError(String(reason)) }).finally(() => { if (active && version.current === token) { lock.current = false; setBusy(false) } })
    return release
  }, [workspaceId, source, request])
  async function action(command: HookAuthoringRequest, apply: (value: unknown) => void) {
    if (lock.current) return
    const token = version.current
    lock.current = true; setBusy(true); setError(undefined)
    try { const result = await request(command); if (token === version.current) apply(result) }
    catch (reason) { if (token === version.current) setError(String(reason)) }
    finally { if (token === version.current) { lock.current = false; setBusy(false) } }
  }
  function result(value: unknown, apply: (revision: string) => void) {
    const saved = value as { kind: string; revision: string }
    if (saved.kind === "conflict") throw new Error(t("來源已變更；草稿已保留。請關閉編輯並重新讀取來源，再比較內容。"))
    if (saved.kind !== "saved") throw new Error(t("未收到已保存的結果"))
    apply(saved.revision); onSaved()
  }
  return <section hidden={!active} className="memory-editor" aria-label={t("本機 Hooks 編輯器")}>
    <label>{t("保存位置")}<select disabled={busy} value={source} onChange={event => setSource(event.target.value as LocalResourceSource)}><option value="workspace">{t("工作區")}</option><option value="global">{t("全域")}</option></select></label>
    <p className="notice">{t("保存設定或腳本會取消此本機設定的內容信任，需重新審查及授權。Hook 只有通過後端信任檢查才可執行。")}</p>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {config ? <form onSubmit={event => { event.preventDefault(); void action({ kind: "desktop/hooks/write-config", workspaceId, source, body: config.body, expectedRevision: config.revision }, value => result(value, revision => { const next = { ...config, revision }; setConfig(next); drafts.set(`${scope}:config`, next) })) }}>
      <label>{t("Hooks 設定 JSON")}<textarea rows={14} maxLength={131072} disabled={busy} value={config.body} onChange={event => { const next = { ...config, body: event.target.value }; setConfig(next); drafts.set(`${scope}:config`, next) }} /></label>
      <p className="muted">{t("使用 version: 1 及 handlers；trust.script 指向 scripts/名稱.cjs，trust.sha256 使用下方保存後的完整雜湊。")}</p>
      <button disabled={busy || !config.body.trim()}>{t("驗證並保存 Hooks")}</button>
      <button type="button" disabled={busy} onClick={() => { void action({ kind: "desktop/hooks/read-config", workspaceId, source }, value => setConfigComparison(value as Document)) }}>{t("重新讀取 Hooks 以比較")}</button>
      {configComparison ? <div><pre className="tool-output">{configComparison.body}</pre><button type="button" disabled={busy} onClick={() => { const next = { ...config, revision: configComparison.revision }; setConfig(next); drafts.set(`${scope}:config`, next); setConfigComparison(undefined); setError(undefined) }}>{t("保留草稿並採用此設定修訂")}</button></div> : null}
    </form> : <p role="status">{t("正在讀取…")}</p>}
    <label>{t("腳本名稱")}<input maxLength={64} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
    <button disabled={busy || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)} onClick={() => { void action({ kind: "desktop/hooks/read-script", workspaceId, source, name }, value => { setScript(drafts.get(`${scope}:script:${name}`) ?? value as Document); setLoadedName(name); setDigest(undefined) }) }}>{t("讀取或建立腳本")}</button>
    {script ? <form onSubmit={event => { event.preventDefault(); void action({ kind: "desktop/hooks/write-script", workspaceId, source, name: loadedName, body: script.body, expectedRevision: script.revision }, value => result(value, revision => { const next = { ...script, revision }; setScript(next); setDigest(revision); drafts.set(`${scope}:script:${loadedName}`, next) })) }}>
      <p><code>scripts/{loadedName}.cjs</code></p>
      <label>{t("Hook 腳本內容")}<textarea rows={10} maxLength={131072} disabled={busy} value={script.body} onChange={event => { const next = { ...script, body: event.target.value }; setScript(next); drafts.set(`${scope}:script:${loadedName}`, next) }} /></label>
      <button disabled={busy || !script.body.trim()}>{t("保存腳本")}</button>
      <button type="button" disabled={busy} onClick={() => { void action({ kind: "desktop/hooks/read-script", workspaceId, source, name: loadedName }, value => setScriptComparison(value as Document)) }}>{t("重新讀取腳本以比較")}</button>
      {scriptComparison ? <div><pre className="tool-output">{scriptComparison.body}</pre><button type="button" disabled={busy} onClick={() => { const next = { ...script, revision: scriptComparison.revision }; setScript(next); drafts.set(`${scope}:script:${loadedName}`, next); setScriptComparison(undefined); setError(undefined) }}>{t("保留草稿並採用此腳本修訂")}</button></div> : null}
      {digest ? <p>{t("保存後的 SHA-256：")}<code>{digest}</code></p> : null}
    </form> : null}
  </section>
}
