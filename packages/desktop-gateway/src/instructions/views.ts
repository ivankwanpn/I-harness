import { randomUUID } from 'node:crypto'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { SessionService } from '@i-harness/session-executor'
import { createSubagentScope } from '../subagents/scope.ts'
export type { InstructionReport } from '@i-harness/session-executor'

type Scope = Readonly<{ sessionId: string; childSessionId?: string }>
type Cursor = Readonly<{ epoch: string; revision: number }>
type Binding = { ownerId?: string; assembly?: ReturnType<SessionService['liveAssembly']>; authority: string }
type Member = { id: string; active: boolean; capturing: boolean; dirty: boolean; revoked: boolean }
type Group = { key: string; scope: Scope; binding: Binding; revision: number; members: Set<Member>; off?: () => void; delivering: boolean; dirty: boolean }
export function createInstructionViews(coordinator: SessionCoordinator, service: SessionService, authorizeScope: (input: Scope) => Promise<string>, notify: (event: { subscriptionId: string; scope: Scope; cursor: Cursor; reason: 'changed' | 'revoked' }) => void) {
  const epoch = randomUUID(), groups = new Map<string, Group>(), subscriptions = new Map<string, { group: Group; member: Member }>(), revisions = new Map<string, number>()
  let closed = false
  const scope = createSubagentScope(coordinator, service, () => { if (closed) throw new Error('Instruction observation closed') })
  const resolve = async (input: Scope): Promise<Binding> => {
    if (closed) throw new Error('Instruction observation closed')
    await scope.parent(input.sessionId)
    const parentAuthority = await authorizeScope({ sessionId: input.sessionId })
    if (!input.childSessionId) return { ownerId: input.sessionId, assembly: service.liveAssembly(input.sessionId), authority: parentAuthority }
    const chain = await scope.lineage(input.sessionId, input.childSessionId), authority = await authorizeScope(input), owner = scope.authority(input.sessionId, input.childSessionId, chain)
    if (!owner || !scope.liveChild(input.childSessionId, owner)) return { authority: JSON.stringify([parentAuthority, authority]) }
    return { ownerId: owner.ownerId, assembly: owner.assembly, authority: JSON.stringify([parentAuthority, authority]) }
  }
  const same = (a: Binding, b: Binding) => a.ownerId === b.ownerId && a.assembly === b.assembly && a.authority === b.authority
  const send = (event: Parameters<typeof notify>[0]) => { try { notify(event) } catch { /* Transport failure cannot change source ownership. */ } }
  const read = async (input: Scope) => {
    const initial = await resolve(input)
    const report = initial.ownerId ? service.instructionState?.(initial.ownerId, input.childSessionId) ?? { state: 'not-published' as const } : { state: 'not-published' as const }
    return same(initial, await resolve(input)) ? report : { state: 'revoked' as const }
  }
  const refresh = async (input: Scope) => {
    const initial = await resolve(input)
    if (!initial.ownerId || !service.refreshInstructions) return { state: 'not-published' as const }
    const report = await service.refreshInstructions(initial.ownerId, input.childSessionId)
    return same(initial, await resolve(input)) ? report : { state: 'revoked' as const }
  }
  const snapshot = async (input: Scope, refreshRequested = false) => {
    input = Object.freeze({ sessionId: input.sessionId, ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}) })
    const key = JSON.stringify([input.sessionId, input.childSessionId ?? null])
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = revisions.get(key) ?? 0
      const report = await (refreshRequested && attempt === 0 ? refresh(input) : read(input))
      if ((revisions.get(key) ?? 0) !== before) continue
      const revision = before + 1; revisions.set(key, revision)
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
    if (closed || group.delivering || !group.dirty) return
    group.delivering = true; group.dirty = false; const revision = group.revision
    void resolve(group.scope).then(current => {
      const reason = same(group.binding, current) ? 'changed' as const : 'revoked' as const
      for (const member of [...group.members]) if (member.active) {
        if (member.capturing) { member.dirty = true; if (reason === 'revoked') member.revoked = true; continue }
        const disposition = member.revoked ? 'revoked' : reason
        send({ subscriptionId: member.id, scope: group.scope, cursor: { epoch, revision }, reason: disposition })
        if (disposition === 'revoked') remove(group, member)
      }
    }, () => { for (const member of [...group.members]) if (member.active) { if (member.capturing) { member.dirty = true; member.revoked = true; continue }; send({ subscriptionId: member.id, scope: group.scope, cursor: { epoch, revision }, reason: 'revoked' }); remove(group, member) } }).finally(() => { group.delivering = false; deliver(group) })
  }
  const subscribe = async (raw: Scope) => {
    const input = Object.freeze({ sessionId: raw.sessionId, ...(raw.childSessionId ? { childSessionId: raw.childSessionId } : {}) })
    const key = JSON.stringify([input.sessionId, input.childSessionId ?? null]), binding = await resolve(input)
    let group = groups.get(key)
    if (group && !same(group.binding, binding)) { group.revision++; revisions.set(key, group.revision); for (const member of [...group.members]) { send({ subscriptionId: member.id, scope: group.scope, cursor: { epoch, revision: group.revision }, reason: 'revoked' }); remove(group, member) }; group = undefined }
    if (!group) {
      if (!service.onInstructionsChanged) throw new Error('Instruction subscription unavailable')
      const created: Group = { key, scope: input, binding, revision: revisions.get(key) ?? 0, members: new Set(), delivering: false, dirty: false }
      groups.set(key, created); group = created
      try { created.off = service.onInstructionsChanged(binding.ownerId ?? input.sessionId, input.childSessionId, () => { created.revision++; revisions.set(key, created.revision); created.dirty = true; deliver(created) }) }
      catch (error) { groups.delete(key); throw error }
    }
    const owner = group, member: Member = { id: randomUUID(), active: true, capturing: true, dirty: false, revoked: false }
    owner.members.add(member); subscriptions.set(member.id, { group: owner, member })
    const snapshotRevision = owner.revision
    try {
      const report = await read(input)
      if (!member.active || !same(binding, await resolve(input))) throw new Error('Instruction scope changed during subscription')
      const result = { subscriptionId: member.id, scope: input, cursor: { epoch, revision: snapshotRevision }, report }
      setTimeout(() => { if (!member.active) return; member.capturing = false; if (member.dirty) { owner.dirty = true; deliver(owner) } }, 0)
      return result
    } catch (error) { remove(owner, member); throw error }
  }
  return { read, refresh, snapshot, subscribe, unsubscribe(id: string) { const value = subscriptions.get(id); if (value) remove(value.group, value.member) }, close() { closed = true; for (const { group, member } of [...subscriptions.values()]) remove(group, member) } }
}
