# Tool argument streams and recovered subagent errors

The user reported `openai malformed function_call arguments` while using
gpt-6.1-sol through the Codex subscription Responses route. Follow-up screenshots
also showed successful child responses alongside errors from earlier attempts.
The user requested comparison with the other supported protocols.

## Confirmed defects and fixes

1. **Responses final arguments were ignored.** The adapter parsed only the
   accumulated deltas at `response.function_call_arguments.done`. It now uses
   that event's complete `arguments` when supplied. Delta-only compatibility
   remains when the field is omitted; an invalid supplied final value never
   falls back to an older parseable delta. This applies to API-key Responses
   and Codex subscription Responses, with no model-specific special case.
2. **Chat Completions discarded completed buffers too early.** A trailing empty
   or whitespace delta recreated a phantom call and could cause a false parse
   failure. Buffers now survive through stream completion, emitted call indices
   prevent duplicates, and the complete buffer is still validated. A second
   JSON document appended to the same call is rejected rather than executed as
   another call.
3. **Recovered subagents retained previous errors.** A new follow-up now clears
   the prior run's error before it starts. The desktop catalog takes the error
   from the current live registry, then the saved registry, then the original
   task hint. Missing current errors do not resurrect older ones through object
   spreading. Current failures and transcript-read errors remain visible.

Core-agent collects tool calls before executing them. A terminal stream error
therefore prevents execution of an earlier parseable Chat argument prefix.

## Protocol comparison

| Protocol | Argument assembly |
| --- | --- |
| Responses | Item identity plus string deltas; final arguments snapshot at completion. |
| Chat Completions / OpenAI compatible | String deltas accumulated by tool-call index. |
| Anthropic Messages | Inline input or JSON deltas finalized at content-block stop. |
| Gemini | Decoded argument objects; complete or partial-object assembly. |
| Bedrock Converse | JSON input deltas finalized at content-block stop. |

The common LLM seam normalizes events and handles retries. It does not implement
the protocol-specific JSON assembly. Inspection and existing adapter tests did
not establish the same two bugs in Anthropic, Gemini or Bedrock; this is not a
claim that those protocols cannot ever produce invalid arguments.

Official Responses event contract:
https://developers.openai.com/api/reference/resources/responses/streaming-events

## Evidence and limits

- Regressions for Responses final snapshots were observed failing before the
  fix; final coverage includes omitted/incomplete/different deltas, invalid
  final values, two interleaved call IDs and duplicate completion events.
- Four Chat regressions were observed failing before the fix: empty, space,
  CRLF/tab suffixes and an invalid extra JSON object.
- Subagent regressions cover a running retry, successful live/saved recovery,
  and retaining a new failure.
- User session records confirm the errors and later successful child turns,
  but do not retain the raw failed SSE argument payload. The exact wire data
  behind each historical error cannot be reconstructed from those records.
- Tests use synthetic data. No account credentials, live provider requests or
  modifications of the user's session files are required for these fixes.

Verification logs are in ignored local files `.tmp/protocol-fixes-tests.log`,
`.tmp/protocol-fixes-typecheck.log` and `.tmp/protocol-fixes-desktop.log`.

The combined run passed 1,192 tests across the nine protocol, shared execution,
subagent and gateway packages (152 test files). Desktop's focused SubagentPane
suite passed 13 tests. Changed backend package typechecks passed. Independent
review checked both stream consumers and persisted error precedence, with no
remaining actionable finding.
