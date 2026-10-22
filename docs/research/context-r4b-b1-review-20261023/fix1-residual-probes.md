# B1 fix1 metadata and prepared-input follow-up probes — 2026-10-23

These are the reviewer's two requested offline controls on unchanged fixed product `163e0f469fc658ba9ffb0d962f22dc2115b77169`. They are execution evidence for root's re-review disposition, not implementation or acceptance. The probes demonstrate one successful invalid metadata publication and two prepared-input accessor reads before eventual export refusal.

## Execution boundary and identity

- CWD `D:/I-harness-main`; HEAD before/after `163e0f469fc658ba9ffb0d962f22dc2115b77169`.
- Fresh scratch root: `.tmp/r4b-b1-fix1-metadata-probe-20261023`, created only after checking it did not already exist. Scripts, local stores, raw before/after files, JSON outcomes, full logs and source hashes remain there.
- Sole product runtime owner; both commands ran sequentially and completed. No product or maintained-test edits, fixes, commits, networks/providers/accounts/user sessions, agent dispatch or prior evidence mutation.
- Before/after SHA256 scope: all132 tracked source files under core-session/session-persistence/session-persistence-jsonl plus the literal ready fixture. `source-before.json`, `source-after.json` and `source-comparison.json` show **132 checked, 0 changed**.
- Product Git status is clean; the same three root-only documentation files remain dirty. Original fix report SHA256 remains `bbbf97fff67c2298e11a5c2351766cf0e79bdac63110b6ceae217792ebac1c69`; original/fix evidence is preserved.

| Actual command from repository root | Exit | Receipt/output |
| --- | ---: | --- |
| `pnpm exec tsx .tmp/r4b-b1-fix1-metadata-probe-20261023/probe.ts` | **0** | `01-command.json`, `01-probe.log`, `results.json` |
| `pnpm exec tsx .tmp/r4b-b1-fix1-metadata-probe-20261023/prepared-input.ts` | **0** | `02-command.json`, `02-prepared-input.log`, `results-prepared-input.json` |

Both commands had **zero setup failures**. Exit0 means the requested control executed and recorded the observed outcome, not that the tested contract passed. A read-only discovery command referenced a nonexistent `test/input-preparation.test.ts`; the actual setup came from `generation-history.test.ts:37–49` as requested. That path error did not execute a fixture or affect behavior evidence.

## 1. Computed title mutates the already-checked semantic reservation

Each case starts from its own actual `createJsonlBackend(store).create` target with valid current11 metadata and literalReady reservation; supported `replaceEvents` installs the complete three-event fixture. Genuine backend read and public projection verify **version11 / 3events / 2items** before mutation.

For the requested adversarial case, the script constructs exactly:

```ts
const patch = { semanticSeed: structuredClone(loaded.meta.semanticSeed) }
Object.defineProperty(patch, 'title', {
  enumerable: true,
  get() {
    reads++
    patch.semanticSeed.seedDigest = changedValidHexDigest
    return 'computed title'
  }
})
await backend.updateMeta(id, patch)
```

The seed digest changes by one valid hex digit:

```text
before: 9d5c8883be3c13c41720b5eb99708e626515685554288c65cd6b8150ac363372
after:  0d5c8883be3c13c41720b5eb99708e626515685554288c65cd6b8150ac363372
```

| Observation | Computed title mutates reservation | Ordinary string-title positive |
| --- | --- | --- |
| Getter calls during update | **1** | **0** |
| Public update result | **Resolved**, returns mutated reservation and `computed title` | **Resolved**, returns original reservation and `ordinary title` |
| Bytes before → after | **2898 → 2898**, content changed | **2898 → 2898**, content changed |
| Changed header keys | **semanticSeed, title** | **title** only |
| Event body | Byte-identical | Byte-identical |
| Subsequent public backend read | **Rejected `TypeError: Invalid semantic seed`** | **Resolved**, version11/3events/new title, original seed digest |
| Does subsequent read change bytes? | No | No |

The ordinary case uses a separate ready target and the same cloned equivalent reservation plus an ordinary string title. It demonstrates that the setup and allowed metadata update work without mutation of protected identity.

The current path is `session-persistence-jsonl/src/index.ts:260`'s `assertMetadataUpdate(previous,patch)`, followed by the shallow merge at263. The equivalent reservation passes the descriptor/data comparison in `src/format.ts:16–27`; the later title getter executes during spread and changes the same nested object already shared into `merged`. Shape serialization at265 accepts its valid hex shape and publishes it. Subsequent read at148 reaches the strict history/readiness owner; `core-session/src/conversation/bootstrap-validation.ts:69` detects the stored manifest versus changed header digest mismatch. This path explanation is supported by the actual successful write/invalid-read outcome, not substituted for execution evidence.

Raw byte copies are `<case>-before.jsonl` and `<case>-after.jsonl`; full headers and SHA256s remain in `results.json`. Computed-case before SHA256 is `91e654b795054e41f87475410d49cc5350bc243150682d3a2665076394754322`; after is `e68e322b2629c9122886138115f525b8ed1941eb49f46e8307adf4e946497d29`.

## 2. Real prepared-input text accessors before selected capture

The second script follows the genuine nondurable setup in maintained `packages/core-session/test/generation-history.test.ts:37–49`: createSession → createNondurableFactOwner.beginAction → actual input admission → captured generation open → captured preparation start → settlement-source captured completion → actual `action.facts.inputs.start` with the committed result. It closes the settlement source and finishes the action. No event history or preparation linkage is manually invented.

All five actual fact outcomes are `memory-committed` / `durability:nondurable`, with seq groups `[0]`, `[1]`, `[2]`, `[3]`, and `[4,5,6,7,8]`. The start operation genuinely adds the turn and raw/derived promotion records. Each variant builds an independent fresh source and verifies **unmodified export(all) returns `seed`**, emitting both `/raw` and the actual generated prepared context.

| Variant | Actual selected message | Getter returns | Final export result | Getter calls |
| --- | --- | --- | --- | ---: |
| Promoted raw text | `user/message`, seq**6**, raw preparation link | Original `/raw` | **`refused`, reason `invalid-seed`** | **2** |
| Derived prepared text | `user/message`, seq**7**, derived preparation link | Original generated host-prepared observation text | **`refused`, reason `invalid-seed`** | **1** |

Both replacement properties are own enumerable getters returning the original benign strings. Getter counts are captured immediately after `exportConversationSeed(session,{kind:'anonymous'},{kind:'all'})`, before any logging of the source. No getter-derived content is successfully exported in these variants, but the zero-read contract fails **before** the later refusal.

Relevant current paths: `conversation/input-preparation.ts:45` compares raw `event.text` with `admission.text`; line39 compares derived `event.text` with `inputObservationText`. The source provenance owner also compares promoted raw text against admission at `conversation/sources.ts:58`. These index/provenance checks precede the renderer's descriptor-aware selected capture. The new metadata preflight intentionally skips payload text, so it does not intercept these earlier text consistency reads. The actual counters distinguish this remaining early-read problem from the renderer-only case already covered by the fix-round tests.

## Disposition boundary

No fix is included, no maintained regression was added, and no broad suite was rerun. The preserved results invalidate a claim that the first fix round fully closes these two read/publication boundaries; root and the same independent reviewer own the re-review disposition and any next implementation scope. Runtime has finished and is idle.
