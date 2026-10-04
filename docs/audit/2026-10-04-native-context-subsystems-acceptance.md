# Native Context Mode and Code Context acceptance

Work began on 2026-10-04 in `D:/frontend-test`, branch `codex/desktop-workbench`. The approved design is [native-context-subsystems-design.md](../superpowers/specs/2026-10-04-native-context-subsystems-design.md); the implementation plan is [native-context-subsystems.md](../superpowers/plans/2026-10-04-native-context-subsystems.md).

This report is a local delivery record. The published GitHub v0.1.0 source and assets are separate from this implementation. Desktop and its gateway use version 0.1.1 for the new local build.

## Product behavior

The dedicated settings page is **「上下文與檢索」**. Its two independent sections are **Context Mode** and **Code Context**, with visible **「設計參考 context-mode」** and **「設計參考 claude-context」** attribution. Both default to off. Global defaults and workspace overrides are supported, along with reset, status, clear, update, rebuild and cancellation controls.

Context Mode retains long textual tool results in an owned local store. The model receives bounded previews and opaque references; it can search retained text and read exact UTF-8 byte windows. Trusted producer retention preserves available shell/exec spill text before the existing preview discards it. Upstream truncation remains explicit. Failures, exit codes and supported media retain their meaning.

Code Context indexes admitted snapshots from the current workspace and explicit read-only references. Its default is local lexical retrieval. Optional hybrid retrieval uses a configured OpenAI-compatible or Ollama embedding endpoint, with local vector storage and credential references. Indexing never writes derived data into source directories. Every returned snippet is checked against current source authority and revision and carries contiguous decoded UTF-16 ranges.

Both services use IH's execution identity, role and approval broker. The six native tools are deferred: `context_output_search`, `context_output_read`, `context_output_status`, `code_context_search`, `code_context_index` and `code_context_status`. The index operation mutates internal storage and retains the ordinary approval path.

## Authority and lifecycle corrections

The final whole-branch review found two integration defects; correction commit `cee2c2f6019b111810ec896db975fdf20e9e4cb8` resolved both. A subsequent scoped independent review returned **READY** for Task 4 specification and quality.

1. The native adapter now distinguishes a session's durable project binding from its current catalog confirmation. A revoked binding cannot fall back to gateway-workspace or reference authority. Real broker regressions cover removal, denied search/index/capture provenance and confirmed restoration.
2. Agent and Code Mode dispatch pass the actual trusted executing Session. Capture metadata is written to the child's durable log, and child creation/resident reconstruction render bounded recovery from that child's own rewind-filtered events. Real regressions cover direct and emitted captures, compaction, reset, cold resume, forks, exclusion of unrelated or rewound refs, and ownership after clearing original owners.

Disabling stops admission, cancels and awaits owned jobs, and retains stored data. Clearing is separate. Index generations are committed transactionally; failed/cancelled attempts preserve the committed generation. Automatic reconciliation runs only when both Code Context and its auto-refresh option are enabled. Close drains owned timers, readers, producer callbacks and network bodies.

## Implementation decisions

- Explicit host-only ownership grants remain available while Context Mode is disabled so a legitimate fork retains its saved references. Capture, search and read remain gated. The cost if this choice is wrong is internal ownership bookkeeping while off; it grants no model retrieval authority.
- Context preview limits bound the direct tool's full textual JSON envelope. Code Mode retains its existing text/token observation contract; native reference metadata is separately bounded to 4 KiB. Its JSON envelope may exceed the text cap, so text bytes and serialized envelope bytes are measured separately. No token or billing percentage is inferred from these byte counts.

## Verification record

Each native package and the settings implementation underwent specification/quality review and focused behavioral tests before integration. Task 4's complete touched-package run recorded 1,892 passing tests and three existing skips. The consolidated final correction recorded **1,144 passing tests across eight complete package suites**, all eight typechecks, and the unchanged reachability gate passing with no new rows. The 0.1.1 installer fixture independently passed **13/13** tests.

An initial Root full run failed one existing 5-second project-context test and exposed four unused public type exports. The unchanged project-context suite passed 11/11 in isolation before correction, and the final complete session-executor suite passed 206/206. Unused exports were removed. No assertions, timeouts, gate scripts or allowlists were weakened. The initial run's short package population is not a full-suite pass.

The fresh Root `pnpm verify:all` completed with **exit 0** on the source used for build commit `7ab6f5cf`:

| Check | Result |
| --- | --- |
| Recursive package suites | 4,797 passed; 13 existing skips; zero failures |
| Package population | 73/73 reported |
| Typecheck | Exit 0 |
| E2E | 12 passed across five files; exit 0 |
| Reachability | Gate PASS, no new rows; three existing inert allowlist entries |
| Desktop distribution | Exit 0; Electron 44.4.5; 206 gateway dependency packages shipped |
| Copied Electron backend smoke | Exit 0; Node 24.21.0; nine behavior groups checked |

The copied smoke imported only gateway and package implementations under the new `release/I-harness Desktop/resources/gateway`. It used private settings, credentials and session directories under `D:/frontend-test/.tmp/native-context-packaged-smoke/run-3AvbHC`, with no live model/embedding request. The nine groups cover default-off zero native stores; actual host configuration and indexing RPC; settings restart/disable; six-tool discovery, native middle search, byte reads and recovery; Code Mode emission; lexical workspace/reference queries with exact ranges; output/index durable restart and drained close; source byte identity; and copied manifest/source parity.

The host was initialized again after restart, using the ordinary protocol handshake. Electron Node-mode was started with a Windows `file:///` URL for the copied tsx loader and an awaited hidden process; the final process exited zero. Initial harness attempts without that URL or the restarted handshake are not passing product evidence.

Measured fixture boundaries:

| Quantity | Bytes |
| --- | ---: |
| Direct original text retained | 84,023 |
| Direct model preview JSON | 16,060 |
| Complete Code Mode emission retained | 48,026 |
| Code Mode observation text | 64 |
| Code Mode observation JSON, including metadata | 1,021 |

These are observation-envelope measurements, not full provider request or billable-token measurements. Earlier producer caps remain applicable. The runtime, host, session retention, core-tools and child implementation copied into the app matched the source bytes by SHA256.

## Local delivery

The canonical release directory is `D:/frontend-test/packages/desktop/release`. Its previous Desktop build was sent to the Recycle Bin after ownership and process checks; this checkout retains only the new 0.1.1 release. The original checkout remains clean.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| `I-harness-Desktop-0.1.1.zip` | 216,316,158 | `790d963d7729bd968b2eeebebc42016ce528ad0c629aadc7980a59062560bfd4` |
| `I-harness-Desktop-Setup-0.1.1.exe` | 138,623,031 | `8696699f68e9863466bb68b1da8a9f525b7ef33d3748f514f2a786ea1d4ee7d4` |

The ZIP contains 8,026 entries, including the actual executable, app manifest, native gateway runtime and both new packages. Its unpacked application is `release/I-harness Desktop`, with app and gateway manifests both at 0.1.1. NSIS 3.11 compiled the unsigned installer successfully from the same validated payload: 7,951 files and 577,100,473 bytes. The installer build metadata's SHA256 matches the file's independently computed hash.

`SHA256SUMS.txt`, `native-context-build.json` and the installer metadata are alongside the artifacts. The recorded build source commit is `7ab6f5cf`; subsequent acceptance/documentation commits do not change that payload. Installer runtime logic is unchanged in this phase; real-user installation/upgrade and Desktop GUI visual acceptance were not rerun. Settings DOM tests and the copied Node-mode backend are the execution evidence for this delivery.

No new source, tag or release asset was pushed to GitHub during this implementation. The branch, private verification evidence and local delivery remain available for review.

## Limits and measured usage

- Context defaults: 16 KiB direct preview, 8 MiB capture per result, 32 KiB read, 16 KiB search envelope, 512 MiB workspace storage and seven-day retention.
- Code defaults: 20,000 files, 1 MiB/file, 128 MiB/index input, 50,000 chunks, 4 KiB/chunk, 512 MiB storage, 16 KiB search envelope and a 60-second index deadline.
- Durable stores are lazy after restart. Unloaded counters do not establish that persistent storage is empty; the UI labels loaded statistics accordingly.
- Embedding requests, successful cache reuse, reported input tokens and requests without provider usage are distinct service-lifetime counters. Controlled provider fixtures verify cancellation, protocol framing, dimensional validity and caching; no real embedding account or billing benchmark was used.
- Request translation fixtures cover Responses, Chat Completions, Anthropic Messages, Gemini and Bedrock Converse. This does not establish live cloud authentication, AWS signing or every provider's remote behavior.
- Native capture cannot recover data already discarded upstream without a trusted retained producer. Expiry, quotas and explicit clearing can make a reference unavailable.
- The protected pre-existing Electron configuration remains byte-identical, SHA256 `EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085`, and is excluded from commits. The Desktop build uses that existing local configuration; copied backend source parity is recorded separately.

Reference checkouts, original reports, real user settings/sessions/credentials and the original `D:/I-harness-main` checkout are outside implementation ownership. No reference checkout was modified. The test fixtures and native stores are owned by the development checkout.

For controls and configuration, see [the product guide](../native-context.md).
