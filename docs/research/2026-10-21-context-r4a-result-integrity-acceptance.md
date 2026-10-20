# R4A bounded result integrity / cold lookup — root acceptance

2026-10-21. **Accepted for this bounded unit only.** Reviewed range `0df518e7042039ef0f312c53aa565abf314bef3a..c9f41bd974f8940381d0f04748b19acc8647f4f3`, implementation `740c515399eebe1c4a27e7367b44ef353b212310`. The [delivery](2026-10-21-context-r4a-result-integrity-delivery.md), [fresh independent review](context-r4a-result-integrity-review-20261021/review.md), [root identity audit](context-r4a-result-integrity-review-20261021/root-identity-audit.json) and [independent literal/receipt audit](context-r4a-result-integrity-review-20261021/root-behavior-audit.json) agree. No unresolved actionable review finding remains.

The work qualifies original A6 bounded integrity and trusted cold lookup. It does not close A6 scale/packaged entry, mixed legacy/managed retention, whole R4A, R4B/C, R5 or R6. Product0.1.13-rc.1, Session10 and unrelated decomposition27/43 remain unchanged; no push, merge, tag or release.

## Accepted behavior

The genuine original RED controls demonstrated that cold lookup could follow linked metadata, classify inconsistent records as committed, or validate operation A and return an unchecked second observation B. The original cold recovery leaf now uses one bounded rooted operation snapshot, binds its original operation/workspace/session/call/directory identity and validates a committed ref against both embedded and on-disk canonical manifests. It does not scan result body/index or resume a producer.

Another actual stored-pin control changed only operationId and still received original plaintext. The existing reader authorization now binds that pin to its operation owner before body/index I/O. Existing before/after policy, immutable-ref and witness checks remain in their original owner.

Authentic capturing without manifest/ref and staged states remain recovery-required. Cleaned refusal, including a real staged-to-deleted refusal retaining earlier metadata, stays a refusal. A valid committed metadata receipt with missing body/index remains a storage receipt while the page refuses. Lookup does not establish read permission, F1 publication, execution success, a grant or a new producer scope. Accepted native witness authorization does not gain a cold disk-manifest/body scan.

Only three product files changed: the cold recovery leaf, original pin comparison and a reader comment explaining that one range can intersect two chunks. Eight test/helper files cover the new bounded controls. No additional storage authority, schema/journal/ACL, production test-only export or large new product closure was added.

## Independent evidence and final qualification

The final contained run collected exactly **18 current-source files / 75 tests**, with **30 new controls and45 existing regressions**, all passing. Final context-output and affected executor/Gateway/SDK type checks passed. These are distinct scopes; repeated runs are not additional test coverage.

Root read all changed source/tests, actual owner helpers, full delivery/handback and fresh review, then independently audited:

- All **4,271 recorded final source/input files** against actual workspace bytes; final source manifests remain unchanged.
- All **3,081 evidence entries**, comprising **3,006 regular files /28,509,779 bytes and75 fixture links**. Link identities/contained targets were checked without traversal. Exact inventory closure excludes only its inventory and outer seal.
- All **26 native command receipts** for isolated roots and sequential nonoverlapping execution, final test collection/exit, type exits, retained behavioral RED and exact three-owner BASE-save/restoration.
- All18 preserved raw Git objects, including the original amended commit identity. Their Git object hashes and raw bytes match.
- Four independent literal crypto constructions for empty/65536/65537/131073 bodies, complete index/header/heap/manifest/revision bytes and the saved positive files/pages. Across saved repeated runs,24 vector records/72 pages were checked; this is audit volume, not24 unique tests.
- Actual native read records: empty index96stored/128read; crossing page131072body+288index bytes;18 capped short reads; zero-progress refusal; exec header/boundary/record3body passes+384index bytes; selected witness read twice with both policies and no catalog body scan.
- Two preserved foreign-observation RED records versus six checked-original GREEN records, and two plaintext pin-mismatch RED records versus five denied-I/O GREEN records. Again these are repeated receipts, not extra distinct controls.

The fresh GPT6.1Sol reviewer independently followed source/callers, all new fixtures, original authority contracts, final receipts and selected phase/snapshot/pin/native-I/O evidence. It reported bounded PASS with no actionable P1/P2/P3 finding. Root did not rerun unchanged product suites merely to duplicate those valid receipts.

## Preserved corrections and practical limits

Early manifests missed ignored hidden inputs; they remain early bounded evidence. The writer corrected enumeration, reinstalled byte-exact Git BASE versions of the three owned product files, reproduced controlled RED under616 named/hidden inputs, and restored the exact fixed bytes. Final qualification expanded to4,271 package/app/config/hidden inputs. This expansion is not retroactively attributed to the earlier gates.

Gate22's repo-root filename filters accidentally collected five historical baseline test files and five copied suites with missing tsconfig. It exited1 and is excluded from qualification. Final25 uses `--dir packages` plus explicit temporary/worktree/release/dist exclusions and exactly the intended18 paths. Source inspection identifies fresh historical fixture roots/cleanup; unlogged OS temporary names cannot be retrospectively inventoried, so no global old-evidence-unchanged claim is made.

Final25/26 executed the cleaned constants workspace bytes while Git HEAD was `96b0bae1`. Its subsequent amendment to740c5153 removed only one extra EOF blank in that constants file; all product owners are identical. Actual manifest hashes qualify the executed bytes; receipts were not rewritten to substitute the later HEAD. Original generator setup, codec reason-oracle and test discriminator failures remain preserved.

These are local Windows/Node controlled results. They do not establish atomic multi-file snapshots, cryptographic detection of coherent rewriting of every trusted record, full revoke/restore ABA detection, untouched-range body integrity, large-data memory bounds, copied/bundled workflows or all protocol/session recovery. The existing actual Gateway frontdoor controls preserve their stated component/broker/fence scope; direct archive metadata tests are not expanded into a full Gateway archive proof.

## Frozen identities and next work

Original evidence root: `.tmp/r4ai-1021-01/`. Final source inventory SHA256 `5762ce5f6dc519ba2b2ff8a0793a701c2c0b08fba0e004058f84939a63b9f398`.

| Artifact | SHA256 |
| --- | --- |
| Outer evidence seal | `8ca45474e862626055952c97c32249e87c301c498dfdbfc67b5c8fcedaca85c8` |
| Evidence inventory | `34a3c7ed16c713f5ea08e1efce4bad481ed3eba923d3b71da063fc3f8ba0697c` |
| Frozen writer report | `30398387773e20cd40e58411b5d15d5c1273163a772e301de30b71f25023366c` |
| Frozen handback | `387922fa9a04778b711671b34cd1d2781eb9a1741369064b3d9246584f84230d` |
| Fresh review | `471efab4147104cd70b31006291722a101a666cfa01af784e865e62e00343aa1` |

The portable review directory preserves readable reports, root audit scripts/results, final source inventory, receipts, seal and commit/selection/cleanup records. `original-bytes.json` additionally stores all67 original copied artifacts as base64 with original byte lengths/SHA256, preserving exact bytes across Git newline conversion. Native console output copies use explicit base64 JSON wrappers rather than editing their trailing whitespace; sealed original logs are untouched. Raw result artifact files remain in the sealed local evidence root. Copied audit scripts describe the accepted historical run and intentionally bind that review HEAD; do not execute old writer runners into sealed roots.

Next is the separately preflighted mixed legacy/managed quota, saved-settings, TTL/clear and derived-index composition. Its concurrency hypothesis requires genuine original-owner evidence before a repair. Final scale and packaged validation follow after storage owners stabilize.
