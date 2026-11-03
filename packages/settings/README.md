# Settings maintenance map

`src/index.ts` is the stable package entry. It explicitly reexports the existing
public schema, normalizers, stores, watcher and section API. Internal helpers and
the default document are not part of the package export. Consumers continue to
import `@i-harness/settings`.

| Location | Responsibility |
| --- | --- |
| `src/schema/types.ts` | Durable document types and their shell/status-line vocabulary. Role types stay internal to the package. |
| `src/schema/defaults.ts` | One shared default document and font-size bounds. |
| `src/normalize/primitives.ts` | Pure guards and scalar fallback rules. |
| `src/normalize/providers.ts` | Provider/model/role normalization and the in-memory legacy TUI provider migration. |
| `src/normalize/execution.ts` | WSL, Code Mode and model-wait validation. |
| `src/normalize/tui.ts` | Presentation preferences and status-line/dashboard lists. |
| `src/normalize/settings.ts` | Root defaulting and composition of normalized sections. |
| `src/storage/contracts.ts` | Store options and the structural surface used by section mutation. |
| `src/storage/layers.ts` | Global/workspace/project ordering, root resolution and raw deep merge. |
| `src/storage/revision.ts` | Read validation of persisted section counters. |
| `src/storage/json-patch.ts` | Tolerant document parsing, comment-preserving patching and `SettingsPatchError`. |
| `src/storage/single-store.ts` | `SettingsStore`, its path resolution and the one-shot update helper. |
| `src/storage/layered-store.ts` | `LayeredSettingsStore`, its factory and reload/write coordination. |
| `src/observation/watch-settings.ts` | Explicit file observation, recovery fingerprints and watcher cleanup. |
| `src/sections.ts` | Section descriptors, redaction, validated mutation and revision conflict errors. |
| `src/context-subsystems.ts` | Context output/retrieval configuration and normalization. |

Each store remains the sole owner of its mutable state. `SettingsStore` owns its
snapshot, canonical LLM content, legacy read pin, revision counters and save
promise. `LayeredSettingsStore` owns its resolved roots, raw documents, merged
snapshot, counters, listeners, watcher handle and reload queue. Helpers introduce
no competing caches or store instances. Section mutation uses the injected store
surface, preserving revision/CAS and error class identity.

Normalize partial documents once after raw layering; objects merge per key and
arrays/scalars replace from low to high priority. Preserve the distinction
between fresh defaults and older documents, absent provider fields, and explicit
canonical provider values versus the legacy read projection. Single-store writes
retain their atomic save ordering. Layered writes patch the highest-priority
existing raw document, retaining unknown keys and the existing comment rules.
Unreadable patch input remains fail-closed.

The watcher uses `@i-harness/fs-watch` by package name so packaging includes its
dependency. It establishes an initial baseline, observes only selected paths
(including missing files), and recovers using retained fingerprints without
polling. Watchers use `persistent: false`. The layered store compares snapshots
and drains pending detections on both successful and failed reloads. Call
`LayeredSettingsStore.dispose()` or the standalone watcher's `dispose()` to stop
callbacks synchronously and close observation; listener unsubscriptions only
remove their own callback.

Run the focused gates from the repository root:

```powershell
pnpm --filter @i-harness/settings exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/settings typecheck
pnpm --filter @i-harness/provider-runtime exec vitest run test/file-runtime.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/provider-runtime typecheck
pnpm verify:reachability
git diff --check
```

Keep existing test files together: settings/defaults, provider and section
contracts, layered persistence/comments, and event/recovery behavior are the
behavior-preservation gates. New modules follow responsibility boundaries; short
pure validators and the explicit public facade do not need padding to reach a
line-count target.

The reachability audit treats the 14 extracted modules and `src/index.ts` as the
original declaring source unit. This preserves its exclusions for internal
normalization/imports; `sections.ts` and `context-subsystems.ts` retain independent
owners. Keep that exact path map aligned when moving these modules again.
