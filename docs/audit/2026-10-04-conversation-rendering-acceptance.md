# IH conversation rendering and child authority acceptance

This local delivery addresses the real DeepSeek Anthropic Messages report in `D:/frontend-test`, branch `codex/desktop-workbench`, from `baaa28b35b6ee75859e3c2d5a4a7ac7f73ef98f6`. It also includes the user's subsequent requirements that Todo float above the conversation and that the other supported protocols be checked.

Current download: [portable ZIP](D:/frontend-test/packages/desktop/release-conversation-rendering-2026-10-04/I-harness-Desktop-0.1.0.zip), with [Desktop EXE](<D:/frontend-test/packages/desktop/release-conversation-rendering-2026-10-04/I-harness Desktop/I-harness Desktop.exe>). Keep the EXE with its adjacent resources. This unsigned local portable build is version 0.1.0, Electron 44.4.5 / Node 24.21.0.

ZIP: **211753527 bytes**, SHA256 `6E748CBC9123FDAB7CCAAF1C1329F123F102DE2CB88A2682CEAD676F2DD34608`.

## Actual diagnosis and resulting behavior

The exact target session was located through I-harness's own workspace catalog for `D:/test-playground`. Its 545741-byte JSONL remained read-only and retained SHA256 `27F4745F66484595001687126140B61CF3A14470D4CCFEFDA7ED09FDB0157C79`. The report and its embedded instructions were treated as untrusted evidence. No report, `_tooltest` artifact, original session, credential file, or reference checkout was changed.

The session contains **848 events, one turn, 74 model steps, 59 nonempty thinking records, and 159 tool calls**. All 59 thinking records already have distinct stream IDs, with provider block IDs attached. Eight system admissions have exact promotion/payload correlations to later `user/message` records and the existing trusted `i-harness/system-input` marker. The renderer ignored that provenance. Also, 45 of the 74 assistant records contain no visible prose; none of the step endings in this run is marked `empty`.

| Cause | Correction |
| --- | --- |
| Work Process deliberately excluded every thinking row, creating a forest of disclosures outside work. | All nonempty thinking participates in the ordered work disclosure, including the first hint. Both live and completed thinking default to collapsed; explicit reader expansion survives growth and settlement. Completed work collapses and the final prose remains separate. |
| Tool-only rounds produced empty assistant bubbles, and passive activity after final prose could take away finality. | Empty assistant prose produces no bubble. Explicit refused/truncated/empty outcomes remain readable. Passive bookkeeping does not displace the last substantive model response; a later tool or thought still prevents earlier commentary being promoted to final. |
| A nonadjacent reasoning chunk replaced its previously displayed prefix. | Separated offset fragments are retained until the missing range joins them. Canonical history settles a stream once; delayed chunks cannot duplicate it. |
| Inbox and idle-run promotion lost admission identity and synthetic metadata. | Optional typed `user/message.input` retains input ID, intent, and synthetic metadata. Task/team/schedule display title/body comes from producer records before transport framing. The inference role and raw text remain unchanged. Literal human XML, Team and SCHEDULE text remains a human message. |
| Todo became an in-flow 300px card below the old responsive cutoff, consuming a whole row above the conversation. | The existing conversation host anchors an absolute, bounded Todo card above the conversation. It consumes zero transcript/composer flow width or height. Only the painted card receives Todo pointer hits; its list scrolls independently, with a compact narrow variant and visible paging/editor controls. |
| The Desktop approval adapter inherited by children accepted only its attached parent identity, rejecting owned child tools with an unchanged policy. | Prepared calls retain their actual runtime registry identity. The host resolves an owned live child and checks exact registry/tool/controller/parent/current role/Plan/catalog and current root policy again at dispatch. Disposal closes the seam before teardown awaits. |

The corrected renderer projected the original session, without rewriting it, into exactly **one human input, one collapsed Work Process, and the final answer** (`message:4`, `work:turn:3`, `message:844`). All 59 thoughts and eight background inputs remain available in expanded work. The read-only metrics helper records only IDs, counts and lengths, rather than private dialogue.

Task completion wording is neutral “reply ended”; it does not claim all child tools succeeded. Existing unknown child-role tools and the IH absolute-path restriction for `apply_patch` remain honest results. No role/tool grants or reminder feature were added.

## ZCode comparison

Read-only comparison used the actual `D:/agent-complete/ZCode-main` source:

- [conversationTurnRenderUnits.ts](D:/agent-complete/ZCode-main/packages/ui/src/v4/conversationTurnRenderUnits.ts) filters empty reasoning and derives work/final placement from actual ordered rows.
- [conversationTurnWorkSegments.ts](D:/agent-complete/ZCode-main/packages/ui/src/v4/conversationTurnWorkSegments.ts) and [conversationTurnFlowItems.ts](D:/agent-complete/ZCode-main/packages/ui/src/v4/conversationTurnFlowItems.ts) keep assistant history in ordered work segments and final prose outside completed history.
- [conversationAssistantWorkItems.ts](D:/agent-complete/ZCode-main/packages/ui/src/v4/conversationAssistantWorkItems.ts), [conversationRowContext.ts](D:/agent-complete/ZCode-main/packages/ui/src/v4/conversationRowContext.ts), and [ConversationRowView.tsx](D:/agent-complete/ZCode-main/packages/ui/src/v4/ConversationRowView.tsx:1596) establish collapsed live/completed thinking and the first-reasoning visibility rule.
- [reasoning.tsx](D:/agent-complete/ZCode-main/packages/ui/src/components/ai-elements/reasoning.tsx) preserves user interaction across state changes. The readonly timeline and CUA grouping source were also inspected for chronology and group identity.

ZCode's first-thinking flag keeps a minimal hint **inside ordered assistant work** when later thoughts are hidden by its setting. IH retains the first hint inside work and does not add a new setting. No ZCode source was edited or copied into this patch.

Ordering claims refer to **recorded event order**. The shared core already persists accumulated commentary after a streamed `tool/call`, even if the provider emitted commentary earlier. The matrix asserts that canonical order; the UI does not invent missing wire chronology. Protocol continuation envelopes preserve provider block order where supported. A bounded historical page lacking its turn start remains readable without inventing a turn boundary or final answer.

## Child authority and independent review

The real-adapter regression passed without Desktop approval attachment and failed with it before the fix: `TOOL_FAILED: prepared approval authority or policy changed before dispatch`. The parent's policy fingerprint was unchanged and the durable child header identified the actual parent/subagent lineage.

The new real-adapter gate passed **13/13** cases: legitimate child read, foreign/spoofed identity, current-role changes, tool replacement/revocation, policy/project changes, unavailable policy, Stop, owner close, actual factory-wrapper acceptance, and fresh same-name replacement refusal. Related gateway, core-tools, subagent, executor and core-agent gates passed before packaging.

Code Mode's exception accepts captured exact child factory `Tool` objects. A matching name grants nothing; nested calls continue through that child's restricted registry. Runtime registry/factory references are never serialized to the event/UI/evidence payloads. The remembered-grant provider retains its root scope; children use the existing one-time approval behavior.

One fresh independent read-only security/integration reviewer returned **READY, with no concrete P1/P2 findings**, including the factory-wrapper branch, dispatch revalidation, disposal, provenance, thinking/history/disclosure and Todo integration. [Review record](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/security-review.md).

## All five protocol checks

The exact supported protocol list is [settings/src/sections.ts](D:/frontend-test/packages/settings/src/sections.ts:110). The new [provider-protocol-rendering.test.ts](D:/frontend-test/packages/desktop/test/provider-protocol-rendering.test.ts) uses each real adapter, core agent, Inbox, registry, event window, projection and Work Process in a finite three-round fixture.

| Protocol | Adapter/core/shared renderer source gate | Continuation asserted | Copied native app |
| --- | --- | --- | --- |
| OpenAI Completions | PASS, real HTTP loopback via `llm-openai-compatible` | Exact `reasoning_content`, tool arguments/results; stable core stream identity despite absent provider block IDs | PASS, 2 actual HTTP requests |
| OpenAI Responses | PASS, real HTTP loopback via `llm-openai` | Opaque encrypted native reasoning items, summary identity, output order/commentary phase | PASS, 2 actual HTTP requests |
| Anthropic Messages | PASS, real HTTP loopback via `llm-anthropic` | Assembled signatures, signed empty/redacted blocks, original content order; unsigned visible thoughts remain visible without invented signatures | PASS, 3 actual HTTP requests |
| Gemini | PASS, real HTTP loopback via `llm-gemini` | Thought/text/tool signatures, part identity/order and function response | PASS, 2 actual HTTP requests |
| Bedrock | PASS, actual `llm-bedrock` Converse adapter with its existing injected SDK runtime face | Exact signed reasoning text, opaque redacted bytes, content order and tool result | SDK source gate only; no local endpoint exists in the current adapter |

All five source cases prove the held live prefix, stable IDs, three nonempty canonical thoughts, no empty thought row, literal human wrappers, trusted background activity, exact raw model payload, cold JSON resume, and delayed-chunk/history deduplication. The matrix was run independently (5/5 pass) and again in the fresh complete gate. [Detailed matrix record](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/protocol-matrix.md).

Bedrock verification does **not** claim AWS authentication, signed HTTP/event-stream decoding, cloud conformance or native gateway execution. The supported runtime injection avoids the ambient credential chain. No endpoint/debug knob, AWS credential or paid/cloud request was added for this verification.

## Current portable/native proof

Final copied visible run **`e6e5fcb0-7544-4e1b-8553-f7e12b4bc90f`** passed and closed **IDLE**, with `surviving: []`. It used its own configuration, userData and fixture workspace, actual original-forwarded native IPC, bundled gateway, real adapters/core and shipped renderer. There were **9 local provider POSTs, 0 remote/blocked fetches, 0 provider errors and 0 renderer errors**. The raw XML human bubble is an explicit negative fixture, not a background message misclassification.

The owned recorded-shape replay models the observed 59 thinking blocks, 159 calls and eight background inputs; original dialogue was not copied or committed. Native checks cover collapsed/expanded work, readable task errors through a real history-search callback, Todo list/scroll/editor/paging, held live thinking, actual successful and missing-file reads, final answer, schedule provenance, reload and all four HTTP protocol continuations.

The existing scheduler admits during `step/start`, after that step's inbox claim. The actual scheduled frame is therefore promoted before step two. Native observed raw-frame occurrences per request **`[0, 1, 1]`**, with one durable admission, promotion and consuming user/message. Reload issues no provider request; broker wake/delivery behavior was preserved.

| Requested window width | Actual viewport width | Full transcript width, review off/on | Transcript height | Todo card height, review off/on |
| --- | --- | --- | --- | --- |
|1500 |1502 |1164 /804 |748.4 |302.6 /302.6 |
|1180 |1182 |844 /484 |748.4 |302.6 /192.6 |
|680 |682 |600 /600 |748.4 |192.6 /192.6 |
|2560 |2562 |2224 /1864 |748.4 |302.6 /302.6 |

At each native width, transcript top equals host top (64.8px), and its full width equals the host content width. The 300px card's list client/scroll widths both equal 253px; actual icon/glyph/control bounds fit. Todo scrolling does not change transcript scroll. The higher narrow review pane wins hit testing over Todo. Source/browser tests additionally compare exact transcript/composer rectangles with and without Todo in ten layouts and exercise short viewports, empty snapshots and more than 50 items. The scoped four-file Todo/Workbench run passed 37 tests, including all three browser geometry cases.

The original header owns the only sidebar toggle. The rail remains 48px with its fixed Settings gear; the four approval choices and Settings-only sandbox selector passed the native probe.

Current screenshots:

- [Anthropic final answer and floating Todo](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/native-owned/e6e5fcb0-7544-4e1b-8553-f7e12b4bc90f/08-native-final-answer.png).
- [Readable background schedule](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/native-owned/e6e5fcb0-7544-4e1b-8553-f7e12b4bc90f/09-native-readable-schedule.png).
- [Completions final](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/native-owned/e6e5fcb0-7544-4e1b-8553-f7e12b4bc90f/14-openai-completions-final.png), [Responses final](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/native-owned/e6e5fcb0-7544-4e1b-8553-f7e12b4bc90f/14-openai-responses-final.png), and [Gemini final](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/native-owned/e6e5fcb0-7544-4e1b-8553-f7e12b4bc90f/14-gemini-final.png).

Root directly inspected the current native collapsed/expanded/history/error, held thinking, narrow review, schedule and protocol final images and accepted the visual result.

Earlier harness runs remain **FAILED**: `8a65a0c1` had an incorrect shipped-owner parity path before launch; `456c7183` selected the wrong project folder for a newly owned session; `b9ba6634` and `0e4d196d` incorrectly expected scheduler delivery in the first HTTP request. Their reports are retained, all closed IDLE, and none is counted as a full pass. The fixes were to the verification harness; product/artifact bytes did not change between them and the final passing run.

## Fresh complete gate and payload parity

After source/artifact/native proof was frozen and all owned native, loopback, helper, worker and reviewer work was idle, **`pnpm verify:all` ran alone and exited 0**.

| Gate | Fresh completed result |
| --- | --- |
| Recursive suite |**4502 passed, 13 skipped, 0 failed; exit 0** |
| Population |**71 of 71 projects reported** |
| All-project typecheck |**exit 0** |
| E2E |**12 passed in 5 files; exit 0** |
| Reachability |**exit 0, no new rows**;419 current,37 baseline rows gone |

Desktop reported **666 passed /3 skipped**. The three additional skips compared with the earlier 10-skip baseline are the new browser geometry cases, which require explicit installed-browser/Playwright environment paths. Those three were exercised in the scoped 37-test run and corresponding native bounds were verified. The five-protocol matrix is included in the full gate and passed. Two existing inert reachability allowlist warnings remain; no allowlist, cap or timer was changed. The old 4443-test result is historical and was not reused.

Packaging exited 0 with **203 gateway packages**. Freeze checked 35 task source/test files and 18 payload/native-copy files, including all changed runtime sources, five adapters, renderer/main, CPU helper/worker, attachment/PDF helpers, reader/engine and Windows rg. No product source changed after build/native freeze. The audit was written after the successful complete gate.

Evidence hashes:

- Native report: `341625F59296C9AAFC14956F7C9C7B007ECB8E36EB9E2D1A970EFA4D2EBFA1DD`.
- Actual native RPC observations: `C3CD5609EA71DC85B2ABCE5B1181EDF92B1E93FAFA9E2B0132ED23619F911F95`.
- Final native harness: `645A74A9AB7581590C50633FA79ABDF1BB039C4562464CC3FD29063B6329FD12`.
- Complete gate log: `B3BBEF197230971902C2B024379540FDF8DB878EA41C680CBBBCCE4764355CFC`.

[Source/artifact freeze](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/source-artifact-freeze.json), [native report](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/native-owned/e6e5fcb0-7544-4e1b-8553-f7e12b4bc90f/report.json), [build log](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/portable-build.log), and [complete gate log](D:/frontend-test/.superpowers/sdd/2026-10-04-conversation-rendering/verify-all.log) are retained locally.

The original dirty `packages/desktop/electron.vite.config.ts` remains unchanged and unstaged at SHA256 `EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085`. Delivery stays on the local branch, with no push or PR.
