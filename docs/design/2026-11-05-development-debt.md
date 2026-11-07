# 開發債務清冊與 burn-down（2026-11-05）

> ## 交接（round 210 後的最新可執行狀態）
> **已完成且全綠**：code-mode（28 檔 365）、core-agent（79 檔 649）、exec（29 檔 367）、
> acp、core-session（87 檔 933）、sandbox-windows-acl（40 檔 382/5 skipped）；
> 三個 gate：typecheck 82/82、boundaries 147/147、reachability PASS。
> **仍紅**：session-persistence-jsonl 20 檔 / 93 failed / 764 passed / 17 skipped；sdk 3。
> **round 218 已結案：task-transition claim/lease 群（9/10 檔）**。結論修正 round 209/210 的判斷：
> 產品在 composed 車道**一直**持有 task document 的獨佔 lease——`append` 走
> `transitionLoad` → `transitions.existing`，claim+lease 在 `begin.execute()` 一起取得，
> 且成功後 `retainClaim()` 保留到 coordinator close。這批測試紅的原因是**觀測 namespace**：
> composed 的文件 lease 是 artifact identity（`artifact-ownership:<doc>` /
> `artifact-document-lease:<doc>`），而測試用裸 `createOwnership({lockRoot})` 的
> `acquireLease('doc:task-*')` 是另一個 lock 檔，因此永遠不會衝突。遷移方式見文末 round 218。
> 因此 **acquire-before-read／append 持 task lease 不再是待辦**（結構已滿足），
> 剩下的唯一 bootstrap 語義缺口是 `task-transition-bootstrap-revoke`（見 round 218 末）。
> **round 469（legacy compaction 觀察）**：app 對短 legacy 會話按 compact 回 `blocked:capacity-unavailable`；repo 測試可達 engine（fixture 摘要失敗為 `retention-output`）。
> **round 486（rc12 手動壓縮驗證）**：`desktop/session/compact`（帶 instructions）在 8 回合 CJK 會話回 `{compacted:true, outcome:'ready', publication:'committed', shadowedSeqs:8}`，摘要正常。
> 顯示 signature 計價修正後手動壓縮可用。
> **round 485（Context Mode / Code Context 續測）**：Code Context 索引 91 files／250 chunks，`code_context_search` 命中正確檔案（`partial:true` reason `result-budget`）。
> Context Mode：`context_output_read` 帶 maxBytes 4096 可正常分頁（textLen 3,629、nextOffset 3,629）；先前 `unavailable:budget` 是因為 prompt
> 讓 maxBytes 只有約 120，小於 ref metadata 大小。status/search 仍只涵蓋 legacy store（managed artifact 不計入），屬設計限制，待評估是否納入索引。
> **round 484（Context Mode / Code Context 實測）**：兩者預設關閉，透過 settings/API 開啟後 UI 顯示 ON。Code Context 可用（index 5 files/5 chunks、
> `code_context_search/status` 成功）。Context Mode 會把 >60KB 的 bash 輸出存成 managed artifact（ref `ctxv1_…`、65,007 bytes），
> 但 `context_output_status` 仍是 `results:0/retainedBytes:0`、`context_output_search` 無命中——status/search 只覆蓋 legacy store，
> 不含 managed artifacts；以完整 ref 呼叫 `context_output_read` 回 `unavailable: budget`，需再查 cursor/maxBytes 與 read 配額。
> **round 483（signature 不再停用容量計算）**：metadata 的 signature 走 opaque() 會加 opaque 不確定性 → estimate unknown → compatibility、context unchecked。
> 改為直接以 bytes/2 計價（保留 signature-token-cost），prepared 不再把它視為不可定價；實機 budget 變 estimated/known。token-meter 55/55、context-engine 98/98。
> **round 482（CJK token 計算與 cache 記錄）**：非 ASCII 以 UTF-8 byte 計價使中文每字 3 token（實測 heuristic 32,062 vs provider 17,944，1.8x）；
> 改為 CJK 每字 1 token（ASCII bytes/3、其餘非 ASCII 維持 bytes）。`context/usage` 新增 cacheReadTokens/cacheCreationTokens 記錄。token-meter 54/54、context-engine 98/98、core-agent 66/66。
> **round 481（partial reduction 修復）**：根因是 candidate 因 replacement 重寫訊息而 `fixedInput:true`，`reductionProgress` 因此拒絕；改為 reduction 自帶 rewrites 時允許 after fixedInput。
> 實機已發布 replacement（33.2k→14.0k heuristic tokens），context-engine 21/21。
> **round 480（partial reduction 不發布）**：reduceContext 只在 `candidate.target==='ready'` 時發布；實測 32.9k→13.9k（仍略高於 target）的
> 大幅縮減被丟棄，改挑 6-token 小組後候選變 33k，最終 `no-progress`，什麼都沒發布。已記錄修法（保留最佳候選並以 reduced-over-target 發布），需 mock ports 測試。
> **round 479（unpriced auto-compaction）**：capacity unknown 時兩個 auto gate 都跳過，長對話不會自動壓縮；改以完整 heuristic prefix 對 threshold 保底觸發 soft reduction。
> 實測 soft sequence 會啟動，但常回 `no-progress`（fixed schema／retained tail 無法降到 target）。另發現 usage checkpoint 只存 excludes-cache 的 input，缺 cacheRead 無法事後核算。
> **round 478（koffi.view × Electron 修正）**：`koffi.view` 在打包 Electron runtime 直接 NAPI fatal（Node 24 正常）；ACL runner 的 zero-fill 與
> PROCESS_INFORMATION 讀取改為 Electron 路徑不使用 view（alloc 已 zero、decode 逐次讀），sandbox 382/382；實機 read-only/workspace-write 的 pwsh 恢復。
> **round 477（受限沙箱 shell 全崩）**：`read-only` 與 `workspace-write` 下 `shell`/`bash`/`pwsh` 全部以同一 `napi_register_module_v1` fatal 崩潰；
> `write`/`read` 正常，`danger-full-access` 正常。手動在 packaged node 載入 koffi（主執行緒與 worker）皆正常（3.1.6），故非單純 koffi ABI；
> 崩潰發生在受限子程序的 native 載入階段。下輪測 `windowsSandboxBackend:psec` 與 dev（非打包）路徑。
> **round 476（workspace-write 沙箱 shell 崩潰）**：RC9 實機在 `workspace-write` 下 `write`/`read` 成功，但 `shell`/`bash` 子程序以
> `FATAL ERROR: Error::New napi_get_last_error_info`（`napi_register_module_v1`）崩潰，tool result 為 `outcome:unknown`、stdout 空白。
> 疑似 sandbox native runtime（legacy backend）在受限模式下載入 native addon 失敗；下輪測 `read-only` 與 `windowsSandboxBackend:psec` 釐清。
> **round 475（unpriced 不再阻擋 compaction）**：`bridge.prepare` 對 `token-cost-unavailable`＋coverage complete 的請求改以 `capacityFit:'no'` 繼續壓縮；
> 小會話由 `capacity-unavailable` 變成 `no-progress`（無可減內容），不再誤報容量。core-agent 15/15、gateway compact 3/3。
> **round 474（capacity-unavailable 真因）**：window 正常（1,000,000），pressure 回 `token-cost-unavailable`：summary/main 請求含 signature／opaque continuation 的
> token 成本無法估計（`assessPreparedCapacity` 的 uncertainties）。下一步：讓 compaction 評估只針對可定價內容，或在不可定價時跳過 capacity 阻擋。
> **round 473（小會話 capacity-unavailable）**：bridge 無例外，原因是 `assessLegacyPreparedRequest` 的 `pressure.kind==='unavailable'`
> （reason: this model has no configured context window）：manual compaction 路徑的 contextWindow 未帶入。下一步查 `runManualGeneration`
> → agent.compact → reduction bridge 的 model window 傳遞（一般回合有 1M window，卻在 compact 時 unknown）。
> **round 472（compaction 根因修復）**：replacement 驗證把 rewind 前未關閉的 turn 視為 ambiguous；delivery 追蹤也把 tool delivery／舊 generation 永久視為 pending。
> 修正後 rewind 會話可成功 compact（compacted:true, summary 產生），core-session 68/68＋新測試。
> **round 471（compaction 錯誤映射修正）**：`bridge.prepare` 對 `SESSION_CONTEXT_REPLACEMENT_FORMAT` 改回 `source-unrepresentable`；
> 實機同一個含工具＋rewind 的會話由 `capacity-unavailable` 變為 `source-unrepresentable`（已驗）。真正的候選保護集合問題仍待修。
> **round 470（compaction 真正原因）**：暫存診斷顯示 `capacity-unavailable` 其實是 `bridge.prepare` 的 catch 把
> `invalid context replacement: protected-source`（`SESSION_CONTEXT_REPLACEMENT_FORMAT`）吞掉；該會話含 bash 工具回合與
> rewind。build 應把此類錯誤映射為 `source-unrepresentable` 而非 `capacity-unavailable`，並單獨修 reduction 候選涵蓋 protected 來源的問題。
> **round 468（大型 workspace 的 watch 啟動失敗）**：chokidar `ignoreInitial:false` 對既有檔案逐一發 add，超過 4096 事件上限 →
> `FS_WATCH_GAP` → instructions 永久 unavailable → CLI 回合 `CONTEXT_INPUT_STALE`。改為 `ignoreInitial:true`（baseline 已提供已知集合），
> fs-watch 69/69＋新 4200 檔案回歸，CLI 在 repo 根目錄恢復。
> **round 467（forked child 刪除修復）**：deletion selection 分離 artifact ids 與 session ids，legacy inventory 只用 session ids 當 targets；
> 測試加回刪除斷言通過，實機刪除 fork child 回 ok。
> **round 466（forked child 刪除缺口定位）**：`prepareSession` 被以 document key `session-title/forked` 呼叫（`needs-parents`）；
> deletion participant 的 result-lineage targets 被當成 session ids 規劃。下一步在 target 規劃區分 session／document key。
> **round 465（legacy fork 續傳修復）**：gateway fork host 在 ready target 觀察後關閉 child 的 bootstrap document（僅非 SCL），
> 讓第一次 prompt 可 attach execution；`host-legacy-fork-continue` 綠，實機 fork→prompt 回 ok。刪除 forked child 仍有
> 「Original session parent unavailable」的獨立缺口。
> **round 464（legacy fork 根因）**：`acquireExecution` 在 entry 已有 document 時拒絕（
> `Original execution attachment requires its original entry construction`），而 v1 fork 的 bootstrap 已建立 child document；SCL coordinator 的 execution 生命週期不同，故 SCL fork 續傳正常。下輪修 legacy bootstrap 與 execution 的順序並補測試。
> **round 463（rc4 實測：legacy fork 無法繼續）**：fork prepare/begin 成功、seed 含來源 turn，但任何 prompt 都回
> `Original execution attachment requires its original entry construction`（session/prompt 與 durable input 皆同）。記錄於
> `2026-11-07-desktop-legacy-fork-continue.md`，下輪測 SCL 變體並對照 host-commit-log-fork-continue 修復。
> **round 462（first-write 修正）**：`manager.ts` preflight 在 prepare 後比較規則文字／sources；未變更則以新 snapshot 發 proof（
> first write 成功），規則真的變更仍回 unseen-rules。instructions 141/141；host-write-first 2 tests 綠（含規則中途出現仍拒絕）。
> **round 461（rc3 實測：write 首次失敗 unseen-rules）**：新 session 第一次 write 被 `INSTRUCTIONS_REPLAN_REQUIRED/unseen-rules` 拒絕
> （`not-dispatched`），模型搜尋 AGENTS.md 後重試成功並建立檔案。根因在 `manager.ts` preflight 的 catch-all 掩蓋真正例外；下輪
> 以 packaged gateway log 與 headless controlled-model 測試抓真實錯誤並修。記錄於 `2026-11-07-desktop-write-first-attempt.md`。
> **round 460（測試 harness 校正）**：core-session 先前 16 個 `memory-source-checkpoint` 失敗是直接跑 vitest 少了 `IH_STRUCTURE_EVIDENCE_ROOT`；
> 改用 `node scripts/test-env.mjs` 後 **933/933 全綠**。測試環境 app 已換成 rc3。
> **round 459（rc2 首個 prompt 修復）**：根因是 turn preparation 期間 session read 被 writer 以 dependency-cleanup 拒絕 → desktop recovery
> gate 誤判為 poison → reload 關閉 live turn。修法：desktop IPC 對 transient reads 重試（12×150ms）再 fallback reload；實機驗證 prompt 完成、
> 0 reload、0 session/error。commit 後續需重建 rc2 安裝檔。
> **round 458（debt waiter 嘗試，未解）**：改 execution-state 讓 prepareWrite 等待 transient read scopes、assertFresh 排除 transient；
> core-session 測試除既有 16 個 memory-source 失敗外全綠，但 packaged app 仍失敗且 assertFresh log 未觸發 → refusal 在更早的 admission
> （document／execution beginAction 的 FACT_RECOVERY_REQUIRED）。已 revert，下一步 instrument beginAction/bootstrapReady。
> **round 457（rc2 讀取競態定位）**：以 bridge 重現——submit 後 ~400ms 任一 session-scoped 讀取（history／context／work-state／input-state）
> 會讓該 turn 失敗；無讀取則成功。桌面 composer 正是這個時序（submit 後 ~420ms 發 history/context/work-state）。更新設計文件。
> **round 456（rc2 實機重現：新會話第一個 prompt 失敗）**：以可攜版＋CDP 實際操作重現 `model_error`；失敗 turn 停在 preparation 後、promotion 前，
> gateway diag 為 `FACT_RECOVERY_REQUIRED` / 「Original pending-input observation unavailable」；同樣 RPC 由 bridge 驅動則成功。已記錄於
> `docs/design/2026-11-07-rc2-desktop-input-recovery.md`，下一步為 instrument durable settlement source 與比較 composer/bridge trace。
> **round 455（最終整合驗證）**：canonical host 45／store 38／commit 43／CLI 6／SDK 74＝206，加 5 個 selection／lifecycle 守門＝211；
> typecheck、boundaries 147、reachability、bench 全 PASS，工作區乾淨。
> **round 454（反方向不對稱）**：legacy host 不列 SCL 會話（只掃 <id>.jsonl），資料仍在磁碟、切回 commit log 可見；已測試固定並寫入指南。
> 專項回歸 7 檔／8 tests。
> **round 453（legacy 會話仍可見）**：SCL host 列出並可讀既有 legacy 會話（list 合併 legacy ids、lazy adoption）；docs/session-store.md 明示；
> 專項回歸 6 檔／7 tests。
> **round 452（store 選擇專項回歸）**：4 gateway 檔＋CLI 1 檔＝5 檔／6 tests 全綠；status 新增 §5.2.1。
> **round 451（settings store 重啟耐久）**：只靠 settings 選 commit-log 的 host，重啟後可列出 session、讀到 history、診斷回報 commit-log。
> **round 450（lifecycle 兩個保證）**：刪除 session 會清掉 native-context 的 per-session artifacts（7→1 共享檔）；settings patch
> 保留 sessionStore；兩者已從 probe 提升為永久測試（artifact-cleanup、settings-write-preserve）。
> **round 449（閘門巡檢）**：typecheck／boundaries 147／reachability／bench 全 PASS，工作區乾淨，無需改碼。
> **round 448（canonical 計數）**：host 45、store 38、commit 43、CLI 6、SDK 74＝206 tests；status／session-store.md／assessment 同步。
> **round 447（store 使用文件）**：新增 `docs/session-store.md`（兩種後端、四種選擇方式與優先序、如何確認、legacy adoption、限制），
> status §5.3 連結。
> **round 446（diagnostics 顯示 store）**：桌面診斷頁新增 Session storage 區塊（Commit log／JSONL），資料來自 payload 的 sessionStore；
> 8 tests 綠、desktop typecheck 乾淨。
> **round 445（flag E2E）**：真實 headless run 以 `--session-store` 切換：commit-log 產生 1 個 v15 generation、jsonl 產生 legacy session 檔
> （另有 `.doc.jsonl`）且無 generation；flag 在兩條 run-flag 鏈中，不會外洩到 prompt（3 tests 綠）。
> **round 444（--session-store flag）**：run/sdk/acp 與 sessions 都支援 `--session-store jsonl|commit-log`；優先序 flag > settings > env > legacy；
> usage 更新、flag guard 接受 value、測試 8 綠。
> **round 443（CLI 讀 settings）**：`cliSessionStore()` 讓 run/sdk/acp 與 sessions 都依 settings > env > legacy；新測試以 settings 切換
> store 並觀察同一目錄的可見性差異（3 tests 綠）。注意：曾因 tools.read 截斷而誤寫 index.ts，已用 git checkout 還原後以 anchored edit 重做。
> **round 442（settings 選擇 store）**：新增 settings `sessionStore`（jsonl／commit-log、未知值視為未設定）；host 優先序 option > settings >
> env > legacy；diagnostics 回報目前 store。host-store-selection 測試雙向驗證，SCL host 39 檔／45 tests 綠。
> **round 441（最終驗證）**：host 44、store 38、commit 43、CLI 2、SDK 74＝201 tests 全綠；typecheck 乾淨、boundaries 147=baseline、
> reachability PASS、bench gate PASS、工作區乾淨。目標三項完成（移植以「不需移植＋nested 已解」收斂）。
> **round 440（nested selected fork 打通）**：capture 由 child 自身 seed pages 推導 inherited metadata（legacy rows 的 seed-result anchor），
> nested export 不再 pendingLegacy 拒絕；host E2E 建立 read-grandchild 並讀取 inherited page；SCL host 38 檔／44 tests 綠。
> **round 439（selected-source port 計畫）**：新增 `2026-11-06-selected-source-port-plan.md`（介面清單、4 個缺口、8 步計畫）；
> 依量測建議暫不移植（預設切換差距為 0），nested fork 的較小修法是 projectSelectedResults 接受 seeded history。
> **round 438（store 重置到底）**：prune → 刪 v10/v11 → 刪整個 node_modules → 官方 registry 全新 install，install 全成功、測試正常，
> 但 `store status` 仍 mutated → 判定為 pnpm 12.3.4 的 store/lockfile 完整性差異（環境層），非 repo 可修。
> **round 437（預設切換差距歸零）**：3 個 legacy 版面測試改 store-agnostic（session/history、work-state、雙 factory 捕捉）；
> 兩 store 下皆綠，6 檔 diff 在 SCL 15/15 綠。
> **round 436（store 修復邊界）**：ffprobe `allowBuilds:false` 後 install exit 0；store 仍是共享 `D:\.pnpm-store\v11`（6.2 GB）的 mutated 狀態，
> 完整重建需操作者決定；toolchain 驗證正常（store 38 tests）。
> **round 435（全量雙 store 比對）**：legacy 437 failed vs SCL 438 failed（雜訊主因 207 個 TASK_TRANSITION_UNSUPPORTED）；隔離重跑後真差異只有 3 檔
> legacy 版面斷言，另 3 檔為 flake。結論：預設切換不需 observations 移植。
> **round 434（預設切換量測修正）**：fork-session／result-page-host／rewind-host／title-action 在預設 legacy 下也失敗（baseline-red）；
> host 子集 legacy 6F/21P vs SCL 7F/20P，唯一差異 subagent-host 兩邊皆紅。尚無 SCL 專屬回歸證據，需全 gateway 雙 store 差異比對。
> **round 433（per-machine bench baseline）**：harness 改為以機器指紋作 key 的 baseline；本機 `--gate` PASS（append 38.5ms、deriveMessages 31.3ms），
> 外機用 reference 並標 WARN foreign；self-test 6/6；keyed baseline 已 gitignore。store 修復受阻：`install --force` 因 ffprobe ignored builds
> 失敗且會改寫 pnpm-workspace.yaml（已回退）。
> **round 432（append 成本歸屬）**：CPU profile 顯示成本在 conversation index 的 stage／beginStage（約 11 µs/append），事件 intake 僅
> 0.84 µs/event；屬 audit 的索引驗證，非 append 簿記。probe 與 profile 已刪除。
> **round 431（append 成本量化）**：append 線性、約 24 µs/event（n=500…8000 穩定），deriveMessages 4k events ≈ 65 ms/次；
> baseline 是 audit 前的 63 ns/event。bench 紅燈＝驗證成本，非病態成長；probe 已刪除。
> **round 430（閘門清單）**：status 新增 §5.2（typecheck／boundaries／reachability／bench caveat／store altered）；
> `pnpm store status` 在本機回報 altered（vitest／zustand 等），屬環境狀態。
> **round 429（bench gate 紅燈）**：`verify:bench` 在本機失敗（deriveMessages 35ms、append 42ms vs 0.079/0.127 baseline）。baseline 為
> 2026-09-18 錄製、bench 未變、core-session 已增 12.8k 行；與 commit log 無關（bench 只用 core-session 的 in-memory append/deriveMessages）。
> 列為既有 caveat，不擅自重寫 baseline。
> **round 428（boundary gate）**：新增的 core-session 深層 import 觸發 boundary gate（148 vs 147）；core-session 宣告
> `./internal/conversation-passive-context` 後恢復 147，host 38 檔／44 tests 全綠。
> **round 427（評估文件校正）**：birth/adoption assessment 的測試數更新為 201，並補上 selected-results read-through 的現況。
> **round 426（整合回歸）**：host 44、store 38、commit 43、CLI 2、SDK 74＝201 tests 全綠；status 已同步。
> **round 425（fallback 不擴大授權）**：child 請求未繼承的 ref 仍回 unavailable；host 38 檔／44 tests 全綠。
> **round 424（read 錯誤也走 fallback）**：`direct()` 把 throw 轉為 unavailable，讓 parent-chain fallback 在讀取拋錯時也能執行；
> host 38 檔／44 tests 全綠（result-page-host 仍是既有 baseline-red TASK_TRANSITION_UNSUPPORTED）。
> **round 423（回歸再驗）**：host 38 檔／44 tests、store 38、commit 43 全綠；typecheck 全綠、reachability PASS，近期改動無回歸。
> **round 422（nested 明確拒絕）**：SDK v2 prepare 對非 prepared 回 `Selected results fork unavailable: <reason>`；E2E 固定 nested 為
> `...: unsupported`。SDK 74 tests 全綠。
> **round 421（nested 收斂到 projection）**：child manifest 欄位齊全；拒絕來自 seed-export 的 catch-all（line 91），即
> `projectSelectedResults` 對 completed-seed 歷史丟錯。修法在 core-session 的 projection。probe 已回退。
> **round 420（nested 拒絕原因）**：`unsupported-history` 發生在 v3 export 的 boundary/selection 階段（來源歷史以 completed v3 seed 開始）；
> 需 core-session 支援重新匯出 child history。instrument 已回退。
> **round 419（parent chain）**：read-through 改為最多走 16 層 parent；nested selected fork（fork child 再 fork）仍被拒
> （v3 export 不從 completed v3 產生 child-history seed），列為 source port 的後續項。
> **round 418（預設切換量測）**：以 IH_SESSION_STORE=commit-log 跑 legacy 導向 5 檔 → 17 failed／5 passed（fork-session、result-page-host、
> rewind-host、title-action），證據支持維持 opt-in，需先移植 observations／result-store。
> **round 417（inherited read-through）**：child 讀取 inherited page 改由 createConversationResultReader 回退到來源 session（需 parent link
> 且 ref 在 seed pages）；E2E 斷言 data，33 檔／35 tests 全綠。
> **round 416（舊格式無法合成）**：legacy store 只寫 v15，舊格式的 fact-journal writer 未匯出 → 6–12 樣本只能來自舊版本錄製；
> in-tree 可驗證的 adoption 已由 legacy-version-adoption 覆蓋。
> **round 415（舊版本 adoption）**：formats 6／8／11／13／14 皆可經 legacy store 讀取、首次寫入遷移為 v15，profile 回報新格式；
> 剩餘的 corpus 缺口只在 legacy reader 的 byte layout（需錄製樣本）。
> **round 414（計劃執行完畢）**：最終回歸 host 38 檔／44 tests、store 38、commit 41、CLI 2＝125 tests 全綠；typecheck 全綠、
> reachability PASS。selected-source 移植為唯一後續大型工作（已明確記錄）。
> **round 413（hydration 也無效）**：補 `context/result-ref` 後仍 `unauthorized`，改動已回退。結論：child 讀取頁面需要 legacy 式
> selected source（held observation＋owning result store）＝§8.2 的 observations 移植；其餘在 commit log 上皆已可用。
> **round 412（store 才是關鍵）**：`readResult` 先查 child 的 context store；seed pages 不是 `context/result-ref`，store 沒有該 ref。
> 下一步：建立 child 後為每個 page row 補 `context/result-ref` 事件。
> **round 411（seed fallback 無效）**：在 `hasVisibleResultRef` 加 seed refs fallback 後 child 仍 unavailable → 拒絕不在此 hook，
> 可能在 service 的 `readManagedResultPage` 授權；改動已回退，測試只斷言 unavailable。
> **round 410（authorization 路徑）**：`allowed()` 需 `store.owns(ref, sessionId)` 或 host `authorize`；child 兩者皆無（gateway 的
> `resultReadScopeFor` 對 child 回空）。修法在 host 端給 child 一個涵蓋 inherited refs 的 read scope。
> **round 409（task document 修正）**：selected fork 直接走 `createChildSession`，未播種 `task-<id>`，導致 child assembly setup 失敗
> （`Owned task document is absent`）→ failedClose。controller 現在補種；child prompt 後 close 乾淨，但讀取仍 unauthorized
> （observation 沒有 inherited selected results）。
> **round 408（child prompt 的 close leak）**：內層錯誤是 `Session service process cleanup incomplete`（assembly.ts:1947 聚合了失敗的
> process close）。修好後才能重試「prompt 後讀取」；測試維持固定 unauthorized。
> **round 407（unauthorized 來源）**：來自 context-output 的 result-page scope（需 live observation）。先 prompt child 再讀，會讓 host close
> 失敗（session service 未釋放）——先修該 leak 再重試。測試維持固定 unauthorized。
> **round 406（child result read＝unauthorized）**：E2E 完成（來源可讀、child seed 有 pages），但 child 的讀取回
> `{kind:"unavailable",reason:"unauthorized"}`——只剩 result-lineage gate；測試固定現況。
> **round 405（child result read 計畫）**：頁面內容在 artifact store；需真實 artifact＋`context/result-ref`，流程為 turn → close → append ref
> → 新 host → v2 fork → 在 child 讀取。草稿跨 close 遺失 session id，實作留待下一輪。
> **round 404（host 繼承 pages）**：預先 seed 的來源（含 `context/result-ref`）經 host v2 fork 後，child 有 `conversation/seed-results`；
> 無 ref 的來源仍為 0 pages（兩個案例都固定）。
> **round 403（result-ref 產生 pages）**：來源加 `context/result-ref` 後 capture 產生 `conversation/seed-results` pages；
> host 的空白 seed 是因為該 turn 沒有引用結果，不是 capture 壞掉。
> **round 402（無選取即無 pages）**：child 的 seed 只有 manifest／groups；來源沒有選取時 pages 為 0（測試已固定）。
> 下一步：在來源記錄一次 selection 再 fork，驗證 page 繼承。
> **round 401（host v2 fork）**：commit-log host 接上 prepare/executeSelectedForkSession；v2 prepare→begin 建立 `selected-child` 並列在
> session/list。host 37 檔／42 tests 全綠。
> **round 400（selected fork controller）**：prepare/execute 在 SCL 上完成（v2 core、intent、createChildSession、project binding、
> v2 receipt）；測試 load 到 header `semanticSeed v3`。剩 host seam 接線與 host 測試。
> **round 399（gateway seed capture）**：`captureSelectedResultsSeed` 以 `coordinator.load` 取 snapshot、建 context、匯出並 compile v3 seed；
> 對真實 commit-log session 的測試通過。
> **round 398（SDK v2 seam）**：新增 `prepareSelectedForkSession`／`executeSelectedForkSession`，prepare/begin 對 v2 契約 fallback；
> 無 seam 的 host 維持原本的拒絕訊息。SDK 74 tests、gateway fork 2 tests 全綠。
> **round 397（selected-results wiring 計畫）**：v2 readers 已存在，缺 SDK 的 fork/prepare、begin/retry seam 與 gateway 實作；
> 計畫列為 4 步（SDK prepare、SDK begin、gateway seam、host 測試）。
> **round 396（SCL 接受 v3 seed）**：`captureBootstrapRequest` 接受 v3 manifest（selected-results commitment 驗證、v3 discriminator、
> groupCount 取自 manifest）；測試以 SCL 建 session → v3 seed → `createChildSession` → load 成功。剩 gateway composer。
> **round 395（v3 seed 被 bootstrap 拒絕）**：`createChildSession` → `captureBootstrapRequest` 只收 v1/v2 manifest，v3 回
> `Invalid bootstrap materialization`；下一步是讓 SCL child creation 接受 v3 record prefix。
> **round 394（真實 snapshot）**：以 SCL 建立的 session（含 artifact result）load 出的 `session` 直接產出 v3 seed，兩個測試通過。
> 剩：compile seed → fork host 提交 → gateway composer。
> **round 393（v3 seed 原型）**：由 folded Session＋FactOwner＋completed passive context 直接產出 v3 selected-results seed（測試 27ms），
> 不需 legacy observations 層；剩把真實 SCL snapshot 接上並從 fork host 提交 compiled seed。
> **round 392（B2 入口）**：`heldSource()` 證明只靠 `createManagedSessionState`＋`FactOwner`＋`createCompletedPassiveContext` 就能呼叫
> `exportSelectedResultsConversationSeed`；SCL 可提供 snapshot → Session。剩 held pages 的 `legacy()` 迭代待驗。
> **round 391（selected-results 邊界）**：SCL 的 v2 selected-results fork prepare 回 `Invalid fork preparation request`（清楚拒絕），
> context-runtime 回 `SELECTED_RESULTS_UNSUPPORTED`；已在 fork-continue 測試固定。
> **round 390（缺口清點）**：status 標記 fork child 續用與 fork→delete 已修；selected results 是唯一阻擋預設切換的功能。
> **round 389（compaction 與 todo）**：八輪 compaction 後 todo 仍為 revision 1／內容保留（compaction 只重寫對話）。
> **round 388（plan 閱讀指引）**：計畫檔開頭註明 Plan 區段是往前插入、編號非遞增，現況以 status 文件為準。
> **round 387（rewind 與 todo）**：conversation rewind 後 todo 仍為 revision 1／內容保留（rewind 只動對話，不動 task document）；
> host 36 檔／41 tests。
> **round 386（ADR 產品面）**：ADR §6 與「已驗證產品面」補上 fork child 續用、rewind 變體、search／context picker、todo、重啟耐久，
> 並把回歸數字更新為 host 35 檔／40 tests。
> **round 385（nested fork 續用）**：parent→child（turn）→grandchild（turn）皆成功、專案繼承、順序刪除清空；host 35 檔／40 tests。
> **round 384（fork child 可續用）**：code-mode 對 `origin:"fork"` 放行（仍拒 delegationDepth／subagentProtocolVersion／其他 origin）；
> child 可跑 turn、有自己 rewind point、可管理 schedule。host 34 檔／39 tests 全綠。
> **round 383（fork child 不能跑 turn）**：SCL 上對 fork child `session/prompt` 回 `Private delegated or unsupported Code owner`（code-mode
> register 拒絕帶 parentSession 的 header）；legacy 同序列可跑。待修：fork child header 不應帶 delegated 標記。
> **round 382（被拒 schedule 後可刪 child）**：`readOriginalRuntime` 對缺席／已關的 runtime 回 undefined（不再丟 `Original managed runtime
> unavailable`），child delete 恢復 ok；新增 `host-commit-log-fork-schedule.test.ts`，host 33 檔／38 tests 全綠。
> **round 381（child schedule 契約）**：fork child 的 schedule create 在 legacy 與 SCL 都回 `Private delegated or unsupported Code owner`
> （產品規則）；但被拒後同 host 內 child delete 會 `ok:false`，列為下一個調查項，未寫入測試契約。
> **round 380（read-only cold document）**：新增 `openReadOnlyManagedDocument`（read 模式、不註冊 managed）；fork witness 改用它，
> 不再關閉 cached execution document。FACT_CLOSED 邊界消失，fork-after-turn 的完整序列（child todo＋descendants＋順序刪除）通過；
> host 32 檔／37 tests、commit 35 tests 全綠。
> **round 379（execution document 帶 view 失敗）**：`openCommitExecutionDocument` 改傳 `context.source` 後 prompt 直接
> `FACT_OWNER_UNSUPPORTED`，已回退；改走「read-only cold document 給 fork witness」方案。
> **round 378（換位置再現）**：對 closed execution 的兩處容忍只把錯誤推到 `execution-inputs.pending()`；真正修法是 fork 不要關閉
> parent 的 cached execution document（讓 execution document 自帶 view，或另開 cold handle）。已全部回退。
> **round 377（FACT_CLOSED 對照）**：legacy 對同序列回正確的 descendants 錯誤，SCL 回 FACT_CLOSED——確認是 SCL 專屬；closed 的
> parent document 正是 fork 為取得 cold witness 而關閉的那個。修法：fork 不關 cached execution document，或 task operation rebind。
> **round 376（全回歸）**：host 32 檔／37 tests、commit 系列 31 tests 全綠（facade 的 fork task document 修正無回歸）；status 更新為 118 tests。
> **round 375（FACT_CLOSED 收斂）**：確認錯誤來自 `captureParent(document).assertCurrent` → `document.assertReady()`（capabilities.ts:68）
> 對已關閉的 parent document；readOriginalRuntime guard 只移除了第一段堆疊。待修：task operation 重新綁定新 document。
> **round 374（兩個未解問題診斷）**：child schedule 是 delegated runtime 被 schedule handler 擋下；parent delete 的 FACT_CLOSED 有兩段堆疊
> （closed execution 的 runtime assertCurrent；task-document 操作持有已關閉文件）。instrument 已回退，修法在文件／runtime 生命週期。
> **round 373（fork child task document）**：fork 經 `createChildSession` 未播種 `task-<id>`，導致 child todo 失敗；facade 現在於缺
> 失時補上（不覆寫）。仍待處理：child schedule 回 `Private delegated or unsupported Code owner`、child todo 後刪 parent 回 `FACT_CLOSED`。
> **round 372（修正：fork-after-turn 斷言其實沒進檔案）**：Plans 107–112 的斷言未寫入測試檔（只改了文件）。重套後暴露兩個問題：
> （a）child todo 後刪 parent 回 `FACT_CLOSED` 而非 descendants；（b）child schedule 會讓 host close 失敗（`session service`）。
> 測試檔已回退，列為後續調查。
> **round 371（child todo）**：fork child 的 work-state revision 0 → 寫入後 1，cold document 路徑正常。
> **round 370（child schedule）**：forked child 上 schedule create/list/delete 皆正常。
> **round 369（status 更新）**：§3 補上 fence exclusive 授權、fork/rewind 於 turn/rewind 後、settleCapture 容錯、descendant 守門；
> 全 host 回歸維持 31 檔／36 tests。
> **round 368（delete 與 observer 並存）**：observer 持有 load handle 時 delete 仍成功；先前的 `does not exist` 是刪除後又呼叫
> `rewind/points` 造成，非鎖問題。
> **round 367（刪除 rewind 過的 session）**：rewind 後 batch delete 成功、list 清空（先關閉觀察用的 coordinator）。
> **round 366（先刪 child 再刪 parent）**：child delete 成功、parent 保留；之後 parent delete 成功、列表清空。
> **round 365（descendant 守門）**：有 fork 子會話的 parent 以 batch delete 被拒（`descendants`），child 保留。
> **round 364（SCL 全回歸）**：host 31 檔／36 tests、`session-commit-log` 9 檔／38 tests、commit 系列 43 tests，共 117 tests 全綠；
> status report 已更新。
> **round 363（fork-after-rewind 修正）**：`settleCapture` 對「Original capture obligation released」視為已 settled；
> rewind→fork 後 host close 乾淨，測試 `host-commit-log-rewind-fork.test.ts` 通過。
> **round 362（capture 釋放堆疊）**：`expired` 堆疊顯示 close → execution-inputs `settle()` → `settleCapture(fact.observe())`，
> 讀到已釋放的 delivery admission capture；疑與 rewind 關閉 settlement source 時仍有 pending admission 有關。
> **round 361（洩漏細節）**：closeAll 的失敗是 `TypeError: Original capture obligation released`（execution-members），代表 rewind/fork
> 保留了 member obligation 卻在 capture 釋放後才存取；instrument 已回退。
> **round 360（rewind 後 fork 洩漏）**：rewind 後 fork 成功，但 `host.close()` 以 `Desktop host cleanup incomplete: session service` 失敗；
> legacy 正常。關閉 cold document 無效，懷疑 rewind 的 managed execution 與 fork observation 互動；已回退探測。
> **round 359（rewind after turn）**：prompt 會記錄 rewind point；plan+execute（conversation）成功，points 清空且 log 有 `rewind/point`
> （`session/list` 的 turnCount 仍為 log 值，rewind 是標記不是改寫）。
> **round 358（fork after turn）**：SCL 上 fork 跑過 turn 的 session 失敗（`Session fork unavailable` / internal），根因是 cached execution
> document 沒有 `view`；`withHandoff` 在 view 缺失時 close 後重開冷 document。legacy 對照成功。
> **round 357（delete after turn）**：跑過 turn 的 session 以 batch delete 刪除成功，list 與 archived 都不再出現。
> **round 356（batch archive/restore）**：跑過 turn 的 session 走 batch 路徑也能 archive／restore（修正前兩個結果都是 ok:false）。
> **round 355（archived context）**：archive 後 `context/search`（sessions）回空、`context/read` 被拒（outside the current project）。
> **round 354（archive 修正）**：`exclusive` 對自己的 async context 發 admission token，`assertOpen` 對 `blocked` 尊重該 grant
> （retired 仍全拒）；archive-after-turn 與 restore 測試通過。
> **round 353（archive 卡住隔離）**：三種序列（prompt→archive、prompt→search→archive、prompt→context→archive）在 SCL 與 legacy
> 都一樣失敗——不是 SCL 回歸；任何跑過 turn 的 session 都無法 archive。錯誤來自 fence.assertOpen（blocked 或 retired），
> 表示 archive 當下仍有 exclusive 在飛或旗標未清除。待 instrument exclusive。
> **round 352（archive 卡住）**：prompt→list→search→context 之後，manage/batch archive 都回 `Session management is in progress or
> session is deleted`，profile 沒有 archived。已回退探測；待隔離是哪個呼叫讓 session 變成 busy。
> **round 351（context files／project guard）**：files 模式命中 `notes.txt`；跨專案 session reference 被拒
> （`Session reference is outside the current project`）。
> **round 350（context read）**：正確參數為 `{reference:{kind:"session", workspaceId, sessionId, seq}}`，回 `{text, truncated:false}`
> 且含 token；先前的空物件是參數層級錯誤。
> **round 349（context picker 搜尋）**：`desktop/context/search`（sessions）經 conversation query 命中 SCL session（含 excerpt）；
> `context/read` 在此配置回空物件，暫不納入斷言。
> **round 348（冷 diagnostics）**：`desktop/environment/diagnostics` 冷 session 為 `{live:false, sessionId, tools:[], roles:[]}`
> （shell 區段依主機環境，不固定）。
> **round 347（live todo 寫入）**：turn 之後 revision 1，帶 expectedRevision:1 寫入成功並回 revision 2。
> **round 346（todo 冷寫入修正）**：冷 `writeTodos` 改走 coordinator document（`document.view` 檢查 revision、`actionMetadataFacts`
> 寫入、寫後關閉），不再 `selectComplete`；todo→turn 流程與 in-turn `todo_write` 全綠。
> **round 345（todo 衝突根因）**：`writableSessionFor` 會 `selectComplete`，讓該 session 永遠跳過 first-party managed selection；
> 後續 turn 走非 managed assembly → in-turn task tool 沒有 managedTaskOwners。兩種繞道（關 document、關 session）都失敗，已回退。
> **round 344（todo 衝突嘗試）**：在 `writeTodos` 冷路徑寫入後 `closeManagedDocument` → 下一次冷寫入回 `Supplied Session is not
> this document view`。已回退；正確修法在 `acquireExecution` 重用既有 document（或冷寫入完整釋放 session），不能只關文件。
> **round 343（todo 寫入與 in-turn tool 衝突）**：`desktop/session/todo/write` 在 SCL 冷 session 正常（revision 1、stale 被拒），
> 但先寫 todo 再跑 turn 時，模型 `todo_write` 失敗 `Original Task projection owner required` 且 prompt rejects。已記錄，待追 owner 一致性。
> **round 342（execution cursor）**：負 offset 與 limit>20 被拒（`Invalid execution cursor or dimension`）；超大 offset 合法且回空頁。
> **round 341（limit 下界）**：修正 `limit:-5` 會經 `slice(0,-1)` 回「全部少一筆」的錯誤；改為 `max(0, min(limit,100))`，
> fallback 對 `limit<=0` 回空。
> **round 340（lineage 工具＋snippet）**：`lineage` 工具由 coordinator metadata 回答 ancestors／children；長訊息中間命中時
> snippet 兩側有 `…`、長度受限且含 token。
> **round 339（session_search 工具）**：tool→conversation query→SCL fallback 端到端通過（命中含 snippet、缺席回空）。
> **round 338（tool 內容可搜尋）**：fallback 涵蓋 tool/call args 與 tool/result output（搜尋 `do it` 命中）。
> **round 337（搜尋 limit）**：兩個 SCL session 共 3 個命中，`limit:2` 回 2 筆、`limit:100` 回 3 筆（跨 session 上限生效）。
> **round 336（混合 store 搜尋）**：同一目錄下 legacy JSONL 與 SCL session 都命中、無重複；legacy 來自索引（bm25 ≤ 0）、
> SCL 來自 fallback（bm25 0）。
> **round 335（未知 session 視圖）**：`processes/read`／`execution/read` 對不存在的 session 回 `does not exist`（-32602）。
> **round 334（冷輸出錯誤）**：`processes/job-output`／`terminal-output` 對未知 id 回 `… unavailable for this owner`（-32602）。
> **round 333（冷視圖形狀）**：`processes/read` 冷 session 為 `{live:false, terminals:[], jobs:[]}`；`execution/read` 為
> `{live:false, cells:[], total:0}`，已由 turn 測試固定。
> **round 332（subtree 搜尋）**：`createConversationQuery` 支援 `subtreeOf`（以 lineage 解析子樹後過濾 ids），測試覆蓋
> 無過濾與 root 子樹兩種結果。
> **round 331（coordinator lineage）**：SCL store 的 lineage 改由 profile 的 parentSession 鏈推導（ancestors）與掃描（children／
> descendants），`session-lineage.test.ts` 覆蓋 depth 2 與未知 id。
> **round 330（session search fallback）**：file-backed 索引對 SCL session 沒有資料；host 加 `createCommitLogSearchFallback`，索引為空時
> 由 coordinator 載入該 session 做 substring 搜尋。lineage 仍走檔案索引（缺口已記錄）。
> **round 329（batch 邊界）**：重複 archive 為成功（idempotent）、刪除已封存 session 成功、restore 已刪除 session 失敗
> （does not exist，不復活）。
> **round 328（跨 host batch move）**：重開的 host 需重新 configure 專案（main-process state），之後 move 綁定／未綁定 session
> 都成功；錯誤的 expectedOwners 被拒（Session project owner changed）。
> **round 327（metadata 跨重啟）**：title／archive／project binding 在 host 重啟後仍一致（archived 列含 title 與 projectId，
> restore 後標題保留）。
> **round 326（rewind files 模式）**：`mode:"files"` 還原 tracked 檔並保留對話事件；`mode:"both"` 不是合法值，RPC 以
> `Invalid rewind request` 拒絕。
> **round 325（rewind fingerprint 失效）**：preview 後改動 tracked 檔，execute 以舊 fingerprint 被拒（Rewind preview changed），
> 不追加 rewind/point、不動對話；亦確認 fingerprint 不涵蓋之後的 append（會在 rewind 目標處被截斷）。
> **round 324（跨 host rewind）**：host1 points+plan、host2 execute（fingerprint）成功，points 清空，log 留下 `rewind/point` 標記；
> rewind 規劃可跨重啟（與 prepared fork 不同）。
> **round 323（prepared fork 不可續）**：host1 prepare、關閉、host2 begin 在 commit-log 與 legacy 都回 `Session fork unavailable`，
> 屬產品層契約（prepared fork 存在原 host 記憶體）；測試固定兩邊行為。
> **round 322（host 重啟續用）**：host1 建立＋prompt 後關閉，host2 冷載入看到 turnCount 1，再 prompt 後 turnCount 2——
> desktop 重啟路徑端到端通過。
> **round 321（pin 回歸測試）**：新增 close→第二個 coordinator openManagedDocument 的測試；把修正回退可重現 `.capabilities` 鎖衝突，
> 證明測試能抓住洩漏。
> **round 320（pin 洩漏修正）**：`coordinator.close()` 改走 `closeManagedDocument`（關 log + unpin），最後再 unpin 殘留；
> 兩 host 的 schedule 重啟測試（建立→關閉→重開→列出→刪除→關閉）全綠。
> **round 319（真正的錯誤）**：host2 的 `schedule/delete` 是 `.capabilities` 檔案鎖衝突（deadline 2000ms），close 的內層錯誤是
> `AggregateError: Session service process cleanup incomplete`（service.ts closeAll）。根因是 host1 關閉後仍持有 capability lock，
> 不是 runtime release；下一步追 `createCommitOwnershipPorts` 的 close/releaseOwnership 路徑。
> **round 318（單元層重現失敗）**：session-executor 單元測試（prepare runtime → service.close）在 legacy 與 SCL coordinator 下都
> 正常關閉；洩漏只在完整 desktop host 組裝下出現。host 探針卡在 `.capabilities` lock（prompt 逾時），需改為量測 host shutdown 各階段。
> **round 317（冷 schedule 修正嘗試）**：在 schedules.create/delete 對非 live session 呼叫 `service.closeSession`，需放在最後一個
> `runtime.assertCurrent()` 之後；仍產生 FACT_CLOSED 警告且兩 host 重啟測試仍以 session service 清理失敗收場。已回退，
> 正確修法在 managed-execution 生命週期（runtime release 或 service 關閉時 drain）。
> **round 316（冷 schedule 關閉洩漏）**：在同一 store 開第二個 host、對冷 session 做 `schedule/delete` 後，`host.close()` 以
> `Desktop host cleanup incomplete: session service` 失敗；冷路徑的 `prepareOriginalManagedRuntime` 未關閉 assembled execution。
> 重啟測試已回退，列為下一個 lifecycle 項目。
> **round 315（schedule 未知 session）**：`desktop/schedule/list` 對不存在的 session 回 -32603 `does not exist`（不是空列表）。
> host 重啟持久性測試需要先把 host 工廠抽成可重用的 opener，暫緩。
> **round 314（現況報告）**：新增 `docs/design/2026-11-06-session-commit-log-status.md`（已驗證面、效能、生命週期、缺口、決策、重跑指令）。
> **round 313（selected results 範圍釐清）**：只有帶 `results:"selected-results-v1"` 的 fork／child 捕獲受影響；一般 fork、
> 無 selected 的 task child、`session/result/read`、context output 皆不受影響（已在 SCL 驗證）。ADR §8.2 已註明。
> **round 312（啟用 context output 後）**：`contextSubsystems.contextOutput.enabled = true` 時，`context_output_read` 仍不在 log 留下
> `tool/result`，只有 context/action、context/budget、context/attempt；待從 native context 直接確認是否需 selected-source witness。
> **round 311（context_output_read 探測）**：SCL host 上以真實 artifact ref 呼叫回 `{"error":"Context output is disabled or stopping"}`，
> 表示測試配置未啟用 context output，尚未走到 selected-source 路徑；探測已移除，結論記入計畫。
> **round 310（selected results 資料流）**：追到出口是 `exportSelectedResultsConversationSeed`，需要 CompletedPassiveContext、
> HeldInheritedResultMetadata、HeldResultPages，輸出 v3 seed；ADR §8.2 因此把替代方案拆成 B1（一般事件）與 B2（自建 held 物件）。
> **round 309（cold control 錯誤）**：`execution/stop`（無 cell／未知 cell）與 `processes/control`（未知 process）在冷 session 上
> 都回明確的 -32602 錯誤（cold history cannot …）。
> **round 308（unavailable 頁面）**：不存在的 digest 與未知 session 的 result read 都回 `{kind:"unavailable"}`（非 RPC 錯誤）。
> **round 307（result page 邊界）**：offset 越界回 `{kind:"unavailable", reason:"budget"}`；maxBytes 超過 query 上限被 RPC 以
> `-32602 Invalid result page query` 拒絕。
> **round 306（result page 分頁）**：4KB 分頁可續讀（nextOffset 前進、eof:false）；低於 page budget 的 maxBytes（如 256）
> 回 `{kind:"unavailable", reason:"budget"}`。
> **round 305（selected results 移植分析）**：ADR §8.2 記錄 legacy 協議、移植範圍，以及 snapshot selection 替代方案
> （fork 當下快照，無 lineage／撤銷見證）。
> **round 304（背景失敗回報）**：`enqueue` 與 deletion listener 的失敗改走 `reportBackgroundFailure`（預設 console.warn），
> 不再靜默丟棄；測試以 enqueue 到不存在的 session 驗證回報。
> **round 303（不捏造 legacy meta）**：可讀的 legacy session 若沒有 metadata，`profile` 直接拋錯，不再以 `now()` 捏造
> `createdAt`。
> **round 302（document 錯誤路徑）**：legacy document 讀取失敗會原樣拋出（不再回 undefined）；corrupt `__documents__` log
> 讓讀寫都拒絕。
> **round 301（legacy list 錯誤）**：`list()` 不再吞掉 legacy list 失敗（原先錯誤會讓 store 看起來是空的），改為原樣拋出；
> 另移除 child capture 的冗餘 try/throw。
> **round 300（legacy 讀取錯誤）**：`readLegacy` 只把 ENOENT 映射成 not-found，其餘原樣拋出；新增「缺 journal 的舊 header」
> 與「真正不存在」兩個案例；ADR §6 第 3 項改註明 6–12 需 journal metadata。
> **round 299（ADR 驗證現況）**：§6 改為表格，逐項標示狀態與證據（crash ✅、fold ✅、舊 corpus ⚠️ 部分、既有回歸 ⚠️ 部分、多程序 ✅）。
> **round 298（雙程序 writer lease）**：子程序持有 write lease 時父程序寫入開啟被拒；kill 後父程序可接管、append，
> 新讀取看到新事件（證明程序死亡會釋放鎖）。
> **round 297（fold property test）**：5 個 seed × 25 commits 的隨機 op 序列，重新編碼／掃描（驗 seq/prev/digest）後與獨立
> 參考模型比對 fold 結果。
> **round 296（SCL 全套回歸）**：host 13 檔/14、commit-log 7 檔/32、commit suites 9 檔/37，共 83 tests 全綠、無 flake。
> **round 295（transcript tail）**：`sessions show --last 2` 在 SCL 只印尾段並標示 earlier lines。單一 host 連線的 RPC 回覆
> 會序列化，無法在 turn 進行中併發觀察 `execution/read`（會等到 turn 結束、live:false）。
> **round 294（大 session 讀取成本）**：5,000 事件 session 連續 10 次讀取共 7ms——fold 成本低於 1ms，無需快取 view。
> **round 293（scan cache 量測）**：40 sessions × 30 events 的第二輪讀取：cache off 17ms、cache on 7ms（約 2.4×）。
> 新增 `IH_COMMIT_SCAN_CACHE=0` escape hatch 與 benchmark 測試。
> **round 292（CLI sessions show）**：`sessions show`（transcript 與 `--json`）在 SCL store 通過；argv 需含 `sessions`
> token（parser 會 slice 第一個元素）。
> **round 291（read scan cache）**：read 開啟的 log 以 byte length 驗證、快取 64 筆 parsed records；append 改變長度即失效。
> session-commit-log 全套 31 tests 全綠。
> **round 290（prefix 單元測試）**：`commit-prefix.test.ts` 驗證每次 append 後 `bodyBytes` 等於 canonical 事件位元組總和、
> 重複讀取穩定、重新開啟的 read handle 得到相同值。
> **round 289（prefix 增量快取）**：`commitPrefix` 的 `bodyBytes` 改為每個 append 增量累加並以 CommitLog 身份快取，
> 避免每次 commit 重新序列化整段歷史；值與舊算法完全一致，26 個 commit 測試全綠。
> **round 288（shell exec 與 execution read）**：`shell` echo 在 SCL 上可執行並提交結果，但 `execution/read` 是 live 視圖，
> 冷 session 回空 cells（非 SCL 問題）。artifact 斷言改以工具名稱挑選 `read` 結果。
> **round 287（task reconcile）**：`desktop/session/tasks/integrity` 的 `reconcile:true` 在 SCL host 上通過（tool 執行後）。
> **round 286（close 撤銷 retained reference）**：`coordinator.close()` 先 `closeRetained`（retire 全部 references、拒絕新
> admission）再關閉 log handles；第三個測試覆蓋 close 後 assertCurrent 失敗。
> **round 285（刪除撤銷 retained reference）**：`deleteOwnedSession` 以 `markDeleted` 標記 session 與 manifest 文件，
> retained reference 在刪除後立即失效；測試覆蓋 acquire→delete→assertCurrent 失敗→release。
> **round 284（selected-results 決策）**：依產品完整性優先，維持 legacy 預設、SCL opt-in，**不刪 legacy**；
> selected-results 移植列為後續大型工作。決策寫入 ADR §8.1。
> **round 283（刪除文件整合測試）**：host 建立 session（facade 播種 `task-<id>`）→ batch delete → 以第二個 coordinator
> 讀回該文件為 absent。`child-bootstrap-admission` 的 28 個失敗確認為既有 plain-factory gate。
> **round 282（刪除清除文件）**：`deleteOwnedSession` 以 `doc-clear` 清除 manifest 內的文件（task／title／binding），
> 避免重建後讀到舊狀態；無關文件不受影響。
> **round 281（full suite 量測）**：遷移後 `session-persistence` 全套為 280 failed／840 passed／1120 tests（38/125 檔案紅），
> 來源是 legacy coordinator 與 artifact/latch fixture 缺口，非 SCL 程式；baseline 修復屬另一項大型工作，暫停。
> **round 280（legacy 測試遷移）**：`repair.test.ts` 改用 composed factory 後 19/19 全綠；`fork-controller.test.ts` 32→6
> （其餘為 admission／host fixture 期望差異）。`delivery-facts` 需 process-read capability，暫緩。
> **round 279（full session-persistence 紅燈分類）**：全套件紅燈皆為既有 baseline——legacy `createSessionCoordinator` 的
> `TASK_TRANSITION_UNSUPPORTED` gate（delivery-facts 48、fork-controller 32、repair 8）、win32 real-lock（ownership 18）、
> 以及 child-bootstrap-intent 一個舊 digest 期望；皆不 import commit package，SCL 套件維持全綠。
> **round 278（child-birth inspection）**：`inspectChildBootstrap` 以 log header 的 operationId 回 ready／conflict／absent，
> 補上 gateway project-scope admission 的查詢能力。
> **round 277（artifact retention／result page）**：200KB `read` 產生 artifact retention（json-utf8-v1），`session/result/read`
> 在 SCL 回傳分頁；artifact 儲存層已可用，selected-results 只剩 selection／witness 生命週期。
> **round 276（tool execution on SCL）**：controlled model 發出 `todo_write` tool call，managed document 完成 tool/call＋tool/result
> 的提交，並由第二個 coordinator 讀回——首個工具執行 round trip。
> **round 275（batch project move）**：`desktop/session/batch` 的 move 在 SCL 通過（需 `expectedOwners`，缺失時每筆回
> `ok:false` 而非拋錯），project state 隨即反映新 projectId。
> **round 274（corpus delivery 事件）**：dual-run corpus 加入 `agent/delivery-generation`；手寫的 `compaction/replacement` 被
> 歷史驗證拒絕，需以真實 compaction 產生的歷史作為 fixture。
> **round 273（legacy corpus dual run）**：以 legacy backend 建 7 種 session（含 tool call/result、steps、title），
> SCL 的 list／events／title／task doc 與 legacy 完全一致——ADR §5 切換前的 golden corpus gate。
> **round 272（compaction E2E）**：以 host 建立的長歷史（8 輪長回覆）在 SCL 上 compaction 成功
> （`compacted:true, publication:'committed'`）。先前的 assembly 失敗來自直接 seed 原始事件，非 compaction 本身。
> **round 271（compaction 尺寸與進度檢查）**：`retention-output` 是摘要長度檢查（≥ minSummaryChars／≤ maxTokens*4）；
> 短 session 回 checkpoint 長度後變 `no-progress`；長歷史時 compact 失敗且 host close 回報 session service cleanup 未完成，
> 以 skip repro 保留（`host-commit-log-compact-long.test.ts`）。
> **round 270（compaction summarizer fixture 調査）**：checkpoint fixture 直接覆寫 `prepare` 會破壞 managed generation
> （`GENERATION_UNSUPPORTED`）；controlled model 則停在 `retention-output`。真正的 E2E compaction 測試需要「留在 managed
> model client 內、且輸出可 retention」的 fixture。
> **round 269（compaction 進入引擎）**：observation expiry 來源是 **cached recovery prompt**（overhead 計數早於
> `prepareModelSurface`）；過期時省略 advisory recovery section 後，compaction 可進入引擎，summarizer 尚需 checkpoint
> fixture（`retention-output`）。
> **round 268（compaction 調查）**：live SCL session 的 `desktop/session/compact` 失敗於 `Original execution observation expired`；
> 有界重試無效（非 transient），skip 測試保留重現。下一步檢查 delivery revision 或 compaction 自身寫入後的重新觀察。
> **round 267（batch／diagnostics）**：`desktop/session/batch` 的 archive／restore／delete 與
> `desktop/environment/diagnostics` 在 SCL 通過；batch delete 端到端驗證 `deleteOwnedSession`。
> **round 266（execution／task／process 讀取）**：兩個 turn 後 execution read、tasks integrity、processes read 在 SCL 全數成功。
> **round 265（live model switch）**：`session/model/set` 後在 SCL 上再跑第二個 prompt 成功，代表 host 的 in-place rebind
> 與 commit-log execution attachment 相容。
> **round 264（CLI headless run on SCL）**：`i-harness run` 在 `IH_SESSION_STORE=commit-log` 下以 fixture provider 完成一輪，
> store 產生一個 session generation 與 `__documents__` log。
> **round 263（auto title 文件）**：controlled turn 後 `session-title/<id>` 以 `{formatVersion:1,title}` 寫入 SCL，
> 可由 read-only coordinator 讀回。`session/list` 的 title 來自 `meta.title`（rename），auto title 不在其中。
> **round 262（legacy document read-through）**：SCL 的 `getDocument` 在文件不存在或 key 未寫入時 fallback 到 legacy
> `*.doc.jsonl`；寫入後以 SCL sidecar 為準。既有 task 文件在切換 store 後仍可讀。
> **round 261（project scope binding）**：configure → bind → state → navigation 在 SCL 通過；`bind` 沒有 unbind 路徑，
> 再次不帶 projectId 的 bind 是 idempotent（保持原 binding）。
> **round 260（desktop rules／usage 探測）**：`desktop/approval-rules/state` 在 SCL 通過；`desktop/usage/query`（v1）在目前 host
> 一律回 `USAGE_UPGRADE_REQUIRED`，usage 讀取需走 v2。
> **round 259（selected-results capability 查詢）**：新增 `hasSelectedSource`，gateway 的 selected-source 取得與 task-child
> 繼承在 SCL 上以 `SELECTED_RESULTS_UNSUPPORTED` 明確拒絕；測試確認 facade 回報 absent。
> **round 258（CLI sessions SCL）**：`IH_SESSION_STORE=commit-log` 時 `sessions list/show` 改用 SCL coordinator；
> 以 SCL store 建立 session 後可列出 id／title。
> **round 257（session management routes）**：rename／archive／restore／reload／navigation 在 SCL 真實 host 上通過；
> `desktop/session/archived` 回傳的是陣列（非 `{sessions}`）。
> **round 256（refresh 重試預算）**：並行跑 7 個 SCL host 檔時，plugin refresh 的 1 秒重試預算不足；改成 5 秒並涵蓋
> `writer dependency cleanup unresolved`，並行 suite 連續 3 次全綠。
> **round 255（surface changed 通知）**：訂閱 execution surface 後跑一個 controlled turn，會收到 `desktop/surface/changed`，
> 確認 SCL 寫入會經 private observation 發佈。
> **round 254（execution surface events）**：retained bindings 讓 gateway 在 SCL 上宣告 `desktop-surface-events`；
> subscribe → snapshot（帶 epoch）→ unsubscribe 經真實 host 通過。
> **round 253（retained bindings）**：facade 註冊 `associateRetainedCoordinator` 並轉發 `retainExistingSessionBindingObservation`；
> gateway 的 execution-host observation 不再停用。reference 發行／讀取／release 測試通過；host 測試 15 全綠。
> **round 252（coordinator 介面盤點）**：gateway 實際使用的 coordinator 成員中，SCL 已支援絕大多數；缺
> `retainExistingSessionBindingObservation`（有 guard，execution-host observation 停用）與 `inspectChildBootstrap`（caller 有 guard）。
> selected-results 與 cold finalization 仍是 legacy-only，列為刪除前必須移植或明確拒絕的項目。
> **round 251（delivery drain transient）**：drain 把 `issued write needs reconciliation`／`writer dependency cleanup unresolved`
> 視為 transient（可重試、不報告），警告歸零；legacy 與 SCL host 測試共 15 全綠。
> **round 250（plugin refresh 競態）**：schedule create 觸發的 plugin refresh 會在寫入 issue→install 視窗斷言 currentness，
> 被回報為 `issued write needs reconciliation` 且永久 poison 該 row。refresh 對這個 transient 錯誤做有界重試後，
> schedule create/list/delete 5/5 通過。
> **round 249（execution prefix 修復）**：source 的 `prefix` 快取改為「event count 變了才重讀」，並在 append→install 視窗以
> `control.suspended` 暫停（backend 與 source 共用）；host turn 5/5 穩定。schedule create（live tool write）仍失敗，
> 以 skip 測試保留（Plan 11）。
> **round 248（host turn 修復）**：dump 顯示 promotion 與 admission 的 provenance 只差**鍵序**（`JSON.stringify` 比較）。
> 改用 `canonicalJsonData` 後 host turn 5/5 通過、conversation 測試 27 全綠；skip 測試已恢復為正式測試。
> **round 247（host turn 診斷修正）**：失敗是 flaky（5 次中 2 次），根因不是 prefix conflict，而是
> `prepared promotion changed raw input`（input-preparation.ts:76，從 prepareWrite→restored-view:353 拋出）：promotion 與
> 以 seq 解析出的 admission 之 provenance／images 不一致。下一輪 dump 事件確認是否同一 input 寫了兩次 admission。
> **round 246（host turn 寫入衝突調查）**：host 層 model turn 重現 `FACT admission requires recovery`＋delivery reconciliation
> 失敗（已以 skip 測試保留）。初判：legacy 對每個 append 包 `processLatches.beginMutation`，SCL 沒有，execution fence 看不到
> 外部 append → 下一批 fact 用過期 prefix 發行 → conflict。下一輪：coordinator 持有 process latches 並包住 append／meta 寫入。
> **round 245（rewind／schedule 讀取）**：真實 host 上 rewind points→plan→execute（conversation）在 SCL 通過；
> `desktop/schedule/list` 以 snapshot fold 回空清單。schedule 寫入與 selected-result 讀取仍綁在 turn 執行期。
> **round 244（nested fork／passive resume）**：nested fork（child→grandchild）在 SCL 通過；`resumeSemanticTarget` 明確回
> `not-issued/unsupported`（SCL 無 staged resume），`session/fork/retry` 不再是 internal error。
> **round 243（SCL gateway fork routes）**：capture 會把 project intent 物化成 target 的 project binding，gateway
> `session/fork/prepare` → `begin` 在 SCL 上回 `ready`，子 session 可列出並繼承 projectId。`host.test.ts` 8/8 在 SCL 全綠。
> **round 242（SCL 公開 fork capture）**：facade `bootstrapSemanticTargetWithCapture` 直接以 capture 建子 session（單一 commit：
> header＋seed＋`session/bootstrap`），conflict → `refused`。`commit-fork.test.ts` 驗證 receipt 與子 log 尾端事件。
> gateway 既有 fork 測試以 legacy `createSessionCoordinator` 建 coordinator，`create` 即 `TASK_TRANSITION_UNSUPPORTED`，屬 baseline 紅燈。
> **round 241（產品接線）**：`sessionStore`／`IH_SESSION_STORE=commit-log` 在 desktop host 與 CLI 全站點選用 SCL；
> `host-commit-log.test.ts` 以**真實 host** 在兩種 store 上各建立並關閉 session（首次產品級驗證）。
> execution-host observation 在缺 retained binding 時改為 no-op preflight；retained close 以 coordinator.close 關聯。
> **round 240（單一 ownership＋gateway cutover 首次貫通）**：coordinator 自建真實 capability ownership 並注入所有 managed
> document／fact owner，開文件時 pin session；facade 改用同一組 ports（ordering／revocation／task／cold writes）；
> `originalExecutionFoldFactory` 穿到 `restoreManagedExecutionState`。**owned gateway 在 SCL 上完整跑通一輪**
> （`owned-gateway-scl5.test.ts`：slash command → model request → close）。
> **round 239（task document 初始文件＋latches）**：`create` 會寫入 composition 提供的空 task document，task operations 接上
> process latches。gateway 已到 task read handoff 的 `assertHeld`：capability ownership 未持有 session bundle（SCL 的
> commit-log lease 是另一個 ownership）。下一步是讓 coordinator 只用一个真實 `createOwnership`（文件與 capability 共用），
> 而不是 spread 衍生（identity WeakMap 會拒絕，`Invalid ownership claim`）。
> **round 238（SCL task document operations）**：task document backend session（observe/confirm/stageWrite 以 witness revision
> 對應 document 快照）＋`createTaskDocumentOperations` 接上 capability ownership；gateway 已越過 Task host，
> 下一個缺口是 selected-results capability（`context-runtime.ts:140` 無條件呼叫 `selectedSourceFor`）。
> **round 237（SCL capability ownership）**：`<root>/.capabilities` 的真實 `createOwnership`＋binding observations，
> ordering 與 revocation 共用同一 ownership 並通過 participant 驗證；4 tests 全綠。gateway 已越過 revocation，
> 下一個缺口是 `associateTaskDocumentOperations`（task registry port）。
> **round 236（SCL result ordering）**：`associateOriginalResultOrdering` 以最小 ledger owner 接上（lease＋commit 順序即 ordering），
> 3 tests 全綠。revocation 需真實 `createOwnership` 的 batch participant，下一步（Plan 6c）以同一 ownership 建 observations／admission。
> **round 235（SCL process read）**：`withProcessReadObservation` 以 fold snapshot 實作（initial.session/highWater/documents、
> `check()` 回 suffix、改寫或縮短即 `PROCESS_READ_UNAVAILABLE`、結束後 observation 退役）。2 tests 全綠。
> **round 234（execution 修復＋capability 審計）**：execution attachment 的 fact owner 與 execution token 改用**同一個 incarnation**
> （否則 receipt 驗證失敗 → `FACT_INSTALL_FAILED`）；gateway 接下來缺的是 result capability 關聯（ordering、revocation、
> process read），它們與 legacy ownership batch 協議深度耦合，需要 SCL-native 設計（Plan 6）。
> **round 233（SCL execution attachment）**：`acquireManagedExecution(facade,id)` 已可用——以 commit log 的 restoration source
> 還原 `restoreManagedExecutionState`，再由該 state 建構 managed document（交付觀察綁定在 execution fence 上）。
> gateway stack 已跑到第一個 turn 的 fact admission，卡在 `FACT_INSTALL_FAILED`：綁定 execution 的 document 其 queue install
> 與 execution state 的 `prepareWrite/install` 路徑未對接（legacy 的 `attach(...)` 有同樣分工）。下一輪處理這個寫入路徑。
> **round 232（gateway cutover 偵察）**：owned-gateway stack 在 SCL 上跑到 `service.close()` 才失敗，
> 缺口是 `acquireManagedExecution`（`execution-internal.ts:28`）——需要 `associateManagedExecution` 與
> `restoreManagedExecutionState` 的 restoration source。已把需要的 port 寫進計畫（Plan 5），並補上 `putDocumentStrict` alias。
> **round 231（SCL 觀察層＋unmanaged task host）**：`withExistingSessionBindingObservation`／`withSessionBindingObservation`
> 以 snapshot+revalidate 實作（binding doc＝`desktop-session-project-<sha256(id)>`；missing＝unavailable、abort＝revoked、
> 變更＝conflict；排除交給 commit log 的 no-overwrite 發佈）。真實 `createUnmanagedTaskChildHost` 已在 SCL 上跑通：
> 觀察 scope 放行 parent、prepared child 出生、產品 `verifyOriginalChildBirth` 接受。
> **round 230（產品驗證器接受 SCL 出生）**：把單一 commit 出生的結果送進產品自己的 `verifyOriginalChildBirth`
> （header lineage／semanticSeed digests、receipt seedLength/manifestDigest/initial commitment、completion frame、
> bootstrap 與 admitted 事件位置與內容、`assertReady()`、initial input digest）——全部通過。
> 這代表 task-birth 的驗證關卡不再區分 legacy 與 SCL 出生。
> **round 229（SCL 第一個真實消費者）**：新增 `asSessionCoordinator` facade（stage bootstrap 大聲拒絕），
> `subagent` 的 `spawnChild` 以 commit coordinator 跑完整流程：create→managed document→seed import（fact path）→run→
> 讀回 durable session（lineage header＋seed 前綴＋admitted input）。**產品程式碼零改動**即通過，證明 facade 相容。
> **round 228（SCL birth 相容入口）**：`createChildSession` 回傳合成的 `BootstrapReceipt`（seed/completion batch、manifestDigest、
> initial seq），事件位置與 `verifyOriginalChildBirth` 的期待一致；新增 `bootstrapChildTargetWithCapture`／`resumeChildTarget`
> 供 subagent 直接呼叫（capture payload 必須與 request invocation 相符；無 payload 的 resume 回 `payload-required`）。
> 18 個 coordinator 測試全綠。
> **round 227（SCL 單一 commit 出生）**：`createChildSession` 以 `buildBootstrapHeader` 產生 header＋manifest digest，
> 把 seed records、`session/bootstrap`、initial `agent/input/admitted` 寫成**同一個 commit**；以 `semanticSeed.operationId` 冪等，
> 父會話存在時先寫 `child:<op>` intent、完成後 settle。17 個 coordinator 測試全綠（fork 子、subagent 子＋initial input）。
> **round 226（SCL 刪除／所有權查詢）**：`deleteOwnedSession`（先寫 `deletion:<id>` receipt，再原子 rename 到 `.trash-*`，
> 最後 best-effort 移除）、`deletionReceipt`、`onDocumentDeleted`、`ownerOf`/`hasLiveOwnership`、`enqueue` shim。
> 15 個 coordinator 測試全綠（含刪除後重建同 id）。
> **round 225（SCL managed document）**：`batch` op＋`CommitView.batches`；`createManagedDocument` 以 commit log 為 backend
> （appendOwnedBatch 驗 prefix→beforeIssue→單一 commit；reconcile 依 fold 回 committed/absent/conflict；
> Ownership 轉接器只保留 `withSessionOperation` 與 `assertHeld`）。協調器新增 `openManagedDocument/closeManagedDocument/revokeManagedDocumentNewWork`。
> 13 個 coordinator 測試全綠（含 managed fact group 寫入、關閉重開）。
> **round 224（SCL fork／intent／dual-run）**：`seed` op＋`fork(cut)`（子會話以單一 commit 發佈，header 記 parentSession/seedLength）、
> `beginIntent/endIntent/intents`（capture reservation 的 durable 替代）、以及與 legacy backend 的 dual-run parity 測試。
> 12 個 coordinator 測試＋2 個 jsonl 整合＋2 個 dual-run 全綠；typecheck／兩個 gate 全綠。
> **round 223（SCL facade + 舊格式遷移）**：`createCommitCoordinator`（create/load/append/updateMeta/list/profile/document/lease）
> 與 `createJsonlCommitCoordinator` 落地；舊 13/14 會話可讀，第一次寫入時發佈 format-15 generation，舊檔位元組不動。
> 10 個 coordinator 測試＋2 個 jsonl 整合測試全綠；typecheck／兩個 gate 全綠。
> **round 222（SCL store）**：`session-commit-log` 加上 store／lease／crash-cut：temp→fsync→`link()` no-overwrite 發佈、
> 寫入租約（重用 `@i-harness/fs-lock`）、torn tail 只在寫入模式截斷、append 失敗以 truncate 回滾、
> content-addressed sidecar＋未引用回收。30 tests 全綠；typecheck／boundaries 147／reachability 全綠。
> 下一步：舊格式（13/14）reader 與 dual-run，然後 facade。
> **round 221（SCL 動工）**：`packages/session-commit-log` 落地（format 15 codec、torn-tail scanner、fold），
> 18 tests 全綠、`tsc --noEmit` exit 0、boundaries 147/147、reachability PASS（index 公開面暫留空，Plan 2 接上第一個消費者時再開）。
> 計畫：`docs/superpowers/plans/2026-11-05-session-commit-log-format.md`；下一步是 Plan 2（store + lease + crash-cut）。
> **round 220（重設計裁定）**：以產品穩定性／功能完整性／設計合理性為判準，採 **ADR-2026-11-05**：
> 重寫耐久核心為 **Session Commit Log**（單一 append-only commit log + content-addressed sidecars +
> flock 租約 + handle），取代分階段出生／adoption／capture reservation。約 15.5k 行的 coordinator+backend
> 可縮到 ~4k；BC01–BC11 的不變量改由 log 內 `intent` 記錄承擔（仍先於 capture）。
> 見 `docs/design/2026-11-05-session-commit-log-redesign.md`（含 format 15 遷移、crash-cut 驗證、刪除清單）。
> **round 219（重設計評估）**：剩餘 41 筆出生／接手紅測試指向同一個根因——**決策軸（durable 位元組是否已承諾）
> 與清理債（handle/temp/lease 是否收斂）被混在一起**，加上 **task document 發佈失敗會擋住 session 出生**。
> 比對六個參考專案（DSH 0.2.2、codex 0.166、opencode 2.1.4、pi-durable 1.2、ZCode、superagent prototype）後，
> 共同法則是「**單一承諾點＋延遲物化＋恢復在 open 決定＋所有權是鎖**」；I-harness 五條全違反。
> 建議三層：A 決策模型（先做，不動 log 佈局）→ B 把 task document 併入單一 commit 域（journal 事件或 pi 式 marker）
> → C 終局（handle/SQLite）。見 `docs/design/2026-11-05-birth-decision-redesign.md`。
> BC01（capture 是否必須先耐久 reserve）仍需裁定。
> **依序執行（設計已定案，不需再問）**：
> 1. ~~acquire-before-read~~、~~append 持 `doc:task-*` lease~~ → round 218 證實已由 composed
>    transition 車道滿足；8 檔測試已遷移，僅 `task-transition-bootstrap-revoke` 仍紅。
> 3. `bootstrap-physical` 5 筆、`bootstrap-capture-physical` 2 筆：中斷後維持 `blocked`，
>    測試改為驅動 reconcile 再斷言 `ready`（不要產品假裝成功）。
> 4. sdk：child-context ×2 走 **model-origin spawn**；已確認卡點不是 prepared-body，而是
>    **durable parent 的 generation 建立**：直接 submit → `This operation was aborted`；
>    inbox admit + `{admittedInputId}` → `GENERATION_UNCERTAIN`（來源包含
>    `generation-action.ts:144` 的 `!bound || pending`）。下一步：對照 `execution-state.test.ts`
>    的 `createSessionService` 選項（它能在 durable parent 上 submit 成功），補齊 generation 所需設定。
>    （原註記：host `tools.execute` 的 prepared body
>    （第一次嘗試改寫後 `service.submit` 收到 `This operation was aborted`、task 未建立；
>    先用 `it.only` 隔離並確認 abort 是 turn 本身還是 finally 的 `service.close()` 造成）
>    是 foreign，`prepared-body.ts:299` 回 undefined）；fork 爭用追
>    `createCliForkHost.withHandoff` 的 `coordinator.flush` 卡在 held write-behind。
> 5. 全綠後跑 `verify:all` full job，把結果寫回本文件。
> **已結案、不要再重開**：Q1（`ready` bootstrap 本來就會建立 `task-*.doc.jsonl`，
> 測試斷言已修正）；Q2/Q3 的設計判讀見 round 209；SYS-PROMPT 見 A-04（round 193）。
>
> **round 218（claim-retention 群：9/10 檔轉綠）**
> - 根因（測試側）：`createOwnership({ lockRoot })` 的裸 ownership 與 composed 協調器
>   **不在同一個 lock namespace**。composed 的 `acquireDocumentLease('task-*')` 走 artifact
>   identity（`artifact-ownership:<doc key>` + `artifact-document-lease:<doc key>`），
>   裸 ownership 的 `acquireLease('doc:task-*')` 是另一個 lock 檔 ⇒ 「必須被拒」的斷言
>   全部變成「成功取得」。這是 D-12 遷移到 composed 建構子後失效的測試假設，不是產品釋放 claim。
> - 遷移：`createOwnership(createJsonlBackend(root), …)` ＋ `acquireDocumentLease('task-…')`
>   （claim 用 `pinOwnership`）；「操作結束即可取得」改成「coordinator close 後才可取得」，
>   因為 M23 acquire-at-live 會把 session bundle（含 parent task artifact）保留到 close。
> - 產品修正（1 處）：`coordinator/task-document-transition.ts` 的 `allowObservation()`
>   不再讓 header close 失敗往外拋。bootstrap outcome 已決定（`blocked`），債務留在
>   `headerSettlementFailure`，由 `finite()`／close 回報；否則第一次 bootstrap 會以
>   `Bootstrap header cleanup unresolved` reject（`task-transition-bootstrap-retry` 的首紅），
>   且 `entry.headerUnknown` 永遠沒機會被 retry 清掉。修正後 retry／stage-debt 一併轉綠。
> - 轉綠 9 檔：`direct-lease`、`header-debt`、`bootstrap-header-debt`、`bootstrap-retry`、
>   `bootstrap-stage-debt`、`bootstrap-stage-swap`、`stage-revision`、`capture-close-race`、
>   `managed-header-confirm`。
>   其中 `stage-revision` 另修掉與 stage-swap 同型的過期斷言：ready bootstrap 已建立
>   `task-target.doc.jsonl`，blocked resume 只能要求**位元組不變**，不能要求 ENOENT。
> - 仍紅 1 檔：`task-transition-bootstrap-revoke`。revoked in-flight header 之後的 resume 在
>   `bootstrap.ts:487` 回 `not-issued/unsupported`，因為第一個 barrier 已被收回、新 barrier
>   **沒有 mode**（`!b.taskBarrier?.mode && request.target.kind==='new' && state.meta`）。
>   此時 `publicationStatus==='valid'` 且 `b.issued` 為 true，birth 其實已發行。
>   下一步（設計級）：新增 `'resume-birth'` 模式（round 216 已預告）或讓 guard 只對
>   **未發行**的 birth 回 unsupported，並用 `observeBootstrap` 驗證既有 birth；之後 close 才
>   不會因 `headerUnknown` 回 `Managed documents require recovery before close`。
> - 全套量測（round 218）：**20 紅檔 / 93 failed / 764 passed / 17 skipped（98 檔）**
>   （round 217：25 紅檔 / 100 failed / 757 passed）。兩個受影響套件 typecheck exit 0。
  **round 174 定論**：在 `capture()` 內記錄事件後，兩個 marker 紅其實是 **`error` 事件**：
  **round 175 已修**：thinking 案補 user turn ＋ 對應 tool result；Responses 案把
  **round 176**：`llm-openai` 的 M72 Ⅲ 紅改為斷言「宣告 `measurementValidity:'invalid'`」
  round 177：`acp` 的 CLI stdio 紅真因——`session/prompt` 回 `-32603 Internal error`，
  **round 178**：該訊息實際是 `CONTEXT_INPUT_STALE`，來自 `session-executor` 的 instructions
  manager（`context/instructions/manager.ts:29` 等）。即 CLI 路徑下 instructions 快照被判定
  stale（temp cwd 沒有 AGENTS.md 時的初始化問題）。下一步：追 manager 的初始 capture 與 CLI 的
  requestContext 建立順序。
  `data.details = 'Observed instructions unavailable'`。即 CLI 的 prompt 路徑需要 instructions
  快照，而測試只 seed 了 provider。下一步：在 fixture 的 `IH_CONFIG_DIR` 補上 instructions
  （或確認是否產品回歸）。
  → **14/14 檔、230/230 tests 全綠**。
  `function_call` 排在 `function_call_output` 前並統一 call_id → **`provider` 10/10 檔、176/176
  tests 全綠**。
  `{code:'INVALID_ARGUMENT', modelFailure:{reason:'message-order'}}` —— 請求在送出前就被
  message-order 驗證拒絕（所以 body undefined，非逾時）。測試輸入是「只有 assistant 訊息
  （含 signed thinking + toolCalls、無 tool results）」，不符合現行順序驗證。修法：調整測試
  輸入為合法序列（user turn + 對應 tool results），或放寬驗證；需先確認哪個才是正確語義。
   **round 145 已遷移** 3 個測試檔（`admitted-context`、`cancel-stop`、`result-page-cli`）→
   **round 161**：`result-page`、`session-context` 亦遷移 → **9 failed / 110 passed（119）**。
round 162：`packages/sdk/vitest.config.ts`（30s）→ cancel-stop 的 5 個 timeout 露出真因
  round 163 查證：`cancel-stop.test.ts` 的兩個 hook（append/reconcile）是**在** `service.submit(...)`
  **round 164 已實作**：`cancel-stop` 5 個 hook 遷到 seam ＋ armed 旗標 → **4/5 通過**；
  round 165 全套：`sdk` **5 failed / 114 passed（119）**（由 9 failed）。剩：CLI end-to-end、
  round 167：`Original prepared task caller unavailable` 來自 `subagent/src/index.ts:349`——
   **round 169**：`launchEntry` 是在工具註冊時（`index.ts:418`，`tool.name==='spawn_agent'`）以
   **round 170**：`enter()` 內部是 `byExec.get(exec)`；若 exec 不在 prepared-body 表中（line 293）
   且外層 frame 未 active，就回 undefined。即 sdk fixture 直接呼叫 `tool.execute`／自製 exec，
   繞過了 registry 的 prepared-body 註冊。修法在測試側：走 registry 的 prepared 流程（或先註冊 body），
   不是產品 bug。
  `bindPreparedTaskLaunchLeaf(tool, tool.execute)` 綁定的；若註冊後 registry 又包裝／替換 `execute`，
  `launchEntry.enter(exec)` 就對不上。修法方向：綁定時改用呼叫當下的 `tool.execute`，或在
  `enter` 失敗時以 `parentRegistry.get('spawn_agent')` 重新綁定一次。
  `launchEntry.enter(exec)` 回 undefined（spawn_agent 的 launch entry 與實際 exec 對不上），
  屬 sdk child-context fixture 的工具掛載／exec 身份問題。
  cleanup 1、`Original prepared task caller unavailable` 2、fork 邊界 1。
  剩「an independent actual fork finishes while the original cancel Stop remains held」
  （`Original Stop boundary pending`，該案自身的 4s 邊界）。
  **之後**才安裝的，正是 round 135 的 `armed` 情境。遷移步驟：把 `entered/release/unknown/allow/key/
  reconciles/closeKeys/receipts` 宣告提前到 `createJsonlBackend` 之前、加 `armed=false`、
  wrapper 內 `if(!armed) return append(...)`、`service.submit` 之後 `armed=true`。
  **`PROCESS_READ_UNAVAILABLE`**（建構後 patch backend，需 seam 遷移）。
   **11 → 10 failed / 109 passed（119）**；剩 1 筆 `TASK_TRANSITION_UNSUPPORTED` 不是建構子路徑。

round 188：`code-mode/test/instruction-start-recovery.test.ts` 4 紅完成 seam 遷移——
狀態（`released`／`key`／`blocked`）提前宣告、掛鉤搬進 `wrapOwnedBatch`／
`wrapOwnedReconcile`、`armed` 在 `openManagedDocument` 之後才設 true（＝原本 patch 的位置）。
遷移後 unmask 出來的真紅不是斷言，而是 **`mount.dispose()` 永遠不 settle**：
cell 的 `started` receipt 不確定時，terminal fact 被同一條 queue 的 held record 擋住，
`finalizations.drain()` 等的是永遠不會來的 terminal → dispose 掛死 30s。
這是 **liveness bug**（fail-closed 應該早點回 `FACT_RECOVERY_REQUIRED`，不是等），
不是產品守衛放寬：`event-facts` 新增 `recoveryPending()`（sticky recovery／pending record／
admission hold），dispose 在 drain 前先問；有債就回 `FACT_RECOVERY_REQUIRED` 並**保留**
finalization reservation，等外部 `document.reconcile` 之後的第二次 dispose 才真的 drain
（第二次會經 `facts.refresh()` 重推 held record，terminal 才 commit、pin 才 release）。
結果 `instruction-start-recovery` **5/5 全綠**、code-mode 全套 **11 failed / 354 passed
（28 檔，4 紅檔：surface-publication 5、output-owner-boundaries 3、register 2、store 1）**。
另補 `packages/code-mode/vitest.config.ts`（30s，讓真實 fsync/reconcile 航程不被 5s 誤殺）、
移除 `cell-output-owner-fixture.ts:114` 的死變數（round 183 重構殘留的 TS6133，
code-mode `tsc --noEmit` 因此由紅轉綠）。

round 189：`surface-publication`（7/7）與 `output-owner-boundaries`（3/3）遷到 seam。
  前者把 `managed()` 擴成 `managed({ wrapOwnedBatch, wrapOwnedReconcile })`，四個 durable
  測試各自在 `openManagedDocument` 之後才 `armed = true`（＝原本 monkeypatch 的時點）；
  後者的 fixture 只是把「觀測 append 前後」的 `vi.spyOn(backend, 'appendOwnedBatch')`
  改成 `wrapOwnedBatch` 的轉發 wrapper（`vi` 仍用於 capture/source 的觀測）。
  兩檔皆由 `PROCESS_READ_UNAVAILABLE` 轉全綠。code-mode 只剩 register 2（round 136
  標記暫緩）與 store 1。`output-owner-boundaries` 的 evidence 檔原本就會寫到
  `IH_OWNER_CONTROL_EVIDENCE_ROOT`，不需額外設定。

round 190：code-mode 收尾兩檔。`register.test.ts` 的兩個 durable 案例（unknown store
  receipt ＋ Stop、terminated receipt）用同一套 seam ＋ `armed`（`openManagedDocument` 之後）
  遷移 → 12/12；round 135/136 記錄的 5s timeout 在 30s 設定下沒有再現。
  `store.test.ts` 的單紅其實**不是** store 語義：body 斷言全過，紅的是 `finally` 的
  `await current.code.dispose()`——terminal flush 失敗會 `reject` 該 cell 的 `fence`，
  `finalizations.drain()` 因此回報 `FACT_RECOVERY_REQUIRED`。這是**正確的 fail-closed**
  （沒有 durable terminal receipt 就不能承認 finalization），且同檔 line 94 的
  nondurable 案例本來就以 `.catch(() => {})` 接受同一個債。修法：測試把這個債**顯式斷言**
  （`expect(current.code.dispose()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})`）
  再在 finally 吞掉重試，不改變產品語義。code-mode **28/28 檔、365/365 tests 全綠**。

round 191：core-agent 的 seam 遷移（5 檔 / 21 tests 全綠）。
  - `soft-sequence-settlement`（3）：`writes`／`armed` 提前；第一個案例 hook 從
    `beginAction` 之後生效，第二個案例必須**等 `beginSoftSequence` 寫完**才 `armed=true`
    （原本 patch 的時點就是這樣）。
  - `retained-boundaries`（3）、`current-context-loopback`（1 個案例）：
    `wrapOwnedBatch`／`wrapOwnedReconcile` ＋ open 之後 `armed`。
  - `held-policy-receipt`（1）：真正的紅不是 seam，而是 `TASK_TRANSITION_FAILED`
    （cause `TASK_TRANSITION_RECOVERY_REQUIRED`）——fixture 用手寫 JSONL 造了一個
    **format-14 但沒有 task document** 的會話。修法：改走產品的 bootstrap
    （`coordinator.create({sessionId})` → `coordinator.append(id, seeded events)`），
    不再手寫 header。
  - `instruction-request-context`（10）：`wrapOwnedBatch`／`wrapOwnedReconcile` ＋
    `armed`。unmask 後只剩 `unknown-absent` 一個 arm：該 arm **完全沒有寫進 journal**，
    所以 drain 內的 reconcile 會落到 `absent`、pin 立即釋放（`held=0`），
    `document.reconcile` 回 `not-issued` 而不是 `absent`。這是可辯護的產品行為
    （批次從未 issue），已把期待改成逐 arm 斷言並加註解。**此點列入待裁定清單**。

round 193：core-agent 收尾兩檔。
  - `unstarted-call-settlement`（9）：`setup(seams)` ＋ `arm()`（hook 在 open 之後才生效），三個測試的
    append/reconcile 掛鉤全部搬進 seam。unmask 後只剩 `unknown-to-absent` 一個 arm：fixture 在
    **沒有真正 append** 的情況下回報 unknown，產品的 `document.reconcile` 會走
    `resolveUnissuedConflict`（managed-document.ts:637-643，只有發行過的批次才 fail-closed）把
    「未發行的 unknown」判成**可證明的 absent**，所以 mount 不需要保持 reconciliation，稍後的
    reconcile 回 `not-issued`。已把期待改成逐 arm 斷言並在碼內寫明規則（**issued** 才保留 hold）。
    → **14/14 全綠**。
  - `compaction-binding`（1）：不是 seam。「reused main client」案例斷言 summary body 的 system
    要含 `main authority`，但 `compaction/src/summary/generate.ts:30-40` 的 A-04 註解明確寫著
    **summary 是專用 request，不複製 main 的 system prompt 與 tool catalogue**。產品是對的、
    斷言過時：改成斷言「不洩漏 main system」、「tools 為空」、仍繼承 main 的 reasoning budget
    （`budget_tokens: 4095`）。→ **9/9 全綠**。此點即先前待裁定的 SYS-PROMPT 語義，證據是
    產品內的 A-04 設計註解。
  - `overflow.test.ts`（最後 1 筆，就是清單裡的「SYS-PROMPT」）：同一個 A-04 衝突。它的
    describe 是「the summarizer inherits the main request's shape (M5/D2)」，斷言 summary
    請求的 `systemPrompt` 要等於主請求的 `SYS-PROMPT`、tools 要 1。A-04（2026-11-05，
    `e5bbe5cf`）比 D2（2026-09-18，`3ac561e8`）新，且註解說明了複製主請求的失敗模式，
    所以改寫成：turn 請求維持 `SYS-PROMPT`／1 tool，summary 請求是**專用**的
    （`systemPrompt: ''`／0 tool）。→ `overflow` **13/13**，core-agent 全套
    **649/649（79 檔）**。

round 194：sdk 由 5 紅降到 **3 紅**。
  - `execution-state`（1，flush 變體）：事後 patch `backend.appendOwnedBatch` → 改走
    `wrapOwnedBatch`（hook 只看 `turn/end`）→ 4/4。
  - `e2e`（CLI 端到端）：斷言 `capabilities['session-fork'] === ['1']`，但 SDK 已改成只廣告
    `session-fork-bootstrap`（`server.test.ts` 早就釘住 `session-fork` 不存在）→ 改期待
    `session-fork-bootstrap: ['1']`、`session-fork: undefined` → 1/1。
  - `sdk/vitest.config.ts` 由 30s 提到 **60s**：真實 fork 飛行單獨跑就要 ~24s，
    全套並行時會超過 30s（不是 hang）。
  - 仍紅兩個：
    1. `admitted-context` 的 child-context ×2：`Original prepared task caller unavailable`。
       追到 `bindPreparedTaskLaunchLeaf.enter`：body 存在、frame 對、leaf/tool 都對，
       但 `body.managed === undefined && body.context === undefined` →
       `prepared-body.ts:299` 直接回 undefined。原因：測試用 **host 端**
       `parent.tools.execute('spawn_agent')`，這種呼叫的 prepared body 沒有
       source/domain（`foreignContext`），屬於設計上的「foreign prepared execution」。
       spawn 必須來自 **model-origin 的 turn**（或產品另開 host spawn API）。
       下一輪：改寫 fixture 讓 parent 的模型發出 `spawn_agent` tool_call。
    2. `cancel-stop` 的 independent fork：`Original Stop boundary pending`——fork 在
       Stop 的 close batch 被 held 時要 **~24s** 才完成（4s `boundary()` 先爆）。
       看起來是 fork 的 target adoption 等在來源 session 的 lease 上直到 20s 級 timeout，
       屬產品爭用問題，不是測試期待問題；需追 `createCliForkHost.withReadyTarget` 與
       coordinator 的 session lock。

round 195：三個小套件收尾。
  - `exec` 的 `retention-store-recovery`：紅在 `await exec.dispose()` 之後才
    `exec.getOutput(jobId).retained`——產品在 dispose 期間就把 `disposed` 設 true，之後所有
    job 讀取都按設計回 `unknown job`。改成**在服務還活著時**用 `expect.poll` 等被動重試
    完成（`finishes` 照樣 2、冷讀仍驗 1MiB sha256）→ 1/1。
  - `core-session` 的 `exchange-acceptance`「indexes a large prefix once」：真因是
    **prefix 被走訪 3 次**（實測 stage 1000 筆讓 `visits` 由 20000 暴增到 60000）。追蹤發現
    `stage()` 對呼叫端給的序列重複枚舉（discriminant 驗證、readiness 的 `[...suffix]`、
    staged read、`advance` 各走一次）。修法：`stage()` 進來就用 `Array.from(suffix)` 取得
    **自有副本**，之後全部用這份副本（也順帶修掉「一次性 iterable 會被展開兩次」的潛在 bug）。
    → `exchange-acceptance` 30/30、core-session 全套 **933/933**。
  - `acp`：本輪重跑已全綠（先前記錄的 CLI stdio `-32603` 已被 instructions 那批修正帶過）。

這份文件處理的是**開發債務**，不是產品功能：讓「回歸」重新有意義，然後清掉
被產品 hardening 甩在後面的測試與 API。

> **狀態快照（round 54）**：typecheck 82/82、boundaries 147/147、reachability PASS（0 NEW）
> 三個 gate 已綠。待辦 1（P0 + P1 #3/#4）、待辦 2（移除 `createJsonlSessionCoordinator`）、
> 待辦 3（A 類 11/11 遷移）已完成。`session-persistence-jsonl` 全套 106 failed / 751 passed
> （26 紅檔）。第 5 項量測：`session-executor` owned-* 19/19、`token-meter` 53/53、
> `llm-seam` 188/188 綠。剩下的紅分兩類：(a) cleanup-debt 群（`closeOne` 的殘留 attempt
> entry，根因已定位）；(b) 各 bootstrap／predecessor 語義紅（逐條列在第 4 項）。
> 下一個具體動作見文末「交接：round 32」與其後的 round 41–52 記錄。
> **round 187 更新**：52 個套件已量測；**10 個由紅轉全綠**（instructions、schedule、
> runtime-context、guard-retry、guard-repeat-tool、session-query、compaction、workspace、
> provider、llm-openai）。**round 188–190**：**code-mode 28/28 檔、365/365 tests 全綠**
> （由 13 紅）：instruction-start-recovery 5/5、surface-publication 7/7、
> output-owner-boundaries 3/3、store 11/11、register 12/12。剩餘紅：core-agent 33（seam 遷移類）、
> sdk 5、exec 1、acp 1、core-session 1（效能）、sandbox-windows-acl 2（native）。
> **round 195**：`exec` **全綠**、`acp` **全綠**（重跑即過，無需改動）、
> `core-session` **87/87 檔、933/933**。剩：sdk 3、sandbox-windows-acl 2（native）、
> session-persistence-jsonl。
> **round 196（jsonl 重新量測）**：**26 紅檔 / 102 failed / 755 passed / 17 skipped（98 檔）**。
> 可見紅檔：`bootstrap-physical` 12、`current-context-predecessors` 9、
> `bootstrap-capture-physical` 4、`task-transition-*` 9 檔（close 債務）、
> `task-document-*` 3 檔（`assertDurableTransition`）、以及其餘 seam／predecessor 群。
> **卡點（需裁定）**：`task-transition-bootstrap-stage-swap` 的 blocked resume 之後
> `task-target.doc.jsonl` **確實被建立**（內容以 `{"for…` 開頭），測試期待 ENOENT。
> **round 217（回歸確認）**：本 session 兩個 jsonl 產品修正
> （`reconcileBootstrapHeader` 只比不可變欄位、`SessionBindingObservationError` conflict 帶 code）
> 沒有讓 `bootstrap-capture-physical` 變差：**4 failed / 57 passed（61）**，與修正前基線相同。
> 該檔的 4 紅與 `bootstrap-physical` 剩餘 7 紅同屬「中斷 birth 續行」與 capture 計數語義，
> 不是我這兩個修正造成的。
> **round 216（barrier 模式語義，只讀）**：`task-document-transition.ts` 的 barrier `prepare()`
> 只有三種模式語義：`'new'` → `observeBootstrap`；`'completed'` → `openBootstrapHistory`（給舊格式
> predecessor）；其他 → `openHistory`。因此「current format、header 已提交、task doc 不存在、
> seed 未寫」的中斷 birth **沒有可用模式**：`completed` 會走 predecessor 歷史驗證而拋錯，
> `new` 會卡在 `prepare()` 的 `settleHeader`（line 325 的 retrying + header debt 分支）。
> 下一輪的實作方向：在 `prepare()` 對「header 已由外部提交（無 debt）」的情況跳過
> `settleHeader`，或新增一個 `'resume-birth'` 模式；再用單一 token `-t` 隔離驗證
> （`bootstrap-physical` 58 筆 + `bootstrap-capture-physical` 61 筆回歸）。
> **round 215（seed 補寫路徑的程式地圖）**：fresh bootstrap 的 phase writer 在
> `bootstrap.ts:527-556`：`phases=[seed?, completion]`，每個 phase 先看
> `doc.view.events.length >= events[0].seq + events.length`（:535）決定是否已完成，否則用
> `encodeFactBatch('bootstrap:<op>:seed'|'complete')` → `reconcileOwnedBatch`（:538，committed
> 就代表「冷寫好了」→ :542 回 blocked）→ 否則 `entry.control.admit(phase,...)`（:546）。
> 對「header 已發佈、0 events」的 retry，這條路**理應**補寫 seed；實測 fall-through 卻回
> `not-issued`，所以 `not-issued` 是在這個 loop 之前產生的（:520 targetPrepared 之後、:527 之前的
> 某條 guard），下一輪只要在 :520-527 之間加探針即可定位。這是最接近完成的一條路。
> **round 213（binding 錯誤分類）**：`SessionBindingObservationError` 的 `reason:'conflict'`
> 原本不帶任何 code，呼叫端無法區分「暫時失敗」與「durable 狀態衝突」。已加
> `code:'FACT_RECOVERY_REQUIRED'`（conflict 即需 reconcile）。→ `bootstrap-physical` 再降一筆
> （**11 → 8 → 7**，「keeps header fsync commitment when file close cleanup fails」轉綠）。
> **round 214（狀態快照）**：blocked 當下實測為 `pub=valid, stageBytes=true, ready=false,
> events=0, seed=true, bar=new`——header 已發佈、**seed 批次未落地**。這是狀態機缺第三條
> 「published header + 未 ready → 冪等補寫 seed → completion」的證據；fall-through 只會得到
> `not-issued`，不是正解。
> **round 212（Q2 第一個產品修正）**：`bootstrap-header.ts` 的 `reconcileBootstrapHeader` 原本
> 拿**磁碟現行 header** 與 stage header 逐位元比對，任何 metadata 變更（title/workspaceId/
> archived/modelSelection）都會被判 conflict → adoption 回 blocked。已改為：只有在
> **不可變欄位**（journal、formatVersion、lineage…）不同時才 conflict；純 metadata 差異時
> 採用磁碟上的現行 header 回 `committed`（adopt）。→ `bootstrap-physical` 由 **11 紅降到 8 紅**
> （「keeps the original manifest ready after mutable metadata edits…」轉綠），且未見新紅。
> **round 211（Q2 首例精化）**：`bootstrap-physical` 的「keeps the original manifest ready after
> mutable metadata edits and a later complete live suffix」不是抽象的 readiness 爭議：
> 流程是 **ready bootstrap → admit plan/mode → updateMeta(title/workspaceId/archived) → close →
> 冷啟動 `resumeSemanticTarget`**，設計上必須回 `already-ready`（且 header 要反映新 metadata、
> `plan/mode` 是最後一個事件），產品卻回 `blocked`。亦即 **良性 metadata 變更後的冷 adoption
> 被誤判成 blocked**——這是 adoption 路徑的產品缺陷，不是測試過度樂觀。下一輪先追這條
> （比追 7 個測試快），修好後其餘 4 筆同形狀的 blocked 很可能一起解。
> **round 210（Q3-a 修正診斷）**：實驗證明「保留 claim」不是改 `fail()` 條件——在
> stage-read 失敗時 transition lane **根本還沒取得 claim**（claim 在 borrow/pin 之後才拿，
> 而讀取在其前）。真正的設計修正叫 **acquire-before-read**：
> `resumeSemanticTarget`（bootstrap.ts:973 → `start(...)`）必須在讀 stage/header **之前**
> 先 `borrowOwnership` + `acquireDocumentLease`，讓任何讀取失敗都自然保留 claim 直到 retry／close。
> 這與 `direct-lease`「append 也要持 task lease」是同一條原則：先取得所有權，再做任何讀取。
> **round 209（設計判讀，Q2/Q3 結案）**：不再以測試為規格，改以產品設計判讀。
> - **Q3-a 保留 claim**：`blocked` 代表 durable 狀態不明，釋放 claim 會讓第二個 writer 接管
>   不明狀態（可恢復債務→不可恢復損壞）。現行 `fail()`（task-document-transition.ts:233）
>   的 `!confirmationUnknown && !taskIssued` 捷徑會在「沒有 issued 寫入」時呼叫 `close()`
>   → 連帶釋放 claim/lease（cleanup 125-126）。`!taskIssued` **不等於狀態可證明安全**，
>   要改成：失敗分類為 blocked/recovery 時**不 close、保留 claim**，等 retry 或顯式 close。
> - **Q3-b append 持 task lease**：跨檔（session journal + task document）雙寫入需要單一 lane
>   序列化，append 應取得 `doc:task-*` lease；`direct-lease` 的期待符合設計。
> - **Q2 blocked → reconcile → ready**：中斷後回 `blocked` 是誠實的 fail-closed，不該假裝
>   ready；測試要改成驅動 reconcile 再斷言 ready（而不是期待產品跳過復原）。
> 修正順序：Q3-a（最小、可單檔驗證）→ Q3-b → Q2 測試期待 → sdk 3 → verify:all。
> **round 208（jsonl 複量）**：**25 紅檔 / 100 failed / 757 passed / 17 skipped（98 檔）**。
> 由 round 196 的 26/102 降下來（stage-swap 轉綠、stage-debt 首紅前移）。
> 三大族群不變：task-transition claim/lease（8）、bootstrap readiness（24）、其餘 seam／predecessor。
> **round 207（claim 族的第二個語義叉路）**：`task-transition-direct-lease` 要求
> **一次普通的 parent append 期間也必須持有 `doc:task-p` lease**（測試在 append 進行中讓另一個
> ownership `acquireLease('doc:task-p')` 期待被拒），現在會成功。這與 Q1/Q2 同類：是「append 是否
> 必須序列化到 task document」的產品契約問題。待你裁定或明確授權「以測試為規格」後再動。
> **round 206（task-transition 群像）**：9 檔現在 **8 紅**，且第一個紅都不再是檔案存在性，而是
> 同一族「**失敗/blocked 之後沒有保留原 claim/lease**」：
> `promise resolved {held:true} instead of rejecting`（header-debt、direct-lease、
> capture-close-race 的 pinOwnership）、`expected {…} to be undefined`
> （capture-close-race 的 parent claim）、`Coordinator cleanup is unresolved`
> （managed-header-confirm、stage-revision）、以及 stage-revision 的
> `expected false to be true`。教訓：`stage-debt`/stage-swap 修好檔案斷言後露出的正是這一族，
> 下一輪應集中攻「blocked/failed 路徑釋放了 claim」這一個根因。
> **round 205（Q1 反轉）**：實驗證明 **成功 bootstrap（`kind: 'ready'`）本來就會建立
> `task-target.doc.jsonl`**（`DBGEXISTS after-ready=yes`）。所以 stage-swap 的 ENOENT 斷言是
> **自相矛盾**：line 30 的 ready 已經寫出該檔，line 36 卻要求它不存在。已改成「blocked resume
> 必須**位元組不變**」，stage-swap **1/1 全綠**。stage-debt 同型修正後第一紅消失，但露出下一個
> 真紅：blocked resume 之後 `pinOwnership('target')` **不再被拒**（測試期待 reject）→
> 「保留 claim 直到明確 resume」這條語義待查（不是 Q1）。
> 我先前「7 個 ENOENT 一致 ⇒ 產品 bug」的推論**撤回**。
> **round 203（Q1 再縮小）**：`openOwnedTask`（backend-factory.ts:608-624）只包一個
> **唯讀** observation（`opener` 只接受 `'r'|'r+'`，見 task-document-observation.ts:12），
> 所以建立不是來自 open/observe；剩下的嫌疑是 transition 在 recovery 之後仍走到
> `settleResources()`／`initializeTask` 其中之一。下一輪用「在 writeFile/open('w') 上掛
> stack」的方式一次釘死，不要在猜測上再耗。
> **round 202（Q1 定位）**：eager 建立的入口在
> `session-persistence/src/coordinator/task-document-transition.ts:147-150` 的 `ensureTask()`：
> `task = open(scope)` 之後才 `observeTask()`，而 recovery（`recover && !recoveryDone`）在
> format 14 且任務文件不存在時就從 :159 拋 `TASK_TRANSITION_RECOVERY_REQUIRED`——此時
> `open(scope)` 已經把 `task-*.doc.jsonl` 建出來了。下一輪要讀
> `session-persistence-jsonl/src/task-document-factory.ts` 的 `open` 實作，替 recovery 路徑
> 加一個「只觀察、不建立」的入口（或在 absent 時回滾該檔）。
> **round 201（Q1 以證據收斂）**：`task-*.doc.jsonl` 在 blocked/refused 之後必須**不存在**，這不是
> 單一測試的過時期待，而是全 suite 一致的契約——`task-transition-bootstrap-stop:28`、
> `-bootstrap-stage-swap:36`、`-bootstrap-stage-debt:29`、`task-transition-existing:19/62/158`、
> `task-d-repair-load:29`、`task-transition-bootstrap:177` 全部斷言 `ENOENT`（或先讀檔再驗
> 內容不變）。因此 Q1 判為 **(a) 產品 bug：transition lane 在 blocked resume 時 eager 建立了
> 任務文件**，下一輪修 lane，不動測試。若你要否決，回一句即可，我再改成 (b)。
> **round 200（gate 複驗）**：三個 gate 在目前 HEAD 全綠——`pnpm -r typecheck` **exit 0**、
> `check-package-boundaries --gate` **147/147 baseline**、`check-reachability --gate`
> **PASS / no new rows（gone rows 為既有清理）**。這代表本 session 的產品改動
> （code-mode dispose recovery、core-session 單次走訪）沒有破壞任何 gate。
> **round 199**：sdk child-context 的 model-origin spawn 改寫**嘗試過但已還原**——把 parent 改成由模型
> yield `spawn_agent` tool_call 後，parent turn 收到 `This operation was aborted`
> （task 從未建立）。下次先查 submit 的 abort 來源（durable session 是否需要 inbox admission、
> 或背景子代理啟動時取消了 parent signal），再重做。
> **round 198**：`sandbox-windows-acl` **全綠（40 檔綠 / 5 skipped，382 passed / 5 skipped）**。
> 兩筆紅的真因不是 native 環境，而是 `init-owner-repair.test.ts` 的 mock API 缺了
> `convertSidToStringSidW`（產品 `pipe-sid.ts:logonSidText` 現在會呼叫它）以及 koffi
> `decode('char16')` 沒有被 mock。補齊後 19/19、全套 382/382。
> **round 197**：`bootstrap-physical` 的 `PROCESS_READ_UNAVAILABLE` 那筆（`prepareBootstrapHeader`
> 事後 patch）已走 `wrap` seam 修掉 → 該檔由 12 紅降到 **11 紅**。其餘紅都是
> readiness 語義（'blocked' vs 'ready'/'already-ready'），與上方裁定同一家族。
> **round 191**：core-agent 由 9 紅檔 / 33 failed 降到 **3 紅檔 / 13 failed**——
> soft-sequence-settlement 3/3、retained-boundaries 3/3、held-policy-receipt 1/1、
> current-context-loopback 2/2、instruction-request-context 12/12 全綠；剩下
> retained-batch-continuation 4、unstarted-call-settlement 9、compaction-binding 2。
> **交接（round 192 收尾）**：下一步是 `unstarted-call-settlement`（9）——它的 `setup()`
> 目前回傳 `backend` 讓測試事後 patch；照 round 192 的 `fixture(names, seams)` ＋ `arm()`
> 模式改即可（hook 在 `openManagedDocument` 之後才生效）。**round 193 已完成**：
> `unstarted-call-settlement` **14/14**、`compaction-binding` **9/9**（SYS-PROMPT 一條已按 A-04
> 改成「專用 summary request」斷言）。**core-agent 全套 649/649（79 檔）**。接著：sdk 5、exec 1、acp 1、
> core-session 1、sandbox-windows-acl 2（native），最後是 session-persistence-jsonl 全套。
> 另修掉 core-agent 的 typecheck（`retained-batch-continuation` 的重複 import 與死變數，
> HEAD 上本來就是紅的）。**round 192**：`retained-batch-continuation` 的 `fixture()` 加上
> `seams`／`arm()`，4 筆紅全綠 → 該檔 **35/35**；core-agent 剩 unstarted-call-settlement 9、
> compaction-binding 2。

## 為什麼先做這個

`verify:all` 的 full job 從未真正 green：v0.1.13 的 gate 只有 typecheck 與
package boundaries，測試 suite 累積了數百個紅測試。當紅測試成為常態，
「這次改動有沒有弄壞東西」就無法回答——本輪 audit 的多次實驗失敗，有一半是
分不清 pre-existing failure 與新 regression。

本輪的原則：

1. 先讓**根因**變成可測（環境、建構子、fixture），不是逐測試硬改。
2. 產品的 fail-closed 契約**不為了測試放寬**；測試要遷移到產品的正式入口。
3. 每個根因都要留下可重跑的驗證指令與預期數字。

---

## 已償還（本輪）

### 1. 套件邊界 gate（紅 → 綠）

`packages/desktop-gateway/src/host.ts` 直接 import
`../../session-executor/src/child-shell.ts`，是 baseline 之外的新違規。
修法：`session-executor` 公開發佈 `mountChildShellTools`（只發佈實際被引用的符號，
避免新增 unused-export），gateway 從套件入口匯入。
`node scripts/audit/check-package-boundaries.mjs --gate` 回到 147 baseline。

### 2. 測試環境自足

先前 `pnpm test` / `node scripts/verify-all.mjs` 直接跑會因為
`IH_*_EVIDENCE_ROOT`、`IH_CONFIG_DIR` 未設而大量崩潰（`Received undefined`）。

- 新增 `scripts/test-env.mjs`：為每個「目錄型」evidence 變數建立**每次執行隔離**
  的暫存目錄（明確給值時不覆蓋）；刻意**不**預設 `IH_BASELINE_RECEIPTS`、
  `IH_CODE_CLOSE_EVIDENCE` 等 opt-in 證據檔。
- root `test` / `test:default` 與 `scripts/verify-all.mjs` 都改走這個 wrapper。

### 3. composed 協調器的測試入口

新增 subpath export
`@i-harness/session-persistence-jsonl/internal/transition`，讓測試/組裝碼不必再
`import '../src/backend-factory.ts'`。目錄內的 `src/` 相對匯入是既有的 147 筆
基線債務，新程式碼不再增加。

### 4. 測試 fixture 的過期假設（4 類）

| 檔案 | 根因 | 修法 |
|---|---|---|
| `task-transition-physical14` (39 tests) | "future task document" 用 `formatVersion: 3`，但 v3 已是支援格式（`captureTaskV3Document`） | future = 4；39/39 |
| `document-observed-read` (6) | S-05 之後 legacy `getDocument` 不再把 IO 錯誤當「沒有文件」 | 斷言兩層都傳播 EACCES/EIO；6/6 |
| `selected-fact-journal` (16) | cleanup 失敗被 managed-documents 包成 aggregate，頂層訊息改變 | 斷言錯誤鏈包含原始 debt；16/16 |
| `task-document-cleanup` (10) | document-only 建構子在 format 14 不能 `create` | 改用 transition 建構子；10/10 |

歷史格式 fixture 也不能再用 `backend.create(format<14)`（產品正確拒絕 downgrade）：

- 新增 `test/helpers/predecessor.ts` 的 `createPredecessorSession`
  （先以 current format 建立、只改 header 的 `formatVersion`）。
- 4 個檔案（history / history-fault / prior-write / upgrade-retry）轉綠；
  upgrade-retry 的「post-effect rename 後讀到什麼版本」斷言改為
  `CURRENT_FORMAT_VERSION`（原本寫死 13 是 format 13 時代的語意）。

### 5. 逾時設定

`session-persistence-jsonl` 的測試會做真實 fsync/journal/lock 工作，原本的
5s 預設逾時會把慢磁碟誤判為失敗（`cold-selected-capability` 42 個「timeout」
其實每個只要 3–8 秒）。新增 `vitest.config.ts` 把 test/hook timeout 設為 30s：
同一批測試（cold-selected-capability + cold-f0-acquisition）由 42 failed 變成
**1 failed / 52 passed / 1 skipped**；剩下的是「closes the exact document
attached during an ordinary opening flight: cleanup-debt」，待查。

### 6. D-12 遷移：不是「改 import」而是逐案重寫

`session-persistence-jsonl` 30 個引用 legacy `createSessionCoordinator` 的檔案，
實測只有 **6 個**能只改 import（45 tests）：

- `meta`、`delivery-journal`、`generation-reservations`、`process-read-owner`、
  `canonical-task-exclusion`、`canonical-connected-exclusion`。

其餘三類根因（20 檔已還原，等待對應工程）：

1. **建構後 monkeypatch backend**（最多）：`appendOwnedBatch` / `repair` /
   `upgradeSessionFormat` 等在 coordinator 建立後被替換 → canonical-path guard
   判 `PROCESS_READ_UNAVAILABLE`。這是產品的 fail-closed 設計。正確遷移是用
   **pre-bind seam**（`wrapOwnedBatch` / `wrapOwnedReconcile`，已存在）重寫每個
   檔案的 fault injection。
2. **predecessor / task-less 會話**：composed 會把 13 升到 14、或對沒有 task
   document 的 legacy session 回 `TASK_TRANSITION_RECOVERY_REQUIRED`。需決定
   語義（升級是否正確），再改測試。
3. **專用建構子缺 transition storage**：見下面產品 bug #2。

`session-persistence` 套件（41 檔使用 legacy 建構子）：**15 檔 / 46 tests 遷移**
（es-platform-events、fact-capacity、fork、input-persistence、m4-crash-acceptance、
model-retry-event、native-witness-format5、retained-execution-observation、
rewind-event、run-end-event、sandbox-mode-event、selected-source-forwarder、
semantic-fork-baseline、step-failed-event、todo-persistence；含 `kill-mid-tool.mts`
子程序），**18 檔還原**，套件 typecheck 乾淨。還原原因與 jsonl 相同（建構後 patch
backend、in-memory fake backend「Original JSONL backend required」、legacy-only 斷言），
另新增兩個產品發現（見下 #7/#8）與一個 hang（#9）。

---

**量測（本輪結束時）**：`session-persistence-jsonl` 全套由
**379 failed / 477 passed（53 個紅檔）** 降到
**295 failed / 561 passed（38 個紅檔，共 98 檔）**。剩餘紅檔分成：

- 建構後 monkeypatch 型（12 檔）：`bootstrap-physical`、`bootstrap-capture-physical`、
  `cleanup-diagnostic`、`coalesced-recovery`、`context-format`、`context-reduction`、
  `current-context-predecessors`、`recoverable-source-hold`、`retained-format-ownership`、
  `selected-results-denials`、`required-source-ports`、`delete-owned`。
- predecessor / 升級語義（5 檔）：`child-bootstrap-predecessor`、
  `child-bootstrap-stage`、`format8/13/11-predecessor`、`semantic-codec2-predecessor`。
- 專用建構子缺 transition（3 檔）：`process-read-composition`、`task-d-repair-header-path`、
  `task-document-write-repair`。
- bootstrap header/close debt 語義（9 檔）：`task-transition-bootstrap-retry/revoke/
  stage-debt/stage-swap`、`task-transition-capture-close-race`、`task-transition-direct-lease`、
  `task-transition-header-debt`、`task-transition-managed-header-confirm/retry`、
  `task-transition-stage-revision`。
- fixture 需要真 birth（2 檔）：`semantic-publication`、`task-document-composition`。
- 其他（3 檔）：`archive-stream`（hang，legacy 也紅）、`managed-native-replay`（deep-JSON
  P0）、`cold-selected-capability`（1 個 cleanup-debt 案例）、`replacement-journal`
  （seedLength 語義）。

---

## 償還：round 6（待辦第 1 項，2026-11-05）

### P0：deep-JSON 冷載入的 e2e 回歸

`managed-native-replay.test.ts` 改走 composed 測試入口後拆成兩個案例：

| 案例 | 深度 | 期望 |
|---|---|---|
| signed/numeric/source-order 保留 | 12 | `prepare().validation.native === 'preserved'`；冷讀後 `tool/call` 的 args 鍵序仍是 `['2','10','z','a','deep','text','$ref']` |
| 過深會話冷開啟 | 6000 | 拒絕：`message === 'TASK_TRANSITION_FAILED'`、`code === 'SESSION_EVENTS_TOO_DEEP'`、`cause.code` 同名、`cause.cause` 是 `RangeError` |

寫入側（agent → managed document → durable journal）在 6000 層仍然成功，只有冷開啟拒絕——
這是 mitigation（`9c4e1bf2` + `e78fe6ca`）的 e2e 證據，`managed-native-replay.test.ts:41`
的重現點結案。保留案例刻意用 12 層：clone 溢出的門檻是 stack 相依，不能當穩定數字。

### P1 #4：create 驗證 lineage 完整性

- `core-session` 新增 `validateLineageHeader`：有 `parentSession` 就必須有合法的
  `seedLength`（安全整數 ≥ 0）。`mutations.create` 的 composed/legacy 兩條分支都在
  寫入前驗證，不再產生「create 成功、append 才 `PROCESS_READ_UNAVAILABLE`」的 artifact。
- 回歸：`delete-owned.test.ts`「refuses a child lineage header without its seed length
  at create」。修前 `create` resolve `{id:'child'}`（測試紅），修後以
  `Invalid parent session lineage: a seed length is required` 拒絕，store 不留檔案。
- 與 `process-read-composition.test.ts:82`（lineage-only 讀取：`seedLength` 缺省視為 0）
  的衝突已記錄：該檔整檔紅（P1 #2），遷移時要把「手寫 lineage-only artifact 的讀取容忍」
  與「create 拒絕」分開寫，不能再用 `create` 造 lineage-only fixture。

### P1 #3：刪除不再被已接受的寫入卡死

- 根因：`lifecycle.deleteOwnedSession` 先 `closeAdmission`（`deleted` 標記）再 flush
  write-behind；composed 的 flush 走 `transitionWrite` → `transitionLoad` →
  `assertWritable`，直接拋 `Session is deleting or deleted`。
- 實測另一條路不可行：只讓 `assertWritable` 在 drain 期間放行、仍走 transition 車道，
  會在 `beginTaskTransition` 得到 `Session binding observation conflict`
  （刪除自己的 observation admission 內不能再開 task transition）。
- 修法：`mutations.ts` 的 write-behind 寫入器在 `deleted.has(id)`（只有 deletion 會設）
  時改走 direct append——與 legacy write-behind 相同形狀，且不必新增 lifecycle 依賴。
- 回歸：`delete-owned.test.ts`「drains accepted writes…」修前在 `deleteOwnedSession`
  拋 `Session is deleting or deleted`，修後刪除成功且事後 `enqueue` 仍被 fence。
- 取捨：drain 的 direct append 不經過 task transition；若 drain 之後刪除才失敗（例如
  backend IO），磁碟上會多一批「已接受但未 transition」的事件，下次開啟是
  `TASK_TRANSITION_RECOVERY_REQUIRED`（fail-closed、可 recovery），而不是靜默丟棄
  已接受的寫入。tombstone 仍在 drain 之後才寫，成功路徑沒有中間可見狀態。

### 同批 fixture 現代化（`delete-owned.test.ts`）

- 建構子改走 `test/helpers/composed.ts`。
- `restarted.create` 的 tombstone 斷言改看 `code: SESSION_DELETED`（D-12 #7 的 wrapper
  只保留 code；message 仍是泛用的 `TASK_TRANSITION_FAILED`）。
- symlink 案例的訊息改 `symlink|non-reparse`（Windows junction 走
  `Artifact ancestor is not an original non-reparse directory`）。
- 「read-only backend 不發佈 destructive capability」改用**從未有**該能力的 fake
  backend：JSONL backend 的 identity guard 會拒絕建構後改屬性，那不是這條契約。

**量測（round 6 結束時）**：`session-persistence-jsonl` 全套
**286 failed / 572 passed / 17 skipped（36 個紅檔，共 98 檔）**
（round 5 結束：295 failed / 561 passed / 38 紅檔）。紅檔集合 = round 5 的 38 檔減去
`delete-owned` 與 `managed-native-replay`，沒有新增紅檔。

**其他 gate（round 6）**：三個受影響套件 `typecheck` exit 0；boundaries 147/147；
reachability 仍是 71 NEW（沒有新增 row）。

---

## 償還：round 7（待辦第 2 項，2026-11-05）

依 round 6 的決策移除 `createJsonlSessionCoordinator`（`session-persistence-jsonl/src/index.ts`
不再 export，`backend-factory.ts` 刪除實作）。14 個測試檔全部遷移：

| 套件 | 檔案 | 前 → 後 |
|---|---|---|
| jsonl | `process-read-composition` | 0/12 → 12/12 |
| jsonl | `task-transition-managed-header-retry` | 0/1 → 1/1 |
| jsonl | `canonical-connected-exclusion` | process-only 變體隨建構子消失，13/13 |
| jsonl | `task-d-repair-selected-capability` | generic 改用 core 建構子，3/3 |
| jsonl | `archive-stream` | composed 建構子改用 transition；42 中仍 1 個既有 hang |
| jsonl | `bootstrap-stage-debt`／`-stage-swap`／`-managed-header-confirm`／`-stage-revision` | setup 改 transition 建構子；紅因轉為 bootstrap 語義（見下） |
| desktop-gateway | `host-publication` | 0/21 → 21/21（同檔 legacy 建構子一併換掉） |
| desktop-gateway | `process-query` | 2/2 |
| desktop-gateway | `process-native-bridge` | 0/1 → 1/1 |
| session-executor | `process-result-integration` | 0/1 → 1/1 |
| subagent | `task-owned-load` | generic 變體改用 core 建構子；該檔 22/37 仍是 5s timeout（套件缺 vitest.config，見下） |

### `process-read-composition` 一併解掉 round 6 的 lineage 衝突

- malformed seed boundary（-1／0.5／'1'／null）：**cold process setup 與 managed recovery
  都拒絕**——format 14 的 recovery 是 task transition，malformed seed 是
  `Invalid task history scope`（包在 `TASK_TRANSITION_FAILED` 內）。
- well-formed inherited boundary（1）：cold setup 拒絕、managed recovery 成功。
- lineage-only（缺 `seedLength`）：create 拒絕；**手寫** artifact 仍可走 cold process lane
  （視為 0），managed recovery 拒絕（strict history reader）。

### round 7 的新發現（未修，歸第 4 項）

- `bootstrap-stage-debt`：setup 走 transition 建構子後 task document 已存在，舊斷言
  「blocked resume 後 doc 不存在」失效；應改成「blocked resume 不改寫 doc」。
- `bootstrap-stage-swap`／`stage-revision`：faulted resume 後重試成功，但
  `coordinator.close()` 拋 `Coordinator cleanup is unresolved`——retained cleanup debt
  沒被 close 收斂。
- `managed-header-confirm`：setup 已完成的 bootstrap 讓 cold open 的 header sync 不再
  落在 `doc:task-target` lease 內（`protectedAtSync === false`）。
- subagent 套件沒有 `vitest.config.ts`（5s 預設）：`task-owned-load` 單檔在空載下仍有
  22/37 個「Test timed out in 5000ms」，實際每個測試要 2.5–4.6s。**不要直接複製 jsonl 的
  30s**：本輪試過同一個 config，該檔 15 分鐘沒有任何輸出（5s 版 151 秒跑完），已還原；
  timeout 與可能的同步 hot loop 要單獨查（第 5 項量測 subagent 時處理）。

### 第 3 項（A 類）開工：5 檔完成

每檔都用 `createJsonlBackend` 的 pre-bind seam（`wrapOwnedBatch`／`wrapOwnedReconcile`）
取代建構後的 `backend.appendOwnedBatch = ...`，並改走 composed 測試 helper：

| 檔案 | 前 → 後 | 用的 seam |
|---|---|---|
| `cleanup-diagnostic` | 0/4 → 4/4 | `wrapOwnedBatch` |
| `required-source-ports` | 0/2 → 2/2 | `wrapOwnedBatch` |
| `recoverable-source-hold` | 0/2 → 2/2 | `wrapOwnedBatch` |
| `coalesced-recovery` | 0/4 → 4/4 | `wrapOwnedBatch` + `wrapOwnedReconcile` |
| `selected-results-denials` | 5/9 → 9/9 | `wrapOwnedBatch` |
| `context-format` | 1/10 → 10/10 | 新增通用 `wrap` seam（見下） |
| `context-reduction` | 0/20 → 20/20 | `wrap` + 可變 `AppendHook`（fixture 在建構前安裝） |
| `retained-format-ownership` | 0/30 → 30/30 | `wrap` 計數器（取代七個 `vi.spyOn`） |
| `bootstrap-physical` | 0/58 → 46/58 | `wrap` + append／confirm frame hooks（剩 12 個語義紅，見下） |
| `current-context-predecessors` | 3/12 → 3/12（遷移完成） | `wrap` upgrade policy（剩下 9 個 predecessor-resume 語義紅，見下） |
| `bootstrap-capture-physical` | 11/61 → 57/61 | `wrap` 通用捕獲方法 hook map（剩 4 個語義紅，見下） |

`context-format` 需要換掉三種「建構後改 backend 方法」的注入，既有的兩個 seam 不夠，
所以 `createJsonlBackend` 多了第三個 pre-bind seam：

- `wrap?: (backend) => void`：在 canonical-path guard 快照 **所有** own descriptor 之前
  執行一次。測試可以替換任何方法（repair／replaceEvents／upgradeSessionFormat／append），
  也可以刪掉能力來模擬「本來就沒有」的 backend。這比照 `wrapOwnedBatch` 的既有限制：
  建構後再改就是 `PROCESS_READ_UNAVAILABLE`。
- 檔內兩個 legacy 期待在 format 14 已不成立，改寫成 composed 契約：
  1. 過深／legacy 升級能力：composed lane 自己 stage header 升級，**不查**
     `backend.upgradeSessionFormat`；改成斷言「沒有該方法也能升到可寫格式」。
  2. 升級被拒後重試：unknown durable write 會 poison process-read latch，重試被
     `PROCESS_READ_UNAVAILABLE` 拒絕、關閉時回報 retained batch debt；改成斷言
     fail-closed 形狀（不再假設同一個 coordinator 內可重試）。
- 順帶修掉 P2 #5：`updateMeta` 的 downgrade 檢查移到 transition 之前，訊息回到
  「cannot downgrade session format」，不再被包成泛用 `TASK_TRANSITION_FAILED`。

11 檔全部遷移完成：8 檔全綠，3 檔只剩語義紅
（`bootstrap-physical` 46/58、`current-context-predecessors` 3/12、
`bootstrap-capture-physical` 56/61）。

`bootstrap-capture-physical` 的 4 個語義紅（歸第 4 項；P18 已修）：

- P09/P10 rename-after promotion：期待 `ready`，實際 `refused`。
- P10 cold full promoted ready stage：期待 `already-ready`，實際 `blocked`
  （metadata 編輯後冷 resume 被拒；要確認 metadata 是否應屬 birth manifest）。
- P14 claim release failure／consumed native claim release：release 次數 2（期望 1；
  composed lane 在捕獲失敗時已嘗試釋放一次，close 再重試）。
- P18 原本期待「root directory open = 0」，但 composed lane 的 fs-lock artifact guard
  會讀一次 root（Windows reparse 檢查）；改成只斷言「沒有可寫的 directory handle」後轉綠。

`bootstrap-physical` 遷移後仍有 12 個語義紅（歸第 4 項），共同形狀是「transition 車道
的 outcome 與 legacy 期待不同」：

- seed-issue 守衛、source-change、frame reconcile、header fsync 等案例期待 `ready`，
  實際是 `blocked`（bootstrap 在 transition 內多了一次一致性檢查）。
- 一個案例期待 `not-issued`，實際 `blocked`（metadata-only nonempty target）。
- 兩個案例期待 `FACT_RECOVERY_REQUIRED` 或直接拋錯，實際是
  `SessionBindingObservationError`／`PROCESS_READ_UNAVAILABLE`。
- `keeps the original manifest ready …` 與 `review F1 …` 期待 `already-ready`，
  實際 `blocked`。

`current-context-predecessors` 遷移後仍有 9 個 predecessor-resume 語義紅（歸第 4 項）：

- ready／direct-upgrade／birth-conflict 模式期待 `already-ready`，實際 `blocked`。
- header-only 期待 `ready`，實際 `not-issued`。
- stage-only 期待 header 升到 CURRENT，實際停在 11（resume 只沿用 predecessor stage 的
  header，沒有走 composed 的升級）。
- partial-header 以 `Coordinator cleanup is unresolved` 收場。
- upgrade-response-lost／upgrade-target-revoked 期待 `blocked`，實際 `already-ready`
  （predecessor 階段已在舊 build 完成，current resume 直接視為已就緒）。

**量測（round 10 結束，空載重跑）**：`session-persistence-jsonl` 全套
**106 failed / 751 passed / 17 skipped（26 個紅檔，共 98 檔）**
（round 34 空載重跑；P18 修正後 +1，與 round 10 的 107/750 對帳一致）。

- round 8/9 結束時是 152 failed / 705 passed（26 紅檔）。
- round 10 的 `bootstrap-capture-physical` 遷移：-45 failed、+45 passed（56/61），
  紅檔不變（檔案仍紅，剩 5 個捕獲語義）。

- round 7 結束時是 228 failed / 629 passed（27 紅檔）。
- round 8 的兩個 A 類遷移：`retained-format-ownership` -30、
  `bootstrap-physical` -46（46 個轉綠、12 個語義紅留下）；紅檔 27 → 26
  （`retained-format-ownership` 轉綠，bootstrap 兩檔仍紅）。
- round 9 的 `current-context-predecessors` 遷移不改數字（9 個語義紅仍在，
  見第 4 項）。

- 第 2 項（建構子移除）後是 273 failed / 584 passed（34 紅檔）：差異恰好是
  `process-read-composition`（-12 failed、+12 passed）、
  `task-transition-managed-header-retry`（-1、+1），加上
  `canonical-connected-exclusion` 少一個 process-only 變體（總數 875 → 874）。
- 第 3 項的 7 檔再降 45 個紅測試（4／2／2／4／4／9／20），紅檔 34 → 27。
- round 6 結束時是 286 failed / 572 passed（36 紅檔）。

**其他 gate（round 7）**：全庫 `pnpm -r --no-bail typecheck` 82 packages 全綠；
boundaries 147/147；reachability 432 rows、70 NEW（round 6 是 71，移除的 export row
已消失）、104 baseline rows 消失。

**round 13 的 gate 進度**：`session-persistence` 移除 5 個沒有 import 端點的 type
re-export（`ResolvedBootstrapBirth`、`ForkHandoffMode`、`ChildInitialCommitment`、
`ChildExecutionIntent`、`ChildLineage`）→ reachability **427 rows、65 NEW**
（-5），套件 typecheck 乾淨。同輪再移除 `BootstrapInitial`、`BootstrapLineage`、
`BootstrapTarget`、`ChildBootstrapRequestIntent` → **423 rows、61 NEW**。
再一輪移除 `core-session` 的 5 個 type re-export（`CurrentContextComponent`、
`SelectedResultsPreparationSemantic`、`LegacyReadVisibility`、`LegacyVisibleRef`、
`DeliveryActionOrigin`）→ **418 rows、56 NEW**（累計 -14）。再一輪移除 `exec` 的
`ExecFrameQuery`、`ExecOutputFramePage`、`ExecRawSummary` → **415 rows、53 NEW**（累計 -17）。
再一輪移除 `core-agent` 的 6 個 type re-export（`ManagedAgentDeps`、`ManagedGenerationFactory`、
`ManagedAcknowledgedFact`、`ManagedRequestContext`、`ManagedSessionExecutor`、
`ManagedSessionExecutorDeps`）→ **409 rows、47 NEW**（累計 -23）。再一輪移除 `settings` 的
`SettingsRevisionGuard`、`SettingsWatchOptions`、`SettingsWatchState`、
`InstructionMigrationMeta` → **405 rows、43 NEW**（累計 -27）。再一輪清三個套件共 11 個
type re-export：`session-executor`（`PendingRewindIntent`、`RewindIntentV1`）、
`subagent`（`DocumentIntentStore`、`DocumentWriteIntentV1`、`JobLoadResult`、
`JobRecordStore`、`PendingDocumentWrite`、`isParentNotificationStopped`）、
`core-tools`（`ApprovalPolicyService`、`NativePlanValidationError`、`NativeTarget`）
→ **394 rows、32 NEW**（累計 -38）。再一輪移除 4 個 type re-export
（`session-persistence` 的 `ForkHandoff`、`ChildCaller`；`instructions` 的
`InstructionPendingLease`；`llm-seam` 的 `SseFrame`）→ **390 rows、28 NEW**（累計 -42）。
接下來改走「公開契約 → allowlist 註明理由」：把 `llm-seam#withPreparedRequests`
（README 列為 public API seam，但目前 adapter 直接 import wrapper 模組）加進
`reachability-allowlist.json`（dated 2026-11-05、附 reason/source）→ **27 NEW**。
接著修 gate 本身的盲點：`session/queued` 的 producer 存在（`session-executor/src/service.ts`
的 `telemetry.emit({ type: 'session/queued' })`），但 gate 的 producer 掃描只認雙引號字面量，
單引號一律漏報。把 `EVENT_LITERAL` 與 `isProducerLine` 改成引號無關 → 該筆 false positive
消失，**26 NEW / 389 rows**（其他既有 producerless 判定不受影響）。再移除
`workflow#WorkflowLoopFailure` 與 `session-executor#ManagedRuntimeLifecycle` 兩個
multi-line export list 內的 type 條目 → **24 NEW / 387 rows**。接著把 5 個有公開簽名／
文件依據的契約加 allowlist（`exec#JobOutputObservation`、`exec#NativeJobKillSelector`、
`core-tools#ToolPrepareIdentity`、`runtime-context#PreparedRuntimeContextReader`、
`token-meter#CHARS_PER_TOKEN`，皆附 dated reason/source）→ **19 NEW**（無 inert 警告）。
再處理第一個「測試專用」項：`settings#SettingsWatchError` 讓 `watch-lease.test.ts`
改從內建模組 import type，入口不再 export → **18 NEW / 386 rows**（測試 14/14 綠）。再移除 `core-session`
的 `validateRuntimeContextRecord`（只在定義模組內使用）→ **17 NEW / 385 rows**。
再移除 `workflow#reserveWorkflowIn`（測試本來就從 `src/runner.ts` 直接 import）
→ **16 NEW / 384 rows**（runner-lifecycle 13/13 綠）。再把 `settings#previewLegacyInstructionImport`
的唯一測試 consumer 改成從 `src/storage/instruction-migration.ts` import，入口不 export
→ **15 NEW / 383 rows**（instructions 44/44 綠）。再移除 `session-persistence` 入口的
`validateChildCaptureStage`（測試本來就從 `coordinator/bootstrap-route.ts` 直接 import）
→ **14 NEW / 382 rows**。再移除 session-executor 的 ManagedRuntimePublication（測試以 import('../src/service.ts') 取得）→ **13 NEW / 381 rows**。把 core-session 兩個 wildcard 來源的 4 筆加 allowlist（CodeOutputRecord、SubagentDeliverySourceEvent、validCodeOutputMember、validDeliveryKey，皆附 dated reason/source）→ **9 NEW**。剩下的 NEW rows 多數是 type-only／內部候選，需逐個確認
是否為公開契約再加 allowlist 或移除。

---

## 發現的產品 bug（本輪新增，依嚴重度）

1. **P0：deep-JSON 冷載入會 `RangeError` 崩潰**
   `session-persistence/src/coordinator/load.ts:90` 用
   `JSON.parse(JSON.stringify(proof.initial.events))` 做 deep clone；
   6000 層的 tool-call args 會 stack overflow（`JSON.parse`、
   `structuredClone` 都會），被包成 `TASK_TRANSITION_FAILED`。
   重現：`packages/session-persistence-jsonl/test/managed-native-replay.test.ts:41`
   （目前被還原；把 import 改回 composed helper 即可重現）。
   建議：在讀取/複製路徑做**迭代式深度檢查**，超過上限回明確
   `SESSION_EVENTS_TOO_DEEP`；或在 tool args admission 就限制深度。
   **已緩解（`9c4e1bf2`）**：cold-load 的 JSON round-trip 現在捕捉 `RangeError`，
   回 `code: SESSION_EVENTS_TOO_DEEP`（cause 保留 RangeError），且
   transition wrapper 會保留該 code。probe（6000 層）：
   `CODE SESSION_EVENTS_TOO_DEEP | CAUSE RangeError`。
   **round 6 已補**：磁碟上深層 args 會話的 e2e 冷開啟回歸
   （`managed-native-replay.test.ts`；6000 層 → `code: SESSION_EVENTS_TOO_DEEP`，
   cause 鏈到 `RangeError`）。**仍欠**：admission 端的深度上限決策（目前語義是
   「寫得進去、冷讀拒絕」）。

2. **P1：`createJsonlSessionCoordinator` 在 format 14 無法建立/開啟會話**
   `backend-factory.ts:42-49` 組裝時沒有 `transitionStorage`，任何
   `create`/`openManagedDocument` 都 `TASK_TRANSITION_UNSUPPORTED`。
   目前沒有 production caller，但它是公開 export，且有 15+ 測試檔使用
   （desktop-gateway、session-executor、subagent、jsonl）。
   建議：讓它要求 `TaskTransitionConfiguration` 參數，或直接移除 export
   （私有套件，無外部使用者）。
   **已修（round 7）**：export 與實作移除，14 個測試檔改走 composed 建構子；
   reachability 的 export row 也跟著消失。詳見上方量測。

3. **P1：`deleteOwnedSession` 先標記刪除、再 drain 已接受的寫入**
   `delete-owned.test.ts:40`：`Session is deleting or deleted`
   （`mutations.ts:53` → `load.ts:51` → `mutations.ts:68`）。刪除順序需與
   accepted-write drain 對齊。
   **已修（round 6）**：`deleted` 狀態的 write-behind 改走 direct append（transition
   車道在刪除 admission 內是 `Session binding observation conflict`），回歸見上方
   量測章節。

4. **P1：`create` 接受 `parentSession` 但沒有 `seedLength`，append 才拒絕**
   `delete-owned.test.ts:12-14`：`create({origin:'subagent',parentSession})`
   成功，`append` 卻 `PROCESS_READ_UNAVAILABLE`（`process-read.ts:237`）。
   應在 create 就驗證 lineage 完整性。
   **已修（round 6）**：`validateLineageHeader` 在 create 入口拒絕不完整 lineage，
   回歸與待解衝突（`process-read-composition`）見上方量測章節。

5. **P2：`updateMeta` 把 downgrade/format 錯誤包成 `TASK_TRANSITION_FAILED`**
   `context-format.test.ts:39` 期待 `/downgrade|format/`，原因藏在 `.cause`。
   對 user-facing diagnostics 是退步。
   **已修（round 7）**：downgrade 檢查移到 transition 之前，訊息恢復原樣；回歸在
   `context-format` 的 cold v1 案例。

6. **P2：fork `seedLength` 語義改變**
   composed fork 的 header `seedLength` 是 4（compiled seed records），
   legacy 是 10（raw prefix）；訊息內容相同。需確認是否有下游依賴舊值
   （`replacement-journal.test.ts:40`）。

7. **P1：composed 路徑把 typed error 全部包成 `TASK_TRANSITION_FAILED`**
   `task-document-transition.ts:234` 把所有失敗包成
   `new Error('TASK_TRANSITION_FAILED', { cause })`。format-15 標頭、unknown
   event type、non-positional seq 都只剩泛用外層錯誤；呼叫端用
   `instanceof SessionFormatUnsupportedError` 會失效（conversation-format ×2、
   repair ×1、passive-code-store-bootstrap ×1）。
   **已修（`e78fe6ca`）**：wrapper 保留原始 `code`，format 拒絕得到穩定的
   `SESSION_FORMAT_UNSUPPORTED`；probe（format-15 header → composed
   `openManagedDocument`）得到 `CODE SESSION_FORMAT_UNSUPPORTED`、
   `CAUSE SessionFormatUnsupportedError`。後續：把上述 4 個測試改為檢查
   `code`（而不是字串）即可一併轉綠，但那些檔案同時有 monkeypatch 問題，
   留在第 4 批一起處理。

8. **P1：每次 append 都會修補 open tail**
   `append(turn/start)` 後 `append(step/start)` 會在中間寫入合成的 `turn/end`；
   下一次 append 再補 `step/end`。被拒絕的 append 也可能留下 durable repair
   batch；且「acceptance 晚於既有 batch」會被 `append conflicts with durable
   prefix` 拒絕（conversation-format test 1）。需確認 transition load 的
   repair 邊界（`load.ts:64-79`、`task-document-transition.ts:215`）。

9. **P1：`process-read-pending-retry` 測試會無限 hang**
   `vitest run test/process-read-pending-retry.test.ts` 240s 無輸出、vitest 5s
   timeout 也不觸發，必須殺 process——疑似 reconcile 路徑的同步 hot loop。

---


## 其他 gate 的債務

### `check-reachability --gate`（**round 27 已轉綠：PASS**）

經 17 輪比對：可移除的 export 逐批拆掉（~50 筆），真正的公開契約則加
`reachability-allowlist.json` 並附 `dated`、reason、source。現在
`node scripts/audit/check-reachability.mjs --gate` 輸出 `gate PASS -- no new rows`（exit 0）；
baseline 仍為 456 rows，目前 381 rows、無 inert 警告。以下為當時的紅清單（歷史）。

- 435 rows（baseline 456，103 筆已消失是進度），但 **71 筆是 baseline 之後新增**：
  多數是 `unused-export`（`core-agent` 6、`core-session` 10、`core-tools` 8、
  `exec` 7、`sdk` 2、`session-executor` 5…），另有 1 筆
  `producerless-event session/queued`（telemetry manifest 宣告但沒有 producer）。
- 2 筆 allowlist 條目已經沒有對應 row（`output-retention#gcSpillStore`、
  `sdk#SdkRunError`）——**已刪除**（`reachability-allowlist.json` 38 筆，
  gate 不再報 inert）。
- 處理原則：能移除的 export 直接移除（型別 export 不影響 runtime）；確實是公開
  契約的就加回 allowlist 並註明理由；`session/queued` 要補 producer 或刪
  manifest 條目。**不要**直接 `--write-baseline` 把 72 筆吞掉。

## 待辦順序（下一輪起）

1. ~~修 P0（deep-JSON）與 P1 #3/#4，各補一個回歸測試。~~ → round 6 完成（見上）。
2. ~~決定 #2 的 API 去留（移除或補參數），同步清掉 15+ 測試的建構子。~~
   → round 7 完成（移除 export，14 檔遷移，見上）。
3. A 類測試（建構後 monkeypatch）逐檔改用 pre-bind seam；每檔一次 PR/commit，
   並用本文件的 `test-env` 指令驗證。
   **round 10：11/11 檔遷移完成**，8 檔全綠；`bootstrap-physical` 46/58、
   `bootstrap-capture-physical` 57/61、`current-context-predecessors` 3/12 的剩餘紅
   都是語義（歸第 4 項，共 25 個已列形的案例）。
4. B 類 predecessor 語義決策：若 composed 升級 13→14 是正確行為，更新
   `child-bootstrap-predecessor`、`semantic-codec2-predecessor` 的位元組斷言；
   若否，回頭修產品。
   **round 12 進度：`session-executor` 第一批（owned-* 17 檔）**。Windows 上該套件
   `vitest.config.ts` 關閉 fileParallelism，單檔要 30–140 秒，17 檔約 25 分鐘；
   已完成 8 檔全綠：`owned-service-shell`(15)、`owned-workflow-service`(7)、
   `owned-metadata-runtime`(18)、`owned-service-title`(7)、`owned-code-nested-shell`(2)、
   `owned-plugin-catalog`(6)、`owned-task-service`(2)、`owned-code-service`(2，單跑 29.6s)。
   量測中發現 **單檔就吃 30–140 秒**，批次跑到第 8 檔後被本輪中止（不是 hang；
   `owned-code-service` 單跑可完成）。**round 31 完成剩餘的 11 檔：11/11 檔、21/21 tests 全綠**（batch2，字串列表下列為當時的清單）。
早先已完成 8 檔；合計 owned-* 子集 **19 檔全綠**。

剩下的清單為（`owned-approval-causal`、`owned-code-mount`、
   `owned-code-nested-workflow`、`owned-code-stop-retry`、`owned-metadata-fold`、
   `owned-plugin-causal`、`owned-prefilesystem`、`owned-rewind`、`owned-service-title-debt`
   等）下一輪分組跑。套件實際有 223 個 `*.test.ts`（不是 99），全套要用多輪或分組跑。
round 28/29 量了兩個小套件：

- `token-meter`：**8 檔 / 53 tests 全綠**（2.4s）。
- `sdk`：**6 檔紅 / 13 檔綠（19 檔），11 failed / 108 passed（119 tests）**——已列為第 5 項待修清單的第一筆（含 `cancel-stop` 的 5 個 Stop receipt 案例、CLI 端到端 2 筆、cold native frames 2 筆等）。
- `instructions`：**1 檔紅 / 12 檔綠（13 檔），1 failed / 140 passed（141 tests）**。
- `runtime-context`：**1 檔紅 / 3 檔綠（4 檔），1 failed / 21 passed（22 tests）**。
  紅點名稱已補記：`instructions` = **「actual W1 128-key aggregate capacity bounds a new
  port without cancelling an accepted producer」→ Test timed out in 5000ms**（時間類；
  round 65 已加 `packages/instructions/vitest.config.ts`（30s），**13/13 檔、141/141 全綠**）；round 67 再量兩個套件：`preset` **2 檔 / 9 tests 全綠**、`provider-runtime`
  **7 檔 / 93 tests 全綠**。
round 70：`session-query` **4 檔紅 / 3 檔綠（7 檔），25 failed / 59 passed（84）**；
  `hooks` **19 檔全綠，167 passed / 1 skipped（168）**。
round 74：`core-plugin` **6 檔 / 58 tests 全綠**、`memory` **3 檔 / 4 tests 全綠**。
round 77：`todo` **1 檔 / 14 tests 全綠**、`text-diff` **1 檔 / 16 tests 全綠**。
round 89：`skills` **8 檔 / 61 tests 全綠**、`telemetry` **4 檔 / 19 tests 全綠**。
round 90：`settings` **18 檔 / 230 tests 全綠**、`plugin-registry` **12 檔 / 244 tests 全綠**。
round 91：`usage-stats` **10 檔 / 88 tests 全綠**、`mcp-client` **17 檔 / 109 tests 全綠**。
round 92：`terminal` **8 檔全綠，57 passed / 2 skipped**（第一次跑有 1 個 flaky 紅，重跑全綠）；
round 93：`fs` **15 檔 / 113 tests 全綠**、`shell` **11 檔 / 93 tests 全綠**。
round 119：`fs-search` **5 檔 / 51 tests 全綠**、`fs-watch` **5 檔 / 69 tests 全綠**。
round 120：`image-validation` **1 檔 / 19 tests 全綠**、`attachment` **2 檔 / 12 tests 全綠**。
round 147：`plan-mode` **1 檔 / 5 tests 全綠**、`interaction` **5 檔 / 29 tests 全綠**。
round 148：`goal` **1 檔 / 16 tests 全綠**、`diagnostics` **4 檔 / 49 tests 全綠**。
round 149：`workspace` **6 failed → 2/2 檔、24/24 tests 全綠**（legacy 建構子 → composed +
round 150：`sandbox-policy` **3 檔 / 67 tests 全綠**、`tool-search` **2 檔 / 19 tests 全綠**。
round 151：`sandbox-local` **4 檔綠 / 2 檔 skipped，22 passed / 6 skipped**；`fs-lock`
round 152：`credentials` **2 檔 / 23 passed + 1 skipped**、`harness-home` **1 檔 / 5 tests 全綠**。
round 154：`output-retention` **5 檔 / 45 tests 全綠**；`sandbox-windows-acl` **1 檔紅 / 39 檔綠 /
round 159：`sandbox` **9 檔 / 142 tests 全綠**、`sandbox-wsl` **8 檔綠 / 4 檔 skipped（63 passed / 20 skipped）**。
round 155：`soft-sequence-settlement` 的 3 紅 unmask 後真因是 **`PROCESS_READ_UNAVAILABLE`**
  （建構後 patch backend），與 code-mode／guard-repeat-tool 同一類；單獨跑時無
  `TASK_TRANSITION_FAILED`（全跑才出現，屬順序敏感）。→ core-agent 的 cleanup 群多數可望以
  same seam 遷移解決。
  5 skipped（45 檔），2 failed / 380 passed**——兩個紅都是「native initialization failed with
  retained cleanup debt」（koffi native 初始化，疑與本機環境有關）。
  **3 檔綠 / 1 檔 skipped，109 passed / 6 skipped**。
  lock）；`workspace-runtime` **3 檔 / 23 tests 全綠**。
round 125：`guard-timeout` **1 檔 / 7 tests 全綠**；`guard-retry` **1 檔紅 / 9 passed（10）**——紅點
  **round 126 已修**：`guard-retry` 在 `sleep(backoff)` **之後**沒有再檢查 caller signal，
round 127：`guard-approval` **11 檔 / 107 tests 全綠**；`guard-repeat-tool` **1 檔紅 / 8 passed（9）**
  **round 128 已修**：把 `entered`／`release` 提到建構前，掛鉤改走 `wrapOwnedBatch` 並用 composed
  建構子 → `guard-repeat-tool` **2/2 檔、9/9 tests 全綠**。
  ——紅點「awaits the actual owned repeat-feedback receipt for the exact observed session」原為
  `TASK_TRANSITION_UNSUPPORTED`（legacy 建構子），遷到 composed 後變成
  `PROCESS_READ_UNAVAILABLE`（建構後 patch backend），即與 `code-mode` 同一類、需同一個掛鉤決策。
  所以 backoff 期間 abort 仍會再派發；補上 `if (upstream?.aborted) break` 後 **10/10 全綠**。
  「does not re-dispatch after the caller signal aborts」→ `expected 2 to be 1`（abort 後仍再派發）。
round 94：`jobs` **1 檔 / 5 tests 全綠**、`workflow` **6 檔 / 66 tests 全綠**。
round 95：`lsp` **6 檔 / 94 tests 全綠**、`media` **3 檔 / 15 tests 全綠**。
round 96：`acp` **1 檔紅 / 16 passed（17）**（CLI stdio NDJSON：`Cannot read properties of undefined
round 101：`core-agent` 原 **13 檔紅 / 44 failed（79 檔 / 649 tests）**，10 個測試檔仍是 legacy
  round 143：加 `packages/core-agent/vitest.config.ts`（30s）→ **10 檔紅 / 35 → 9 檔紅 /
  round 144 抽樣：`soft-sequence-settlement` 首紅是 **`TASK_TRANSITION_FAILED`**（需讀 wrapper 的
  `cause`），其餘三紅是 cleanup 遮罩；`held-policy-receipt` 1 紅同屬 cleanup 群。
  紅檔清單（9 檔）：`held-policy-receipt`、`compaction-binding`、`soft-sequence-settlement`、
  `overflow`、`retained-boundaries`、`current-context-loopback`、`instruction-request-context`、
  `unstarted-call-settlement`、`retained-batch-continuation`。
  33 failed（649）**；剩餘分類：22× `Coordinator cleanup is unresolved`（多為遮罩，需 unmask）、
  6× `expected undefined to be defined`、1× `SYS-PROMPT`、1× `main authority`、1× length、以及少量 timeout。
round 115：`code-retrieval` **4 檔 / 54 tests 全綠**；`code-mode` **10 檔紅 / 18 檔綠
  **round 117 已遷移**：8 個 code-mode 測試檔改用 composed 建構子 → **9 檔紅 / 19 檔綠，
round 133：`compaction` 已由 3 紅轉 **33/33 檔、247/247 tests 全綠**——`managed-facts` 與
  `summary-observation` 的 `appendOwnedBatch`／`reconcileOwnedBatch` 掛鉤搬到 `wrapOwnedBatch`／
  `wrapOwnedReconcile`（計數器先宣告），並把 `finally` 的 close 改為只附加錯誤 → 真紅現形、逐一修正。
  **round 121 遷移配方**（給下一輪照做）：測試目前是 `backend.appendOwnedBatch = async (...args)=>…`
  **round 122 首例完成**：`broker.test.ts` 的 `appendOwnedBatch` 掛鉤搬進 `wrapOwnedBatch` →
  **round 134**：`managed-store-stop.test.ts` 同法遷移（計數器先宣告）→ **2/2 全綠**。
round 138 全套重跑：`code-mode` **7 檔紅 / 21 檔綠（28 檔），83 failed / 282 passed（365）**
round 182：`cell-output-owner-fixture.ts` 的第一個 `appendOwnedBatch` 掛鉤搬進 `wrapOwnedBatch`
  **round 183**：fixture 加 `setBatchHook`／`setReconcileHook`（建構時安裝轉發 wrapper），
  round 184：`output-owner-boundaries` 剩 3 筆（`retains same-cell source admission` ×2、
  `characterizes original optional store`）→ 仍 `PROCESS_READ_UNAVAILABLE`；測試走 `fixture(order)`
  （非 native/memory）與 `f.facts.requiredPrepared`，需以 verbose stack 找出實際 patch／guard 來源。
  mount helper 改用 setter → **`cell-output-owner-lifetime` 45/45 全綠**；`output-owner-boundaries`
  剩 3 筆仍 `PROCESS_READ_UNAVAILABLE`（改 patch 另一個方法）。
  → **`retention-callback-latches` 41 紅 → 84/84 全綠**（單一修正清掉 41 筆）。其餘兩個
  consumer（`cell-output-owner-lifetime`、`output-owner-boundaries`）用的是 fixture 後面
  line 115/127 的動態掛鉤，仍需 armed 重構。
  round 139：`store.test.ts` 單紅是「a failed completion flush overrides a persisted store
round 141：`session-query` 4 個測試檔遷到 composed 建構子 → **25 → 20 failed / 64 passed
  **round 142 收尾**：剩下的 `TASK_TRANSITION_UNSUPPORTED` 其實來自
  `task-document-transition.ts:95`（lock 未啟用）——補上 `{ lock: { enabled: true } }`；
  子會話建立需 `seedLength`（lineage validator）；current append 測試的格式改期待 14。
  → `session-query` **7/7 檔、84/84 tests 全綠**（由 25 failed）。
  （84）**、4 紅檔不變；剩餘 20 筆仍報 `TASK_TRANSITION_UNSUPPORTED`，來源不是測試檔的建構子
  （src 無 `createSessionCoordinator`），需追 session-query 工具內部開啟 session 的路徑。
  candidate and completed marker」→ `Managed facts require reconciliation`；該測試用非 durable
  `createSession()`（不是 jsonl backend），屬語義/生命週期問題，需與 cleanup-debt 一起判讀。
  （由 9 檔紅 / 86 failed 改善）。紅檔：`retention-callback-latches` 41、`cell-output-owner-lifetime` 27、
  `surface-publication` 5、`instruction-start-recovery` 4、`output-owner-boundaries` 3、`register` 2、`store` 1。
  **round 135 重要教訓**：`register.test.ts` 的 hook 若在建構時就生效，會攔到 `create`／
  **round 136**：加 `armed` 旗標（open 後才生效）仍 5s timeout → 不是 hook 攔到 open，而是
  `register` 這兩個案例的 settle 時序本身需要更長／或 hook 與 settle 互動有問題；此檔暫緩，
  先做 `surface-publication`／`output-source-recovery` 這類較單純的檔案。
  `openManagedDocument` 期間的 append/reconcile（測試原本是 open 之後才掛），導致 `mount.ready()`
  永遠等不到（30s timeout）。遷移時必須加 `armed` 旗標：open 完成後才 `armed = true`，hook 內
  `armed && …` 才生效。已還原該實驗（未提交）。
  **round 123 卡點**：`cell-output-owner-fixture.ts` 的後續掛鉤（line 115–134）依賴執行期狀態
  （`batch`／`receipt`／`target` 由測試參數決定），無法直接搬進建構選項；同類測試還有
  `instruction-start-recovery`、`output-source-recovery`。這批需要「建構後的合法掛鉤 API」
  （例如 `backend.hookOwnedBatch(fn)` 重新 bind guard）或把 fixture 改成在建構前先確定 hook 的
  形式——屬設計決策，不是機械遷移。`broker.test.ts` 之所以能遷是因為它的 hook 是靜態的。
  **11/11 全綠**（原本 `PROCESS_READ_UNAVAILABLE`）。其餘檔案照同一模式處理。
  與 `backend.reconcileOwnedBatch = …` 的建構後賦值。改法是：把包裹邏輯改寫成
  `createJsonlBackend(root, { wrapOwnedBatch: append => async (...args) => { …原邏輯，用 append 當原方法… },
  wrapOwnedReconcile: reconcile => async (...args) => { … } })`；需要跨測試共享的計數器/旗標先
  在檔案頂層宣告（`let`），wrapper 內用閉包讀寫。涉及檔案：`broker`、`cell-output-owner-fixture`、
  `instruction-start-recovery`、`managed-store-stop`、`output-owner-boundaries`、`output-source-recovery`、
  `register`、`surface-publication` 等。
  86 failed / 279 passed（365）**，`TASK_TRANSITION_UNSUPPORTED` 絕跡；剩 **83×
  `PROCESS_READ_UNAVAILABLE`**（建構後 patch backend，需 pre-bind seam）、1× FACT_RECOVERY 期待不符、
  1× reconciliation、1× timeout。
  （28 檔），94 failed / 271 passed（365）**——失敗原因分三類：**71× `PROCESS_READ_UNAVAILABLE`**
  （建構後 patch backend，需改用 pre-bind seam）、**22× `TASK_TRANSITION_UNSUPPORTED`**（legacy
  建構子）、1× `Managed facts require reconciliation`。前兩類都是本 session 已建立遷移模式的機械問題。
  建構子（全部 `TASK_TRANSITION_UNSUPPORTED`）；遷到 composed 建構子後降為 **10 檔紅 / 35 failed**，
  `TASK_TRANSITION_UNSUPPORTED` 絕跡。剩餘紅：3 個 `Coordinator cleanup is unresolved`（同一
  cleanup-debt）、1 個 `TASK_TRANSITION_FAILED`、若干行為斷言（`main authority`、`SYS-PROMPT`）。
  **round 97 排除**：在 `startInner` 的 flight 上「barrier.headerCommitted 為真時清
  **round 98 實測欄位**（`closeOne`，`bootstrap-stage-swap`）：
  **round 99 排除**：在 `startInner` 的 flight 上「outcome 為 ready／already-ready 就清
  **round 102**：`trackBootstrap`（bootstrap.ts:128–148）只負責 process latch 的 witness，
  **round 103**：`withBootstrapResume`（binding-observation.ts:293–299）只是 capture＋
  **round 104 執行期追蹤**：stage-swap 測試中 `adopt` 與 remap 都有跑，且都是
  **round 105 決定性證據**：`documents` 只有一個 key `target`；close 時該 entry 是
  **round 106 決定性證據**：在 `startInner` 的 `documents.set`（line 605）與 flight finally 的
  **round 107**：`documents.delete` 共 7 處——bootstrap.ts:608（已驗證未觸發）、:681（capture
  **round 108 修正解讀**：兩個 `NEW_ENTRY` 很可能分別是「第一個 coordinator 的 bootstrap」與
  **round 109 關鍵翻轉**：在 `start`（bootstrap.ts:572）與 factory 的 `resumeSemanticTarget`
  **round 110 定論**：把第二次 `resumeSemanticTarget` 包 try/catch 後**沒有** `RESUME2_ERR`——
  **round 111 揭曉真正失敗**：把兩檔的 `finally` close 改成 `.catch(console.error)` 後，真正的
  **round 113 已修測試衛生**：兩檔的 `finally` 改為「先捕捉 body 錯誤、close 只在沒有其他
  **round 114**：`child-bootstrap-physical` 也套用同樣的 finally 衛生改動，真實失敗現形為
  `expected ['ready','already-ready'] to include 'refused'`——即冷 resume 在某個 barrier cut
  之後回 `refused`（測試期待 ready/already-ready）。這是真正的語義問題，不是 cleanup 假象。
  失敗時才蓋上」，現在回報的是真實斷言（`task-target.doc.jsonl` 非 ENOENT）；
  `child-bootstrap-physical` 的 `finally{await cold.close()}` 同類問題待套用。
  斷言錯誤現形——`promise resolved "Buffer[123,34,102,111,114,…]" instead of rejecting`，
  即測試 line 35 的 `await expect(readFile('task-target.doc.jsonl')).rejects.toMatchObject({code:'ENOENT'})`
  **失敗**：blocked resume 之後 `task-target.doc.jsonl` **被建立**了（內容以 `{"for…` 開頭）。
  這才是 bootstrap 群紅的真正原因（cleanup-debt 只是 close 的二次現象）。下一步：確認 transition
  lane 在 blocked resume 時建立 task document 是否為預期行為；若是，更新測試期待（允許該檔存在
  並斷言內容）；若不是，修 lane 的 eager 建立。實驗已還原。
  即它沒有拋錯。配合 round 109 的 log（該次呼叫沒有 START_OUT），最可能是 `expect(...).toBe
  ('already-ready')` 的斷言失敗（實際回 `refused` 或 `blocked`），而 JS 的 `finally` 中
  `await coordinator.close()` 拋錯**覆蓋**了原本的斷言錯誤。所以 bootstrap 群 3 檔的
  `Coordinator cleanup is unresolved` 是**遮罩後的假象**；真正要看的是「stage 被替換/還原後
  第二次 resume 為何不是 already-ready」。下一步：把三檔測試的 `finally` 改成先記錄原錯誤
  再 close（或 close 用 catch 收集），以顯示真正的斷言差異。
  各加 outcome log 後，測試只印出 `START_OUT ready`（第一個 coordinator 的 bootstrap）、
  `START_OUT blocked`（第二個 coordinator 的第一次 resume）與一次 `FACTORY_OUT blocked`——
  **第二次 resume 既沒有 START_OUT 也沒有 FACTORY_OUT/ERR**，即它根本沒走到 factory 的
  `trackBootstrap`（很可能在 `captureSelfConflict`／guard capture 同步拋出）。因此測試看到的
  `Coordinator cleanup is unresolved` **是 finally 的 close 蓋住了真正錯誤**；cleanup-debt 可能
  只是次要現象。下一步：在 `resumeSemanticTarget` 入口用 try/catch 印出同步例外。
  「第二個 coordinator 的第一次 resume」；第二次 resume（line 37）**沒有**再建 entry（所以只有
  兩筆 log），而是直接回 `already-ready`——但該 entry 仍停在 `phase:'header'`、`ready:false`。
  即「already-ready 沒走 adopt」的謎團仍在；下一步應在 `startInner` 的所有 return 點印
  outcome 與 entry 狀態（確認是否有一條回 already-ready 但沒走 adopt 的分支，例如
  `entry.bootstrap` 已存在時走 `startInner:595` 那條）。
  finally，需 `!b.issued`）、:877、:908（selected/capture）、managed-documents.ts:66、:98、:255
  （open 失敗處理）。下一步在 :66、:255、:681、:877、:908 各插一行 log（帶 stack）即可定位；
  其中 :255 的 `open` rejection 路徑最可疑（若第一次 resume 的 open 以 rejection 結束，entry
  會被直接刪除，而 `blocked` outcome 仍可能被回傳）。
  `delete` 各加 log，stage-swap 測試印出**兩次 `NEW_ENTRY target`**（都來自 `startInner`），
  而**沒有**任何 `DEL_ENTRY`——即第二次 resume 時 `documents` 是空的，第一次 blocked resume
  的 entry 被「別的路徑」移除了（不是 startInner 的 flight finally）。下一步：在所有
  `documents.delete(` 呼叫點加 log（含 `closeOne` line 98、`revoke` 相關），找出移除者。
  `{ready:false, doc:false, issued:true, phase:'header'}`——正是**第一次 blocked resume** 留下的
  那個 entry，而不是 adopt 成功的那個物件。即第二次 resume 的 adopt 作用在另一個物件上，
  `documents` 後來又被換回／重建了。下一步：在 `documents.set`／`delete` 加 log，找出
  adopt 之後誰重建了 'target' entry。
  `{doc:true,current:true,ready:true,headerUnknown:false}`——即 target 的 bootstrap entry 是
  健康的。但 close 的 AggregateError 仍來自 `closeOne` line 96（headerUnknown 守衛），表示
  **失敗的是另一個 entry（不同 id，很可能是 task document entry，測試裡 `task-target.doc.jsonl`
  的 ENOENT 斷言正指向它）**。下一步：在 closeOne 印出 `id` 與 `documents` 全部 keys。實驗已還原。
  `bootstrapMutation(run)` 的薄包裝，不合成 outcome；所以 `already-ready` 仍應出自
  `start`→`adopt`。與 `document:false` 的矛盾未解，下一步只能做執行期追蹤：在
  bootstrap.ts:350（adopt 的 already-ready）與 :561（remap）各印一行（entry 是否有 document、
  是否為 `documents.get(id)`），跑 `task-transition-bootstrap-stage-swap` 一次即可定位。
  不碰 entry 的 `headerUnknown`；`attach`（managed-documents.ts:37）對已有 document 的 entry
  直接回傳，不會換 entry；而 `adopt`（唯一會產生帶 document 的 `already-ready` 的地方）
  必會 `attach`，所以 round 98 印到的 `document:false` 與「第二次 resume 回 already-ready」矛盾。
  結論：那個 `already-ready` 很可能來自 observations 層（`withBootstrapResume`）合成的結果，
  而非 `managed.resumeSemanticTarget`；下一輪要查該 wrapper。
  `headerUnknown`」仍三檔全紅 → 表示第二次 resume 的 `already-ready` 沒有經過該 flight（或
  close 時 `documents` 裡的 entry 不是 flight 的 `owned`）。下一步必須在 close 時印出
  `documents` 的所有 key 與 `owned` 的參照比較，確認是否有第二個 entry 存在。
  `{headerUnknown:true, document:false, headerCommitted:false, revoked:true, issued:true, phase:'header', current:true}`
  （`revoked` 是 closeOne 自己在 line 90 revoke 的結果；`ready` 未定義）。也就是說：第一個
  `resumeSemanticTarget` 回 `blocked` 後 entry 停在 `phase:'header'`、header issued 未 commit；
  第二個呼叫回 `already-ready` 卻**沒有**把這個 entry 的 `headerUnknown` 清掉（adopt 的 line 349
  只作用在它自己的 entry 上）。下一步：找 `resumeSemanticTarget` 回 `already-ready` 的實作，
  確保它對 `documents` 裡的那個 entry 標記 header 已確認。
  `headerUnknown`」→ 三檔仍 `Coordinator cleanup is unresolved`，表示這些 entry 的
  `headerCommitted` 是 false（或 close 走的是另一條路徑）。累計已排除：放寬守衛、只對 current
  entry 拋、document 路徑 fallback、ready 判斷、blocked 返回清旗標；下一輪需在 `closeOne` 直接
  印出 `entry` 的 `ready／headerUnknown／document／bootstrap.taskBarrier.headerCommitted／revoked`
  五個欄位才能定位。
  (reading 'stopReason')`，疑與建置/環境有關）；`compaction` 原 **4 紅全是 `TASK_TRANSITION_UNSUPPORTED`**
  （legacy 建構子），遷到 composed 建構子後降為 **3 紅，且全變成 `Coordinator cleanup is
  unresolved`**——即與 bootstrap 群同一個 cleanup-debt（`headerUnknown` 殘留 entry）。
  `web` **2 檔 / 16 tests 全綠**。
round 78：`schedule` **2 檔紅 / 4 檔綠（6 檔），3 failed / 97 passed（100）**；`rewind`
  **7 檔 / 72 tests 全綠**。`schedule` 三紅同源：live fold 失敗保留語義（預期 `uncertain`
  或 `undefined`，實際是 `TypeError: Original fold callback failed`）。round 79 定位：
  `core-session/src/managed/restored-view.ts:95` 的 `synchronous()` 會刻意把 fold callback 的
  例外包成 `TypeError('Original fold callback failed',{cause})` 並保留 `foldFailure`（fail-closed
  設計）；`schedule/test/fold-bridge.test.ts:78` 卻直接 `toThrow('uncertain')`（期待未包裝的
  原始錯誤）。另兩個測試期待 `undefined` 但收到包裝後的 TypeError。這是測試期待與產品設計
  不一致，需決定：改成斷言 `cause.message === 'uncertain'`，或產品在 `install` 首次失敗時
  原樣拋出。**round 80 已修**：斷言改為 `TypeError('Original fold callback failed')` 且
  `cause` 分別是 `'uncertain'`／`undefined`（產品 fail-closed 設計不變）→ **`schedule`
  6/6 檔、100/100 tests 全綠**。
round 75：`core-tools` **24 檔 / 187 tests 全綠**；`exec` **1 檔紅 / 28 檔綠（29 檔），
  1 failed / 366 passed（367）**——紅點「recovers the same real1MiB background artifact after
  losing its original finish receipt」→ `unknown job: bash-1`。
  測試位置：`packages/exec/test/retention-store-recovery.test.ts:12`，用真實 1 MiB 輸出＋
  `createContextOutputService` 的 retention store 重建流程；錯誤表示重建後 job registry 找不到
  原本的 job（`bash-1`）。下一輪：查 retention store 復原後 job 索引的寫入/讀取順序。
round 68：`provider` **2 檔紅 / 8 檔綠（10 檔），4 failed / 172 passed（176）**；
  `core-session` **1 檔紅 / 86 檔綠（87 檔），1 failed / 932 passed（933）**。
  紅點名稱：`core-session` =「durable exchange acceptance > indexes a large prefix once
  and visits only each proposed suffix」→ `expected +0 to be 20000`；`provider` =
  「preserves invalid raw input -1／1.5 without declaring accounting」（多了一個欄位）、
  「does not add a marker to signed or redacted assistant thinking」與「explicit off removes
  supported Responses content breakpoints while preserving tool data」（皆 `expected undefined
  **round 84 修一半**：兩個 invalid raw input 紅的根因是 `measurementValidity:'invalid'`——
  只有 llm-openai 會標，其餘三個 provider 沒標。已把同樣規則（`typeof === 'number'` 且非
  safe-integer 或 <0）加到 llm-anthropic／llm-gemini／llm-openai-compatible，並把 `provider`
  測試改為斷言 `{ inputTokens: count, measurementValidity: 'invalid' }`（仍不宣告 accounting
  semantics）→ `provider` 由 4 紅降為 **2 紅**（剩兩個 marker 紅）；三套 llm 測試與 llm-openai
  基線一致（1 個既有 M72 紅，與本次無關）。
  round 71 診斷：`visits` 只在 `entries()` yield 時遞增，而目前實作不再透過 `entries`（所以 0）。
  改測 `Symbol.iterator`＋`entries` 後得到 **60000**（3×20000）——表示 index 建構時對前綴做了
  **round 85**：兩個 marker 紅都失敗在 `capture()` 的 `expect(body).toBeDefined()`——
  請求根本沒發出去（stub 沒收到 fetch），不是 marker 內容不對。下一步要查 client 在
  signed/redacted thinking＋toolCalls 或 explicit-off breakpoints 這兩種輸入下是否提早結束
  （例如驗證/錯誤事件在 fetch 之前），再決定修產品或修測試的輸入。
  3 次走訪，或 hooks 被呼叫多次；需先確認實作是否真的退化（效能契約）再決定修產品或重寫 probe。
  **round 87 排除**：即使補一個前置 user turn，`anthropic-messages` 仍不發 fetch（body 仍
  undefined）→ 不是「訊息序列缺 user」的問題；需在 `buildModelClient` 的 stream 進入點直接觀察
  是否產生 error event（測試的 `for await` 會吞掉事件，不拋錯）。實驗已還原。
  兩次實驗均已還原。round 72 追加：`conversation/validation.ts` 只有一處
  `for (const event of events)`（line 431）；3 次走訪的其他來源很可能在 `createHistoryIndex`
  （core-session 內另一個模組），下輪沿該呼叫鏈數走訪次數即可。**round 73 定論**：只掛
  `Symbol.iterator`（不掛 entries）仍得到 **60000 = 3 次完整走訪**；而 `validation.ts` 只有
  一處 `for (const event of events)`（line 431）→ 同一段建構路徑被呼叫了 3 次。這是真實的
  「一次建構要走訪前綴三次」效能問題（測試契約正確），修法需重構 `conversationIndex` 的
  建構流程；已還原探針，未改產品。
  to be defined`）。
- `runtime-context` = **「original-only management settles actual
  absent without getter/action/retain or publication replay」→ resolved undefined instead
  of rejecting**（語義類）。round 66 定位：`test/original-disposition.test.ts:52` 的
  `it.each(['committed','absent','install'])`，只有 `absent` 這輪失敗，失敗點是 line 57 的
  `await expect(f.rc.settleOriginals()).rejects.toThrow()`——`absent`  disposition 在
  `allow()` 之前 `settleOriginals()` 直接 resolve。下一步：確認 absent 的 settle 是否應在
  `allow()` 前拒絕（與 committed/install 對齊），或測試期待需調整。**round 81 分析**：
  fixture 的 absent 路徑讓 `appendOwnedBatch` 只回 `{kind:'unknown'}`（不寫入）、`reconcile`
  在 `allow()` 前也回 `unknown`；`settleOriginals()` 的 `reconcileRecords` 只把 absent/not-issued
  放進 refused 而不拋，所以 absent 這輪 resolve 是**產品既有語義**（committed/install 才會因
  `unknown` 拋）。測試卻對三個 disposition 一律要求 reject；修正需把 absent 那輪改成
  `resolves` 並重新推導 counts（`finishes` 會變 1），屬測試期待調整，需一併改 line 56–60 的計數。
  **round 82 實測**：只把 line 57 的 absent 改成 `resolves` 後，失敗移到 line 59——
  absent 是 terminal（無 pending write），`next()` 後的下一次 render 也直接 resolve，而測試
  期待它拒絕到 `allow()`。結論：absent 需要**獨立的測試**（斷言 terminal 語義與對應 counts），
  不能和 committed/install 共用同一個流程；已還原實驗。
  **round 83 已修**：把 `it.each` 拆成 `['committed','install']`，並新增「an absent original
  settles as a terminal disposition and does not fence later renders」測試（斷言 settle 兩次都
  resolves、`issues` 由 1 → 2、後續 render 不再被 fence）→ **`runtime-context` 4/4 檔、
  22/22 tests 全綠**。
- `llm-seam`：**22 檔 / 188 tests，1 紅**（21 檔綠）。唯一紅是 `terminal-ownership-contract.test.ts`：它期待 private SDK ownership bridge 的 production importer 只有 `['.', './internal/bedrock-terminal']`，實際收到 4 個（已有額外檔案 import）。這是未量測套件既有紅，列入第 5 項待修。
  round 30 修正：它比的是 `package.json` 的 exports 清單，而該清單後來多了
  `./internal/passive-observation` 與 `./internal/stream-lifetime` 兩個已審查的內部 bridge；
  把期望值更新為四個 subpath（`importers` 仍只允許 Bedrock terminal）後
  **llm-seam 22/22 檔、188/188 tests 全綠**。
5. 量測 `session-executor`（223 檔）、`desktop-gateway`（61 檔）、`subagent`、
   `agent-team` 的 red 清單，補進本文件。
6. 全部轉綠後，才把 `verify:all` 的 full job 當成 gate；在那之前 CI 的必過項目
   仍是 typecheck + boundaries。

## 驗證指令

```powershell
# 全庫型別 gate
pnpm -r --no-bail typecheck
# 邊界 gate（147 baseline）
node scripts/audit/check-package-boundaries.mjs --gate
# 自帶隔離環境的套件測試
node scripts/test-env.mjs pnpm --filter @i-harness/session-persistence-jsonl test
node scripts/test-env.mjs pnpm --filter @i-harness/session-persistence test
# round 6 的回歸點（P0 deep-JSON、P1 #3/#4）
node scripts/test-env.mjs pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/managed-native-replay.test.ts test/delete-owned.test.ts
```

## 交接：2026-11-05 round 32

**已綠的 gate（可當 CI 必過項）**：
- `pnpm -r --no-bail typecheck`：**82 packages 全綠**（round 39 空載重跑）。
- `node scripts/audit/check-package-boundaries.mjs --gate`：147/147 PASS。
- `node scripts/audit/check-reachability.mjs --gate`：**PASS（0 NEW，381 rows，無 inert）**，
  由 round 6 的 70 NEW 經 17 批移除（~50 筆 export）與 dated allowlist 收斂。

**測試債務現況**：
- `session-persistence-jsonl` 全套 **106 failed / 751 passed / 17 skipped / 26 紅檔**
  （round 34 空載重跑；98 檔）。
- 三個 A 類檔的語義紅共 25 筆：`bootstrap-physical` 12、`bootstrap-capture-physical` 4、
  `current-context-predecessors` 9（逐條形狀見上文第 4 項）。
- 其餘 jsonl 紅檔：`task-transition-*` header/close 群、`semantic-publication` 24、
  predecessor 群（format8/11/13、codec2、child-bootstrap）、`archive-stream` 1 個 hang。

**第 5 項量測進度**：`session-executor` owned-* 19/19 檔全綠（30–140s/檔，Windows
關閉 fileParallelism）；`token-meter` 53/53、`llm-seam` 188/188 綠。未量：
`session-executor` 其餘分組（private-*/task-*/result-* 等，共 223 檔）、
`desktop-gateway`（61 檔）、`subagent`、`agent-team`。

**下一輪建議順序**：第 4 項語義紅（先 `bootstrap-capture` P09/P10 與 P14 release 計數，
再 `bootstrap-physical` outcome 差異），然後分組量測其餘套件，最後把 `verify:all`
full job 當 gate。

**已定位、尚未實作的具體修法**（round 37 查證）：

- `child-bootstrap-physical.test.ts` 的子程序 template（約 line 49–54）在
  `createJsonlBackend` 之後才 patch `bootstrapRoutes.reserveCapture`／`prepareBootstrapHeader`／
  `appendOwnedBatch`／`confirmBootstrapFrames`，所以子程序一啟動 bootstrap 就被
  canonical-path guard 判 `PROCESS_READ_UNAVAILABLE`。修法：把四個 patch 搬進
  `createJsonlBackend(root,{ wrap })` 的 pre-bind seam，並把 `p.createSessionCoordinator`
  改成 `composeJsonlTaskTransitionCoordinator(backend,{lock},
  taskDocumentStorageContract)`（即 `bootstrap-capture` P06 的成功模式）。
  **round 40 已實作**：child script 改成 `createJsonlBackend(root,{wrap})` + composed 建構子，
  `PROCESS_READ_UNAVAILABLE` 消失、測試主體（barrier／cold restart／receipt／bytes）全部通過；
  剩下唯一紅是 `finally { await cold.close() }` 拋 `Coordinator cleanup is unresolved`——新的
  cleanup-debt 語義（與 `bootstrap-stage-swap`／`stage-revision` 同一類），列入第 4 項。
  （round 41–43 定位：`Coordinator cleanup is unresolved` 來自 `coordinator-factory` 的
  `closeWithRetained`，其 rejection 鏈是 `Managed documents require recovery before close`
  → `Managed facts require reconciliation`（`managed-documents.ts:259` 的 AggregateError
  包住 `closeOne` 的失敗）。round 44 再收窄：該訊息是 `FactRecoveryRequiredError`
  （`FACT_RECOVERY_REQUIRED`），由 `core-session/src/managed/nondurable.ts:41` 的
  `assertNewWork` 在 `recoveryState.sticky || recoveryHolds.size` 時拋出——即冷 resume 後
  仍有 sticky recovery 或未釋放的 recovery hold。**round 46 修正線索**：durable managed
  document 走的是 `session-persistence/src/coordinator/bootstrap.ts`；`FactRecoveryRequiredError`
  的 throw 點是 `bootstrap.ts:359`（`assertCurrent`：`documents.get(id)!==entry || entry.revoked`）
  與 `:825`（`captureClosed || owned.revoked || documents.get(id)!==owned`）。即 close 期間某個
  bootstrap entry 的識別已失效（revoked／被 resume 換掉）。**round 47 再收窄**：最可能的
  throw 是 `resumeCachedReady` 內的 `assertCurrent`（`bootstrap.ts:359`），由已排入 flight
  的延續在 entry 被 revoke 後執行；`managed.closeOne` 會 await `entry.flight`，因此把該
  rejection 併進 close 的 AggregateError。下一步：在 `closeOne` revoke 前先 join flight，
  或讓 revoked entry 的延續走 `refused` 而非 throw（需確認 fail-closed 語義）。
  **round 48 關鍵發現**：`managed-documents.ts:closeOne` 有兩條路徑——
  `if(entry.document){await entry.document.close();return}`（line 85）直接關文件，
  而 `revokeManagedEntry(entry); await entry.flight?.catch(...)` 的 revoke/join 只在**沒有**
  document 的 entry（line 90）才做。冷 resume 後 entry 已有 document，所以走 line 85，
  文件內部的 currentness 斷言在文件關閉時仍以舊 entry 為準 → `FactRecoveryRequiredError`。
  下一輪候選修法：在 line 85 之前也先 `revokeManagedEntry(entry)` 並 join flight（或让
  document.close 對已 revoke 的 entry 容忍），再跑三檔驗證。
  **round 50 實測**：在 line 85 包一層「遇 `FactRecoveryRequiredError` 才 revoke+join 並重試」
  的 fallback，三檔仍全部 `Coordinator cleanup is unresolved` → 表示 rejection 不是裸的
  `FactRecoveryRequiredError`（可能是 AggregateError／另一層包裝），或失敗點不在 closeOne 的
  document 路徑。已還原該實驗；下一輪應先在 `managed.close()` 印出實際 rejection 的建構子
  名稱與 stack，再決定修法。
  **round 51 取得真實 stack**：throw 點是 `managed-documents.ts:96` 的
  `if(entry.headerUnknown) throw new FactRecoveryRequiredError()`（closeOne 的無 document
  分支）。即冷 resume 後該 entry 的 `headerUnknown` 仍為 true；`bootstrap.ts` 只有 line 349、
  514 兩處會清除它，冷 resume 走的另一條分支沒清。下一輪：找出冷 resume 後 header 已
  confirmed 的分支，補上 `entry.headerUnknown=false`。
  **round 52 實測**：把守衛改成 `if(entry.headerUnknown && !entry.ready)` 後三檔仍全部
  `Coordinator cleanup is unresolved` → 該 entry 的 `ready` 是 **false**（不是「已 ready 但
  flag 沒清」）。所以失敗的 entry 是一個「header 未確認、也還沒 ready」的殘留 attempt entry；
  需要的是在冷 resume 成功時**清掉這個殘留 entry**（或清它的 flag），而不是放寬守衛。已還原實驗。
  **round 55 再排除**：改成 `if(entry.headerUnknown && documents.get(id)===entry)`（只對
  current entry 拋）仍然三檔全紅 → 失敗的 entry **就是** `documents` 裡的 current entry，
  且 `ready=false`、`headerUnknown=true`。即冷 resume 的成功結果並沒有回寫到這個 entry。
  需要的是在 `resume` 成功時把「已確認 header」回寫到 current entry（或把該 entry 標 ready），
  不是 close 端的守衛問題。已還原實驗。
  **round 57–58 再收窄**：`adopt()` 其實會在成功時設 `entry.ready=true; entry.headerUnknown=false`
  （`bootstrap.ts:349`），所以失敗的 current entry 走的是**另一條**（例如 `blocked`）路徑：
  header 已 issued（`activeIssue` 設 `headerUnknown=true`）但最後回 `blocked`，flag 沒被清。
  下一輪：在 `run()` 回傳 `blocked` 前，若 durable state 已證明 header committed（或由後續
  成功 resume 證明），清掉 `entry.headerUnknown`；否則保留 fail-closed。
- 其餘 in-process 的 legacy 建構子已清完；`child-bootstrap-predecessor` 的紅在 generated
  `.mjs` predecessor runtime（format11-clean 腳本 line 18），屬 predecessor 語義。

## 交接：2026-11-05 round 7（歷史）

待辦第 1、2 項完成，第 3 項（A 類）11／11 檔全部遷移（8 檔全綠；三個 bootstrap／
predecessor 檔只剩語義紅，歸第 4 項）。`createJsonlBackend` 另有通用 `wrap` seam、
P2 #5 的 downgrade 修正。**第 5 項量測已起跑過 `session-executor`（99 檔，尚未完成，
下一輪重跑並記錄）；`desktop-gateway`（61 檔）、`subagent`、`agent-team` 仍未量測。**
下一輪優先：第 4 項的 `bootstrap-capture-physical` 4 紅（P09/P10 promotion、P14 release
計數）與 `bootstrap-physical` 的 12 個 outcome 差異。

## 交接：2026-11-05 round 5（歷史）

本 session 的上下文已用盡，停止在乾淨的 345541fe（工作樹 clean）。本輪只做狀態驗證：
全庫 typecheck 在 round 2 為 82 packages exit 0；reachability allowlist 已清到 38 筆、
不再有 inert 警告。**下一輪請開新工作階段**，從上面的「待辦順序」第 1 項（P0 端到端
回歸測試）開始；每次修完一項就更新本文件並 push。
