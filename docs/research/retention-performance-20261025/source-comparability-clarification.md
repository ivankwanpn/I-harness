# Source comparability clarification — Task 1

This supplements, and does not overwrite, `../task-1-report.md` or any command/receipt/manifest. No runtime workload, product/test edit, evidence-runner edit, commit change or protected-file read/run/edit was performed for this clarification. HEAD remains `a3dbcfc528e5ed4e87dfb229cf478704271b5e0b`.

## Finding and correction to the report's interpretation

The reviewer is correct: `red-final-probe` and `final-fast-gate` do **not** have identical helper/test source, in addition to the intended product change. `sourceStable: true` establishes stability within each command group; it does not establish equal source between groups. The original report should not be read as claiming byte-identical full instrumentation or whole-test comparability between those two groups. Its omission of the exact intervening test-only edits is clarified here.

The named one-admission control remains directly comparable: its test body is byte-identical; its entire module prefix containing imports, interception declarations, method wrappers and both direct admission controls is byte-identical; the only helper change is a synchronous-throw bookkeeping guard on `work()`, a branch not taken by this successful original/native admission. Original full-inventory counting, native forwarding, resource observation, SQL-ceiling observation and asynchronous settlement logic are unchanged. The preserved native receipts show old 2/new 1 inventories, old 8/new 4 lstat calls, the same actual byte inputs and the same 24-page ceiling.

## Exact recorded source hashes

Hashes below are SHA256 of the actual working-source bytes recorded before each command, not inferred Git identity or newline-normalized equivalence. `focused-green` and `final-fast-gate` agree exactly for all three files; frozen current source also agrees exactly with the final column.

| File | red-final-probe/source-before.json | focused-green and final-fast-gate/source-before.json |
|---|---|---|
| packages/context-output/src/store.ts | `BD991EE39EA2BEF15D75717CF05E5DB7022268BA0F8897D4ED710C7E2C605C3E` | `596B263C249D9C05DC99B472D2D68580C4EC4E2675A597482D6FC9F8C21E4EF3` |
| packages/context-output/test/helpers/legacy-performance-probe.ts | `F8D32CFFD988BC3DC2D00502A134D1B64C3A4AF7E2D75F8E52DE9DE0A6702B50` | `49572EC2F49C3E88940583C1EC4E4B3BEFF0F4674109DF2A976DF3CEED657721` |
| packages/context-output/test/legacy-fork-performance.test.ts | `F8165304AEDF7C0CEB0D29E32748C066A27240120ACCF44359CF2447A48610AA` | `E2A7C216464F36227267E3EDCE89E5319D593C9656CC7768A7F79EB0FC2B1747` |

## Prior-source provenance and recovery

I did not separately archive the full raw helper/test contents before the RED run. The original evidence preserves their SHA256 identities and raw commands/results. The exact post-RED edits are known from my implementation actions: I added a synchronous-throw span guard to the helper, then added setup/teardown failure-receipt handling and post-expiry assertions to the bounded test. Those edits were made in the same patch as the intended `store.ts` change after `red-final-probe` ended and before `focused-green` started.

For this clarification I reversed only those known exact edits against frozen final source. Each reverse replacement required a unique exact match. The reconstructed helper and test byte streams each match their independently preserved RED source-before SHA256 **exactly**, including the recorded newline form. They are therefore exact recovered RED contents, not an invented or approximately remembered prior implementation. Their provenance remains reconstruction, not a previously archived raw source snapshot. The BASE store Git blob, in the matching working-tree newline form, independently matches the RED store hash.

New evidence, created without replacing earlier artifacts:

- `source-reconstruction/reconstruction.json`: provenance, full old/final hashes and exact recorded-hash-match results.
- `source-reconstruction/red-final-probe-helper.ts`: recovered exact RED helper bytes.
- `source-reconstruction/red-final-probe-test.ts`: recovered exact RED test bytes.
- `source-reconstruction/red-final-probe-store.ts`: recovered RED product bytes matching BASE and the RED manifest.
- `source-reconstruction/red-final-probe-helper.ts.to-final.patch`: complete exact helper old-to-final diff.
- `source-reconstruction/red-final-probe-test.ts.to-final.patch`: complete exact test old-to-final diff.
- `source-reconstruction/named-control-comparison.json`: exact test-body/prefix equality checks and native receipt pointers.

## Complete helper/test semantic differences

The complete patches contain only the following changes.

1. **Helper, hunk at old/final line 44:**

   ```typescript
   // RED
   const pending = work()
   // Final
   let pending: Promise<T>
   try { pending = work() } catch (failure) { settled(true); throw failure }
   ```

   The final helper records a failed elapsed span if the callback throws synchronously, then rethrows the same error. When the callback returns its original promise, both versions attach the same success/failure settlement observers and return that same promise. There is no change to the native I/O observers, full inventory start recognition, counters, hash observation, SQL observation, arguments, handles or results. All successful admission work in the named control follows this unchanged promise-returning path. Specifically, its callback calls the real `owner.mutate`, whose `enqueue` API returns a promise even for refused admission; the inner callback calls the original async `admitLegacyIndex`, which also returns a promise.

2. **Bounded test, hunk at old line 101/final line 101:**

   ```typescript
   // RED
   const f = await probe.run('fixture-setup', 'capture-and-grant', () => legacyFixture({ distinct, observations, summary: true }))
   // Final
   let f: Awaited<ReturnType<typeof legacyFixture>>
   try { f = await probe.run('fixture-setup', 'capture-and-grant', () => legacyFixture({ distinct, observations, summary: true })) }
   catch (failure) { await receipt(name, { distinct, observations: distinct * observations, setupFailed: true }); throw failure }
   ```

   This preserves counter receipts on fixture setup failure. The successful fixture call, arguments and existing setup/owner work are the same. It does not affect either direct admission control.

3. **Bounded test, hunk at old line 125/final line 127:** the exact same expiry-trigger capture is assigned to `triggered`; after that capture and its sweep have already settled, final source adds an `assertions/expiry-effects` span. It checks that capture returned a ref and performs one actual `stat` assertion per selected original body expecting `ENOENT`, proving GC effects. It also hashes the literal workspace identity while building that assertion directory and adds this assertion duration to `assertionMs`. This is real additional correctness-test filesystem work **after** the measured owner, startup and expiry sweep, outside their scopes. It changes the whole-test assertion workload and adds an assertion bucket, so whole-test time, `assertionMs`, aggregate hashing/counter bookkeeping time and all-scope totals are not directly source-identical comparisons.

4. **Bounded test, hunk at old line 131/final line 140:**

   ```typescript
   // RED
   await probe.run('teardown', 'close', () => f.close())
   await receipt(name, { distinct, observations: distinct * observations, assertionMs })
   // Final
   try { await probe.run('teardown', 'close', () => f.close()) }
   finally { await receipt(name, { distinct, observations: distinct * observations, assertionMs }) }
   ```

   This preserves receipts if teardown close fails. Successful native close behavior is unchanged. It does not affect either direct admission control.

All of the bounded fixture selection, owner invocation, graph/index/funding/application/final-proof marker logic, original I/O observers, body-byte/hash equality checks, native resource checks, cold startup, fake-clock setting and original expiry-trigger arguments are otherwise unchanged. The helper/test diff is not merely line-ending noise.

## Named admission control: exact comparability evidence

The test named `uses one actual physical snapshot for an index admission predicate and SQLite ceiling` is byte-identical from its `it(...)` declaration through its end. Its extracted-body SHA256 is:

```text
4AF7AC4AB38720A3ACF5B800423137729613E4DDB2537BDADB68B091981BEBE0
```

The whole test-module prefix before `it.each([` is also byte-identical. That prefix includes the original promise/handle interceptors, SQLite exec observer, startup/body/prune/private-admission wrappers, receipt function, named one-admission control and the headroom/refusal control. Verification of this equality is preserved in `source-reconstruction/named-control-comparison.json`.

The helper source difference is limited to the synchronous failure branch described above. Neither receipt shows a synchronous callback failure: both admission spans settle successfully, the named admission's native I/O bucket has no failures, and the intended RED failure is the later `expect.soft(...inventories).toBe(1)` assertion outside the measured promise. Thus the added helper catch does not explain or manufacture the inventory delta.

| Actual receipt field | red-final-probe/legacy/single-admission.json | final-fast-gate/legacy/single-admission.json |
|---|---:|---:|
| total | 86,016 | 86,016 |
| index | 86,016 | 86,016 |
| quota | 217,145 | 217,145 |
| full inventories | 2 | 1 |
| readdir calls / returned entries | 8 / 8 | 4 / 4 |
| lstat calls | 8 | 4 |
| successful SQLite page admissions | 1 | 1 |
| SQLite requested ceiling | 24 | 24 |
| final active observed I/O / handles | 0 / 0 | 0 / 0 |

This supports the named structural RED/GREEN claim under the same direct-control body and same successful counting/forwarding semantics. It does **not** claim byte-identical entire test/helper files or an elapsed speedup. The broader owner/index counters remain structurally comparable within the unchanged owner scopes, but the full-test totals and assertion/overhead measurements require the qualifications above. The previously reported coarse phase-marker limitation also remains.

## Further verification scope

The exact prior source is recovered and matches the independently preserved hashes, so there is no missing-prior-source gap requiring a runtime rerun merely to explain these changes. No new runtime execution is proposed as necessary by this clarification. If root/reviewer nevertheless requires a literal identical-final-instrumentation runtime RED, the only suitable follow-up is **one** isolated run of the exact named one-admission test with only BASE `store.ts` temporarily overlaid, final helper/test bytes unchanged, fresh evidence roots, and restoration/source verification in `finally`. No bounded scales, full gate, 1001 or 10001 workload should be repeated. Such an overlay/run has not been performed or authorized here.
