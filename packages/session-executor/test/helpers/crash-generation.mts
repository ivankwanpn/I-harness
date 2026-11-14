import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFactBatch } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../../llm-openai-compatible/src/index.ts'
import { createSessionService } from '../../src/index.ts'

const [root, id, endpoint, cut] = process.argv.slice(2)
if (!root || !id || !endpoint || !cut) throw new Error('Missing controlled crash fixture arguments')
const nativeFetch = globalThis.fetch
// Installed before constructing any model; only this exact loopback fixture is allowed.
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (url !== endpoint + '/v1/chat/completions') throw new Error('Unexpected network destination')
  return nativeFetch(url, init)
}) as typeof globalThis.fetch
async function crash(): Promise<never> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`AT_CUT ${process.pid} ${cut}\n`, error => error ? reject(error) : resolve())
  })
  process.exit(0)
}
const backend = createJsonlBackend(root, {
  wrapOwnedBatch: append => async (...args) => {
    const events = decodeFactBatch(args[3].bytes).events
    if (cut === 'before-reservation' && events.some(event => event.type === 'context/attempt' && event.op === 'reserve')) await crash()
    if (cut === 'output-before-acceptance' && events.some(event => event.type === 'model/exchange-accepted')) await crash()
    const result = await append(...args)
    const committedCut = cut === 'reservation-before-handoff' && events.some(event => event.type === 'context/attempt' && event.op === 'reserve')
      || cut === 'settled-tool' && events.some(event => event.type === 'tool/result')
    if (committedCut) {
      assert.equal(result.kind, 'committed')
      if (cut === 'settled-tool') {
        const settled = events.find(event => event.type === 'tool/result')
        assert.equal(settled?.callId, 'original-effect')
        assert.equal(settled?.envelope?.execution.outcome, 'succeeded')
      }
      await crash()
    }
    return result
  },
})
const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
await coordinator.create({ sessionId: id })
const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: endpoint })
const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, approveAll: true,
  additionalTools: [{ name: 'crash_effect', description: 'Controlled crash effect.', inputSchema: { type: 'object', properties: {} }, isReadOnly: false,
    async execute() { await appendFile(join(root, 'effect.txt'), 'exactly once\n'); return 'settled original effect' } }] })
await service.submit(id, 'crash boundary request', new AbortController().signal)
throw new Error('Controlled crash cut was not reached')
