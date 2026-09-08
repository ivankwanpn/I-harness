# M52 research — Rewind cold-start recovery (I-harness)

Date: 2026-09-08 · HEAD: `d7c1631` (main) · Scope: read-only investigation of the M49 far-future queue
item 「Rewind 冷啟動恢復」. Evidence: source read + 5 local probes against the real
`RewindStore`/`RewindRecorder`/`RewindService` and the real `session-persistence` coordinator +
jsonl backend (scripts in the OS temp dir, not committed; outputs pasted verbatim).

**Verdict in one line: the engine side of a cold start already works (points/plan/execute and the
journal-derived `turnIndex` all survive a restart), but the session side does not — `rewind/point`
is never registered with `session-persistence`'s load gate, so *any session that has had a rewind
applied becomes unloadable after a restart* (`SessionFormatUnsupportedError`); a mid-turn crash
silently loses the turn's point and its pre-images, leaving orphan files invisible to `plan()`.**

---

## 1. What works today across a restart, and what does not

### 1.1 Points list — **works**

`RewindService.points()` re-reads the durable journal on every call
(`packages/rewind/src/service.ts:115-122` → `store.readPoints()` at
`packages/rewind/src/store.ts:69-88`). The journal is a real file
(`rewind/<sessionId>/points.jsonl`, atomic temp+rename rewrite: `store.ts:111-115`), and the
assembly builds a fresh `RewindStore` over the same `rewindStoreRoot`+`sessionId` on a resumed
session (`packages/session-executor/src/assembly.ts:265-268`, root plumbed from
`apps/cli/src/index.ts:285`, `packages/tui/src/backend/embedded.ts:888,914`). Probe B1 confirms the
list is byte-identical after a simulated restart. The existing M48 test already covers a
close/reopen (not a process restart) at `packages/tui/test/rewind-bridge.test.ts:456-457`.

### 1.2 plan / execute — **work at the engine level**

`plan()` (`service.ts:133-166`) and `execute()` (`service.ts:175-234`) are pure functions of the
journal + the workspace; nothing is cached in memory. Probe B1/B3 show both work unchanged after a
restart, including a post-rewind restart (journal already truncated). `execute()` truncates with
`store.truncate(targetTurnIndex)` (`service.ts:222-223` → `store.ts:103-109`), so the frontier stays
consistent across restarts (probe B3: next turn lands at `turnIndex 1` after the truncate).

### 1.3 `turnIndex` derivation — **works**

`RewindRecorder.finalize()` derives `turnIndex = readPoints().length` (`recorder.ts:125`), and the
assembly *re-derives it again* at commit time under the serialized drain chain
(`assembly.ts:328-336`, recompute at `:333`). Both are journal-derived, so a restarted process
continues numbering correctly (probe B1: new turn gets `turnIndex 2`). The recorder test
`packages/rewind/test/recorder.test.ts:108-120` pins the in-process behaviour.

### 1.4 Mid-turn crash — **BROKEN (silent data loss)**

`RewindRecorder.pending` is a plain in-memory field (`recorder.ts:45`); `take()` only holds the
pre-image bytes in memory (`recorder.ts:74-85`) and `writeBlob` is called exclusively in
`finalize()` (`recorder.ts:115`). If the process dies between `user/message` (begin,
`assembly.ts:322-323`) and `turn/end` (finalize, `assembly.ts:326-336`), then:

* no point is appended for that turn (it never reaches the journal),
* the pre-images are gone (never written to `blobs/`),
* on restart the recorder is brand new (`pending = null`) and the resumed session's log tail is
  repaired with a synthetic `turn/end` (`packages/session-persistence/src/repair.ts:63-136`) — but
  nothing tells rewind a turn is missing.

Consequence: files created/modified by the crashed turn are in **neither** `plan().ops` **nor**
`plan().unTracked` (`service.ts:140-156`), because `unTracked` is computed from *recorded later
points*. A rewind then leaves silent orphans on disk while the conversation that explains them is
hidden. Probe B2 (below) shows the created file surviving with no mention anywhere in the plan.

### 1.5 Post-rewind restart — **BROKEN (the session cannot be loaded at all)**

This is the headline gap. `execute()` appends the `rewind/point` marker into the live session log
(`service.ts:209-218`; embedded `append(session, ev)` at `packages/tui/src/backend/embedded.ts:817`,
wire `append(live, event)` at `packages/sdk/src/server.ts:616-618`). The marker is then persisted by
the ordinary write-behind path (assembly `onAppend` → `coordinator.enqueue`,
`assembly.ts:305-309`; `packages/session-persistence/src/write-behind.ts:41-52`) — probe A shows the
line in the jsonl.

But `rewind/point` is **not in `KNOWN_EVENT_TYPES`** (`packages/session-persistence/src/index.ts:156-160`)
and is **never passed to `registerEventType`** (the module-init block at `index.ts:184-214` registers
`todo/write`, `goal/change`, `job/status`, `schedule/change`, `agent/input/*`, `session/title`,
`plan/mode`, `subagent/*`, `reasoning`, `command/*` — no rewind). So `guardIgnorable`
(`index.ts:384-395`) throws on load:

```
unknown event type 'rewind/point' without ignorable marker
```

for **both** `load()` (`index.ts:459`) and `loadOwned()` (`index.ts:497`). Every resume path goes
through one of them:

| Path | Call site | Result |
|---|---|---|
| TUI `--resume` (embedded factory) | `packages/tui/src/backend/embedded.ts:854` | factory rejects → TUI fails to start |
| CLI headless `--resume` | `apps/cli/src/run.ts:164-179` | `exitCode 1` + the raw message |
| SDK wire `session/history` | `packages/sdk/src/server.ts:247` → `session-executor/src/durable-session.ts:11` | `-32603 failed to prepare session` |
| SDK wire `session/rewind/*` | `packages/sdk/src/server.ts:559,580,605` (live assembly required) | `-32602 session not found` (the assembly can never be built) |
| fork / web-host / feedback reads | `packages/session-persistence/src/fork.ts:36`, `packages/web-host/src/host.ts:590,732,1568` | same throw |

Remote `--attach` fails at startup: `open` = `switchSession` fetches the full log via
`wireFullHistory` → `session/history` before committing the session
(`packages/tui/src/backend/remote.ts:1135-1157`, `open: switchSession` at `:1273`), so the wire error
propagates out of `open()` and the loop lands on the welcome screen with
`session open failed: …` (`packages/tui/src/app/loop.ts:1092-1100`). (The separate `replay()` API
would silently degrade the same failure to `[]` — `remote.ts:1307-1323` — but the app's startup path
does not use it.)

Note the trigger condition: this bites **only after the first successful `execute()`** (any mode,
including `files` — the marker is appended unconditionally at `service.ts:217`, and `truncated` is
false for `files`/error cases but the marker still lands). A session that merely *recorded* points
(never rewound) loads fine, which is why M42/M43/M48 testing never hit it: the durable-factory test
resumes *before* executing (`packages/tui/test/rewind-bridge.test.ts:456-464`) and never resumes the
rewound session again.

### 1.6 Remote / attach cold start — **structurally works, same gate blocks it**

The wire surface requires a *live assembly*: `session/rewind/points|plan|execute` reject with
`-32602 session not found` when `service.liveSession(sessionId)` is undefined
(`packages/sdk/src/server.ts:559,580,605`; `liveSession` = `assemblies.get(id)?.session`,
`packages/session-executor/src/service.ts:575`). That is by contract ("read 永不 auto-create",
`docs/contracts.md:129`) — but `session/history` **does** create the assembly for a known durable
session (`server.ts:247` → `service.assemblyFor`), and the TUI's `--attach` fetches the full history
in `open()` before the user can reach Esc-Esc (`remote.ts:1135-1157`; the picker additionally needs
`lineCount() > 0`, `packages/tui/src/app/loop.ts:3565-3569`). So the remote surface is served for a
cold session **provided the log loads** — the only failure is §1.5, where `session/history` itself
throws and `open()` rejects.

Separately, the `session-rewind` capability row is advertised **unconditionally**
(`server.ts:284`, unlike the host-gated create/fork/model rows at `server.ts:293-297`), while
`rewindFactory` is only wired with `--session-dir` (`apps/cli/src/index.ts:365`). So a server
without a session dir still advertises rewind; the TUI builds the member
(`packages/tui/src/backend/remote.ts:1129-1130`) and every call fails `-32603 rewind not enabled`.

### 1.7 Adjacent (not strictly cold start)

`completedTurnPrefix` (`packages/session-persistence/src/fork.ts:56-97`) slices the log at the last
`turn/end` and ignores rewind cut windows, and `forkSession` does not copy the marker — once §1.5 is
fixed, forking a rewound session would resurrect the hidden turns in the child. Today it fails
earlier, at `fork.ts:36`'s `coordinator.load`.

---

## 2. Probes and failure scenarios

All probes are throwaway `.ts` scripts run with `node --import tsx` from the repo root against the
real packages; stores/workspaces are `mkdtemp` temp dirs. Scripts live in
`%TEMP%\rewind-probe-{a,b,c,d,d2}.ts` (not committed). Outputs are pasted verbatim; a `...` inside a
line marks an elided 64-hex blob id (B1/B4) or a long repeated list (B2's three committed points).

### Probe A — durable session containing the marker, cold load (`rewind-probe-a.ts`)

Sequence: coordinator + jsonl backend, 2 turns, then
`{ type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 4, mode: "all", fileOps: [] }`
appended through the ordinary write-behind; close the coordinator; **new** coordinator over the
same dir; `load()` / `loadOwned()`.

```
root: C:\Users\inkik\AppData\Local\Temp\rewind-cold-a-QIQmji
jsonl tail: {"type":"turn/end"} | {"type":"rewind/point","version":1,"targetTurn":1,"anchorSeq":4,"mode":"all","fileOps":[]}
LOAD THREW: SessionFormatUnsupportedError - unknown event type 'rewind/point' without ignorable marker
LOADOWNED THREW: SessionFormatUnsupportedError - unknown event type 'rewind/point' without ignorable marker
```

### Probe B — engine-level cold-start scenarios (`rewind-probe-b.ts`)

```
== B1: points/plan survive a restart ==
  points after restart: [{"turnIndex":0,"preview":"turn zero edits a","files":1},{"turnIndex":1,"preview":"turn one creates b","files":1}]
  plan(0) after restart: {"target":0,"mode":"all","clean":[{"path":"a.txt","kind":"restore-blob",...}],"conflicts":[],"unTracked":["b.txt"],"ops":[...]}
  new turn turnIndex (recorder-derived): 2

== B2: process dies MID-TURN (begin+take, never finalize) ==
  points after restart: [ ...3 committed points, the crashed turn is absent... ]
  plan(1) (target = last committed point): {"target":1,"mode":"all","clean":[{"path":"b.txt","kind":"delete-added"}],"conflicts":[],"unTracked":["a.txt"],"ops":[{"path":"b.txt","kind":"delete-added"}]}
  c.txt still on disk: true          <-- created by the crashed turn; in NO plan field
  a.txt on disk: v3-uncommitted (restore op targets it, so it is covered)

== B3: post-rewind restart (journal truncated, marker in the log) ==
  appendEvent: {"type":"rewind/point","version":1,"targetTurn":1,"anchorSeq":10,"mode":"all","fileOps":[{"path":"b.txt","op":"delete"}]}
  execute(1) result: {"target":1,"revertedFiles":1,"conflicts":[],"errors":[],"truncated":true,"eventAppended":true}
  points after restart: [{"turnIndex":0,"preview":"turn zero edits a","files":1}]
  post-rewind turn turnIndex: 1 points: [turnIndex 0, turnIndex 1]     <-- engine-side consistent

== B4: restart in a DIFFERENT workspace (journal is cwd-relative) ==
  plan(0) resolved against wsB: {"clean":[],"conflicts":[{"path":"a.txt","kind":"modified"}],"ops":[{"path":"a.txt","kind":"restore-blob",...}]}
  execute(0,'files') reverted: 1 wsB a.txt now: v0    <-- wsA's pre-image written into wsB
```

### Probe C — end-to-end cold start of a rewound session (`rewind-probe-c.ts`)

Seeds a durable session whose log carries the marker, then drives (1) the real TUI embedded factory
and (2) a real `createSdkServer` + `createSessionService` + `createDurableSessionLoader` over a
fresh coordinator (the CLI `sdk` composition).

```
seeded durable session: rewound-1

-- (1) TUI embedded factory resume (defaultEmbeddedFactory) --
  RESUME THREW: SessionFormatUnsupportedError - unknown event type 'rewind/point' without ignorable marker

-- (2) SDK wire cold start (fresh service + coordinator) --
  session/rewind/points -> {"error":{"code":-32602,"message":"session/rewind/points: session not found: rewound-1"}}
  session/history       -> {"error":{"code":-32603,"message":"session/history: failed to prepare session: unknown event type 'rewind/point' without ignorable marker"}}
  session/rewind/points -> {"error":{"code":-32602,"message":"session/rewind/points: session not found: rewound-1"}}
```

### Probe D — the candidate fix works (`rewind-probe-d.ts`)

```
-- (1) registerEventType('rewind/point') fix --
  load():     types: turn/start,user/message,assistant/message,turn/end,rewind/point
  load():     rewindCuts: [{"cutFrom":1,"markerSeq":4}]
  loadOwned(): types: ... ,rewind/point seqs: 0,1,2,3,4
  loadOwned(): rewindCuts: [{"cutFrom":1,"markerSeq":4}]
```

### Probe D2 — the `ignorable: true` alternative is a trap (`rewind-probe-d2.ts`, fresh process)

```
load():      types: turn/start,user/message,assistant/message,turn/end | rewindCuts: []
loadOwned(): types: turn/start,user/message,assistant/message,turn/end,rewind/point | rewindCuts: [{"cutFrom":1,"markerSeq":4}]
```

`load()` (no `retainIgnorable`) **silently drops** the marker → the cut is lost and the rewound turns
reappear; `loadOwned()` keeps it. Any fix that marks the event `ignorable` instead of registering it
introduces exactly this inconsistency (and `coordinator.load` is used by `session/list` turnCount,
web-host reads, feedback and fork).

### Realistic sequences

1. **Post-rewind restart (P0).** TUI: turn 1 edits `a.txt`, turn 2 adds `b.txt`; Esc-Esc → rewind
   to turn 2 → disk restored, journal truncated to 1 point, marker appended. Quit. `i-harness tui
   --session-dir D --resume <sid>` → the factory throws `SessionFormatUnsupportedError`; the TUI
   never starts. Over `--attach`: `open()` fails, the loop shows
   `session open failed: unknown event type 'rewind/point' …` on the welcome screen.
2. **Mid-turn crash (P1).** A turn writes `c.txt` and rewrites `a.txt`; the machine dies before
   `turn/end`. Restart, resume, rewind to the last committed point: `plan()` lists neither `c.txt`
   nor `a.txt` (probe B2); after `execute()` `c.txt` is still on disk although the conversation that
   created it is hidden, and `unTracked` never mentions it.
3. **Resume from another directory (P2).** Record points in `wsA`, quit, then
   `i-harness tui --session-dir D --resume <sid>` from `wsB`; `plan()` reports a `modified`
   conflict against `wsB/a.txt` and `execute()` writes `wsA`'s pre-image into `wsB` (probe B4).

---

## 3. Fix options

### G1 (P0) — register `rewind/point` with the load gate

**Smallest change:** one line in the module-init block of
`packages/session-persistence/src/index.ts` (after the `command/done` registration at `:214`):

```ts
// M42: the rewind engine's durable conversation marker (core-session union).
registerEventType("rewind/point")
```

**What it breaks:** nothing. The type already exists in core-session's union
(`packages/core-session/src/index.ts:128`); `CURRENT_FORMAT_VERSION` stays 1; `loadOwned`'s strict
`seq === index` invariant (`index.ts:501-505`) still holds because nothing is dropped any more
(probe D). It does *not* make older builds read new logs — they already fail today. The alternative
of appending the marker with `ignorable: true` (service.ts:209-216) must **not** be used (probe D2).

**Tests that pin it:**
* new `packages/session-persistence/test/rewind-event.test.ts`: coordinator+jsonl round-trip —
  enqueue the marker, close, reopen, `load()` and `loadOwned()` both keep it and `rewindCuts`
  resolves to `[{cutFrom, markerSeq}]` (probe D output).
* extend `packages/tui/test/rewind-bridge.test.ts`'s durable-factory test: after
  `resumed.rewind.execute(0,"all")` + `close()`, resume a **third** time and assert `points()` is
  `[]`, the marker still replays as the `rewind` TuiEvent, and the rewound turns are hidden.

### G2 (P1) — survive a mid-turn crash

**Options:**
* *(a) Durable pending turn (recommended shape).* `RewindStore`: add
  `writePending/readPending/clearPending` over `rewind/<sid>/pending.json`. `RewindRecorder`:
  `begin()` writes the pending header; `take()` fire-and-forgets `store.writeBlob(before)` and
  appends `{path, blobId, isNewFile}` to the pending record; `finalize()` clears it;
  a new `recoverPending()` rebuilds the point exactly like `finalize()` (same re-read/afterHash
  logic, `recorder.ts:102-131`). `createSessionAssembly` calls `recoverPending()` right after the
  store/recorder are built (`assembly.ts:265-268`) and appends the recovered point through the same
  drain chain. ~60-90 lines + tests. Breaks: one extra fs write per `take()` on the hot path (blob
  write was already needed at finalize — it is content-addressed and idempotent, `store.ts:117-131`);
  a crashed turn now becomes a normal point on the next start, which is the point.
* *(b) Honesty-only.* On cold start, detect a tail turn with no point and warn. Cheap, but the
  pre-images are still gone, so it buys nothing beyond a log line. Not worth a change.

**Test that pins it:** a recorder/service test that does `begin`+`take` (no `finalize`), constructs
a *new* `RewindRecorder` over the same store, calls `recoverPending()`, and asserts the recovered
point has the original pre-images and that `plan()` now covers the created file.

### G3 (P2) — bind the journal to its workspace

**Smallest change:** persist the absolute workspace once (`rewind/<sid>/meta.json` written when the
store first creates its dir, `store.ts:111-115`), and have `RewindService.plan/execute`
(`service.ts:133,175`) fail closed with a new `RewindError` code when the resolved workspace differs
(an explicit override flag on the service opts covers deliberate moves). Missing meta (old stores)
= adopt current workspace. **Breaks:** legitimate cwd moves without the override — acceptable, it is
destructive today. **Test:** build a store under `wsA`, construct a service with `wsB` → `plan`
throws `REWIND_WORKSPACE_MISMATCH`; with the override it proceeds.

### G4 (P3) — stop advertising rewind when the host cannot serve it

One line at `packages/sdk/src/server.ts:284`: make `"session-rewind": ["1"]` conditional on
`opts.rewindFactory !== undefined` (same pattern as `server.ts:293-297`). **Breaks:** nothing — the
TUI gates on the row (`remote.ts:1129-1130`), so a server without a session dir simply hides the
rewind UI (the honest behaviour `docs/contracts.md:129` already documents). **Test:** extend
`packages/sdk/test/server.test.ts`'s capability test — no `rewindFactory` ⇒ no row; with it ⇒ row.

### G5 (P3, adjacent) — fork must respect cut windows

`completedTurnPrefix` (`fork.ts:56-97`) should stop at the last `rewind/point` marker (or apply the
resolved `rewindCuts`) and copy the marker into the child. Only worth doing once G1 lands; today
forking a rewound session throws first.

---

## 4. Recommendation

| Rank | Gap | User impact | Cost | Do now? |
|---|---|---|---|---|
| 1 | **G1** `rewind/point` unregistered → resume of any rewound session fails (hard error on TUI/CLI, `session open failed` over `--attach`) | **Critical** — the whole rewind feature poisons the session it was used on; the session is unreachable until the log is hand-edited | **1 line + 2 tests** | **Yes** |
| 2 | **G2** mid-turn crash loses the pending point and its pre-images | High but rarer: orphan files invisible to `plan()`, unrecoverable | M (store+recorder+assembly) | Follow-up milestone |
| 3 | **G3** journal is workspace-relative, workspace is not durable | Medium: silent destructive restore into the wrong tree when resuming from another cwd | S–M (meta.json + guard) | Cheap, can ride with G1 |
| 4 | **G4** `session-rewind` capability over-advertised | Low: dead rewind UI + `-32603` on servers without `--session-dir` | 1 line | Yes (ride with G1) |
| 5 | **G5** fork resurrects rewound turns | Low, currently masked by G1 | S | Later |

**Do now:** G1 (one line, the only true blocker) plus G4 (same file family, one line, restores
contract honesty), and G3's guard if the batch has room. G2 is the one genuinely new piece of
engineering — it is the only gap that *recovers* data rather than preventing corruption, and it
should be its own task with the recorder/assembly test above. Everything in G1–G4 is additive; no
wire or on-disk format changes are needed (the marker is already in the log).

**Acceptance for the G1 fix (manual, end-to-end):** record ≥1 file-writing turn in a durable TUI
session, apply a rewind, quit, resume → the session loads, `points()` reflects the truncated
journal, the scrollback hides the rewound turns, and a new rewind can be executed.

---

### Appendix — probe scripts

`%TEMP%\rewind-probe-a.ts` (persistence gate), `-b.ts` (engine cold start),
`-c.ts` (end-to-end TUI + SDK), `-d.ts` / `-d2.ts` (fix validation / ignorable trap). Run with
`node --import tsx <script>` from `D:\I-harness-main`; all write only to `mkdtemp` dirs and clean up
after themselves.
