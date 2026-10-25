import type { BootstrapCallerMetadata } from './coordinator/bootstrap-types.ts'

export interface ForkRequestCore {
  version: 1; kind: 'session-fork-core'; sourceSessionId: string;
  selection: { kind: 'completed'; atSeq?: number };
  sourceCapture: 'first-authorized-capture'; metadata: BootstrapCallerMetadata;
}
const invalid = (): never => { throw new TypeError('Invalid fork request core') }
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value as object).some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(descriptors, key))) invalid()
  const result: Record<string, any> = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) invalid()
    result[key] = descriptor.value
  }
  return result
}
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
/** Browser-only descriptor reader. Node hosts additionally reject proxies. */
export function readForkRequestCore(input: unknown): Readonly<ForkRequestCore> {
  const r = fields(input, ['version', 'kind', 'sourceSessionId', 'selection', 'sourceCapture', 'metadata'])
  if (r.version !== 1 || r.kind !== 'session-fork-core' || r.sourceCapture !== 'first-authorized-capture' || !id(r.sourceSessionId) || /[\\/\u0000-\u001f\u007f]/.test(r.sourceSessionId) || r.sourceSessionId.includes('..')) invalid()
  const selection = fields(r.selection, ['kind'], ['atSeq'])
  if (selection.kind !== 'completed' || selection.atSeq !== undefined && (!Number.isSafeInteger(selection.atSeq) || selection.atSeq < 0)) invalid()
  const metadata = fields(r.metadata, [], ['title', 'workspaceId', 'modelSelection'])
  if (metadata.title !== undefined && (typeof metadata.title !== 'string' || new TextEncoder().encode(metadata.title).length > 32768) || metadata.workspaceId !== undefined && !id(metadata.workspaceId)) invalid()
  if (metadata.modelSelection !== undefined) {
    const m = fields(metadata.modelSelection, ['provider', 'model'], ['protocol', 'reasoningEffort'])
    if (!id(m.provider) || !id(m.model) || m.reasoningEffort !== undefined && !id(m.reasoningEffort) || m.protocol !== undefined && !['openai-completions', 'openai-responses', 'anthropic-messages', 'gemini', 'bedrock'].includes(m.protocol)) invalid()
    metadata.modelSelection = Object.freeze(m)
  }
  return Object.freeze({ version: 1, kind: 'session-fork-core', sourceSessionId: r.sourceSessionId, selection: Object.freeze(selection), sourceCapture: 'first-authorized-capture', metadata: Object.freeze(metadata) }) as Readonly<ForkRequestCore>
}
