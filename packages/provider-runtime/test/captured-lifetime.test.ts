import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '@i-harness/settings'
import { createProviderRegistry, type ProviderProfile } from '@i-harness/provider'
import { createCredentialStore } from '@i-harness/credentials'
import { createProviderRuntime } from '../src/index.ts'
it('detaches captured API-key/config aliases and keeps the epoch across wait-only rebuilds with no extra auth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-r2b2-capture-'))
  try {
    const settings = new SettingsStore({ path: join(root,'settings.json') }); await settings.load()
    await settings.set({ llm: { providers: { fixture: { apiKeyEnv: 'FAKE' } }, defaultModel: { provider: 'fixture', model: 'm' } } })
    const registry = createProviderRegistry(), headers = { 'x-fixture': 'original' }
    const template: ProviderProfile = { name: 'fixture', displayName: 'fixture', protocol: 'openai-compatible', headers, promptCache: { mode: 'off' } }
    registry.register(template)
    let authCalls = 0
    const builds: ProviderProfile[] = []
    const runtime = createProviderRuntime({ settings, registry, credentials: createCredentialStore(join(root,'keys.json')), auth: { async describe() { throw Error('must not inspect auth') }, async resolve() { authCalls++; return { kind: 'api-key', value: 'controlled' } } }, buildClient(profile) { builds.push(profile); return { async *stream() { yield { type: 'end' } } } } })
    const first = await runtime.resolveModel({}); if (first.status !== 'ready') throw Error(JSON.stringify(first))
    const epoch = first.binding.client.executionIdentity!.authEpoch
    headers['x-fixture'] = 'mutated'; template.baseUrl = 'https://changed.invalid'; template.promptCache!.mode = 'automatic'
    await settings.set({ modelWait: { firstResponseSeconds: 30, progressSeconds: 0 } })
    await first.binding.client.prepare!({ systemPrompt: '', tools: [], messages: [] })
    expect(builds).toHaveLength(2)
    for (const profile of builds) { expect(profile.headers?.['x-fixture']).toBe('original'); expect(profile.baseUrl).not.toBe('https://changed.invalid'); expect(profile.executionIdentity?.authEpoch).toBe(epoch) }
    expect(authCalls).toBe(1)
    const fresh = await runtime.resolveModel({}); if (fresh.status !== 'ready') throw Error(JSON.stringify(fresh))
    expect(fresh.binding.client.executionIdentity!.authEpoch).not.toBe(epoch)
    expect(authCalls).toBe(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
