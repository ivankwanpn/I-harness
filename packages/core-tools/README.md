# Tool registry

`src/index.ts` is the public entry and composes one registry. It retains the
package's named and type exports; `./context-remaining` is also a public package
entry. Private modules import their contracts from `types.ts`.

| Module | Responsibility and ownership |
| --- | --- |
| `registry/catalog.ts` | Sole owner of tools, registration generations, promoted names and the installed search function. Captures each registration's tool and execute binding; serves live metadata, stable direct/deferred schema ordering and search promotion. |
| `registry/prepare.ts` | Clones and recursively freezes the call, captures its binding, validates schema before policy, merges per-call/ancestor decisions, applies guards, and seeds trusted execution metadata. |
| `approval/decision.ts` | Installs the pre-execute waterfall once per registry and validates/merges the closed decision vocabulary. An absent decision returns `undefined`, preserving ancestor classification of the original call. |
| `approval/identity.ts` | Captures current authority synchronously before approval waits. Owns each preparation's remembered-approval validation and human request, including fail-closed service lookup and remembered approval ordering. Guardian review remains at its original await sites in preparation. |
| `approval/arguments.ts` | Recursively freezes captured arguments and produces bounded, redacted approval summaries. |
| `registry/dispatch.ts` | Validates binding, current authority, approval identity and guards before the execution cascade and again immediately before the tool body. No await separates the final validation from body invocation. |
| `registry/finalize.ts` | Emits post-execute and returns the original output. Ordered-lane/once-finalization ownership remains with the scheduler/caller. |
| `types.ts` | Public tool, registry, approval and execution contracts; disposition codes, error classes and the structural policy-refusal marker. |

Approval and cascade metadata receive the returned registry object. Registration
generations outlive unregistering; promotions are removed with the tool.
Preparation/finalization use the caller's ordered lane, while dispatch may
overlap. Prepared calls retain existing caller-owned reuse semantics. The
existing `json-schema.ts`, `observation.ts` and `context-remaining.ts` remain
independent responsibilities. Scope retirement belongs to later lifecycle work.

Run the package suite and typecheck sequentially:

```sh
pnpm --filter @i-harness/core-tools exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-tools typecheck
```

`test/registry-contracts.test.ts` characterizes ownership, frozen operation
identity, authority capture before human/guardian waits, immediate dispatch,
caller-owned finalization, live catalog/search references and refusal markers.
Existing authority, guardian, schema and execution tests retain their coverage.
Consumer checks are `core-agent/test/{execute-tool-calls,batch-isolation,finalize-cancellation,tool-lookup-isolation}.test.ts`
and `guard-approval/test/{approval-v2,active-rules,guardian-review}.test.ts`, with
the same worker limits and each package's typecheck.
