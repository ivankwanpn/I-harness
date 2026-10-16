# File-backed session queries

`../file-backed.ts` is the stable direct facade; the package entry continues to
export the query factory, options, inspection outcomes, and error class. The
existing `../index.ts` also keeps its legacy read-only SQLite query implementation.

- `contracts.ts` holds the original options, source/index row contracts, and
  observable error types and messages.
- `database.ts` owns the only process-level set of file-backed connections,
  permission preparation, opening, identity checks, and failure-safe closing.
- `schema.ts` owns the derived schema identity, version, and transactional setup.
- `inspection.ts` scans the JSONL root and parses its original header and
  contiguous event prefix, including the original fingerprint line selection.
- `index-refresh.ts` owns one reconciliation promise chain per query instance.
  It removes missing sessions before rebuilds, updates identical-content
  revisions, and performs the same two stable observation attempts and per-session
  transactions. The inspection hook runs after commit and before the stability
  re-stat. Failed work leaves the chain available for the next observer.
- `query.ts` runs reconciliation before every search or lineage read, then reads
  the owned schema using the original sanitization, limits, filtering, and order.

JSONL remains the sole authority and is read-only here. This index never migrates,
repairs, or writes the source. Scan/decode failures raise `SessionQueryError` with
`SESSION_QUERY_OBSERVE_FAILED`; foreign or newer index identities raise
`SESSION_QUERY_INDEX_FOREIGN`. Existing raw read/stability/transaction/cancellation
failures propagate at their original boundaries. Failed observation never returns
stale results. Search hit times remain index rebuild times from `Date.now()`.

`closeFileBackedConnections()` closes the file-backed set. Public
`closeSessionQueries()` closes the existing legacy query owner and this owner,
allowing hosts and tests to release Windows file handles. Each query has exactly
one database and one reconciliation chain.

The warning module installs its process filter as an import side effect. Both the
facade and `database.ts` import it before the first runtime `node:sqlite` import;
the package entry preserves its own leading warning import. SQLite imports in
schema, refresh, and query are type-only. Keep this evaluation order when moving
modules. Tests import both actual entries in child processes and ensure unrelated
warnings still reach stderr.

Verification from the repository root:

```powershell
pnpm --filter @i-harness/session-query exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-query typecheck
pnpm --filter @i-harness/cli typecheck
pnpm --filter @i-harness/desktop-gateway typecheck
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```

Reconcile-on-search is intentional in this decomposition. Event invalidation and
the existing blank-line/fingerprint parsing concern belong to later E7 work.
