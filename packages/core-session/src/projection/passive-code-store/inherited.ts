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
      let cut = event?.type === 'conversation/seed-group' ? data.groups[event.ordinal] : window.startRank === 0 ? undefined : data.latest
      if (view.header?.semanticSeed?.version === 3 && event?.type !== 'conversation/seed-group' && window.startRank !== 0) {
        if (event?.type !== 'conversation/seed-results' || event.page.extent.kind !== 'framed') throw new TypeError('Unavailable inherited result cut')
        const extent = event.page.extent
        if (extent.first !== extent.last) throw new TypeError('Partial inherited result cut')
        const manifest = view.events[0]
        if (manifest?.type !== 'conversation/seed-manifest' || manifest.version !== 3 || manifest.profile !== 'public-completed') throw new TypeError('Invalid semantic seed')
        // A page names a turn, not a physical CodeStore chronology position.
        // Require that turn's actual group anchor, or a proved completed cut
        // immediately before it. Never substitute latest for a missing alias.
        const group = view.events.find(record => record.type === 'conversation/seed-group' && record.group.extent.kind === 'framed' && record.group.extent.first === extent.first && record.group.extent.last === extent.last)
        cut = group?.type === 'conversation/seed-group' ? data.groups[group.ordinal] : extent.first === 1 ? undefined : data.completed.find(entry => entry.turn === extent.first - 1)?.cut
        if (cut === undefined) throw new TypeError('Unavailable inherited result cut')
      }
      if (event?.type === 'conversation/seed-group' && cut === undefined) throw new TypeError('Invalid semantic seed')
      if (cut === undefined) { emptyBase = true; start = 0 }
      else { effectiveBase = Math.min(effectiveBase, cut); start = data.cuts[cut]!.end }
    } else start = data.rows.length + window.startRank
    meldRewindCut(translated, start, data.rows.length + window.endRank)
  }
  return { effectiveBase, emptyBase, translated }
}
