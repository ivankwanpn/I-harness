# `operator/run-end`（durable run 紀錄）：**T1–T3 完成，T4 未做**（3／4）

**Written:** 2026-09-22，SDD 執行 session，分支 `m69`。依 owner 指示在 **T3 收線**後停下寫這份記錄。
**Audience:** 把 **T4（收尾閘門＋記錄）** 與**終審全分支複審**跑完的人；以及日後要查這個單元究竟證明了什麼的人。
**State measured at:** `c2824ab`（`m69` 的 tip）。**行號會腐，引用前先重量**（本 repo 既有紀律）。自重：

```bash
git log --oneline -3 m69 && git status -sb
```

---

## 0. 先看五件事

| Fact | Value |
|---|---|
| 分支 | `m69`，tip `c2824ab`，工作區乾淨，與 `origin/m69` 同步 |
| 計畫 | `docs/superpowers/plans/2026-09-22-operator-run-end.md`（4 條任務） |
| spec | `docs/superpowers/specs/2026-09-22-operator-run-end-design.md`（本計畫的權威） |
| ledger | `.superpowers/sdd/2026-09-22-operator-run-end/progress.md`（**gitignored**，遷移要手動複製） |
| 未跑 | `pnpm verify:all`（T4 的第一步）與**終審複審**——這兩件是「還沒做」，不是「做完沒記」 |

## 1. 完成了什麼（每條都有 commit 與「它證明了什麼」）

| Task | Commit | 證明了什麼 |
|---|---|---|
| T1 事件＋載入閘門 | `db996b3` | `operator/run-end` 進 `SessionEvent` union（phase 詞彙**內聯**，core-session 保持零依賴）；`session-persistence` 註冊它、**不是** `ignorable`。驗收形狀是**載入往返**（存→重開→`load`→事件還在），紅有兩段：`tsc` 的 unknown member → 執行期的 `SessionFormatUnsupportedError`。複審：✅ Approved，0C／0I／3 Minor |
| T2 生產者三站 | `fb0349f` | CLI 的 `run` 在三個出口寫紀錄（組裝前失敗→`mount`／成功→`run`／run 失敗→`run`），各自緊鄰**既有的**排空；`error` 走 `fromError(err, redactor).message`；bootstrap 回傳 `runId`＋`redactor`，`runId` 與診斷 JSONL 的 `run` 欄位相同。突變證明兩條（拿掉成功站點、把 append 移到 `close()` 之後）**都真的紅**，且紅的案例比計畫預測各多一條。複審：✅ Approved，0C／**1 Important（plan-mandated）**／6 Minor |
| T3 表面 | `c2824ab` | `sessions list` 多一欄 `LAST RUN`（`ok 1.2s`／`failed exit 1 0.4s`／`—`），`sessions show` 多一行 `run end: exit 1 · 0.4s — …`；`lastRun` 是**投影**（不把 `runId`／`phase` 洩進 `--json`）。複審：✅ Approved，0C／0I／1 Minor |
| （控制器）計畫更正 | `65d09f4`、`15a8ae4`、`e812aa6`、`af958fb` | 執行期量測推翻了計畫原稿的三處（見 §4）；每一筆都只有 docs |

讀數（各自在自己的 commit 上量）：T1 focused 1/1、`session-persistence` 82/82、`core-session` 94/94；T2 `run-end` 6/6 與 CLI 全包 289 passed｜1 skipped；T3 sessions 15/15 與 CLI 全包 **291 passed｜1 skipped**；`check-reachability --gate` 在 `c2824ab` 上 **PASS -- no new rows**（控制器親跑）。

## 2. 還沒做什麼（接手指令）

1. **T4**：`pnpm verify:all`（五步；母體 67；`--gate` 不得新增 row）→ 記錄三處：queue doc 的 C1 列翻 ✅、M3 spec §3.4 加 dated 註記、**本單元自己的 spec §4 加第 5 條**（durable 寫入失敗 ⇒ 一筆 run 兩筆紀錄 ⇒ 讀取端**最後一筆為準**）。細節在 `task-4-brief.md`。
2. **終審全分支複審**（最強模型）：`scripts/review-package PLAN_FILE <merge-base> HEAD`，並把 ledger 的 **deferred minor 與 parked 清單**交給它分級。
3. **`superpowers:finishing-a-development-branch`**：主分支的合併時機**由 owner 決定**，不要自行推 `main`。

接手的跑法：`superpowers:subagent-driven-development` 指向同一份計畫。**ledger 的第一行就是這份計畫的路徑**；有 `Task N: complete` 的就是已完成，**不要重派**（T1–T3 已完成）。briefs 已在 workspace 內（`task-4-brief.md` 可直接用）。

## 3. 我做的裁定（逐條附「若錯的代價」）

| # | 裁定 | 若錯的代價 |
|---|---|---|
| R1 | T1 的 RED #1 走 `pnpm --filter … typecheck` 讀，**不是** vitest 跑（vitest 不檢查型別，兩個紅會塌成一個） | 多一條指令、紅的敘述不同；不動程式碼 |
| R2 | `apps/cli` 的新 export **不可能**產生 reachability row（該儀器的 class 1 只報 `packages/*/src/index.ts`）⇒ 不需 allowlist | 多一列 allowlist（附 `reason`＋`dated`）；Task 4 的閘門會自己說 |
| R3 | 本 repo 的提交**一律不加 attribution trailer**，覆蓋 harness 層的提醒 | 歷史多一條 trailer，而本 repo **禁止 amend**，拿不掉 |
| R4 | **計畫缺陷**：T2 的測試必須每個 run 都帶 `--session-dir`，掃描也讀同一目錄（見 §4） | 整組正向案例會對著**空 store** 斷言；功能在預設路徑上根本不會觸發 |
| R5 | T2 的 RED 是**五條**不是六條：resume 那條斷言「沒有紀錄」，在 RED 階段本來就會過 | 一輪修在一個從沒壞過的案例上 |
| R6 | 「blob EOL 是 CRLF」的疑慮**不成立**：`core.autocrlf=true` 讓 checkout 是 CRLF、**blob 是 LF**（實測 0 個 CR） | 一次純 EOL 正規化提交；無語意影響 |
| R7 | `flush` 拒絕時一筆 run 有**兩筆**紀錄 ⇒ **讀取端最後一筆為準**（`.at(-1)`）；**不**把站點 ② 移到 flush 之後 | 極窄情況下 `sessions list` 可能把失敗的 run 顯示成 `ok`；反過來改則會在**常見**的成功路徑上丟掉紀錄 |
| R8 | 宿主自帶 `opts.session` 時紀錄只留在記憶體（無 shipped path 這樣做）⇒ 記為真實但不可達的 minor | embedder 同時給 `session` 與 `coordinator` 時看不到紀錄；CLI 行為不變 |
| R9 | **計畫內部衝突**：既有的表頭斷言是**錨定**的，新欄必破它 ⇒ 授權改**那一行**（見 §4） | 改了既有斷言的一行，意圖原樣保留；替代方案是欄位條件式出現，而計畫自己的測試與之矛盾 |
| R10 | `LAST RUN` **不**篩 phase：一個 session log 可以累積好幾次 run 的結局（`--resume` 會再寫一筆），欄位語意是「這個 session 最近一次 run 怎麼結束」 | 可能顯示 `mount` 相位的一筆；該行仍照實渲染 exit／時長／error |
| R11 | `runId` **有寫進紀錄、卻沒有任何表面顯示它**（§1.3 的接合因此要靠讀原始 jsonl）⇒ **交棒**，不在 T3 之後才改需求 | 紀錄最有價值的一個欄位保持不可見；補一行渲染或一個投影欄位即可關掉 |

## 4. 計畫被量測推翻的三處（都在執行中更正並提交）

1. **生產者是三站，不是漏斗**（`7360f36`，寫計畫前）：`run.ts` 的成功路徑在 `emitSessionEnd(0)` **之前**就 `coordinator.close()`，把 append 放進漏斗會讓成功那一筆被關掉的 coordinator 吃掉。
2. **測試必須 store-backed（R4／`65d09f4`）**：`apps/cli/src/index.ts` **只在 `--session-dir` 下**接線協調器與 `create()`。原稿的 `run` 沒有這個旗標 ⇒ 沒有 session 文件、`activeId === undefined` ⇒ 生產者什麼都不寫：四條正向案例會全數落空，而「resume 不寫」那條會**因為錯誤的理由通過**（先撞上 `--resume` 需要 `--session-dir` 的拒絕）。**附帶後果**：**ephemeral（無 `--session-dir`）的執行永遠沒有紀錄**——這比 spec §4.1 原稿的「session 存在之前就死」更寬，T4 要寫進 spec。
3. **錨定的表頭斷言（R9／`af958fb`）**：`apps/cli/test/sessions.test.ts` 用 `/^ID\s+TITLE\s+TURNS\s+UPDATED$/` 釘住表頭，加欄位必破；量測全樹只有**那一行**（＋`src/sessions.ts` 的 doc comment）出現欄名 ⇒ 授權只改那一行，意圖（欄位對齊、欄序）保留。

## 5. 殘餘與待辦（終審請從這裡分級）

1. **R11（最重要）**：`runId` 未露面。紀錄有它、表面沒有 ⇒ §1.3 的「拿那一行回 JSONL 撈整個 run」今天要靠讀原始 session jsonl。建議：在那行渲染 `runId`，或加進 row 投影（注意別洩進 `sessions list --json`，那是刻意的白名單）。
2. **R8**：宿主自帶 `opts.session` 時紀錄不落地（無 shipped path 觸發）。`sdk`／`acp` 的 run-end 仍是 spec §3 的具名 residual。
3. **漂移檢查是單向的**：`DiagnosticPhase` ⊆ 內聯 union 會被編譯器抓到，反向不會。要雙向就加一行 assignability 斷言或一個列舉 union 的測試。
4. **陳舊引用**：`apps/cli/test/run-end.test.ts:103` 的註解引 `` `run.ts:342-346` ``，T2 的 diff 把那段推到 **`run.ts:379-382`**（`loadOwned` 的 catch：`emitSessionEnd(1)`／`telemetry?.close()`／`return`，控制器在 `c2824ab` 上**重量**）。當時刻意保持測試檔逐字元等於 brief ⇒ 沒改。**修正它符合本 repo 的 citations-rot 紀律**。（T2 複審當時報的替換值是 `:355-359`——**那是錯的**，那幾行是 helper 自己的 `append`；這是「引用會腐、寫前重量」的又一個實例，順手記下以免下一個人照抄。）
5. **T3 的 deferred minor**：`sessions.test.ts` 的 `toContain("—")` 沒有隔離 `LAST RUN` 格（UPDATED 格也可能是同一個字元），且「缺席而非 `undefined` 值」這條慣例**沒有任何斷言**——回歸成 `row.lastRun = undefined` 仍會全綠。建議：行尾 `endsWith("—")` ＋資料層 `not.toHaveProperty("lastRun")`。
6. **T1／T2 的 deferred minor**：註冊區塊前少一空行（可讀性）；union 註解聲稱的「生產者賦值是編譯期檢查」在 T2 落地後**已成真**（複審已具名查核：`appendRunEnd` 的參數是 `DiagnosticPhase`）。

## 6. 已知的閘門陷阱（別踩）

- **`pnpm verify:all` 才是閘門**；`pnpm -r --no-bail test` 單獨跑不算。
- 本 suite 有**已量測的負載 flake**（W6 的記錄：BASE 自身 3 跑中 2 跑紅）。T2 期間也出現過一次 `cli.test.ts` 的 M12 retry（300 ms 預算）；實作者以四組對照跑歸因，複審另以機制確認**本次改動不貢獻**（那個測試直接呼叫 `runHeadless`，無 coordinator ⇒ 生產者第一個 guard 就返回）。可疑失敗**先單獨跑該套件**，兩個讀數都記。
- `.superpowers/` 是 gitignored 的 scratch：**ledger、briefs、報告、review packages 都不在 git 裡**。換機／換 session 要手動複製整個 `2026-09-22-operator-run-end/` 目錄。

---

**這份記錄的性質**：它是 **partial**——T4 與終審還沒跑。跑完 T4 的人應該把它收成終態（檔名去掉 `-partial`，比照 W6 的 `2026-09-22-w6-diagnostics.md`）。
