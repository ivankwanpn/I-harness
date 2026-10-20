# Root audit attempts

The first read-only identity/receipt/source/collection audit passed:44sequential source-stable receipts,601tests/72files,10original copies and4753current delivered inputs. It did not yet include evidence closure/portable byte/source declaration checks.

The extended audit's first run exited1 at its own portable-original lookup: it treated all item paths as evidence-root relative. Four explicitly `.superpowers/sdd/2026-10-21-context-r4a-surface/` executable helper paths are workspace-relative. Native error was ENOENT for `D:/I-harness-main/.tmp/r4au-1021-01/.superpowers/sdd/2026-10-21-context-r4a-surface/run-gate.mjs`, Node24.15.0. This was a root audit path mapping mistake, not missing delivered evidence or a product/runtime failure. No evidence/product file was mutated; the failure occurred after sealed inventory/hash checks and before completing portable comparison.

The root audit now explicitly selects workspace ONLY for that exact scoped helper prefix, evidence root for every other item, and checks containment before comparing actual bytes. There is no existence-based fallback or alteration of the writer's item paths. Final outcome is recorded in the subsequent audit.json with this final script. No product tests are rerun by any audit attempt.
