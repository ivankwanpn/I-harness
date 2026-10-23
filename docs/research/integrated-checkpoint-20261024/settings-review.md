# Independent W2 settings consumer review

**Verdict: changes required. One Important finding; no Critical findings.**

Reviewed the complete `807d2cc082632544034aa13bbd8a75d2b952fcf0..9094f2190d2dbdfca0eec63184656efc9573421f` diff in the frozen checkout `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`, against task-1-brief.md, the promoted plan, and the implementation report. This is a scoped implementation review, not integrated W2 or release approval.

## Important — normalize the layered baseline keys before handing them to the adapter

**Location:** `packages/settings/src/storage/layered-store.ts:249–250`; causal lookup at `packages/settings/src/observation/watch-settings.ts:35–36`. Existing source construction at `packages/settings/src/storage/layers.ts:86–88` permits a relative path for `roots.workspace: "auto"` when `options.workspace` is relative.

`read()` commits stamps under `source.path` (`layered-store.ts:68,70,75`), and ensureWatcher passes that map unchanged. The adapter resolves selected paths to absolute names and retrieves the supplied baseline with those absolute keys. For a relative workspace source, the lookup misses and invokes `readSourceStampSync` again. A write between the store's read/publication and watch acquisition then becomes the adapter's new baseline. The initial reset compares equal, so the store can indefinitely retain the old effective settings until another observable event occurs. This violates the packet's central load-to-watch-gap guarantee even though the supplied map contains the exact bytes that load committed.

**Reproduction and evidence:** Root granted one bounded runtime lease. `review-startup-probe.mjs` uses the real LayeredSettingsStore, a controlled lease, and an ensureWatcher seam that changes the actual fixture file immediately after load has read and published its bytes, before calling the original ensureWatcher. It neither mocks filesystem reads nor edits product files. The same operation is exercised once with a relative workspace and once with an absolute workspace:

| Case | Published before watch | Disk after boundary write | Effective state after initial reset | Notifications |
|---|---:|---:|---:|---:|
| Relative workspace | 14 | 15 | **14** | **0** |
| Absolute workspace control | 14 | 15 | 15 | 1 |

The relative baseline key and absolute selected key are printed in `review-startup-probe.log`. The probe exited 0 because its assertions confirmed the defect and the working control. `review-startup-probe-command.txt` records the package CWD and invocation. Both stores were closed and fixtures removed. All 43 recorded source hashes match before/after in `review-startup-probe-before.json` and `review-startup-probe-after.json`; the host runtime lease was released immediately afterward.

**Suggested correction:** Canonicalize baseline keys using the same absolute-path operation as the adapter, either when the store records them or when ensureWatcher builds its supplied baseline. Preserve configured callback spelling where required. Add a relative-workspace auto-source regression at the same read/publication boundary; keep the absolute-path control. Do not reconstruct the baseline with another filesystem read.

## Other reviewed behavior

No other concrete defect found in the scoped implementation. The adapter acquires one nonpersistent lease, separates coverage from content validity, uses exact-byte stamps, retains same-path work arriving during an awaited read, forces changed-event invalidation, and leaves retry ownership with W1. Callback invocation isolates exceptions and returned promise failures; the fallback diagnostic contains constant text. Close fences synchronously, joins accepted adapter work and owned resources, preserves failed cleanup for retry, and does not close a borrowed service. The per-invocation AsyncLocalStorage token confines the self-close exclusion to the requesting adapter callback while retaining joins for other accepted callbacks.

Layered reads stage documents and stamps before committing; malformed and non-missing I/O failures retain the prior published state. Watched attribution captures both effective state and source differences within the serialized read. The strengthened B/C queue expectations correctly report both changed sources, and self-write stamps come from the exact serialized write text. The gateway returns the refresh promise, fences at the original early shutdown point, and joins after session/plugin cleanup; the existing retryable cleanup structure remains intact.

## Contract and evidence qualifications

These are scope qualifications, not additional blocking implementation findings:

- **Layered subscriber promises are not joined.** `layered-store.ts:255–270` observes rejections from onChange listeners, telemetry, and onWatchError, but does not retain their returned promises. Its close at `154–164` joins the watcher, active reload, and queue. Task 2 explicitly preserves void subscriber contracts and specifies those joins; Task 1's full callback-join contract belongs to SettingsWatchHandle. Root confirmed that asynchronous continuations from the layered void callbacks remain caller-owned. The comment at `139` should be read as accepted store operations, not arbitrary subscriber continuations; documenting that distinction would prevent overclaiming. IC-B must not use a layered subscriber's async return as a joined shutdown boundary.
- **Final receipts match the stated test counts.** The whole settings log records 216 passed and one failed out of 217, including all 58 watcher/layering tests passing. The real missing ignored-parent case took 843 ms; source retains intervalMs=60000 and the original 3000 ms wait bound. Gateway close receipts record 4/4 passing. The intermediate RED/GREEN and final held-read counts agree with the report. Supplementary controls are correctly described as green controls rather than all having independent RED runs. No suite was rerun for this review.
- **The single-store failure is not waived.** The final whole run and `retired-keys-baseline.log` show the same retired-key survivors: theme, busyEnter, transcriptMode. The baseline log identifies BASE and exit 1 with 3 passed/1 failed, and the reviewed diff leaves the single-store implementation and retired-key test untouched. The restoration mechanism itself is described in the implementation report as residing in the tool transcript, not fully encoded in the raw baseline log. This review follows the root's accepted baseline attribution; it does not turn that known failure into an all-settings-green or release statement.
- **Source binding is selected, not whole-runtime attestation.** `final-before.txt` and `final-after.txt` are byte-identical. Independently recomputing their 43 SHA256 entries against the frozen checkout produced zero mismatches, including the protected diagnostic and patched handler. The records cover settings sources/tests, the edited host/test, and that handler; they do not hash every gateway dependency, package manifest, lockfile, or all W1 sources. The reviewed diff changes none of those manifests/lockfiles/W1 sources. Current workspace links point settings to fs-watch, gateway to settings, and fs-watch to the patched chokidar dependency. The manifests declare the dependencies and build-gateway.mjs traverses declared dependencies. This supports the scoped report, not a fresh packaged-runtime qualification.
- **Typecheck receipt limit:** Both final typecheck logs contain only `$ tsc --noEmit` with no diagnostics. Exit 0 is reported by the implementer; those short log files do not themselves encode an exit marker. No contrary typecheck evidence was found, and this review did not rerun them.

The main plan is coherent when adapter callback ownership and layered void-subscriber ownership are kept distinct. Its startup baseline guarantee is not fully satisfied for relative workspace sources. Correct the Important finding and return the changed source plus bounded regression receipts to this same reviewer before accepting this packet.

No tracked product file, Git state, protected diagnostic, or dependency was modified by this review. Final checkout status remains only the pre-existing untracked diagnostic. Review artifacts and the explicitly authorized bounded probe were written only in this SDD directory.
