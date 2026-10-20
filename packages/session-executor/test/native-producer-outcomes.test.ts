import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { deriveMessages, resultIsError, resultDisposition } from '@i-harness/core-session'
import { createShellTools } from '@i-harness/shell'
import { nativeFixture } from '../../exec/test/native-fixture.ts'
import { createSessionAssembly } from '../src/assembly.ts'
import { controlledModel } from './controlled-model.ts'

it.each([['normal', 7, 'failed'], ['normal', null, 'unknown'], ['nested', 7, 'failed'], ['nested', null, 'unknown']] as const)(
  'actual assembly retains %s native exit %s as %s under its original source and complete value', async (consumer, exitCode, outcome) => {
    const base = resolve(import.meta.dirname, '../../../build/native-outcome-tests'); await mkdir(base, { recursive: true })
    const root = await mkdtemp(resolve(base, 'managed-'))
    const coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } }), { id } = await coordinator.create()
    const service = createContextOutputService({ root: resolve(root, 'outputs'), workspaceId: 'native-outcome-fixture', config: { enabled: false }, authorizeResult: () => true })
    const raw = 'original native 中文 '.repeat(5000)
    const native = nativeFixture({ root: { exitCode }, text: raw })
    const tool = createShellTools({ exec: native.exec, agentShell: () => ({ id: 'fixture', label: 'controlled native', command: 'fixture', dialect: 'posix' }) }).find(tool => tool.name === 'shell')!
    let sends = 0
    const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, contextOutput: service, codeMode: { mode: 'mixed' },
      additionalTools: [{ ...tool, name: 'native_original', isReadOnly: true }],
      model: controlledModel(async function* () {
        if (++sends === 1) yield { type: 'tool_call', call: { id: 'original-call', name: consumer === 'normal' ? 'native_original' : 'code_exec', args: consumer === 'normal' ? { command: 'fixture' } : { code: 'const value=await tools.native_original({command:"fixture"});text(value.exitCode);', yield_time_ms: 60000 } } }
        else yield { type: 'text/chunk', text: 'complete' }
        yield { type: 'end' }
      }),
    })
    try {
      await assembly.agent.run('retain original native outcome')
      const events = assembly.session.events.filter(event => event.type === (consumer === 'normal' ? 'tool/result' : 'code/result') && event.name === 'native_original')
      expect(events).toHaveLength(1)
      const event = events[0]!
      if ((event.type !== 'tool/result' && event.type !== 'code/result') || !event.envelope) throw new Error('Expected original retained result')
      expect(event.envelope.execution).toEqual({ outcome, dispatch: 'dispatched' })
      expect(resultIsError(event.envelope)).toBe(true)
      expect(resultDisposition(event.envelope)).toBe(outcome === 'unknown' ? 'unknown' : undefined)
      expect(event).not.toHaveProperty('output')
      if (event.envelope.retention.kind !== 'artifact') throw new Error('Expected complete program artifact')
      const ref = event.envelope.retention.ref, parts: Buffer[] = []; let offset = 0
      for (;;) {
        const page = await service.readResult({ sessionId: id }, { ref, offset })
        parts.push(page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64'))
        if (page.eof) break
        offset = page.nextOffset!
      }
      expect(JSON.parse(Buffer.concat(parts).toString())).toEqual({ stdout: raw, stderr: '', exitCode: exitCode ?? -1 })
      const originalCall = assembly.session.events.find(call => call.type === (consumer === 'normal' ? 'tool/call' : 'code/call') && call.callId === event.callId)
      expect(originalCall).toMatchObject({ name: 'native_original', callId: event.callId })
      const projected = deriveMessages(assembly.session).find(message => message.role === 'tool' && message.toolCallId === 'original-call')
      expect(projected).toBeDefined()
      if (consumer === 'normal') {
        expect(projected).toMatchObject({ isError: true })
        expect(JSON.parse(String(projected!.content))).toMatchObject({ execution: { outcome, dispatch: 'dispatched' }, retention: { ref: { id: ref.id } } })
      } else {
        // Nested native failure is data guest code can consume; outer completion succeeds.
        expect(projected).not.toHaveProperty('isError')
        expect(assembly.session.events.find(row => row.type === 'tool/result' && row.callId === 'original-call')).toMatchObject({ envelope: { execution: { outcome: 'succeeded' }, retention: { kind: 'inline', value: { status: 'completed', text: String(exitCode ?? -1) } } } })
      }
      expect(native.counts()).toEqual({ launches: 1, terminations: 0, releases: 1 })
    } finally { await assembly.dispose(); await native.exec.dispose(); await coordinator.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
  },
)
