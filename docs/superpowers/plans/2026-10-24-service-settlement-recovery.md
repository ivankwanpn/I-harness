# Same-service original settlement recovery implementation plan
> Promoted by root after the P2 independent review and source-boundary inspection. Execute this bounded Task2/Task7 packet; P2 original capture/Stop/host-close remains accepted within its recorded scope. Use a fresh implementer and full-range independent review. The test plan below has not yet been executed.

**Goal:** 實際 service.submit 的原 acceptance unknown 經原 key 確認後，由仍持有原來源的 document 完成有限收尾，同一未關閉 service 可接下一個明確輸入。
**Architecture:** 在現有 document sourceDrains 補「原 action 已 finish 且原 source 已被原 owner 明確要求 close」資格，由下一次 service.submit 的原 admission 前接合重入既有有限收尾；原來源自己 reconcile／close，不重建執行權限。
**Tech stack:** TypeScript、現有 ManagedDocument／SessionService、controlled loopback、JSONL、Vitest。
**Spec:** docs/superpowers/specs/2026-10-23-v0.1.13-integrated-delivery.md；docs/superpowers/plans/2026-10-24-recovery-terminal-settlement.md。
**Global constraints:** 0.1.13-rc.1／Session12 不變；無新 journal/schema、metadata 旁路、第二 registry、JSON/seq 重建權限、live provider/credentials/profiles、remote、純拆分；不重發 model/tool/input、不替換 action、不自動 retryAbsent。

## 1. 已證實的缺口及既有管理入口
- 原 source 註冊並由 document 持有；holdRecovery 加入 recoveryHolds，成功原 close 才刪除／releaseOptional：packages/session-persistence/src/coordinator/managed-document.ts:61、:336、:347、:355。
- document.reconcile(key) 只處理 pending frame 並 resume capacity；document.drain 只 await pump/check；document.close 先 revokeNewWork 再 close sources：同檔 :372、:388、:394、:399。故只 reconcile／drain 並未釋放 source hold，close 又不能維持 warm service。
- 現有 service.reconcileExecutionAuthority 僅 sandbox executionRuntime.reconcile，不能挪作 fact-source 收尾：packages/session-executor/src/service.ts:1146；assembly.ts:1589。
- 可用真實 host 管理入口是 SessionService.liveAssembly(id)?.managedDocument：service.ts:212、:971；assembly.ts:392、:1595。它返回原 managed document，不截取 source、不建新 Agent；無 live assembly 時不可用 assemblyFor 來假造 warm。
- 未 mount 的 ingress 仍由 coordinator.openManagedDocument(id) 取回原 document：lifecycle/managed-document.ts:24。此補充只供原 host 管理，不承諾另一個新 host incarnation 能取得舊 source。
- 既有 Agent fixture 改寫 registerSettlementSource、保存 handles 後 f.drain：packages/core-agent/test/unstarted-call-settlement.test.ts:40、:46、:66，僅證明 fixture owner。
- 既有 service borrowed control 先 close host/coordinator，兩次都 new coordinator/service：packages/session-executor/test/context-recovery.test.ts:236、:273；root-review-evidence-qualification.md 已限定為 fresh reopen，不能當 same-service GREEN。

## 2. 原 invocation 結束後仍由產品持有的東西
| 原 owner／存活鏈 | 有限收尾內容；明確界線 |
|---|---|
| document → 原 action 註冊 sources | action normal admission 已 stop/finish，但 sources／required authorization／captures 仍在；成功 source.close 釋放，失敗保留：managed-document.ts:328、:332、:338、:355。 |
| Agent invocation source → closure running、sourceDrains、原 lifecycle | closure await 原 operation，關閉 delegated sources，再 drain 原 lifecycle；locals 跨失敗保留，不讀下一輪 deps：packages/core-agent/src/agent/create.ts:50、:61、:72、:85、:89、:98。 |
| 原 response acceptance delegate | genuine captured acceptance＋finishFailure＋closureAttempted；unknown 持有，committed/absent 分類後才原結果／失敗／end；packages/core-agent/src/agent/acceptance-settlement.ts:8、:9、:11、:21、:27。 |
| 同 response 的 unstarted／recovery delegates | 原 call references、result captures、原 terminal recovery captures；尚未交接的工具只生成原 aborted-before-dispatch result，不能 prepare/execute；unstarted-call-settlement.ts:12、:23、:34；recovery-settlement.ts:6、:34。 |
| borrowed ingress 原 action | createInputPreparationOwner 的 retained captures／source、createGenerationLifecycle 的 running／retained／source、原 generation.close promise；input-preparation-owner.ts:12、:13；generation-actions.ts:19、:21；generation-action.ts:171。 |
| service 完整 submit disposition | preparedInput.close 在 caller settle 前執行；其 closeGeneration 先同步 capture，再 resolve closeDecided，finish 會 action.finish，即使後續 drain 失敗；service.ts:787、:808、:831；lifecycle/input-preparation.ts:30、:33、:39、:59。 |

- 程式仍執行中或只收到 Stop 的 action：不能列入本能力；signal.aborted／action.stopped 不等於原 operation 結束。另一個 active child 的來源保持原持有、結果與 Stop 權限。
- **finish 本身也不夠：** packages/subagent/src/job-facts.ts:17 註冊 mount source、:18 立即 action.finish，後續 record 仍產生 job/status；packages/code-mode/src/event-facts.ts:78 註冊 drainProducers source、:79 立即 finish。僅 finished 或 finished+recoveryHold 會錯關背景來源，兩案均排除。
- 明示 finish 只證普通 admission 永久 revoked；還需原 source 已被其 owner 明確要求 close，管理才可重入該原意圖。現有 Action 只有 stopped，需私有 finished 位；close-requested 預設 false，不從 history／錯誤名稱推定。
- required source records 由原 createSourceFacts 持有，drain 原 capture.reconcile；absent 仍失敗／hold：packages/session-persistence/src/coordinator/source-facts.ts:7、:25；settlement-fact.ts:59、:71。acceptance 的 absent 可完成「未接受」分類，與 required-result absent 不同。
- 本包不補造遺失的 preparation/generation 工作；原 source 無足夠 capture／closure、invalid/install-failed 或 sourceFault 仍需如實拒絕，不能清旗標假裝 recovered。

## 3. 待 root 凍結的唯一新能力
```ts
// packages/session-persistence/src/coordinator/fact-types.ts — ManagedDocument only
settleFinishedActions(): Promise<void>
// coordinator/settlement-source.ts — internal constructor operations only
onCloseRequested(): void // synchronous notification, no await / fact permission
```
- 呼叫者：持有原 ManagedDocument 的 trusted host；**shipping caller 是 service.ts:788 的 completeSubmission work 最前端**，在 :839 的 prev turn gate 之後、:789 的 prepareInputExecution 之前，從現有 liveAssembly(sessionId) 取原 document 並 await 此方法一次。不上 FactOwner／ManagedAction／SettlementFacts／Agent tools／wire DTO；不加 SessionService wrapper、不借 sandbox reconcile。
- caller 固定順序：const priorDocument = liveAssembly(sessionId)?.managedDocument；await priorDocument?.settleFinishedActions()；controller.signal.throwIfAborted()；若 closed || closing.has(sessionId) || failedClose.has(sessionId) 則 throw FACT_CLOSED；然後執行原 prepareInputExecution。這些語句在新 completeSubmission work 內，失敗仍由原 completeSubmission reject/report；queue row 不是 durable input accepted，admittedInputId 不重複 admit。原 startTurn 之前已 aborted 的 queued row 保留既有不執行語意。
- 具體流程：原 submit reject → backend 原 key 可確認（可先由既有 host 管理 reconcile）→ 同 service 新明確 submit → 等 prev 完整 disposition → 原 document 有限收尾 → 重查 closed／closing／failedClose／新 controller.signal → 原 prepareInputExecution／原 inbox admission／原 lane.runAdmitted。只有 source release 可解除 hold；未知仍拒絕，required-result absent 不 retry。
- 僅使用當前 cached live assembly；無此 assembly 就照既有 acquire/setup 路徑，不新建 Agent 來找舊權限。本包驗收範圍是實際 acceptance 已發生的 live assembly；未 mount setup recovery 不冒稱已覆蓋。新 Stop 不取消舊 finite settlement，但必須在新 admission 前生效；host close 中途開始亦不得建立新 action。
- 將既有 sourceDrains Set 元素改為 { source: { close(): Promise<void> }, finished?: () => boolean, closeRequested: boolean }；這是同一 registry 的資格資料。received-input source 無 finished，永不納入；未被原 owner 要求 close 的 job／CodeMode／spawn 長壽 source 即使 finished／held 亦保留。
- 每個 beginAction closure 有 let finished=false；只有 capability.finish() 在原 stopped/revoke 行為之外設 true；stop()/signal abort/revokeNewWork 都不得設 true。每個原 registerSettlementSource entry 綁此 closure；原 released callback 刪該 entry 並保留原 recoveryHolds／capacity release。
- createSettlementSource.close() 於首次呼叫、任何 await／失敗之前同步 operations.onCloseRequested()，令該 entry.closeRequested=true；失敗清 closing Promise 但不清此 sticky 位，成功仍由原 released 移除 entry。只有此內部 constructor notification，不加 registerSettlementSource 第三參數／SettlementFacts 方法／generation dependencies。
- 原 P2 路徑已具 close intent：create.ts:98 finish 後 :100 無條件 attempt parent source.close；若其 generation source 尚未 close，管理只重入 parent 原 closure :76 的 lifecycle.drain，不替 sibling 作決定。tool-batch join.ts:105 join inFlight 後 :118 resolve finished；背景 child publication 交獨立 owner（child.ts:91）。
- borrowed input-preparation.ts:39–44 的 finish 逐項 try generation.drain／preparation.close，前者失敗不跳過後者；:71–72 setup catch 亦執行。literal-input.ts:33–35 同樣逐項清理，:49 catch 走原 close。無需改這些 owner；原 closeDecided 仍在 generation close capture 後、await 前 resolve。
- close-requested 表示原 owner 已決定加入其 producer／settlement，不宣稱 producer 已 idle；重入只 join 其原 close Promise／原 callbacks，不主動 stop/cancel。從未 close 的 active source 保留；finish-only 與 recoveryHold-only 兩候選都不足。較大的 source readiness 新介面不採用，因已存在原 close 意圖且不需擴散修改。
- 進入時用 held.assertHeld，拒絕已 closing/closed；不呼叫 assertReady。同步 snapshot 僅取 finished()===true AND closeRequested===true 的原 entries；依註冊順序逐一 await 原 source.close，失敗逐項收集並繼續。sourceDrains 之外不建意圖／歷史 registry。
- 每次只處理開始時的有限 eligible snapshot，不 while-drain、不追新來源；同 document 的並行呼叫共用一個 attempt Promise，每個 source 仍用其既有 close Promise 合併。成功或失敗後清此 attempt，讓 host 可明確重試尚存原來源。原 parent closure 可 join 自己的 dependent generation；body mutation 留原 owner。無背景 retry／自動 retryAbsent。
- 完成後 await pump；pending/quarantined/sourceFault/recoveryHolds 任一未清仍回 FACT_RECOVERY_REQUIRED，聚合本輪真實 source 錯誤；不手動刪 holds 或 reset sourceFault。若 host close 已開始，完成已選原收尾後回 FACT_CLOSED，不宣稱 service 可用。
- source 的 close 已合併同時呼叫並於失敗後保留重試：packages/session-persistence/src/coordinator/settlement-source.ts:27；Agent delegate 同樣如此：packages/core-agent/src/agent/settlement-source.ts:50。
- 防 cycle：絕不從 document.reconcile、document.drain、pump、source.close callback 或原 submit completion 內呼叫本能力；shipping caller 僅在**下一輪** prev gate 後、建立新 action 前呼叫；同輪來源不能等待這個下一輪 submit。整輪不能包 ownership.withSessionOperation，因原 capture.reconcile 自己會取該鎖（managed-document.ts:374）。
- 已查 P2 的 finished+原 close intent 時點保障 Agent running 已 settled（create.ts:89、:98、:100），且 ingress closeDecided 已 resolve（input-preparation.ts:33、:41、:42）；generation beforeDrain → delegates → 原 generation 仍用既有方向，不 await 原 enclosing submit Promise。host close 也會呼叫 source.close 並標 requested，但 document closing fence 已先置位，不能藉此獲得 warm 資格。
- 註冊序的 borrowed generation 原 close capture 先收尾，使後續 acceptance closure 看到原 generation 已 closed；不得靠重建 generation.close 或改其 cached failure 解除依賴。因果測試若顯示一輪仍留真錯誤，保留錯誤與原來源，明確再次管理呼叫，禁止無界 drain-until-green。
- 原 submit 已交付的 primary/cause 不改寫；本能力成功只表示有限收尾完成。原 acceptance/classification/results/end/generation 均由同一 closure/source 決定；本能力不接收任何 fact payload。

## 4. 實作與真正 RED/GREEN 計劃（本輪未執行）
- [ ] R1：在 session-executor/test/context-recovery.test.ts 增加兩個 real submit unknown→committed/absent 控制，沿用 :199 JSONL 與 :223 loopback 的實體邊界；只攔 backend.appendOwnedBatch/reconcileOwnedBatch，不替換 action/source/factory。
- [ ] RED：第一個服務在原 acceptance receipt gate 變 unknown，讓原 submit 確實 reject；保留 error/cause/key。允許 backend 給 committed/absent，經原 document.reconcile(key) 後，對同一 service 作新明確 submit，現狀須因 source hold 拒絕、HTTP 仍 1。另證 document.drain 不能使它恢復。保留原 receipt／逐事件／拒絕原因，不能只測缺少新方法。
- [ ] R2：凍結內部 onCloseRequested、finished+sticky close intent；managed-fact-batch.test.ts 證 stopped-but-unfinished、finished-but-never-close、received-input source 都不 close；原 close 失敗仍 sticky、管理重入原 handle，不重造 drain。再接 service.ts pre-admission caller；無 production caller 不接受此包。
- [ ] GREEN：相同 real backend/service 控制中，原 submit reject、backend 開放原 disposition 後，直接 await service.submit('parent','next explicit input',freshSignal) 成功；由新 production caller 完成收尾，測試不得先手動 close/source-drain／settleFinishedActions。另獨立驗證既有 host liveAssembly→document 管理入口，不能拿它代替 shipping caller GREEN。
- [ ] 保存 service／liveAssembly／Agent／document／owner incarnation 全部物件 identity 相等；未 service.close／closeSession／coordinator.close、未重建 assembly/model、未 fixture f.drain。reconcile 僅原 acceptance batch key，acceptance issuance=1、無原模型／工具／input 重送；新明確輸入才增第 2 physical HTTP。
- [ ] committed 分支：原 accepted group 恰一次、原未 dispatch call 的 aborted result 恰一次、無 step/failed 誤分類；absent 分支：零原 acceptance、原 step/failed 恰一次。兩者 results→失敗分類（如需）→step/end→turn/end 及原 generation terminal 順序／身份正確，cold fold 無孤兒 protection；原 effect=0。
- [ ] unknown 再 unknown／conflict／install-failed：管理呼叫失敗，hold/capture/key 保留、新 submit 在 transport 前受原 fence 拒絕；不錯稱 durable、成功或 absent。再管理僅針對既有原來源。
- [ ] required-result unknown→absent：acceptance 可已確認 committed，但該原 result capture 仍 retained/hold，管理與 next submit 仍拒絕；驗證 append 次數不增、無 retryAbsent。不要把 acceptance-absent 的分類規則套到 required result。
- [ ] Stop／新輸入：receipt gate 前後分別 cancelRunning/abort；在下一輪 production recovery snapshot／source close gate 再排新 submit，仍經原 admission／queue／Stop fence，無新模型先跑；新一輪於 gate 中 Stop 時禁止 input admission／prepare/model。管理不取消另一 queued input，也不復活原 stopped invocation。
- [ ] 活躍 child／背景：真實 registerSubagent/spawn 先留住另一 child/provider gate；母 invocation unknown 結束後經下一次 submit 收尾，child 原 source 仍 active、無提前 terminal／close／重播。另在同 document 留真 job-facts 與 CodeMode producer gate（action 已 finish），證新 submit 不等待／cancel／close 它們，gate 未釋放時仍 warm GREEN；隨後原 owner 寫新 job/status／cell result 成功，再自行完成。held 背景 source 則保留 hold 並如實拒絕新工作，不能偷釋放。
- [ ] host close race：管理 gate 中同時 service.close/coordinator.close，所有 promises joined；close fence 永久生效、不能 same-service warm；只把合法 fresh reopen 計為另一項 cold gate，保留原 P2 borrowed control。
- [ ] primary/secondary：原輸出／Stop／acceptance failure ＋管理期間 required result/flush/generation save failure，逐 cause/aggregate identity 比較；保留原 primary 及實際 secondary，診斷不能覆蓋。成功管理不把原 submit rejection 改成 success。
- [ ] 檢核命令由唯一 runtime writer 序列執行：各 package CWD pnpm exec vitest run 指定新控制/原 affected suites --maxWorkers=2 --minWorkers=1；affected persistence/executor typechecks；固定 BASE..HEAD、來源 SHA、RED/GREEN raw receipt、key/HTTP/effect/input/generation counts，再交獨立 scoped review。未滿足 same-service GREEN 不關 Task2/Task7。

## 5. 唯一 writer 與共用檔案交接
| 工作線 | 與本包重合／須交接 |
|---|---|
| 本包唯一 writer | session-persistence/src/coordinator/{fact-types,managed-document,settlement-source}.ts；test/managed-fact-batch.test.ts；session-executor/src/service.ts 與 test/context-recovery.test.ts／必要 typed fixtures。core-session、core-agent、ingress/generation 產品源碼唯讀；root promote 前不寫產品。 |
| IC-B | 真共享為 executor service.ts，先凍結 pre-admission caller 再串行；assembly.ts、core-agent/src/agent/{create,generation,response,exchange,finalization}.ts 只讀核對。無公開 source 介面修改，原 accepted/issued handshake 不拓權。 |
| F1 | semantic-callers-next-packet-draft.md:36、:43 的 persistence bootstrap／result-store／公開 fork consumers；managed document 型別須先凍結；本包不改 fork/importSeed/result-store，不把 recovery 管理能力塞入 bootstrap transfer。 |
| S1 assembly hook | root 已釋出 bbca3c79 的 assembly schedule pre-step hunk 給唯一 NATIVE writer；本包 assembly 全唯讀，亦不碰 test/schedule-delivery.test.ts、不新增 idle tick／自動 submit／恢復後重放 occurrence。service 的新工作仍受原 occurrence admission。 |
- Root已凍結下列實作裁決；單writer依真正新測試結果實作。這份計劃不是產品恢復證據，也不是整版可交付聲明。

## Root promotion rulings and verification boundary

- **S2-01 original close intent:** `ManagedDocument.settleFinishedActions():Promise<void>` is the only new host capability. Eligibility is original `action.finish()` AND the same source's sticky, synchronously recorded prior `close()` request. Neither finish-only nor recoveryHold-only is sufficient: real job-facts and CodeMode mounts prove that finished actions may own still-producing sources. No third registerSettlementSource argument, public SettlementFacts method, generation dependency, event/schema change or producer-wide opt-in.
- **S2-02 one registry:** prefer changing the existing `sourceDrains` Set into a Map keyed by the exact same source object, with internal action/close-intent metadata. Preserve all `.has`, release/delete, input-source and document.close semantics against the real source key. A second registry keyed by action IDs/history/JSON is forbidden. The internal constructor callback records only intent; it grants no fact capability and must run before the first close await.
- **S2-03 finite original management:** one call snapshots eligible original entries and joins their existing close operations, preserving every genuine failure. It never drains until green, clears sourceFault/holds by hand, cancels a never-close producer, or retries an absent issued operation. Concurrent calls share one attempt; a later explicit call may retry retained originals. `document.reconcile`, `drain`, pump and source callbacks must not call this method recursively. Keep the actual owned source dependencies; source ordering is not permission to issue new work.
- **S2-04 causal ordering check:** the real same-service RED must be observed before implementation. Record separately (a) exact original document.reconcile followed by next service submit, and (b) backend disposition made available followed directly by next service submit, where original captured handles must perform their own reconciliation. Do not silently substitute a manual fixture drain or multiple hidden retry turns for either expected outcome. If original source ordering causes a genuine first finite attempt to fail, preserve that receipt and bring the exact owner dependency to root before changing the promised one-submission GREEN or adding new management mechanics.
- **S2-05 shipping gate:** place the real caller after the per-session previous-turn disposition gate and before new input preparation/action creation; recheck closed, closing, failedClose and current Stop after awaiting it. A queued service row is not durable input acceptance. Preserve existing admittedInputId behavior and original error/report cleanup. Still-active and never-close job/CodeMode/child sources retain their original rights and lifetimes.
- **S2-06 scope and maintenance:** only the three persistence owners, service.ts and named real tests/strictly needed typed fixtures may change. Keep assembly, core-agent, core-session, generation/input lifecycle and bootstrap/fork unchanged. S1's assembly writer is independent. No whole-file reformatting or pure decomposition; use a cohesive private helper only if necessary rather than growing unrelated responsibilities.
- **S2-07 gates:** package-CWD causal controls and affected owner suites, then persistence/executor typechecks on frozen sources. The previously combined core-agent495/495 is valid evidence for unchanged core-agent; do not rerun it merely to recreate an old green result. New failures/real shared boundary changes may justify targeted expansion, which must be explained. Every receipt includes command, CWD, timestamp, numeric exit and source binding; preserve all failed/setup/oracle iterations. Full BASE..HEAD independent review follows.

Root self-review: the plan now distinguishes finished action from finished producer, uses existing original close intent, installs a real service caller, fences host-close/Stop after awaits, preserves original capture/unknown/absent semantics, and records source-ordering uncertainty as a concrete causal gate. No permission to fake same-service recovery or broaden generic metadata admission is granted.

### S2-08 original pending-frame dependency (causal receipt03)

The real same-service controls prove that externally reconciling the original acceptance key before management makes both committed/absent branches pass, but backend-ready direct submit still fails. Earlier ingress/generation close captures meet the pending acceptance fence; the later invocation source owns acceptance reconciliation. Merely reversing arbitrary source order or discarding those errors is not an acceptable fix.

Authorize one narrow prerequisite in the same ManagedDocument owner: retain the actual pending frame and its exact original key at management entry, alongside the finite eligible-source snapshot. Registry metadata may retain the **original private Action object** as well as its finished/close-requested state. Only if every entry in that captured pending frame belongs by object identity to an action represented by the eligible snapshot may management observe/reconcile that original frame once through existing document.reconcile, before joining sources. No history/ID matching, new key, payload reissue, bootstrap entry, input receiver or active/never-close action can qualify. A physical mixed frame involving any unqualified action remains outside this automatic prerequisite; report recovery-required for explicit existing owner management.

Recheck original pending-object identity/current close fence before invoking the prerequisite; never chase a replacement pending frame or loop. An already-confirmed prior key is not a reason to create another operation. The existing document reconciliation controls visibility and outcome installation; known absent acceptance still means unaccepted, and a known absent required result still remains retained rather than being reissued. A still-unknown/conflicted/install-failed prerequisite remains a truthful refusal with its original outcome/cause. Do not reinterpret that outcome as completion or clear source holds manually. Do not hold ownership.withSessionOperation while calling document.reconcile or joining source.close.

Keep original source registration order after this prerequisite. Qualify both direct ready branches with one next service submission, exact one acceptance issue and no original model/tool/input replay. Add a control where a pending frame includes an unqualified active/never-close source: zero prerequisite reconciliation by this management call and no closing of that producer; explicit original-key host reconciliation remains a separate operation. Retain receipt03 and the successful manual-reconcile controls as the causal basis, not replace them with helper-only tests. No changes to core-agent/generation/input owners are authorized by this refinement.

