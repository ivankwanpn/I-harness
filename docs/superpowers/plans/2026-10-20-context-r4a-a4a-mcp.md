# R4A A4a — MCP normalized results and bounded presentation

> **For agentic workers:** Use the approved subagent-driven-development/executing-plans workflow. Codex coordinates; every delegated implementer/reviewer is GPT6.1Sol. One product writer, no recursive agents. Complete this single connected unit and return for independent review. Do not begin the remaining A4 readers or A5/A6.

**Goal:** Preserve the complete normalized MCP result and expose useful bounded text/media/resource descriptions through genuine registry, managed store and Code Mode paths.

**Status2026-10-20:** Task1 accepted within this scope through product`fd84e6ea`/delivery`e0e6a8d1`; independent GPT6.1Sol spec/quality PASS and root source/copy/evidence verification are recorded in the [acceptance](../../research/2026-10-20-context-r4a-a4a-mcp-acceptance.md). Remaining A4/A5/A6 and broader qualifications stay open.

**Architecture:** The existing private registered ToolExec metadata identifies an actual MCP producer. The original retention owner passes that presentation hint into the existing once-lowered result capture. A focused MCP presenter reads only the immutable owned value, produces bounded descriptions, and leaves original program/artifact data and native image extraction intact. No payload-shaped object grants execution status or presentation authority.

**Tech Stack:** Existing TypeScript/Node24, MCP SDK/local stdio fixture, Vitest, managed Session/F1, ContextOutput and QuickJS/WASM. No new dependency or external service.

**Spec:** [R4A A4](2026-10-19-context-engine-r4a-completion-handoff.md), [retained result contracts](2026-10-18-context-engine-r4a-retained-results.md), [framework](../specs/2026-10-15-context-engine-framework.md). Start after `a8f4a694`; accepted product checkpoint `583bc11f` and its [A3 acceptance](../../research/2026-10-20-context-r4a-a3-acceptance.md) are not reopened without a demonstrated regression.

## Fixed constraints and rulings

- Work in `D:/I-harness-main`, branch `codex/v0.1.13-development`; retain existing changes. Desktop0.1.13-rc.1, Session format10, decomposition27/43 stay unchanged. No push/merge/tag/release.
- Ordinary final escaped envelope≤64,000 UTF-8 bytes; descriptive preview uses the existing8,192 escaped-byte cap. Typed media retains its existing separate validation/aggregate bounds. Guest transfer remains4MiB by default.
- Complete normalized MCP data is `{content, isError?, structuredContent?}` from `client.ts`, not the entire raw provider response. Preserve explicit false/null, array order and arbitrary nested fields. Existing schema stripping of unrelated raw top-level provider fields is not changed or represented as lossless raw-wire retention.
- Ruling MCP-01: `bridge.ts` already returns the full normalized result on genuine registry execution. Its content-only/throw branch is direct-execute compatibility. Preserve that fallback and add actual route coverage; do not rewrite it based on the old direct-call test.
- Ruling MCP-02: producer identity uses the existing registered execution metadata owner, never payload keys, tool-name prefixes or returned ref shapes. Add an optional runtime-only presentation hint; it is not serialized in ResultExecution/ResultEnvelope and does not change session format.
- Ruling MCP-03: supported image extraction and the existing tool-text plus companion-user-image arrangement remain unchanged. Preserve original text/image/audio/resource interleave in full normalized/program/artifact data; descriptive preview lists original block positions. Do not claim native model-block interleaving or change protocol adapters.
- Ruling MCP-04: normalized non-text MCP blocks require retained presentation even if their encoded body is small, so binary fields do not enter ordinary inline model text. Pure text/structured-only small results may keep the existing inline path. An unmarked ordinary tool keeps its existing behavior.
- Ruling MCP-05: preview fields are capped before concatenation. Use at most2,048 escaped bytes for a text body and1,024 for a URI/name/type field, then the existing8,192-byte total cap. Stop traversal when the summary budget is exhausted and disclose remaining block count. These are display limits; no original data is removed. Do not stringify or concatenate a huge blob merely to truncate it.
- Getter/toJSON/tool/hook execution occurs once; storage retry uses the original capture/scope/ref. Storage refusal does not rewrite execution status. No new journal, hold owner, retry scheduler, generic reset, reachability exemption or fake consumer.
- Tests are offline and sequential; never edit sources during a run. Keep every genuine RED and failed run; create a fresh evidence directory. Do not use live providers, real credentials or user sessions.

## Files and interfaces

| File | Responsibility |
| --- | --- |
| `packages/core-tools/src/registry/result-finalization.ts`, `src/index.ts` | Extend the existing private execution metadata row and public producer declaration/getter |
| `packages/mcp-client/src/bridge.ts` | Declare presentation only on the genuine registered execution path |
| `packages/session-executor/src/lifecycle/result-retention.ts` | Pass actual prepared metadata to original capture; synthetic transport failures retain their ordinary path |
| `packages/output-retention/src/result/capture.ts` | Once-lowered immutable data, original stream/sink and truthful result; consume optional presenter |
| New `packages/output-retention/src/result/mcp-presentation.ts` | Bounded descriptive MCP preview/force-artifact decision, no original-value mutation or store ownership |
| Existing `result/media.ts`, `result/preview.ts` | Reuse existing native media validation and escaped preview limiter |
| `packages/mcp-client/test/{stdio-stub,client,bridge}.ts` or their existing `.test.ts` counterparts | Real local normalization and registered/direct execution compatibility |
| New `packages/session-executor/test/retained-mcp-result.test.ts` | Genuine managed Agent/registry/store and real WASM integration |
| New `packages/output-retention/test/mcp-presentation.test.ts` and existing core-tools result tests | Negative association, bounded projection and unchanged owned data |

Introduce these exact narrow runtime interfaces (no separate type-only public export is needed):

```ts
// @i-harness/core-tools, existing private metadata owner
declareToolResultPresentation(exec: ToolExec, presentation: 'mcp'): boolean;
resultPresentation(prepared: PreparedCall): 'mcp' | undefined;

// @i-harness/output-retention, existing ResultCaptureOptions
presentation?: 'mcp';

// Private output-retention helper, consumes the already lowered/frozen value
mcpPresentation(value: unknown):
  { preview: string; requiresArtifact: boolean } | undefined;
```

Declaration returns false for an unregistered exec and requires the genuine dispatched state otherwise. Reset presentation on registration and preserve it across later outcome declaration. `resultPresentation` validates the original prepared identity. `resultExecution` must explicitly return only `{outcome, dispatch}` even if the private row gains presentation. Do not create a competing metadata registry.

The presenter recognizes the normalized top-level content array only after this trusted hint. It describes text, image, audio, embedded resource and resource_link blocks by position. Do not print data/blob base64. Unsupported/invalid media stays descriptive and fully retained; do not advertise invalid bytes as validated native media. Structured data is preserved in full; a bounded note can identify its availability. If a trusted post-execute transform no longer has normalized content, fall back to the existing generic capture presentation without losing the transformed owned value.

## Task 1 — Connected implementation and evidence

- [x] Read the actual owners and establish narrow baseline controls at the current HEAD. Record raw normalized versus direct compatibility versus genuine retained behavior separately.
- [x] Extend the local stdio fixture and actual client test for explicit `isError:false/true`, `structuredContent:null` and a structured object, ordered text/image/audio/resource/resource_link blocks. Use existing PNG/JPEG fixtures for two distinct supported images. Raw top-level extras remain outside the normalized contract.
- [x] Add a genuine managed registry/Agent control before product changes. It should currently fail because an image replaces useful content with a generic sentence, and because leading binary JSON hides later descriptors. A missing new export/import error is setup failure, not a behavioral RED.
- [x] Add the private presentation metadata declaration/getter to the existing owner and wire bridge→actual prepared capture. Keep legacy direct execute behavior and no-retention genuine registry behavior. Verify an ordinary unmarked lookalike does not get MCP-specific presentation or failure status.
- [x] Build the presenter on the owned immutable value, with capped fields and block positions. Reuse existing image extraction. Skip encoded-prefix preview accumulation only when the explicit presenter supplies preview; use that same preview for artifact and unavailable outcomes. Force retained representation for normalized non-text MCP content, without changing ordinary tools' inline semantics.
- [x] Add source/quota/unknown recovery and Code Mode controls below. Correct real failures in their original owners, preserve old failures and document scope changes before expanding.
- [x] Run targeted and affected package suites/types, then a fresh copy/build control for the changed path. Record exact source and test fixture hashes, commands, exits and immutable raw output. Commit coherent changes locally, update this task's ledger, and return for independent spec/quality review.

### Discriminating fixture and assertions

Use a fresh literal result per execution so expected construction does not invoke the same producer getters twice:

```ts
const normalized = {
  content: [
    { type: 'audio', mimeType: 'audio/wav', data: 'QUJD'.repeat(250_000) },
    { type: 'text', text: 'TEXT_AFTER_BINARY' },
    { type: 'image', mimeType: 'image/png', data: PNG },
    { type: 'resource', resource: { uri: 'file:///fixture/report.txt', mimeType: 'text/plain', text: 'RESOURCE_TEXT' } },
    { type: 'image', mimeType: 'image/jpeg', data: JPEG },
    { type: 'resource_link', uri: 'https://example.invalid/fixture', name: 'RESOURCE_LINK' },
  ],
  isError: failed,
  structuredContent: {
    body: 'x'.repeat(1_048_576), sentinel: 'BEYOND_PREVIEW',
    error: 'payload data', code: 'payload data', isError: !failed,
    images: ['ordinary structured field'], ref: { id: 'not-authority' },
  },
};
const expectedBytes = Buffer.from(JSON.stringify(normalized));
```

Feed it through `createMcpTool` and the existing `retained-result-flow.test.ts` real managed fixture: registered registry, `createToolResultRetention`, original F1 owner and controlled model. Then assert actual committed result/model projection and fresh-store pages:

```ts
expect(envelope.execution.outcome).toBe(failed ? 'failed' : 'succeeded');
expect(envelope.preview).toContain('TEXT_AFTER_BINARY');
expect(envelope.preview).toContain('file:///fixture/report.txt');
expect(envelope.preview).toContain('audio/wav');
expect(envelope.preview).not.toContain('QUJD'.repeat(100));
expect(envelope.media.map(image => image.mediaType)).toEqual(['image/png', 'image/jpeg']);
expect(Buffer.byteLength(JSON.stringify({ ...envelope, media: [] }))).toBeLessThanOrEqual(64_000);
expect(coldEncodedBytes.equals(expectedBytes)).toBe(true);
expect(JSON.parse(coldEncodedBytes.toString('utf8'))).toEqual(normalized);
expect({ calls, hooks }).toEqual({ calls: 1, hooks: 1 });
```

These variable names are local fixture observations, not new product APIs. Collect `coldEncodedBytes` by the actual `readResult` advancing pages and verify `ref.contentDigest` with Node crypto independently. Preserve the artifact's declared encoding and count; do not label encoded JSON fragments as decoded text fields.

Additional required controls:

- Success/failure × saved/quota-refused: protocol outcome and payload remain independent, complete owned program data is available to the original consumer when encoding succeeded, and unavailable model projection is truthful/bounded.
- No supported image plus leading audio/blob; supported images plus useful text/resources; empty content, structuredContent null, unknown block type, escaping/NUL/unpaired surrogate, and a long URI/name. Do not allocate a full huge preview string first.
- Genuine Code Mode WASM reads `structuredContent.sentinel` from the full returned MCP value. A separate >4MiB return is refused by the unchanged guest boundary, while the host's complete artifact remains readable. Do not raise the cap.
- One original finish-unknown cut through actual managed source: unblock and settle the same operation; one MCP call, one hook sequence, one original result fact, no repeated producer/getter. No independent fake finalizer may replace the store path.
- A plain ordinary tool returns similarly named fields without the trusted marker; its original data/outcome and existing media behavior remain unchanged. Marker metadata must not leak into serialized ResultExecution.

### Validation commands

Use the installed Node and package-local working directories. Run sequentially and capture failures rather than hiding them:

```powershell
& 'C:/Program Files/nodejs/node.exe' '../../node_modules/vitest/vitest.mjs' run test/bridge.test.ts test/client.test.ts --maxWorkers=1 --minWorkers=1
& 'C:/Program Files/nodejs/node.exe' '../../node_modules/vitest/vitest.mjs' run test/retained-mcp-result.test.ts test/retained-result-flow.test.ts --maxWorkers=1 --minWorkers=1
& 'C:/Program Files/nodejs/node.exe' '../../node_modules/typescript/bin/tsc' --noEmit
```

The first command runs in `packages/mcp-client`, second in `packages/session-executor`, and types in each changed package. Also run output-retention and core-tools affected/full scopes because their real contracts change. Broaden only for actual impacted callers or failures. Existing unrelated A3 failures are in the acceptance report, not an excuse to omit relevant checks. Root completes independent copy/evidence verification and review; package build alone is not runtime proof.

## Delivery boundary

Write `docs/research/2026-10-20-context-r4a-a4a-mcp-delivery.md` with BASE/HEAD, real producer/consumer map, RED/GREEN evidence, exact normalized-contract preservation, owned versus model representation, source-time-qualified checks, known failures and untested cases. Keep all old evidence immutable. Remaining A4 read/search/export/version/authority work, A5/A6, full six-route/live-provider/IPC and whole-session validation remain open. This unit does not change original decomposition progress or release status.
