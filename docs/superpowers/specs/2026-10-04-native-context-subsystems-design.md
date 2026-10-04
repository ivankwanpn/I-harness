# IH Context Mode and Code Context

Approved direction: the user confirmed implementation on 2026-10-04 (Asia/Hong_Kong), after reviewing the two native-subsystem proposal and local-source findings. The subsequent naming requirement is binding: the settings page is「上下文與檢索」, with **Context Mode** and **Code Context** sections, and attribution to context-mode and claude-context respectively. No further design approval is required for this implementation.

## Product and subsystem boundaries

- Context Mode captures admitted long textual tool/Code Mode output into owned immutable storage, returns bounded previews with opaque references, offers lexical result search and exact bounded read, and preserves recovery references through compaction/resume/fork.
- Code Context indexes admitted source snapshots and supplies lexical or configured hybrid code search, exact ranges, revisions, incremental generations, cancellation, status and clear operations.
- These are native services assembled by IH. Agent, child, Code Mode, SDK and Desktop use the same service and existing broker. The original session log remains authoritative; indexes are derived data.
- Both default off. Existing output guards and automatic compaction continue to have their own controls. Local lexical retrieval needs no server or embedding. Hybrid retrieval uses a separately configured OpenAI-compatible or Ollama embedding endpoint and a local vector index; no cloud database is required.
- The Desktop page displays the selected workspace, setting source, saved/effective state, quotas, retained/indexed size, indexing progress/errors, and separate update/rebuild/cancel/clear actions. Global defaults may be overridden per workspace. Disable drains owned work and retains data; clear deletes selected owned data; close releases resources.

## Context Mode contract

`packages/context-output` owns immutable UTF-8 blobs, owner metadata, derived SQLite FTS and bounded recovery rendering. Native IDs are opaque. Identical labels never replace older results. Access is host supplied; the model cannot choose another session or grant visibility. Missing, expired, disabled, unauthorized and incomplete results are distinct.

Defaults: preview 16 KiB, capture 8 MiB/result, read 32 KiB, search 16 KiB serialized, disk 512 MiB/workspace, retention seven days. Config limits are validated as safe positive integers; lowered response budgets include all metadata. Capture completeness describes captured producer content and preserves upstream truncation, timeout/cancel and failure information. Media bytes are excluded from text indexing.

Capture runs after approved execution at the output-retention boundary. Trusted existing spills may be registered by their producer; arbitrary returned paths are not treated as trusted files. Code Mode receives bounded model observations while its authorized nested execution stays on the broker. Add `code/call`, `code/result`, `code/output` to session search without indexing binary media.

Recovery uses bounded reference metadata from the actual session/fork lineage, not another session's latest snapshot. It does not promote retrieved text to instructions. Clearing one owner preserves other visible owners. GC only removes owned expired artifacts and exposes unavailable refs honestly.

## Code Context contract

`packages/code-retrieval` consumes a host-supplied snapshot reader and revalidator. Each snapshot has source ID, relative path, immutable text, content revision and completeness. Source configuration belongs to IH; external reference directories remain read-only and receive no index/hash/config files.

Defaults: 20,000 files, 1 MiB/file, 128 MiB admitted bytes/job, 50,000 chunks, 4 KiB text/chunk, 512 MiB disk/workspace, 16 KiB serialized search output, 60-second owned job deadline. The UI can lower configurable quotas. `.gitignore`, extension and custom ignore rules are honored by the source reader. Empty, partial, failed, cancelled and completed indexing states differ.

The index stores exact contiguous ranges and revisions. A TypeScript/JavaScript AST chunker may use existing TypeScript; other languages use explicit text fallback with accurate offsets. A displayed overlap is either a contiguous snapshot window or separately attributed ranges.

Refresh stages replacements, completes all successful writes, atomically publishes the generation, then advances hashes. Failed/interrupted updates remain retryable and cannot replace the committed generation. Initial index, refresh, force rebuild, clear, disable and dispose share one mutation owner. Late completions cannot publish after a superseding operation.

Hybrid embeddings are optional. Provider endpoint/model/credential reference are explicit. Vectors are stored locally and keyed by content, model, dimension and chunker identity; query caches also bind index generation, scope and visibility. No secret values enter settings, responses, logs or telemetry. Configured HTTP requests have abort, time/response/batch budgets and strict dimension/finite-number validation. Usage is actual provider usage where available, otherwise labelled estimates.

## Assembly and settings

Desktop gateway owns one pair of services under its session storage root, with identity derived from canonical workspace root. Current session/project membership supplies consumer authority; configured references are read authority only. Pinned project readers validate actual handles and revisions at discovery and query admission. General `read` alone is not index authority.

New tool declarations stay stable. Read/search/status tools are read-only; index/clear mutations are marked accordingly. Enabled-state checks also happen inside operations. Existing permission, Plan Mode, child authority, Stop and fatal policy refusal continue to apply. Off services create no background watcher, index or provider request.

The UI uses typed gateway state/configure/action RPC and reports effective state only after drainage. Global configuration writes reuse the existing settings-file lease. Workspace overrides are keyed by workspace identity. The normal Desktop bridge carries only validated fields and redacted credential status.

## Acceptance

Meaningful RED/GREEN tests cover owner isolation, immutable labels, UTF-8 windows, complete/partial capture, durable restart, expiry/quota, clear/fork ownership, disable drainage, Code Mode event search, failed generation retry, current revision/scope rejection, external-reference zero writes, cache invalidation, embedding cancellation/dimension errors, and settings saved/effective behavior.

Integration must exercise direct and Code Mode paths, child sessions, compaction/restart and all five protocol families through controlled local transport/adapter fixtures. Measure serialized result/request bytes separately from provider tokens and embeddings. No inherited upstream percentage claim.

Each task receives independent spec/quality review. The final gate is fresh `pnpm verify:all`, followed by a Desktop build and an owned backend smoke with isolated storage. Preserve the pre-existing Electron config edit and all reference/user files. Source commits are local to the approved feature checkout; a new shared publication is a separate action.
