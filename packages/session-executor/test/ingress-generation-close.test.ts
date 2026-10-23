import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGenerationActions, type ManagedAction, type ProducerFactOutcome } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createMockClient } from '@i-harness/llm-mock'
import { openExecutorDocument } from '../src/lifecycle/managed-document.ts'
import { prepareInputExecution } from '../src/lifecycle/input-preparation.ts'
import { openLiteralInputExecution } from '../src/lifecycle/literal-input.ts'
import { createSessionService } from '../src/index.ts'

afterEach(() => vi.unstubAllEnvs())

async function setup(cut: string) {
  const root = await mkdtemp(join(tmpdir(), 'ih-ingress-close-')), backend = createJsonlBackend(join(root, 'sessions'))
  vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root); vi.stubEnv('IH_CONFIG_DIR', join(root, 'config'))
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const attachment = await openExecutorDocument({ coordinator, sessionId: id }), document = attachment.document!
  const input = { inputId: 'original-input', text: 'original literal input', delivery: 'queue' as const, intent: 'user' as const,
    preparationPolicy: 'human-host' as const, provenance: { kind: 'human' as const, authority: 'request' as const, scope: 'turn' as const, producer: 'session.prompt' } }
  await attachment.inbox.admit(input)
  const original = Error('original construction boundary ' + cut), actions: ManagedAction<ProducerFactOutcome>[] = [], begin = document.beginAction.bind(document)
  document.beginAction = signal => {
    if (cut === 'begin-action') throw original
    const action = begin(signal), register = action.registerSettlementSource.bind(action)
    expect(document.ownsAction(action)).toBe(true)
    actions.push(action)
    let registrations = 0
    action.registerSettlementSource = (drain, reconcilePending) => {
      registrations++
      if (cut === 'generation-source' && registrations === 1 || cut === 'preparation-source' && registrations === 2) throw original
      return register(drain, reconcilePending)
    }
    return action
  }
  const service = createSessionService({ workspace: root, coordinator, sessionFor: async () => document.view, model: createMockClient([]), modelPolicy: 'test-mock', approveAll: true, sandbox: 'danger-full-access' })
  return { root, backend, coordinator, id, attachment, document, input, pending: attachment.inbox.pending().find(entry => entry.inputId === input.inputId)!, original, actions, service,
    async close() { await service.close(); await coordinator.close() },
  }
}

it.each(['acquire', 'begin-action', 'generation-source', 'preparation-source', 'admission', 'generation-open', 'assembly', 'transform'] as const)(
  'finishes every created submitted-input source after failure at %s without self-join', async cut => {
    const f = await setup(cut)
    try {
      const failure = await prepareInputExecution({ ownerSessionId: f.id,
        acquire: async () => { if (cut === 'acquire') throw f.original; return f.attachment },
        assemble: async () => { if (cut === 'assembly') throw f.original; return f.service.assemblyFor(f.id) },
        input: cut === 'admission' ? { ...f.input, text: 'mismatch' } : f.input, alreadyAdmitted: true, signal: new AbortController().signal,
        ...(cut === 'generation-open' ? { modelActionTimeoutMs: 0 } : {}),
        prepare: async (_assembly, text) => { if (cut === 'transform') throw f.original; return text },
      }).catch(error => error)
      if (!(failure instanceof Error)) await failure.close()
      expect(failure).toBeInstanceOf(Error)
      if (['acquire', 'begin-action', 'generation-source', 'preparation-source', 'assembly'].includes(cut)) expect(failure).toBe(f.original)
      if (f.actions[0]) expect(() => f.actions[0]!.assertOpen()).toThrow('FACT_CANCELLED')
      const actions = readGenerationActions(f.document.view.events, { sessionId: f.id })
      expect(actions.every(action => action.closed !== undefined)).toBe(true)
      await f.coordinator.close()
    } finally { await f.close() }
  },
)

it.each(['begin-action', 'generation-source', 'preparation-source', 'admission', 'generation-open', 'completed'] as const)(
  'joins the literal-input original sources at %s without source release racing its close decision', async cut => {
    const f = await setup(cut)
    try {
      const result = await openLiteralInputExecution({ attachment: f.attachment, ownerSessionId: f.id,
        input: cut === 'admission' ? { ...f.pending, text: 'mismatch' } : f.pending, signal: new AbortController().signal,
        start: { wall: Date.now(), monotonic: performance.now() }, selectedClient: () => undefined, localTestEnabled: false,
        ...(cut === 'generation-open' ? { timeoutMs: 0 } : {}),
      }).catch(error => error)
      if (cut === 'completed') {
        expect(result.generation).toBeDefined(); expect(result.preparation).toBeDefined()
        await result.close()
      } else {
        expect(result).toBeInstanceOf(Error)
        if (cut.endsWith('source') || cut === 'begin-action') expect(result).toBe(f.original)
      }
      if (f.actions[0]) expect(() => f.actions[0]!.assertOpen()).toThrow('FACT_CANCELLED')
      expect(readGenerationActions(f.document.view.events, { sessionId: f.id }).every(action => action.closed !== undefined)).toBe(true)
      await f.coordinator.close()
    } finally { await f.close() }
  },
)
