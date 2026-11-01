import type { createInstructionViews } from './views.ts'
type Views = ReturnType<typeof createInstructionViews>
type Settings = ReturnType<typeof import('./settings.ts').createInstructionSettings>
const id = (value: unknown, name: string) => { if (typeof value !== 'string' || !value || value.length > 256) throw new Error(`Invalid ${name}`); return value }
export async function instructionRequest(views: Views, method: string, raw: unknown, settings?: Settings): Promise<unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid instruction request')
  const params = raw as Record<string, unknown>
  if (method === 'desktop/instructions/settings') { if (!settings || Object.keys(params).length) throw new Error('Invalid instruction settings request'); return settings.state() }
  if (method === 'desktop/instructions/configure') { if (!settings || Object.keys(params).some(key => key !== 'patch') || !Object.hasOwn(params, 'patch')) throw new Error('Invalid instruction settings request'); return settings.configure(params.patch) }
  if (method === 'desktop/instructions/unsubscribe') { const subscriptionId = id(params.subscriptionId, 'subscription'); if (Object.keys(params).some(key => key !== 'subscriptionId')) throw new Error('Invalid instruction fields'); views.unsubscribe(subscriptionId); return { unsubscribed: true } }
  if (Object.keys(params).some(key => key !== 'sessionId' && key !== 'childSessionId')) throw new Error('Invalid instruction fields')
  const sessionId = id(params.sessionId, 'session'), childSessionId = params.childSessionId === undefined ? undefined : id(params.childSessionId, 'child session')
  const scope = { sessionId, ...(childSessionId ? { childSessionId } : {}) }
  if (method === 'desktop/instructions/state') return views.snapshotReply(scope)
  if (method === 'desktop/instructions/refresh') return views.snapshotReply(scope, true)
  if (method === 'desktop/instructions/subscribe') return views.subscribe(scope)
  throw new Error('Unknown instruction method')
}
