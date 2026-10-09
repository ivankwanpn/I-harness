import { useEffect, useState } from 'react'
import type { ContextSubsystemConfigure, ContextSubsystemRequest, ContextSubsystemState } from '@i-harness/desktop-gateway/src/context-subsystems.ts'
import { useExecutionSurface } from '../session/execution-surface.ts'
import { useText } from '../design/i18n.ts'
import { SettingsGroup, SettingsRow } from '../vendor/zcode/SettingsRow.tsx'
import { Button } from '../vendor/opencode/Button.tsx'

export interface ContextSubsystemSettingsProps {
  bridge: { request(request: ContextSubsystemRequest): Promise<unknown> }
  workspaceId: string
  active?: boolean
}
type ToggleAttempt = { target: 'contextOutput' | 'codeRetrieval'; enabled: boolean }
type ToggleFailure = { attempt?: ToggleAttempt; message: string }

/** Execution settings: two workspace toggles, with explicit request ownership. */
export function ContextSubsystemSettings({ bridge, workspaceId, active = true }: ContextSubsystemSettingsProps) {
  const t = useText()
  // The response workspaceId is a durable gateway actor, not the catalog ID.
  const view = useExecutionSurface<ContextSubsystemState>(() => bridge.request({ kind: 'desktop/context-subsystems/state', workspaceId }), workspaceId, true, active)
  const [pending, setPending] = useState<ToggleAttempt>()
  const [failure, setFailure] = useState<ToggleFailure>()
  const [saved, setSaved] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const blocked = view.busy || refreshing

  useEffect(() => { setPending(undefined); setFailure(undefined); setSaved(false); setRefreshing(false) }, [workspaceId])

  function applicationError(state?: ContextSubsystemState) {
    if (!state) return undefined
    const discrepancy = state.saved.contextOutput.enabled !== state.context.enabled || state.saved.codeRetrieval.enabled !== state.code.enabled ||
      JSON.stringify(state.saved.contextOutput) !== JSON.stringify(state.context.config) || JSON.stringify(state.saved.codeRetrieval) !== JSON.stringify(state.code.config)
    return state.applicationError ?? state.context.error ?? state.code.error ?? (discrepancy ? t('已儲存設定與有效設定不同，請重新整理或再次儲存以重試。') : undefined)
  }
  async function configure(patch: ContextSubsystemConfigure, attempt?: ToggleAttempt) {
    if (blocked || !view.state) return
    const generation = view.generation.current
    let requestError: string | undefined
    setPending(attempt); setFailure(undefined); setSaved(false)
    const success = await view.act(async () => {
      try { return await bridge.request({ kind: 'desktop/context-subsystems/configure', workspaceId, patch }) }
      catch (reason) { requestError = reason instanceof Error ? reason.message : String(reason); throw reason }
    }, value => {
      const state = value as ContextSubsystemState
      view.replace(state)
      const problem = applicationError(state) ?? (attempt && state.saved[attempt.target].enabled !== attempt.enabled ? t('已儲存設定與有效設定不同，請重新整理或再次儲存以重試。') : undefined)
      setSaved(!problem)
      setFailure(problem ? { attempt, message: problem } : undefined)
    }, false)
    if (generation !== view.generation.current) return
    setPending(undefined)
    if (!success) setFailure({ attempt, message: requestError ?? t('重新讀取失敗，請重試後再操作。') })
  }
  function toggle(attempt: ToggleAttempt) {
    void configure({ scope: 'workspace', [attempt.target]: { enabled: attempt.enabled } }, attempt)
  }
  async function refresh() {
    const generation = view.generation.current
    setRefreshing(true)
    await view.refresh()
    if (generation === view.generation.current) setRefreshing(false)
  }
  function retry() {
    if (blocked) return
    const attempt = failure?.attempt
    if (attempt && view.state?.saved[attempt.target].enabled !== attempt.enabled) toggle(attempt)
    else if (view.state && (failure || applicationError(view.state))) void configure({ scope: view.state.source })
    else void refresh()
  }
  const error = failure?.message ?? view.error ?? applicationError(view.state)
  const checked = (target: ToggleAttempt['target']) => pending?.target === target ? pending.enabled : view.state?.saved[target].enabled ?? false

  return <section className="ih-control-scope context-switches" aria-label={t('上下文')} aria-busy={blocked || (!view.state && !view.error) || undefined}>
    <SettingsGroup>
      <SettingsRow label="Context Mode" description={`${t('保存較長的工具輸出，按需取回內容。')} ${t('設計參考 context-mode')}`} control={<input type="checkbox" aria-label={t('啟用 Context Mode')} checked={checked('contextOutput')} disabled={!view.state || blocked} onChange={event => toggle({ target: 'contextOutput', enabled: event.target.checked })} />} />
      <SettingsRow label="Code Context" description={`${t('按需搜尋工作區程式碼中的相關片段。')} ${t('設計參考 claude-context')}`} control={<input type="checkbox" aria-label={t('啟用 Code Context')} checked={checked('codeRetrieval')} disabled={!view.state || blocked} onChange={event => toggle({ target: 'codeRetrieval', enabled: event.target.checked })} />} />
    </SettingsGroup>
    {error ? <div className="settings-preference-actions"><p className="error-text" role="alert">{error}</p><Button size="small" disabled={blocked} loading={blocked} loadingLabel={t('正在處理…')} onClick={retry}>{t('重試')}</Button></div> : blocked || !view.state ? <p className="muted" role="status">{t('正在處理…')}</p> : saved ? <p className="muted" role="status">{t('設定已儲存')}</p> : null}
  </section>
}
