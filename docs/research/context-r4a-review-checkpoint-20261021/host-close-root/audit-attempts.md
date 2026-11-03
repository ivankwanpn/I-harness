# Root static audit attempts

2026-10-21. This directory is root-owned evidence outside the immutable writer roots.

The first full read-only audit exited1 at audit.mjs:136 because the checker expected `production-graph.json.cycles` to be an empty array. The actual schema records a numeric cycle count,0. The error was `AssertionError: 0 !== []`; this is an audit-tool schema error, not a product failure. The exact first script is preserved as `audit-before-cycle-schema.mjs`. All earlier tree/hash/proof/receipt/copy/observation checks had executed before this final graph assertion, but no PASS report was written.

The corrected script checks numeric cycles===0 and reruns the independent static audit. It imports only Node filesystem/assert/path/crypto/zlib and never imports product, executes tests/builds or modifies sealed evidence. Final `audit.json` records the resulting outcome only if every check passes. Preliminary read-navigation commands also overexpanded a public manifest object in tool output before its gateway/bundle shape was inspected; no artifact or source was modified by that read.

The separate acceptance-copy/link checker initially selected an exact copied review using a slash-only suffix against Windows-native resolved paths, producing undefined before link validation. Normalizing separators fixes that checker; the original private script is retained beside it. This did not change any source, copied review bytes or sealed evidence. The full content audit above had already passed independently.
