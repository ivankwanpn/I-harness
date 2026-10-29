import { useEffect, useRef, useState } from 'react'
import type { DesktopBridge } from '../../shared/bridge.ts'
import { Button } from '../vendor/opencode/Button.tsx'
import { useToolText } from '../session/tool-text.ts'
import './instruction-settings.css'
type Saved = { enabled: boolean; maxBytes: number; globalSources?: string[] }
export function InstructionSettings({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useToolText()
  const [saved, setSaved] = useState<Saved>(), [draft, setDraft] = useState<Saved>(), [paths, setPaths] = useState(''), [overrideGlobals, setOverrideGlobals] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const generation = useRef(0)
  useEffect(() => { let active = true; generation.current++; setSaved(undefined); setDraft(undefined); setError(undefined); setBusy(false)
    void bridge.request({ kind: 'desktop/instructions/settings', workspaceId }).then(value => { if (!active) return; const initial = (value as { saved: Saved }).saved; setSaved(initial); setDraft(initial); setPaths((initial.globalSources ?? []).join('\n')); setOverrideGlobals(initial.globalSources !== undefined) }, reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false; generation.current++ }
  }, [bridge, workspaceId])
  const dirty = !!saved && !!draft && (saved.enabled !== draft.enabled || saved.maxBytes !== draft.maxBytes || overrideGlobals !== (saved.globalSources !== undefined) || paths !== (saved.globalSources ?? []).join('\n'))
  const save = async () => { if (!draft || busy) return; const ticket = generation.current; setBusy(true); setError(undefined)
    try { const next = (await bridge.request({ kind: 'desktop/instructions/configure', workspaceId, patch: { enabled: draft.enabled, maxBytes: draft.maxBytes, ...(overrideGlobals ? { globalSources: paths.split('\n').map(value => value.trim()).filter(Boolean) } : {}) } }) as { saved: Saved }).saved; if (ticket !== generation.current) return; setSaved(next); setDraft(next); setPaths((next.globalSources ?? []).join('\n')); setOverrideGlobals(next.globalSources !== undefined) }
    catch (reason) { if (ticket === generation.current) setError(reason instanceof Error ? reason.message : String(reason)) } finally { if (ticket === generation.current) setBusy(false) }
  }
  return <section className="instruction-settings" aria-label={t('指令設定', 'Instruction settings')}><h2>{t('指令設定', 'Instruction settings')}</h2><p>{t('觀測到已儲存政策後才會套用變更；已發布的上下文在重新整理前可能已過期。', 'Changes apply after the saved policy is observed. Existing published context may remain stale until refreshed.')}</p>
    {error ? <p role="alert">{error}</p> : null}{draft ? <><label><input type="checkbox" disabled={busy} checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /> {t('啟用指令來源', 'Enable instruction sources')}</label>
      <label>{t('位元組上限', 'Maximum bytes')} <input type="number" min="0" disabled={busy} value={draft.maxBytes} onChange={event => setDraft({ ...draft, maxBytes: Number(event.target.value) })} /></label>
      <label><input type="checkbox" checked={overrideGlobals} disabled={busy || saved?.globalSources !== undefined} onChange={event => setOverrideGlobals(event.target.checked)} /> {t('指定全域來源路徑', 'Specify global source paths')}</label>
      {saved?.globalSources !== undefined ? <p>{t('已儲存的清單可編輯；空白清單表示不使用全域來源。', 'Edit the saved list; an empty list disables global sources.')}</p> : null}
      {overrideGlobals ? <label>{t('全域來源路徑，每行一個', 'Global source paths, one per line')} <textarea disabled={busy} value={paths} onChange={event => setPaths(event.target.value)} /></label> : <p>{t('使用預設全域來源路徑。', 'Default global source paths are used.')}</p>}
      <Button disabled={!dirty || busy} onClick={() => { void save() }}>{t('儲存', 'Save')}</Button></> : null}
  </section>
}
