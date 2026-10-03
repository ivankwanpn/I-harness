# IH bounded search and readonly references acceptance

Task started 2026-10-03; packaged execution and final verification continue on 2026-10-04 (Asia/Hong_Kong). Work is in `D:/frontend-test`, branch `codex/desktop-workbench`, from product baseline `eb7d757c` and design/plan commit `1a8859e9`.

**Verified:** implementation, finite independent review, packaged Electron Node-mode proof, every required copied visible native group and a fresh complete all-project gate passed. All owned processes were closed before the standalone gate. Local source/document delivery follows these recorded results.

## Implemented behavior

- Existing model `grep`/`glob` use bounded streaming, current scoped Exec policy and owned abort signals. Enumeration, a fixed no-spawn fd reader and fixed rg stdin matching run as separately confined first-generation commands. The parent relays bounded reader bytes without filesystem stat/read calls. Actual Windows read-only/workspace-write mounts work without changing provider DACLs or adding a host fallback.
- Typed options include regex/literal, case, context, include/exclude, hidden/ignore, PCRE2, multiline and encoding. Results distinguish completed emptiness, limits, cancellation, timeout and errors, with physical read statistics, bounded diagnostics and effective filter metadata. Interior U+FEFF and whitespace are preserved; range columns are UTF16 code units, not source/transcoded byte offsets.
- Desktop adds explicit content submission and Stop alongside existing filename search. Project refs remain relative `{workspaceId,path}`. Repeated navigation uses a fresh nonce while draft/tab identity is unchanged; dirty drafts remain intact.
- A separate absolute `參考位置（唯讀）` can search/read an outside file or folder without adding a workspace or write root. Reference targets/viewers are readonly and have no save/draft ingestion path. Intentional project aliases resolving outside return readonly metadata. SAVE checks current membership, the original canonical write root and actual edit-handle containment.
- Preview/read requests carry optional client identities. Replacement, unmount, request failure and window close cancel captured owned work; membership/session ownership mutations drain affected captures before acknowledgement, including a job already stopped but still draining. Unchanged scopes continue.
- UTF16 and other previews are centered and readonly, with startLine, raw snapshot SHA, changed/truncated flags and explicit replacement-decoding warnings. Model Code Mode keeps the same registered tools, deferred broker and role/permission path; its stop awaits the actual producers.

## Limits and interpretation

| Bound | Value / behavior |
| --- | --- |
| Model returned count | glob100 / grep250 defaults; requested count1..1000 |
| Serialized result | Model default32KiB; explicit4..256KiB; human ceiling256KiB, including metadata and diagnostics |
| Search deadline | Default/hard30s; requested100..30000ms; owned process/IO drain awaited |
| Physical searched input | At most32MiB aggregate,1MiB/file; reservations precede up to four reads |
| Raw result/control admission | Engine enumeration + matcher stdout/stderr1MiB; runner control/result1MiB independently; fd raw relay counts input instead |
| Matcher concurrency | Model1 to share the existing combined stdout/stderr allowance; human at most4 |
| Candidate/frames | At most1000 candidates and256KiB retained candidate paths, including reference label prefixes; pending frame bounded by raw allowance |
| Human traversal/policy |3000 entries, depth32; at most20 pinned ignore files,64KiB each |
| Preview text | At most32KiB in UTF8 and UTF16 storage; readonly |
| Derived Latin1 stdin | At most2MiB UTF8 from a physical snapshot at most1MiB; next byte rejected; physical/output limits unchanged |

EOF is proved by a positive read returning zero, or the pinned reader returning less than its requested allowance. Exact-limit input without proven EOF is partial. Matching-file JSON begin/end events are not invented scan counts. Raw admission does not claim to bound bytes already generated into OS pipes. Partial/limited results and local paging provide no stable filesystem cursor.

Human ignore policy is pinned project/reference-local `.gitignore`, `.ignore`, `.rgignore`, with per-directory `.rgignore > .ignore > .gitignore`, deeper rules and ignored-parent behavior. It does not claim global Git/parent ignore semantics. Automatic traversal excludes `.git`, `node_modules` and links; explicit readonly references/aliases remain available. Incomplete policy is reported. Regex errors come from the actual rg engine, including empty trees.

## Focused verification and independent review

Meaningful red/green tests cover stream byte clipping/cleanup, descriptor growth/replacement, shared reservations and exact EOF, JSON/Base64/Unicode/CRLF, context/multiline/PCRE2, current policy, process cancellation, membership races, reference writes refused, preview UUID drain and retained drafts. Two independent passes reported six P2 issues; finite repairs and a final Stop-then-withdraw probe were re-reviewed READY. The final probe returned `acknowledgedBeforeDrain:false, acknowledgedAfterDrain:true`.

Focused evidence includes Exec39, fs-search41 before final reviewed edge repairs, model/scoped mount8, Code Mode runtime/human-stop30, renderer117 distinct covered cases before finite viewer repairs, renderer affected61 and native affected12. These are overlapping scoped runs, not a sum or substitute for the final all-project gate. The FEFF and pre-aborted metadata repairs passed engine18+bounded11; the latter confirms ≤4096 serialized bytes and zero Exec side effects.

Actual mixed/only workspace-write Code Mode uses20 files×12rows=240 retained nested matches. JavaScript groups and emits ten references in less than1000 bytes. `deriveMessages` contains only emitted evidence while the full nested trace remains owned. This is output evidence, not a measured token-saving percentage or speed multiplier; CPU limits and global retention remain unchanged.

## Portable build and Electron Node-mode proof

Distinct artifact: `packages/desktop/release-search-optimization-2026-10-03/I-harness Desktop/`. Initial, finite CSS and final source-parity builds completed with exit0 and203 gateway packages. Final zip SHA256 is `0BC84D4E0ACD5C1502F4C80C869BC1EE35C6C5439CF9202AA3936D72D3B65FCE`. The initial zip was `9C6A8E1941826441CDA44E4AE9F4063FD33F90CA46D4E088E228E9E80154A623`; the CSS-rebuilt zip was `0862955F7C7ACB1BEE6CA50CA110B1CE30B03CEA990571207671D767BBC9553A`.

The final parity build removes only the unused new root type re-export. Main, renderer HTML, reader, engine, options, rg and ignore dependency bytes remained identical to the native-approved CSS build. Existing Node/GUI proofs were reused after this hash comparison; no runtime behavior changed.

Actual packaged rg reports15.0.0 and PCRE2 10.45/JIT. Required reader/engine/options/ignore/picomatch/rg assets are present. The final CSS rebuild changed renderer assets while main/search/ignore/rg hashes stayed identical:

| Asset | SHA256 |
| --- | --- |
| reader.mjs |3B0F74CE640729C33DB0FB0153E22A7EE459D77B3E42416FA7D79526DD6FEEBA |
| engine.mjs |D5A718F620056D52E0932B9771C377B41B27227692D74055632380A1D9C37951 |
| options.mjs |595D49E0886BCB96A3F7A5A31C048E94F672F0FC316E558E1E439EBCE8A8BCF5 |
| rg.exe |F9DDE63498B3193F098355DBEC97AF99DC4F6B8FA0DF5ED04114A03012C042CB |
| Electron main index.js |B5207EDDCF7BE3527564ACF103D5E1BAEE09BC2A2111BBFF46E7E92458F7F3C6 |

The awaited actual release EXE ran Electron44.4.5/Node24.21.0 with `ELECTRON_RUN_AS_NODE=1`, loading only packaged source modules/tsx/reader/rg. Read-only/mixed and workspace-write/only each retained24 rows from two real files and emitted two references in79 bytes. Six scoped operations closed per scope, activeOwned0, fetchCalls0; dispose was awaited and no owned EXE/rg remained. The initial ignored-scratch query returned zero candidates correctly; only the fixture options were repaired to explicit hidden/ignore settings, with the failed log retained.

## Visible native acceptance and full gate

The fresh complete `pnpm verify:all` ran alone after every app/server/probe/implementation owner was idle. It exited0:

| Gate | Actual completed reading |
| --- | --- |
| Recursive suite |4437 passed,10 skipped,0 failed; exit0 |
| Population |71 of71 projects with tests reported |
| Typecheck |exit0 |
| E2E |12 passed in5 files; exit0 |
| Reachability |exit0, no new rows;420 current,36 baseline rows gone |

Two pre-existing inert reachability allowlist warnings were retained; no allowlist was added. The earlier4322/10 baseline is historical. The first new gate failed an obsolete context-preview outside-read denial expectation and a newly unused `SearchStatus` root re-export, reporting an incomplete3792/70 prefix. After verifying the readonly context contract, its deliberate alias read now asserts readonly/external metadata and unchanged bytes; traversal remains refused. Removing the unused root re-export preserved the canonical internal type. The failed log is retained and was not counted as a passing total.

The copied app used fresh owned config/userData/two roots and a separate readonly reference folder, with loopback guards, zero provider POSTs/model turns and zero renderer exceptions. Native replies were recorded through unchanged forwarding and never replaced. Every required group passed across explicitly recorded affected-stage retries:

| Native scope | Passing owned run |
| --- | --- |
| Identity, actual options, beta line41 UTF16 columns4–10, repeated dirty draft/CAS, UTF16 startLine21, readonly references/no outside write/catalog addition |`15fd3fa1-4507-4cc3-8a97-e52b0d7162dc` |
| Final wide/narrow geometry, real regex error/limited result, live fed rg Stop at both widths, withdrawal before ACK and refused old beta read |`d509dd70-6d59-44e4-946c-49f1bfd8f085` |
| Shield popup portal/row hit testing, window controls, zero outside-Settings sandbox and one Settings combobox |`9daec657-40f0-4cc2-84a5-e33134cb29a4` |

Earlier passing logic/main/helper bytes were unchanged by the CSS correction. The final actual measurements were279/279 wide and585/585 narrow client/scroll widths, zero offending controls. The original34.4px overflow is retained as a real defect, with the one scoped label rule correction. Native Stop required an OS-live logged rg with nonempty stdin; post-ACK CIM found no captured PID. Project save similarly drained its captured rg before acknowledging withdrawal. All reports end IDLE/surviving[] and external byte hashes match before/after.

Six failed harness attempts remain accurately failed: pre-entry TDZ, two prelaunch asset assumptions, missing CR in the multiline pattern, optional alert-role assumption despite visible actual diagnostics, and clicking the composer beneath the normal narrow review overlay. Only the affected harness/query/view state was corrected. No single uninterrupted pass is claimed; no cap, timer or response was altered to pass a fixture.

## Evidence and preservation

- Design and normalized plan: [design](../superpowers/specs/2026-10-03-search-optimization-design.md), [plan](../superpowers/plans/2026-10-03-search-optimization.md).
- Ignored exact source/artifact manifests and logs: `D:/frontend-test/.superpowers/sdd/2026-10-03-search-optimization/` (`integrated-source-freeze.json`, `portable-artifacts*.json`, `portable-build*.log`, review reports, packaged-node probe and native-owned reports/screens).
- Packaged Node-mode evidence: `D:/frontend-research/packaged-node-evidence-01b1e5cf-2ada-472a-b314-93219cb9f395/`.
- Prior search research: `D:/frontend-test/.superpowers/sdd/2026-10-03-desktop-front-polish/grep-ripgrep-research.md` (historical baseline, current delivery pointer added).

Exact completed gate: `verify-all-final-complete.log`; failed initial gate: `verify-all-final.log`. Aggregate native report SHA256 is `4B443764BF73082A7833F8D14C6B3F4C06166A9D88639FCE38A224B102D6E789`, harness SHA256 `5A9D6E90B7038809663AD284EF06C64D984D396DD4D2D42D87A039BBB7ECE786`. Final artifact inventory is `portable-artifacts-final.json`; exact local commit/status are recorded in ignored `final-delivery-report.md`.

The original dirty `packages/desktop/electron.vite.config.ts` remains unchanged/unstaged at SHA256 `EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085`. Protected main/reference checkouts, real user data and old rejected temporary directories were not modified/deleted. Delivery is local; no push or PR was requested.
