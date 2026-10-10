import { useEffect, useRef, useState } from "react"
import type { ApprovalRulesState, RememberApprovalOptions } from "@i-harness/desktop-gateway/src/approval-rules.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"

export function ApprovalRuleManager({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useText()
  const [state, setState] = useState<ApprovalRulesState>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const [requestId, setRequestId] = useState("")
  const [scope, setScope] = useState<RememberApprovalOptions["scope"]>("session")
  const [duration, setDuration] = useState(3600000)
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(0)
  const currentWorkspace = useRef(workspaceId); currentWorkspace.current = workspaceId
  const lock = useRef(false)
  // These actions are added to the central Desktop contract by the host owner.
  const request = (action: unknown) => bridge.request(action as Parameters<DesktopBridge["request"]>[0])
  useEffect(() => {
    let active = true
    setState(undefined); setError(undefined); lock.current = false; setBusy(false)
    void request({ kind: "desktop/approval-rules/state", workspaceId }).then((value) => {
      const next = value as ApprovalRulesState | undefined
      if (!next || !Array.isArray(next.rules) || !Array.isArray(next.candidates)) throw new Error(t("目前工作區後端未提供此功能。"))
      if (active) { setState(next); setRequestId((selected) => next.candidates.some((row) => row.requestId === selected) ? selected : next.candidates[0]?.requestId ?? "") }
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, reload])
  async function mutate(action: unknown): Promise<void> {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined)
    try { await request(action); if (currentWorkspace.current === workspaceId) setReload((value) => value + 1) }
    catch (reason) { if (currentWorkspace.current === workspaceId) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (currentWorkspace.current === workspaceId) { lock.current = false; setBusy(false) } }
  }
  const query = search.trim().toLowerCase()
  const filteredRules = state?.rules.filter((row) => `${row.evidence.name} ${row.evidence.arguments} ${row.scope.kind === "session" ? row.scope.sessionId : "workspace"}`.toLowerCase().includes(query)) ?? []
  const pageCount = Math.max(1, Math.ceil(filteredRules.length / 20)), visiblePage = Math.min(page, pageCount - 1)
  const filteredCandidates = state?.candidates.filter((row) => `${row.name} ${row.sessionId} ${row.arguments}`.toLowerCase().includes(query)) ?? []
  const visibleCandidates = filteredCandidates.slice(0, 100)
  const candidate = visibleCandidates.find((row) => row.requestId === requestId) ?? visibleCandidates[0]
  return <section aria-label={t("記住核准規則")} className="settings-group">
    <h2>{t("記住核准規則")}</h2>
    <p className="settings-description">{t("規則僅允許相同工具身分與完整參數。每次仍會檢查目前沙箱、Plan Mode、角色與 Hooks；變更身分、設定或到期後重新詢問。")}</p>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    <button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>{t("重新讀取規則")}</button>
    {!state ? !error ? <p role="status">{t("正在讀取…")}</p> : null : <>
      <label>{t("搜尋核准規則")}<input aria-label={t("搜尋核准規則")} value={search} onChange={(event) => { setSearch(event.target.value); setPage(0) }} /></label>
      {filteredRules.length === 0 ? <p>{t(query ? "沒有符合的核准規則" : "尚未保存核准規則")}</p> : <><ul className="task-list">{filteredRules.slice(visiblePage * 20, visiblePage * 20 + 20).map((rule) => <li className="task-row" key={rule.id}>
        <strong>{rule.evidence.name}</strong><pre className="approval-details">{rule.evidence.arguments}</pre>
        <p>{t(rule.scope.kind === "workspace" ? "此專案" : "此會話")}{rule.scope.kind === "session" ? ` · ${rule.scope.sessionId}` : ""} · {t("有效期限")}：{new Date(rule.expiresAt).toLocaleString()}{rule.expiresAt <= Date.now() ? ` · ${t("已到期")}` : ""}</p>
        <button type="button" aria-label={t("撤銷規則")} disabled={busy} onClick={() => { void mutate({ kind: "desktop/approval-rules/revoke", workspaceId, ruleId: rule.id }) }}>{t("撤銷規則")}</button>
      </li>)}</ul>{pageCount > 1 ? <div><button type="button" disabled={busy || visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>{t("上一頁")}</button><span>{t("第 {page} / {total} 頁", { page: visiblePage + 1, total: pageCount })}</span><button type="button" disabled={busy || visiblePage + 1 === pageCount} onClick={() => setPage(visiblePage + 1)}>{t("下一頁")}</button></div> : null}</>}
      <h3>{t("新增規則")}</h3>
      {visibleCandidates.length === 0 ? <p>{t(query ? "沒有符合的待核准操作" : "目前沒有可記住的即時待核准操作。可在新的核准卡片勾選記住；中斷或無完整身分證據的操作只支援單次核准。")}</p> : <form onSubmit={(event) => {
        event.preventDefault(); if (!candidate) return
        void mutate({ kind: "desktop/approval-rules/add", workspaceId, requestId: candidate.requestId, sessionId: candidate.sessionId, remember: { scope, expiresAt: Date.now() + duration } })
      }}>
        <label>{t("待核准操作")}<select aria-label={t("待核准操作")} disabled={busy} value={candidate?.requestId ?? ""} onChange={(event) => setRequestId(event.target.value)}>{visibleCandidates.map((row) => <option key={row.requestId} value={row.requestId}>{row.name} · {row.sessionId}</option>)}</select></label>
        {filteredCandidates.length > 100 ? <p className="notice">{t("結果已達搜尋上限，請縮小搜尋範圍。")}</p> : null}
        {candidate ? <pre className="approval-details">{candidate.arguments}</pre> : null}
        <label>{t("規則作用範圍")}<select aria-label={t("規則作用範圍")} disabled={busy} value={scope} onChange={(event) => setScope(event.target.value as RememberApprovalOptions["scope"])}><option value="session">{t("此會話")}</option><option value="workspace">{t("此專案")}</option></select></label>
        <label>{t("有效期限")}<select aria-label={t("有效期限")} disabled={busy} value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={3600000}>{t("1 小時")}</option><option value={86400000}>{t("1 天")}</option><option value={604800000}>{t("7 天")}</option></select></label>
        <p className="notice">{t("新增只保存此完整操作的規則；目前核准卡片仍須明確批准或拒絕。")}</p>
        <button type="submit" className="primary-button" disabled={busy || !candidate}>{t("新增規則")}</button>
      </form>}
    </>}
  </section>
}
