# Task 1 fix1 re-review — IF15 explicit portable qualification

**IF15 specification: PASS. Code quality: PASS. Evidence: PASS for this scoped portability correction. No new actionable P0/P1/P2/P3 finding.** The ordinary-discovery/author-local-proof gap is addressed. The prior Task 1 native/source proof and gate verdicts carry forward within their existing conditions; this review does not expand them into connected Store, full-budget, Task 2 or release approval.

## Frozen scope and review method

- HOST: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`, assigned branch `codex/derived-index-foundations-20261025`.
- Fix range: `63825004a6a53d686e0955a771e27274d3b14c68..6689aa951669779e37599b6d819429a6a7ad1e3f`.
- Supplied diff: `review-63825004..6689aa95.diff` in the parent SDD directory.
- Requirements: current binding spec IF15; earlier IF05–IF14 and the prior `task-1-review.md` acceptance limits remain in force.
- Evidence: `task-1/fix1-if15/report.md`, boundary/source/unchanged-behavior/fresh-copy manifests, raw-checksum proof, negative/discovery/positive/typecheck receipts, copied launcher receipt and selected generated native process envelopes.

This was a read-only source/evidence review apart from writing this report. No Node/runtime/launcher/test/probe command, Git command, subagent or product edit was performed. The protected Gateway diagnosis file was not read, hashed, executed or modified. No unrelated files beneath `D:/frontend-test` were inspected or removed. Commit ancestry and staged-object identities are taken from the supplied range/boundary receipts; no Git ancestry check was run.

The diff contains the sixteen necessary IF15 paths reported by the boundary manifest: narrow `.gitattributes` addition, one package script, launcher/config, eleven fixtures and the native qualification-file rename. Large plan fixtures were checked through hashes and parsed semantic records, without dumping their roughly 23000 data lines.

## Addressed portability gap

Paths below are beneath frozen HOST unless prefixed by the parent evidence location. Line references support the assessment; there are no requested code changes.

| IF15 obligation | Re-review assessment |
| --- | --- |
| Ordinary tests do not require pinned qualification inputs | `packages/context-output/test/qualification/legacy-index-native.qualification.ts:1–32` moves the earlier native suite out of ordinary `*.test` / `*.spec` discovery. `test/qualification/vitest.config.mts:6–13` explicitly selects that one file, using its own file-relative package root. `package.json:7` leaves the ordinary `vitest run` command intact and adds `qualify:index-native`. The old ordinary native filename is absent. The stored no-proof-env discovery lists 35 ordinary files and no native qualification file. |
| Qualification remains explicit and mandatory | `scripts/qualify-index-native.mjs:18–31` requires all three command-line inputs; environment variables do not supply missing arguments. Dedicated config includes the qualification file, and launcher `:68–71` propagates the Vitest result. No pass-with-no-tests setting or success-from-exclusion path was added. Fixture `usage.md:6–11` expressly says ordinary exclusion is not qualification PASS and retains the command in the later fixed-version qualification plan. |
| Missing/mismatched inputs reject before children | Launcher `:19–30` rejects unknown/duplicate/missing argument pairs, relative paths, unsupported platform, existing output and invalid parent. `:35–46` validates the policy and every referenced fixture, both role entries, regular executable files and both exact original official executable checksums. The first child call is only at `:68`, after all these checks; output is created only at `:51`. Existing dependency resolution also occurs before creation/spawn. Stored missing-arguments and mismatched-floor cases both exit 2 with no output directory. No trace/interceptor claim is needed to establish the static ordering. |
| Paths resolve from the checkout's bundle | Launcher `:7–16,35–40` derives package/fixture roots from its own module URL, rejects absolute/traversing fixture paths and checks raw file hashes. It has no author checkout path, `.superpowers`, Git-history lookup or network request. `:52–59` writes the generated qualification JSON into the fresh output, with resolved absolute proof paths pointing into that checkout's fixture bundle. Selected generated qualification paths all point into the proof copy, not the original evidence tree. |
| Explicit pinned executable pair | Launcher `:41–46` verifies active and floor before its child call, using each role's original official `win-x64/node.exe` checksum entry. The renamed native suite keeps its own prior pre-execution checksum/version/executable checks. The recorded mismatch deliberately passes the active executable as floor and is refused before output/child launch. No runtime selection fallback, download, install, profile or PATH mutation exists in the launcher. |
| Portable representation is honest and hash-bound | Fixture `manifest.json:6–15,31–118,120–214` separates portable argument/observation hashes and representation labels from original artifact hashes and official source URLs/digests. Each version's `source-argument-*.md:3–14` explicitly identifies an argument document, not raw native implementation bytes. `reviewed-policy.md:1–7` labels new portable bytes. The unchanged probe's legacy nodeSource/sqliteSource fields therefore receive clearly labeled reviewed argument artifacts, not falsely advertised copied implementation blobs. |
| Deterministic raw checkout inputs | `.gitattributes:8–9` adds only `/packages/context-output/test/qualification/fixtures/** -text`. Eleven fixture hashes match the HOST bytes, manifest links and generated-copy bytes. Stored staged/working/checkout comparisons agree for all eleven. Official checksum fixture bytes also match the original downloaded checksum texts. Other code files remain under existing text conversion; their fresh-copy raw hashes can differ through CRLF/LF without implying a behavior change. |
| Native/gate/product behavior remains stable | All ten unchanged-behavior manifest paths independently hash-match: probe, gate, gate tests, six listed product source files and lockfile. The renamed suite is text-identical to its reviewed predecessor after only the two necessary relative-path adjustments and the stated provenance-comment replacement. The package edit changes only the authorized local script. No native assertions/control semantics, schema, Store/service behavior or package-index export was added. |

## Fixture and provenance validation

Every source-manifest HOST raw hash matches the current frozen file. Every launcher-referenced fixture hash matches. The fixture manifest itself hashes to `5654ba896f482544602894bb23893cb8172af0dc3f4faeb0c340bb51bd44be8c`, matching the copied launcher receipt.

The original qualification-manifest hash in the portable manifest matches the retained original manifest. All eight original upstream source URL/hash/byte-length records (Node source, header, SQLite build file and amalgamation for each release) match the earlier reviewed official-source manifest. Those URLs and hashes are provenance, not runtime download dependencies.

Both large `reviewed-plans-*.json` fixtures preserve the complete original `observations` objects: parsed deep serialization compares equal to each original hash-bound qualified-audit receipt. Their `originalReceiptSHA256` values match the original raw receipt bytes. Their extraction labels correctly disclose omission of original argv/author executable paths. Targeted semantic checks retain schema 21 pages, same-transaction raise to 768, 35 retained scratch-free shapes, 72-owner nullable fixture semantics and active defensive refusal / floor direct-shadow preparation behavior. There is no substitution of a reduced successful summary for the reviewed plan evidence.

The original checksum texts remain exact raw bytes:

| Official checksum text | Original and portable SHA256 |
| --- | --- |
| Node v24.15.0 SHASUMS256.txt | `1e812945dee26c3e4ca41a8c0b582668ff2401ba0ae727a122300c0e8514edb0` |
| Node v22.18.0 SHASUMS256.txt | `5499a9c23b58f52f297f9541656564aee7025ef652f7f74d49b98f7c72f9030f` |

The HOST probe/gate/gate-test hashes remain respectively `f0f6cc04e998632265d1b82c2bfd4c576adca9703bf8b9bff132d806d255a22c`, `5e75e018c455222c53c09f1e83c0c62864952b27f111885e039aaa84b5390bac` and `d25bfba71e5a75f77fa707ef67dcfc88f710c15d45d90cacf80a749703740186`, identical to the prior full review.

## Fresh-copy and verification evidence

The following `D:/frontend-test` paths are **generated proof-copy/runtime/output evidence only**, not another product checkout adopted by this review:

- Copy: `D:/frontend-test/derived-index-native-if15-copy-e381c683-a11b-4dbe-8ed0-931ced006d94`.
- Copied floor: `D:/frontend-test/derived-index-native-if15-copy-e8b22347-46ae-444c-9bd0-58134809a6ae-runtime/node-v22.18.0.exe`.
- Output: the copy path plus `-qualification-output`.

Read-only checks confirm the proof copy contains neither `.git` nor `.superpowers`; its dependency junction targets the preexisting `D:/I-harness-main/node_modules`. The preparation receipt/script records staged tracked-file export with `.superpowers/` explicitly excluded. The rejected earlier preparation copy is preserved as preparation history, with no positive native qualification attributed to it. The copied floor executable's SHA256 is the expected original official `c22d1c59a1f767a1ed0178445a027f2257d318c55430fc819d48f269586822b7`, outside the original author evidence tree.

All eleven generated-copy fixture hashes were independently checked and match the stored fresh-copy comparisons. Launcher/config/renamed suite/probe/Store text in the proof copy is LF-normalized-equal to frozen HOST text. In particular the copied launcher's raw SHA256 `a888f045dc4cc6770731f678d6bbc455fee93e95df5cc55b59c9cd4f7815bdf0` matches the recorded launched bytes; the HOST launcher has different raw line endings and hash `7995c7406291c2db866999017b6aa1e77e32abc26e35757bd78fa5bbbe2fd69f`. The fixture hashes remain byte-identical rather than merely normalized-equal.

Stored verification is consistent across command/result/output and launcher receipts:

| Check | Recorded result |
| --- | --- |
| Ordinary discovery with derived proof variables absent | exit 0; 35 files; qualification absent; discovery only |
| Explicit launcher without inputs | exit 2; expected missing-input error; no output created |
| Active executable incorrectly supplied as floor | exit 2; official floor checksum mismatch; no output created; the named refusal-output path is still absent |
| One explicit positive qualification in actual proof copy | launcher exit 0; dedicated native file 2/2 passed; fourteen controls on both pinned runtimes; one recorded positive run |
| HOST package typecheck without derived proof env | exit 0 |

The copied output's `launcher.json` is raw-equal to `portable-launcher-receipt.json`. Its cwd/config/launcher/proof paths use the generated copy; the Vitest dependency path uses only the explicitly reused existing dependencies. Fourteen selected native process envelopes identify copied helper and Store paths, the copied-bundle qualification JSON, active installed Node and the external copied floor runtime. Each uses the copied probe hash `42edec11ae0e8d8a13f1a7a67a24243934308cdcd9077bb320f034a226d37c04` (verified raw bytes, normalized-equal to HOST probe) and original Store hash. Status is 0 except intentional transaction exits at 29. The positive native output records 2/2 tests in 18.73 seconds; ordinary discovery exclusion is never counted as that success.

No verification was rerun for this review. The evidence supports the single recorded positive qualification and scoped typecheck; it does not establish any unrecorded run or environment.

## Disposition and limits

The IF15 portability correction is addressed with no new actionable finding. Prior `task-1-review.md` native/source conditions remain unchanged: exact supported builds/VFS, fixed SQL/schema/compiler context, conditional journal/undo/temp bounds, truthful native failure outcomes and safe cursor/SQL settlement. Bundling the argument documents does not create a new internal SQL trace, transient-I/O peak measurement, total-RAM bound or native-source implementation copy.

The explicit `qualify:index-native` command remains mandatory in later fixed-version qualification. Its ordinary-discovery exclusion alone is insufficient for native acceptance. Existing dependencies and user-supplied official pinned runtimes remain intentional prerequisites; no automatic acquisition is added.

This re-review permits only root disposition of the scoped Task 1 tooling fix. It grants no connected Store/gate adoption, generation/authority/grant restoration claim, full-budget/Task 2 approval, MAIN integration or release approval. No cleanup or deletion of the generated proof evidence is requested or performed.
