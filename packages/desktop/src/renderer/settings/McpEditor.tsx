import { useState } from "react"
import type { createDesktopMcp, McpSettingsCommand } from "@i-harness/desktop-gateway/src/mcp-settings.ts"
import { useText } from "../design/i18n.ts"
import { McpSecrets } from "./McpSecrets.tsx"
export type McpState = Awaited<ReturnType<ReturnType<typeof createDesktopMcp>["state"]>>
type Row = McpState["servers"][number]
export function McpEditor({ row, busy, onSave, onClose }: { row?: Row; busy: boolean; onSave(command: McpSettingsCommand): Promise<void>; onClose(): void }) {
  const t = useText()
  const [name, setName] = useState(row?.config.serverName ?? "")
  const [transport, setTransport] = useState(row?.config.transport ?? "stdio")
  const [command, setCommand] = useState(row?.config.transport === "stdio" ? row.config.command : "")
  const [args, setArgs] = useState(JSON.stringify(row?.config.transport === "stdio" ? row.config.args : [], null, 2))
  const [cwd, setCwd] = useState(row?.config.transport === "stdio" ? row.config.cwd ?? "" : "")
  const [url, setUrl] = useState(row?.config.transport === "streamable-http" ? row.config.url : "")
  const [advanced, setAdvanced] = useState(JSON.stringify(Object.fromEntries(Object.entries(row?.config ?? {}).filter(([key]) => !["serverName", "transport", "command", "args", "cwd", "url"].includes(key))), null, 2))
  const [patch, setPatch] = useState<Record<string, string | null>>({})
  const [error, setError] = useState<string>()
  return <form className="provider-editor" onSubmit={(event) => {
    event.preventDefault(); setError(undefined)
    try {
      const extra: unknown = JSON.parse(advanced)
      if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error(t("進階設定必須是 JSON 物件"))
      const config = transport === "stdio" ? { ...extra, transport, serverName: name, command, args: JSON.parse(args) as string[], ...(cwd ? { cwd } : {}) } : { ...extra, transport, serverName: name, url }
      void onSave({ action: "save", config, revision: row?.revision ?? 0, ...(Object.keys(patch).length ? { secrets: transport === "stdio" ? { env: patch } : { headers: patch } } : {}) })
    } catch (reason) { setError(String(reason)) }
  }}><fieldset disabled={busy}><legend>{t("MCP 伺服器設定")}</legend>
    <label>{t("伺服器名稱")}<input required maxLength={64} disabled={Boolean(row)} value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>{t("連線方式")}<select disabled={Boolean(row)} value={transport} onChange={(event) => { setTransport(event.target.value as typeof transport); setPatch({}) }}><option value="stdio">stdio</option><option value="streamable-http">Streamable HTTP</option></select></label>
    {transport === "stdio" ? <><label>{t("執行程式")}<input required value={command} onChange={(event) => setCommand(event.target.value)} /></label><label>{t("參數（JSON 陣列）")}<textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} /></label><label>{t("工作目錄（選填）")}<input value={cwd} onChange={(event) => setCwd(event.target.value)} /></label></> : <label>URL<input type="url" required value={url} onChange={(event) => setUrl(event.target.value)} /></label>}
    <details><summary>{t(transport === "stdio" ? "環境變數" : "HTTP Headers")}</summary><McpSecrets keys={row?.secretKeys ?? []} patch={patch} onChange={setPatch} /></details>
    <details><summary>{t("進階設定")}</summary><label>{t("進階設定（JSON）")}<textarea rows={5} value={advanced} onChange={(event) => setAdvanced(event.target.value)} /></label></details>
    {!row ? <p className="muted">{t("新增設定預設停用；儲存後可啟用並載入現有會話。")}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="provider-actions"><button type="submit" className="primary-button">{t(busy ? "儲存中…" : "儲存")}</button><button type="button" onClick={onClose}>{t("取消")}</button></div>
  </fieldset></form>
}
