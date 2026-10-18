# Provider runtime

`src/index.ts` preserves the public `@i-harness/provider-runtime` entry. The
existing `@i-harness/provider-runtime/file` export continues to point at
`src/file-runtime.ts`. This package combines the provider registry with current
settings and credential references; each resolved binding owns its active
client. The registry and capability catalogue remain owned by
`@i-harness/provider`.

| Owner | Responsibility |
| --- | --- |
| `src/types.ts` | Existing runtime options, public operations, directory entries and binding state; mutation field types remain internal to the package. |
| `src/directory/types.ts`, `profile.ts` | Internal views, user/template precedence, declared card family, and construction of the selected adapter profile. |
| `src/directory/view.ts` | Current registry/settings lookups and directory projection with authentication description. Rebuilds views on every read. |
| `src/directory/merge.ts` | Template/user merging, existing-row-wins discovery merging, and clone boundaries. |
| `src/configuration/store.ts` | Canonical LLM mutation base, legacy-plane handling and one persistence function around the injected settings store. |
| `src/configuration/validation.ts` | Provider IDs, credential-reference names, patch allowlist and Codex endpoint/account constraints. |
| `src/configuration/routes.ts` | Route create/patch/upsert/removal and default selection; no model-list replacement through route patches. |
| `src/configuration/models.ts` | Model-row writes and authoritative subscription snapshots; one `addModelRows` write arm used by manual addition and discovery. |
| `src/configuration/credentials.ts` | Credential set/unset and the corresponding settings reference writes, preserving operation order. |
| `src/runtime/auth.ts` | One runtime auth resolver wrapping the injected resolver for current Codex account state; auth-reference and usable-value rules. |
| `src/runtime/discovery.ts` | Sole owner of the discovery memo; one probe implementation and explicit invalidation callback used by mutations. |
| `src/runtime/media.ts` | Current video/audio selection, route validation and credential resolution; wire work stays in the pre-existing `video-audio.ts`. |
| `src/selection/choice.ts` | Override/session/default choice, reasoning-effort validation and refusal state helpers. |
| `src/selection/resolve.ts` | Ordered provider/auth/account checks, selection → model row → route protocol choice, context/output-cap resolution and binding result. |
| `src/selection/binding.ts` | Active client/wait/retry state for one binding and fresh policy reads before each stream. |
| `src/runtime/create-runtime.ts` | Assembly of the narrow owners and existing public operation order. |

`createProviderRuntime()` selects a registry, creates one auth wrapper, captures
the client builder, and assembles readers, persistence, discovery and mutation
owners. Helpers receive typed dependencies for their responsibilities; there is
no shared bag of factory locals. All owners use the same injected settings and
credential stores. The discovery Map is private to discovery and configuration
changes call its invalidation function. Credential operations retain their
original write ordering and do not introduce a second transaction queue.

Directory and provider getters call `settings.get()` at operation time, and
canonical writes use `getSectionMutationBase("llm")` when available. Model
resolution reads the current default, route and retry settings. An already
resolved binding reads `readModelWait()`/`readModelRetryLimit()` or the current
settings at the next stream; explicit template retry policies keep their
precedence while wait settings still refresh. Codex account state and tokens
also remain calls to the current account service.

The in-memory runtime owns no watcher, background process or shutdown API.
`file-runtime.ts` remains the host adapter: its serialized operation queue, file
validation, sorted locks and fresh settings/policy reads are unchanged. The
credential store and account service retain their existing external lifecycle.

| Tests | Contracts covered |
| --- | --- |
| `test/runtime.test.ts` | Settings/registry precedence, model and protocol choice, context/caps, cloning, legacy mutation plane, credential ordering, discovery cache/invalidation, route/model mutations and live wait settings. |
| `test/file-runtime.test.ts` | Serialized host operations, shared credential locks, validation and retry-limit refresh on an existing binding. |
| `test/chatgpt-plan.test.ts` | Account affinity, Codex endpoint validation, subscription catalogue membership and authoritative replacement. |
| `test/video-audio.test.ts` | Video/audio selection, route restrictions and analysis behavior. |
| `apps/cli/test/run-protocol-selection.test.ts`, `models-command.test.ts` | Actual host consumers of runtime selection and model mutations. |

Run the provider suite first, then
`pnpm --filter @i-harness/provider-runtime exec vitest run --maxWorkers=2 --minWorkers=1`,
and `pnpm --filter @i-harness/provider-runtime typecheck`. Fixtures use temporary
files, injected services and local HTTP, without real account/model calls.
