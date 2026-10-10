import { useEffect, useId, useRef, useState } from "react"
import type { createDesktopMcp, McpSettingsCommand } from "@i-harness/desktop-gateway/src/mcp-settings.ts"
import { useAuthoringText } from "./resource-authoring-text.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { McpSecrets, type McpSecretInput } from "./McpSecrets.tsx"
import { useSettingsDraft } from "./settings-drafts.tsx"
export type McpState = Awaited<ReturnType<ReturnType<typeof createDesktopMcp>["state"]>>
type Row = McpState["servers"][number]
interface McpDraft { name: string; transport: Row["config"]["transport"]; command: string; args: string; cwd: string; url: string; advanced: string; revision: number; patch: Record<string, string | null>; privateInputs: Partial<Record<Row["config"]["transport"], McpSecretInput>> }
type InvalidField = "args" | "advanced"
export function McpEditor({ row, busy, onSave, onClose, onReload, draftIdentity = ["mcp-editor"] }: { row?: Row; busy: boolean; onSave(command: McpSettingsCommand): Promise<void>; onClose(): void; onReload?(): Promise<Row | undefined>; draftIdentity?: readonly string[] }) {
  const t = useAuthoringText()
  const [draft, setDraft, clearDraft] = useSettingsDraft<McpDraft>(draftIdentity, () => ({ name: row?.config.serverName ?? "", transport: row?.config.transport ?? "stdio", command: row?.config.transport === "stdio" ? row.config.command : "", args: JSON.stringify(row?.config.transport === "stdio" ? row.config.args : [], null, 2), cwd: row?.config.transport === "stdio" ? row.config.cwd ?? "" : "", url: row?.config.transport === "streamable-http" ? row.config.url : "", advanced: JSON.stringify(Object.fromEntries(Object.entries(row?.config ?? {}).filter(([key]) => !["serverName", "transport", "command", "args", "cwd", "url"].includes(key))), null, 2), revision: row?.revision ?? 0, patch: {}, privateInputs: {} }))
  const { name, transport, command, args, cwd, url, advanced, patch } = draft
  const change = (patch: Partial<McpDraft>) => setDraft(previous => ({ ...previous, ...patch }))
  const [error, setError] = useState<string>()
  const [fieldError, setFieldError] = useState<{ field: InvalidField; message: string }>()
  const fieldId = useId()
  const argsField = useRef<HTMLTextAreaElement>(null)
  const advancedField = useRef<HTMLTextAreaElement>(null)
  const advancedDisclosure = useRef<HTMLDetailsElement>(null)
  const [comparison, setComparison] = useState<Row>()
  const generation = useRef(0), inFlight = useRef(false)
  useEffect(() => { ++generation.current; return () => { ++generation.current } }, [])
  function invalid(field: InvalidField, message: string) {
    setFieldError({ field, message })
    if (field === "advanced" && advancedDisclosure.current) advancedDisclosure.current.open = true
    const control = field === "args" ? argsField : advancedField
    control.current?.focus()
  }
  return <form className="provider-editor" onSubmit={(event) => {
    event.preventDefault()
    if (busy || inFlight.current) return
    setError(undefined); setFieldError(undefined)
    let parsedArgs: unknown = []
    if (transport === "stdio") {
      try { parsedArgs = JSON.parse(args) }
      catch { invalid("args", t("參數的 JSON 格式有誤；請使用字串陣列。")); return }
      if (!Array.isArray(parsedArgs) || parsedArgs.some(value => typeof value !== "string")) { invalid("args", t("參數必須是 JSON 字串陣列。")); return }
    }
    let extra: unknown
    try { extra = JSON.parse(advanced) }
    catch { invalid("advanced", t("進階設定的 JSON 格式有誤；請使用物件。")); return }
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) { invalid("advanced", t("進階設定必須是 JSON 物件")); return }
    const config = transport === "stdio" ? { ...extra, transport, serverName: name, command, args: parsedArgs as string[], ...(cwd ? { cwd } : {}) } : { ...extra, transport, serverName: name, url }
    const token = generation.current
    inFlight.current = true
    void onSave({ action: "save", config, revision: draft.revision, ...(Object.keys(patch).length ? { secrets: transport === "stdio" ? { env: patch } : { headers: patch } } : {}) }).then(() => { clearDraft(draft) }).catch(reason => { if (token === generation.current) setError(String(reason)) }).finally(() => { inFlight.current = false })
  }}><fieldset disabled={busy}><legend>{t("MCP 伺服器設定")}</legend>
    <label>{t("伺服器名稱")}<input required maxLength={64} disabled={Boolean(row)} value={name} onChange={(event) => change({ name: event.target.value })} /></label>
    <label>{t("連線方式")}<select disabled={Boolean(row)} value={transport} onChange={(event) => change({ transport: event.target.value as typeof transport, patch: {} })}><option value="stdio">stdio</option><option value="streamable-http">Streamable HTTP</option></select></label>
    {transport === "stdio" ? <><label>{t("執行程式")}<input required value={command} onChange={(event) => change({ command: event.target.value })} /></label><label>{t("參數（JSON 陣列）")}<textarea ref={argsField} rows={3} value={args} aria-invalid={fieldError?.field === "args" || undefined} aria-describedby={fieldError?.field === "args" ? `${fieldId}-args-error` : undefined} onChange={(event) => { change({ args: event.target.value }); if (fieldError?.field === "args") setFieldError(undefined) }} /></label>{fieldError?.field === "args" ? <p role="alert" id={`${fieldId}-args-error`}>{fieldError.message}</p> : null}<label>{t("工作目錄（選填）")}<input value={cwd} onChange={(event) => change({ cwd: event.target.value })} /></label></> : <label>URL<input type="url" required value={url} onChange={(event) => change({ url: event.target.value })} /></label>}
    <details><summary>{t(transport === "stdio" ? "環境變數" : "HTTP Headers")}</summary><McpSecrets draftIdentity={[...draftIdentity, transport, "secrets"]} input={draft.privateInputs[transport] ?? { name: "", value: "" }} onInputChange={input => setDraft(previous => ({ ...previous, privateInputs: { ...previous.privateInputs, [transport]: input } }))} keys={row?.secretKeys ?? []} patch={patch} onChange={patch => change({ patch })} /></details>
    <details ref={advancedDisclosure}><summary>{t("進階設定")}</summary><label>{t("進階設定（JSON）")}<textarea ref={advancedField} rows={5} value={advanced} aria-invalid={fieldError?.field === "advanced" || undefined} aria-describedby={fieldError?.field === "advanced" ? `${fieldId}-advanced-error` : undefined} onChange={(event) => { change({ advanced: event.target.value }); if (fieldError?.field === "advanced") setFieldError(undefined) }} /></label>{fieldError?.field === "advanced" ? <p role="alert" id={`${fieldId}-advanced-error`}>{fieldError.message}</p> : null}</details>
    {!row ? <p className="muted">{t("新增設定預設停用；儲存後可啟用並載入現有會話。")}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {row && onReload ? <Button disabled={busy} onClick={() => { void onReload().then(value => { if (!value) throw new Error(t("項目已不可用，請重新整理。")); setComparison(value); setError(undefined) }).catch(reason => setError(String(reason))) }}>{t("重新讀取來源以比較")}</Button> : null}
    {comparison ? <div><h3>{t("目前來源內容")}</h3><pre className="tool-output">{JSON.stringify(comparison.config, null, 2)}</pre><Button disabled={busy} onClick={() => { change({ revision: comparison.revision }); setComparison(undefined); setError(undefined) }}>{t("保留草稿並採用此來源修訂")}</Button></div> : null}
    <div className="provider-actions"><button type="submit" className="primary-button">{t(busy ? "儲存中…" : "儲存")}</button><button type="button" onClick={onClose}>{t("取消")}</button></div>
  </fieldset></form>
}
