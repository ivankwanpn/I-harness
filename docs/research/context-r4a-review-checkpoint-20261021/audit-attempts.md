# Read-only review audit attempts

2026-10-21. First `evidence-audit.mjs` invocation exited1 after validating the portable records, because I incorrectly assumed individual gate receipts were under `.tmp/r4v1/receipts/`. Native Node error: `ENOENT` opening `.tmp/r4v1/receipts/01-p3-native.receipt.json`. This was a reviewer path assumption, not product or sealed-evidence failure. No product was imported and no old runner was executed. The corrected attempt uses the observed original receipt location and preserves the failed attempt here.

Earlier read navigation used PowerShell-glob-looking literal arguments to ripgrep (`packages/subagent/src/task*`, test counterparts); rg returned Windows error123. Corrected searches targeted real directories. An archive navigation query initially selected nonexistent `files` instead of observed `originals`, producing no selected rows. These read-only navigation failures did not mutate source/evidence or constitute behavioral results.

Two separately authorized fresh semantic probes under `.tmp/r4rv-1021-01` and `-02` reached their intended assertions on their first invocations and exited1 for actual current-format success-inference failures. They are preserved as semantic failures, not folded into the audit setup correction.
