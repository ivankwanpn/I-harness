# Independent review: retired single-store settings leaf

Approved for this scoped leaf. No actionable correctness, preservation, or maintainability findings.

Reviewed range: `a41230d96a84ba2ca14fa2cc36fc30ab3adc85f9..85beea4a7509c7aaa9273bf63d8cd5abfd351b12` (two files, 27 insertions). Reviewed the brief, implementation report, supplied review diff, complete contents of both changed files, raw red/expanded-red/green/type logs, and before/after source hashes. The current copies of both changed files match the leaf commit (empty `git diff 85beea4a7509c7aaa9273bf63d8cd5abfd351b12 -- <both files>`), despite subsequent unrelated accepted changes on MAIN.

- `packages/settings/src/storage/single-store.ts:120-129`: the ordinary save boundary deletes only the own root properties `theme`, `busyEnter`, and `transcriptMode` at line 123. It does not traverse or normalize unknown extension objects. This restores the stated retirement contract without changing the existing instruction metadata, revision, serialization, or publish sequence.
- `packages/settings/src/storage/single-store.ts:67-77`, `:84`, and `:91-99`: all save callers construct a separate document (spread-created set/reset documents or a structured clone for legacy provider removal). The deletion therefore does not mutate `this.raw` before a successful write. Provider-removal saves also retire the named root keys consistently with the ordinary-write boundary; provider data is otherwise outside the deletion target.
- `packages/settings/src/storage/single-store.ts:42-53` and `:103-117`: ordinary reads still do not write. Explicit instruction import retains its separate digest-bound raw transaction and does not pass through the changed save boundary.
- `packages/settings/test/retired-tui-keys.test.ts:183-205`: parameterized set/reset controls verify no rewrite on load, absence of retired keys after a write, exact preservation of an unknown root extension (including its own nested `theme`), native instruction provenance, enabled/default behavior, and instruction consistency after reopening. Existing tests at `:159-180` retain active TUI/provider and reload assertions. This is adequate regression coverage for the three-line production change.

Evidence inspected: the original red log records 1 failed/3 passed; expanded red records 3 failed/3 passed, all failures naming exactly the three retired root keys. The final green log records 110 passed across the retired-key, settings, sections, and instructions files with exit 0; the type log records `tsc --noEmit` exit 0. These are inspected root-run results, not independent reruns. No concrete risk justified rerunning suites or requesting the root runtime lease.

Independent read-only verification: `git diff --check` for the exact range exited 0. Current SHA-256 values match both recorded before/after evidence files:

- `single-store.ts`: `D2D7A4B7228EB4FE3C5876D2A27FCE01DE219DCB0C066C97663B4F10C6E510E6`
- `retired-tui-keys.test.ts`: `16E0B2267E7469021260CFA18B1EFFFB85C9C4B17647D404E8E1E5F262A145C8`

Scope limitation: this approves the retired-settings leaf only. It does not accept the entire version or replace the combined settings gate after W2 integration. No product or Git mutations, live profile writes, version changes, or Session 12 changes were performed by this review; only this report was added. Product remains 0.1.13-rc.1.
