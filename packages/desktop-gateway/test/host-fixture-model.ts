import { afterEach } from 'vitest'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import type { buildModelClient } from '../../provider/src/index.ts'
import type { createHostFixtureTrace } from './host-fixture-trace.ts'

// Capture the native transport before a test installs any global spy. Each
// host retains its own origin check for its complete lifetime, including drain.
const nativeFetch = globalThis.fetch
const transports = new Map<string, typeof globalThis.fetch>()
afterEach(() => { globalThis.fetch = nativeFetch; transports.clear() })

export function createHostFixtureModel(origin: string, trace?: ReturnType<typeof createHostFixtureTrace>): typeof buildModelClient {
  const expected = new URL(origin)
  if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' || expected.origin !== origin) throw new Error('Host fixture requires an exact loopback origin')
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== origin) throw new Error('Host fixture refused a provider request outside its own loopback origin')
    const request = () => nativeFetch(input, { ...init, redirect: 'error' })
    return trace ? trace.run('model/fetch', request) : request()
  }
  transports.set(origin, fetch)
  // Deny-by-default process boundary is installed before creating any client.
  // The actual built-in terminal still owns the global fetch handoff.
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const transport = transports.get(url.origin)
    if (!transport) throw new Error('Host fixture refused an unregistered network destination')
    return transport(input, init)
  }
  return (profile, model, extra) => {
    if (profile.protocol !== 'openai-compatible' || !profile.baseUrl || new URL(profile.baseUrl).origin !== origin || !model) {
      throw new Error('Host fixture refused a provider outside its own loopback model route')
    }
    const config = { apiKey: profile.apiKey ?? '', baseUrl: profile.baseUrl, model, providerId: profile.name,
      options: extra, inputModalities: profile.inputModalities, maxTokensField: profile.maxTokensField, usageInStream: profile.usageInStream,
      promptCache: profile.promptCache, headers: profile.headers }
    return createOpenAICompatibleClient(config)
  }
}
