import type { HistoryFact } from './facts.ts'
import { meldRewindCut, type RewindCut } from '../../projection/rewind.ts'

const boundaries = new Set(['step/start', 'step/end', 'step/failed', 'turn/start'])
type VisibilityFact = Pick<HistoryFact, 'type' | 'seq' | 'shadowedSeqs' | 'removedSeqs' | 'anchorSeq'>
export function historyVisibility(events: Iterable<VisibilityFact>, throughSeq?: number) {
  const selected = (event: VisibilityFact) => throughSeq === undefined || event.seq === undefined || event.seq <= throughSeq || event.type === 'compaction/prune'
  const shadowed = new Set<number>(), cuts: RewindCut[] = []
  for (const event of events) {
    if (!selected(event)) continue
    if (event.type === 'compaction/summary') for (const seq of event.shadowedSeqs!) shadowed.add(seq)
    else if (event.type === 'compaction/reset') for (const seq of event.removedSeqs ?? []) shadowed.add(seq)
    else if (event.type === 'rewind/point' && typeof event.seq === 'number' && typeof event.anchorSeq === 'number' && event.anchorSeq < event.seq) meldRewindCut(cuts, event.anchorSeq, event.seq)
  }
  const rewound = (event: VisibilityFact) => event.seq !== undefined && cuts.some(cut => event.seq! >= cut.cutFrom && event.seq! < cut.markerSeq)
  const hidden = (event: VisibilityFact) => event.seq !== undefined && shadowed.has(event.seq)
  return { selected, branch: (event: VisibilityFact) => selected(event) && !rewound(event),
    content: (event: VisibilityFact) => selected(event) && !rewound(event) && !hidden(event),
    lifecycle: (event: VisibilityFact) => selected(event) && !rewound(event) && (!hidden(event) || boundaries.has(event.type)), shadowed: hidden }
}
export type HistoryVisibility = ReturnType<typeof historyVisibility>
