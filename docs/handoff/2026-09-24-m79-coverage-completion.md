# M79（覆蓋率補齊——五個站點、四個 hop、兩個死成員、三件指派）交付紀錄

**一句話**：這一輪**不加功能**——把「行為已正確、但沒有觀察者／沒有牙齒」的指名位置補上，並修好一個**把註解當成使用**的儀器；儀器修好後**一次浮出 24 條被註解遮蔽的真發現**（reachability **432 → 456**），而 union 的 `telemetry`／`acp` 量到**零生產者** ⇒ **移除**而不是接線。

- **分支**：`m79`（from `main` `5446d6bb`）。**執行段**：`d2c18c35`（spec＋計畫）＋ 六個任務 ＋ 控制器的三處就地更正（`c037fe0`、`887f741`、`b43a5da`）＋ fix wave（`5d080ef`）＋ 本紀錄。合併尚未進行。
- **▶ 已合併（2026-09-24）：PR #15 → `bc45dce`** —— 合併後 tree 與分支尖端相同（`git rev-parse m79^{tree}` ＝ `bc45dce^{tree}` ＝ `3f2bbabb5ad641ffffeeb3b0262f8e753b6c4bc8`；`git diff bc45dce m79 --stat` 空），所以上面那句「合併尚未進行」只描述寫下時的那一刻。**M80 的收線紀錄：`docs/handoff/2026-09-24-m80-backend-readiness.md`。**
- **spec（權威）**：`docs/superpowers/specs/2026-09-24-coverage-completion-design.md`
- **計畫**：`docs/superpowers/plans/2026-09-24-coverage-completion.md`
- **它屬於**：`docs/handoff/2026-09-23-backend-closure-plan.md` 的 **M79／M76–M80**

---

## 1. 閘門與算術

**`pnpm verify:all` 在最終樹上 PASSED**（單獨執行）：

| 步驟 | 讀數 |
|---|---|
| suite | exit 0 · **3133 passed｜9 skipped｜0 failed** |
| population | **67 of 67** |
| typecheck | exit 0 |
| e2e | exit 0 · 5 檔 |
| reachability | exit 0 · **456 列** · `gate PASS -- no new rows`（digest `49399a6d…`） |

**算術**：M78 終態 **3124** ＋ **9** ＝ **3133**（T4 五站＋5、T5 三條＋3、T2 的 `phase-union.test.ts` ＋1）。**規劃期寫的「3124＋8＝3132」是錯的**——漏了 T2 的 `it`（型別斷言本身不加 `it(`，但它所在的檔要有一個 `it` 才不會 fail vitest 的 "No test suite found"）；終審抓到、spec 就地下更正。

**reachability 432 → 456（＋24／−0）**：24 條是儀器修好後第一次看得見的**被遮蔽真發現**（逐條清單在 §2.6），並由控制器用 `--json` 前後機械 diff 複核（`＋24／−0` 逐字相符）。播種同時丟掉 46 條自 2026-09-17 起離開 baseline 的列（ratchet 的既有重生路徑）。

---

## 2. 交付物（六個任務，逐條附最關鍵的讀數）

1. **T1 manifest 測試的牙齒**（`230fd44`）：`Missing extends never ? true : false = true` ⇒ 一個 union 成員沒有 manifest 列 ⇒ `pnpm typecheck` **紅在那一行**。變異證明：**舊樹上同一顆突變 exit 0**（缺陷重現）→ 新樹上 `TS2322` 且**全跑唯一錯誤**。執行期的同義反覆刪除；import 修剪一行（`noUnusedLocals` 逼出來的，已申報並寫回計畫）。
2. **T2 union 的兩個零生產者成員移除**（`a629acd`）：`telemetry`／`acp` **零生產者**（ACP 走 `cli` handle〔`apps/cli/src/index.ts:49`〕、telemetry 的 sink 錯誤仍是 W6 的指名 byte-untouched 例外〔`telemetry.ts:11,13`〕）⇒ **移除**；`record.ts` 的 doc comment 改寫（帶日期、理由、與「加成員要說縫」的協定）；`core-session:151` 的內聯複本**人手**同步；`phase-union.test.ts` 加「恰等於 8 個」的**雙向**型別斷言（紅先：今天 `exactA` 紅；兩顆突變各紅一側）。`apps/cli/src/index.ts:179` 的 `"acp"` 是 argv 判別字、不是相位引用（量測）。
3. **T3 `CAPABILITIES-DETAIL.md` 四個列數 19→23**（`45bd37e`）：`:22`／`:293`／`:295`／`:674` 全改 23、兩個行號範圍改 `manifest.ts:16-49`、列舉補 `provider/usage`／`provider/truncated`／`provider/refused` ⇒ 列舉與 manifest **順序敏感地完全相同**（23／23，複審親量）。
4. **T4 五個可驅動站點**（`c0d1ea1`）：plugin-registry `commands.ts:76`、hooks `trust.ts:87`、sdk `server.ts:224`／`:230`、core-plugin `index.ts:458`——**`sdk` 與 `shutdown` 因此首次有相位斷言**。五格各以「拿掉 `installDiagnostics` ⇒ `lines` 斷言紅」為紅先；五顆 `d.<level>→console.<level>` 突變**逐格命中**（sdk 兩格各自只殺自己那格）。core-plugin 用**假計時器**驅動 5 秒逾時：**15–17 ms** vs 真時間孿生（`plugin.test.ts`）**5017 ms**。
5. **T5 四個「窗口那半」hop 的誘餌觀察者**（`3b37ed3`）：`assembly.ts:1146`／`:1182`、`agent-team/src/scheduler.ts:221`、`guard-approval/src/guardian/reviewer.ts:178`——fixture 帶三顆**相異誘餌**（`contextWindow: 8_000`／`maxOutputTokens: 100_000`／`compact.contextWindow: 4_000`）；四顆變異逐一殺死具名斷言（`:1146`→`expected 100000 to be 8000`；閘→`expected 200000 to be undefined`；`:1182`／`scheduler`→同前）——**閘的窗口半只有新測試抓得到**（既有 M73 案例抓不到，複審確認）。測試 2 的缺席值**量出來**是「`budget` 整個 undefined」。
6. **T6 reachability 儀器剝註解**（`cd188d7`＋`6bd35c7`）：class 1 的「用了嗎」改讀**剝掉註解**的文字（**字串內容保留**——刻意防偽陽性）；entry **先剝註解再塗白 re-export**；逐檔備忘；self-test **38/38**（反轉「documented false negative」＋entry 案例＋字串護欄）；**432 → 456（＋24／−0）**——24 條：`agent-team#RosterDeps`／`TaskBoardDeps`／`MailboxDeps`、`core-agent#AgentBudgetConfig`／`ExecuteToolCallsOptions`／`SessionExecutorDeps`／`SessionExecutorRegistry`、`core-plugin#Listener`、`interaction#ApprovalRequest`、`plugin-registry#Capability`、`provider#Probe`、`rewind#createGitProbe`、`sandbox#EscalationContext`、`sdk#HarnessClient`、`session-query#closeSessionQueries`／`createSessionQuery`、`settings#normalizeSettings`／`FieldSpec`／`SEEDED_PROTOCOLS`／`mutateSection`、`subagent#RegisterSubagentOptions`／`TaskConcurrencyLimitError`、`workflow#WorkflowJobStore`、`workspace#Workspace`（每一條都量過：非宣告檔的提及全在**註解**裡；`plugin-registry#Capability` 的兩個真抑制站是 `provider/src/index.ts:85` 與 `sdk/src/server.ts:142`）；`codeOnly` 對 553 檔逐位元組不變；class 2/4/5 的註解危害量到（latent、本樹零列移動、不修）；`--seed-baseline` 重生掉了 46 條已離開的列（既有 ratchet 路徑）。

---

## 3. ⚠️ 這一輪最重要的那條：**規劃期的字面錯了四次，量測每一次都贏**

| # | 我的字面 | 量到的實況 | 誰抓到 |
|---|---|---|---|
| 1 | T3 的驗收：粗 grep（`19\|20` × `telemetry\|manifest`）「零命中」；逗號數 22 | **修前就非零命中**（`:328`／`:345`／`:490`／`:649` 的 19/20 坐在無關引用／數字裡）；22 是**列舉範圍**的數（整行 24，同行 `{ts,type,data}` 貢獻 2） | 實作者（改用宣稱範圍 grep；拒絕把檔案改成湊字面） |
| 2 | T6 的 self-test「36 → **39**」 | **38**（36＋2 新增；反轉不增案例） | 實作者（**拒絕為了湊字面而生第 39 條**） |
| 3 | T6 Step 5 的突變預測：entryText-only ⇒ 紅「反轉」那條 | 只紅**新增的 entry 條**（反轉的需 per-file 路徑） | 實作者 |
| 4 | spec 的算術「3124 ＋ 8 ＝ 3132」 | **3124 ＋ 9 ＝ 3133**（漏了 T2 的 `it`——純型別檔會 fail vitest 的 "No test suite found"） | **終審** |

前三次就地更正進計畫（`887f741`、`b43a5da`），第四次進 spec。**這是本樹第 N 次「計畫的字面是預測、量測是事實」**——而四次裡沒有一個實作者遷就字面。反過來說：**終審替本單位抓到的是兩條「註解宣稱超過量測」**（I1 `assembly.test.ts` 的區塊理由句雙重為假、I2 `core-plugin` 的「~0ms」vs 15–17 ms）——正是本單位要消滅的那一類，已由 fix wave 修正。

---

## 4. 裁決（Rulings）— 九條，逐條附代價

1. **工作區＝分支 `m79` 就地執行**（不建 worktree）。*代價*：無（分支即隔離）。
2. **T1 保留一個刻意同義反覆的執行期 `expect`**：它是 `noUnusedLocals` 的 keep-alive；承重的是型別註解（由突變證明）。*代價*：讀者可能誤讀那行（註解已寫明）。
3. **T4 的「紅先」＝拿掉觀察者**（覆蓋型任務的生產行為今天已正確）。*代價*：複審可能誤判「沒有紅先」（裁決在 ledger，複審可見）。
4. **T4／T6 的小工具逐檔重複是 house style**（9 個先例；抽共用作耦合）。*代價*：~10 行模板未來可能各自漂移。
5. **T2 的內聯 union 複本（core-session）保留**（零依賴是既有設計；只同步字面）。*代價*：兩份字面可再漂移（單向檢查已具名為殘餘）。
6. **接受兩個既有測試檔的檔頭註解改動**（hooks／plugin-registry）：檔頭各自列舉覆蓋範圍，加了格子後會變假話；複審驗過 comment-only、事實為真、零既有案例被動。*代價*：失去「既有測試檔逐字未動」的保證（改動已逐條具名）。
7. **parked**：`check-reachability.mjs:548-549` 對 class 3 的方向描述錯（`unread-flag` 也是鑄列方向）。*代價*：一句散文對 class 3 的敘述與 class 1 讀起來不同（紀錄已載；本樹 0 實例）。
8. **parked**：`:555-556`「every span inside a regex source」只對觸發成立（塗白延伸到行尾，含 literal 之後的程式碼）。*代價*：讀者以為 span 只含 regex（實質句「零個 export 名」不受影響）。
9. **parked**：`assembly.test.ts:1585-1586` 的 compact 句對「這四個站」成立、非普遍宣稱（direct-child `assembly.ts:1077` 的 M73 案例會紅）。*代價*：未來讀者可能以為整個檔案都看不見該交換（複審自己說這是 scope 措辭、不是被推翻的量測）。

**這三條 parked 全屬本單位的核心類別**（註解宣稱超過量測）——照 SDD 沒有第二輪 fix wave，故在此逐條具名，不沉默。

---

## 5. 殘餘與 deferred minors

- **指名未覆蓋**：`subagent/src/tools.ts:829`（`session`，M71 量過驅不動）與 `subagent/src/child.ts:399`（只有 console 間諜）。
- **class 2/4/5 的註解危害**：量到 latent（本樹零列移動），**不修**（spec §3）。
- **core-session 內聯 union 的漂移檢查是單向的**（pin 對 union 精確；內聯複本靠人手）。
- **只被字串提到的 export 仍不會有列**（刻意的取捨）——例：`interaction#Command` 被 `"-Command"` 字串藏住（複審確認是取捨不是漏洞）。
- **stripper 的 regex-literal 極限**：5 檔受影響（`task-board.ts`、`lsp/render.ts`、`plugin-registry/marketplaces.ts`、`rewind/path.ts`、`settings/index.ts`；全部 regex 內、**零個含 export 名**）+ 反方向的 4 檔（保留未剝的註解；**量到沒有列被藏住**）。
- **`docs/` 其餘過期載體**（2026-09-11／15 audit 的「20 rows」、2026-09-17 spec 的「是 20」、W6 handoff `:167` 的「六個可翻」、`docs/audit/2026-09-15-reachability-baseline.md` §6.2 隨 M65 死掉的 `mountPreset` 主張）——**歷史快照不改**，M80 的文件一致性範圍。
- **allowlist 的 note** 說兩個資料檔是 CRLF、baseline 現在是 LF（may-ship；blobs 兩邊都是 LF）。
- T5 的 `compact` 誘餌讓主 session 自動壓縮保持 enabled（今天穩定；fixture 脆弱點）；T5/T4 的 helper 重複（先例一致）。
- T2 的 `Exclude<any, X>` = `any` 洞（威脅模型註記）；T1/T2 的非分配性只寫在 fix wave 補的那一句。

---

## 6. 給下一個動這條鏈的人

1. **reachability**：儀器現在**剝註解**（字串保留）；列集合 456、`--seed-baseline` 會重生（含丟掉已離開的列——那是 ratchet 的既有路徑）。**在 CRLF 工作樹上播種**照 allowlist 的 note 處理。
2. **相位 union 恰 8 個**（雙向 pin）；加成員是**一個決定**——提交要說出它來自哪條縫；core-session 的內聯複本**手動同步**。
3. **四個 hop 的觀察者是誘餌設計**：改那些 fixture 時**保持誘餌值相異**，否則交換會變回不可觀察。
4. **計畫的字面是預測**：本單位四個字面錯，全由量測抓到——任何驗收指令**先量再信**。
