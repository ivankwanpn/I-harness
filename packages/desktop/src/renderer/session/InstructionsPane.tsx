import { RefreshCw } from 'lucide-react'
import type { DesktopBridge } from '../../shared/bridge.ts'
import { Button } from '../vendor/opencode/Button.tsx'
import { useInstructionObservation } from './instruction-observation.ts'
import { useToolText } from './tool-text.ts'
import './instructions.css'

export function InstructionsPane({ bridge, workspaceId, sessionId, childSessionId }: { bridge: DesktopBridge; workspaceId: string; sessionId: string; childSessionId?: string }) {
  const { report, error, refresh } = useInstructionObservation(bridge, workspaceId, sessionId, childSessionId)
  const t = useToolText()
  const states: Record<string, string> = { ready: t('可用', 'ready'), stale: t('已過期', 'stale'), pending: t('處理中', 'pending'), unavailable: t('不可用', 'unavailable'), revoked: t('權限已撤銷', 'revoked'), loaded: t('已載入', 'loaded'), shadowed: t('已遮蔽', 'shadowed'), truncated: t('已截斷', 'truncated'), unreadable: t('無法讀取', 'unreadable'), 'outside-scope': t('超出範圍', 'outside scope') }
  return <section className="instructions-pane" aria-label={t('指令來源', 'Instruction sources')}>
    <header className="instructions-header"><h2>{t('指令來源', 'Instruction sources')}</h2><Button variant="ghost" size="small" icon={<RefreshCw size={14} />} onClick={() => { void refresh() }}>{t('重新整理', 'Refresh')}</Button></header>
    <p className="instructions-note">{t('此處顯示最近發布的上下文；發布不代表模型已讀取。', 'This shows the latest published context. Publication does not confirm that a model has read it.')}</p>
    {error ? <p role="alert">{error}</p> : null}
    {!report && !error ? <p role="status">{t('正在讀取指令來源…', 'Loading instruction sources…')}</p> : null}
    {report ? <><p role="status">{report.state === 'not-published' ? t('此會話尚未發布來源中繼資料。', 'No source metadata has been published for this session.') : `${t('狀態', 'Status')}: ${states[report.state] ?? report.state}`}</p>
      {report.effectivePolicy ? <p className="instructions-note">{t('已儲存政策', 'Saved policy')}: {report.effectivePolicy.enabled ? t('已啟用', 'enabled') : t('已停用', 'disabled')} · {report.effectivePolicy.maxBytes} {t('位元組上限', 'byte limit')}</p> : null}
      {report.publication ? <><p className="instructions-fingerprint">{t('已發布指紋', 'Published fingerprint')}: {report.publication.fingerprint} · {report.publication.bytes} {t('位元組', 'bytes')}</p>
        <ul className="instructions-sources">{report.publication.sources.map((source, index) => <li key={`${source.path}:${index}`}><strong>{source.kind}</strong><span>{states[source.state] ?? source.state}</span><code>{source.path}</code><span>{source.bytes} {t('位元組', 'bytes')}</span>{source.scopeDirectory ? <small>{t('適用範圍', 'Scope')}: {source.scopeDirectory}</small> : null}{source.hashScope === 'prefix' ? <small>{t('前綴雜湊', 'Prefix hash')}</small> : null}{source.message ? <small>{source.message}</small> : null}</li>)}</ul>
      </> : null}</> : null}
  </section>
}
