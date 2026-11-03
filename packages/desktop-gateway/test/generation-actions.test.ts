import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '@i-harness/session-executor'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createDesktopInput } from '../src/input.ts'
import { PNG } from '../../image-validation/test/fixtures.ts'

afterEach(() => vi.unstubAllGlobals())
const success = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

it('queued-only Desktop receipt cold-resumes exact raw/context/image content without resolving during admission or reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-desktop-cold-input-')), backend = createJsonlBackend(root)
  let resolutions = 0, transforms = 0
  const wire: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { if (url !== 'https://desktop-cold.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); wire.push(String(init.body)); return success() })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://desktop-cold.fixture.invalid', inputModalities: ['text', 'image'] })
  const bind = async () => { resolutions++; return { status: 'ready' as const, binding: { providerId: 'fixture', modelId: 'fixture', label: 'fixture', model } } }
  const first = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await first.create()
  const service = createSessionService({ workspace: root, coordinator: first, codeMode: { mode: 'off' }, modelBindingFor: bind })
  const input = createDesktopInput(first, service, { prepare: async () => { transforms++; return 'exact saved expansion' } })
  const raw = { text: '/cold-fixture', context: 'exact supplemental bytes', images: [{ mediaType: 'image/png' as const, dataBase64: PNG }], delivery: 'queue' as const, clientToken: 'cold-fixture-token', start: false }
  const admitted = await input.admit(id, raw)
  expect((await input.state(id)).resumable).toBe(true)
  expect(resolutions).toBe(0); expect(transforms).toBe(0); expect(wire).toHaveLength(0)
  expect((await backend.read(id)).events.filter(event => event.type === 'context/action' || event.type === 'agent/input/preparation')).toHaveLength(0)
  await input.close(); await service.close(); await first.close()
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const nextService = createSessionService({ workspace: root, coordinator, codeMode: { mode: 'off' }, modelBindingFor: bind })
  const nextInput = createDesktopInput(coordinator, nextService, { prepare: async () => { transforms++; return 'exact saved expansion' } })
  try {
    expect((await nextInput.state(id)).resumable).toBe(true)
    expect(resolutions).toBe(0)
    await nextInput.resume(id); await nextInput.drain()
    expect(resolutions).toBe(1); expect(transforms).toBe(1); expect(wire).toHaveLength(1)
    for (const content of ['/cold-fixture', 'exact supplemental bytes', 'exact saved expansion']) expect(wire[0]).toContain(content)
    expect((wire[0]!.match(/data:image\/png;base64/g) ?? [])).toHaveLength(1)
    expect(await nextInput.admit(id, raw)).toEqual(admitted)
    await nextInput.drain()
    expect(transforms).toBe(1); expect(wire).toHaveLength(1)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
    expect(events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(1)
  } finally { await nextInput.close(); await nextService.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('Desktop retains raw input before its held resolver and deduplicates effectful preparation by the original token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-desktop-generation-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let calls = 0, transforms = 0
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://desktop-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); calls++; return success() })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://desktop-generation.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, codeMode: { mode: 'off' }, modelBindingFor: async () => {
    entered.resolve(); await release.promise
    return { status: 'ready', binding: { providerId: 'fixture', modelId: 'fixture', label: 'fixture', model } }
  } })
  const input = createDesktopInput(coordinator, service, { prepare: async () => { transforms++; return 'derived expansion' } })
  const raw = { text: '/fixture', delivery: 'queue' as const, clientToken: 'fixture-token-1234' }
  const admission = input.admit(id, raw)
  void admission.catch(() => {})
  try {
    await entered.promise
    const held = (await backend.read(id)).events
    expect(held.filter(event => event.type === 'agent/input/admitted').map(event => event.text)).toEqual(['/fixture'])
    expect(held.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(1)
    expect(transforms).toBe(0)
    expect(calls).toBe(0)
    release.resolve()
    const first = await admission, duplicate = await input.admit(id, raw)
    expect(duplicate).toEqual(first)
    await input.drain()
    expect(calls).toBe(1)
    expect(transforms).toBe(1)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'agent/input/preparation').map(event => event.op)).toEqual(['started', 'completed', 'promoted'])
    expect(events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(1)
  } finally { release.resolve(); await admission.catch(() => {}); await input.close(); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
