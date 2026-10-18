import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
const backend = createJsonlBackend(root), append = backend.appendOwnedBatch!.bind(backend)
const crash = () => { process.stdout.write('AT_CUT\n'); process.exit(0) }
backend.appendOwnedBatch = async (...args) => {
  const frame = JSON.parse(Buffer.from(args[3].bytes).toString('utf8')), events = frame.events as { type: string; op?: string }[]
  if (cut === 'before-reservation' && events.some(event => event.type === 'context/attempt' && event.op === 'reserve')) crash()
  if (cut === 'output-before-acceptance' && events.some(event => event.type === 'model/exchange-accepted')) crash()
  const result = await append(...args)
  if (cut === 'reservation-before-handoff' && events.some(event => event.type === 'context/attempt' && event.op === 'reserve')) crash()
  if (cut === 'settled-tool' && events.some(event => event.type === 'tool/result')) crash()
  return result
}
const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
await coordinator.create({ sessionId: id })
const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: endpoint })
const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, additionalTools: [{ name: 'crash_effect', description: 'Controlled crash effect.', inputSchema: { type: 'object', properties: {} }, isReadOnly: true, async execute() { await writeFile(join(root, 'effect.txt'), 'exactly once'); return 'settled original effect' } }] })
await service.submit(id, 'crash boundary request', new AbortController().signal)
throw new Error('Controlled crash cut was not reached')
