import { historyEntries, type HistoryArchive, type HistoryFact } from './facts.ts'
import { meldRewindCut, type RewindCut } from '../../projection/rewind.ts'

const boundaries = new Set(['step/start', 'step/end', 'step/failed', 'turn/start'])
export function historyVisibility(archive: HistoryArchive, throughSeq?: number) {
  const selected = (event: HistoryFact) => throughSeq === undefined || event.seq === undefined || event.seq <= throughSeq || event.type === 'compaction/prune'
  const shadowed = new Set<number>(), cuts: RewindCut[] = []
  for (const [, event] of historyEntries(archive)) {
    if (!selected(event)) continue
    if (event.type === 'compaction/summary') for (const seq of event.shadowedSeqs!) shadowed.add(seq)
    else if (event.type === 'compaction/reset') for (const seq of event.removedSeqs!) shadowed.add(seq)
    else if (event.type === 'rewind/point' && typeof event.seq === 'number' && typeof event.anchorSeq === 'number' && event.anchorSeq < event.seq) meldRewindCut(cuts, event.anchorSeq, event.seq)
  }
  const rewound = (event: HistoryFact) => event.seq !== undefined && cuts.some(cut => event.seq! >= cut.cutFrom && event.seq! < cut.markerSeq)
  const hidden = (event: HistoryFact) => event.seq !== undefined && shadowed.has(event.seq)
  return { selected, branch: (event: HistoryFact) => selected(event) && !rewound(event),
    content: (event: HistoryFact) => selected(event) && !rewound(event) && !hidden(event),
    lifecycle: (event: HistoryFact) => selected(event) && !rewound(event) && (!hidden(event) || boundaries.has(event.type)), shadowed: hidden }
}
export type HistoryVisibility = ReturnType<typeof historyVisibility>
