# Context snapshot boundary

`captureContextSnapshot(session, { ownerSessionId, surface })` captures the active
core-session projection and a detached request surface. `readContextCoordinates`
derives the same context identities without a surface, provider, authentication,
preparation or transport. Both return a bounded unsupported result for data they
cannot safely capture. Core-session remains the single conversation fold and
renderer; core-agent remains the single admission/calibration/recovery owner.

Supported payloads are JSON data: finite lossless numbers, strings, booleans,
null, dense arrays and enumerable own data records with plain or null prototypes.
Undefined record fields are omitted. Unsupported payloads include accessors,
cycles, functions, callable toJSON, symbols, nonenumerable fields, sparse/extended
arrays, custom prototypes, bigint, negative zero and unsafe integers. Descriptor
inspection precedes payload reads. Reflecting on arbitrary Proxies can itself
have effects; this API does not promise Proxy inspection is side-effect-free.
Only newly owned nodes are frozen, and rendering yields fresh adapter containers.

Archive cursors are observations, separate from model-visible semantic identity,
protection, branch and rewrite lineage. Digests are SHA-256 over a versioned,
domain-separated canonical encoding; record keys sort and array/native order is
preserved. Effect-only evidence belongs to protection. Pending/unknown call
evidence remains protected even in a structurally
closed exchange, and its reported state participates in protection identity.
Identities are replay facts, never scheduling, authority, lease or
result-promotion capabilities.

Reads currently rewalk and validate history synchronously. There is no mutable
length cache or incremental performance claim. Persisted budget identities refer
to measured request input; accepted output and later edits retain historical
measurements with unavailable admission. Cold metadata cannot certify the current
system/schema surface and therefore cannot restore fit. Actual capture errors
block the main request before prepare; no opaque mutable fallback is provided.

This package implements R1C only. Structural reduction/publication, policy
replacement and the remaining R1D/R2–R6 responsibilities have separate gates.
