# External R4A review attachments

These files preserve the exact independent review probes and selected evidence
for the external implementer. Product HEAD under review is
`41e97ecb80149bfe99bb7151c3bd5a0b7c11a9e7`; no product change was made by review.

- `task-roundtrip.probe.txt`, `background-catalog.probe.txt`,
  `background-retry.probe.txt`: byte-identical copies of the tested TypeScript
  probes. They are stored as text so repository test discovery will not run
  them accidentally.
- `vitest.config.txt`: exact probe configuration.
- `code-review.md`: the single fresh reviewer's report, including new versus
  inherited findings and attributed root evidence checks.
- `root-evidence-verification.json`: final independent hash/source/copy check.
- `root-run-receipts.json`: exact sequential fresh run receipts. Raw logs and
  full before/after tracked source manifests remain in the local review folder.

To reproduce on this machine, use the originals under
`.superpowers/sdd/2026-10-19-context-r4a-external-review/` and the commands in the
fix plan. To reproduce on another checkout, copy the three `.probe.txt` files
into that same three-level review directory as `.probe.test.ts`, and copy
`vitest.config.txt` as `vitest.config.ts`. The probes import actual public
`../../../packages/<package>/src/index.ts` entries. Use a fresh output/evidence
directory and preserve old results; do not overwrite product code or old logs.

The `background-retry` probe demonstrates unknown -> known storage-refused on
the same original capture; it does not prove successful artifact publication
after an I/O cut. The background-catalog probe uses real local process output
with controlled offline model responses. No live provider/account is tested.

Review outcome: **CHANGES REQUESTED**. Passing the submitted normal-path tests
does not cover the four failing cases in the three independent probes. Full
R4A also remains incomplete apart from these findings.
