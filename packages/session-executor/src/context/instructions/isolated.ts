import type { AuthorityState } from '@i-harness/sandbox'
import type { IsolatedInstructionFactory, IsolatedInstructionLease } from '@i-harness/guard-approval'
import type { ExecutionConfirmation } from '@i-harness/llm-seam'
import { openOwnedPreparedStream, readDrainedOwnedExecutionConfirmation, type OwnedPreparedStreamInvocation } from '@i-harness/llm-seam/internal/stream-lifetime'
import type { InstructionEnvironment } from './contracts.ts'
import { instructionView } from './views.ts'
import { contained } from './targets.ts'

const unavailable = () => Object.assign(new Error('Observed instructions unavailable'), { code: 'CONTEXT_INPUT_STALE' })
function originalMethod<T extends (...args: any[]) => any>(owner: object, name: string): T {
  for (let current: object | null = owner; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor) { if ('value' in descriptor && typeof descriptor.value === 'function') return descriptor.value.bind(owner) as T; break }
  }
  throw new TypeError(`Invalid isolated instruction ${name} capability`)
}
function optionalMethod<T extends (...args: any[]) => any>(owner: object, name: string): T | undefined {
  for (let current: object | null = owner; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor) { if ('value' in descriptor && typeof descriptor.value === 'function') return descriptor.value.bind(owner) as T; throw new TypeError(`Invalid isolated instruction ${name} capability`) }
  }
  return undefined
}
export function createIsolatedInstructionHost(options: { environment: InstructionEnvironment; cwd: string; authority(): AuthorityState; available(): boolean }) {
  const authorityNow = originalMethod<typeof options.authority>(options, 'authority'), hostAvailable = originalMethod<typeof options.available>(options, 'available')
  const policyReady = originalMethod<typeof options.environment.policy.ready>(options.environment.policy, 'ready'), policyCurrent = originalMethod<typeof options.environment.policy.current>(options.environment.policy, 'current')
  const leases = new Set<{ retire(): void; close(): Promise<void> }>()
  const failures = new Set<unknown>()
  let retired = false
  const scope = () => {
    if (retired || !hostAvailable()) throw unavailable()
    const authority = authorityNow()
    if (authority.kind === 'revoked' || authority.kind === 'unavailable') throw unavailable()
    const roots = authority.kind === 'bound' ? authority.roots : [authority.workspaceRoot]
    if (!roots.some(root => contained(root, options.cwd))) throw unavailable()
    return { roots, identity: JSON.stringify([authority.revision, roots]) }
  }
  const create: IsolatedInstructionFactory = async input => {
    const closeGeneration = input.generation ? originalMethod<typeof input.generation.close>(input.generation, 'close') : undefined
    let recoverGeneration: (() => Promise<void>) | undefined
    let view: ReturnType<typeof instructionView> | undefined, invocation: OwnedPreparedStreamInvocation | undefined
    let closed = false, generationClosed = false, generationCloseFailed = false, fenced = false, acquiring = true, flight: Promise<void> | undefined
    let disposition: 'completed' | 'failed' | 'stopped' = 'failed', dispositionSet = false
    const acquired = Promise.withResolvers<void>()
    const holder = {
      retire() { fenced = true; if (!dispositionSet) disposition = 'stopped' },
      close() {
        fenced = true
        if (flight) return flight
        const pending = (async () => { if (acquiring) await acquired.promise; let failure: unknown, failed = false; if (invocation) try { await invocation.drain() } catch (error) { failure = error; failed = true; failures.add(error) }; if (!generationClosed) { if (generationCloseFailed) { if (!recoverGeneration) throw Object.assign(new Error('Original generation close recovery unavailable'), { code: 'FACT_RECOVERY_REQUIRED' }); await recoverGeneration() } else try { await closeGeneration?.(disposition) } catch (error) { generationCloseFailed = true; throw error }; generationClosed = true }; if (!closed) { await view?.retire(); closed = true; leases.delete(holder) }; if (failed) throw failure })()
        flight = pending; void pending.catch(() => { if (flight === pending) flight = undefined }); return pending
      },
    }
    leases.add(holder)
    try {
      recoverGeneration = input.generation ? optionalMethod<NonNullable<typeof input.generation.recoverClose>>(input.generation, 'recoverClose') : undefined
      const lifetimeAvailable = originalMethod<typeof input.lifetime.available>(input.lifetime, 'available')
      if (retired || input.signal.aborted) throw unavailable()
      await policyReady()
      const policy = policyCurrent(), authority = scope()
      if (fenced || input.signal.aborted || !lifetimeAvailable() || policy.kind !== 'ready') throw unavailable()
      view = instructionView(options.environment.host.create({ cwd: options.cwd, roots: authority.roots, ...policy.policy }))
      const snapshot = await view.service.prepare([{ path: options.cwd, kind: 'directory' }])
      const identity = JSON.stringify([policy.generation, authority.identity, snapshot.fingerprint, snapshot.candidates, snapshot.applicable])
      let stale = false
      const assertCurrent = () => {
        if (stale) throw unavailable()
        try {
          const currentPolicy = policyCurrent()
          if (fenced || input.signal.aborted || !lifetimeAvailable() || currentPolicy.kind !== 'ready' || currentPolicy.generation !== policy.generation || scope().identity !== authority.identity) throw unavailable()
          const current = view!.service.snapshot()
          if (!current.complete || current.reliability !== 'ready' || JSON.stringify([policy.generation, authority.identity, current.fingerprint, current.candidates, current.applicable]) !== identity) throw unavailable()
        } catch (error) { stale = true; throw error }
      }
      assertCurrent()
      let bound = false
      const lease: IsolatedInstructionLease = Object.freeze({ text: snapshot.text, poolIdentity: identity, assertCurrent, retire: holder.retire, close: holder.close, finish(value: 'completed' | 'failed' | 'stopped') { if (!fenced) { disposition = value; dispositionSet = true } },
        bind(prepared: import('@i-harness/llm-seam').PreparedModelRequest) {
          assertCurrent(); if (bound) throw unavailable(); bound = true
          let pending: ExecutionConfirmation | undefined, issued: ExecutionConfirmation | undefined, active = true, bad = false
          const sends = new Set<string>()
          const valid = (value: ExecutionConfirmation) => value.version === 1 && value.semanticId === prepared.measurement.input.semanticIdentity?.semanticId && value.payloadId === prepared.measurement.payloadIdentity?.id && value.payloadKind === prepared.measurement.payloadIdentity?.kind && typeof value.sendId === 'string' && !sends.has(value.sendId)
          return Object.freeze({
            open(control: Readonly<Pick<import('@i-harness/llm-seam').PreparedStreamControl, 'generation' | 'signal'>>) {
              assertCurrent(); if (!active || invocation) throw unavailable()
              invocation = openOwnedPreparedStream(prepared, { ...control,
                confirmExecution(value) { assertCurrent(); if (!active || pending || !valid(value)) throw unavailable(); sends.add(value.sendId); pending = value },
                validateBeforeTransport() { assertCurrent(); if (!active || !pending) throw unavailable() },
                onTransportIssue() { if (!active || !pending) { bad = true; return }; issued = pending; pending = undefined },
              })
              return invocation
            },
            complete() { assertCurrent(); if (!active || bad || pending || !issued || !invocation || !readDrainedOwnedExecutionConfirmation(invocation, issued, prepared)) throw unavailable() },
            close() { active = false; pending = undefined },
          })
        },
      })
      return lease
    } catch (error) {
      holder.retire()
      disposition = input.signal.aborted ? 'stopped' : 'failed'
      acquiring = false; acquired.resolve()
      try { await holder.close() } catch { /* retain original close debt */ }
      throw error
    } finally { acquiring = false; acquired.resolve() }
  }
  return { create, retire() { retired = true; for (const lease of leases) lease.retire() }, async close() { retired = true; for (const lease of leases) lease.retire(); for (const lease of [...leases]) try { await lease.close() } catch (error) { failures.add(error) }; if (failures.size) { const reported = [...failures]; failures.clear(); throw new AggregateError(reported, 'Original isolated instruction cleanup failed') } } }
}
