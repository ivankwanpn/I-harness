import { randomUUID } from 'node:crypto'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { SessionService } from '@i-harness/session-executor'
import { createSubagentScope } from '../subagents/scope.ts'
export type { InstructionReport } from '@i-harness/session-executor'

type Scope = Readonly<{ sessionId: string; childSessionId?: string }>
type Cursor = Readonly<{ epoch: string; revision: number }>
type Binding = { ownerId?: string; assembly?: ReturnType<SessionService['liveAssembly']>; diagnostics?: ReturnType<NonNullable<import('@i-harness/session-executor').SessionAssembly['instructionDiagnostics']>>; authority: string }
type Member = { id: string; active: boolean; capturing: boolean; dirty: boolean; revoked: boolean }
type Group = { key: string; scope: Scope; binding: Binding; revision: number; members: Set<Member>; off?: () => void; delivering: boolean; dirty: boolean }
export function createInstructionViews(coordinator: SessionCoordinator, service: SessionService, authorizeScope: (input: Scope) => Promise<string>, notify: (event: { subscriptionId: string; scope: Scope; cursor: Cursor; reason: 'changed' | 'revoked' }) => void, limits: { maxSubscriptions?: number; maxScopes?: number } = {}) {
  const epoch = randomUUID(), groups = new Map<string, Group>(), subscriptions = new Map<string, { group: Group; member: Member }>()
  const maxSubscriptions = limits.maxSubscriptions ?? 128, maxScopes = limits.maxScopes ?? 64
  if (![maxSubscriptions, maxScopes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid instruction subscription limits')
  let closed = false, revision = 0, pending = 0
  // One host sequence is monotonic within every scope, without retaining cold
  // or retired scope keys. Revisions are observation cursors, not replay claims.
  const advance = () => { if (revision === Number.MAX_SAFE_INTEGER) throw new Error('Instruction cursor exhausted; reconnect required'); return ++revision }
  const open = () => { if (closed) throw new Error('Instruction observation closed') }
  const current = (binding: Binding, input: Scope) => !closed && (!binding.ownerId || service.liveAssembly(binding.ownerId) === binding.assembly) && binding.assembly?.instructionDiagnostics?.(input.childSessionId) === binding.diagnostics && binding.diagnostics?.read().state !== 'revoked'
  const scope = createSubagentScope(coordinator, service, () => { if (closed) throw new Error('Instruction observation closed') })
  const resolve = async (input: Scope): Promise<Binding> => {
    if (closed) throw new Error('Instruction observation closed')
    await scope.parent(input.sessionId)
    const parentAuthority = await authorizeScope({ sessionId: input.sessionId })
    open()
    if (!input.childSessionId) { const assembly = service.liveAssembly(input.sessionId); return { ownerId: input.sessionId, assembly, diagnostics: assembly?.instructionDiagnostics?.(), authority: parentAuthority } }
    const chain = await scope.lineage(input.sessionId, input.childSessionId), authority = await authorizeScope(input), owner = scope.authority(input.sessionId, input.childSessionId, chain)
    open()
    if (!owner || !scope.liveChild(input.childSessionId, owner)) return { authority: JSON.stringify([parentAuthority, authority]) }
    return { ownerId: owner.ownerId, assembly: owner.assembly, diagnostics: owner.assembly.instructionDiagnostics?.(input.childSessionId), authority: JSON.stringify([parentAuthority, authority]) }
  }
  const same = (a: Binding, b: Binding) => a.ownerId === b.ownerId && a.assembly === b.assembly && a.diagnostics === b.diagnostics && a.authority === b.authority
  const send = (event: Parameters<typeof notify>[0]) => { try { notify(event) } catch { /* Transport failure cannot change source ownership. */ } }
  const read = async (input: Scope) => {
    const initial = await resolve(input)
    const after = await resolve(input)
    if (!current(initial, input) || !same(initial, after)) return { state: 'revoked' as const }
    return initial.ownerId ? service.instructionState?.(initial.ownerId, input.childSessionId) ?? { state: 'not-published' as const } : { state: 'not-published' as const }
  }
  const refresh = async (input: Scope) => {
    const initial = await resolve(input)
    if (!initial.ownerId || !service.refreshInstructions) return { state: 'not-published' as const }
    const report = await service.refreshInstructions(initial.ownerId, input.childSessionId)
    const after = await resolve(input)
    return current(initial, input) && same(initial, after) ? initial.diagnostics?.read() ?? report : { state: 'revoked' as const }
  }
  const snapshot = async (input: Scope, refreshRequested = false) => {
    input = Object.freeze({ sessionId: input.sessionId, ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}) })
    const key = JSON.stringify([input.sessionId, input.childSessionId ?? null])
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = groups.get(key)?.revision
      const report = await (refreshRequested && attempt === 0 ? refresh(input) : read(input))
      if (groups.get(key)?.revision !== before) continue
      open(); const revision = advance()
      const group = groups.get(key); if (group) group.revision = revision
      return { scope: input, cursor: { epoch, revision }, report }
    }
    throw new Error('Instruction state changed during observation')
  }
  const remove = (group: Group, member: Member) => {
    if (!member.active) return; member.active = false; group.members.delete(member); subscriptions.delete(member.id)
    if (!group.members.size) { group.off?.(); if (groups.get(group.key) === group) groups.delete(group.key) }
  }
  const deliver = (group: Group) => {
    if (closed || !group.members.size || group.delivering || !group.dirty) return
    group.delivering = true; group.dirty = false; const revision = group.revision
    void resolve(group.scope).then(resolved => {
      for (const member of [...group.members]) if (member.active) {
        const reason = same(group.binding, resolved) && current(group.binding, group.scope) ? 'changed' as const : 'revoked' as const
        if (member.capturing) { member.dirty = true; if (reason === 'revoked') member.revoked = true; continue }
        const disposition = member.revoked ? 'revoked' : reason
        send({ subscriptionId: member.id, scope: group.scope, cursor: { epoch, revision }, reason: disposition })
        if (disposition === 'revoked') remove(group, member)
      }
    }, () => { for (const member of [...group.members]) if (member.active) { if (member.capturing) { member.dirty = true; member.revoked = true; continue }; send({ subscriptionId: member.id, scope: group.scope, cursor: { epoch, revision }, reason: 'revoked' }); remove(group, member) } }).finally(() => { group.delivering = false; deliver(group) })
  }
  const subscribe = async (raw: Scope) => {
    open()
    if (subscriptions.size + pending >= maxSubscriptions) throw new Error('Instruction subscription limit reached')
    pending++; let reserved = true
    try {
    const input = Object.freeze({ sessionId: raw.sessionId, ...(raw.childSessionId ? { childSessionId: raw.childSessionId } : {}) })
    const key = JSON.stringify([input.sessionId, input.childSessionId ?? null]), binding = await resolve(input)
    let group = groups.get(key)
    open()
    if (group && !same(group.binding, binding)) { group.revision = advance(); for (const member of [...group.members]) { send({ subscriptionId: member.id, scope: group.scope, cursor: { epoch, revision: group.revision }, reason: 'revoked' }); remove(group, member) }; group = undefined }
    if (!group) {
      if (groups.size >= maxScopes) throw new Error('Instruction scope limit reached')
      if (!service.onInstructionsChanged) throw new Error('Instruction subscription unavailable')
      const created: Group = { key, scope: input, binding, revision: advance(), members: new Set(), delivering: false, dirty: false }
      groups.set(key, created); group = created
      try { created.off = service.onInstructionsChanged(binding.ownerId ?? input.sessionId, input.childSessionId, () => { created.revision = advance(); created.dirty = true; deliver(created) }) }
      catch (error) { groups.delete(key); throw error }
    }
    const owner = group, member: Member = { id: randomUUID(), active: true, capturing: true, dirty: false, revoked: false }
    pending--; reserved = false
    owner.members.add(member); subscriptions.set(member.id, { group: owner, member })
    const snapshotRevision = owner.revision
    try {
      const report = await read(input)
      const after = await resolve(input)
      if (!member.active || groups.get(key) !== owner || !current(binding, input) || !same(binding, after)) throw new Error('Instruction scope changed during subscription')
      const result = { subscriptionId: member.id, scope: input, cursor: { epoch, revision: snapshotRevision }, report }
      return result
    } catch (error) { remove(owner, member); throw error }
    } finally { if (reserved) pending-- }
  }
  return { read, refresh, snapshot, subscribe, acknowledge(id: string, write?: () => void) {
    const value = subscriptions.get(id)
    if (!value) return false
    if (!value.member.active || groups.get(value.group.key) !== value.group || !current(value.group.binding, value.group.scope)) { remove(value.group, value.member); return false }
    try { write?.() } catch (error) { remove(value.group, value.member); throw error }
    if (!value.member.active) return true // A synchronous transport callback may withdraw the scope.
    value.member.capturing = false
    if (value.member.dirty) { value.member.dirty = false; value.group.dirty = true; deliver(value.group) }
    return true
  }, revokeSession(sessionId: string) {
    for (const group of [...groups.values()]) if (group.scope.sessionId === sessionId) {
      group.revision = advance()
      for (const member of [...group.members]) { if (!member.capturing) send({ subscriptionId: member.id, scope: group.scope, cursor: { epoch, revision: group.revision }, reason: 'revoked' }); remove(group, member) }
    }
  }, unsubscribe(id: string) { const value = subscriptions.get(id); if (value) remove(value.group, value.member) }, close() { closed = true; for (const { group, member } of [...subscriptions.values()]) remove(group, member) } }
}
