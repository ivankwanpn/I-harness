import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFactBatch } from '@i-harness/core-session'
import { createControlledJsonlBackend, createSessionCoordinator, ownedControls } from '../../session-persistence/test/helpers/composed.ts'
import { createSpawnSource } from '../src/tools/spawn-source.ts'
import { OriginalTerminalRecoveryError } from '../src/task-notification.ts'

it('preserves a non-required source terminal UNKNOWN and reconciles its same original native fact', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'ordinary-source-unknown-'))
  const backend = createControlledJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const control = ownedControls(backend)
  let held = true, issued = 0, saved = 0
  const terminal = (bytes: Uint8Array) => decodeFactBatch(bytes).events.some(event => event.type === 'subagent/end')
  control.append = async (...args) => {
    const outcome = await control.originalAppend(...args)
    if (terminal(args[3].bytes)) { issued++; if (held) return { kind: 'unknown', key: args[3].key } }
    return outcome
  }
  control.reconcile = async (...args) => held && terminal(args[3].bytes)
    ? { kind: 'unknown', key: args[3].key } : control.originalReconcile(...args)
  let source: ReturnType<typeof createSpawnSource> | undefined
  let endEntered = false
  let primary: { cause: unknown } | undefined
  try {
    await coordinator.create({ sessionId: 'parent' })
    const document = await coordinator.openManagedDocument('parent')
    source = createSpawnSource(document)
    expect(source.hasRequiredTask()).toBe(false)
    await source.start({ type: 'subagent/start', version: 1, taskId: 'ordinary', parentSessionId: 'parent', agentPath: 'root/ordinary', role: 'general', description: 'ordinary source' })
    source.bindTask('ordinary', async () => { saved++ })
    endEntered = true
    const cause = await source.end({ type: 'subagent/end', version: 1, taskId: 'ordinary', outcome: 'completed', resultText: 'original terminal' }).then(
      () => { throw Error('Original terminal UNKNOWN unexpectedly acknowledged') }, cause => cause,
    )
    expect(cause).toBeInstanceOf(OriginalTerminalRecoveryError)
    expect(cause.outcome).toMatchObject({ kind: 'unknown' })
    expect(saved).toBe(1); expect(issued).toBe(1)
    held = false
    await source.reconcileTerminal()
    const events = (await backend.read('parent')).events
    expect(events.filter(event => event.type === 'subagent/end')).toHaveLength(1)
    expect(saved).toBe(1); expect(issued).toBe(1)
  } catch (cause) { primary = { cause } }
  finally {
    held = false
    const failures: unknown[] = []
    if (source) {
      try { if (endEntered) await source.reconcileTerminal(); else await source.releaseUnused() }
      catch (cause) { failures.push(cause) }
      finally { try { source.finish() } catch (cause) { failures.push(cause) } }
    }
    try { await coordinator.close() } catch (cause) { failures.push(cause) }
    if (primary || failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original non-required recovery and cleanup must acknowledge')
  }
})
