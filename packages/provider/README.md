# Provider registry and catalogue

`src/index.ts` is the existing public package facade. Consumers outside this
package import `@i-harness/provider`; private module exports are implementation
seams, not additional package APIs. The registry owns routes and probes. The
separate `@i-harness/provider-runtime` package owns settings, credentials and
per-session model bindings.

| Owner | Responsibility |
| --- | --- |
| `src/types.ts` | Profile, registry, discovery and wire-client contracts. |
| `src/catalog/load.ts` | Load and validate the capability cards once at module initialization; sole owner of catalogue lookup, file-order rows and provenance. |
| `src/catalog/resolve.ts` | Read-only card, alias, family-row and provenance queries; copies returned to callers. |
| `src/catalog/context.ts` | Per-field user-model → model-context → profile → card resolution without clamping. |
| `src/values.ts` | Shared positive-integer parsing for catalogue and discovered capacity values. |
| `src/probe/errors.ts` | One definition of each branded probe error, shared by HTTP and normalization. |
| `src/probe/normalization.ts` | Accepted array/map response shapes and capacity pairs. |
| `src/probe/http.ts` | Ordered candidates, explicit endpoint validation, protocol-specific authentication, protected headers, timeout/cancellation and HTTP failure policy. |
| `src/probe/registry.ts` | One profiles Map and one custom-probes Map per registry; probe precedence and lazy module-default registry. |
| `src/clients/validation.ts` | Registration-time context and retry-policy validation. |
| `src/clients/build.ts` | Dispatch to each existing adapter, then waiting guard and retry wrapper in their original order. |
| `src/web-search/registry.ts` | Plugin-context registration and pinned/single-provider selection. |

The loader at `src/catalog/load.ts` resolves `../model-catalog.json` relative to
its own `import.meta.url`, which is the original `src/model-catalog.json` asset.
It has no missing-file fallback or duplicate data copy. Invalid data fails at
module initialization. Importing the public facade still initializes this one
catalogue instance. Each call to `createProviderRegistry()` creates independent
Maps; `defaultProviderRegistry()` initializes one registry on its first call.
The built-in probe uses a getter into its registry's profiles Map, so later
registration/removal remains visible.

This package installs no watchers or background workers and exposes no shutdown
API. Abort signals and the HTTP probe timeout bound requests; adapter lifecycle
and protocol details remain with the individual LLM packages. The web-search
registry remains owned by the injected plugin context.

| Tests | Contracts covered |
| --- | --- |
| `test/provider.test.ts`, `test/directory.test.ts` | Catalogue/provenance, resolution precedence, independent registries, probe priority, candidates, headers and response normalization. |
| `test/probe-cancel.test.ts` | Cancellation before and after probe work. |
| `test/codex-subscription.test.ts` | Account-bound Responses routing and authorization. |
| `test/prompt-cache.test.ts`, `test/input-usage-semantics.test.ts` | Adapter-specific cache, input and usage behavior through the builder. |
| `test/retry-wiring.test.ts`, `test/waiting-http.test.ts` | Retry/wait configuration and wrapper behavior. |
| `test/websearch-seam.test.ts` | Registration and pinned/single/absent selection. |

Run `pnpm --filter @i-harness/provider exec vitest run --maxWorkers=2 --minWorkers=1`
and `pnpm --filter @i-harness/provider typecheck`. Fixtures use local HTTP or
injected clients; no real model accounts are required.
