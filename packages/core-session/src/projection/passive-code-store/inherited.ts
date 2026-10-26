import type { SessionView } from '../../managed/types.ts'
import { meldRewindCut, originalRewindWindows, type OriginalWindow, type RewindCut } from '../rewind.ts'
import type { PassiveCodeStoreV1 } from './types.ts'

/** Capture and ordinary restore share original physical→inherited aliases.
 * Ordered cut IDs retain observations even when different cuts have equal ends. */
export function normalizeInheritedCodeStore(view: SessionView, data: PassiveCodeStoreV1, selectedBase = data.latest,
  originalWindows: readonly OriginalWindow[] = originalRewindWindows(view)) {
  let effectiveBase = selectedBase, emptyBase = false
  const translated: RewindCut[] = [], seedLength = view.header?.seedLength ?? 0
  for (const window of originalWindows) {
    let start: number
    if (window.startRank < seedLength) {
      const event = view.events[window.startRank]
      const cut = event?.type === 'conversation/seed-group' ? data.groups[event.ordinal] : window.startRank === 0 ? undefined : data.latest
      if (event?.type === 'conversation/seed-group' && cut === undefined) throw new TypeError('Invalid semantic seed')
      if (cut === undefined) { emptyBase = true; start = 0 }
      else { effectiveBase = Math.min(effectiveBase, cut); start = data.cuts[cut]!.end }
    } else start = data.rows.length + window.startRank
    meldRewindCut(translated, start, data.rows.length + window.endRank)
  }
  return { effectiveBase, emptyBase, translated }
}
