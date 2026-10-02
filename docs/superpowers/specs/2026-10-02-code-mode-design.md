# IH Code Mode backend design

User approved this design on 2026-10-02, then clarified that Codex's mechanisms should be redesigned around IH's existing backend. Reference: `D:/agent-complete/codex-rust-v0.160.0` (code-mode-runtime, code-mode-protocol, core/tools/code_mode). Implementation remains in `D:/frontend-test`; no change to the reference or `D:/I-harness-main`.

## Architecture and engine

A new `@i-harness/code-mode` package owns JavaScript cells, observations and a registry broker. Each cell runs in a fresh QuickJS/WASM context inside a Node worker. Guest code has no Node, filesystem, network, process environment or module loader; filesystem/network effects use existing IH tools. QuickJS 0.32.0 supports modules with top-level await, bounded heaps and interrupt handlers. A parent hard termination protects the host from a guest that stops making progress. This adopts Codex's execution semantics, not its Rust/V8 deployment. WASM avoids a new Node/Electron native ABI dependency.

`code_exec({code,yield_time_ms?,max_output_tokens?})` and `code_wait({cell_id,yield_time_ms?,max_tokens?,terminate?})` use normal function-tool schemas for all existing model protocols. Plain source is the `code` string; optional first-line `// @exec:` pragma is accepted. Runtime observations have `cellId`, `status` (running/completed/failed/terminated), emitted items, bounded text and explicit truncation/error. Waiting consumes new output only. One observer per cell, natural completion wins a racing termination, and retired/unknown cell IDs refuse truthfully.

Helpers: `tools`, `ALL_TOOLS`, `text`, `image`, `audio`, `store`, `load`, `notify`, `yield_control`, `exit`, `setTimeout`, `clearTimeout`. Images are forwarded through IH's existing tool-result `images` projection. Audio can be recorded as an emitted item; no claim of audio-capable inference is made for existing image/text-only providers. Unawaited work is canceled when the module completes. Timers alone do not keep a completed module alive.

## Tool authority and recording

The cell receives direct and deferred tools from its own registry, never hidden tools, orchestration recursion or another session's tools. JS aliases normalize names; collisions refuse before execution. Each invocation is bound to the original cell/session/call, validates the current tool binding, and uses `prepare -> dispatch -> finalize`. Existing hooks, approval/guardian, sandbox, Plan Mode, role allowlists, timeout and output-spill apply. Registry policy refusals terminate the cell and remain loud even if guest code tries to catch them. Ordinary tool/body/argument errors can be caught in JS.

A session broker bounds concurrency and serializes non-concurrency-safe calls against all active calls. Every nested call has durable call/dispatch/result records linked to its parent and cell. Dispatch is flushed before the tool body. The model receives the outer observation and explicit emitted content; nested records do not become separate inference tool-use blocks. No irreversible action is made merely by admitting an exec cell.

## State, cancellation and limits

Store/load holds bounded JSON values for the current Code Mode session; globals are fresh per cell. Writes commit at successful module completion. Concurrent cells use completion order for conflicting store keys; this is an explicit process-local convenience store, not a durable shared document. Compression/reset does not invalidate active cell ownership or store state. Restart cannot restore live JS continuations or promises, and never replays a program. Persisted open cells are marked interrupted; stale waits explain that the old cell is unavailable.

Cancel/dispose rejects queued calls, aborts active tools and terminates workers, then drains tracked producers before coordinator shutdown. Late callbacks cannot admit new work or mutate a retired cell. Output, source, tool-result transfer, store, active-cell count, pending-call count, memory and CPU work are bounded independently. Requested observation duration is not a lifetime/goal-round budget. Waiting on tools is not billed as synchronous CPU time.

Default limits: memory 64 MiB per cell, cumulative synchronous guest CPU budget 1000 ms (idle tool/timer waiting excluded), 4 active cells/session, 64 pending tool calls/cell, source 128 KiB, single transferred tool result 4 MiB, session store 1 MiB, default output 4096 approximate tokens with 16 KiB transport text cap per observation. Configured limits must be validated and clamped at host boundaries. Output exhaustion discards further emitted content with a truncation flag; it does not repeat work. Error diagnostics are bounded before IPC, then share the observation text budget. Finalization hooks are serialized in body-completion order so a finished read need not wait for an unrelated slow body. Active cell IDs are exposed in the bounded, owner-local wait description, preserving discoverability after compaction.

## Exposure and hosts

Config mode is `off | mixed | only`. Existing installations default off, preserving their current tool surface; enabling uses mixed unless only is explicitly selected. Off has no workers and no advertised Code Mode tools. Mixed adds exec/wait to direct tools. Only exposes exec/wait to the model while the broker retains the role-scoped tool registry. This is a backend setting/CLI capability, not an Agent preset UI.

`registerCodeMode(ctx, registry, {session,sessionId,config,flush?,maxParallel?})` returns `schemas()`, `cancel()` and `dispose()`. AgentDeps gains optional `modelToolSchemas()`; inference and overhead estimation use that same source. Assembly mounts Code Mode after host/plugin tools and guards. CLI and Desktop gateway pass normalized settings; ordinary subagents, resident followups and Team-created children receive a factory that mounts against their own allowlisted registry. Disposal is owned by each assembly/child.

## Acceptance

Real worker tests prove top-level await, parallel tools, catchable body errors, missing ambient authority/imports, fresh globals and same-session store, yielding/waiting, termination, infinite-loop/OOM containment, observer exclusion, bounded transfers/output/store and disposal. Real registry tests prove denied writes cannot be caught into success, Plan Mode permits reads but rejects writes, ordered exclusive calls, dispatch checkpoint ordering, hidden/recursive/changed bindings refuse, nested records are omitted from model context, images avoid base64 text duplication, and no duplicate side effects after restart.

Host tests prove settings/CLI reachability, mixed/only schemas, role-local child/resident registration and shutdown drains. Full workspace gate must include the new package. Actual native packaged acceptance uses a temporary config/workspace and real worker, and checks the WASM payload outside the source tree. No new provider credentials, remote push, reference modification, Agent preset UI or reminder work.

Engine source: https://github.com/justjake/quickjs-emscripten (README: modules, promises, memory/CPU constraints and Node support). Native V8 alternative: https://github.com/laverdet/isolated-vm (native compilation/ABI requirements).
