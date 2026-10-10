import { useEffect, useRef, useState } from "react";
import type { AgentDefaults, AgentSettingsState, WslSettingsState } from "@i-harness/desktop-gateway";
import type { DesktopBridge } from "../../shared/bridge.ts";
import { useText } from "../design/i18n.ts";
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx";
import { ApprovalRuleManager } from "./ApprovalRuleManager.tsx";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const defaultWsl = { distribution: "Ubuntu", networkAccess: false, workspaceDependencies: true };
const webLabels = { disabled: "停用", cached: "快取", indexed: "已索引", live: "即時" } as const;
const webDescriptions = {
    disabled: "不允許網頁抓取或搜尋。",
    cached: "只讀取本機已保存的網頁與搜尋結果；快取未命中時不連線。",
    indexed: "只有已設定的搜尋提供者或索引所收錄的網址可以抓取；未設定提供者時不提供搜尋工具。",
    live: "允許直接抓取網頁；搜尋仍使用你已設定的提供者。",
} as const;
const backendLabels = { legacy: "Windows ACL", psec: "PSEC（實驗性）", wsl: "WSL2 Linux" } as const;
function SessionExecutionStatus({ value }: { value: unknown }) {
    const t = useText();
    const status = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const backend = status.windowsSandboxBackend ?? status.backend;
    const label = typeof backend === "string" && backend in backendLabels ? t(backendLabels[backend as keyof typeof backendLabels]) : t("未回報");
    const wsl = status.wslExecution && typeof status.wslExecution === "object" ? status.wslExecution as Record<string, unknown> : undefined;
    return <div>
      <p>{t("執行後端")}：{label}{wsl && typeof wsl.distribution === "string" ? ` (${wsl.distribution})` : ""}</p>
      <p>{t("有效狀態")}：{t(status.availability === "available" ? "可用" : status.availability === "unavailable" ? "執行環境不可用" : "未回報")}</p>
      {typeof status.detail === "string" ? <p>{status.detail}</p> : null}
      {wsl ? <><p>{t("命令網路存取")}：{t(wsl.networkAccess === true ? "已啟用" : "唯讀與工作區寫入關閉；完整存取允許")}</p><p>{t("工作區依賴")}：{t(wsl.workspaceDependencies === true ? "已啟用" : "已停用")}</p></> : null}
    </div>;
}
export function AgentSettings({ bridge, workspaceId, onSandboxChange, onExecutionBindingSaved }: {
    bridge: DesktopBridge;
    workspaceId: string;
    onSandboxChange?(mode: AgentDefaults["sandboxMode"]): void;
    onExecutionBindingSaved?(): void;
}) {
    const t = useText();
    const [state, setState] = useState<AgentSettingsState>(), [draft, setDraft] = useState<AgentDefaults>();
    const [wsl, setWsl] = useState<WslSettingsState>(), [error, setError] = useState<string>(), [wslError, setWslError] = useState<string>();
    const [busy, setBusy] = useState(false), [wslBusy, setWslBusy] = useState(false), [reload, setReload] = useState(0);
    const lock = useRef(false), version = useRef(0);
    useEffect(() => {
        const current = ++version.current;
        lock.current = false;
        setBusy(false);
        setError(undefined);
        setState(undefined);
        setDraft(undefined);
        setWsl(undefined);
        void bridge.request({ kind: "desktop/agent-settings/state", workspaceId }).then(value => { if (current === version.current) {
            const next = value as AgentSettingsState;
            setState(next);
            setDraft(next.saved);
        } }).catch(reason => { if (current === version.current)
            setError(String(reason)); });
        return () => { version.current++; };
    }, [bridge, workspaceId, reload]);
    const isWsl = draft?.windowsSandboxBackend === "wsl";
    useEffect(() => {
        if (!isWsl)
            return;
        let active = true;
        setWslError(undefined);
        setWslBusy(true);
        void bridge.request({ kind: "desktop/wsl/state", workspaceId }).then(value => { if (active)
            setWsl(value as WslSettingsState); }).catch(reason => { if (active)
            setWslError(String(reason)); }).finally(() => { if (active)
            setWslBusy(false); });
        return () => { active = false; };
    }, [bridge, workspaceId, isWsl, reload, state?.saved.wslExecution?.distribution, state?.saved.wslExecution?.networkAccess, state?.saved.wslExecution?.workspaceDependencies]);
    const labels = { "read-only": "唯讀", "workspace-write": "可寫入工作區", "danger-full-access": "完整存取" } as const;
    const approvalLabels = { dangerous: "僅危險操作詢問", "ask-all": "逐項詢問", delegate: "代我審批", "full-access": "完整存取權" } as const;
    const changed = state && draft && !same(state.saved, draft), configuration = draft?.wslExecution ?? defaultWsl;
    const wslChanged = !same(configuration, state?.saved.wslExecution ?? defaultWsl) || draft?.windowsSandboxBackend !== state?.saved.windowsSandboxBackend;
    async function wslAction(action: "diagnose" | "repair") {
        if (wslBusy || wslChanged)
            return;
        const current = version.current;
        setWslBusy(true);
        setWslError(undefined);
        try {
            const value = await bridge.request({ kind: action === "diagnose" ? "desktop/wsl/diagnose" : "desktop/wsl/repair", workspaceId });
            if (current === version.current)
                setWsl(value as WslSettingsState);
        }
        catch (reason) {
            if (current === version.current)
                setWslError(String(reason));
        }
        finally {
            if (current === version.current)
                setWslBusy(false);
        }
    }
    return <section aria-label={t("執行與上下文")}>
  <p className="settings-description">{t("後端、WSL 與網頁設定會由新組裝的會話擷取；既有組裝與執行中的命令保留原設定。沙箱與核準模式套用到下一次工具呼叫，自動壓縮套用到下一個步驟。")}</p>
  {error ? <p role="alert" className="error-text">{error}<button disabled={busy} onClick={() => setReload(value => value + 1)}>{t("重試")}</button></p> : null}
  {!state || !draft ? !error ? <p role="status">{t("正在讀取…")}</p> : null : <form onSubmit={event => {
                event.preventDefault();
                if (lock.current || !changed)
                    return;
                const current = version.current, patch: Partial<AgentDefaults> = {};
                for (const key of ["windowsSandboxBackend", "wslExecution", "webSearchMode", "sandboxMode", "autoCompaction", "approvalMode"] as const)
                    if (!same(draft[key], state.saved[key]))
                        Object.assign(patch, { [key]: draft[key] });
                lock.current = true;
                setBusy(true);
                setError(undefined);
                void bridge.request({ kind: "desktop/agent-settings/configure", workspaceId, patch }).then(value => { if (current !== version.current)
                    return; const next = value as AgentSettingsState; setState(next); setDraft(next.saved); if (!same(next.saved.windowsSandboxBackend, state.saved.windowsSandboxBackend) || !same(next.saved.wslExecution, state.saved.wslExecution))
                    onExecutionBindingSaved?.(); if (next.effective.sandboxMode !== state.effective.sandboxMode)
                    onSandboxChange?.(next.effective.sandboxMode); }).catch(reason => { if (current === version.current)
                    setError(String(reason)); }).finally(() => { if (current === version.current) {
                    lock.current = false;
                    setBusy(false);
                } });
            }}>
   <h2>{t("權限與核準")}</h2><SettingsGroup>
    <SettingsRow label={t("核準模式")} description={t("危險模式只詢問高風險或無法判定的操作；代審使用模型檢查每項工具請求，仍可能交由你決定。完整存取權會一併設定完整存取沙箱。")} control={<select aria-label={t("核準模式")} disabled={busy} value={draft.approvalMode} onChange={event => { const approvalMode = event.target.value as AgentDefaults["approvalMode"]; setDraft({ ...draft, approvalMode, ...(approvalMode === "full-access" ? { sandboxMode: "danger-full-access" as const } : {}) }); }}>{Object.entries(approvalLabels).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select>}/>
    <SettingsRow label={t("沙箱")} description={t("唯讀允許檢視檔案；工作區寫入只允許指定範圍；完整存取允許工作區外寫入。有唯讀參考鎖時，完整存取會拒絕執行。")} control={<select aria-label={t("沙箱")} disabled={busy} value={draft.sandboxMode} onChange={event => { const sandboxMode = event.target.value as AgentDefaults["sandboxMode"]; setDraft({ ...draft, sandboxMode, approvalMode: draft.approvalMode === "full-access" && sandboxMode !== "danger-full-access" ? "dangerous" : draft.approvalMode }); }}>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select>}/>
    <SettingsRow label={t("Windows 執行後端")} description={t("由新組裝的會話採用。PSEC 是實驗性後端；WSL2 使用所選 Linux 發行版。無法執行時會回報原因。")} control={<select aria-label={t("Windows 執行後端")} disabled={busy} value={draft.windowsSandboxBackend ?? "legacy"} onChange={event => setDraft({ ...draft, windowsSandboxBackend: event.target.value as AgentDefaults["windowsSandboxBackend"] })}>{Object.entries(backendLabels).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select>}/>
   </SettingsGroup>
   <h2>{t("網頁存取")}</h2><SettingsGroup><SettingsRow label={t("網頁存取")} description={t("控制網頁抓取與搜尋，與命令的網路權限分開設定。")} control={<select aria-label={t("網頁存取")} disabled={busy} value={draft.webSearchMode ?? "live"} onChange={event => setDraft({ ...draft, webSearchMode: event.target.value as AgentDefaults["webSearchMode"] })}>{Object.entries(webLabels).map(([id, label]) => <option key={id} value={id}>{t(label)} — {t(webDescriptions[id as keyof typeof webDescriptions])}</option>)}</select>} detail={<p>{t(webDescriptions[draft.webSearchMode ?? "live"])}</p>}/></SettingsGroup>
   {isWsl ? <><h2>{t("WSL 執行環境")}</h2><SettingsGroup>
    <SettingsRow label={t("WSL 發行版")} description={t("選擇已安裝的 WSL2 發行版；發行版變更由新組裝的會話採用。")} control={<select aria-label={t("WSL 發行版")} disabled={busy || wslBusy} value={configuration.distribution} onChange={event => setDraft({ ...draft, wslExecution: { ...configuration, distribution: event.target.value } })}>
      {!wsl?.distributions?.some(row => row.name === configuration.distribution) ? <option value={configuration.distribution}>{configuration.distribution}（尚未確認安裝）</option> : null}
      {wsl?.distributions?.map(row => <option key={row.name} value={row.name} disabled={row.version !== 2}>{row.name} — WSL{row.version} ({row.state})</option>)}
     </select>}/>
    <SettingsRow label={t("命令網路存取")} description={t("唯讀與工作區寫入預設關閉命令連線；開啟後允許 WSL 命令使用網路。完整存取模式允許命令連線。網頁工具仍依網頁存取設定。")} control={<input type="checkbox" aria-label={t("命令網路存取")} disabled={busy} checked={configuration.networkAccess} onChange={event => setDraft({ ...draft, wslExecution: { ...configuration, networkAccess: event.target.checked } })}/>}/>
    <SettingsRow label={t("工作區依賴")} description={t("允許使用或明確修復 IH 管理的 Linux Node/npm。系統 Python、Bash 與 bubblewrap 的缺失由診斷提供原因與處理指引。")} control={<input type="checkbox" aria-label={t("工作區依賴")} disabled={busy} checked={configuration.workspaceDependencies} onChange={event => setDraft({ ...draft, wslExecution: { ...configuration, workspaceDependencies: event.target.checked } })}/>}/>
    <SettingsRow label={t("環境診斷")} description={t("檢查已儲存的發行版與依賴；修復只處理 IH 管理的工作區依賴。")} control={<><button type="button" disabled={busy || wslBusy || wslChanged || !wsl?.capabilities.diagnose} onClick={() => void wslAction("diagnose")}>{t("診斷 WSL")}</button><button type="button" disabled={busy || wslBusy || wslChanged || !configuration.workspaceDependencies || !wsl?.capabilities.repair} onClick={() => void wslAction("repair")}>{t("修復工作區依賴")}</button></>} detail={<>{wslChanged ? <p>{t("先儲存 WSL 設定，再診斷或修復所選環境。")}</p> : null}{wslBusy ? <p role="status">{t("正在檢查 WSL…")}</p> : null}{wslError ? <p role="alert">{wslError}</p> : null}
      {wsl?.runtime ? <><p role="status">{wsl.runtime.distribution}：{t(wsl.runtime.available ? "執行環境可用" : "執行環境不可用")} — {wsl.runtime.detail}</p><ul>{Object.entries(wsl.runtime.dependencies).map(([name, result]) => <li key={name}>{name}：{t(result.available ? "可用" : "缺少或不可用")}{result.detail ? ` — ${result.detail}` : ""}</li>)}</ul>{wsl.runtime.paths.map(row => <p key={row.windows}>{row.windows} → {row.linux}</p>)}</> : <p>{t("尚未診斷執行環境。")}</p>}
      {wsl?.managedDependencies ? <p role="status">{wsl.managedDependencies.status} — {wsl.managedDependencies.detail}</p> : !wsl?.capabilities.repair ? <p>{t("目前未提供工作區依賴修復。")}</p> : null}</>}/>
   </SettingsGroup></> : null}
   <h2>{t("上下文")}</h2><SettingsGroup><SettingsRow label={t("自動壓縮上下文")} description={t("依模型的上下文大小自動整理內容；關閉後仍可手動壓縮。")} control={<input type="checkbox" aria-label={t("自動壓縮上下文")} disabled={busy} checked={draft.autoCompaction} onChange={event => setDraft({ ...draft, autoCompaction: event.target.checked })}/>}/></SettingsGroup>
   <div className="settings-save-bar"><button type="submit" className="primary-button" disabled={busy || !changed}>{t(busy ? "儲存中…" : "儲存")}</button>{changed ? <button type="button" disabled={busy} onClick={() => setDraft(state.saved)}>{t("取消")}</button> : null}</div>
   {state.restartRequired ? <p role="status" className="notice">{t("部分已儲存設定尚未由執行環境採用；目前顯示的有效設定仍適用。可重新讀取以重試。")}</p> : null}
   <h2>{t("新組裝採用的設定")}</h2><p>{t("執行後端")}：{t(backendLabels[state.effective.windowsSandboxBackend ?? "legacy"])}{state.effective.windowsSandboxBackend === "wsl" ? ` (${state.effective.wslExecution?.distribution ?? "Ubuntu"})` : ""}。{t("既有組裝保留已擷取的後端、WSL 與網頁設定。")}</p>
   <SettingsGroup><SettingsRow label={t("沙箱")} control={<span>{t(labels[state.effective.sandboxMode])}</span>}/><SettingsRow label={t("核準模式")} control={<span>{t(approvalLabels[state.effective.approvalMode])}</span>}/><SettingsRow label={t("網頁存取")} control={<span>{state.effective.webSearchMode ? t(webLabels[state.effective.webSearchMode]) : t("未回報")}</span>}/><SettingsRow label={t("自動壓縮上下文")} control={<span>{t(state.effective.autoCompaction ? "已啟用" : "已停用")}</span>}/></SettingsGroup>
   <h2>{t("會話的實際執行環境")}</h2>{state.executions?.length ? state.executions.map(row => <details key={row.sessionId}><summary>{row.sessionId}</summary><SessionExecutionStatus value={row.status}/></details>) : <p>{t("目前沒有已選定執行後端的會話組裝。")}</p>}
  </form>}
  <ApprovalRuleManager key={workspaceId} bridge={bridge} workspaceId={workspaceId}/>
 </section>;
}
