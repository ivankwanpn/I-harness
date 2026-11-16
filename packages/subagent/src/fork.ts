import { CURRENT_FORMAT_VERSION, copyConversationData, isContextEventType, type SessionEvent, type SessionEventView, type SessionView } from "@i-harness/core-session"
import { remapConversationSeed, SessionForkUnavailableError } from "@i-harness/session-persistence"

/** The last N parent turns as a child's SEED — in the CHILD's coordinates.
 *
 * M74: this used to return a raw slice, so a parent's compaction markers
 * carried the parent's seq numbers into a log that starts at 0. With "all" the
 * indices coincide; with N they name unrelated events, and a summary's
 * `shadowedSeqs` would hide the child's own turn (itself included) — silent
 * content loss with no test covering it. The remap is the SAME one the session
 * fork has always applied (session-persistence's `remapSeedEvent`): renumber to
 * the child's coordinates, and drop references into events this child never
 * received. `append` only rewrites an event's own `seq`, never the seqs it
 * NAMES — which is exactly why this pass has to exist here.
 *
 * M76: `anchorSeq` WAS the one reference out of that contract — the fallthrough
 * rewrote `seq` and left the anchor in the PARENT's coordinates, so a seed
 * carrying a rewind marker located its cut window wrongly, and the error
 * direction was UNDER-hiding: the stale anchor is never below the child-side one,
 * the window `rewindCuts` resolves is a subset of the correct one, and part or
 * all of the rewound region could stay VISIBLE in the child (when the anchor
 * lands at or past the marker's child-side seq, `rewindCuts` drops the window
 * entirely — `anchorSeq >= seq`). It is the same KIND of reference the three
 * above are — it names a seq — so it now rides the same map. One boundary is
 * worth naming: an anchor this seed never received (the slice begins INSIDE the
 * window the marker opened, so nothing on this side can be its target) opens the
 * window on the child's FIRST event — everything this child owns before the
 * marker was hidden on the parent's surface, and a stale parent coordinate would
 * instead name an unrelated event here.
 *
 * The session fork resolves the same marker the other way, and still does: it
 * DROPS rewind markers (packages/session-persistence/src/fork.ts:115-120, filter
 * at :150-152), because its child never had the rewound turns at all — copying a
 * marker there would assert a window over a region that log does not contain.
 * This path keeps it (the slice is a contiguous tail of the parent's log, so the
 * events it hides can be in it), which is why the reference has to MOVE here
 * rather than vanish.
 *
 * SEMANTIC-SEED PARENT: a session that is itself a fork carries its inherited
 * conversation as `conversation/seed-manifest` + `conversation/seed-group`
 * bootstrap records, not as raw events (session-persistence's fork publishes a
 * semantic seed target). A child seed, by contrast, is still the legacy event
 * prefix `openChildDocument` appends, so this function first MATERIALIZES those
 * seed groups into the events they stand for (`materializeSeedView`): input
 * items become `user/message` observations (a prepared observation keeps its
 * `seedInputContext` link to the materialized raw human message), summaries
 * become `compaction/summary`, and pure-text exchanges become
 * `assistant/message`, turn-framed by the item extents. Only after that does the
 * ordinary coordinate remap run, with the semantic header's bootstrap claims
 * dropped because the materialized projection carries no seed records. */
export function forkTurns(events: readonly SessionEventView[], n: number, sourceFormat = CURRENT_FORMAT_VERSION, sourceHeader?: SessionView['header']): SessionEvent[] {
  const source = materializeSeedView(events, sourceHeader) ?? events
  const seed = sliceTurns(source, n).filter(event => !isContextEventType(event.type))
  // Every return path goes through the remap, including the untouched ones: for
  // a POSITIONAL whole-log seed (seq === index, what `append` writes) it is the
  // identity, and making it unconditional is what keeps the contract ("the output
  // is in child coordinates") true for all of them — a non-positional log (M51,
  // `repair.test.ts:289-302`: seqs [0, 20]) legitimately re-indexes instead.
  return remapConversationSeed({ sourceFormat, sourceHeader, source, retained: seed })
}

function sliceTurns(events: readonly SessionEventView[], n: number): readonly SessionEventView[] {
  if (n === 0) return []
  const turnStarts: number[] = []
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type === "turn/start") turnStarts.push(i)
  }
  if (turnStarts.length === 0) return events
  if (turnStarts.length <= n) return events
  return events.slice(turnStarts[turnStarts.length - n]!)
}

type SeedGroupItemView = Extract<SessionEventView, { type: "conversation/seed-group" }>["group"]["items"][number]
type SeedAddressView = SeedGroupItemView["origins"][number]

/** `undefined` keeps the ordinary live-view path byte-for-byte. A semantic seed
 * view is recognized by its leading manifest record — the same record the
 * bootstrap header names — so a normal (seed-free) log is never re-read here. */
function materializeSeedView(events: readonly SessionEventView[], header: SessionView['header']): readonly SessionEventView[] | undefined {
  if (events[0]?.type !== "conversation/seed-manifest") return undefined
  const declared = header?.seedLength
  const bootstrap = typeof declared === "number" ? declared : events.findIndex(event => event.type === "session/bootstrap")
  if (!Number.isSafeInteger(bootstrap) || bootstrap < 1 || events[bootstrap]?.type !== "session/bootstrap")
    throw new SessionForkUnavailableError("semantic seed view requires its complete bootstrap record")
  // A seeded child that has since appended its own turns keeps those as raw
  // events after the bootstrap. Materializing only the inherited prefix and
  // renumbering the live suffix is not implemented yet, and dropping the suffix
  // would silently lose the child's own conversation, so this refuses instead.
  if (events.length > bootstrap + 1) throw new SessionForkUnavailableError("semantic seed view with appended child turns cannot be materialized as a legacy seed")
  let next = 0
  const seq = () => next++
  const inherited: SessionEventView[] = []
  const messageSeqs = new Map<string, number>()
  let turn: number | undefined
  const closeTurn = () => {
    if (turn === undefined) return
    inherited.push({ type: "turn/end", seq: seq() })
    turn = undefined
  }
  for (const record of events.slice(0, bootstrap)) {
    if (record.type !== "conversation/seed-group") continue
    for (const item of record.group.items) {
      if (item.extent.kind === "framed") {
        if (item.extent.first !== turn) {
          closeTurn()
          inherited.push({ type: "turn/start", seq: seq() })
          turn = item.extent.first
        }
      } else closeTurn()
      inherited.push(...materializeSeedItem(item, seq, messageSeqs))
    }
  }
  closeTurn()
  return inherited
}

function seedAddress(address: SeedAddressView): string { return `${String(address.origin)}:${String(address.seq)}` }

function materializeSeedItem(item: SeedGroupItemView, seq: () => number, messageSeqs: Map<string, number>): SessionEvent[] {
  if (item.kind === "summary") {
    const message = singleTextMessage(item)
    return [{ type: "compaction/summary", text: message, shadowedSeqs: [], seq: seq() }]
  }
  if (item.kind === "input") {
    if (item.input.media.length) throw new SessionForkUnavailableError("semantic seed input media cannot be materialized as a legacy seed")
    const text = singleTextMessage(item)
    const own = item.input.raw.find(address => address.part === "message")
    if (!own) throw new SessionForkUnavailableError("semantic seed input item has no source message address")
    const key = seedAddress(own), provenance = item.sourceProvenance[0], producer = item.producer ?? provenance?.producer
    // A host preparation observation is the one input shape whose seed carries
    // MORE than its own message origin: the second message address is the raw
    // human message it was derived from (`SeedItem.input.derivedContext`).
    const derived = provenance?.kind === "plugin" && provenance.authority === "observation"
      && (producer === "host-preparation" || producer === "supplemental-context")
    const raw = derived ? rawSourceSeq(item, key, messageSeqs) : undefined
    if (derived && raw === undefined) throw new SessionForkUnavailableError("semantic seed prepared observation has no materialized raw source message")
    const event: SessionEvent = derived
      ? { type: "user/message", text, internal: true, source: { kind: "plugin", plugin: producer! },
          provenance: { kind: "inherited", authority: "observation", scope: item.scope, producer: "host.input-preparation" },
          seedInputContext: { rawMessageSeq: raw! }, seq: seq() }
      : { type: "user/message", text, provenance: { kind: "inherited", authority: "observation", scope: item.scope, producer: producer ?? "session.seed" }, seq: seq() }
    messageSeqs.set(key, event.seq!)
    return [event]
  }
  // Tool authority (call identity, dispatch/dispatch-less state, retained result
  // payload and its envelope) is not carried by a semantic seed group: only the
  // rendered messages and metadata are. Materializing an exchange would then
  // fabricate authority this seed never recorded, so it refuses instead of
  // silently dropping the calls or their results.
  if (item.calls.length || item.results.length || item.messages.some(message => message.role !== "assistant" || message.toolCalls?.length))
    throw new SessionForkUnavailableError("semantic seed exchange with tool authority cannot be materialized as a legacy seed")
  return item.messages.flatMap((message): SessionEvent[] => {
    if (message.role !== "assistant") throw new SessionForkUnavailableError("semantic seed exchange has a non-assistant message")
    const thinkingBlocks = message.thinkingBlocks
    const providerContinuation = message.providerContinuation
    return [{ type: "assistant/message", text: message.content, seq: seq(),
      ...(thinkingBlocks?.length ? { thinkingBlocks: copyConversationData(thinkingBlocks) } : {}),
      ...(providerContinuation ? { providerContinuation: copyConversationData(providerContinuation) } : {}) }]
  })
}

function singleTextMessage(item: SeedGroupItemView): string {
  const message = item.messages.length === 1 ? item.messages[0] : undefined
  if (!message || message.role !== "user" || typeof message.content !== "string")
    throw new SessionForkUnavailableError("semantic seed item has no single text message")
  return message.content
}

/** The raw human message this prepared observation derives from, already
 * materialized (and therefore already in child-seed coordinates). */
function rawSourceSeq(item: SeedGroupItemView, own: string, messageSeqs: ReadonlyMap<string, number>): number | undefined {
  if (item.kind !== "input") return undefined
  for (const address of item.input.raw) {
    if (address.part !== "message") continue
    const key = seedAddress(address)
    if (key === own) continue
    const seq = messageSeqs.get(key)
    if (seq !== undefined) return seq
  }
  return undefined
}
