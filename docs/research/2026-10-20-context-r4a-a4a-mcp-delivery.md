# R4A A4a MCP implementation delivery — 2026-10-20

The approved MCP slice is implemented and ready for independent review. This implementer report does not declare independent acceptance of A4 or R4A.

## Revision and scope

- Workspace/branch: `D:/I-harness-main`, `codex/v0.1.13-development`; initial working tree clean.
- Exact product/test range: `3ed2d6681decfce4230eca4699890e874da13965..fd84e6eaab3357bc79ea1d3b4a73f763661c9466`.
- Commits: `01bbd64ea5f3dc579740f26d3bbf44559aa1fcd7` (connected retention/presentation), `fd84e6eaab3357bc79ea1d3b4a73f763661c9466` (storage-neutral preview wording). The report is a documentation-only descendant; the local task report and handback record the full resulting HEAD.
- Accepted A3 product `583bc11fff2905778b0c983f1887a75de61d380c` was continued, not redone. Desktop `0.1.13-rc.1`, Session format 10, decomposition 27/43, protocol adapters and guest transfer limit are unchanged.
- One product writer; no recursive delegation, branch/worktree switch, live provider/account/session access, push, merge, tag or release.

## Actual owner and consumer map

| Owner | Responsibility |
| --- | --- |
| Existing `mcp-client/src/client.ts` | Real SDK client normalizes precisely `{content,isError?,structuredContent?}`. Explicit false/null and arbitrary nested values remain; unrelated raw top-level fields are stripped. No product change needed. |
| `mcp-client/src/bridge.ts` | Genuine registered execution returns the full normalized object and declares outcome plus runtime MCP presentation. Legacy direct execute still returns content or throws. |
| `core-tools/src/registry/result-finalization.ts` | Existing private execution row owns presentation. Declaration requires registered dispatched identity; registration resets it and later outcome declaration preserves it. Getter validates original PreparedCall. Serialized `resultExecution` explicitly returns only outcome/dispatch. |
| `session-executor/src/lifecycle/result-retention.ts` | Original composition passes the actual prepared metadata into capture. Original scope, source binding, dependency owner and synthetic path remain responsible. |
| `output-retention/src/result/capture.ts` | Original synchronous lowering/freezing runs once. Same immutable value reaches original stream encoder, sink and full program consumer. Explicit presentation replaces only encoded-prefix preview accumulation. |
| New `result/mcp-presentation.ts` | Focused bounded description of original block positions, text, media types, embedded resource text/URI and resource links. Binary data/blob never enters the preview. Marked non-text content requires retained representation even when small. |
| Existing `result/media.ts` and core-session projection | Native image validation/order and tool-text plus companion-user-image arrangement remain authoritative. Description neither validates media nor grants execution/read authority. |
| Original Agent/Code Mode/F1/store | Managed fixtures commit bounded envelopes and cold-read complete artifacts. Full owned values reach Code Mode; real WASM still refuses above 4 MiB. Original document close retries its registered settlement sources after unknown finish. |

Structured data, isError, content order and nested `error`, `code`, `images` and `ref` fields stay in the complete owned/program/artifact value. Unmarked ordinary lookalikes keep existing inline/outcome/media behavior. A trusted dispatch transform replacing normalized content falls back to generic capture of the transformed value.

Fields are capped before joining: text body at most 2,048 escaped bytes; URI/name/type at most 1,024; final preview at most 8,192. Traversal stops on exhaustion and discloses remaining block count, with a small reserved suffix budget. Unvisited blocks conservatively require retained representation. Neutral descriptions work for both artifact and unavailable outcomes; retention metadata alone reports storage availability. Original interleave is preserved in full data, without claiming native model-block interleaving or constant heap for already materialized source objects.

## Rulings and failed evidence

**MCP-06, approved by root:** SDK Server 1.30.0 rejects `structuredContent:null` as an invalid record before transmission. Receipt `05-mcp-local-and-bridge` preserves that rejection. Original SDK stub remains the default; parameterized vectors use a minimal literal JSON-RPC stdio responder and still traverse real `createConnectedClient`, SDK client transport and local normalization. This proves local normalized-contract tolerance and does not claim SDK Server supports null. Production validation was not relaxed.

Receipt `06-managed-quota-wasm-unknown` preserves a recovery-oracle error: `document.drain()` only flushes admitted fact work; `document.close()` owns original source-close retries. Corrected `07-managed-source-close` and final runs settle the same operation/scope and one result fact without replay. No recovery owner/reset was added.

Receipt `10-types-*` preserves test setup failures: missing stdio args, incomplete typed client doubles and TypeScript discriminant narrowing. Complete fixtures/args and the narrowed original envelope fix those tests. They are distinct from behavioral REDs.

Self-review found “retained”/“available in the full result” descriptions could imply durable availability under quota refusal. Receipt `21-quota-wording-red` records five failures. Neutral wording in `fd84e6ea` passes the same controls and a refreshed copy; earlier evidence remains unchanged.

## Verification and source time

Evidence: `.tmp/context-r4a-a4a-mcp-20261020-implementation/`. Each numbered run has `receipt.json` with exact executable/arguments/cwd, UTC start/end, HEAD and exit; `raw.txt`; `status.txt`; and before/after SHA-256 manifests over then-present packages/scripts. All 32 receipts have identical before/after source manifests. Suites run sequentially with one worker and no product/test edits during runs. Raw warnings and failures are preserved.

| Receipts | Observed result and qualification |
| --- | --- |
| `01-real-path-red` | Two genuine managed Agent→MCP→registry→retention failures: images replace useful text with generic sentence; leading audio hides later text. Baseline production source, not missing-import setup. |
| `02-capture-red` | Six behavior failures/four passes: small marked non-text inline and encoded prefix hiding descriptors. |
| `03-real-path-green`, `04-capture-green` | Original connected preview and capture regressions pass after implementation. |
| `05`, `06`, `10-types-*` | Preserved SDK/fixture/oracle/type setup failures described above. |
| `07-managed-source-close` | 15 connected tests pass after recovery-owner correction; later controls are separately recorded. |
| `08-core-tools-full` | 137 tests/15 files pass. Core-tools source/tests match final HEAD. |
| `09-output-retention-full`, `13-output-retention-final` | 51 then 53 pass at their earlier source times; not relabeled final wording runs. |
| `11-mcp-literal-stdio`, `12-mcp-full` | Targeted12 then full107 tests/16 files pass. These MCP sources/tests match final HEAD. Full package OAuth controls use local fixture AS/temporary stores, not user accounts/credentials. |
| `14-session-mcp-final` | 16 connected tests pass before neutral wording; predecessor evidence retained. |
| `15-gateway-build`, `16-copy-prepare`, `17-copy-runtime` | Fresh predecessor Gateway build and copied-library37 tests/5 files pass.846 source files match;280 internal edges resolve inside copy. |
| `18-types-final-{core-tools,output-retention,mcp-client,session-executor}` | All four tsc --noEmit exit0. Later change only description strings/quota wording assertion, with no API/type structure change. |
| `19-package-graph` | 82/82 application-reachable packages,0 production cycles. Existing checker copied with repository/output paths adapted to avoid overwriting its old fixed evidence output. |
| `20-reachability` | Exit1, same six previously documented unused exports: ExecFrameRecord, JsonStreamOptions, validResultEnvelope, ExecFrameCaptureOptions, ResultCaptureOptions, createOutputSpillGuard. No exemptions, baseline reset or fake consumer. Later wording adds no exports. |
| `21-quota-wording-red` | Five misleading quota-description failures/seven passes at01bbd64e plus new regression. |
| `22-output-retention-final-neutral` | Final53 tests/7 files pass; existing spill-GC ENOENT warnings retained, not a warning-free claim. |
| `23-session-mcp-final-neutral` | Final16 tests/2 files pass: ten MCP controls and six relevant existing retained-result controls. |
| `24-gateway-build-final`, `25-copy-prepare-final`, `26-copy-runtime-final` | New final Gateway copy builds, matches final source and passes22 affected tests/2 files. Earlier broader copy remains separately recorded. |

The managed fixture constructs fresh execution results and independent `Buffer.from(JSON.stringify(literalExpected))` bytes, not the shipping stream encoder as oracle. It has a 1,000,000-character audio body, text after binary, distinct genuine PNG/JPEG, embedded resource, resource link, and1 MiB structured body/sentinel/arbitrary nested keys. Advancing fresh-store pages explicitly contain encoded JSON fragments; independent SHA-256 and encoded-byte count match complete expected bytes. Success/failure × saved/quota refusal preserves complete program data and truthful execution. Real WASM reads sentinel and ordered block types; a separate >4 MiB result fails guest transfer after complete host artifact retention and cold read. Finish uncertainty observes one MCP body, one source getter, one hook, one original scope and one committed fact.

Additional controls cover empty content, explicit null, invalid/unsupported media, unknown type, long URI/name/type, quotes/backslash/NUL/unpaired-surrogate/emoji, exact escaped per-field bounds, ordinary lookalikes, original ordinary image extraction and transformed-value fallback. Shared once-lowering/raw-token controls pass. No claim of constant total source-object heap is made.

## Copy and evidence limits

Final tree: `.tmp/context-r4a-a4a-mcp-20261020-gateway-b/`, normal Gateway runtime graph with242 shipped packages. Unsupported-platform optional-dependency messages remain in build output. Final QA rewrites imports with AST in four test/helper fixtures (twenty import edits); product copies are unmodified. `copied-qa-b-before.json` records all source/copy/fixture hashes and280 resolved in-copy edges. Final runtime tests exercise copied libraries, not Gateway IPC, Electron, live six-protocol endpoints or packaged CLI. Source local-stdio tests are separate. No CLI build/runtime qualification is claimed here.

`seal.mjs` verifies final bytes against final run manifest, every final source/copy/fixture hash and all32 receipt source-stability checks. `seal.json`:2,603 package/script inputs, source digest `8a53b64d1b66dfbb903ad2cd25615141e5e88c88175917f9b443bb615caca419`, final product HEAD `fd84e6eaab3357bc79ea1d3b4a73f763661c9466`. `inventory.json`:184 files, digest `10dec13468a890acc59e39cc8c6b1dc83402be8b54b39ab942113321c60eda15`, excluding its own output and seal.json to avoid self-reference. This implementer seal does not replace root's independent check.

`residual-processes-final.json` is an empty list of task/stdio-matching Node processes after tests; no claim about unrelated processes. Fixtures close original service/coordinator/runtime/broker/client owners; new literal stdio directories are removed in finally. Existing default SDK helper temporary-directory lifetime was not redesigned.

## Remaining boundary

Whole-workspace/session,100 MiB/100-child,live-provider,Gateway IPC,renderer and all-six-route qualification remain open. Existing unrelated A3 suite failures remain documented in its acceptance report, not relabeled fixed. Remaining A4 readers/search/export/version/authority, A5/A6, R4B/R4C,R5/R6 and release acceptance stay open. Product writes stop for root's independent verification and fresh GPT6.1Sol review.
