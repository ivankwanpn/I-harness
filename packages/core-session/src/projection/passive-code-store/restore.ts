import type { SessionView } from '../../managed/types.ts'
import { replayLegacyCodeStore } from './legacy.ts'
import { normalizeInheritedCodeStore } from './inherited.ts'
import { replayPassiveCodeStore } from './replay.ts'
import { validatePassiveCodeStore } from './validate.ts'
import type { StoreReplay } from './types.ts'

/** Existing runtime reads already-loaded data; this grants no capture/owner
 * authority. Legacy locals retain their exact optional-seq/array-order fold. */
export function replaySessionCodeStore(view: SessionView, ownerId?: string): StoreReplay {
  if (view.header?.semanticSeed?.version !== 2 && !(view.header?.semanticSeed?.version === 3 && view.header.semanticSeed.profile === 'public-completed')) return { kind: 'value', entries: replayLegacyCodeStore(view, ownerId) }
  const manifest = view.events[0]
  if (manifest?.type !== 'conversation/seed-manifest' || !(manifest.version === 2 || manifest.version === 3 && manifest.profile === 'public-completed')) throw new TypeError('Invalid semantic seed')
  const data = validatePassiveCodeStore(manifest.passive.codeStore, manifest.turns, manifest.groupCount)
  const { effectiveBase, emptyBase } = normalizeInheritedCodeStore(view, data)
  const inherited = emptyBase ? { kind: 'value' as const, entries: [] } : replayPassiveCodeStore(data, effectiveBase)
  if (inherited.kind === 'limit-exceeded') return inherited
  const values = new Map(inherited.entries)
  for (const [key, value] of replayLegacyCodeStore(view, ownerId)) values.set(key, value)
  return { kind: 'value', entries: [...values] }
}
