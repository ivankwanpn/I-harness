# ContextEngine R0 request acceptance corpus

Date: 2026-10-15. Base: `051e85419244d71ce04aba4885d6960209e7e2f3` on `codex/v0.1.13-development`.

This is a test-only acceptance corpus for existing prepared-request behavior. It exercises real session projection and all five adapters over six routes: Chat Completions, public Responses, subscription Responses, Anthropic Messages, Gemini, and Bedrock Converse. It does not replace product context state or repair the research findings.

## Reproduction and evidence

Run the package baselines **sequentially** using the commands below, then the focused corpus and existing e2e typecheck. Every command below exited 0 in this task. No repository-wide test command was run; no dependency, profile, or product source was changed.

| Command | Tests | Exit |
| --- | ---: | ---: |
| `pnpm --filter @i-harness/llm-openai-compatible exec vitest run test/prepared.test.ts --maxWorkers=2 --minWorkers=1` | 7 | 0 |
| `pnpm --filter @i-harness/llm-openai exec vitest run test/prepared.test.ts --maxWorkers=2 --minWorkers=1` | 16 | 0 |
| `pnpm --filter @i-harness/llm-anthropic exec vitest run test/prepared.test.ts --maxWorkers=2 --minWorkers=1` | 7 | 0 |
| `pnpm --filter @i-harness/llm-gemini exec vitest run test/prepared.test.ts --maxWorkers=2 --minWorkers=1` | 20 | 0 |
| `pnpm --filter @i-harness/llm-bedrock exec vitest run test/prepared.test.ts --maxWorkers=2 --minWorkers=1` | 6 | 0 |
| `pnpm --filter @i-harness/core-session exec vitest run test/compacted-step.test.ts --maxWorkers=2 --minWorkers=1` | 5 | 0 |
| `pnpm --filter @i-harness/llm-anthropic exec vitest run test/compacted-tool-response.test.ts --maxWorkers=2 --minWorkers=1` | 2 | 0 |
| `pnpm exec vitest run e2e/context-corpus.e2e.ts --config e2e/vitest.config.ts --maxWorkers=2 --minWorkers=1` | 57 | 0 |
| `pnpm exec tsc --noEmit -p e2e/tsconfig.json` | existing e2e configuration | 0 |

The seven baseline files contain 63 passing tests. Detailed command receipts and retained logs are in `.superpowers/sdd/2026-10-15-context-engine-r0-corpus/`; `task-1-report.md` records implementation/self-review evidence and `command-receipts.txt` records individual process exits.

## Coverage by acceptance case

| Case | Actual coverage | Mutation rejected |
| --- | --- | --- |
| 1: physical protocols | All six routes: system/instructions, full declared `read` schema, `read-a`/`read-b` arguments, reverse-arriving B/A results, and concrete cap fields. Public and subscription Responses have separate tool namespace and cap assertions. | Lost authority/schema, wrong call/result ID or result value, missing result, wrong cap field, public/subscription protocol conflation. |
| 2: native continuation | All six routes: compatible data and interleaved order, then foreign-model fallback with legal unsigned tool pairs. | Dropped or reordered eligible native blocks, replay against another model, loss of visible assistant text. |
| 3: repaired compaction grouping | Six live and six JSONL-restored cases: checkpoint shadows original human input and the current `step/start`; calls/assistant/results are subsequently committed. A reminder arriving between reversed results must be moved after the result group. | Detached assistant/tool block from a shadowed start, a human message splitting the result group, source mutation, reload disagreement. |
| 4: ownership, cap, bytes | All six routes: mutate caller system/messages, nested tool arguments, nested schema, native model provenance and nested route options after preparation; send a derivative with cap 2048. Check original cap 1024 and unchanged input facts. | Aliased mutable request/config data, generation cap changing semantic/native input, wrong physical packet measurement. |
| 5: preparation and guards | All six routes: no captured send or auth call during preparation; stale validation and already-aborted owner prevent send. A separate deferred-promise subscription case invalidates ownership while auth is held. | Eager transport/auth, missing pre-send validation, validation occurring before an auth await only, ignoring abort. |
| 6: images | Six text-only and six image-capable cases derived from raw image-bearing session events. Typed image field and actual count/70 binary bytes checked; visible text fields cannot contain the base64 payload. Source JSONL remains identical. | Image leak to text-only models, base64 injected as ordinary text, image dropped from capable projection, destructive source sanitization. |
| 7: large archive | One >100MiB controlled archive case prepares and physically captures all six routes with two retained active messages. Actual component token estimates and packet sizes are bounded independently of archive bytes. | Shadowed archive content entering active input, measuring archive volume as active payload. |
| 8: oracle sensitivity | Six separately labeled control tests first accept real captured wire and an unchanged copy, then reject a missing result, wrong result ID, and lost native signature/data. | A vacuous structural/native oracle that cannot recognize deliberate corruption. |

There are 48 route acceptance tests (eight per route), one held-auth case, one archive case covering all routes, one fail-closed transport control, and six oracle-control tests. The six oracle tests exercise 18 deliberate corruptions. These corruptions are performed on copies; they do **not** claim production `prepare` validates malformed history.

## Protocol-specific native expectations

Every compatible continuation uses model and provider label `fixture`. The histories contain an original human request, one assistant exchange with two parallel read calls and narration, reverse-order results, and a later current human input. The signed/block protocols deliberately interleave the first tool call before narration to make order observable.

| Route | Concrete continuation assertions | Foreign-model behavior exercised |
| --- | --- | --- |
| Chat | `reasoning_content: "Synthetic plan."`, assistant narration and both `tool_calls`. | `reasoning_content` absent; narration and tool pair retained. |
| Public Responses | Exact reasoning item, summary and `encrypted_content`; reasoning/call/text/call item order; ordinary public function schema. | Native reasoning item omitted; narration and calls retained. |
| Subscription Responses | Same reasoning/order plus `ih` function-call namespace, namespaced schema, `store:false`, encrypted-reasoning include and no output cap. | Native reasoning item omitted; namespace and tool pair retained. |
| Anthropic | Thinking block with synthetic signature and thinking/tool_use/text/tool_use order; next user message holds both results. | Thinking block omitted; unsigned narration/tool group retained. |
| Gemini | Signed thought, signed narration, separate call signatures, thought/call/text/call order; next user message contains named/id-bearing function responses. | Thought/signatures omitted; unsigned calls and function responses retained. |
| Bedrock | Signed reasoning plus redacted native bytes; reasoning/call/text/reasoning/call order; next user message contains both `toolResult` blocks. | Native reasoning blocks omitted; narration and tool group retained. |

The Anthropic fixture intentionally uses a supported legacy continuation without a `prefixFingerprint`: it protects compaction grouping and native block replay. It does not qualify newly issued signature prefix chains. The existing Anthropic compacted-tool-response baseline also exercises a continuation obtained from a local provider-shaped stream. No synthetic signature is claimed cryptographically valid for a live provider.

These are per-route expectations for the particular provenance mismatch fixture, not a rule that all foreign reasoning envelopes or stale-order cases should behave identically. Bedrock's existing order-fallback behavior is left to its prescribed prepared baseline; this corpus uses eligible matching order.

## Measurement domains

The archive fixture counts JSONL header, each serialized raw event and newline independently. It totals **132,018,224 bytes**, 302 raw events, and two active messages. It shares immutable strings in memory and never persists a 100MiB file. The checkpoint explicitly shadows the first 300 events; the test makes no claim about an automatic compaction policy.

| Route | Physical measurement domain | Actual bytes | Projected heuristic input tokens |
| --- | --- | ---: | ---: |
| Chat | `http-json-body` | 309 | 103 |
| Public Responses | `http-json-body` | 253 | 88 |
| Subscription Responses | `http-json-body` | 357 | 95 |
| Anthropic | `http-json-body` | 270 | 88 |
| Gemini | `http-json-body` | 257 | 91 |
| Bedrock | `sdk-command-estimate` | 260 | 88 |

Every HTTP send compares the final captured JSON string's UTF-8 length with `packet.bodyBytes`. Bedrock instead captures the real `ConverseStreamCommand.input`, compares its JSON estimate with `packet.sdkCommandBytesEstimate`, and asserts `bodyBytes` is absent. The SDK may serialize bytes differently later; no Bedrock HTTP-byte claim is made. Input pricing is the sum of the real prepared input component heuristics, not provider billing, tokenizer truth, calibrated admission, or a sum of source-event estimates. Image count and observed binary bytes are tested; visual token cost remains explicitly uncertain.

## Transport isolation and first-run harness correction

The first corpus run exited 1 (41 passed, 15 failed). The root e2e package has no root `@i-harness/http-transport` link. A mock using that unresolved package specifier did not cover the adapter's package-local source module; subscription used the real system-fetch wrapper. Its final delegation to `globalThis.fetch` hit this suite's already-installed subscription quarantine, which throws `subscription used global fetch`. The wrapper sanitized that local rejection as `The selected proxy request failed`. The attempted adapter endpoint was `https://chatgpt.com/backend-api/codex/responses`; all supplied token/account values and bodies were synthetic fixture data. The original global fetch was never called and physical outbound HTTP was blocked. No live provider response or account/profile credential was used. Proxy selection was entered before this block; the initial run is not evidence that system proxy configuration was bypassed.

The fix is entirely in this corpus: mock the exact source `packages/http-transport/src/index.ts` identity, mock its implementation as a second fail-closed layer, and verify both are mocks before adapter construction. Expected HTTP destinations must match exact `.invalid` URLs (the subscription adapter requires its fixed official endpoint and rejects an arbitrary base URL). All unexpected HTTP paths throw with no original transport fallback; subscription global fetch always throws. Bedrock receives an injected runtime and never initializes its SDK credential chain. The focused harness control proves unexpected global fetch and underlying system-fetch calls are quarantined. Successful runs capture subscription through its exact mocked `systemFetch` and other HTTP routes through global fetch. Local responses contain only minimal terminal stream envelopes; tools never execute.

After each case, global stubs and spies are restored and mock implementations reset. Captures, auth counters, deferred promises, sessions and requests are case-local; tests are not concurrent. Each fixture call creates owned objects, and request messages are cloned from projection so hostile caller mutations do not edit raw session events. The fixtures import no production serializer or private wire mapper for expected-value construction.

## Explicit gaps

- No production context-state migration, importer, S/CX decomposition, live provider/account, remote write, full repository test run, or throughput/disk-load qualification.
- No automatic compaction fix or assertion adopting the known lost-current-input behavior; the current human input follows the controlled closed round and must survive verbatim in its proper wire role.
- No assertion adopting known orphan-history acceptance, summary character/token mismatch, summary provenance weakness, cache-calibration behavior, or legacy active-token mismatch as the desired architecture.
- No cross-provider semantic equivalence claim beyond the concrete protected inputs and per-route wire contracts.
- Source projection/reload and deterministic local request capture are qualified; cryptographic signature validity, server-side protocol acceptance and exact provider usage require later qualification.

R0 phase exit still requires the controller's independent specification and quality review.
