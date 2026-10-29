import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopBridge } from '../../shared/bridge.ts'
import type { InstructionReport } from '@i-harness/desktop-gateway/src/instructions/views.ts'
type Snapshot = { subscriptionId?: string; scope: { sessionId: string; childSessionId?: string }; cursor: { epoch: string; revision: number }; report: InstructionReport }
type Change = { subscriptionId: string; scope: Snapshot['scope']; cursor: Snapshot['cursor']; reason: 'changed' | 'revoked' }
export function useInstructionObservation(bridge: DesktopBridge, workspaceId: string, sessionId: string, childSessionId?: string) {
  const [report, setReport] = useState<InstructionReport>(), [error, setError] = useState<string>()
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const state = useRef<{ active: boolean; disconnected?: boolean; id?: string; cursor?: Snapshot['cursor']; busy: boolean; dirty: boolean }>({ active: false, busy: false, dirty: false })
  const refresh = useCallback(async (manual = false) => {
    const owner = state.current; if (!owner.active) return
    if (owner.busy) { owner.dirty = true; return }
    owner.busy = true
    try {
      const snapshot = await bridge.request({ kind: manual ? 'desktop/instructions/refresh' : 'desktop/instructions/state', workspaceId, sessionId, ...(childSessionId ? { childSessionId } : {}) }) as Snapshot
      if (!owner.active || state.current !== owner) return
      if (owner.cursor && (snapshot.cursor.epoch !== owner.cursor.epoch || snapshot.cursor.revision < owner.cursor.revision)) return
      owner.cursor = snapshot.cursor; setReport(snapshot.report); setError(undefined)
    } catch (reason) { if (owner.active && state.current === owner) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { owner.busy = false; if (owner.active && owner.dirty) { owner.dirty = false; void refresh() } }
  }, [bridge, workspaceId, sessionId, childSessionId])
  useEffect(() => {
    const owner = { active: true, busy: false, dirty: false } as typeof state.current; state.current = owner; setReport(undefined); setError(undefined)
    const buffered: Change[] = []; let overflow = false
    const receive = (change: Change) => {
      if (!owner.active || !change || typeof change !== 'object' || change.scope?.sessionId !== sessionId || change.scope?.childSessionId !== childSessionId) return
      if (!owner.id) { if (buffered.length < 32) buffered.push(change); else overflow = true; return }
      if (change.subscriptionId !== owner.id || !change.cursor || (owner.cursor && (change.cursor.epoch !== owner.cursor.epoch || change.cursor.revision <= owner.cursor.revision))) return
      owner.cursor = change.cursor
      if (change.reason === 'revoked') { setReport({ state: 'revoked' }); return }
      void refresh()
    }
    const off = bridge.onEvent(event => {
      if (event.kind !== 'sdk/disconnected' && event.kind !== 'sdk/notification') return
      if (event.workspaceId !== workspaceId) return
      if (event.kind === 'sdk/disconnected') { owner.active = false; owner.disconnected = true; setReport({ state: 'unavailable' }); return }
      if (!owner.active) { setConnectionAttempt(value => value + 1); return }
      if (event.kind === 'sdk/notification' && event.method === 'desktop/instructions/changed') receive(event.params as Change)
    })
    void bridge.request({ kind: 'desktop/instructions/subscribe', workspaceId, sessionId, ...(childSessionId ? { childSessionId } : {}) }).then(value => {
      const snapshot = value as Snapshot
      if (!snapshot.subscriptionId) throw new Error('Instruction subscription unavailable')
      if (!owner.active) { if (!owner.disconnected) void bridge.request({ kind: 'desktop/instructions/unsubscribe', workspaceId, subscriptionId: snapshot.subscriptionId }).catch(() => {}); return }
      owner.id = snapshot.subscriptionId; owner.cursor = snapshot.cursor; setReport(snapshot.report)
      for (const event of buffered) receive(event)
      if (overflow) void refresh()
    }).catch(reason => { if (owner.active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { owner.active = false; off(); if (owner.id && !owner.disconnected) void bridge.request({ kind: 'desktop/instructions/unsubscribe', workspaceId, subscriptionId: owner.id }).catch(() => {}) }
  }, [bridge, workspaceId, sessionId, childSessionId, refresh, connectionAttempt])
  return { report, error, refresh: () => { if (!state.current.active) { setConnectionAttempt(value => value + 1); return }; return refresh(true) } }
}
