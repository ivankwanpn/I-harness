# Genuine format12 retained ordinary child producer

This separate test-only capsule contains765 source files from immutable
`c76a56011e16057030c2fa7106d358b1eac99657`, the actual format12 predecessor.
It also carries the one required original data file,
`packages/provider/src/model-catalog.json`, pinned to its c76 Git blob/hash.
It does not modify or replace the207-file Task1 predecessor capsule.

`source.json.gz` is a JSON object with normalized original Git blob content
and one independently identified test driver. `manifest.json` binds every
relative path, byte count, SHA256, original Git blob and resolved import edge.
The manifest embeds the predecessor workspace's original MIT LICENSE and
records its hash. The additional driver/runtime are test-only code in this
repository; no third-party source or native binary is redistributed.

Use `produceFormat12RetainedResult({ root, dependencyRoot? })` from
`test/helpers/format12-retained-runtime.ts`. Supply a fresh task-owned actual
data/workspace root. The helper verifies the capsule and installed direct
dependency metadata/entry hashes before starting a producer. It extracts only
captured files, resolves workspace imports only through captured import edges,
bundles that exact graph, refuses residual workspace externals, and links only
declared installed third-party package roots. It then launches one hidden owned
Node child and joins actual exit, IPC and closed output streams.

TypeScript's AST transformer replaces only actual `import.meta.url`/`dirname`
property expressions with each original captured module's private extracted
location. Strings/comments are not rewritten. This preserves the catalog's
original relative load and original module-local dependency resolution. Build
provenance records TypeScript version, changed modules, transformed hashes and
the emitted bundle hash separately from original source hashes. Emitted bundle
bytes are not asserted equal to old TypeScript source. Other module-relative
worker/native assets are outside this producer path and are not copied.

The compiler APIs execute from the selected `dependencyRoot`, even when the
helper is hosted in another checkout. Before loading either API, validation
binds its package name/version, package metadata hash, resolved package root,
resolved entry path and entry content hash to the manifest. Build provenance
records these exact loaded paths/hashes plus the APIs' reported versions.
Same-version compiler entries with different content are refused before any
producer data root or child is created. The helper host supplies no compiler.

The child uses the original service, original JSONL writer, real model-issued
background spawn, original TaskResultOwner, original ContextOutput retention,
original source end and original task save. A task-owned loopback SSE provider
returns deterministic escaped Unicode output. The original tool reads96,785
encoded bytes through31 actual pages; expected bytes are independently encoded
before task execution. The SHA256 is
`21779f96fe93d10ccd48e47f8fc2418d75389ea354b2b6dee8d2193a94986f84`.

Only the real service's named notification admission operation is held until
the backend confirms the original end frame. The unchanged real notification
adapter then reaches a deliberately refused pre-native admission. The old drain
saves its own error outbox, attempts1. No fake consumer, result envelope,
registry terminal status, receipt or format-version rewrite is used.

Readiness observes the original coordinator's actual successful strict task
document save and the independent original backend end commit. The observer
forwards the same document, returns the exact original write promise and leaves
its errors and saved retention label unchanged. It adds no save/retry and does
not poll the task file during writes. Original source/result/end creation and
the old tool's full paged body read remain decisive. After actual child exit
and closed streams, the parent independently reads the final raw task document
and complete original journal, checks their exact result revision/ref/end and
the original error outbox, and rejects any original notification admission.

The deliberate refusal leaves original managed close debt. Original service
and coordinator close failures are recorded recursively. The child sends its
cut message and actually exits73. This is process-release evidence, not
successful logical disposal. The parent rejects any primary producer failure,
wrong exit or missing IPC/stream-close observation.

The current-reader caller must open the **same data root after the returned
child close**. The helper returns actual session/task/revision/ref and expected
body bytes. Do not copy original data, rewrite workspace/source identity, infer
delivery authority from the task document, or call this capsule a current-reader
pass. Current result readability and zero automatic operational binding,
receipt/admission/request remain assertions for the later current service.

Recorded construction evidence preserves earlier local failures, including an
old notification/end ordering race and a Vitest-intercepted attempted exit.
The SDD predecessor report binds the original pre-run graph, driver, local
production and portable qualification separately.
Later PF03 evidence preserves two original Windows EPERM task-save failures,
including a short-root failure. One bounded IO control did not reproduce them;
their cause remains unresolved. Removing live task-file polling and a later
successful qualification do not establish an OS/filesystem fix.

Runtime assumptions are Node>=22.18, esbuild0.28.2, the manifest's TypeScript
compiler version, and the manifest's installed
direct dependencies. Package metadata and recorded direct CJS resolution entry
bytes are verified; installed transitive contents, conditional ESM entries and
platform native dependencies remain host/runtime assumptions. The fixture
does not execute shell/native tools, install dependencies, copy binaries or
claim unrestricted predecessor behavior beyond this qualified producer path.
