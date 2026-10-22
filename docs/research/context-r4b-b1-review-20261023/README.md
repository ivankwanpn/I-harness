# B1 review checkpoint

The root acceptance record is [2026-10-23-context-r4b-b1-acceptance.md](../2026-10-23-context-r4b-b1-acceptance.md). Reports preserve their original source timing and verdicts. `manifest.json` records UTF8/LF-normalized report hashes and original local hashes. `proof.json` embeds each listed original log, probe and manifest as gzip/base64 with original byte count and SHA256; decode/hash before reuse. Local paths inside historical reports are labels, not dependencies of the maintained predecessor test.

The genuine predecessor graph is separately committed under `packages/session-persistence-jsonl/test/fixtures/format10-predecessor/`; it is not duplicated here. Root audit scripts are retained for inspection and reference their original local evidence layout; their outputs are recorded, not instructions to rerun sealed evidence.
