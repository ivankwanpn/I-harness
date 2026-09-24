# M80 殘餘稽核（Part 1：舊半）— Tier-1 鏈關閉 ＋ Tier-2 四鍵

**這是什麼**：`docs/handoff/2026-09-24-m80-backend-readiness.md`（M80 收線紀錄）的**稽核輸入**——把舊半（M69–M75 ＋ W6，共 **113 條**）的每一條具名殘餘，沿鏈關閉或逐條歸類。方法逐條照 spec §1.3（`docs/superpowers/specs/2026-09-24-m80-backend-readiness-design.md`）。

**輸入**：`.superpowers/sdd/2026-09-24-m80-backend-readiness/task-6-input-old-half.md`（spec 前量測代理的清單；`path:line` **以內容定位**，行號是那次量測的數字）。本表的來源欄保留該清單的編號與行號（`M69 1（:84）`＝該節第 1 條、行號 `:84`），每一條**恰好出現一次**（**W6 的 19 列例外**：座標是該紀錄自己的節號，如 `W6 §2.5-1（:162）`，因為輸入清單的 W6 項本身就是以節列寫的）。

**來源標籤**（全在 `docs/handoff/`）：

| 標籤 | 檔案 | §5 的位置（輸入清單所引） |
|---|---|---|
| M69 | `2026-09-22-operator-run-end.md` | `:82-89` |
| M70 | `2026-09-22-m70-dispatch-boundary.md` | `:65-70` |
| M71 | `2026-09-22-m71-residuals.md` | `:108-121`（＋§2 的四列 `:74-77`） |
| W6 | `2026-09-22-w6-diagnostics.md` | §2.5 `:162-177`、§7 `:257-263` |
| M72Ⅰ | `2026-09-23-m72-phase-1.md` | `:72-80` |
| M72Ⅱ | `2026-09-23-m72-phase-2.md` | `:86-97`（＋`:103`） |
| M72Ⅲ | `2026-09-23-m72-phase-3.md` | `:114-126`（＋§5 `:132-136`） |
| M73 | `2026-09-23-m73-provider-budget-chain.md` | `:96-107`（＋§5 `:113-116`） |
| M74 | `2026-09-23-m74-child-budget-compaction.md` | `:94-100` |
| M75 | `2026-09-23-m75-over-window-summarization.md` | `:95-102` |

**兩層的判準（本表的讀法）**：

- **§A Tier-1**：該條的**每一個具名部分**都被後續里程碑關掉 ⇒ 引用關閉它的紀錄 ＋ commit。若只剩一個**已被另行裁定**的殘餘（例如逐列 allowlist 的 dated 裁定），在該列**具名**，不另開列。
- **§B Tier-2**：至少一個具名部分在 HEAD 仍開 ⇒ 落四鍵之一（①修掉了／②等前端／③產品決定／④明說接受的成本）或 **`UNMEASURED`**；同列若另有部分被後續里程碑關掉，**在證據欄寫出關閉者＋commit**（不靜默丟棄；該半以「⇒ ①」標出）。`UNMEASURED` 只在該條**整體量不到**時使用，並具名量不到的東西。
- 提示的查核：輸入清單的「⇒ Mxx 收」是推測。**查核結果：三條提示錯／半錯**——M72Ⅱ `:89`（不是 M77，是 M72Ⅲ）、M72Ⅲ `:123`（不是 M79）、W6 `:167`（五個相位斷言是 M71 T3 不是 M79）；見各列。
- **量的時間**：2026-09-24，`m80` 分支 `6d35ee8` 的樹（HEAD）。測試的存在性以檔案內容為準；型別／欄位以 `grep`／`sed` 讀數為準。**沒有跑 `pnpm verify:all`**（Task 8）。

**計數**：**Tier-1 20 列｜Tier-2 93 列（其中 `UNMEASURED` 2 列）＝ 113 條**。

---

## §A Tier-1：沿鏈關閉（20 條）

| 來源 | 一句話 | 關閉者（紀錄＋commit） |
|---|---|---|
| M70 2（`:68`） | Q8 的字面重讀（全 log 無標記 ⇒ 未知）parked 觸發項 | M71 紀錄 §5.2（`docs/handoff/2026-09-22-m71-residuals.md`）—— `ebcabbf0`（`boundaryProven` 全 log 檢查，`repair.ts:143`）＋ `c473e6f1`（M4 判別器修回、加 `earlier-turn-marker`） |
| M71 3（`:112`） | 五個便宜、可驅動、這次沒驅動的站點（plugin-registry `commands.ts:76`、hooks `trust.ts:87`、sdk `server.ts:224`／`:230`、core-plugin `index.ts:458`） | M79 紀錄 §2.4 —— `c0d1ea1`（五格各以「拿掉 `installDiagnostics` ⇒ 斷言紅」為紅先）。HEAD 親量：五處都出現在對應的 `site-diagnostics.test.ts`（`packages/{plugin-registry,hooks,sdk,core-plugin}/test/`） |
| M71 5（`:117`） | dated 快照仍寫「M4 完成（只差 Q8）」（`:11`／`:28`／`:219`） | M80 Task 5 —— `00067ec`（＋`10c6558`／`6d35ee8`）。HEAD 親量：`grep -n "只差 Q8" docs/handoff/2026-09-18-backend-backlog.md` ＝ **0**；該檔 `:30`／`:209`／`:220` 都載了 ▶ 2026-09-24 的更正 |
| W6 §2.5-1（`:162`） | 儀器盲區的實例（§5 三則） | M79 §2.6 —— `cd188d7`＋`6bd35c7`（class 1 的「有沒有被用」改讀**剝掉註解**的文字）。HEAD 親量：`node scripts/audit/check-reachability.mjs` 的 456 findings 裡**沒有** `@i-harness/diagnostics#Diagnostics`——真消費者是 `apps/cli/src/diagnostics-bootstrap.ts:52,76`（不再是「只被註解提到」）。**殘餘（具名）**：第 2 則（`#RedactedError`）的成因是 re-export 塗白、不是註解，仍在 findngs 內，靠 `scripts/audit/reachability-allowlist.json:191` 的 dated 裁定（M1 R-L／M2 Task 4 刻意不修） |
| W6 §2.5-6（`:167`） | 六個可翻相位沒有測試斷言；`telemetry`／`acp` 兩個 union 成員零站點 | **M71 T3（五個相位斷言）**：`4b57999`（schedule）、`0b3d613`（compaction）、`8188dab`（plugin-registry state）、`f39c54f`（output-retention）、`aff475b`（subagent child）＋ **M79** `a629acd`（移除兩個零生產者成員）。⚠ **提示半錯**：輸入清單與 W6 的 ▶ 指針（由 M80 `00067ec` 寫入）都寫「M79 收五個」；逐檔 `git log -S` 量到的關閉者是 **M71 T3**。**殘餘**：`subagent/tools.ts` 的 `session` 站（今天 `:829`）——見 §B |
| W6 §2.5-7（`:168`） | 縫的覆蓋缺口：`schedule/driver.ts:106`／`workflow/registry.ts:31` 的預設體沒被行使；hooks／skills 行使未斷言；`plugin-registry/state.ts:74`／`credentials:243` 只有 `toHaveBeenCalled()`；沒有 package 測試 install 實例 | M71 T3（R15 的網：九個套件九個新檔，`8188dab0`／`aff475b9`／`0b3d6131`／`4b579990`／`f39c54f4`／`e7f1d9da`／`0c8b30eb`／`9edad4a4`／`0c47bd46`）。HEAD 親量：六個縫檔（`schedule`／`workflow`／`skills`／`credentials`／`hooks`／`plugin-registry`）的 `site-diagnostics.test.ts` 都在，且都以 `toMatchObject({ phase, level })` 斷言——`schedule/test/site-diagnostics.test.ts:82` 即 `{ phase: "session", level: "warn" }` |
| M72Ⅱ §5.1（`:88`） | 拒答沒有自己的通道（五家都 200 空成功） | M77 紀錄 §2 —— `26ec2359`（seam 的 `refused?: true`）＋ `6651e49`（五家各自的字面，含 anthropic 的 context 臂走既有 `CONTEXT_WINDOW_EXCEEDED`）＋ `9ef0ed5`（`step/end.refused`／telemetry／CLI／`result.refused`）；fix wave `282e81e`／`bf85c64`／`ccb9df0`（三家的**內容側**載體） |
| M72Ⅱ §5.2（`:89`） | `ANTHROPIC_MAX_TOKENS_FALLBACK`（128 000）從不經過夾取；兩條可達路 | **M72Ⅲ §2.4** —— `c103984`（常數改在 provider-runtime 解析，只有 `anthropic-messages` route，隨 `maxOutputTokens` 進 binding ⇒ 夾取看得到）。HEAD 親量：`packages/provider-runtime/src/index.ts:676`。⚠ **提示錯**：猜「M77 fix wave 的 context 臂」；M77 的 `97e2c39` 是 context 臂**保留 usage**，與這條無關 |
| M72Ⅱ §5.4（`:91`） | compat 的殘餘 flush 缺 `tool_calls` 片段累積（無邊界末幀的工具呼叫被丟） | M72Ⅲ §2.5 —— `dce8cfd`（兩個 frame 迴圈合成一個 `handleFrame`，兩條規則各只落一處） |
| M72Ⅱ §5.5（`:92`） | 子代理拿不到上限——兩個站點（`child.ts:270-317`、`tools.ts:657-666`） | M73 紀錄 §2.1 —— `d42c342`（spawn：binding／host 形狀 ⇒ `AgentDeps.maxOutputTokens`＋`budget`）＋ `7fbbfb1`（rebuild 的孿生，同時修掉掉 `SUBAGENT_PROMPT_CONTRACT` 的缺陷） |
| M72Ⅲ §4.1（`:114`） | 拒答仍沒有自己的通道 | M77（同 §A 第 7 列）—— `26ec2359`／`6651e49`／`9ef0ed5` |
| M72Ⅲ §4.2（`:115`） | `compaction/src/summarizer.ts:181` 自建 request、不帶 `maxOutputTokens` | M73 §2.3 —— `f599e79`（cap 傳進引擎、在窗口在手處用 `clampOutputCap` 夾一次）＋ `064500a`（連 host overhead 一起計） |
| M73 §4.1（`:96`） | 子代理有窗無 compactor ⇒ 階梯第 1、2 層對它不可用 | M74 §2.2 —— `5e33726`（兩個建構點各一個 `compact` 鍵，缺席即缺席）＋ `f87b00d`（rebuild 側獨立見證） |
| M73 §4.5（`:100`） | 四個「窗口那半」的 hop 沒有觀察者（`assembly.ts:1146`／`:1182`、`agent-team/scheduler.ts:221`、`guard-approval/reviewer.ts:178`） | M79 §2.5 —— `3b37ed3`（四站誘餌觀察者；三顆**相異**誘餌值，四顆變異逐一殺死具名斷言） |
| M74 §5.1（`:94`＋`:72`） | 超窗時「壓縮」實為 reset（分段摘要／prune-warn 兩個候選） | M75 紀錄 §2.1 —— `f9356e0`（切塊、串連摘要；該區從 2 個請求回到 1）＋ M76 §2.2 —— `d5d1144`／`c2e9e60`（種子端 warn 的門檻與它自己的算術）。**殘餘**：切不動的單一巨塊仍走 fail-soft ⇒ reset（M75 §5 具名，見 §B M75 9） |
| M74 §5.2（`:95`） | `rewind/point` 的 `anchorSeq` 沒有被重映射也沒有被丟掉 | M76 §2.3 —— `fefe660`（`remapSeedEvent` 對 `rewind/point` 用同一份 `renumbered`；缺席落點是正確投影） |
| M75 §5.1（`:95`） | 種子端的約束（要先重排 `resolveModel`，順帶關掉一個真的洩漏） | M76 §2.2 —— `f8eb14a`（閘 → `resolveModel` → `coordinator.create`；非 ready 不留 durable session／表項／job）＋ `d5d1144`（種子 warn 說出後果，只警告不修剪） |
| M75 §5.2（`:96`＋`:68`） | 既有的走位漏洞：M70 的 `tool/dispatch` 讓守衛靜默失效（16/71 走位後還是 16） | M76 §2.1 —— `590b2c6`（判準改問 **result 側**；16/71 → **0**；57 433 個（日誌, 切點）配對的窮舉釘住極大性） |
| M75 §5.6（`:100`） | prune 在摘要之前（標記在摘要成功之後才附加 ⇒ 摘要器一份都沒省） | M78 紀錄 §2 —— `0336fe4`（標記移到摘要嘗試之前 ＋ `deriveMessagesUpTo` 的 seq 濾網對 `compaction/prune` 破例）。讀數：15 390 → 11 673 token |
| M75 §5.7（`:101`） | `anchorSeq`（M74 的殘餘，未動） | M76 §2.3 —— `fefe660`（與 §A 第 16 列同一條路） |

---

## §B Tier-2：仍開者逐條四鍵（93 條；`UNMEASURED` 2 條）

| 來源 | 一句話 | 鍵 | 證據（指令／讀數） |
|---|---|---|---|
| M69 1（`:84`） | R11：`runId` 可從 `sessions show --json` 取回，但沒有給人看的行；需求決定已交棒 | ③ 產品決定 | 問題：要不要在人看的行渲染 `runId`，或加進 row 投影（**別洩進 `sessions list --json`**——那是刻意的白名單）。HEAD 親量：`grep -n "runId" apps/cli/src/sessions.ts` ＝ **0**；`sessions.ts:40` 的 row 投影只有 `lastRun: { exitCode, durationMs, error? }` |
| M69 2（`:85`） | R8：宿主自帶 `opts.session` ⇒ 紀錄只留在記憶體（無 shipped path 觸發）；`sdk`／`acp` 的 run-end 仍是 spec §3 的具名殘餘 | ④ 明說接受的成本 | 代價＝embedder 同時給 `session` 與 `coordinator` 時看不到紀錄；CLI 行為不變（M69 §3 R8）。紀錄把它記為「真實但不可達的 minor」，沒有任何里程碑動它 |
| M69 3（`:86`） | 漂移檢查是單向的：`DiagnosticPhase` ⊆ 內聯 union 編譯器抓得到，反向不會 | ④ 明說接受的成本 | HEAD 親量：內聯複本仍在 `packages/core-session/src/index.ts:151`（八個字面）；`packages/diagnostics/test/phase-union.test.ts:29-32` 只釘**套件自己**的 union（`NoExtra`／`NoMissing`）；`grep -rn "DiagnosticPhase" packages/core-session/test` ＝ **0**。M79 §5 自己記「內聯複本靠人手」 |
| M69 4（`:88`） | T3 deferred minor：`toContain("—")` 不隔離 LAST RUN 格；「缺席而非 `undefined`」沒有斷言 | ④ 明說接受的成本 | HEAD 親量：`apps/cli/test/sessions.test.ts:133` 仍是 `toContain("—")`；全檔沒有 `not.toHaveProperty("lastRun")`；`git log --oneline b48c289..HEAD -- apps/cli/test/sessions.test.ts` **空**（自 M69 未動）。終審判「可接受」 |
| M69 5（`:89`） | T1／T2 deferred minor：註冊區塊前少一空行 | `UNMEASURED` | **量不到**：**真正的阻塞＝紀錄從未指出是哪一個 block**（只說「T1／T2 的註冊區塊」）；唯一候選（`packages/session-persistence/src/index.ts` 的 `registerEventType` 區）在 M70 插入 `tool/dispatch` 列之後，原始間距也難由內容重建（`git log -p` 未逐段追）。量到的只有：它是一行可讀性項、從未進任何 fix 清單 |
| M69 6（`:79`） | §4.2 的後果：ephemeral run（無 `--session-dir`）永遠不留紀錄；比 spec §4.1 廣 | ④ 明說接受的成本 | HEAD 親量：`apps/cli/src/index.ts:337` 的錯誤訊息自己明說「headless runs are ephemeral without a store」；`:325-348` 只在 `--session-dir` 分支接線 coordinator ⇒ 邊界成立且**已寫進 M3 spec 的落地註**（M69 §4.2） |
| M69 7（`:51-55`） | §2 仍待辦：fix-wave diff 的限定複審；合併時機＝owner 的；gitignored ledger 的 R11 措辭未更新 | `UNMEASURED` | 量到的：**合併已發生**（PR #2 → `b48c289`）。**量不到的**：①限定複審的結果（住在 gitignored 的 `.superpowers/**` ledger）；②ledger 自己的 R11 措辭（同上）。兩者在樹上都無痕跡，不假裝讀過 |
| M70 1（`:67`） | 載入失敗的子代理 entry 留著 `createSessionFromEmpty()` 佔位；append 到不了 write-behind，`flush` ＝ 0 筆後端寫入；entry 以 `error` 現形 | ④ 明說接受的成本 | HEAD 親量：佔位仍在 `packages/subagent/src/persist.ts:124`（helper 在 `:155`）；M70 §5.1 明說「**不修** —— 那是 resume 路徑的耐久修復，不是本單元」 |
| M70 3（`:69`） | parked Minors：abort／refusal 的支配巧合會蓋掉 store 錯誤的訊息；沒有「mid-batch flush 被拒＋兄弟取消」案例；先到先贏套在**值**上 | ④ 明說接受的成本 | 代價寫在 M70 §5.3（turn 兩種都失敗，**沒有靜默續行**；`run.ts` 以 `instanceof Error` 防守）。M71 §4.2 把「先到先贏」的值側代價一併量清（`execute-tool-calls.ts:495-498`） |
| M70 4（`:70`） | `tools.ts` 的 resume 子代理站點被探針 C 量過，但**沒有 package 測試釘它** | ④ 明說接受的成本 | HEAD 親量：`grep -rn "M70" packages/subagent/test/*.ts` 只命中 `child.test.ts`（`:195`／`:281`／`:286`，**spawn** 側的 checkpoint）；`resume.test.ts` 零個 `M70` ⇒ resume 側仍只有探針，沒有 pin。順帶：62 筆 `spill GC failed: ENOENT` 前後同數（M70 §5.4） |
| M70 5（`:49`） | 使用者可見副作用：checkpoint 抽乾的是前綴 ⇒ 耐久讀者在**本體還在跑**時就看見本 turn 的 `tool/call` | ④ 明說接受的成本 | 數字：10 次 durable 寫入／62 ms vs pre-M70 0 次／16 ms（M70 §2 的真實後端探針；M78 §3 再確認並把批次化判為「等儲存變遠端再做」） |
| M70 6（`:55`） | §3 R15：舊的反對現在是規則的 accepted cost——每個從未派送過的 session（含被拒）整份讀 unknown | ④ 明說接受的成本 | owner 接受的正是這個（M71 §2 第 3 列）；落點 `packages/session-persistence/src/repair.ts:82` 的 ACCEPTED COST 註（HEAD 親量：`grep -n "ACCEPTED COST" repair.ts` → `:82`） |
| M71 1（`:110`） | `subagent/src/tools.ts` 的 `session` 站仍無守衛（34 個裡唯一「量過驅不動」） | ④ 明說接受的成本 | HEAD 親量：站點今天是 `tools.ts:829`（handle 宣告 `:28`）；`packages/subagent/test/site-diagnostics.test.ts:10-12` **自己**把「`tools.ts:28` 的 handle（`session`）不被覆蓋」寫成報告——覆蓋清單誠實，不是缺口被藏 |
| M71 2（`:111`） | R15 覆蓋帳：44 個 package 站點 ＝ 38 handle ＋ 6 縫；已覆蓋 10／44 | ④ 明說接受的成本 | HEAD 重量（同一條 grep）：**39 handle ＋ 6 縫 ＝ 45**（`grep -rn '\bd[0-9]*\.\(warn\|error\)(' packages/*/src` ＝ 39；縫 ＝ 6）。多出的 1 條是 `subagent/src/child.ts:399`（M79 §5 已點名）。已覆蓋 **15**（M71 的 10 ＋ M79 的 5）⇒ **未覆蓋 30** |
| M71 4（`:113`） | 28 個較重（真縫／大 fixture）的站點未覆蓋 | ④ 明說接受的成本 | HEAD 親量：`ls packages/*/test/site-diagnostics.test.ts` ＝ 11 檔，其中 `mcp-client`（8 站）／`session-executor`（13 站）／`rewind`（2 站）**沒有**這種檔；`plugin-registry` 有檔但只蓋 `state.ts:78`／`agents.ts:112`／`commands.ts:76` 三站，不含它那 5 個較重的（`index.ts:257`／`:268`／`:488`、`install.ts:140`／`:151`）⇒ 28 站仍在未覆蓋的 30 之內 |
| M71 6（`:118`） | `apps/cli` 的 10 個 handle 不在 R15 的網裡（由 `diagnostics-bootstrap.test.ts` 釘） | ④ 明說接受的成本 | HEAD 親量：`grep -rn 'level).toBe("warn")' apps/cli/test/*.ts` ＝ 0；`apps/cli/test/diagnostics-bootstrap.test.ts` 在（11 個 `it`），但斷言的是 install／close 生命週期，不是每個站點的 phase／level ⇒ 這是**範圍**，M71 §6.6 已具名 |
| M71 7（`:119`） | Q8 的範圍是整份 log 不是每個呼叫：沒有縫時，一個活著的兄弟 marker 讓整份 log「已證明」 | ④ 明說接受的成本 | 機制在 `repair.ts:143` 的 `events.some(...)`（全 log）；代價是「不是回歸，是範圍比第一版的讀法窄」（M71 §6.7） |
| M71 8（`:120`） | Q8 不回溯：被更舊 build 修過的 log 保留當時的裁決 | ④ 明說接受的成本 | by design（M71 §6.8）；讓已接受的代價只落在**此後**才修復的 log 上 |
| M71 9（`:74`） | R14 accepted cost：值遮蔽（`secrets: 42` 被整個遮掉） | ④ 明說接受的成本 | HEAD 親量：`packages/diagnostics/test/redactor.test.ts:112` `expect(r.redact({ secrets: 42 })).toEqual({ secrets: TOKEN })` ——代價**釘在測試**（同 M71 §2 第 1 列） |
| M71 10（`:75`） | R14 accepted cost：flag 形狀過度遮蔽（`noSecrets: true` → `[REDACTED]`）；接受不修、未釘 | ④ 明說接受的成本 | HEAD 親量：代價寫在 `packages/diagnostics/src/redactor.ts:132`（「same price buys the flag-shaped compounds」）；測試檔沒有對應的 pin（M71 §2 第 2 列） |
| M71 11（`:76`） | Q8 拒絕類 accepted：guard／approval／guardian／unknown-tool 都 throw、什麼都不寫 ⇒ 從未派送讀 unknown | ④ 明說接受的成本 | 機制逐點可查（`packages/core-tools/src/index.ts:311`／`:351`／`:354`／`:363`／`:366`／`:380`，M71 §4.2 親量）；`repair.ts:82` 的 ACCEPTED COST 註以第二個實例明說它 |
| M71 12（`:77`） | R15 無行為代價，只有覆蓋帳 | ④ 明說接受的成本 | 帳的現況見本表 M71 2／4（45 站、覆蓋 15、未覆蓋 30）；代價是「**沒**寫的假斷言」（誠實清單，M71 §6） |
| W6 §2.5-2（`:163`） | R5 具名殘餘：`\bBearer\s+\S+` 過度遮蔽散文 | ④ 明說接受的成本 | HEAD 親量：規則仍在 `packages/diagnostics/src/redactor.ts:213`；代價寫在 `:52-54`（「the sentence 'the Bearer scheme is unsupported' loses the word after `Bearer`」）——少一個字 vs 活憑證外洩 |
| W6 §2.5-3（`:164`） | T4 shutdown 記帳：`uncaughtException`／`unhandledRejection` 的 `process.exit(1)` 繞過 `finally` | ④ 明說接受的成本 | HEAD 親量：`apps/cli/src/index.ts:63-66`——`for (const event of [...])` 的處理器裡 `process.exit(1)`；兩個 sink 都 flush-free ⇒ 今日無害（W6 §2.5-3 原文） |
| W6 §2.5-4（`:165`） | 普查精度：(a) 六行縫 fallback 是可見子群（重跑讀 12 行）；(b) `mcp-client/src/oauth.ts:233` 的 `console.info` 在普查外 | ④ 明說接受的成本 | HEAD 親量（(a) 重跑同一條普查指令）：`grep -rn -F -e "console.warn(" -e "console.error(" packages/*/src \| grep -v test` ＝ **12 行** ＝ 6 縫 fallback ＋ `diagnostics` 自己的 3 ＋ 3 條例外（`session-persistence:257`／`telemetry:11`／`:13`）。(b)：`grep -rn "console\.info" packages/*/src` ＝ 3 行，扣掉 `diagnostics/src/index.ts:138`（委派通道）與 `mcp-client/src/types.ts:31`（註解）⇒ **1 個生產站** |
| W6 §2.5-5（`:166`） | `record.err` 沒有站點級寫者（44 個站點只傳 `msg`） | ④ 明說接受的成本 | HEAD 親量：`grep -rn '\.\(warn\|error\|info\|debug\)(`[^`]*`,' packages/*/src apps/*/src --include=*.ts` ＝ **0**（沒有任何生產呼叫傳第二／第三參數）⇒ 這條**今天仍然成立**，不是舊話 |
| W6 §2.5-8（`:169`） | §7 deferred minors 全份交給 final triage；T7 沒修 | ④ 明說接受的成本 | 最終整支複審（W6 §2.7）逐條 triage 為 **safe-to-leave** ⇒「不修」是複審的判定，不是省略（本表逐條落在下面 W6 §7 各列） |
| W6 T7-1（`:173`） | T4 測試改寫是五條（R10 寫四條） | ④ 明說接受的成本 | HEAD 親量：`apps/cli/test/diagnostics-bootstrap.test.ts` 的 SUCCESS 出口案例用的是 `console.log`、**不在遷移通道**上（W6 §2.5 精度註 1 已說出「五」） |
| W6 T7-2（`:174`） | SUCCESS 出口的捕捉點變窄、非嚴格等價 | ④ 明說接受的成本 | 四條性質逐條保留、case ① 反而變強（多一條 `toHaveLength(1)`），但可觀察範圍較窄（W6 §2.5 精度註 2） |
| W6 T7-3（`:175`） | 「50 站走 handle」≠「50 站寫記錄」（只在三條路徑 install） | ④ 明說接受的成本 | HEAD 親量：`grep -n "createCliDiagnostics" apps/cli/src/index.ts` → `:477`／`:597`／`:847` **三條** install 路徑（行號自 W6 的 `477/585/835` 漂移，數量不變）⇒ 契約成立 |
| W6 T7-4（`:177`） | `durMs` 在 W6 沒有生產者 | ④ 明說接受的成本 | HEAD 親量：`grep -rn "durMs" packages/*/src apps/*/src` → 只有型別宣告 `packages/diagnostics/src/record.ts:116`，**零生產者** |
| W6 §7 T1（`:257`） | 雙重 install／uninstall、`stream` 勝 env 未測；`durMs` 無生產者 | ④ 明說接受的成本 | HEAD 親量：`packages/diagnostics/test/diagnostics.test.ts` 的 19 個 `it` 裡沒有「install 兩次」的案例（`grep -n "twice"` ＝ 0）；三個 `I_HARNESS_LOG` 案例（`:154`／`:169`／`:183`）都**不傳 `stream`** ⇒ 優先序仍未測。`durMs` 見上一列 |
| W6 §7 T2（`:258`） | (a) `index.ts:29` 的 `fromError` re-export 無套件外消費者（一行可刪）；(b) no-err-key 只釘 wire 形狀；(d) 非 Error 的 `name = typeof err` | ④ 明說接受的成本 | **(a) 已由 M69 關掉**（`fb0349f`，PR #2）：HEAD 親量 `apps/cli/src/run.ts:33` 從套件根 import `fromError`、`:390` 消費它 ⇒「一行可撤」的建議失效。(b)(d) 仍開（語意選擇，W6 §7 T2 原文）；(c) 早已由 T3 `99c287e` 履行 |
| W6 §7 T3（`:259`） | (a) base64 鍵名 fence 比 §3.5 寬；(b) `toJSON` 回傳自身時 UNSCANNED；(c) 衍生副本邊角；(d) 循環引用只在報告；(e) 洩漏 payload 缺 scan-① 樣本；(f) 規則序 fixture 不重疊 | ④ 明說接受的成本 | HEAD 親量：(b) 仍在——`packages/diagnostics/src/redactor.ts:323-327` 的 identity 檢查對「回傳自身」的 `toJSON` **原樣回傳**（`serialised === value ? value : redact(...)`）；(e) 專屬案例仍抓得到（W6 §7 T3 原文）。其餘為已量到的 dead-code／罕見形狀辯護 |
| W6 §7 T4（`:260`） | (a) `env` 名不實；(b) resume-exit 兩出口共用 `toContain`；(c) sdk／acp 的 install→teardown 拋出窗可 `try/catch` 化；(d) `MIN_SECRET_LENGTH` 副本未測；(e) M11 惰性分支正確保留；(f) `process.exit(1)` 繞過 `finally` | ④ 明說接受的成本 | HEAD 親量：(c) 仍在——`apps/cli/src/index.ts` 的 sdk 路徑在 `:590-805` 區間**沒有任何 `try {`**（`awk '/try \{/'` ＝ 0 行），install 在 `:597`、teardown 只在 `:789-801` 的 close／signal 上 ⇒ 兩者之間拋出仍會漏掉 `boot.diagnostics.close()`。(f) 見 W6 §2.5-3 列 |
| W6 §7 T5（`:261`） | (c) 五個 `mount` warn 通道未斷言；(d) SUCCESS 出口較窄；(e) 報告 §8.2 錯；(f) R10 說四條改了五條；(g) handle ≠ 寫記錄；(h) 負載 flake BASE 2/3 紅、HEAD 3/3 綠；唯一 skip ＝ Linux/bwrap | ④ 明說接受的成本 | HEAD 親量：(c) 仍開——`apps/cli/test/*.ts` 裡沒有任何 `level === "warn"` 斷言（M71 T3 的網只蓋 **package** 站點，CLI 的十個 handle 在網外）。(h) 是本機既有的負載 flake（M72Ⅱ §1 三讀數＋對照組、M73 §4.10、M74 §6 都重申） |
| W6 §7 T5⑨（`:262`） | `f45d0a5` 的訊息宣稱假（`record.ts:38` 是 union 成員）；不 amend，更正往前帶 | ④ 明說接受的成本 | 更正已落在同一份紀錄的 §7 T5⑨（HEAD 親量：`packages/diagnostics/src/record.ts` 的 union）——**不 amend** 是樹規矩，代價是歷史訊息永久為假，由紀錄承擔 |
| W6 §7 T6（`:263`） | (a) plan:42 的 dated 指針；(b) 縫的覆蓋；(c) `plugin-registry/state.ts:74`→`mount` 最可翻；(d) `telemetry` 也零站點；(e) handle 擺放；(f) 遮蔽陷阱；(g) 24 檔 boilerplate ~120 行 | ④ 明說接受的成本 | **已關的部分**：(a) M71 `6c47681`；(b) M71 T3（見 §A）；(c) M71 T3 斷言了 `state→mount`；(d) M79 `a629acd` 移除成員。**仍開的**：HEAD 親量 (e) `packages/session-executor/src/service.ts:39` 的 handle 仍夾在 import 之間、(f) `packages/mcp-client/src/bridge.ts:154-155` 的迴圈 `d` 與 `:155` 的模組 handle 同名、`packages/output-retention/src/spill-guard.ts:264` 的 `const d = dispatch` 遮蔽 `:256` 的 handle、(g) `grep -rln "diagnosticsFor(" packages/*/src` ＝ 19 檔 |
| M72Ⅰ §7-1（`:74`） | M62 的 fetch 相位 abort 不對稱：四個轉接器把 caller abort 變成 `error` 事件，新的 mid-stream 守衛 rethrow | ④ 明說接受的成本 | HEAD 親量：四個 fetch 轉接器的請求層 catch 都**無條件** `yield { type: "error", error: await describeTransportError(...) }`（`grep -n describeTransportError` → `llm-openai:143`、`llm-anthropic:175`、`llm-gemini:214`、`llm-openai-compatible:189`；`llm-openai:143-145` 逐行讀過：`catch (error) { yield … }`，abort 也走這條）；同一家的 mid-stream 守衛是 `if (request.signal?.aborted === true) throw err`（`llm-openai:330`）⇒ 兩套規矩今天都存在 |
| M72Ⅰ §7-2（`:75`） | `SSEParseError` 不帶 `cause`（解析位置／期望值遺失） | ④ 明說接受的成本 | HEAD 親量：`packages/llm-seam/src/index.ts:437-442`——`constructor(text: string)`、訊息只有 `malformed SSE chunk: …`，**沒有 `cause`** |
| M72Ⅰ §7-3（`:76`） | 四條迴圈 catch 比「bad chunk」寬：mid-body 傳輸失敗也成事件、且不經 `describeTransportError` | ④ 明說接受的成本 | HEAD 親量：`packages/llm-openai/src/index.ts:327-332` 的 catch 同時吃壞 chunk 與 `reader.read()` 的拒絕，產出 `err instanceof Error ? err : new Error(String(err))`——**不含** `describeTransportError` ⇒ 可能顯示成 `TypeError: terminated` |
| M72Ⅰ §7-4（`:77`） | `llm-openai` 的 `parseSSE` 不看 SSE 的 `event:` 行 | ④ 明說接受的成本 | HEAD 親量：`packages/llm-openai/src/index.ts:70-84` 只 `filter(chunk => chunk.includes("data:"))` 並讀 `data:`；`event:` 從未被讀 ⇒ body 無 `type` 的 `event: error` 仍落到空結果 |
| M72Ⅰ §7-5（`:78`） | 空字串 `systemPrompt` 跨轉接器不一致（openai／anthropic 仍送） | ④ 明說接受的成本 | HEAD 親量：`llm-openai:95` `instructions: request.systemPrompt` 與 `llm-anthropic:133` `system: request.systemPrompt` **無條件**送；`llm-gemini:176`／`llm-bedrock:157` 有 `.trim() !== ""` 守衛、`llm-openai-compatible:148` 也有 ⇒ 不一致仍在 |
| M72Ⅰ §7-6（`:79`） | 未量風險：沒對任何真實 provider 發過請求；內建 `deepseek` 收 `system` 是假設 | ④ 明說接受的成本 | 樹上**沒有真 provider 的請求**（這是全樹的既有事實，M80 spec §1.4 的裁定也建立在「樹上沒有真 provider」上）；若某 gateway 拒收該角色，今天的行為是 400（舊行為是靜默丟掉 prompt） |
| M72Ⅰ §7-7（`:80`） | `systemPrompt: undefined` 會在 transport try 之前 TypeError；今天不可達 | ④ 明說接受的成本 | HEAD 親量：`grep -rn "systemPrompt === undefined\|systemPrompt == null" packages/llm-*/src` ＝ **0**（沒有守衛被補上）；可達性仍由「所有建構點都供應字串」維持（M72Ⅰ §7-7 的量測） |
| M72Ⅱ §5.3（`:90`） | legacy `budget_tokens` 必須 < `max_tokens`（使用者把上限設得比它小 ⇒ 400） | ④ 明說接受的成本 | HEAD 親量：`packages/llm-anthropic/src/index.ts:106` 與 `packages/llm-bedrock/src/index.ts:118`／`:123` 仍直接把 effort 鑄成 `budget_tokens`／`budgetTokens`；**沒有任何地方與 `max_tokens` 互鎖**（`grep` 只命中註解與鑄造點）。M72Ⅲ 的殘餘清單**沒有**列它 ⇒ 至今無主 |
| M72Ⅱ §5.6（`:93`） | `maxTokensField` 只能改 `settings.json`（`provider set` 沒有這個開關） | ④ 明說接受的成本 | HEAD 親量：`grep -rn "maxTokensField" apps/cli/src/*.ts` ＝ **0**；值只由 `settings` → `provider-runtime:751-753` → `provider:901` → 轉接器到達（與 M61 的 `inputModalities`、M72Ⅲ 的 `usageInStream` 同形狀 ⇒ 先例） |
| M72Ⅱ §5.7（`:94`） | 兩個 latent：只有 `maxOutputTokens` 的卡片顯示成「no card」；compat 兩個 frame 解析點未統一 | ④ 明說接受的成本 | **已關的一半**：compat 的解析點由 M72Ⅲ `dce8cfd` 合成一個 `handleFrame`（`mapUsage` 在 `packages/llm-openai-compatible/src/index.ts` 只有**一個**呼叫點，親量）。**仍開的一半**：`apps/cli/src/models.ts:426` 仍以 `card?.contextWindow !== undefined` 決定印 `card N` 還是 `no card`（`:298`／`:320` 同形狀）⇒ 只有 cap 的卡片顯示成「no card」 |
| M72Ⅱ §5.8（`:95`） | proof gaps（具名）：T5 有一條測試沒有記錄過的殺手；「request cap beats generationConfig」未斷言；T7 五斷言同 | ④ 明說接受的成本 | 可量到的那半：**仍缺**——`grep -n "generationConfig: { maxOutputTokens" packages/llm-gemini/test/gemini.test.ts` ＝ **0**（沒有「route 自己的 cap 被 request cap 蓋過」的斷言）；相鄰的兩條在（`:364-371` 父物件建成、`:391-397` 其他鍵存活、`:399-404` 無 cap 原樣通過）。「殺手沒有被記錄」的兩半**未重量**（它們是關於 ledger／紀錄史的主張，樹上量不到） |
| M72Ⅱ §5.9（`:96`） | `SSEParseError` 無 `cause`；`HeadlessResult.truncated?: boolean` 比其他兩個表面寬 | ④ 明說接受的成本 | `SSEParseError` 見 M72Ⅰ §7-2 列（同一件事，兩份紀錄各列一次）。`truncated` 的寬度：R14 之後 repo 內**無生產讀者**，它是**主機介面**（M72Ⅱ §5.9 原文） |
| M72Ⅱ §5.10（`:97`） | 引用腐：`diagnostics/test/record.test.ts:58` 引的行號已漂 | ④ 明說接受的成本 | HEAD 親量：`packages/diagnostics/test/record.test.ts:50-58` 的檔頭自帶「Sites re-read 2026-09-22 (line numbers rot)」免責句，但四個 cited 行**今天都不再是洩漏行**（`:128`／`:141`／`:167`／`:163` 各是別的東西）⇒ 腐**擴大**、免責句是緩解。該句自 `1d20ef5`（W6 T2，2026-09-22）起原樣未動 |
| M72Ⅱ §6.3（`:103`） | 交棒：final tree 跑 `pnpm verify:all`；PR 必說三件事 | ① 修掉了 | 親量（`gh pr view 6 --json body`）：PR #6 的 body 有一節「三件必須明說的事」逐條寫出（值鏈只對主要 session 完整／anthropic 的 128k fallback 沒被夾／`maxTokensField` 只能改 settings.json），並附三個閘門讀數＋對照組 ⇒ 交棒履行 |
| M72Ⅲ §4.3（`:116`） | `reasoning` 語意不一致（四個生產者取自四個無關的 wire 概念）；gemini 的 thought parts 未讀 | ③ 產品決定 | 問題：要不要在 seam 上替「原始思考 vs 摘要」封一個位（M72Ⅲ §4.3 明說「產品決定」）。HEAD 親量：`thoughtSignature` 全樹零命中（M72Ⅲ §4.3 的讀數）；`grep -rn reasoning packages/llm-mock/src` ＝ 0（見下一列） |
| M72Ⅲ §4.4（`:117`） | `"off"` 在 anthropic／bedrock 仍等於 unset（API 的關法是 `{type:"disabled"}`） | ③ 產品決定 | 問題：`"off"` 要不要真的送 `{type:"disabled"}`（spec §3 已列，M72Ⅲ §4.4）。HEAD 親量：`packages/llm-anthropic/src/index.ts:106`／`packages/llm-bedrock/src/index.ts:118`／`:123` 仍是「effort ⇒ enabled 的預算」形狀 |
| M72Ⅲ §4.5（`:118`） | usage 沒有 per-response 去重（`core-agent:408-415` 逐欄 last-write-wins）；今天良性 | ④ 明說接受的成本 | 觸發條件具名：**若哪天有 gateway 被看到重複回報**，才在這裡加去重（M72Ⅲ §4.5）。今天良性是量到的（沒有已知的重複回報者） |
| M72Ⅲ §4.6（`:119`） | 本樹自己的 M5-T2 wire 欄位表在 bedrock 那列漏了 cache 欄位 | ④ 明說接受的成本 | HEAD 親量：`docs/superpowers/specs/2026-09-18-m5-t2-prompt-cache-continuity-design.md:185` 的 bedrock 列仍只寫 `inputTokens`／`outputTokens`；該檔屬 `docs/superpowers/**` ⇒ M80 spec §0.1 判**快照**、不改本文 |
| M72Ⅲ §4.7（`:120`） | `llm-mock` 不能發 `reasoning`（core-agent 的推理測試自帶 fake client） | ④ 明說接受的成本 | HEAD 親量：`grep -rn "reasoning" packages/llm-mock/src/*.ts` ＝ **0**；`MockStep` 只有 `usage`（M72Ⅲ §4.7） |
| M72Ⅲ §4.8（`:121`） | `Number.isFinite` 那半四家未釘（要生 SSE 字串寫 `1e999`） | ④ 明說接受的成本 | HEAD 親量：`grep -rn "1e999" packages/*/test/*.ts` ＝ **0**；`JSON.stringify(Infinity)` → `null` ⇒ fixture helper 表達不出來（M72Ⅲ §4.8 的機制） |
| M72Ⅲ §4.9（`:122`） | tracked 文件仍載假註解原文（plans phase-3 `:190-192`、specs provider-boundary `:23`） | ④ 明說接受的成本 | HEAD 親量：`git grep -n "seam 沒有 usage 事件" -- docs` 命中 **spec `:23`**；plans 該處仍在（`:190-192` 的 Step 3 片段）。兩者都在 `docs/superpowers/**` ＝ 快照（M80 spec §0.1）⇒ 照計畫走的人仍可再抄一次 |
| M72Ⅲ §4.10（`:123`） | 兩處註解仍宣稱超過碼（R17：`anthropic.test.ts:436`、`llm-openai-compatible:279-282`） | ④ 明說接受的成本 | ⚠ **提示錯**（猜「M79 收」）：M79 的 `5d080ef` 修的是 session-executor／core-plugin／audit／diagnostics／telemetry 的六處，**不含**這兩處。HEAD 親量：`packages/llm-anthropic/test/anthropic.test.ts:435-438` 仍是「Anthropic omits the cache fields on responses that used no cache」（**沒有被量測**的 wire 行為；來源句 `b8a7a10` 只修了 src）；`packages/llm-openai-compatible/src/index.ts:306` 仍自稱 usage 的「ONE carrier」（行號自 `:279-282` 漂移；樹上 `mapUsage` 只有一個呼叫點，但「這條 wire 只有一個載體」是未量的 wire 主張） |
| M72Ⅲ §4.11（`:124`） | `response.incomplete` 丟 usage payload（R14 parked；候選修法 4 行） | ④ 明說接受的成本 | HEAD 親量：`packages/llm-openai/src/index.ts:245-247` 的 `response.incomplete` 臂仍只設 `truncated`，**不讀** `response.usage`；候選修法與「價值建立在未量前提」的理由在 `M72Ⅲ §3 R14` |
| M72Ⅲ §4.12（`:125`） | OpenAI 形狀的 cache 拼寫（`prompt_tokens_details.cached_tokens`）沒被讀 | ④ 明說接受的成本 | HEAD 親量：`packages/llm-openai-compatible/src/index.ts:26` 只 `take("prompt_cache_hit_tokens", "cacheReadTokens")`；全檔沒有 `prompt_tokens_details`（R16 parked；代價是 OpenAI 形狀 gateway 的 cache 讀數**缺席**，不是假話） |
| M72Ⅲ §4.13（`:126`） | 13 條 deferred minors（ledger 已刪，內容併入本節各條與 §3） | ④ 明說接受的成本 | 內容**已在**該紀錄 §4 各條與 §3 的 R 系列（M72Ⅲ §4.13 原文）；ledger 是 gitignored scratch ⇒ 樹上沒有第二份可查，也沒有殘餘條目掉在外面 |
| M72Ⅲ §5.1（`:132`） | 不保證每個 provider 都收 `stream_options`（預設送） | ④ 明說接受的成本 | 逃生口是 **per-route 的 `usageInStream: false`**，而它只能改 `settings.json` ⇒ 同 M72Ⅱ §5.6 的表面缺口（M72Ⅲ §6.1 明說） |
| M72Ⅲ §5.2（`:133`） | 不保證 usage 可比；`absent ≠ 0` | ④ 明說接受的成本 | 本樹維持 absent ≠ 0（四個生產者都遵守；見 M72Ⅲ §2.1 的兩條鐵律與 `packages/llm-anthropic/src/index.ts:6-12` 的註） |
| M72Ⅲ §5.3（`:134`） | 預設打開改變了每一條既有 compat route 的請求形狀（刻意） | ④ 明說接受的成本 | 這是**刻意的行為改變**（spec §1.4／§4），且寫進同一份紀錄的 §5.3 與 PR 三件事之 1 ⇒ 代價已被明說而非隱藏 |
| M72Ⅲ §5.4（`:135`） | `reasoning` 算「產出」⇒ 重試包不再靜默重試（行為改變未另載） | ④ 明說接受的成本 | HEAD 親量（機制）：`packages/llm-seam/src/index.ts:227` 把 `reasoning` 併入 `produced`、`:259` 的重試閘是 `retryable && !produced && !budgetExhausted` ⇒ 先吐推理才失敗的往返不再被重試。代價是「避免重複的可見推理」換一次不重試 |
| M72Ⅲ §5.5（`:136`） | 不保證 usage 完整（truncated Responses＋OpenAI 形狀 cache） | ④ 明說接受的成本 | 兩個缺口的落點：M72Ⅲ §4.11（`llm-openai:245-247`）與 §4.12（`llm-openai-compatible:26`）——兩列都在本表 |
| M73 §4.2（`:97`） | 子代理的 telemetry：兩個建構點都沒有 `deps.telemetry` ⇒ metrics sink 看不到子代理 token | ④ 明說接受的成本 | HEAD 親量：`grep -rn "telemetry" packages/subagent/src/*.ts` ＝ **0**（整個套件的 src 沒有 telemetry 字樣）⇒ 缺口原樣（M74 §5.5 亦重申「與主要 session 的引擎對等」，非本階段造成） |
| M73 §4.3（`:98`） | `forkTurns` 預設 `"all"`（產品決定） | ③ 產品決定 | 問題：子代理「看得到什麼」——預設把父的整份逐字稿交給它，於是接近窗口的父 spawn 出的子代理**從第一步就超預算**（M73 §4.3）。M74/M75 之後它有壓縮可救，但預設值本身仍是決定（M74 §5.6 重列） |
| M73 §4.4（`:99`） | 配置了模型的 guardian：窗口與 cap 在該站點**結構上不可知**（依「缺席即缺席」不傳） | ④ 明說接受的成本 | 原則與代價：`M73 §7` 第 2 條——「不知道的數字不傳」，代價是它**沒有預算**；要修得讓 host 連 binding 一起交進來（M73 §4.4）。HEAD 親量：`guard-approval` 的審查者仍只有 `deps.model ?? deps.parentModel` 的繼承臂（M73 §2.2） |
| M73 §4.6（`:101`） | rebuild 的 declared 臂 cap 回退沒有擊殺點（四種組合釘三種） | ④ 明說接受的成本 | HEAD 親量：`packages/subagent/test/resume.test.ts` 的 declared 臂案例都帶 binding 的 cap（`:226` `maxOutputTokens: 4_242` → `:235` 斷言、`:415` `50_000` → `:422` 斷言）；**沒有**「binding 沒有 cap ⇒ 回退」的那一格 ⇒ 四種組合仍只釘三種 |
| M73 §4.7（`:102`） | `maxOutputTokens` 沒有輸入驗證（host 給 `0` ⇒ 送 `max_tokens: 0`）；與主 session 共用的既存洞，今天不可達 | ④ 明說接受的成本 | HEAD 親量：`packages/core-agent/src/index.ts:166` 驗的是 `budget.contextWindow`（finite positive）；`deps.maxOutputTokens` 只在 `:195`／`:311-314` 被讀與夾，**沒有驗證** |
| M73 §4.8（`:103`） | `overheadTokens` 對子代理不可觀察（拿掉仍全綠） | ④ 明說接受的成本 | 機制：它動的是階梯的**門檻**、不是請求，不等式吸收了它（M73 §4.8）；M74 §5.7 把同一條列為 comment 級 Minor、終審判「ship」 |
| M73 §4.9（`:104`） | `Number.isFinite` 那半的 guard 四家未釘（pre-existing） | ④ 明說接受的成本 | HEAD 親量：`grep -rn "1e999" packages/*/test/*.ts` ＝ **0**（同 M72Ⅲ §4.8 那一列，兩份紀錄各列一次） |
| M73 §4.10（`:105`） | 兩個本機負載 flake（不屬本分支） | ④ 明說接受的成本 | M12 retry 已由 PR #7 修掉；剩 `session-executor/test/shell-promotion.test.ts` 與 `apps/cli/test/cli.test.ts` 的**真子行程時序**兩條，並行 subagent 會餵它們（M74 §6 的量測：跑閘門時不要同時跑 subagent） |
| M73 §4.11（`:106`） | `reason` 是同義異義詞：telemetry 的是**觸發源**，結果的是**失敗因** | ④ 明說接受的成本 | HEAD 親量：`packages/compaction/src/index.ts:121` 的 request `reason?: "auto" \| "manual"`（觸發源）與 `:45` 的 `CompactionResult.reason?: "summarizer-failed"`（失敗因）並存；`:141` 的 telemetry data 帶的是觸發源 |
| M73 §4.12（`:107`） | `apps/cli/src/run.ts` 的檔頭註解位置（在 `CLI_COMMAND_NAMES` 上方而不是 handler 上方）— pre-existing | ④ 明說接受的成本 | HEAD 親量：`apps/cli/src/run.ts:51-59` 是那段說明、`:60` 才是 `const CLI_COMMAND_NAMES`；`:563-566` 的 plugin runtime 引用它 ⇒ 位置原樣 |
| M73 §5.1（`:113`） | 不保證子代理跑得完（超窗硬失敗，刻意） | ④ 明說接受的成本 | 保證仍不給，但**邊界被後續里程碑推走**：M74 給了它 compactor（超窗時 reset 使 `compaction/reset` 接手）、M75 給超窗區域切塊摘要 ⇒「硬失敗」只剩**切不動的單一巨塊**與無 `requestShape` 的路（M75 §5 具名） |
| M73 §5.2（`:114`） | 不保證配置的 guardian 有預算 | ④ 明說接受的成本 | 與 M73 §4.4 同一條（此列是 §5 的明說版）；原則＝「缺席即缺席」，代價＝它沒有預算（M73 §7 第 2 條） |
| M73 §5.3（`:115`） | 不保證 overhead 精確（估計＝字元／4） | ④ 明說接受的成本 | 它是估計（system prompt ＋ tool schemas 的字元／4），與主 session 同一條慣例（M73 §5.3）；M76 §4.5 另把種子警告的沉默帶 `[0.8·W − overhead, W)` 具名在註解 |
| M73 §5.4（`:116`） | `compaction` 的 legacy 路徑仍可能送出不夾的 cap | ④ 明說接受的成本 | HEAD 親量：`packages/compaction/src/summarizer.ts:322-326` 的閘要求 `region`＋`prefix`＋`maxOutputTokens`＋`contextWindow` **四樣同時在**；缺 `prefix`（legacy 文字路徑）即回到原路 ⇒ `clampOutputCap` 在輸入佔滿窗口時原值回傳的臂仍會讓 cap 原樣出去（M73 §5.4 的機制） |
| M74 §5.3（`:96`） | 已存在的子代理 log 沒有遷移路徑（`child-<uuid>.jsonl` 仍帶父座標引用） | ④ 明說接受的成本 | 修法只作用在**新** fork 出來的種子（M74 §5.3）；M76 §5 把「既有的孤兒 `child-<uuid>` log 沒有遷移路徑」重列一次 ⇒ 仍開 |
| M74 §5.4（`:97`） | inbox 游標的邊角：`compaction/reset` 讓一則訊息對模型不可見、卻仍算已消費 | ④ 明說接受的成本 | HEAD 親量：消費游標確實在 `packages/subagent/src/persist.ts:22`（「M9: the durable inbox consumption cursor」）；reset 與游標的交互自 M74 §5.4 起未被任何里程碑動 |
| M74 §5.5（`:98`） | 子代理的 telemetry 與 `modelPolicies` 與主 session 的引擎對等缺口 | ④ 明說接受的成本 | HEAD 親量：`grep -rn "telemetry\|modelPolicies" packages/subagent/src/*.ts` ＝ **0**；M73 §4.2 與 M74 §5.5 都記「core-agent 都不傳」⇒ 對等缺口原樣 |
| M74 §5.6（`:99`） | `forkTurns` 預設值（產品決定） | ③ 產品決定 | 同 M73 §4.3（此列是 M74 的重列）：它決定子代理「看得到什麼」——問題本身仍然是決定 |
| M74 §5.7（`:100`） | 註解級 Minors（`mainRequests` 的負向子字串分類、host 給 `0`／`NaN` 時錯誤訊息指向孿生的鍵、`overheadTokens` 不可觀察） | ④ 明說接受的成本 | 終審判 **「ship」**（M74 §5.7 原文）；其中 `overheadTokens` 那一條與 M73 §4.8 同一件事 |
| M75 §5.3（`:97`） | fallback 的惰性路線：配置 `summarizationModel`、沒有 `requestShape`、或綁定解析不出 cap ⇒ 超窗時仍是 reset | ④ 明說接受的成本 | HEAD 親量：閘在 `packages/compaction/src/summarizer.ts:322-326`（四樣同時在才切塊）；`apps/cli/src/run.ts:536` 一帶的 binding 解析若拿不到 cap，這條路就回到原路（M75 §5.3 的落點） |
| M75 §5.4（`:98`） | 估計 vs 真實 tokenizer（CJK 為主的區域可能遠超窗口而估計說放得下） | ④ 明說接受的成本 | 閘問的是 `estimateContent`（～4 字元／token）（M75 §5.4）；沿用 clamp ⇒ 誤差方向已知、代價明說 |
| M75 §5.5（`:99`） | 粒度：一個 user turn 內不可切；孤立超預算的塊仍走 fail-soft ⇒ reset | ④ 明說接受的成本 | M75 §2.1 的切點規則（`user` 訊息）**就是**這個代價的來源；真正的解法具名為「那一塊的來源（工具結果的上限）」（M75 §5.5） |
| M75 §5.8（`:102`） | `attempts` 語意改變（breaker 分不出「不穩」與「太大」） | ④ 明說接受的成本 | HEAD 親量：`packages/compaction/src/summarizer.ts:161` 的註解說出新的意思（「how many model calls the pass took」）＋ spec §1.6 ⇒ 語意已寫在事件旁，代價是 breaker 的分辨力 |
| M75 §5.9（`:79`） | 切塊路徑只在**需要夾取時**進入（沒有 cap 的 session 在超窗時不被救） | ④ 明說接受的成本 | Ruling 6（M75 §4）：兩個既有 engine 級測試沒有 cap，否則會變行為並轉紅 ⇒ 條件化；代價原文即「沒有 cap 的 session 在超窗時不被救」，閘的形狀見 `summarizer.ts:322-326` |
| M75 §5.10（`:74`＋`:76`） | Ruling 1：directive 本身的文字回歸不被那條斷言抓到；Ruling 3：串連規則曾有一格沒有突變證明（已移 Task 3） | ④ 明說接受的成本 | 兩半分開量：**前半仍開**——`messages.slice(0,-1)` 那條斷言蓋的是區域、不是 directive 文字（M75 §4 Ruling 1 的代價）。**後半已由本階段 Task 3 關掉**——`dbcca12`（`packages/compaction/test/summarizer-prefix.test.ts`：一個標記、串連、中途失敗仍原子）（該半 ⇒ ①） |

---

## 附：本表用到的載重讀數（可重跑）

```bash
node scripts/audit/check-reachability.mjs | head -1        # reachability: 553 ts files, 456 finding(s)
grep -rn '\bd[0-9]*\.\(warn\|error\)(' packages/*/src --include=*.ts | wc -l   # 39 handle 站點
grep -rn '\.child("[a-z]*")\.\(warn\|error\)(' packages/*/src --include=*.ts | wc -l  # 6 縫
ls packages/*/test/site-diagnostics.test.ts                # 11 檔（M71 的 9 ＋ M79 的 sdk／core-plugin）
grep -rn -F -e "console.warn(" -e "console.error(" packages/*/src --include=*.ts | grep -v "test" | wc -l  # 12 行
grep -n "createCliDiagnostics" apps/cli/src/index.ts                          # 477 / 597 / 847
grep -rn "1e999" packages/*/test/*.ts                                        # 0
grep -rn "durMs" packages/*/src apps/*/src                                    # 只有 record.ts:116
grep -n "只差 Q8" docs/handoff/2026-09-18-backend-backlog.md                  # 0
git log --oneline -S'六個相位有五個已有相位斷言' -- docs/handoff/2026-09-22-w6-diagnostics.md  # 2 顆：00067ec（M80 T5 寫入指針）＋ a2a2bdd（M80：同一行改寫，五個斷言的功勞改歸 M71 T3）
sed -n '1,/^# M80 殘餘稽核（Part 2/p' docs/handoff/2026-09-24-m80-residual-audit.md | grep -oE '\b[0-9a-f]{7,40}\b' | sed 's/^\(.......\).*/\1/' | sort -u | wc -l   # ⇒ 51 個不重複 commit（未截短的 sha 形式為 56；5 對是同顆的 7／8 字寫法）
git log --oneline -S'phase: "session", level: "warn"' -- packages/schedule/test/site-diagnostics.test.ts  # 4b57999（M71 T3）
gh pr view 6 --json body      # M72Ⅱ PR 的「三件必須明說的事」
```

本表引用的 **51 個不重複 commit**（Tier-1 的關閉者 ＋ Tier-2 證據裡的關閉者 ＋ 附錄 `-S` 讀數標出的第二顆；量法見附錄：**56** 個 sha 形式，其中 5 對是同一顆的 7／8 字寫法 ⇒ **51**）全部以 `git cat-file -t <sha>` 檢查，**每一個都回 `commit`**。

---
---

# M80 殘餘稽核（Part 2：新半）— Tier-1／Tier-2 ＋ 六處矛盾 ＋ 兩個候選 ＋ §4 逐條重量

**這是什麼**：Part 1（舊半）的續——**新半**（M76–M79 ＋ 收線計畫，共 **87 條**）的每一條具名殘餘沿鏈關閉或逐條歸類；六處紀錄／計畫矛盾（D1–D6）以**最新讀數**收掉；兩個候選（計畫 §2.45／§2.5）照 spec §1.4／§1.5 的**裁定**入表；計畫 §4「不是後端的事」**逐條重新量測**。判準與讀法同 Part 1（spec §1.3 的兩層）：**Tier-1**＝該條的每一個具名部分都被後續里程碑關掉（引用關閉它的紀錄＋commit）；**Tier-2**＝至少一個具名部分在 HEAD 仍開，落四鍵之一（①修掉了／②等前端／③產品決定／④明說接受的成本）或 `UNMEASURED`（只在該條整體量不到時用，並具名）。**無殘餘的裁定**（提案被拒、或裁決本身即處置）不另開桶：落 Tier-2、鍵 ④、在證據欄寫明「無殘餘」，與 Part 1 的 M72Ⅲ §4.13 同一處理。

**輸入**：`.superpowers/sdd/2026-09-24-m80-backend-readiness/task-7-input-new-half.md`（spec 前的量測代理）。來源欄保留該清單的編號與行號（`M76 1（:89）`＝該節第 1 條、行號 `:89`），每一條**恰好出現一次**。**行號是那次量測的**：M79 紀錄今天整體 **+1**（M80 `00067ec` 在 `:6` 補了一行 ▶），M76／M77／M78 三份未位移——一律**以內容定位**。

**來源標籤**（除計畫外全在 `docs/handoff/`）：

| 標籤 | 檔案 | 輸入清單所引的位置（以內容定位） |
|---|---|---|
| M76 | `2026-09-24-m76-walkoff-and-seed-bound.md` | §4 `:75-83`、§5 `:89` 與 `:91` |
| M77 | `2026-09-24-m77-refusal-channel.md` | §4 `:79-86`、§5 `:92` 與 `:94`、§6 `:102-103` |
| M78 | `2026-09-24-m78-prune-before-summarise.md` | §4 `:54-59`、§5 `:65` 與 `:67` |
| M79 | `2026-09-24-m79-coverage-completion.md` | §4（今天 `:57-67`）、§5（今天 `:73-81`） |
| 計畫 | `2026-09-23-backend-closure-plan.md` | §2.4 `:46-48`、§2.45 `:50`、§2.5 `:52`、§2 `:40-56`、§4 `:75-82` |

**量的時間**：2026-09-24，`m80` 分支 `a2a2bdd` 的樹（HEAD）。**沒有跑 `pnpm verify:all`**（Task 8）；唯一跑過的儀器是 `node scripts/audit/check-reachability.mjs`（**456 findings**，與 Part 1 同一讀數）。

**計數**：**Tier-1 10 列｜Tier-2 69 列（`UNMEASURED` 0）＝ 79 條**（§C）＋ **§F 8 條（落 9 列）**（覆蓋計畫 §4 的 8 條輸入項——第一條的兩個句子分開量）＝ **87 條**（＝ 79＋8；逐節的 18＋23＋12＋19＋15 亦為 87）。Tier-2 的鍵分佈：**① 0｜② 0｜③ 3｜④ 66**。

**輸入提示的查核**（「⇒ Mxx 已收」是量測代理的推測，不是裁定）：清單共 **13 個**這種提示，**11 條成立、2 條半錯**：

1. **成立（11）**：M77 8（⇒ M80 T1 `2f9147e`）、M77 17（⇒ M79 T3 `45bd37e`）、M77 18 與 22（⇒ M79 T1 `230fd44`）、M78 12（⇒ M79 T6 `cd188d7`／`6bd35c7`）、計畫 §2.4 三件（⇒ M79 全部交付）、計畫 §2.5（⇒ M80 T1）、計畫 §4 H-3（⇒ M80 T5 `00067ec`）、D2／D3／D5（⇒ M80 T5 已修，逐條見 §D）。
2. **半錯（2）**——兩條都是「修了，但只修了一半，剩下一半照規則不改」：
   - **M79 6**（`docs/` 其餘過期載體）：「⇒ M80 T5 已加指針」——**只加在兩個載體**（W6 紀錄 `:168`、reachability baseline §6.2 的 `mountPreset` 格）；**另兩個（2026-09-11 audit 的「20 rows」、2026-09-17 spec 的「是 20」）今天仍無指針**，而那是 M80 spec §1.1 的 **leave** 規則（`docs/audit/**` 與 `docs/superpowers/**` 是快照）。
   - **D1**（計畫 §2.4 以待辦寫）：「⇒ M80 T5 已修 §2.4」——**三件裡只有第 3 件**（19→23）加了 ▶ 2026-09-24；第 1、2 件（manifest 牙齒、儀器剝註解）**仍是「修法＝…」的將來式**（見 §D D1）。
3. **另外兩個提示不是「已收」型，是「量：今天還在嗎」型**（M78 2 的五處快取簡寫、M78 3 的 `engine.test.ts` 測試名稱）——**答案都是「還在」**，見那兩列。

---

## §C Tier-1：沿鏈關閉（10 條）

| 來源 | 一句話 | 關閉者（紀錄＋commit） |
|---|---|---|
| M77 8（`:92`） | 「非內容」的空結束仍靜默（gemini 的其他十個停止原因 ⇒ 200 空成功）——已成為候選 §2.5 | **M80 T1** —— `2f9147e`（`provider/empty` telemetry ＋ 耐久 `step/end.empty` ＋ CLI `[empty]` ＋ `result.empty`；判定點 `packages/core-agent/src/index.ts:512-514`，述詞帶 `!truncatedThisStep && !refusedThisStep`）。裁定與交付見 §E。**具名殘餘（不在此條的範圍）**：A3（seam 層）不做 ⇒ `compaction`／`session-title` 自己的模型呼叫仍不在此位（spec §1.5 的 *代價*、§4.3） |
| M77 17（`:94`） | `CAPABILITIES-DETAIL` 說「19 行」而 manifest 有 23 列（第三次遺漏，原記「M80 收」） | **M79 T3** —— `45bd37e`（「19 行」連同其他三處一律改 23 列）＋ **M80 T3** —— `0496421`（23 → **24**，補 M80 T1 的 `provider/empty`）。HEAD 親量：`docs/CAPABILITIES-DETAIL.md` §2.2 今天寫「manifest 24 碼（manifest.ts:16-53）」與「= 24 行」；`grep -n "19 行\|19碼\|19 碼" docs/CAPABILITIES-DETAIL.md` ＝ **0** |
| M77 18（`:94`） | `manifest.test.ts` 的執行期那一半是同義反覆（指派 M79） | **M79 T1** —— `230fd44`。HEAD 親量：`packages/telemetry/test/manifest.test.ts:17` 的 `type Missing = Exclude<TelemetryEventType, (typeof TELEMETRY_MANIFEST)[number]["code"]>` ＋ `:25` 的 `Missing extends never ? true : false = true`（`:22-24` 說明為何必須是**具名具體型別**）；執行期的迴圈斷言已刪 |
| M77 22（`:102`） | 「加了型別忘了列 = 沒有東西會紅」（至 M79 修 `manifest.test.ts`） | **M79 T1** —— `230fd44`。同一顆釘子（上一列）；M79 §2.1 的突變證明：舊樹上同一顆突變 **exit 0**、新樹上 `TS2322` 且全跑唯一錯誤 |
| M78 12（`:59`） | R6：reachability 儀器的註解盲點升格 M79 | **M79 T6** —— `cd188d7`（class 1 的「用了嗎」改讀**剝掉註解**的文字、entry 先剝再塗白；432 → 456）＋ `6bd35c7`（fixture 與備忘的措辭）。HEAD 親量：`scripts/audit/check-reachability.mjs:529-536` 的 `blankLexical(text, keepStrings)` 就是那個共用狀態機；`:553` 起自陳「M79 Task 6 parameterised this function instead of forking it」 |
| 計畫 1（§2.4 `:46`） | manifest 測試同義反覆（指派） | **M79 T1** —— `230fd44`（同 M77 18 那一列）。計畫 §2.4 第 3 件已加 ▶，這一件沒有——見 §D D1 |
| 計畫 2（§2.4 `:47`） | 儀器註解盲點（指派；M77／M78 各觸發一次） | **M79 T6** —— `cd188d7` ＋ `6bd35c7`（同 M78 12 那一列） |
| 計畫 3（§2.4 `:48`） | `CAPABILITIES-DETAIL:295` 的 19→23 | **M79 T3** `45bd37e` ＋ **M80 T3** `0496421`（同 M77 17 那一列）；那一件在計畫裡已帶 **▶ 2026-09-24** |
| 計畫 5（§2.5 `:52`） | 「非內容」的空結束仍靜默（候選，控制器傾向 (a)） | **M80 T1** —— `2f9147e`（同 M77 8 那一列）。裁定「**做（A0）**」在 spec §1.5；交付與讀數見 §E。**具名殘餘**：A3 不做（spec §1.5 的 *代價*）＋「有欄位卻帶著不可累積 parts」的角落（spec §4.3） |
| 計畫 6（§2 `:40-43`） | 種子端只警告（2026-09-23 裁定；M76 R1 落地） | **M76 §2.2** —— `d5d1144`（種子端 warn 的門檻與它自己的算術）＋ `c2e9e60`。HEAD 親量：條件是 `seedTokens >= contextWindow`（`packages/subagent/src/child.ts:399`），訊息說明後果（`:400-404`），**只警告不修剪** |

---

## §C-Tier-2：仍開者逐條四鍵（69 條；`UNMEASURED` 0 條）

| 來源 | 一句話 | 鍵 | 證據（指令／讀數） |
|---|---|---|---|
| M76 1（`:89`） | `resolveRoleTools`（`child.ts:408-411`）跑在 `coordinator.create` 之後 ⇒ 工具名重複會 throw、仍留孤兒 log | ④ 明說接受的成本 | HEAD 親量：`coordinator.create` 在 `packages/subagent/src/child.ts:324`、`resolveRoleTools(...)` 在 **`:411`**（`createToolRegistry` `:410`）；`:260-264` 的 M76 註解自陳被移到前面的是**模型解析器**、不是工具解析器 ⇒ 這一條原樣。代價寫在 M76 §6 第 3 條（「具名殘餘，不是保證」） |
| M76 2（`:89`） | `createAgent`／`jobs.registerJob` 同理；早於本階段 | ④ 明說接受的成本 | 同上：`createAgent` 在 `:426`、`jobs.registerJob` 在 `:501`，都在 `:324` 之後 ⇒ 這兩個 throw 仍會孤兒化；「早於本階段」是 M76 §5 的歸屬 |
| M76 3（`:89`） | **既有的**孤兒 `child-<uuid>` log 沒有遷移路徑 | ④ 明說接受的成本 | 親量：`git grep -n "child-" -- packages/subagent/src` 只有 mint（`:323` 的 `` `child-${randomUUID()}` ``）與註解，**沒有任何遷移程式**。與 Part 1 的 **M74 §5.3** 同一條（該列已判 ④：修法只作用在新 fork 的種子） |
| M76 4（`:89`） | 切不動的單一巨塊仍走 fail-soft（M75 §4.4） | ④ 明說接受的成本 | 機制同 Part 1 的 **M75 §5.3／§5.5** 兩列：閘在 `packages/compaction/src/summarizer.ts:320-326`（四條件同時在才切塊）；切不動的區仍回到 reset／fail-closed。M76 §4 R1 把「多花一輪摘要」與它並列為代價 |
| M76 5（`:89`） | `forkTurns` 預設 `"all"` 是產品決定 | ③ 產品決定 | 問題：子代理「看得到什麼」——預設把父的整份逐字稿交給它。HEAD 親量：`packages/subagent/src/child.ts:274` `const turns = opts.forkTurns ?? "all"`（`:275` 的 `Infinity`）。同一條在 Part 1 已兩列（M73 §4.3、M74 §5.6，皆 ③） |
| M76 6（`:89`） | `tool/dispatch` 的 `eventSeq` 不動 | ④ 明說接受的成本 | HEAD 親量：`packages/core-agent/src/index.ts:419` 取 `deps.session.events.length`、`:423` 進 batch；`packages/core-session/src/index.ts:23` 的 `tool/dispatch` 帶 `eventSeq?: number`（`:21-22` 說明它是 durable seq）。M76 未動 ⇒ 位移敏感的既有形狀留住 |
| M76 7（`:89`） | `NaN` 的既成行為 | ④ 明說接受的成本 | HEAD 親量：`packages/session-persistence/src/fork.ts:209-211`——`typeof event.anchorSeq === "number"` 對 `NaN` **成立** ⇒ 走 `renumbered.get(NaN) ?? 0` 得 `0`；而 `packages/core-session/src/index.ts:281-282` 的 `rewindCuts` 只拒絕**非數字**。`NaN` 由 JSON 帶不進來（`JSON.parse` 不產 `NaN`）⇒ 今天的不可達是**輸入種類**保證的，不是守衛。M76 §4 R9 記「早於本階段」 |
| M76 8（`:91`） | 註解稱懸空 call 投影成 `assistant("", toolCalls)`——帶旁白的步驟會把文字折進同一則 | ④ 明說接受的成本 | HEAD 親量：句子在 `packages/compaction/src/region.ts:46`（"so it surfaces as `assistant(\"\", toolCalls)` carrying a `tool_use` no result answers"）；`grep -n "prose" packages/compaction/src/region.ts` ＝ **0** ⇒ 那半仍沒寫。deferred minor（M76 §5 明說非阻塞） |
| M76 9（`:91`） | `fork.test.ts:376` 只斷言 `"turn 3 user"` 缺席（`"turn 3 answer"` 是同一個隱藏窗裡的免費判別力） | ④ 明說接受的成本 | HEAD 親量：那個檔今天**不存在**（`ls packages/subagent/test/fork.test.ts` 無）；同一條測試在 `packages/subagent/test/child.test.ts:125`（push `"turn 3 user"` ＋ `"turn 3 answer"`）與 **`:153`**（只有 `expect(shown).not.toContain("turn 3 user")`）⇒ 免費判別力仍未取 |
| M76 10（`:91`） | `src/fork.ts` 對 melded 標記的視窗描述比實際精確 | ④ 明說接受的成本 | 量到的：句子仍在 `packages/subagent/src/fork.ts:24-36`（「opens the window on the child's FIRST event…」），而窗是**併**出來的（`packages/core-session/src/index.ts:286` 的 `meldRewindCut(resolved, ev.anchorSeq, ev.seq)`）⇒ 一個標記的敘述讀起來像整個視窗。**只量到句子在**；「比實際精確」是 M76 複審的判斷，本表未重新推導 |
| M76 11（`:91`） | `child.test.ts` 的測試註解與原始碼訊息現在都是條件的 | ④ 明說接受的成本 | HEAD 親量：訊息自身帶條件子句（`packages/subagent/src/child.ts:400-404`「…and the turn fails closed when it does not」）；測試註解在 `packages/subagent/test/child.test.ts:519-526`——明說那三個 presence-only 斷言「stay green if the message reverts to the unconditional wording」⇒ 條件性是**寫下來**的代價，不是被守著的 |
| M76 12（`:75`） | R1 cost：子代理多花一輪摘要；切不動的巨塊仍 fail-soft | ④ 明說接受的成本 | 代價原文在 M76 §4 R1；兩半都能在 HEAD 找到落點——warn 與「summarises its inherited context in pieces before its first request」（`packages/subagent/src/child.ts:400-404`）＋ fail-soft（本表 M76 4 那一列） |
| M76 13（`:76`） | R2：平行預檢 ~46ms 等儲存變遠端（屬 M78，在那裡接受） | ④ 明說接受的成本 | 數字在計畫 §2 第 2 條（`docs/handoff/2026-09-23-backend-closure-plan.md:56`：**10 個並行呼叫 62ms vs 16ms** ⇒ 差 ~46ms；同一組數字在 M70 §2 的探針）＋ **M78 §4 R4** 再接受一次（本表 M78 11、計畫 7 兩列） |
| M76 14（`:77`） | R3 cost：規則單側 ⇒ 走位可停在未解析的 `tool/call`（**具名盲點** `region.ts:60-64`） | ④ 明說接受的成本 | HEAD 親量：`packages/compaction/src/region.ts:61` 起就是那段「Named residual, not a solved case: nothing constrains an unresolved `tool/call`, so the rule will let a cut REST ON one」。**這是具名的盲點**，不是被藏起來的 |
| M76 15（`:78`） | R4 cost：兩條孿生路徑仍不一致（只讓子代理那條正確） | ④ 明說接受的成本 | HEAD 親量：session fork **丟** `rewind/point`——`packages/session-persistence/src/fork.ts:149-152`（`event.type !== "rewind/point" && …`）；子代理的 `forkTurns` **留**它——`packages/subagent/src/fork.ts:32-37`（「This path keeps it…」）⇒ 兩套規矩今天並存，兩邊都寫了理由 |
| M76 16（`:79`） | R5 cost：第一步就摘要的子代理不會產那行 warn（沉默帶 `[0.8W − overhead, W)`） | ④ 明說接受的成本 | HEAD 親量：門檻是 `seedTokens >= contextWindow`（`packages/subagent/src/child.ts:399`），而帶狀區的算術與 `window = 5 × directive` 的交界寫在 `:378-396`（「the band `[0.8·window − overhead, window)` is silent here — a known, deliberate narrowing」）⇒ 沉默帶**具名在註解** |
| M76 17（`:80`） | R6 接受的偏差：單元案例與端到端案例分檔 | ④ 明說接受的成本 | HEAD 親量：單元案例在 `packages/session-persistence/test/fork.test.ts:294`（`anchorSeq` 的重映射，直接呼叫 `remapSeedEvent`），端到端在 `packages/subagent/test/child.test.ts`（直接呼叫 `forkTurns`）⇒ 兩檔；多一個檔是 R6 明說的偏差 |
| M76 18（`:83`） | R9 out-of-scope：新測試手寫 `renumbered` 映射；`NaN` 仍被當數字 | ④ 明說接受的成本 | 前半親量：`packages/session-persistence/test/fork.test.ts:326-333` 的 `remapSeedOf` 自建 `Map` 再呼叫 `remapSeedEvent`（不走 `forkTurns`）；後半見本表 **M76 7** 那一列 |
| M77 1（`:79`） | R1 cost：分不出拒絕的種類 | ④ 明說接受的成本 | HEAD 親量：seam 的形狀只有一個位元——`packages/llm-seam/src/index.ts:71` `{ type: "end"; truncated?: true; refused?: true }`；`:43` 自陳「The seam learns "the provider refused", never which filter said so」。要分辨得再分一層語意（M77 §5） |
| M77 2（`:80`） | R2 cost：終止 error ⇒ 整個 run 失敗、exit 1（spec §4.5） | ④ 明說接受的成本 | HEAD 親量：`packages/llm-anthropic/src/index.ts:236` 把 context 臂鑄成 `error.code = "CONTEXT_WINDOW_EXCEEDED"`；那個碼**不在**預設重試清單裡（`packages/llm-seam/src/index.ts:129`）⇒ 終止。行為改變逐字寫在 spec §4.5（`docs/superpowers/specs/2026-09-24-refusal-channel-design.md:100`：**「這一輪整個失敗、CLI exit 1」**） |
| M77 3（`:81`） | R3 cost：`EMPTY_RESPONSE` 死碼繼續死著 | ④ 明說接受的成本 | HEAD 親量：`git grep -n "EMPTY_RESPONSE" -- '*.ts'` ＝ **2 行**，都在 `packages/llm-seam/src/index.ts`（`:83` 型別成員、`:129` 預設重試清單）——**零生產者**（同本表 M77 11） |
| M77 4（`:84`） | R6：位元只給內容／政策；能力／可用性走錯誤通道；沒現成碼就具名不新造 | ④ 明說接受的成本 | **無殘餘（裁定，是原則本身）**。HEAD 親量兩側都成立：內容側——`packages/llm-gemini/src/index.ts:121-127` 逐條排除非內容原因並說「claiming a refusal for them would be a false statement about what the model did」；可用性側——anthropic 的 context 臂**不設位元**、走 `CONTEXT_WINDOW_EXCEEDED`（`packages/llm-anthropic/src/index.ts:236`） |
| M77 5（`:85`） | R7：compat 的 `refusal: ""` 保持現狀，量了再說 | ④ 明說接受的成本 | HEAD 親量：規則在 `packages/llm-openai-compatible/src/index.ts:288-289`——`const refusalText = (delta as { refusal?: unknown }).refusal`；`if (typeof refusalText === "string") refused = true`。理由（`""` 的拒絕仍是拒絕；拿 `length > 0` 會漏掉它）在 spec §5（`…-refusal-channel-design.md:111`）⇒ 邊界未測見本表 M77 13 |
| M77 6（`:86`） | R8：每家一個獨立性測試被拒 | ④ 明說接受的成本 | **無殘餘（提案被拒）**。被拒的依據今天仍可量：compat 的請求 payload（`packages/llm-openai-compatible/src/index.ts:157-172`）**沒有 `n`**，所以「兩條 `choices` 的框」是發明的內容；M77 §4 R8 逐條說明 |
| M77 7（`:92`） | 分不出拒絕的種類（§5 的重列） | ④ 明說接受的成本 | 與本表 **M77 1** 同一條（紀錄在 §4 R1 與 §5 各列一次）；證據同列 |
| M77 9（`:92`） | 拒絕之後的行為是產品決定 | ③ 產品決定 | 問題：重試？換模型？（M77 §5；M77 §6 第 4 條：腳本仍分不出拒絕與成功，除非解析 stderr）。HEAD 親量：`packages/llm-openai/src/index.ts:182-183` 把拒絕的**文字**不提進 assistant text，且自陳「(a parked product decision)」；CLI 的 exit code 仍是常數 0（`apps/cli/src/run.ts:934`） |
| M77 10（`:92`） | anthropic 的 context 臂會弄死整個 run | ④ 明說接受的成本 | 與本表 **M77 2** 同一條（§4 R2 與 §5 各列一次）：`packages/llm-anthropic/src/index.ts:189-236` 的臂 ＋ spec §4.5。刻意（大聲失敗勝過靜默），且是**使用者看得見**的行為改變 |
| M77 11（`:92`） | `EMPTY_RESPONSE` 沒有生產者 | ④ 明說接受的成本 | 與本表 **M77 3** 同一條（兩列）；證據同列 |
| M77 12（`:92`） | `delta.refusal` 的伴隨形狀不可查（兩個文件站 403） | ④ 明說接受的成本 | HEAD 親量：`packages/llm-openai-compatible/src/index.ts:276-286` 引的是 `Choice.Delta.refusal?: string \| null` 的**廠商文字**（「The refusal message generated by the model」），而 403 是量測環境的限制 ⇒ 位元看的是**欄位本身**、不是 `finish_reason`（spec §5），所以不影響正確性。**量不到的那半**見 §G |
| M77 13（`:92`） | `refusal: ""` 的邊界未測 | ④ 明說接受的成本 | HEAD 親量：`git grep -n 'refusal: ""'` 在 `packages/llm-openai-compatible/**` ＝ **0**（唯一一處是 `packages/llm-openai/test/openai.test.ts:548` 的 **content-part**，屬 openai 那條 wire、鍵在 `type` 上）；compat 的 delta 載體本身**有**測試（`packages/llm-openai-compatible/test/openai-compatible.test.ts:449`）⇒ 未測的**正好是 `""` 這個邊界** |
| M77 14（`:92`） | `llm-seam` 的 JSDoc 仍是「一家一個載體」的舊寫法 | ④ 明說接受的成本 | HEAD 親量：`packages/llm-seam/src/index.ts:31-36` 仍以「一家的停止原因字面」逐一列舉五家（"openai's and openai-compatible's `content_filter`, gemini's `SAFETY` / `RECITATION`, anthropic's `stop_reason: "refusal"`, bedrock's `guardrail_intervened`"），而 fix wave 的三個補丁（`282e81e`／`bf85c64`／`ccb9df0`）證明**三家另有內容側載體**（`git show --no-patch --format=%s` 逐條讀過）⇒ 清單的寫法未動（改的是引用形式） |
| M77 15（`:92`） | `response.completed` 的 `output[]` 是陳述的邊界、不是量測過的 wire | ④ 明說接受的成本 | HEAD 親量：`packages/llm-openai/src/index.ts:170-181` 的三載體清單自陳「Three carriers are read, because at this layer none implies another」；全檔 `grep -n "response\.output"` 只有 `response.output_text.delta`（`:196`）與 `response.output_item.added`（`:199`）——**`response.completed` 的 `output[]` 沒有被讀**，`response.completed` 那臂只讀 `response.usage`（`:251-257`）⇒ 邊界是**陳述**的。**量不到的那半**見 §G |
| M77 16（`:94`） | `spyTelemetry` 被複製一份 | ④ 明說接受的成本 | HEAD 親量：`grep -rn "function spyTelemetry" packages/*/test/*.ts \| wc -l` ＝ **7 個定義**、`grep -rln` ＝ **5 個檔**（`compaction/test/analytics.test.ts:10`、`core-agent/test/agent.test.ts:504`／`:563`／`:652`、`core-agent/test/projection-rewrite.test.ts:19`、`core-agent/test/provider-usage.test.ts:27`、`core-agent/test/telemetry.test.ts:13`）⇒ 「一份」的複製在計數上是**七份** |
| M77 19（`:94`） | `session-title` 的訊息沒有呼叫端觀察得到（在 `try` 裡、`catch` 直接回退） | ④ 明說接受的成本 | HEAD 親量：`packages/session-title/src/index.ts:89-92`——throw 就在自家的 `try` 裡，`:93-95` 的 `catch { return { title: fallbackTitle(...), source: "fallback" } }` 直接吞掉；註解自陳「the text is a message for a reader of the source … not for an operator today」。呼叫端 `apps/cli/src/run.ts:863` 的 `await maybeAutoTitle` 沒有任何觀察者 |
| M77 20（`:94`） | `llm-gemini` 的排除清單只列了 10 個（14 個裡） | ④ 明說接受的成本 | HEAD 親量：排除清單在 `packages/llm-gemini/src/index.ts:121-126`，具名 **10 個**（`LANGUAGE`／`OTHER`／`NO_IMAGE`／`IMAGE_OTHER`／`MALFORMED_RESPONSE`／`UNEXPECTED_TOOL_CALL`／`TOO_MANY_TOOL_CALLS`／`MISSING_THOUGHT_SIGNATURE`／`ESCALATION`／`PUP_LIMITED_DISABLED`；＋`STOP`／`MAX_TOKENS` 另句）；而**測試只釘 2 個**——`packages/llm-gemini/test/gemini.test.ts:504` 的 `it.each(["OTHER", "LANGUAGE"])` |
| M77 21（`:94`） | `anthropic.test.ts` 的一句措辭 | ④ 明說接受的成本 | HEAD 親量：`packages/llm-anthropic/test/anthropic.test.ts:536`（"…every other stop_reason is a clean ending, and a clean ending must…"）——M77 之後`refusal` 不再是乾淨結束，所以「every other」變得不精確（spec §2 的同一條，`…-refusal-channel-design.md:24`） |
| M77 23（`:103`） | exit code 仍是 0…那是產品決定（§5） | ③ 產品決定 | 問題：要不要讓腳本能分辨拒絕與成功（M77 §5／§6 第 4 條）。HEAD 親量：`apps/cli/src/run.ts:934` 的成功出口是 `exitCode: 0` 常數；`[refused]`／`[truncated]`／`[empty]` 三行只到 stderr（`:931` 的 `[empty]`） |
| M78 1（`:65`） | 快取那一側沒有量（§1.1、closure §2.45） | ④ 明說接受的成本 | 裁定＝**明說接受**，觸發條件＝第一次有真 provider 的部署（spec §1.4）；受影響的落點自陳在同檔 **`packages/compaction/src/index.ts:86-96`**（「It is NOT a byte-prefix of the LAST SENT main request any more, and the cache side is a trade this unit did not measure — stated, not repaired」）。**量不到的那半**見 §G；處置見 §E |
| M78 2（`:65`） | 五處過期的快取簡寫 | ④ 明說接受的成本 | HEAD 親量（**五處都還在**）：① `packages/compaction/src/index.ts:200-202`（"replay the region as REAL messages so this call is a byte-prefix of the last main request"）；② `packages/compaction/src/summarizer.ts:181-182` 與 `:303-305`（"it is a byte prefix of the session's last main request and the provider cache serves it"）；③ `packages/core-agent/src/index.ts:183-184`（"the call is a byte-prefix of the main request and the provider's cache serves it"）；④ `packages/core-session/src/index.ts:447-449`（**最糟**：就在 M78 自己那段例外說明（`:455` 起）上方幾行，互相矛盾）；⑤ `packages/session-executor/test/assembly.test.ts:249-251` |
| M78 3（`:65`） | `engine.test.ts` 的測試名稱同類 | ④ 明說接受的成本 | HEAD 親量：`packages/compaction/test/engine.test.ts:58` 的名字仍是 `"summarizer failure is fail-soft: no events appended"`，`:70` 的斷言仍是 `expect(s.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)`——而 M78 之後失敗的一輪**可以**附加 `compaction/prune`（`packages/compaction/src/index.ts:271-272` 自己說「the log changed while the result says the pass failed」）；它在這個 fixture 綠只因為 `longSession()`（`:18-22`）只有 `user/message`、沒有可 prune 的東西（**未重跑；推論自 fixture 與 M78 的閘**）。M78 的 `0336fe4` 動的是四個檔（`compaction/src/index.ts`／`test/prune.test.ts`／`core-session/src/index.ts`／`test/prune-event.test.ts`），**不含**此檔 |
| M78 4（`:65`） | 重試會再附加一個標記（冪等 last-wins；手動 `compact()` 沒閘；去重省 ~5 180 bytes，不做） | ④ 明說接受的成本 | HEAD 親量：`packages/compaction/src/index.ts:277-289` 逐句（"the ladder's next rung RE-PLANS the same records and appends a SECOND `compaction/prune` marker (nothing dedupes…)"；`enforceBudget` 的 layer 1 每步呼叫無閘的 `compact()`；"one record's marker JSON is 5 180 bytes"；"Deliberately left alone"） |
| M78 5（`:65`） | prune 只縮它能縮的（沒東西可 prune 的區域仍走 M75 切塊路徑） | ④ 明說接受的成本 | HEAD 親量：只有 `pruneRecords.length > 0` 才附加標記——`packages/compaction/src/index.ts:186`；而切塊的閘是四條件同時在（`packages/compaction/src/summarizer.ts:320-326`）⇒ 兩條路今天並存，代價是「區域沒東西可 prune 時沒有省」 |
| M78 6（`:67`） | 改正後的註解有兩處措辭不精（`summarizationModel` 的閘沒提；「不再是 byte-prefix」讀起來無條件） | ④ 明說接受的成本 | HEAD 親量：`sed -n '84,97p' packages/compaction/src/index.ts \| grep -c "summarizationModel"` ＝ **0**（那一段沒提**那道閘**）；同一段的「It is NOT a byte-prefix of the LAST SENT main request any more」（`:86`）讀起來無條件，而分岔是 **prune 條件性的**（真閘在 `:202-203`） |
| M78 7（`:67`） | `slices.ts`／`region.ts` 之外仍有幾個目前正確的行號引用 | ④ 明說接受的成本 | HEAD 親量：`grep -rn "\.ts:[0-9]" packages/compaction/src packages/compaction/test \| grep -v "/slices.ts\|/region.ts"` ⇒ **8 行**（例：`src/index.ts:627` 引 core-session 的 `src/index.ts:138/277`；`test/walkoff.test.ts:57` 引 `index.ts:352` 與 `region.ts:150`；`test/slices.test.ts:35`／`:38` 引 `core-agent` 的兩個位置）——「目前正確、但會腐」；`region.ts` 自己仍有 **4 條**（`:31`／`:47`／`:49`／`:73`）。本階段自己的規矩是引符號不引行號（M78 §6 第 1 條：「**引檔案用符號名**——本階段那個檔案的行號移了 30 行」） |
| M78 8（`:54`） | R1 cost：把 `compacted:false` 讀成「什麼都沒附加」的消費者現在微妙地錯 | ④ 明說接受的成本 | HEAD 親量：代價被具名成「An odd combination, named rather than smoothed over」（`packages/compaction/src/index.ts:270-273`），並有釘子（同段指名 `test/prune.test.ts` 的案例「M78: a summarizer failure leaves the prune APPLIED」）。**一個活的例子就在樹上**：本表 M78 3 那一列的 `engine.test.ts:71` |
| M78 9（`:55`） | R2 cost：一個 prefix fold 會套用屬於更晚時刻的重寫（時間尋址的釘子是警報） | ④ 明說接受的成本 | HEAD 親量：例外只給 prune（內容尋址）——`packages/core-session/src/index.ts:455-464`（"`derivePruneSubstitutes` keys its map by tool call id… applying the map to ANY fold is exactly right"）；警報的釘子有兩顆：`packages/core-session/test/prune-event.test.ts:92`（"the content-addressed prune directive crosses the cut; the time-scoped markers do not"）＋ 同檔 `:54-65` 的 shadow／reset 案例 |
| M78 10（`:56`） | R3：取捨（快取 vs token），哪邊贏沒有量 ⇒ 候選量測（closure §2.45） | ④ 明說接受的成本 | 與本表 **M78 1** 同一條（紀錄在 §4 R3 與 §5 各列一次）；裁定與觸發條件見 §E |
| M78 11（`:57`＋`:34`） | R4：平行預檢候選（條件：儲存變遠端） | ④ 明說接受的成本 | **具名候選**：數字在計畫 §2 第 2 條（62ms vs 16ms），機制是逐步呼叫的 checkpoint（`packages/core-agent/src/execute-tool-calls.ts:209` 的 `callEventSeq`／`:252` 的 `eventSeq`）；觸發條件逐字是「若儲存變成遠端（每次寫入是一次往返）再回來做」（計畫 §2 第 2 條末）。同一條在 M76 13／計畫 7 兩列 |
| M79 1（`:72`） | 指名未覆蓋：`subagent/src/tools.ts:829`（量過驅不動）與 `child.ts:399`（只有 console 間諜） | ④ 明說接受的成本 | HEAD 親量：兩站今天**就在原行號**——`packages/subagent/src/tools.ts:829` 與 `packages/subagent/src/child.ts:399` 都是 `d.warn(`；覆蓋帳見 Part 1 的 M71 2 列（45 站／已覆蓋 15／未覆蓋 30），`packages/subagent/test/site-diagnostics.test.ts` 自己也把「`tools.ts` 的 session handle 不被覆蓋」寫成報告 |
| M79 2（`:73`） | class 2/4/5 的註解危害：latent（零列移動），明說不修 | ④ 明說接受的成本 | HEAD 親量（機制）：class 2 的 producer 掃描讀**原文**——`scripts/audit/check-reachability.mjs:516-525`（`f.text.split(/\r?\n/)`，`isProducerLine` 只排除**行首**註解：`:505-509`）。spec §1.4 d2 是「只量不修」（`…-coverage-completion-design.md:88`）⇒ 危害類別**今天仍在**，只有 class 1 被 `cd188d7` 修掉 |
| M79 3（`:74`） | core-session 內聯 union 的漂移檢查是單向的 | ④ 明說接受的成本 | HEAD 親量：內聯複本在 `packages/core-session/src/index.ts:151`（`phase: "cli" \| "config" \| "run" \| "turn" \| "sdk" \| "session" \| "mount" \| "shutdown"`＝八個字面）；雙向的釘子只蓋**套件自己的** union——`packages/diagnostics/test/phase-union.test.ts:25-32`（`NoExtra`／`NoMissing`）；該檔 `:11-14` 自己說內聯複本「a sync there is a disciplined edit rather than a compile error」。（Part 1 的 **M69 3** 是同一條） |
| M79 4（`:75`） | 只被字串提到的 export 仍不會有列（刻意的取捨；`interaction#Command`） | ④ 明說接受的成本 | HEAD 親量：instrument 自己的 self-test 把這個取捨**釘住**——`scripts/audit/check-reachability.mjs:1109-1111`（名 `"class 1: a name only inside a STRING literal still retires the row (strings are not stripped)"`）；字串本身在 `packages/shell/src/index.ts:21`／`:479` 與 `packages/guard-approval/src/remember.ts:17` 的 `"-Command"`，而 `Command` 是 `packages/interaction/src/index.ts:76` 的 export ⇒ 它不會有列，是取捨不是漏洞（M79 §5） |
| M79 5（`:76`） | stripper 的 regex-literal 極限：5 檔受影響＋反方向 4 檔（量到沒有列被藏住） | ④ 明說接受的成本 | HEAD 親量：5 檔名逐字在 `scripts/audit/check-reachability.mjs:553-557`（`task-board.ts`／`lsp/render.ts`／`plugin-registry/marketplaces.ts`／`rewind/path.ts`／`settings/index.ts`；「every span inside a regex source and none containing an export name」）⇒ 限制**今天仍在**；反方向的 4 檔只在紀錄（`m79-coverage-completion.md:77`），樹上沒有第二份（見 §G） |
| M79 6（`:77`） | `docs/` 其餘過期載體（audit 的「20 rows」、baseline §6.2 的 `mountPreset`…）——歷史快照不改 | ④ 明說接受的成本 | **已處置的兩處**：W6 紀錄 `:167` 那條的正下方 `:168` 有 ▶（`00067ec`，M80 T5）；`docs/audit/2026-09-15-reachability-baseline.md` 的 §6.2 `mountPreset` 格有 ▶ 2026-09-24（**`packages/tui` 隨 M65 刪除 ⇒ 抑制失效 ⇒ 成為 live finding，重測於 `1ac091e`**）。**按 leave 規則原樣的兩處**：`docs/audit/2026-09-11-ih-backend-inventory.md:3063`（「TELEMETRY_MANIFEST has 20 rows」；對該檔 `grep -c "▶"` ＝ **0**）與 `docs/superpowers/specs/2026-09-17-m3-measurement-foundation-design.md:77`（「是 20」）——兩者都在 M80 spec §1.1 的**快照／leave** 名下 ⇒ 假數字留在快照裡，是刻意的 |
| M79 7（`:78`） | allowlist 的 note 說兩個資料檔是 CRLF、baseline 現在是 LF（may-ship） | ④ 明說接受的成本 | HEAD 親量（工作樹）：`scripts/audit/reachability-allowlist.json` **269/269 行帶 CR**（CRLF），`scripts/audit/reachability-baseline.json` **0/464 行帶 CR**（LF）；兩者的 **blob 皆 0 CR**（`git show HEAD:<f> \| tr -dc '\r' \| wc -c` ＝ 0）⇒ note 的 (2) LINE ENDINGS 那一段的主張**今天為假**（baseline 是 LF），而它的 `core.autocrlf=true` 附註仍對 |
| M79 8（`:79`） | T5 的 `compact` 誘餌讓自動壓縮保持 enabled（脆弱點）；T5/T4 的 helper 重複 | ④ 明說接受的成本 | HEAD 親量：第三顆誘餌 `compact: { contextWindow: 4_000 }` 在 `packages/session-executor/test/assembly.test.ts:1592`，作者自己寫下「its presence does not disturb the fixtures (no compaction pass: the runs keep the review at exactly one request…)」（`:1594-1595`）⇒ 今天穩定**靠的是沒有壓縮 pass**，那正是脆弱點。helper 重複：`ls packages/*/test/site-diagnostics.test.ts \| wc -l` ＝ **11 檔**，11 檔都各自帶區域 helper（`grep -rl "installDiagnostics" packages/*/test/site-diagnostics.test.ts` ＝ 11） |
| M79 9（`:80`） | T2 的 `Exclude<any, X>` = `any` 洞；T1/T2 的非分配性只寫在 fix wave 補的那一句 | ④ 明說接受的成本 | HEAD 親量：`git grep -n "Exclude<any" -- '*.ts'` ＝ **0**（今天沒有任何 `Exclude<any, …>`）；兩個斷言檔的 checked 側都是具名具體型別（`packages/diagnostics/test/phase-union.test.ts:25-27`、`packages/telemetry/test/manifest.test.ts:17`）⇒ 這是**模式層的威脅模型註記**（若哪天 checked 側是 `any`，`Exclude` 回 `any`、釘子靜默通過），不是活的殘餘。後半：那句非分配性警語由 fix wave **`5d080ef`** 補進兩個檔（`:26-28` 與 `:22-24`，`git show 5d080ef -- …/phase-union.test.ts` 親量） |
| M79 10（`:56`） | R1 工作區＝分支就地（不建 worktree） | ④ 明說接受的成本 | **無殘餘（裁定）**：M79 紀錄的檔頭逐字記「`m79`（from `main` `5446d6bb`）」（`docs/handoff/2026-09-24-m79-coverage-completion.md:5`）；代價「無（分支即隔離）」。⚠ 輸入清單的行號比今天少 1（M80 `00067ec` 在紀錄 `:6` 補了 ▶） |
| M79 11（`:57`） | R2 T1 的惰性 expect（keep-alive） | ④ 明說接受的成本 | HEAD 親量：`packages/telemetry/test/manifest.test.ts:25` 的 `const manifestIsExhaustive: Missing extends never ? true : false = true` ＋ **`:26`** 的 `expect(manifestIsExhaustive).toBe(true)`——那是 `noUnusedLocals` 的 keep-alive，承重的是型別註解（M79 §4 R2 逐字：讀者可能誤讀，註解已寫明） |
| M79 12（`:58`） | R3 T4 的紅先＝拿掉觀察者 | ④ 明說接受的成本 | 樹上量得到的：五個站點的測試都在——`packages/{plugin-registry,hooks,sdk,core-plugin}/test/site-diagnostics.test.ts`（`ls packages/*/test/site-diagnostics.test.ts` ＝ 11 檔），關閉者 `c0d1ea1`。**裁決本身住在 ledger**（M79 §4 R3 自己說「裁決在 ledger，複審可見」）⇒ 見 §G |
| M79 13（`:59`） | R4 小工具逐檔重複是 house style | ④ 明說接受的成本 | HEAD 親量：同本表 M79 8 那一列（11 檔各自的區域 helper）；代價「~10 行模板未來可能各自漂移」（M79 §4 R4） |
| M79 14（`:60`） | R5 內聯 union 複本保留 | ④ 明說接受的成本 | 與本表 **M79 3** 同一件事的裁定面：`packages/core-session/src/index.ts:151` 的八個字面 ＋ 零依賴是既有設計 ⇒ 只同步字面（M79 §2.2 的 `a629acd` 逐字：「內聯複本**人手**同步」） |
| M79 15（`:61`） | R6 接受兩個既有測試檔頭註解改動 | ④ 明說接受的成本 | HEAD 親量：那兩個檔頭今天各自列舉覆蓋範圍並說明為何存在——`packages/hooks/test/site-diagnostics.test.ts:1-8`（"WHY THIS FILE EXISTS…"）；代價原文是「失去『既有測試檔逐字未動』的保證」（M79 §4 R6），改動逐條具名 |
| M79 16（`:62`） | R7 parked：`check-reachability.mjs:548-549` 對 class 3 的方向描述錯 | ④ 明說接受的成本 | HEAD 親量：`scripts/audit/check-reachability.mjs:548-549` 今天正是那段——「`codeOnly` (class 3) blanks string content by design, so a span lost there is a miss. `commentsBlanked` (class 1) KEEPS the strings…」（parked 的判讀：`unread-flag` 也是**鑄列**方向；本樹 0 實例） |
| M79 17（`:63`） | R8 parked：`:555-556`「every span inside a regex source」只對觸發成立 | ④ 明說接受的成本 | HEAD 親量：`scripts/audit/check-reachability.mjs:555-556` 逐字仍在（塗白延伸到行尾、含 literal 之後的程式碼；實質句「零個 export 名」不受影響） |
| M79 18（`:64`） | R9 parked：`assembly.test.ts:1585-1586` 的 compact 句 scope | ④ 明說接受的成本 | HEAD 親量：句子在今天的 `packages/session-executor/test/assembly.test.ts:1585-1586`（「while the `opts.compact?.contextWindow` form is what nothing above can see: the fixture passes the SAME window to both keys」）——它對 `:1606` 起的**這四個 fixture**成立，不是普遍宣稱（direct-child 的 M73 案例會紅） |
| M79 19（`:66`） | 三條 parked 全屬核心類別，逐條具名不沉默 | ④ 明說接受的成本 | 紀錄層面的**處置本身**：`docs/handoff/2026-09-24-m79-coverage-completion.md:67` 逐字（「照 SDD 沒有第二輪 fix wave，故在此逐條具名，不沉默」）；三條的落點見本表 M79 16／17／18 |
| 計畫 4（§2.45 `:50`） | 摘要請求的快取那一側沒有量（候選，待裁決） | ④ 明說接受的成本 | 裁定＝**明說接受**（spec §1.4，逐字「樹上沒有真 provider ⇒ 快取側量不到；紅利側已量到且壓倒性」）；觸發條件＝**第一次有真 provider 的部署**（量 `cacheReadTokens` 修前／修後）。三列同一條：本表 M78 1／M78 10；處置見 §E |
| 計畫 7（§2 `:54-56`） | M70 checkpoint 接受；平行預檢具名候選（儲存變遠端） | ④ 明說接受的成本 | 接受面：M78 §4 R4 再確認一次；候選面見本表 M76 13／M78 11（同一個觸發條件）。計畫 §2 第 2 條今天逐字仍寫「若儲存變成遠端（每次寫入是一次往返）再回來做」 |

---

## §D 六處紀錄／計畫矛盾（D1–D6）— 以今天的事實收掉

| # | 矛盾 | 今天的事實（量測） | 收法 |
|---|---|---|---|
| **D1** | §2.4 三件已交付，計畫本文仍以待辦寫 | **半修**：第 3 件（19→23）帶 **▶ 2026-09-24**（`docs/handoff/2026-09-23-backend-closure-plan.md:48`）；第 1、2 件（`:46`／`:47`）**仍是「修法＝…」的將來式**，沒有任何 ▶。交付的事實由 §1 的 M79 列承載（`:31` 逐字：「三件指派（manifest 牙齒／儀器註解盲點／19→23 列）**全部落地**」）＋ 本表 §C Tier-1 的三列 | 以 §1（進度表）＋ §C 的三列為準；§2.4 第 1、2 件保持原文（那是**指派語**、不是假宣稱）。查核：輸入提示「⇒ M80 T5 已修 §2.4」**半錯**，見上 |
| **D2** | 計畫 M78 列「留下的兩件」vs record §5 五條 | **已修**：計畫 `:30` 今天寫「**留下的五條**（record §5 的殘餘逐條）」，並把五條逐一列名（快取那一側未量、五處過期的快取簡寫、`engine.test.ts` 的測試名稱、重試會再附加一個標記、prune 只縮它能縮的）⇒ 與 M78 §5 的五條**逐條對上** | 以計畫那一列為準（數量與內容都對上了）；五條各自的處置在本表 M78 1–5 |
| **D3** | `CAPABILITIES-DETAIL` 列數項被兩份文件再路由去 M80，實已由 M79 收 | **已修**：① 計畫 §2.4 第 3 件帶 ▶（19→23 由 M79 `45bd37e`、23→24 由 M80 T3）；② M77 紀錄 `:94` 那句「（**第三次遺漏**，M80 收）」**仍是原文**，但**緊接在 `:96`** 就是 **▶ 已收線（M79）**，逐字說明「`45bd37e` 把『19 行』連同其他三處一律改成 23 列（早於預期的『M80 收』）」；③ 檔案本身今天寫 **24 碼／24 行**（`docs/CAPABILITIES-DETAIL.md` §2.2）；④ 逐字掃「M80 收」（`grep -rn "M80 收" docs/`）⇒ 今天 **8 行**，扣掉**本檔自己的 4 行**（`:3`／`:218`／`:312`／`:351`——**本檔自己也是命中之一**）⇒ **4 行，再路由語只剩兩處**：M77 紀錄 `:94` 那句（**已在 `:96` 被 ▶ 收掉**）與計畫 §4 的 H-3 那句（`:79`，見 §F 第 12 列）；其餘兩個命中不是再路由——`2026-09-24-coverage-completion-design.md:126` 是 M79 spec 自己的 leave 清單、M77 `:96` 的命中是 ▶ 在引述「早於預期的『M80 收』」 | 已無第三份文件牴觸；保留的原文＋▶ 是樹規矩（**只加不刪**） |
| **D4** | 計畫自稱「唯一還沒做清單」，但殘餘在各紀錄——**結構性、by design** | 兩句都逐字在：計畫 `:3` 自稱「它是**唯一的『還沒做』清單**」；計畫 §5 `:90` 自己的規則說「**新的殘餘**一律先寫進該單位的 spec §5，再由 M80 決定去留；**不直接塞進這張表**（否則它會變成第二個落後的 `queued-work.md`）」 | **by design**：計畫的「唯一」只對**里程碑狀態**成立（§1 那張表），**殘餘清單**的載體是各單位的 spec §5 與紀錄——本稽核的輸入因此從**紀錄組**來（本檔＋舊半檔），不是從計畫抄。**這是設計的兩份東西，不是矛盾**；不修（改任一句都會讓另一句更假） |
| **D5** | M79 紀錄與計畫列的「合併尚未進行」 | **已收**：紀錄 `:5` 保留原文，`:6` 就是 **▶ 已合併（2026-09-24）：PR #15 → `bc45dce`**，並附 tree 相等的兩個證明（`git rev-parse m79^{tree}` ＝ `bc45dce^{tree}` ＝ `3f2bbabb…`；`git diff bc45dce m79 --stat` 空），末尾自陳「上面那句…只描述寫下時的那一刻」；計畫 `:31` 的 M79 列寫 **PR #15 → `bc45dce`** ＋ 閘門 3133／456 | 兩側都處理完（原文＋▶／狀態列），沒有第三份文件牴觸 |
| **D6**（soft） | 計畫 §0「沒有任何東西卡在產品決定上」（僅指 queued-work Q1–Q8）vs 紀錄的兩個開放產品決定（`forkTurns` 預設；拒絕之後的行為） | 計畫 `:18` 的句子**沒有限定詞**，但它的主語在**同一句**裡——「它的 A 堆是空的，而且 `Q1–Q8` 全部有答案（`:549-554`）」⇒ **它是對 `queued-work.md` 說的**。而樹上的產品決定不只兩個：本表 ③ 三條（M76 5、M77 9、M77 23）＋ Part 1 的五條（M69 1、M72Ⅲ 116／117、M73 98、M74 99）＝ **8 條**（量的方式：逐列數兩張 Tier-2 表的 ③） | **措辭與範圍的問題**：句子對它的主語為真、對全樹為假。今天兩側都留著（計畫是**活文件**、這一輪沒有改它這一句）⇒ 判為**已足**（收線紀錄 §3 的判準 2 要的正是「③附問題」的逐條歸類，本表與 Part 1 都做了）。**建議**：readiness 紀錄引用它時**把主語一起引**（`queued-work` 的 A 堆與 Q1–Q8），不要單獨引「沒有任何東西卡在產品決定上」 |

**D1–D6 的總讀數**（每列恰好一種）：**3 已修**（D2／D3／D5）＋ **1 半修**（D1——三件裡一件帶 ▶）＋ **1 by design**（D4，不修且不該修）＋ **1 措辭**（D6，兩側都留、以引用方式約束）＝ **6**。

---

## §E 兩個候選的處置

### §2.45（計畫 `:50`）— **明說接受**，觸發條件＝第一次有真 provider 的部署

- **裁定**（spec §1.4，`docs/superpowers/specs/2026-09-24-m80-backend-readiness-design.md:87`，逐字）：**「樹上沒有真 provider ⇒ 快取側量不到；紅利側已量到且壓倒性（超窗 2→1 請求）。觸發條件：第一次有真 provider 的部署（量 `cacheReadTokens` 修前／修後）。代價：若快取損失佔上風，『放得下』那側的帳單可能更貴。」**
- **受影響的三條輸入項**：M78 1／M78 10／計畫 4（本表 §C-Tier-2 各一列，皆 ④）。
- **紅利側的讀數（已量）**：超窗時 **2 個請求 → 1**（計畫 §2.45 `:50`；M78 紀錄 §3「紅利那一側仍是真的且壓倒性」）。
- **成本側的讀數（已量）**：prune 讓摘要請求少了 **3 717 個 token**（計畫 §2.45 `:50`），代價是它與上次送出的主請求在第一個被 prune 的輸出處分岔 ⇒ 之後是全額。
- **量不到的依據**：「樹上從未發過真 provider 的請求」——本表能加的讀數：`git grep -ln 'stubGlobal("fetch"'` ⇒ **25 個檔命中，扣掉 `docs/**` 的 13 個引文（**本檔自己也是命中之一**）⇒ 12 個測試檔**；另一種引號形式 `git grep -ln "stubGlobal('fetch'"` ＝ **1 檔（就是本檔——引述該模式的那兩行；扣掉本檔 ⇒ 0 個測試檔）**（不是漏了寫法）⇒ 樹上沒有任何測試打真網絡。`ANTHROPIC_API_KEY`／`OPENAI_API_KEY` 在 `apps/**`／`packages/**` 只出現為**測試裡的名字**（`packages/provider/test/directory.test.ts:32`／`:53`／`:180`、`packages/settings/test/sections.test.ts:517`／`:540`），真正的值是執行期從 settings／env 解（`packages/provider-runtime/src/index.ts:266-267`）。這是**斷言式的既有事實**（Part 1 的 M72Ⅰ §7-6 列同樣處理），見 §G。
- **觸發條件可執行**：`provider/call` 已在報 `cacheReadTokens`（M78 §6 第 3 條逐字：「先量 `cacheReadTokens`（`provider/call` 已經在報）」）⇒ 部署時修前／修後各一次即可結案。

### §2.5（計畫 `:52`）— **做（A0）**，已由 M80 T1 交付

- **裁定**（spec §1.5，`…-m80-backend-readiness-design.md:91`；**節縮引文**——省去該句的「（同紀律、同樣板）」與「否決 A2 的理由是紀律…」兩處）：**「做（A0）」**——理由：與收線判準直接相關（**靜默空成功就是 M77 消滅的那一類**）；成本量到是 5＋2 檔；形狀與 M77 逐點對稱。*代價*：**A3 的覆蓋不做**（具名殘餘）。
- **交付**：**M80 T1 —— `2f9147e`**（`feat(core-agent,core-session,telemetry,cli): a non-content empty success stops being silent — provider/empty, step/end.empty, [empty] (M80)`）。`git show --stat` 親量：**7 檔 ＝ 5 src ＋ 2 測試檔**（`apps/cli/src/run.ts`、`packages/core-agent/src/index.ts`、`packages/core-session/src/index.ts`、`packages/telemetry/src/manifest.ts`、`packages/telemetry/src/types.ts`；`packages/core-agent/test/agent.test.ts`、`apps/cli/test/metrics-summary.test.ts`）——與 spec §0.5 量到的「A0 ＝ 5 src ＋ 2 測試檔」**逐檔相同**。
- **HEAD 讀數（四條通道都在）**：① 判定點 `packages/core-agent/src/index.ts:512-514`（`stepText === "" && toolCallsThisStep === 0 && !truncatedThisStep && !refusedThisStep`）⇒ `:513` 發 `provider/empty`；② 耐久位 `:515` 的 `step/end.empty`（型別註解在 `packages/core-session/src/index.ts:25`，逐字寫出「Excluded by construction from a step that was `truncated` or `refused`… a step whose only output was a tool call is NOT empty」）；③ manifest **24 列**（`:44` 的 `provider/empty` 列）；④ CLI `[empty]`（`apps/cli/src/run.ts:931`）＋ `result.empty`（`:934` 的 `...(empty ? { empty: true } : {})`）。
- **六個案例的形狀都在**（spec §2 第 3 條）：`packages/core-agent/test/agent.test.ts` 4 條（`:663` 空步寫耐久位＋telemetry／`:692` 乾淨步不寫／`:709` `refused` 或 `truncated` 不雙報／`:743` 只有 tool call **不是** empty）＋ `apps/cli/test/metrics-summary.test.ts` 3 條（`:305` 空 run 說在 stderr 與 result／`:316` 乾淨 run 兩者都不／`:329` 真 CLI **exactly-once**）。
- **代價與具名殘餘**（照裁定入表）：**A3（seam 層）不做** ⇒ `compaction`／`session-title` 自己的模型呼叫不在這個位（spec §1.5）＋「有欄位卻帶著不可累積 parts」的角落仍未覆蓋（spec §4.3，逐字「**不保證 §2.5 之後沒有靜默空成功**」）。**兩者都不在輸入清單的新半條目裡** ⇒ 由本節承接，不另開列。

---

## §F 計畫 §4「不是後端的事」逐條重驗（8 條輸入項；第 1 條的兩個句子分開量 ⇒ 9 列）

| 輸入（計畫 §4） | 一句話 | 仍是事實？ | 量測（指令／讀數） |
|---|---|---|---|
| 8a（`:75`） | 五個零消費者套件：`fs-watch`／`goal`／`jobs`／`workspace` 等前端 | **是** | 逐套件掃生產面（`git grep -ln "@i-harness/<pkg>" -- 'packages/*/src' 'apps/*/src'` 扣掉自己）：`fs-watch`／`goal`／`jobs`／`workspace` **零命中**；處置逐條在 `docs/handoff/2026-09-18-backend-backlog.md` §2.1（列表逐字：等前端／前端／前端／前端）。對照組仍在同一節（`core-session` 48／`session-persistence` 18） |
| 8b（`:75`） | `schedule` 的缺口已由 W3 補上 | **是（歸因寬鬆）** | `@i-harness/schedule` 今天**有**生產消費者：`packages/session-executor/src/assembly.ts`（工具 `createScheduleTools` 與 driver 的掛載，backlog §2.1 的 ▶ 逐字給行號）。歸因：**W3 交的是 spec**（`docs/handoff/2026-09-20-queued-work.md` §4／`:895`，owner 2026-09-20 核准），**接線是 M66 的六個任務**（`742bc96f`／`700e81b9`／`b0d29271`／`3ee94dcd`／`a7a84a7a`／`a4d07e63`，皆 `git cat-file -t` ＝ commit）⇒ 「已補上」為真、把兩者併成「W3」寬鬆 |
| 9（`:76`） | `settings/*` 上 sdk 線：Q7「是，但先不要建」 | **是** | 答案逐字在兩處：`docs/handoff/2026-09-18-backend-backlog.md:206`（「**✅ 2026-09-22 owner 裁定：是（走 (a)），但現在不建** —— 觸發條件是前端做到需要設定面」）與 `docs/handoff/2026-09-20-queued-work.md:551`（同句＋「不要在它上面蓋東西」）。樹上的對照量測：`grep -n "settings" packages/sdk/src/server.ts` ⇒ 唯一一處是 `:861` 的「wire contract, **not the settings resolver**」⇒ sdk 線上**沒有** settings 面 |
| 10（`:77`） | hooks 核准的 UI：今天只有 CLI | **是** | `apps/cli/src/hooks.ts:47`（`subcommand: "list" \| "approve" \| "revoke" \| "help"`）與 `:63` 的用法行；共用的 store 是 `<home>/hook-trust.json`（`packages/hooks/src/trust.ts:61-66`）。`git ls-files \| grep -c "packages/tui\|apps/tui\|packages/web-host"` ＝ **0**（M65 已刪）⇒ 除 CLI 外**沒有任何面** |
| 11（`:78`） | R-B4 git snapshot/undo 的 plan B：等產品反饋 | **是** | 三處逐字都在：`docs/roadmap/2026-08-31-roadmap-B-tools.md:18`（R-B4 列「中長期」）與 `:87`（「**後補 \| 待 UI 產品反饋定 undo 形狀（M27+）**」）、`docs/roadmap/2026-08-31-m27-backlog.md:64`（「R-B4 \| M27+ \| git 快照/undo——唯一 L 級，隨產品反饋定」）；plan A 已落地（M58）的註在 `docs/CAPABILITIES.md:142` |
| 12（`:79`） | H-3 MCP 真 AS：與 `CAPABILITIES.md:51` 矛盾（⇒ M80 收） | **不再是「不是後端的事」——已收（本條改歸「已交付」）** | M80 T5（`00067ec`）已修狀態列：`docs/roadmap/2026-08-31-m27-backlog.md:30`（「**✅ 已落地（M28，2026-09-01，`44db372`）** —— 自建真 AS 的契約測試…」）與 `:75`（「✅ 已完成（M28）」）；`docs/CAPABILITIES.md:51` 的「真 AS 測試」**為真、不動**（測試在 `packages/mcp-client/test/oauth-real-as.test.ts`）。ⓘ **計畫 §4 的那一行今天仍以「⇒ M80 收」結尾**（`docs/handoff/2026-09-23-backend-closure-plan.md:79`）——該工作已完成，這是一句**尚未更新的收工語**（與 D1 同一個形狀、同一個載體）⇒ 分類：**已交付**，不是「不是後端的事」 |
| 13（`:80`） | 前端重建本體（web／desktop）：使用者端專案（Q6） | **是** | Q6 那一列逐字在 `docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md:305`（「『重建前端』是一個**客戶端專案**，不是後端專案 —— 後端的責任是讓那條 wire 值得被蓋在上面」）；樹上今天**沒有**任何前端套件（同上第 10 列的量測：tui／web-host 皆 0 檔）⇒ 這一條的形狀在 M65 之後更乾淨（唯一的契約是 sdk 的 wire） |
| 14（`:81`） | 非目標（PTC／code-mode、workflow worker、provider registry、外掛執行、企業權限引擎、記憶子系統、M7 自我喚醒） | **是** | 清單逐條在 `docs/CAPABILITIES.md:141`（「**不做**：PTC/run_code、workflow worker、provider 註冊表化、插件執行」）與 `docs/superpowers/specs/2026-09-15-backend-polish-roadmap-design.md` §4「明確不做」（`:269-278`：權限規則引擎／企業治理層／plugin VM 與 code-mode／T6 記憶子系統（✅ 2026-09-22 裁定不做）…）。抽查（樹上沒有主體）：`git grep -rln "run_code\|codeMode\|code-mode" -- 'packages/*/src' 'apps/*/src'` ＝ **0**；`git grep -rln "eval(\|vm\."` 生產面 ＝ **0**；`git grep -rn "worker" -- packages/workflow/src` ＝ **0** |
| 15（`:82`） | 遠期觀望（R-A10、R-A11、R-B10、R-C8、R-D5、R-D6、R-E12、R-E13、macOS sandbox） | **是** | 清單逐條在 `docs/roadmap/2026-08-31-m27-backlog.md:50-56`（遠期觀望清單四行）與 `docs/CAPABILITIES.md:142`（遠期／觀望）；R-A10 另在 `docs/roadmap/2026-08-31-roadmap-A-core.md:24`／`:69`（「遠期候選」）。抽查（樹上沒有主體）：`packages/sandbox-local/src/index.ts` 只有 `win32`（`:33`／`:52`）與 `linux`（`:58`）兩個分支 ⇒ **macOS 沙箱沒有後端** |

**§F 的總讀數**：**8 條為真、1 條已不再是「不是後端的事」**（H-3，分類改成「已交付」——它是本次唯一一條**不必再等任何東西**的）。逐條都附了指令與讀數；沒有把已收的那條硬留在清單裡。

---

## §G 誠實註（兩條量不到 ＋ 一條指針狀態）

1. **量不到：真 provider 的那一側（快取、wire 形狀）。** §2.45 的快取側量不到（裁定為「明說接受」，見 §E），以及三條 wire 主張——M77 12（`delta.refusal` 的伴隨形狀，文件站 403）、M77 15（`response.completed` 的 `output[]` 是陳述的邊界）、M77 13（`refusal: ""` 的邊界未測）。**本表能做的只有把邊界具名＋把「今天不影響正確性」的理由找出來**（各列已做），**不假裝量過**。「樹上從未發過真 provider 的請求」本身是一個斷言式的既有事實（Part 1 的 M72Ⅰ §7-6 同樣處理）：本表加上的是 **12 個 stub-`fetch` 測試檔**（＋單引號形式：唯一的命中是本檔自己，測試檔 **0**）與「`apiKeyEnv` 在樹上只是名字」兩個側面讀數，**不是證明**。
2. **量不到：住在 gitignored ledger 的那半。** M79 §4 R3 的紅先裁決（「T4 的紅先＝拿掉觀察者」）**只住在 ledger**（`.superpowers/**`，gitignored）——M79 紀錄自己說「裁決在 ledger，複審可見」，而**樹上沒有第二份**。本表引的是紀錄的轉述＋樹上的痕跡（五個站點的測試存在、關閉者 `c0d1ea1`），**沒有讀 ledger、也不假裝讀過**。同類：M79 5 那一列的「反方向 4 檔」量測，載體只有紀錄（instrument 的註解只列 5 檔那一半）。
3. **指針狀態（不是殘餘，但讀者會撞到）：兩份紀錄的 ▶ 指向一份還沒寫的檔。** `docs/handoff/2026-09-24-m80-backend-readiness.md` **今天不存在**（`ls docs/handoff \| grep readiness` ＝ 0），而 `docs/handoff/2026-09-24-m77-refusal-channel.md:96` 與 `docs/handoff/2026-09-24-m79-coverage-completion.md:6` 都以它為「收線判讀的家」。它是本里程碑後面那個單位的交付物 ⇒ 現在是**待交付**，不是壞指針；本稽核（Part 1＋Part 2）就是它的輸入。

---

## 附：本 Part 用到的載重讀數（可重跑）

```bash
node scripts/audit/check-reachability.mjs | head -1     # reachability: 553 ts files, 456 finding(s)
grep -c "^  {" packages/telemetry/src/manifest.ts       # 24（M80 T1 補 provider/empty 之後）
sed -n '505,516p' packages/core-agent/src/index.ts      # 空成功的判定點與 provider/empty
git grep -n "EMPTY_RESPONSE" -- '*.ts'                  # 2 行，都在 llm-seam（零生產者）
grep -rn "function spyTelemetry" packages/*/test/*.ts | wc -l          # 7（5 檔）
git grep -n "Exclude<any" -- '*.ts'                     # 0
grep -rn "\.ts:[0-9]" packages/compaction/src/region.ts | wc -l        # 4（同包扣掉 slices.ts／region.ts 後剩 8）
grep -rn "\.ts:[0-9]" packages/compaction/src packages/compaction/test | grep -v "/slices.ts\|/region.ts" | wc -l   # 8
ls packages/*/test/site-diagnostics.test.ts | wc -l     # 11（T4/T5 的 helper 逐檔各一份）
printf '%s\n' "$(tr -dc '\r' < scripts/audit/reachability-allowlist.json | wc -c)"; printf '%s\n' "$(tr -dc '\r' < scripts/audit/reachability-baseline.json | wc -c)"  # 269 / 0（工作樹）
git show HEAD:scripts/audit/reachability-baseline.json | tr -dc '\r' | wc -c   # 0（blob）
for p in fs-watch goal jobs workspace schedule; do git grep -ln "@i-harness/$p" -- 'packages/*/src/**' 'apps/*/src/**' | grep -v "^packages/$p/"; done   # 前四個 0 命中、schedule 命中 assembly.ts
git ls-files | grep -c "packages/tui\|apps/tui\|packages/web-host\|apps/cli/src/web.ts"   # 0
git grep -rln "run_code\|codeMode\|code-mode" -- 'packages/*/src' 'apps/*/src'            # 0
grep -n "darwin" packages/sandbox-local/src/index.ts                                     # 0（只有 win32/linux）
grep -c "▶" docs/audit/2026-09-11-ih-backend-inventory.md                                # 0（20 rows 那條按 leave 原樣）
git grep -ln 'stubGlobal("fetch"' | grep -vc "^docs/"   # 12 個測試檔（命中 25，扣掉 13 個 docs 引文——含本檔）
git grep -ln "stubGlobal('fetch'" | wc -l               # 1 檔（本檔自己引述了該模式：扣掉本檔 ⇒ 0 個測試檔）
sed -n '57,67p' docs/handoff/2026-09-24-m79-coverage-completion.md   # 九條裁決（今天的行號＝輸入清單 +1）
```

本 Part 引用的 **26 個 commit** 全部以 `git cat-file -t <sha>` 檢查，**每一個都回 `commit`**（清單＝本 Part 正文出現的每一個 sha，逐條抽出後去重；括號是它在本 Part 的角色）：`2f9147e`（M80 T1）、`45bd37e`／`0496421`（19→23、23→24）、`230fd44`（manifest 牙齒）、`cd188d7`／`6bd35c7`（儀器剝註解）、`00067ec`（M80 T5 的指針與 H-3）、`d5d1144`／`c2e9e60`（種子端 warn）、`282e81e`／`bf85c64`／`ccb9df0`（M77 的三個內容側載體）、`5d080ef`（非分配性那句）、`c0d1ea1`（M79 T4 五站）、`a629acd`（兩個零生產者成員）、`0336fe4`（M78 的 prune 移動）、`1ac091e`（`mountPreset` 的 dated 重測）、`44db372`（M28 的自建 AS）、`bc45dce`／`5446d6bb`（M79／M78 的合併點）、`742bc96f`／`700e81b9`／`b0d29271`／`3ee94dcd`／`a7a84a7a`／`a4d07e63`（M66 的六個任務）。**另外兩個 hex 不是 commit 清單的一部分**：`a2a2bdd`（量測時的 HEAD）與 `3f2bbabb…`（M79 宣告的 tree hash，引紀錄原文）。
