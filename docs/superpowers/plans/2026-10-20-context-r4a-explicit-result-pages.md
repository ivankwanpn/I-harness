# R4A — Explicit retained result pages

> **For agentic workers:** Use subagent-driven-development. Root coordinates one GPT6.1Sol writer and a fresh GPT6.1Sol reviewer per connected task, without recursive delegation. Continue after native-producer acceptance; task handbacks are review boundaries.

**Goal:** Allow an explicitly requested page of a saved tool/Code Mode result to be read through SDK and the existing Desktop result card, without creating an execution assembly or loading the full artifact.

**Architecture:** Use the original ContextOutput artifact owner, immutable ref, caller pin and current source policy. A shared codec query leaf dispatches existing page readers. A short read lease lives in the original result-store registry; host-injected adapters supply actual visibility. Desktop shows one bounded page on demand. No second storage/index/permission owner.

**Status2026-10-20:** Task1 accepted through memory97c6d355, pages6fd98f90, test-EOF745302f4 and deliveryed6f2b6c after fresh independent PASS and root source/copy/BASE-restoration/whitespace verification. [Acceptance](../../research/2026-10-20-context-r4a-result-read-acceptance.md) records PAGE-11 and exact source-time/isolation limits. Task2 is ready for its final interface rebase and dispatch; existing search/display, child-result pages and prior acceptance remain intact.

**References:** [retained-results contract](2026-10-18-context-engine-r4a-retained-results.md), [remaining A4–A6](2026-10-19-context-engine-r4a-completion-handoff.md), [display acceptance](../../research/2026-10-20-context-r4a-a4b-display-acceptance.md), [owned version acceptance](../../research/2026-10-20-context-r4a-owned-version-acceptance.md).

## Fixed boundaries

- Same checkout/branch, product0.1.13-rc.1, Session10, decomposition27/43. No live provider/account/user data, new dependency, publishing, audit exemption or unrelated work.
- Reading cannot create an assembly/child, prepare/send/authenticate a model, admit input, wake a task, capture a new result, mint pins/grants, call an execution project resolver or repair/upgrade session files.
- A complete ref is required data, not authorization. The original artifact owner verifies committed operation/ref identity, caller pin and current source before body/index I/O and again after I/O. Do not replace it with a new token or weak-map authority.
- Search remains bounded inline/preview search. This task adds neither full-artifact indexing nor automatic body hydration on history/export/display.
- Generic Desktop conversation visibility and artifact pin/source policy are distinct gates. The base SDK router fallback has no general visibility guard; new SDK method availability must require an explicitly injected host adapter.
- Parent-scoped child result paging already has its own qualified lineage/revision adapter and remains unchanged. Generic conversation paging rejects a hidden child caller even if that child has a pin. Child-transcript ordinary artifact access requires a separate parent/lineage adapter and is not silently granted by this task.
- Fresh CLI cold unbound sessions can use the original durable root and source resolver. Fresh CLI project-bound sessions without an existing confirmed producer scope must report unavailable. Do not derive confirmed scope from saved projectId or invoke `projectContextFor`. Desktop's supplied native ContextOutput owner already uses `projects.nativeScopeFor`.
- Each page preserves its original ref/codec/completeness and encoded-byte position or exec cursor. `eof` means the end of the retained artifact, not proof that the original producer captured its entire output.
- Keep the original page DTO's JSON size cap32768. Standard RPC framing is separate; do not add an artifact DTO wrapper whose overhead breaks that existing page contract. The UI requests16384 bytes and retains one page only.
- Files stay cohesive: codec helper, short read lifetime, host guard, transport parser and UI page component are separate small responsibilities. Large existing service/server/IPC files receive thin wiring only.
- PAGE-11 root ruling after the real SDK gate and exact BASE overlay both fail: the original nondurable source is registered in `memoryScopes`, but `delegateFactSettlementSource` copies only managed bindings. A genuine agent wrapper therefore fails synthetic tool-result ownership validation, aborting a soft tool failure before `tool/result`. Preserve a genuine registered memory parent's original view binding in that same delegation owner. Do not loosen synthetic validation, create another source, infer identity from headers, promote memory to managed or give it a storage session identity. Its real parent lifetime/drain still applies. This narrow prerequisite repairs the existing SDK continuation contract; it is not a reader-regression claim.

## Interfaces fixed against current owners

### ContextOutput codec helper

Add a narrow `packages/context-output/src/result-page.ts` leaf. Maintain one type definition, re-exported through the public package:

```ts
type ResultPageQuery =
  | { ref: ManagedArtifactRef; offset?: number; maxBytes?: number; cursor?: never; textView?: never }
  | { ref: ManagedArtifactRef; cursor?: ExecFrameCursor; maxBytes?: number; textView?: boolean; offset?: never };
type ResultPageResult = ManagedArtifactPage | ExecFramePage | {
  kind: 'unavailable';
  reason: 'not-found' | 'stale' | 'unauthorized' | 'corrupt' | 'range' | 'budget' | 'unavailable';
};
readManagedResultPage(
  service: Pick<ContextOutputService, 'readResult' | 'readExecResult'>,
  access: ContextAccess,
  query: ResultPageQuery,
): Promise<ResultPageResult>;
```

Reuse original page types from artifact/types.ts and artifact/exec-reader.ts, and the existing bounded failure classification from tools.ts. Runtime validation is closed: valid full ref; safe nonnegative offset or closed two-field cursor; boolean textView only for exec; positive safe maxBytes≤32768; reject mixed/unknown fields. Expose a narrow parser if the actual transport consumers need it; no duplicated wire union or ad hoc validators in each host.

The existing model `context_output_read` delegates its managed branch to this helper, retaining its legacy refId path. Its current exec offset shorthand is a compatibility adapter: translate offset to `{recordOffset:offset,sliceOffset:0}` before strict helper validation, preserving existing mixed offset/cursor rejection. Also preserve the original legal positive-integer `maxBytes>32768` behavior: clamp it to32768 before the strict helper, as the original store does. The new public API uses codec-correct cursor and strictly bounded maxBytes, without removing the old model tool contract.

The helper dispatches JSON/text to readResult and exec to readExecResult. It never chooses a caller, resolves a project or handles filesystem paths. Raw filesystem errors do not cross the API.

### Original result-store read lease

In `packages/session-executor/src/lifecycle/result-store.ts`, share the original key/map/factory/deletion listeners/refcounts. Add a distinct acquisition wrapper for reads, returning the same service and release callback. Required inputs are existing workspace/coordinator/sessionId, optional supplied ContextOutput owner/sourceFor/settings path and a read-caller availability predicate.

1. A supplied ContextOutput instance is borrowed; release must not close it.
2. Otherwise require an actual durable coordinator root and existing session; use original canonical workspace key and source resolver.
3. Existing entry: add a short read registration without loading new config or calling configure/prune/GC.
4. No entry: original factory may read initial settings, but page access cannot initialize a legacy output index, register producer scope, create a sink or add a pin.
5. Both producer and reader acquisition wrappers use the same protection: after awaiting creation, verify the pending entry is still current in the original registry. A last-owner release may have removed/retired it; retry acquisition rather than attach to a closing instance.
6. Both wrappers reserve registration/users before any subsequent await that can race final release, including the producer's original configure await. Keep a reader's reservation through page pre/post checks. Producer configure failure and all other admission failures roll back their own reservation exactly once. A reader-only entry must not close while an admitted producer is still configuring; the read branch itself still never configures.
7. Read registration cannot mask an existing producer registration's confirmed scope getter. Preserve original producer selection, scope-loss refusal and parent binding validation. A reader's lifetime predicate is not execution authority.
8. Release deletes only its own registration/refcount. Close the original store only at zero users and only for the map-current entry; preserve deletion observers and original writer lifetime.

Do not create another store registry or supply a fake projectContext getter returning saved metadata.

### SessionService and host transport

Add an optional `SessionService.readResultPage(sessionId, query): Promise<ResultPageResult>` implemented by a small `service/result-reader.ts` leaf. Re-export the original query/result types rather than copying them. Advertise only when real supplied-owner or durable-store composition exists.

The leaf validates admission, acquires one read lease, invokes the common helper, rechecks service availability and releases in finally. Register the complete operation synchronously **before its first await**; its pending lifetime includes acquisition/profile/settings waits, rollback, page pre/post checks and `finally await release()`. These pending promises are only a lifecycle join. Global close revokes admission and joins complete operations before original store disposal; its early-return condition cannot skip pending read cleanup. closeSession similarly rejects new reads, joins the full same-session operations, then disposes original owners; only after closing state clears may a new cold reader enter. Use existing closed/closing state, not a permanent ACL or execution lane.

SDK adds:

```ts
SdkServerOptions.readResultPage?: (sessionId: string, query: ResultPageQuery) => Promise<ResultPageResult>;
// Method: session/result/read
// Params: {sessionId, ref, offset?, cursor?, maxBytes?, textView?}
// Capability: session-result-read, only with the supplied host operation.
```

There is **no automatic fallback to service.readResultPage** in the generic SDK switch. CLI explicitly injects its available service port. Gateway explicitly injects a new small conversation reader adapter, with profile exists, not archived, isConversation and management fence checked before and after read. `fence.run` lets structural management drain an admitted read; post-read checks can discard a page if the fence/visibility/source became unavailable. Store-level authority remains independently enforced. Unsupported capability is explicit, not an empty page.

Actual SDK client/session convenience methods use the existing request transport. Parsing/dispatch lives in a new leaf; server/protocol barrels remain thin. Actual paths include `packages/sdk/src/server.ts`, `client.ts`, `protocol.ts`, `packages/desktop-gateway/src/host.ts` and `apps/cli/src/index.ts`.

PAGE-11 additionally modifies only `core-session/src/managed/source-scope.ts`'s original delegation and directly relevant source-owner/SDK tests. Use genuine nondurable owner→memory source→`trackSettlementSource`→registered synthetic validation. Same-view delegation must succeed; foreign view, unregistered/shape-only parent and a closed genuine parent must still be rejected at the proper identity/lifetime gate. `isManagedSettlementSource` stays false and `settlementSourceSessionId` stays undefined for memory. The existing SDK test's real skill_get throw must produce one failed/dispatched inline result preserving the original error and allow the second model response; its stale `.output` assertion migrates to the complete retained value without weakening the continuation oracle.

## Task 1 — Authoritative bounded read service and transport

- [x] Rebase actual owner interfaces after native-producer acceptance. Record the current source→store→host guard→SDK method path before edits.
- [x] Add actual missing-capability/entry behavioral controls before implementation. Use genuine retained artifacts from existing capture/commit/pin owners, not just manufactured ref-shaped JSON.
- [x] Implement shared codec query helper and preserve the model tool's legacy refId, exec-offset and oversized legal maxBytes clamp compatibility. Test valid JSON/text/exec pages, raw binary/multibyte cursor edges, truthful completeness, mixed/unknown params, tiny budget refusal and exact serialized page cap. The same maxBytes64000 model request stays capped while the new strict SDK API rejects it.
- [x] Add the original registry read lease and SessionService lifecycle leaf. Fresh backend/coordinator read must work without assembly/model/auth/input/wake; supplied owner must be borrowed. Reads must not configure active writers or prune/repair/create pins.
- [x] Test same-registry races deterministically: pending entry vs last release, read while producer active, reader release while producer configure is held, configure failure rollback, and global/per-session close during acquisition, page I/O and release. No premature close, missing cleanup or late page publication; close cannot return while a late acquisition/rollback is still pending.
- [x] Implement explicit SDK option/capability/client method plus actual CLI injection and Gateway conversation guard. No base-router bypass; malformed request does not reach body I/O; hidden child/foreign caller cannot gain permission by selecting a pinned child ID.
- [x] Real cold SDK/Gateway controls cover valid refs, forged revision/codec/bytes/digest/completeness, no pin, foreign workspace, archived/hidden caller, current project/source revocation before/during read. Unauthorized cases cause zero artifact body/index I/O; original metadata checks may run. Authorized post-I/O revocation discards the result.
- [x] Verify fresh unbound CLI read success and project-bound-without-confirmation unavailable; live confirmed producer scope remains usable without execution subscription. Read session files remain byte-identical and no execution counters increment.
- [x] Close PAGE-11 through genuine source-capability RED/GREEN and the actual two-step SDK soft-failure/continuation path, preserving managed synthetic/refusal controls and all nondurable limits. Keep the earlier SDK failure, diagnostic and exact BASE-overlay restoration proof.
- [x] Run affected types/owner/SDK/Gateway tests sequentially; fresh copy exercises the same public host adapter and original store owner. No broad suite expansion without a concrete concern.
- [x] Self-review, locally commit and hand back exact source/copy/evidence plus limitations. Root accepts after fresh independent review before Task2.

## Task 2 — Existing Desktop result cards read one page on demand

This task starts only after Task1 acceptance and an actual interface rebase. Root fixes exact current bridge/component props in its dispatch brief; no implicit execution or hidden child reader is added.

Read-only Desktop source scoping fixes these seams before dispatch:

- `shared/result-pages.ts` defines the typed Desktop request as workspace/session plus the original query type, and `shared/bridge.ts` includes it. The existing preload request channel needs no additional API.
- `main/result-pages.ts` owns a small parser/dispatcher. Main validates the complete query **before** calling `runtimeForKnownWorkspace`, because that resolver can launch Gateway. In this same Task2 change, publicly re-export Task1's existing canonical strict parser from the Node-only `@i-harness/sdk/server` entry and consume it in Desktop main; do not add a duplicate validator or a new dependency. Keep the original global IPC sender gate.
- Renderer type-only SDK imports support `RecordedResultReader { readonly workspaceId: string; readonly sessionId: string; readPage(query: ResultPageQuery): Promise<ResultPageResult> }`. `resultReader?` is a bound UI capability, never part of persisted rows. Create it stably from the existing workspace-scoped capability snapshot and actual displayed session.
- Forward it through Workbench→Timeline→RowView, both ActivityGroup and ordinary ToolActivity→RecordedToolOutput→RecordedResultEnvelope, and the Code Mode RecordedCodeActivity→CodeActivityBody path. SessionHistoryView's separate Timeline also needs the reader; preserve its existing selected workspace/session match guard.
- One page viewer per envelope switches explicitly between primary output and dependency catalog. Do not mount independent page holders for both targets. Key state/request generation to workspace, session, **all** immutable ref fields, target and component lifetime; invalidate on capability removal, scope/ref/target change and unmount.
- Start exec reads without a cursor. The original reader normalizes the first cursor to `{recordOffset:9,sliceOffset:0}` after its magic header; do not reject it by comparing with an invented initial `{0,0}`. Subsequent pages use the exact nextCursor. Validate returned full ref and page shape before display, preserving this valid normalization.
- Clarify the existing model-facing `context_output_read` description alongside the page navigation: JSON/text continues with nextOffset, exec continues with the complete nextCursor unchanged. Its current nextOffset-only wording predates exec paging and must not encourage dropping sliceOffset or repeating the same frame. This is static usage guidance only; no schema/behavior change or new text-mirroring test.

- Add typed Desktop `session/result/read` bridge request and a small main-process parser/handler using the known workspace runtime and advertised SDK capability. Keep global sender validation; do not bypass it with a renderer-side filesystem API.
- Pass a narrow read callback bound to workspace/session through both Timeline and ActivityGroup into the existing result envelope component and Code Mode result path. Render without a read action when host capability is absent.
- Add one small page-view component using existing IH tokens, text blocks, disclosure/i18n and button styles. Action is explicit: read first page, next page and restart. Retain only current page and cursor; no automatic prefetch or complete-body accumulation.
- Use the original immutable ref for an artifact or explicit dependency catalog. Do not parse a partial JSON page as a complete object, auto-follow catalog refs, fetch remote URIs or auto-render body-shaped media.
- Show text fragments as retained encoded data; binary pages keep exact base64 with a clear view label. Exec pages preserve channel/frame/offset order and exact bytes, using optional verified UTF8 views only. Saved-scope metadata remains separate from execution outcome.
- Key pending requests to workspace/session/full ref and component lifetime. A late page for a switched session/ref cannot appear in the new card; failed/revoked reads clear the pending view and show bounded localized feedback. `eof` wording refers to saved content only.
- Keep existing parent-scoped RetainedChildBody unchanged; do not replace its resultText/error/revision contract with generic child access.

Task2 behavioral controls must exercise actual regular/grouped/Code Mode paths, no initial read, bounded next/restart, no accumulation, unavailable/partial/binary/exec views, capability absence, stale-response switching and denied/forged requests through real bridge routing. Preserve Task1 host guard tests. Build the actual renderer and inspect Chinese/English actual-component preview in IH style; preview is a development harness, not a new product page. Qualify the actual copied main/SDK/Gateway route, not only a fake bridge component.

## Completion and evidence

One writer, sequential stable-source tests and separate fresh review per task. Record original failures/setup, exact source/copy/fixture transformation maps and tested platform limits in new per-task evidence directories. No old proof overwrite, unrelated version updates or baseline reseed.

This unit proves explicit bounded read capability in qualified host compositions. Full artifact indexing, automatic external-resource fetch, child-transcript access without lineage, live-provider validation, 100MiB/fan-in/crash cuts and release readiness remain outside it. Root continues remaining A5/A6/R4B/C/R5/R6 after acceptance.
