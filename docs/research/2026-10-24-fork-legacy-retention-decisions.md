# F1 legacy retention decisions after store ownership acceptance

F1-L0 is accepted at MAIN `2e5a8ae9`; it supplies the actual legacy lifetime and shared quota mutation owner. This document fixes the next legacy-transfer design, not its implementation or the public fork cutover. The accepted B1 semantic seed and B2 bootstrap remain the history/creation owners, and ContextStore remains the owner of legacy bytes and canonical membership.

## Retain a commitment, not a second descriptor copy

The earlier draft proposed a second chunk graph for full legacy reference descriptors. That is unnecessary for the required F1 operations and is superseded. Each bounded observation row records `refId`, `revision`, `metadataDigest`, `metadataEncodedBytes` and `expiresAt`, alongside its typed source address, target turn extent/anchor and immediate inherited relation.

Compute the digest and byte count by streaming the complete canonical `ContextResultRef`, with a dedicated domain and lexical/data-only encoding. Do not hash only the body revision or selected metadata fields. Valid long source paths/revisions/identifiers do not gain an8192-byte or64KiB total descriptor limit. No complete encoded descriptor string, second descriptor object or descriptor chunk graph is needed.

For a live ref, the actual canonical ContextStore manifest supplies its full value; verify its complete digest/count, identity, original expiry, canonical ownership, body integrity and current scope. Ordinary reads return that actual ref. Missing, changed or corrupt live metadata blocks; a hash never reconstructs it or grants access by itself. A nested live transfer uses that same real ref and the parent's confirmed commitment.

Natural expiry may remove the original manifest/body only after a monotone expiry disposition bound to the full original tuple. Exact plan/application plus that disposition can confirm historical publication of an already-applied expired grant. It cannot restore data, create owners, extend expiry or authorize reads. A live missing manifest without the exact expiry disposition is unavailable. Explicit revocation wins over historical application. A new transfer containing expired selected refs may refuse; it cannot silently claim an empty selection. Restoring deleted descriptors or exporting deleted historical metadata is not promised by F1.

## Keep the original ownership requirements

Bounded plan pages/directories, complete selection, original application and revocation records still live inside the existing ContextStore. Its canonical owner arrays remain authoritative; immutable application records cannot recreate a missing owner. All mutations and physical accounting use the actual F1-L0 owner. Derived SQLite rows accelerate lookup only.

There is no new total-ref cap. Existing100-ref grant/query limits are per-call budgets, not a bound on one session's retained membership. Page/root encoding is bounded to64KiB and page fanout/rows to100, while traversal and canonical hashing stream. This page budget does not constrain complete original descriptor size or total selected ref count. Row fields use existing bounded identity coordinates and digests; large descriptor values stay in the original manifest.

New publication requires the live original source and target scope, plus the actual B2 reservation/manifest. Passive reconciliation uses target authority and already-published exact records only, with no source access, selection or missing grant writes. Warm continuation may only use the same original capture under a newly acquired valid source/target lifetime; it cannot reuse expired guard functions. The next executable plan must specify how partially written pages resume without retaining another full seed/archive or replaying producers.

Ordinary inherited access requires actual READY binding, exact plan/application, current canonical owner, no revoke/expiry, current scope and branch-visible typed anchors. Source-less refs cannot bypass those checks through an old generic owner shortcut. Source.clear removes that source's ownership but preserves a separately published target owner. Target/global clear and deletion revoke before removing the relevant owner. Unknown publication/cleanup remains attached to its original operation and cannot be turned into a new operation or success.

## Public caller decisions

The existing request hash owner remains canonical. A portable client module may mint `session-fork:v1:<canonical ISO createdAt>:<lowercase UUIDv4>` and derive `fork_<SHA256(domain + operationId)>` under the domain `ih.session-fork.target.v1\0`; receiver validation binds those fields before mutation. `@i-harness/sdk/fork` is the browser-safe subpath; it must not import the Node SDK root or implement a second canonical request hash.

READY/adopted receipts remain B2's truth. Host controllers own only pending whole flights, original cleanup and small source witnesses; B2 remains the single compiled seed/request cache. The actual managed document's private append-only view identity plus captured count/readiness is an append witness, not generic array-length authority. Source retirement removes witness lookup keys; advisory finalization may prune dead entries but never proves authorization or resource cleanup.

Content is fixed by the original durable issuance. On a cold retry, only confirmed B2 absence plus absence of same-operation legacy progress can take the genuinely new-work route under current source policy. This may evaluate the retained selection expression when no original effects were issued; it does not recover a lost volatile pre-issuance capture or claim exactly-once evaluation. Known warm capture/cached payload, conflicting/unknown physical state and complete original targets never take that fresh route. Stronger first-volatile-capture recovery would require a separate durable capture contract and is not claimed.

Both Gateway SDK and Desktop routes must use the same controller and capability. Retry retains the full original request/invocation and cleanup outcome. UI uses ordinary retry/new-fork actions and existing diagnostic details; it must not expose internal ownership mechanics as a user decision. A dashboard refresh failure cannot create another target. The next public-caller plan still needs to bind these interfaces to the actual legacy transfer implementation before dispatch.
