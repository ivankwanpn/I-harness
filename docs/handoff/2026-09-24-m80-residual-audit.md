# M80 殘餘稽核（Part 1：舊半）— Tier-1 鏈關閉 ＋ Tier-2 四鍵

**這是什麼**：`docs/handoff/2026-09-24-m80-backend-readiness.md`（M80 收線紀錄）的**稽核輸入**——把舊半（M69–M75 ＋ W6，共 **113 條**）的每一條具名殘餘，沿鏈關閉或逐條歸類。方法逐條照 spec §1.3（`docs/superpowers/specs/2026-09-24-m80-backend-readiness-design.md`）。

**輸入**：`.superpowers/sdd/2026-09-24-m80-backend-readiness/task-6-input-old-half.md`（spec 前量測代理的清單；`path:line` **以內容定位**，行號是那次量測的數字）。本表的來源欄保留該清單的編號與行號（`M69 1（:84）`＝該節第 1 條、行號 `:84`），每一條**恰好出現一次**。

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
- **§B Tier-2**：至少一個具名部分在 HEAD 仍開 ⇒ 落四鍵之一（①修掉了／②等前端／③產品決定／④明說接受的成本）或 **`UNMEASURED`**；同列若另有部分被後續里程碑關掉，**在證據欄寫出關閉者＋commit**（不靜默丟棄）。`UNMEASURED` 只在該條**整體量不到**時使用，並具名量不到的東西。
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
| M69 5（`:89`） | T1／T2 deferred minor：註冊區塊前少一空行 | `UNMEASURED` | **量不到**：紀錄只說「T1／T2 的註冊區塊」，沒指出是哪一個 block；唯一候選（`packages/session-persistence/src/index.ts` 的 `registerEventType` 區）在 M70 插入 `tool/dispatch` 列之後，原始間距**無法由內容重建**（`git log -p` 未逐段追）。量到的只有：它是一行可讀性項、從未進任何 fix 清單 |
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
| M75 §5.10（`:74`＋`:76`） | Ruling 1：directive 本身的文字回歸不被那條斷言抓到；Ruling 3：串連規則曾有一格沒有突變證明（已移 Task 3） | ④ 明說接受的成本 | 兩半分開量：**前半仍開**——`messages.slice(0,-1)` 那條斷言蓋的是區域、不是 directive 文字（M75 §4 Ruling 1 的代價）。**後半已由本階段 Task 3 關掉**——`dbcca12`（`packages/compaction/test/summarizer-prefix.test.ts`：一個標記、串連、中途失敗仍原子）⇒ ① |

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
git log --oneline -S'六個相位有五個已有相位斷言' -- docs/handoff/2026-09-22-w6-diagnostics.md  # 00067ec（M80 T5 的指針）
git log --oneline -S'phase: "session", level: "warn"' -- packages/schedule/test/site-diagnostics.test.ts  # 4b57999（M71 T3）
gh pr view 6 --json body      # M72Ⅱ PR 的「三件必須明說的事」
```

本表引用的 **45 個 commit**（Tier-1 的關閉者 ＋ Tier-2 證據裡的關閉者）全部以 `git cat-file -t <sha>` 檢查，**每一個都回 `commit`**。
