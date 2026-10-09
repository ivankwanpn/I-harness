import { useEffect, useRef, useState } from "react"
import type { ResourceAuthoringRequestHandler, ResourceDetail, ResourceKind } from "@i-harness/desktop-gateway/src/resources.ts"
import type { LocalResourceSource } from "@i-harness/desktop-gateway/src/effective-local-inputs.ts"
import { useAuthoringText } from "./resource-authoring-text.ts"
import { Button } from "../vendor/opencode/Button.tsx"

export interface ResourceDraft { name: string; source: LocalResourceSource; body: string; revision: string | null; existing: boolean }
export function ResourceAuthoringEditor({ workspaceId, resourceKind, detail, request, reload, draft, onDraft, onSaved, onClose, onBusyChange }: { workspaceId: string; resourceKind: ResourceKind; detail?: ResourceDetail; request: ResourceAuthoringRequestHandler; reload?(source: LocalResourceSource, name: string): Promise<ResourceDetail | undefined>; draft?: ResourceDraft; onDraft(draft: ResourceDraft): void; onSaved(): void; onClose(): void; onBusyChange?(busy: boolean): void }) {
  const t = useAuthoringText()
  const [value, setValue] = useState<ResourceDraft>(() => draft ?? { name: detail?.name ?? "", source: detail?.source === "global" ? "global" : "workspace", body: detail?.rawBody ?? detail?.body ?? (resourceKind === "skills" ? "---\nname: new-skill\ndescription: Describe this skill\n---\n" : ""), revision: detail && detail.source !== "plugin" ? detail.revision ?? null : null, existing: Boolean(detail && detail.source !== "plugin") })
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [remove, setRemove] = useState(false)
  const [comparison, setComparison] = useState<ResourceDetail>()
  const alive = useRef(true), lock = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  function change(patch: Partial<ResourceDraft>) { const next = { ...value, ...patch }; setValue(next); onDraft(next) }
  async function save(removing = false) {
    if (lock.current) return
    lock.current = true; setBusy(true); onBusyChange?.(true); setError(undefined)
    try {
      const result = await request(removing ? { kind: "desktop/resources/remove", workspaceId, resourceKind, source: value.source, name: value.name, expectedRevision: value.revision!, confirmed: true } : { kind: "desktop/resources/write", workspaceId, resourceKind, source: value.source, name: value.name, body: value.body, expectedRevision: value.revision }) as { kind: string }
      if (!alive.current) return
      if (result.kind === "conflict") { setError(t("來源已變更；草稿已保留。請關閉編輯並重新讀取來源，再比較內容。")); return }
      if (result.kind !== (removing ? "removed" : "saved")) throw new Error(t("未收到已保存的結果"))
      onSaved()
    } catch (reason) { if (alive.current) setError(String(reason)) }
    finally { lock.current = false; if (alive.current) { setBusy(false); onBusyChange?.(false) } }
  }
  return <form className="memory-editor resource-editor" aria-label={t("資源編輯器")} onSubmit={event => { event.preventDefault(); void save() }}>
    <h2>{t(detail?.source === "plugin" ? "複製插件到本機" : value.existing ? "編輯本機內容" : "建立資源")}</h2>
    {detail?.source === "plugin" ? <p className="notice">{t("此內容會建立本機版本，來源插件仍可辨識。")}</p> : null}
    <label>{t("名稱")}<input maxLength={64} required pattern="[a-z0-9]+(-[a-z0-9]+)*" disabled={busy || value.existing} value={value.name} onChange={event => change({ name: event.target.value })} /></label>
    <label>{t("保存位置")}<select disabled={busy || value.existing} value={value.source} onChange={event => change({ source: event.target.value as LocalResourceSource })}><option value="workspace">{t("工作區")}</option><option value="global">{t("全域")}</option></select></label>
    <label>{t("完整 Markdown（含 frontmatter）")}<textarea rows={15} maxLength={131072} disabled={busy} value={value.body} onChange={event => change({ body: event.target.value })} /></label>
    <p className="muted">{t("最多 128 KiB；技能需含相符名稱及描述的 frontmatter。")}</p>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {busy ? <p role="status">{t("正在處理…")}</p> : null}
    {reload && value.existing ? <Button disabled={busy} onClick={() => {
      if (lock.current) return
      lock.current = true; setBusy(true); onBusyChange?.(true); setError(undefined)
      void reload(value.source, value.name).then(next => { if (alive.current) { if (!next?.rawBody || !next.revision) throw new Error(t("項目已不可用，請重新整理。")); setComparison(next) } }).catch(reason => { if (alive.current) setError(String(reason)) }).finally(() => { lock.current = false; if (alive.current) { setBusy(false); onBusyChange?.(false) } })
    }}>{t("重新讀取來源以比較")}</Button> : null}
    {comparison ? <div><h3>{t("目前來源內容")}</h3><pre className="tool-output">{comparison.rawBody}</pre><Button disabled={busy} onClick={() => { change({ revision: comparison.revision! }); setComparison(undefined); setError(undefined) }}>{t("保留草稿並採用此來源修訂")}</Button></div> : null}
    <div className="provider-actions"><Button type="submit" loading={busy} disabled={!value.name || !value.body.trim()}>{t("儲存資源")}</Button><Button disabled={busy} onClick={onClose}>{t("保留草稿並關閉")}</Button>{value.existing && value.revision ? <Button disabled={busy} onClick={() => setRemove(true)}>{t("移除本機版本")}</Button> : null}</div>
    {remove ? <div role="group" aria-label={t("確認移除本機版本")}><p>{t("移除此本機版本後，可能重新顯示同名插件或全域版本。")}</p><Button disabled={busy} onClick={() => { void save(true) }}>{t("確認移除本機版本")}</Button><Button disabled={busy} onClick={() => setRemove(false)}>{t("取消")}</Button></div> : null}
  </form>
}
