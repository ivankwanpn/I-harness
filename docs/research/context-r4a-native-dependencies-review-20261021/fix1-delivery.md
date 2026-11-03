# Native dependency qualification fix1 — frozen handback

Status: both P2 qualification findings from the full task-1-review.md have focused test-only additions and passing verification. Ready for the same fresh reviewer to re-review the full range and this delta. No product defect was reproduced by these additions, and no product source changed.

Workspace `D:/I-harness-main`, branch `codex/v0.1.13-development`.

- Original frozen review HEAD / fix1 BASE: `cfa3d5ee8b899e4b31f9870ff1cb1cb86eadd87a`
- Fix1 final HEAD: `382864914331931f6b04502501a86153cce02204`
- Exact fix1 range: `cfa3d5ee8b899e4b31f9870ff1cb1cb86eadd87a..382864914331931f6b04502501a86153cce02204`
- Exact full unit range: `afec9bb6034378207ac18a44fd9d6b2c3af70445..382864914331931f6b04502501a86153cce02204`
- Product remains unchanged from `139bf7779a00d84e9dbea84836077497e7f43649`; Git product-source diff exit 0.
- One coherent local commit, `test: qualify later catalog refusal and CLI witness reads`, changes only two test files, 132 insertions / 9 deletions. Native commit exit 0; tracked tree clean.

Product 0.1.13-rc.1, Session format 10 and original decomposition 27/43 remain unchanged. No push, merge, tag, release, real provider call or installed-app mutation was invoked. Prior broader R4B/A5/A6 and packaged/scale limits remain.

## Finding 1 — usable C1 survives a later genuine known refusal

Changed `packages/session-executor/test/native-dependency-observer.test.ts`.

The existing actual Agent→direct durable child→inherited ExecService→parent prepared job_output path first establishes usable C1 and the original child frame. A later, distinct genuine parent job_output observes that same original native capture. The chosen refusal seam is **membership metadata admission after the later genuine catalog has actually committed**. The transparent wrapper delegates original catalog finish, records the actual original private scope/ref, then uses the real service configuration and physical-byte owner to set quota to current use plus one. The original membership reservation supplies the actual known quota refusal. No desired descriptor or fake dependency is substituted.

The final run records physical use 65,871 bytes and quota 65,872 bytes, against original membership reservation growth of at least 131,072 bytes. The later F1 is exactly `dependencies:{kind:'unavailable',reason:'quota',count:1}`. Its primary retention and execution facts equal C1's actual original primary facts.

Assertions verify:

- C1 was usable before refusal and remains usable afterward through complete advancing bounded typed reads, with exact 40,000 stdout `a` bytes and `child-end` stderr.
- C1 companion and original target pin remain byte-identical; frame/catalog ref identities remain exact.
- The later refused catalog cannot witness a frame page, and its companion is physically absent.
- The completed job still returns the exact original retained native dependency.
- A process-written native effect ledger contains one line, and original native producer body / launch counts remain one. No native/body replay occurred.

The chosen later-refusal seam is membership quota, not catalog-body quota. The report does not infer a C1-plus-catalog-body-refusal qualification from earlier independent no-C1 controls. Existing pending later publication, same-scope reconciliation, two successful witnesses, selective real rewind, sibling/source/archive denials, cold reads and supported lower deletion/retry coverage remain in this same passing observer flow.

Representative final receipt: `observer-xL77sR/later-refusal-receipt.json`; original pending/rewind/lifecycle receipt: `observer-xL77sR/observer-receipt.json`. These live entirely in the fresh fix1 evidence root.

## Finding 2 — actual CLI process dispatches witnessed native pages

Changed `packages/sdk/test/result-page-cli.test.ts`.

This is accurately a **cold transport/storage-owner composition control**, not native-producer or full Agent qualification. Original createExecFrameCapture and automatic result-store scope/sink owners commit a native frame. A genuine private dependency-catalog scope binds its actual dependency and commits membership. Real managed closed delivery facts make the original catalog visible under the actual source/current-policy owner. All original writer leases/coordinator retire before `HarnessClient.spawn` starts the actual `apps/cli/src/index.ts sdk` process against that storage. The genuine native producer qualification remains the separate actual child/parent observer control.

Through the real CLI v2 composition, the test sends `{ref:frame,viaCatalog:catalog,cursor,maxBytes:4096}` and compares all five advancing typed pages to the independently authored original bytes: 12,007 stdout bytes (binary NUL/255/127, emoji and ASCII) and seven stderr bytes. It asserts full immutable ref identity, serialized page budget, frame/channel order, contiguous offsets, final end markers and exact bytes. The actual CLI advertises `["1","2"]`.

The actual CLI also rejects a malformed non-JSON selector with RPC code -32602. An unrelated actual JSON artifact is committed, pinned and made directly visible; ordinary CLI reading of it succeeds, while using it as a frame witness denies. Its reference-looking JSON body supplies no authority. Ordinary unbound text success and saved-project-binding refusal remain. Both session files and the task-owned settings document remain byte-identical across the requests.

The test observes the original HarnessClient.spawn child handle read-only, without replacing its process/transport owner or adding a production test export. The original client close runs normally; final CLI exit is exactly code 0, signal null. Chosen task-root runs retain receipts and original storage instead of removing them. Default non-evidence OS-temp cleanup remains; selecting a sealed evidence root rejects before fixture writes.

Representative final receipt: `result-cli-GpxpXk/cli-witness-receipt.json`; actual process exit: `result-cli-GpxpXk/cleanup.json`.

## Focused verification and failures

Both environment variables were explicitly installed in the shell before every process startup:

```text
IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT=D:\I-harness-main\.tmp\r4a-native-fix1-20261021
IH_CONFIG_DIR=D:\I-harness-main\.tmp\r4a-native-fix1-20261021\config
```

No old sealed runner was executed. A new runner exists only inside the fresh fix1 root. Individual `*-exit.json` files preserve exact commands/argument arrays, timestamps, native exits and before/after source hashes.

| Final gate | Result |
| --- | --- |
| fix1-observer-final | One complete genuine observer flow passed, including refusal/pending/rewind/lifecycle; native exit 0; source delta 0 |
| fix1-cli-final | One actual CLI cold witness/text/project control passed, five typed pages; native exit 0; source delta 0 |
| fix1-types | Session-executor and SDK typechecks ran sequentially and passed; native exit 0; source delta 0 |

The first observer and CLI attempts also passed and remain preserved as `later-refusal-attempt1` and `cli-witness-attempt1`. No runtime/setup failures occurred in fix1. Expected quota/unavailable/RPC-negative results are normal control observations, not hidden test failures. The earlier 98-test/nine-type evidence was not repeated or relabeled; it remains the original root-audited product baseline.

All final gates have the same frozen 2,541-file source state and match current raw workspace bytes after the commit. `source-delta.json` explicitly explains the larger manifest scope: the prior 2,533 paths remain, exactly the two authorized test paths changed, and eight manifest-only additions are the original review/brief plus six previously hidden package fixture files. No product files were added or removed. Historical .tmp copied suites and Desktop release snapshots are excluded. No .mts helper was added; directly affected .ts tests passed their project type gates.

Final owned-process inventory is zero matching fix1 Node processes. Four original fixture cleanup receipts cover both observer and both actual CLI attempts. The actual CLI process receipts have code 0 / signal null; the actual child native job exits 0. No unrelated process was terminated.

## Immutability, seal and re-review

Fresh fix1 evidence: `D:/I-harness-main/.tmp/r4a-native-fix1-20261021/`.

- New seal `evidence-seal.json`: 176 files, 5,056,413 raw bytes.
- New seal SHA256: `442127da8ff7804537e8ea3d1e057a33859096c915f48d189c504b0528fc531b`
- Final source manifest `fix1-observer-final-after-sources.json` SHA256: `46534268aea349f8db462774161b2056c374223b8a7d834962c207d0e2189920`
- `fix1-freeze.json`, `source-delta.json`, `fix1-index.json`, `cleanup-inventory.json`, all gate receipts/logs and the local commit receipt are inside the new seal.

The original root was read only for integrity checks: all 2,103 original sealed files / 28,496,267 bytes still match their original hashes and closed inventory. Original evidence seal SHA remains `547b65cbe233bd03ccdc5d4bbb4447bb5156186f8c6bc8c9b349a3658be3142f`; original task-1-report.md SHA remains `f66b061b5ea0f75b8c6bf259498d9d15a0488eb9f443a3549143e6f9be2f46f7`; original task-1-handback.json SHA remains `3a5e2b4b981fd060723fa25043bec449478a14946971734f1299f173b4249400`. They were not edited or appended to. The original review is also preserved and source-hashed.

The old retrospective profile-isolation uncertainty, unproved deep-root SQLite setup cause and all other original delivery limits remain unchanged; no new claim replaces them. This fix1 used a fresh short root and task-owned pre-start settings throughout.

For re-review execution, select another fresh short task-owned root and set both environment variables before pnpm starts. Do not reuse either sealed writer root or execute either writer's evidence runner, which writes into its own sealed root. Run explicit changed test paths and directly affected types with separate reviewer artifacts. Product/tests and new fix1 report/handback/seal are frozen pending root's acceptance after the same reviewer's scoped re-review.
