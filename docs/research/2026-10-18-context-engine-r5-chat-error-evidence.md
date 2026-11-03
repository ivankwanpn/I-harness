# R5 observed Chat stream-error acceptance gap

2026-10-18, read-only root probe while the F3c3 implementer owns product work. No product change, live request or main-loop/tool execution. This converts the connected-rebase note's static Chat SSE question into a bounded adapter-level reproduction; it is not a diagnosis of the user's historical HTTP400.

Command: `pnpm exec tsx .tmp/context-redesign-20261015/r5-chat-stream-error-probe.mts` (exit 0). Script, closed output log and JSON result are retained beside that path. Process global fetch was replaced with an unconditional denial; every actual Chat adapter instance had its own local fixture fetch returning Response/SSE. Each case made exactly one fixture fetch and one actual execution confirmation. No credentials were read and no network endpoint was contacted.

| Literal fixture | Actual adapter events |
| --- | --- |
| Ordinary stop chunk plus DONE | text/chunk, end without refusal/truncation |
| Top-level error object plus DONE | end without error/refusal/truncation |
| Same error object followed by EOF | end without error/refusal/truncation |
| Same error as final residual frame without blank separator | end without error/refusal/truncation |
| Partial text and complete tool-call delta, then error plus DONE | text/chunk, tool_call, end without error/refusal/truncation |
| Corrupt JSON control | error, no end |

The fixture's error is `{error:{message:'Fixture temporary server error',type:'server_error',code:'server_error'}}`. The supplied word/shape is a controlled carrier, not a claim that every Chat-compatible provider emits that exact dialect. Its complete object is valid JSON. `createChatFold.handleFrame` currently reads choices/usage but ignores error; `decodeChatStream` then emits ordinary finish. This is distinct from malformed JSON, which the decoder does reject. The partial-tool case establishes the adapter's unsafe success signal only; it does **not** claim a tool was accepted or executed by the actual Agent.

Source files were unchanged from pinned fbd74bc6 at this probe. Raw current file SHA256:

- client.ts: `12852c7e190cac2b4ecf997ae3da874b3e374305380b9af5d6c16a652e61fc3e`
- stream/fold.ts: `12313093fa127219fff4d9c5741f040c96fa4772e448b2f592db52c83a14b9df`
- stream/decode.ts: `c1da6383a66657369f18ba2e364ff48a41cf56ef710550bbd2ffd8f084975992`

R5 must add typed terminal-error handling at this actual protocol owner, using primary/local reference evidence for recognized carriers and existing error classification rules. Keep boundary/residual behavior consistent, preserve honest usage observations, and refuse accepted exchange/tool dispatch after such a failure. Its integration tests must prove the actual main no-effect/no-calibration behavior and consume the same F4 allowance; no new free correction loop or blanket context-overflow classification. Unknown/malformed error payloads remain explicit malformed/unknown failure rather than clean success. Do not expand the currently active F3c3 task or weaken its coherent HTTP400 fault-injection oracle to use this unsupported path.
