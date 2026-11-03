import type { ModelClient } from '../index.ts'
import { generationError } from './generation.ts'

const sources = new WeakMap<ModelClient, () => ModelClient>()
/** Package-private registration by fixed mapping/wait/retry/observation and
 * stable-handle implementations; no arbitrary public wrapper can opt in. */
export function rememberModelSource(client: ModelClient, source: () => ModelClient): void { sources.set(client, source) }
export function modelExecutionSource(client: ModelClient): ModelClient {
  const visited = new Set<ModelClient>()
  let current = client
  while (sources.has(current)) {
    if (visited.has(current)) throw generationError('GENERATION_UNSUPPORTED')
    visited.add(current); current = sources.get(current)!()
  }
  return current
}
