import { useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { errorMessage } from "../design/error-message.ts"
type Mode = "all" | "files" | "conversation"
interface Point { turnIndex: number; preview: string; files: number }
interface Preview {
  fingerprint: string
  ops: { path: string; kind: string }[]
  conflicts: { path: string; kind: string }[]
  unTracked: string[]
  unseen?: { path: string; kind: string }[]
  orphanedTurns?: unknown[]
}
interface Result { revertedFiles: number; errors: { path: string; message: string }[]; eventAppended: boolean }
export function RewindPanel({ bridge, workspaceId, sessionId, onComplete, onClose, onBusyChange }: { bridge: DesktopBridge; workspaceId: string; sessionId: string; onComplete(): void; onClose(): void; onBusyChange?(busy: boolean): void }) {
  const t = useText()
  const [points, setPoints] = useState<Point[]>()
  const [target, setTarget] = useState<number>()
  const [mode, setMode] = useState<Mode>("all")
  const [plan, setPlan] = useState<Preview>()
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<Result>()
  const [reload, setReload] = useState(0)
  const busyListener = useRef(onBusyChange)
  busyListener.current = onBusyChange
  useEffect(() => { busyListener.current?.(busy) }, [busy])
  useEffect(() => () => { busyListener.current?.(false) }, [])
  useEffect(() => {
    let active = true
    void bridge.request({ kind: "desktop/rewind/points", workspaceId, sessionId }).then((rows) => { if (active) setPoints(rows as Point[]) }).catch((reason: unknown) => { if (active) setError(errorMessage(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, sessionId, reload])
  const run = async (execute: boolean) => {
    if (target === undefined || lock.current || (execute && (!confirmed || !plan))) return
    lock.current = true; setBusy(true); setError(undefined)
    try {
      if (execute) {
        const value = await bridge.request({ kind: "desktop/rewind/execute", workspaceId, sessionId, target, mode, fingerprint: plan!.fingerprint }) as Result
        setResult(value); setPlan(undefined); setConfirmed(false); setReload((value) => value + 1); onComplete()
      } else {
        setPlan(undefined); setConfirmed(false); setResult(undefined)
        setPlan(await bridge.request({ kind: "desktop/rewind/plan", workspaceId, sessionId, target, mode }) as Preview)
      }
    } catch (reason) { setPlan(undefined); setConfirmed(false); setError(errorMessage(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <section className="provider-editor" aria-label={t("回復會話")}>
    <h3>{t("回復會話")}</h3>
    <p>{t(mode === "files" ? "僅還原檔案，對話內容保持不變。" : "回復到所選回合開始前；之後的回合將不再提供給模型。")}</p>
    <label>{t("回復點")}<select disabled={busy} value={target ?? ""} onChange={(event) => { setTarget(event.target.value === "" ? undefined : Number(event.target.value)); setPlan(undefined); setConfirmed(false) }}><option value="">{t("選擇回復點")}</option>{points?.map((point) => <option key={point.turnIndex} value={point.turnIndex}>{point.turnIndex + 1} · {point.preview}</option>)}</select></label>
    {points?.length === 0 ? <p>{t("沒有已記錄的回復點")}</p> : null}
    <label>{t("回復範圍")}<select disabled={busy} value={mode} onChange={(event) => { setMode(event.target.value as Mode); setPlan(undefined); setConfirmed(false) }}><option value="all">{t("對話與檔案")}</option><option value="conversation">{t("僅對話")}</option><option value="files">{t("僅檔案")}</option></select></label>
    <button disabled={busy || target === undefined} onClick={() => { void run(false) }}>{t("預覽回復")}</button>
    {error ? <p role="alert">{error}<button disabled={busy} onClick={() => { setError(undefined); setReload(reload + 1) }}>{t("重試")}</button></p> : null}
    {plan ? <>
      <p>{t("檔案操作：{count}", { count: plan.ops.length })}</p>
      <ul>{plan.ops.map((op) => <li key={op.path}>{op.path} · {t(op.kind === "delete-added" ? "刪除新建檔案" : "還原檔案內容")}</li>)}</ul>
      {plan.conflicts.length ? <div role="alert"><strong>{t("存在衝突；確認後仍會覆寫下列檔案。")}</strong><ul>{plan.conflicts.map((row) => <li key={row.path}>{row.path} · {row.kind}</li>)}</ul></div> : null}
      {plan.unTracked.length || plan.unseen?.length || plan.orphanedTurns?.length ? <div><p>{t("下列變更沒有完整快照，不會自動還原。")}</p><ul>{[...new Set([...plan.unTracked, ...(plan.unseen ?? []).map((row) => row.path)])].map((path) => <li key={path}>{path}</li>)}</ul></div> : null}
      <p className="muted">{t("Shell 或外部程式造成的變更可能未被記錄。")}</p>
      <label><input type="checkbox" disabled={busy} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t("我已查看影響範圍並確認回復")}</label>
      <button disabled={busy || !confirmed} onClick={() => { void run(true) }}>{t("確認回復")}</button>
    </> : null}
    {result ? <div role="status"><p>{t("已回復 {count} 個檔案", { count: result.revertedFiles })}</p>{result.errors.map((row, index) => <p role="alert" key={index}>{row.path}: {row.message}</p>)}</div> : null}
    <button disabled={busy} onClick={onClose}>{t("關閉")}</button>
  </section>
}
