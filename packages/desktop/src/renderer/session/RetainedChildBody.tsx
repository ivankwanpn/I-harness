import { useEffect, useRef, useState } from 'react'
import type { DesktopBridge } from '../../shared/bridge.ts'
import type { DesktopSubagentRow } from '@i-harness/desktop-gateway/src/session-subagents.ts'
import type { DesktopSubagentResultPage as TaskResultPage } from "@i-harness/desktop-gateway/src/session-subagents.ts"
import { useText } from '../design/i18n.ts'

/** Displays each exact encoded page separately. A partial JSON body is never
 * substituted for the ordinary resultText/error preview or parsed as one. */
export function RetainedChildBody({ bridge, workspaceId, request }: { bridge: DesktopBridge; workspaceId: string; request: NonNullable<DesktopSubagentRow['fullResult']> }) {
  const t = useText(), active = useRef(true), ticket = useRef(0)
  const [page, setPage] = useState<TaskResultPage>(), [error, setError] = useState<string>(), [busy, setBusy] = useState(false)
  useEffect(() => { active.current = true; return () => { active.current = false; ticket.current++ } }, [])
  async function read(offset: number) {
    const serial = ++ticket.current
    setBusy(true); setError(undefined)
    try {
      const result = await bridge.request({ kind: 'desktop/session/subagents/result', workspaceId, sessionId: request.sessionId, childSessionId: request.childSessionId,
        resultRevision: request.resultRevision, refId: request.refId, refRevision: request.refRevision, offset, maxBytes: 16384 }) as TaskResultPage
      if (!active.current || serial !== ticket.current) return
      if (!result || result.codec !== 'json-utf8-v1' || result.data?.kind !== 'text' || typeof result.data.text !== 'string'
        || result.resultRevision !== request.resultRevision || result.ref.id !== request.refId || result.ref.revision !== request.refRevision
        || result.offset !== offset || typeof result.eof !== 'boolean' || (result.eof ? result.nextOffset !== null : !Number.isSafeInteger(result.nextOffset) || result.nextOffset! <= offset)
        || new TextEncoder().encode(JSON.stringify(result)).length > 16384) throw new Error('Invalid retained child result page')
      setPage(result)
    } catch (reason) { if (active.current && serial === ticket.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (active.current && serial === ticket.current) setBusy(false) }
  }
  return <section className="subagent-final-result">
    <button type="button" disabled={busy} onClick={() => { void read(page && !page.eof ? page.nextOffset! : 0) }}>{page && !page.eof ? t('下一頁') : t('讀取完整結果')}</button>
    {error ? <p role="alert">{error}</p> : null}
    {page ? <><p>{t('JSON 編碼片段')} · {page.offset}–{page.nextOffset ?? page.ref.encodedBytes} / {page.ref.encodedBytes}</p><pre>{page.data.text}</pre></> : null}
  </section>
}
