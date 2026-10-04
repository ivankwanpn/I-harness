# IH context efficiency from Pi research

Accepted direction: the user requested implementation according to the Pi 1.0.2 research on 2026-10-04. Their later subsystem request refers to the separate context-mode and claude-context research, not a restructuring of this implementation.

## Scope and responsibilities

1. `code-mode`: keep model descriptions stable and avoid repeating direct schemas in mixed mode. Add bounded guest `searchTools` and `describeTool` against the cell's captured authorized catalog. Discovery does not promote direct declarations or bypass the broker. Live cell IDs use a stable status tool/result rather than mutable descriptions.
2. `code-mode` and `core-session`: persist bounded JSON store writes only after successful completion. Resume and fork replay committed state, excluding rewound event ranges. No worker continuation or executable code is restored. Preserve full emitted text, up to the existing transfer cap, through the output-retention store when the model preview truncates it; do not enlarge model previews or search limits.
3. `llm-seam`, provider adapters, and provider settings: add explicit per-route prompt cache capability/retention configuration and per-request cache intent/session affinity. Unsupported/default routes keep their current payload. Anthropic markers and Responses affinity are opt-in; a one-off summarizer must carry explicit cache intent. No cache warmer or extra paid request is enabled.
4. `token-meter`, `core-agent`, and `compaction`: keep raw provider counters distinct from estimates. Normalize input accounting using the reporting protocol, never assume all protocols count cached input identically. Calibrate a completed request's projected input against a valid positive usage report, then estimate only appended messages. Any changed system/tools, rewritten message prefix, prune/summary/reset/rewind, model binding, failed/aborted request, or uncertain accounting invalidates the anchor. Cache reads still count toward context.
5. Telemetry and acceptance: record schema/system/history/result bytes separately from provider usage, plus cache measurement availability and summary usage. Store counts/hashes and timings, not prompt bodies or secrets. A deterministic offline workload must exercise actual adapters, permission refusal, resume, and compaction invalidation. Report serialized bytes and heuristic token estimates honestly; local mocked usage is not a real provider cache hit or cloud cost benchmark.

## Invariants

- All changes occur in `D:/frontend-test`, branch `codex/desktop-workbench`, baseline `d0eca79f`.
- Preserve the user's existing `packages/desktop/electron.vite.config.ts` edit byte for byte; never stage it.
- Original checkout, Pi, DSH, user reports, settings, credentials and real sessions remain read only.
- Reuse existing registered tool authority, hidden/deferred/role visibility, current permission checks, fatal policy refusal, abort and Stop ownership.
- Retain existing 16 KiB model text preview, 256 emitted-item limit, bounded worker transfer/store limits, and grep defaults.
- Persist JSON data only, with an explicit version; missing old-log fields remain compatible. No silent replay of in-flight operations.
- No mandatory embeddings, external search server, new cloud service, cache warming, global installation, or user credential use.
- Session executor remains the host assembly boundary; shared helpers stay in their existing responsibility packages.

## Acceptance

Each behavior has a test that fails before implementation and passes afterward. Complete package tests and type checks must pass, followed by an independent branch review, the project's `verify:all` gate, a fresh portable Desktop build, and an owned copied-app backend smoke test. Raw source and artifact parity is checked. Research of the two MCP repositories is delivered separately with pinned primary sources and optional subsystem designs; no MCP installation or implementation is inferred from that request.
