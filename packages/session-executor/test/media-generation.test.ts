import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createReadVideoTool } from '../../media/src/index.ts'
import { createProviderRuntime } from '../../provider-runtime/src/index.ts'
import { SettingsStore } from '@i-harness/settings'
import { createCredentialStore, createProviderAuthResolver } from '../../credentials/src/index.ts'
import { PNG } from '../../image-validation/test/fixtures.ts'
import { createSessionService } from '../src/index.ts'
import { subscribe } from '@i-harness/core-session'

afterEach(() => vi.unstubAllGlobals())
it.each([['off', false], ['off', true], ['only', false], ['late', false], ['late', true], ['auth', true], ['steer', false]] as const)('actual %s read_video opens before decode and bounds audio transport with Stop=%s', async (mode, stop) => {
  const root = await mkdtemp(join(tmpdir(), 'ih-media-generation-'))
  await writeFile(join(root, 'clip.mp4'), 'synthetic decoder fixture')
  let main = 0, audio = 0
  const wires: string[] = [], transforms: string[] = []
  const background = mode === 'late' || mode === 'steer'
  const direct = mode === 'off' || mode === 'auth'
  const gateEntered = Promise.withResolvers<void>(), releaseGate = Promise.withResolvers<void>()
  const authEntered = Promise.withResolvers<void>(), releaseAuth = Promise.withResolvers<void>()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === 'https://media-audio.fixture.invalid/v1/chat/completions') {
      audio++; expect(init.redirect).toBe('error')
      return Response.json({ choices: [{ message: { content: 'A synthetic tone is audible.' } }] })
    }
    if (url !== 'https://media-main.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination')
    wires.push(String(init.body))
    main++
    const code = (background ? 'const pending = tools.fixture_gate({}); ' + (mode === 'late' ? 'await yield_control(); ' : '') + 'await pending; ' : '') + 'text(await tools.read_video({path:"clip.mp4"}));'
    const delta = main === 1 ? { tool_calls: [{ index: 0, id: 'video-call', type: 'function', function: { name: direct ? 'read_video' : 'code_exec', arguments: JSON.stringify(direct ? { path: 'clip.mp4' } : { code }) } }] } : { content: 'Video checked.' }
    return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: main === 1 ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
  const settings = new SettingsStore({ path: join(root, 'settings.json') }); await settings.load()
  await settings.set({ llm: { providers: { audio: { protocol: 'openai-completions', baseURL: 'https://media-audio.fixture.invalid', apiKeyEnv: 'SYNTHETIC_AUDIO' } }, defaultModel: { provider: '', model: '' }, videoAudio: { provider: 'audio', model: 'synthetic-audio' } } })
  const credentials = createCredentialStore(join(root, 'credentials.json')); await credentials.set('SYNTHETIC_AUDIO', 'fixture-only')
  const baseAuth = createProviderAuthResolver(credentials)
  const runtime = createProviderRuntime({ settings, credentials, auth: { describe: ref => baseAuth.describe(ref), resolve: async (ref, context) => {
    if (mode === 'auth') { authEntered.resolve(); await releaseAuth.promise }
    return baseAuth.resolve(ref, context)
  } } })
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'synthetic-main', baseUrl: 'https://media-main.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: direct ? 'off' : 'only' }, ...(background ? { modelActionTimeoutMs: 1000 } : {}), transformPrompt: async (_assembly, text) => { transforms.push(text); return text === '/new-guidance' ? 'expanded steer guidance' : text } })
  const assembly = await service.assemblyFor(id), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(), controller = new AbortController()
  const cellClosed = Promise.withResolvers<void>()
  const unsubscribe = subscribe(assembly.session, event => { if (event.type === 'code/cell' && ['completed', 'failed', 'terminated', 'interrupted'].includes(event.state)) cellClosed.resolve() })
  assembly.tools.register({ name: 'fixture_gate', description: 'Controlled test gate.', inputSchema: { type: 'object', properties: {} }, isReadOnly: true, isConcurrencySafe: true, execute: async () => { gateEntered.resolve(); await releaseGate.promise; return { released: true } } })
  assembly.tools.unregister('read_video')
  assembly.tools.register(createReadVideoTool({ workspace: root, analyzeAudio: input => runtime.analyzeVideoAudio!(input), decoder: async () => {
    entered.resolve(); await released.promise
    return { sourceDurationSeconds: 1, startSeconds: 0, durationSeconds: 1, frames: [{ timestampSeconds: 0, image: { mediaType: 'image/png', dataBase64: PNG } }], wav: new Uint8Array(44) }
  } }))
  const run = service.submit(id, 'Inspect this synthetic video.', controller.signal); void run.catch(() => {})
  try {
    if (background) {
      await Promise.race([gateEntered.promise, run.then(() => { if (!assembly.liveResources?.().codeCells.length) throw new Error('Turn ended without a live yielding cell') })])
      if (mode === 'steer') await assembly.inbox.admit({ inputId: 'steer-guidance', text: '/new-guidance', delivery: 'steer', intent: 'user', preparationPolicy: 'human-host', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } })
      await run
      if (mode === 'steer') {
        expect(transforms.filter(text => text === '/new-guidance')).toHaveLength(1)
        expect(wires[1]).toContain('/new-guidance')
        expect(wires[1]).toContain('expanded steer guidance')
      }
      const prior = assembly.session.events.find(event => event.type === 'context/action' && event.op === 'open')!
      if (prior.type === 'context/action' && prior.op === 'open') await new Promise(resolve => setTimeout(resolve, Math.max(0, prior.expiresAt - Date.now() + 10)))
      expect(audio).toBe(0)
      if (stop) {
        const cellId = assembly.liveResources!().codeCells[0]!.id, stopping = assembly.stopCodeCell!(cellId)
        releaseGate.resolve(); await stopping; await cellClosed.promise
        expect(audio).toBe(0)
        expect(assembly.session.events.filter(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'media')).toHaveLength(0)
        return
      }
      releaseGate.resolve()
      await Promise.race([entered.promise, cellClosed.promise.then(() => { throw new Error('Yielding cell closed before its late decoder') })])
    } else await Promise.race([entered.promise, run.then(() => { throw new Error('Turn ended before decoder entered') })])
    const held = (await backend.read(id)).events
    expect(held.filter(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'media')).toHaveLength(1)
    expect(audio).toBe(0)
    if (stop && mode !== 'auth') controller.abort()
    released.resolve()
    if (mode === 'auth') {
      await Promise.race([authEntered.promise, run.then(() => { throw new Error('Turn ended without audio credentials') })])
      controller.abort(); releaseAuth.resolve()
    }
    await run.catch(error => { if (!stop) throw error })
    if (background) await cellClosed.promise
    expect(audio).toBe(stop ? 0 : 1)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve' && event.payloadKind === 'audio-json-body')).toHaveLength(stop ? 0 : 1)
    expect(JSON.stringify(events.filter(event => event.type === 'context/action' || event.type === 'context/attempt'))).not.toContain('input_audio')
  } finally { releaseAuth.resolve(); releaseGate.resolve(); released.resolve(); await run.catch(() => {}); await service.close().catch(() => {}); unsubscribe(); await coordinator.close().catch(() => {}) }
})
