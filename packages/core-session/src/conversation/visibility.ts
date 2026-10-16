import type { SessionEventView as SessionEvent } from "../managed/types.ts"
import type { SessionView as Session } from "../managed/types.ts"
import { meldRewindCut, type RewindCut } from "../projection/rewind.ts"

const boundaries = new Set(["step/start", "step/end", "step/failed", "turn/start"])

/** Compaction hides content, while rewind also removes abandoned lifecycle. */
export function conversationVisibility(session: Session, throughSeq?: number) {
  const selected = (event: SessionEvent) => throughSeq === undefined || event.seq === undefined || event.seq <= throughSeq || event.type === "compaction/prune"
  const shadowed = new Set<number>()
  const cuts: RewindCut[] = []
  for (const event of session.events) {
    if (!selected(event)) continue
    if (event.type === "compaction/summary") for (const seq of event.shadowedSeqs) shadowed.add(seq)
    else if (event.type === "compaction/reset") for (const seq of event.removedSeqs ?? []) shadowed.add(seq)
    else if (event.type === "rewind/point" && typeof event.seq === "number" && typeof event.anchorSeq === "number" && event.anchorSeq < event.seq) {
      meldRewindCut(cuts, event.anchorSeq, event.seq)
    }
  }
  const rewound = (event: SessionEvent) => event.seq !== undefined && cuts.some(cut => event.seq! >= cut.cutFrom && event.seq! < cut.markerSeq)
  const hidden = (event: SessionEvent) => event.seq !== undefined && shadowed.has(event.seq)
  return {
    selected,
    branch: (event: SessionEvent) => selected(event) && !rewound(event),
    content: (event: SessionEvent) => selected(event) && !rewound(event) && !hidden(event),
    lifecycle: (event: SessionEvent) => selected(event) && !rewound(event) && (!hidden(event) || boundaries.has(event.type)),
    shadowed: hidden,
  }
}

export type ConversationVisibility = ReturnType<typeof conversationVisibility>
