import { useEffect, useRef, useState } from 'react'
import type { ContextSubsystemRequest, ContextSubsystemState, ContextSubsystemAction } from '@i-harness/desktop-gateway/src/context-subsystems.ts'
import { useExecutionSurface } from '../session/execution-surface.ts'
import { useText } from '../design/i18n.ts'
import { SettingsGroup, SettingsRow } from '../vendor/zcode/SettingsRow.tsx'

export function ContextSubsystemSettings({ bridge, workspaceId }: { bridge: { request(request: ContextSubsystemRequest): Promise<unknown> }; workspaceId: string }) {
  const t = useText()
  const view = useExecutionSurface<ContextSubsystemState>(() => bridge.request({ kind: 'desktop/context-subsystems/state', workspaceId }), workspaceId, true)
  const [scope, setScope] = useState<'global' | 'workspace'>('workspace')
  const [draft, setDraft] = useState<ContextSubsystemState['saved']>()
  const [references, setReferences] = useState('')
  const [ignores, setIgnores] = useState('')
  const dirty = useRef(false)
  function load(state: ContextSubsystemState, selected = scope) {
    const next = selected === 'global' ? state.global ?? state.saved : state.saved
    setDraft(structuredClone(next)); setReferences(JSON.stringify(next.references, null, 2)); setIgnores(next.codeRetrieval.ignorePatterns.join('\n')); dirty.current = false
  }
  useEffect(() => { if (view.state && !dirty.current) load(view.state) }, [view.state, scope])
  function change(target: 'contextOutput' | 'codeRetrieval', key: string, value: unknown) {
    if (!draft) return
    dirty.current = true; setDraft({ ...draft, [target]: { ...draft[target], [key]: value } })
  }
  function embedding(key: string, value: unknown) {
    if (!draft) return
    change('codeRetrieval', 'embedding', { provider: 'openai-compatible', endpoint: '', model: '', ...draft.codeRetrieval.embedding, [key]: value })
  }
  async function save() {
    if (!draft) return
    await view.act(async () => {
      const refs: unknown = JSON.parse(references)
      const config = { ...draft.codeRetrieval, ignorePatterns: ignores.split('\n').filter(Boolean) }
      const state = await bridge.request({ kind: 'desktop/context-subsystems/configure', workspaceId, patch: { scope, contextOutput: draft.contextOutput, codeRetrieval: config, references: refs as ContextSubsystemState['saved']['references'] } }) as ContextSubsystemState
      dirty.current = false; view.replace(state); load(state)
      return state
    }, undefined, false)
  }
  function action(command: ContextSubsystemAction) {
    void view.act(() => bridge.request({ kind: 'desktop/context-subsystems/action', workspaceId, command }))
  }
  const number = (target: 'contextOutput' | 'codeRetrieval', key: string, label: Parameters<typeof t>[0], value: number) => <SettingsRow key={key} label={t(label)} control={<input aria-label={t(label)} type="number" min={key === 'retentionDays' ? 0 : 1} step="1" value={value} disabled={view.busy} onChange={event => change(target, key, Number(event.target.value))} />} />
  const discrepancy = view.state && (JSON.stringify(view.state.saved.contextOutput) !== JSON.stringify(view.state.context.config) || JSON.stringify(view.state.saved.codeRetrieval) !== JSON.stringify(view.state.code.config))
  return <section aria-label={t('上下文與檢索')}>
    <SettingsGroup><SettingsRow label={t('設定範圍')} control={<select aria-label={t('設定範圍')} value={scope} disabled={view.busy} onChange={event => { const next = event.target.value as typeof scope; setScope(next); if (view.state) load(view.state, next) }}><option value="workspace">{t('此工作區')}</option><option value="global">{t('全域預設')}</option></select>} />
      <p role="status">{t('有效範圍')}：{t(view.state?.source === 'workspace' ? '此工作區' : '全域預設')}</p>
      {scope === 'workspace' ? <button disabled={!view.state || view.busy} onClick={() => { void view.act(() => bridge.request({ kind: 'desktop/context-subsystems/configure', workspaceId, patch: { scope: 'workspace', resetOverride: true } }), () => { dirty.current = false }) }}>{t('重設工作區覆寫')}</button> : null}
    </SettingsGroup>
    <h2>Context Mode</h2><p className="muted">{t('設計參考 context-mode')}</p>
    <p className="muted">{t('大型工具輸出保存在本機工作區資料庫，會話透過引用讀取。停用會等待工作完成；清除會刪除保留資料。')}</p>
    {draft ? <SettingsGroup>
      <SettingsRow label={t('啟用 Context Mode')} control={<input type="checkbox" aria-label={t('啟用 Context Mode')} checked={draft.contextOutput.enabled} disabled={view.busy} onChange={event => change('contextOutput', 'enabled', event.target.checked)} />} />
      {number('contextOutput', 'maxPreviewBytes', '預覽上限（bytes）', draft.contextOutput.maxPreviewBytes)}
      {number('contextOutput', 'maxCaptureBytes', '單次保存上限（bytes）', draft.contextOutput.maxCaptureBytes)}
      {number('contextOutput', 'maxReadBytes', '讀取上限（bytes）', draft.contextOutput.maxReadBytes)}
      {number('contextOutput', 'maxSearchBytes', '輸出搜尋上限（bytes）', draft.contextOutput.maxSearchBytes)}
      {number('contextOutput', 'maxDiskBytes', '輸出儲存上限（bytes）', draft.contextOutput.maxDiskBytes)}
      {number('contextOutput', 'retentionDays', '保留天數', draft.contextOutput.retentionDays)}
      <p role="status">{t('有效狀態')}：{view.state?.context.state} · {t('已載入統計')}：{view.state?.context.results} {t('結果')} / {view.state?.context.retainedBytes} bytes · {t('執行中工作')}：{view.state?.context.activeJobs}</p>
      <button disabled={view.busy} onClick={() => action({ target: 'context', action: 'clear' })}>{t('清除輸出資料')}</button>
    </SettingsGroup> : null}
    <h2>Code Context</h2><p className="muted">{t('設計參考 claude-context')}</p>
    <p className="muted">{t('索引儲存在本機。詞彙搜尋無需 embedding；混合搜尋會把選取的程式碼傳送到指定提供商。憑證只保存引用。')}</p>
    {draft ? <SettingsGroup>
      <SettingsRow label={t('啟用 Code Context')} control={<input type="checkbox" aria-label={t('啟用 Code Context')} checked={draft.codeRetrieval.enabled} disabled={view.busy} onChange={event => change('codeRetrieval', 'enabled', event.target.checked)} />} />
      <SettingsRow label={t('檢索模式')} control={<select aria-label={t('檢索模式')} value={draft.codeRetrieval.mode} disabled={view.busy} onChange={event => change('codeRetrieval', 'mode', event.target.value)}><option value="lexical">{t('詞彙搜尋')}</option><option value="hybrid">{t('混合搜尋')}</option></select>} />
      <SettingsRow label={t('自動更新索引')} control={<input type="checkbox" aria-label={t('自動更新索引')} checked={draft.codeRetrieval.autoRefresh} disabled={view.busy} onChange={event => change('codeRetrieval', 'autoRefresh', event.target.checked)} />} />
      {draft.codeRetrieval.mode === 'hybrid' ? <>
        <SettingsRow label={t('Embedding 提供商')} control={<select aria-label={t('Embedding 提供商')} disabled={view.busy} value={draft.codeRetrieval.embedding?.provider ?? 'openai-compatible'} onChange={event => embedding('provider', event.target.value)}><option value="openai-compatible">OpenAI compatible</option><option value="ollama">Ollama</option></select>} />
        {(['endpoint', 'model', 'credentialRef'] as const).map((key, i) => { const label = (['Embedding 端點', 'Embedding 模型', '憑證引用'] as const)[i]!; return <SettingsRow key={key} label={t(label)} control={<input aria-label={t(label)} value={draft.codeRetrieval.embedding?.[key] ?? ''} disabled={view.busy} onChange={event => embedding(key, key === 'credentialRef' && !event.target.value ? undefined : event.target.value)} />} /> })}
      </> : null}
      {number('codeRetrieval', 'maxFiles', '檔案數量上限', draft.codeRetrieval.maxFiles)}
      {number('codeRetrieval', 'maxFileBytes', '單一檔案上限（bytes）', draft.codeRetrieval.maxFileBytes)}
      {number('codeRetrieval', 'maxInputBytes', '索引輸入上限（bytes）', draft.codeRetrieval.maxInputBytes)}
      {number('codeRetrieval', 'maxChunks', '片段數量上限', draft.codeRetrieval.maxChunks)}
      {number('codeRetrieval', 'maxDiskBytes', '索引儲存上限（bytes）', draft.codeRetrieval.maxDiskBytes)}
      {number('codeRetrieval', 'maxSearchBytes', '程式碼搜尋上限（bytes）', draft.codeRetrieval.maxSearchBytes)}
      {number('codeRetrieval', 'deadlineMs', '索引期限（ms）', draft.codeRetrieval.deadlineMs)}
      <SettingsRow label={t('忽略模式')} description={t('每行一個，最多 16 個，每個最多 512 字元。')} control={<textarea aria-label={t('忽略模式')} value={ignores} disabled={view.busy} onChange={event => { dirty.current = true; setIgnores(event.target.value) }} />} />
      <p role="status">{t('有效狀態')}：{view.state?.code.state} · {t('已載入統計')}：{view.state?.code.files} {t('檔案')} / {view.state?.code.chunks} {t('片段')} / {view.state?.code.storedBytes} bytes · {t('索引版本')}：{view.state?.code.generation}</p>
      {view.state?.code.progress ? <p role="status">{t('索引進度')}：{view.state.code.progress.files} {t('檔案')} / {view.state.code.progress.bytes} bytes</p> : null}
      {view.state?.code.lastJob ? <p>{t('最近索引工作')}：{view.state.code.lastJob.outcome} {view.state.code.lastJob.reason}</p> : null}
      {view.state?.code.partial ? <p role="status">{t('索引不完整')}：{view.state.code.reasons.join(' · ')}</p> : null}
      {view.state?.code.metrics ? <p>{t('Embedding 請求')}：{view.state.code.metrics.embeddingRequests} · {t('快取命中')}：{view.state.code.metrics.embeddingCacheHits} · {t('已回報輸入 tokens')}：{view.state.code.metrics.reportedInputTokens} · {t('未回報用量請求')}：{view.state.code.metrics.unreportedRequests}</p> : null}
      <button disabled={view.busy || !view.state?.code.enabled} onClick={() => action({ target: 'code', action: 'update' })}>{t('更新索引')}</button>
      <button disabled={view.busy || !view.state?.code.enabled} onClick={() => action({ target: 'code', action: 'rebuild' })}>{t('重建索引')}</button>
      <button disabled={view.busy || !view.state?.code.activeJobs} onClick={() => action({ target: 'code', action: 'cancel' })}>{t('取消索引')}</button>
      <button disabled={view.busy} onClick={() => action({ target: 'code', action: 'clear' })}>{t('清除索引')}</button>
    </SettingsGroup> : null}
    <h2>{t('唯讀參考資料夾')}</h2><p className="muted">{t('明確加入絕對路徑。參考資料夾只供讀取；索引和輸出寫入本機工作區儲存。')}</p>
    <SettingsGroup><SettingsRow label={t('參考資料夾清單')} description={t('JSON 陣列，每項包含 id、path 和 label。')} control={<textarea aria-label={t('參考資料夾清單')} value={references} disabled={!draft || view.busy} onChange={event => { dirty.current = true; setReferences(event.target.value) }} />} /></SettingsGroup>
    {discrepancy ? <p role="status">{t('已儲存設定與有效設定不同，請重新整理或再次儲存以重試。')}</p> : null}
    {view.error || view.state?.applicationError || view.state?.context.error || view.state?.code.error ? <p role="alert" className="error-text">{view.error ?? view.state?.applicationError ?? view.state?.context.error ?? view.state?.code.error}</p> : null}
    <button disabled={!draft || view.busy} onClick={() => { void save() }}>{t('儲存')}</button>
    <button disabled={view.busy} onClick={() => { dirty.current = false; void view.refresh() }}>{t('重新整理')}</button>
  </section>
}
