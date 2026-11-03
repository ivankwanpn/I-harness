# Context redesign proposal: independent evidence/design review

Reviewed `docs/research/2026-10-15-context-architecture-reassessment.md` and `docs/superpowers/specs/2026-10-15-context-engine-redesign.md` as design-stage drafts. No product edits, providers or repeated tests. Findings below are actionable correctness refinements, not approval of implementation. No P0 defect found in the architectural direction; the central archive/snapshot/protocol/admission separation and evidence qualifications are sound.

## P1 — Compaction commit must preserve all accepted asynchronous suffix facts

**Location:** spec lines 109, 114; also snapshot/job invariants at 20, 63 and 131.

The commit rule only explicitly permits rebasing when “new pending input” arrived. While the summary is awaiting a provider, already dispatched tools can settle, a child can complete, an artifact can finish retaining, or an already admitted notification can change delivery state. Those facts are neither edits to the captured source nor necessarily new pending input. An implementation that treats source revision as a scalar equality check can repeatedly discard useful work; one that swaps the captured snapshot plus only user suffix can lose accepted outcomes or replay delivery. Protecting an active exchange does not alone specify late-result merge semantics.

**Proposed insertion after §5 Commit:**

> Capture 記錄 archive high-watermark、被替代 source IDs/digests 與各 owner revision。Commit 不覆寫已接受的新事實；watermark 後新增的 human input、tool dispatch/outcome、child settlement、artifact retained status、notification admission/delivery 均由同一 projector 依穩定 ID 重播至 candidate suffix，再重新准入。若新增事實與被替代區重疊或無法證明可合併，捨棄候選並有界重建；不能撤銷副作用、漏掉結果或重新派發工具。Branch/rewind/binding 變動按明確相容規則使候選失效。

**Acceptance addition:** a summary held across parallel tool completion and child notification settlement, with a crash at publication, retains every accepted outcome and performs zero duplicate dispatches.

## P1 — Stop/commit requires a durable linearization point and bounded exceptions

**Location:** spec line 25 (“Stop blocks subsequent transport/commit/wake”), lines 57, 114 and 131.

The blanket prohibition conflicts with persisting completed tool effects and child settlement after Stop. It also leaves the journal edge undefined: Stop can arrive after commit record append but before flush resolves; a timeout can leave the writer uncertain although restart finds the commit. Durable publication cannot be retroactively uncommitted merely because in-memory cancellation won a later race.

**Replace the Stop invariant with:**

> Stop 阻止新的模型 transport、工具 dispatch、compaction publication 和 parent wake。已派發工具／child 的 outcome、unknown outcome、artifact retention 與 settlement bookkeeping 仍必須持久記錄，但不產生新的執行或 wake。Compaction 以持久 commit record 為 publication linearization point；在此之前取消則不發布，在此之後視為已發布而停止續跑。若寫入／flush 結果不確定，按 transaction ID 從 archive 核對，不再寫另一份不同 checkpoint。

**Specify alongside §5.6:** checkpoint prepare records without committed publication are ignored during replay; a committed record identifies source lineage and candidate manifest digest; installation/replay is idempotent. This makes “flush then switch snapshot” meaningful across crashes without requiring a new database.

## P1 — Native-state downgrade is conditional, not always possible

**Location:** spec lines 74, 76, 98–103, 119 and 129.

The draft correctly says opaque compaction is not generic text, but then says incompatible native replay can be downgraded to portable content without saying when that content exists. A snapshot whose only representation of old work is an encrypted checkpoint cannot be locally converted to a faithful portable summary. A file/server reference can also be unusable under a new account/endpoint/child owner even when protocol and model strings match. Local signature validation can verify shape/provenance/prefix compatibility, not the provider's opaque cryptographic acceptance.

**Add to Native checkpoint / fork paragraphs:**

> Native replay/ref 攜帶非敏感的 origin scope：protocol、provider/route identity、model compatibility、account/workspace scope、必要 server session/reference ownership、expiry/availability 與原始 source lineage；不保存憑證值。跨 scope 不沿用 opaque state。只有已保留足夠可讀語義材料／portable checkpoint，或原相容 binding 能在受限 admission 下建立 portable handoff 時才可降級；否則明確 blocked，不能只刪 opaque state 後聲稱上下文已保留。Validator 檢查可在本機驗證的 block/order/signature presence 與記錄的 compatibility；無法本機驗證的 provider cryptographic validity 明示 unknown，使用既有 typed rejection/recovery。

**Acceptance addition:** model/account/endpoint switch and full child fork from an opaque-only checkpoint or expired stored ref either produce a verifiable portable handoff or stop with a specific blocked reason; never silently continue missing prior task state.

## P2 — “Every call/result adjacent” is not a valid cross-protocol invariant

**Location:** spec R1 acceptance, line 163; Anthropic row at 101.

Parallel calls A/B followed by results A/B cannot make each individual pair immediately adjacent. Providers impose block/group and ordering constraints, with server-side/unpaired event exceptions. The proposal otherwise correctly preserves multi-protocol semantics; this acceptance wording can accidentally force flattening/reordering valid native exchanges.

**Replace the R1 phrase with:**

> live／cold／rewind／in-step compaction 均保持 adapter 宣告的 call/result group-order 與 pairing 規則；parallel call/result block 不被無關訊息非法插斷；不要求跨協議通用的一對一直接相鄰。合法的 server-side／外部獨立 tool events 以 typed exception 表示。

## P2 — Legacy importer must not invent instruction authority

**Location:** spec lines 59, 63–65 and 176.

Typed provenance for new sessions is good, but legacy logs can lack human/plugin/synthetic origin or contain a summary already projected in user role. Inferring “human authority” merely from user role, lexical imperative text, or a previous Sensitive Instructions heading recreates the defect being redesigned. A group reconstructed from events can be structurally inferred without proving its authority origin.

**Add to legacy importer:**

> Legacy importer 將可證明的 source metadata 原樣保留；缺少來源則標為 legacy/inferred/unknown，不能因 role=user、舊摘要章節或關鍵詞而升為 human/developer authority。結構分組推斷與授權來源判定分開。Migration checkpoint 記錄 importer version/source high-watermark，保留可追查原文；權限決策不足時不自行補授權。

## P2 — “Consumed exactly once” needs a logical definition

**Location:** spec lines 131 and R4 at 166.

The delivery chain is useful, but HTTP transmission/wake and local disk records are not one atomic transaction. After a crash, a wake can be scheduled twice even though logical inbox admission is deduplicated; provider retries and normal history replay intentionally resend previously consumed text. Claiming exactly-once physical delivery would be impossible without a cooperating remote idempotency contract.

**Clarify:**

> Exactly-once 限於 task/result revision 對 parent durable inbox 的邏輯 admission／消費狀態；使用穩定 delivery ID、durable outbox/inbox 與冪等轉移。Wake／傳輸可能 at-least-once，接收方按 ID 去重，允許 provider retry 與合法歷史回放重送內容；不能因此重新派發 child 或工具副作用。若結果在 Stop 前已 admitted、Stop 後才醒來，runtime 仍重新檢查 stop/lease 而不啟動 turn。

## Evidence precision corrections (P2, small)

The synthesis retains the important limitations: projected estimates are not provider samples; prune fixture is below hard window; orphan input is not a demonstrated current normal producer bug; the archive fixture is not a cold-load test; shipping child reports are already bounded. No substantive reversal needed.

Fix misleading source links:

- Synthesis R1 `core-agent/src/agent/context.ts:85` should be `:79` for ownedBudget.pressure; `compaction/src/index.ts:125` should be `:127` for callback selection.
- Synthesis R2 `llm-anthropic/src/context.ts:49` should be `:51` for counter.unit over the decorated message.
- Synthesis R8 `core-agent/src/agent/budget.ts:88` points past the 87-line file; actual accepted-output unavailable snapshot is `:82` (record method starts `:74`).
- Synthesis line 49 describes “原始事件 JSONL 內容”; the fixture sums JSON-serialized event objects plus newline in memory, not a persisted JSONL file including session header. Prefer “原始事件的 JSONL 等價序列化 bytes（不含 session header）”. Existing paragraph already correctly excludes cold-load/provider stress, so this is evidence-unit precision only.

These refinements do not require choosing policy ratios, new global output defaults, or an execution plan. They close correctness/migration contracts before implementation scope is finalized.

## Resolution verification — 2026-10-15

Reviewed only the revised passages in the two design/research documents; no new research, execution or tests.

| Finding | Revised evidence | Assessment |
| --- | --- | --- |
| P1 asynchronous accepted suffix | Spec §5 Commit, line 114, now names pending inputs, committed tool results, child settlement and notification admission, preserves them by stable ID, requires re-admission, and discards/rebuilds if joining cannot be proven safe. R3 acceptance at 165 includes tool/child result races. | Resolved at design stage. Accepted effects cannot be overwritten, lost or redispatched by snapshot replacement. |
| P1 Stop / durable publication | Spec invariant 25 preserves tool/unknown outcome/child settlement bookkeeping; §5 Commit at 114 defines durable commit as publication, ignores uncommitted candidates, and restores committed checkpoint plus suffix after Stop/crash/uncertain flush reply. | Resolved at design stage. Transaction identifiers, manifest digests and crash-cut fixtures remain implementation-plan details under this invariant. |
| P1 opaque downgrade / ownership | Spec 76 distinguishes observable compatibility checks from provider cryptographic validity; 119 defines route/provider/model/account/tenant/workspace/server scope and expiry, and blocks opaque-only/expired-ref migration without recoverable semantic source; 129 applies it to child inheritance. R3/R4 acceptance includes these cases. | Resolved. No promise of automatic conversion from opaque state to portable text remains. |
| P2 universal pair adjacency | Spec 76 explicitly describes route group-order, parallel calls, interleaving and hosted/external exceptions. R1 at 163 uses per-protocol group pairing/order. | Resolved. Preserves native multi-protocol structure. |
| P2 legacy authority inference | Spec 59 refuses to infer human authorization from user role/summary text, retains unknown/inherited provenance where trusted admission evidence is absent; R1 acceptance at 163 forbids privilege elevation. | Resolved. Structural import does not manufacture authority. |
| P2 logical exactly-once | Spec 131 identifies the durable inbox admission/claim key and permits idempotent wake retries rather than promising one physical signal/HTTP send; R4 at 166 checks repeated wake does not duplicate claim. | Resolved. Logical deduplication and physical delivery are separated. |
| Evidence precision | Synthesis 49 now explicitly says in-memory per-event JSONL-equivalent bytes including newline and excluding header, never written as a session file. R1 context link is 79; R2 Anthropic context link is 51; R8 budget link is 82. | Resolved for all requested substantive/evidence corrections. The neighboring compaction/index.ts:125 link still identifies the createAdmission call; :127 would point directly at the callback, but this is not a correctness blocker. |

Conclusion: all substantive findings from this review are resolved in the revised design proposal. No remaining P1 design blocker identified in the changed passages. This confirms proposal consistency only; it is not product implementation approval, a completed execution plan, or validation that runtime behavior has changed.
