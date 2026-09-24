# M80 — 文件債 ＋ 後端收線稽核 Design

**一句話**：**收線**。把**活文件**上量到為假的宣稱修成真的、把四處矛盾以最新量測解掉、把 **~200 條具名殘餘**沿鏈關閉或逐條歸類成四類、**順手把 §2.5 的靜默空成功關掉**（量到 A0 只要 5 src ＋ 2 測試檔），然後用**讀數**回答「後端打磨完成了沒有、可不可以進前端」。

**來源**：`docs/handoff/2026-09-23-backend-closure-plan.md` §1（M80）／§0（四處矛盾）／§2.45／§2.5／§3（判準）；五份 spec 前量測（四處矛盾、活文件過期宣稱三分表、舊半／新半殘餘清單、§2.5 最小版波及面）。

**分級**：**M–L**。計畫原本寫 S——量測把它升了一級：文件債的真實範圍大一個量級，且 §2.5 會多一個小任務。

---

## 0. 事實（全部在 `bc45dce`／`m80` 樹上量過）

### 0.1 活文件 vs 快照的分界

- **活（要修）**：`docs/CAPABILITIES.md`、`docs/CAPABILITIES-DETAIL.md`、`docs/contracts.md`、`docs/handoff/2026-09-18-backend-backlog.md`、`docs/handoff/2026-09-20-queued-work.md`、`docs/handoff/2026-09-23-backend-closure-plan.md`、`docs/roadmap/2026-08-31-roadmap-E-platform.md` 與 `…-m27-backlog.md`（這兩份是 dated 清單，**只修未更新的狀態列、不重寫**）、`docs/handoff/HANDOFF.md`（只加 dated 指針）。
- **快照（不改本文；兩處加 dated 指針）**：`docs/audit/**`（27 檔＋data）、`docs/handoff/` 的 34 份 dated 紀錄、`docs/research/**`（25）、`docs/roadmap/` 其餘四份、`docs/superpowers/**`（190）。判準：本樹自己的規矩——「被超越的快照的修法是 **dated 更正**，不是無聲改寫」（`docs/audit/2026-09-15-reachability-baseline.md:1359`）。

### 0.2 要修的宣稱（逐檔清單，全部量過）

**A. `queued-work.md`**：§9.2（`:931-961`）——`B4`／`C3` 兩列的內容**已完成**（M72 Ⅲ `llm-openai-compatible:163`；M72 Ⅱ／M73 `llm-seam:310`）、三個堆標題（`A 堆「可以現在動」`／`B 堆「卡在決定」`／`C 堆「孤兒」`）**全部過期**、banner 的 `llm-seam:274` 引用已漂（欄位在 `:310`）。⇒ **整節重寫**。§6 的 `:535`／`:941` 的「現量：107 ＝ 94 ＋ 13」**已不可重現**（同一條指令今天 25 行；新切分**未量**）⇒ 重量並改寫。

**B. `backend-backlog.md` 11 行**：`:11`／`:28`／`:219`（「M4 工程完成（只差 Q8）」——Q8 已於 2026-09-22 裁定並落地）、`:31`（M7「卡住」——Q1 已答「暫不」）、`:68`（「第二半未動」自相矛盾於同檔 `:29`）、`:39`（W6 一半）、`:40`（redaction 缺口）、`:98`（schedule「需要 spec」——M66 已實作）、`:115-116`（445 findings → **456**；448 unused-export ／ 7 unconsulted-setting ／ 1 producerless-event）、`:204-207`＋`:209-210`＋`:222`（四題 Q 已全答）。

**C. `CAPABILITIES-DETAIL.md`**：
- **「未掛載」家族 8 行**（`:83`／`:118`／`:215`／`:617`／`:623`／`:624`／`:635`／`:636`）：`todo_write` 與 `read_image` **都已掛載**（`packages/session-executor/src/assembly.ts:833`／`:834`，M40 落地；`:617` 還明文宣稱它們「仍然成立且仍待處理」）。**這是全樹最嚴重的活文件假話。**
- **計數**：`:21`＋`:255` SessionEvent **34 → 36 個相異字面**（union 現在 `5-157`；兩個量測代理讀到 36（相異字面）與 37（成員行）——**修的時候以相異 `type` 字面為準、把三個缺的成員名列出**）；`:24`（HTTP ~53＋WS 7 → **0**，web-host 已刪且這一列不在 M65 註記的清單裡）；`:3`（**65 包 → 66**）；`:25`（sdk 方法——兩個代理量到 6 與 19，**修的時候從 `server.ts` 的 switch 重量**）；`:535`（live discovery 的 `/api/llm/probe`／`probe-apply`／fingerprint／`web.ts` 全不存在）；`:659`（`host.ts:2347-2348` 隨 web-host 死）；`:31`＋`:508`（「4 譯表」→ **5**）。
- **引用漂移**：§1.2 整張表的行號（`:59` 的 `assembly.ts:161-470` 與列上 `:168`…`:414`；實況 `createSessionAssembly` 在 `:405`、檔 1419 行）；§2 的 `path:line`（`:206` OAuth、`:289` 的 `command/run|done` 生產者已死、`:305`、`:332` 的 `sessionContextWindow` 已不存在、`:483`、`:486` 的 `SETTINGS_DEFAULTS` **鍵清單本身也錯**〔`theme`／`transcriptMode`／`busyEnter` 不存在；缺 `compaction`／`agents`〕）；§12 items 6／12／13／20-24／30。

**D. `CAPABILITIES.md`**：`:3`（65 → 66）、`:80`（`probe-apply`／fingerprint 不存在）。`:51` 的「真 AS 測試」**為真**（見 0.3.1）——不動。

**E. `contracts.md` 5 行**（`:20`／`:73`／`:119`／`:161`／`:194`＋`:200`）：web-host 已死；**這份沒有任何 M65 註記**。

**F. `roadmap-E-platform.md` `:26`／`:57`／`:85`**：live discovery 不是「遠期」——**已實作且有 CLI**（見 0.3.3）。

**G. `m27-backlog.md` `:30`／`:75`**：H-3 已由 M28 落地（自建 AS）；`:73`（H-1）的主體隨 web-host 死。

**H. dated 指針（不改本文）**：`w6-diagnostics:167`（六個可翻 → 五個已有斷言；`telemetry`／`acp` 已移除）、`2026-09-15-reachability-baseline:858` → §9.4、`HANDOFF.md:16`（live branch 早已不是 m65）、`m77-refusal-channel:94`（19 行已於 M79 修）、`m79-coverage-completion`（「合併尚未進行」）。

**I. 收線計畫自身**：`:29` M77 列**缺 PR/merge**（PR #13 → `bb266229`，tree 相等）；`:30` M78 列「留下的兩件」**少算 3 條**（record §5 有五條）；`:11` 的 §9.2 行範圍（`:931-957` → `:931-961`）；`:20` 的「四處矛盾」路由句（其中兩處已解）；`:48` §2.4 第 3 條仍以待辦文寫。

### 0.3 四處矛盾的事實（以最新量測為準）

1. **H-3 MCP 真 AS**：M28 交付的是**自建 AS**（`packages/mcp-client/test/oauth-real-as.test.ts`：RFC 8414 探索＋RFC 7591 註冊＋PKCE，全在 `node:http`、綁 loopback；**m28-design:84 的定義句就是答案**：「真 AS **契約**而非真外部 AS」）⇒ **`CAPABILITIES.md:51` 為真**；`m27-backlog:30`／`:75` 的「後補」是**沒更新的狀態**。量過：**沒有任何測試做 loopback 以外的 I/O**。
2. **R-E11**：`m27-backlog:72`／`:85`（「**不做**——決策關閉」，維持 M20「不新增」）vs `roadmap-E:26`／`:85`（「**已落地（M30）**」，用戶拍板覆蓋 M20）。**實測**：gemini／bedrock 是一級協議（`settings/src/sections.ts:110` 的 `PROVIDER_PROTOCOLS` 五個）；**variants 不存在**；live discovery 存在（見 3）。⇒ **m27-backlog 過期**。
3. **live discovery**：**已實作且在用**（`provider-runtime/src/index.ts:463` `probeModels`／`:521` `discoverModels` → CLI `apps/cli/src/models.ts` 的 `models probe`／`models refresh`）⇒ `CAPABILITIES.md:80` **實質為真**；`roadmap-E` 的「遠期」**過期**；**`CAPABILITIES-DETAIL:535` 的傳輸面全死**。**兩個語意不可混**：2026-09-02 的「不追自動合併」決策與「明確、用戶觸發的 probe」並存。未做的只有 **bedrock live probe（manual-only）與 variants**。
4. **`CAPABILITIES-DETAIL` 的漂移**：見 0.2C——**遠大於**一個「19→23」（那一項已由 M79 收）。

### 0.4 殘餘清單與稽核方法

- **兩份清單**：舊半（M69–M75＋W6）約 **115 條**、新半（M76–M79＋計畫）約 **89 條**；**成鏈**（例：anthropic 未夾 fallback → compaction 無 cap → 子代理無 compactor → 超窗變 reset → …，四份紀錄互相指涉）。
- **六處紀錄／計畫互相矛盾**：D1（§2.4 三件已交付仍以待辦寫）、D2（M78 列少算三條）、D3（列數項被兩份文件錯誤地再路由去 M80）、D4（計畫自稱「唯一清單」但殘餘在紀錄——by design，稽核輸入要從紀錄組）、D5（M79 列與紀錄的合併註）、D6（§0 的「沒有任何東西卡在產品決定上」與紀錄的兩個開放產品決定牴觸）。
- **兩個候選**：**§2.45**（快取側未量——樹上沒有真 provider）；**§2.5**（非內容空結束——量到 A0，見 0.5）。

### 0.5 §2.5 的量測（裁決輸入）

- **A0（完整 (a)）＝ 5 src ＋ 2 測試檔（~6–8 案例）**，可選 +1 文件：`core-agent`（判定＋telemetry）、`core-session`（`step/end.empty`）、`telemetry` types／manifest、`run.ts`（述詞＋`[empty]`＋`result.empty`）。覆蓋 **stderr ＋ 耐久 log ＋ result ＋ telemetry**——與 `truncated`／`refused` **完全同形**。
- **硬邊（量到）**：`provider/empty` 的字面**必須真的發**（只加 manifest 列 = reachability 多一列 `producerless-event` ⇒ gate exit 1）。
- **被否決的較小形狀**：**A2**（只在 CLI，1 檔）**必須用 `finalText` 當證據**——違反 `run.ts:892-894` 的「NOT a claim about `finalText`」紀律且會誤報 ⇒ **不用**；**A1**（只 telemetry）終端仍靜默、無耐久位 ⇒ 不足；**A3**（seam 層，~10 檔）只多買 compaction／session-title ⇒ **具名為殘餘**；**A4**（重試包）量測否決（無 retryPolicy 時不包上去）。
- **判定點**：`core-agent/src/index.ts:499-507`；述詞**必須帶** `!truncatedThisStep && !refusedThisStep`（否則雙報——M77 釘住兩者各自獨立的案例會紅）。
- **樣板**：M77 的 35 個案例散在 20+ 檔；其中 core-agent 3 個（`:574`／`:603`／`:620`）＋ CLI 3 個（`:136`／`:147`／`:237`）＋ 真 CLI fixture。**新增一個 M77 沒有的對照**：「只有 tool call、沒有文字 ⇒ **不是** empty」。

---

## 1. 設計

### 1.1 文件債的處置規則（三分，準則先寫）

- **fix**：**活文件**裡被量到為假的宣稱 ⇒ 改成量到的真（附指令）。
- **date-stamp**：**dated 紀錄／快照**被後續里程碑推翻 ⇒ **不改本文**，加一行 dated 指針（`▶ 已收線（MNN）`，本樹既有慣例）。
- **leave**：純歷史材料（audit／research／superpowers／其餘 roadmap 檔）。

### 1.2 四處矛盾的解法（逐條）

1. **H-3**：修 `m27-backlog:30`／`:75` 的狀態列（指向 M28 的自建 AS 與 m28-design:84 的定義句）；`CAPABILITIES.md:51` **不動**（已真）。
2. **R-E11**：修 `m27-backlog:72`／`:85`（指向 M30 的用戶拍板與 `roadmap-E:85` 的追加決策）；餘項（variants）保持遠期。
3. **live discovery**：修 `roadmap-E:26`／`:57`／`:85` 的「遠期」為「已落地（CLI `models probe`／`refresh`）；未做：bedrock probe、variants」；修 `CAPABILITIES-DETAIL:535` 與 `CAPABILITIES.md:80` 的傳輸面為存活面。
4. **CAPABILITIES-DETAIL 漂移**：見 0.2C，全部 fix＋引用重指。

### 1.3 稽核的方法（兩層）

- **Tier 1（沿鏈關閉）**：每一條被後續里程碑關掉的 ⇒ **引用關閉它的紀錄＋commit**（走位守衛→M76；拒絕通道→M77；prune-before-summarise→M78；儀器盲點／五站／四 hop→M79；Q8→M70＋M71；…）。
- **Tier 2（仍開者逐條歸類）**：每一條在 **HEAD 量現況**，落進四鍵：**①修掉了 ②等前端（附來源）③產品決定（附問題）④明說接受的成本（附數字）**。量不到的標 **`UNMEASURED`** 並具名。
- 稽核逐條回答計畫 §3 的四個判準——**用讀數不用形容詞**。

### 1.4 §2.45 的裁定：**明說接受**

樹上沒有真 provider ⇒ 快取側**量不到**；紅利側已量到且壓倒性（超窗 2→1 請求）。**觸發條件**：第一次有真 provider 的部署（量 `cacheReadTokens` 修前／修後）。*代價*：若快取損失佔上風，「放得下」那側的帳單可能更貴。

### 1.5 §2.5 的裁定：**做（A0）**

理由：與收線判準直接相關（**靜默空成功就是 M77 消滅的那一類**）；成本量到是 5＋2 檔；形狀與 M77 逐點對稱（同紀律、同樣板）；否決 A2 的理由是**紀律**（用 `finalText` 當證據會破 `run.ts` 的自律）而非風格。*代價*：最後一個單位多一個小任務；A3 的覆蓋不做（具名殘餘）。

### 1.6 就緒紀錄的內容契約

`docs/handoff/2026-09-24-m80-backend-readiness.md`（＝本單位紀錄＋稽核判決）：①**五讀數**（閘門）；②**Tier-1 鏈關閉表**（每條：來源 → 關閉者＋commit）；③**Tier-2 四鍵逐條**；④**四份文件互相一致**且都指向本紀錄（列指針）；⑤§2.45／§2.5 的處置；⑥**判決**：「後端打磨完成／可以進前端」＋逐條前置（若有）。

---

## 2. 驗收（每一條都要量）

1. **0.2 的 A–I 清單逐條為真**：每條附指令與讀數（`grep`／`sed` 層級）。
2. **四處矛盾**：每一處的**兩側**都被處理（fix 或 dated 指針）；**掃這四個關鍵詞沒有第三份文件牴觸**。
3. **§2.5 A0**：紅先（先在舊樹上寫測試 ⇒ 紅）＋**六個案例**（空步寫耐久位＋一則 telemetry／乾淨步什麼都不寫／`empty` 與 truncated／refused 不雙報／**tool-only 不是 empty**／CLI stderr＋result／真 CLI exactly-once）；`--gate` **不新列**（字面真的發）。
4. **稽核**：Tier-1 每條有關閉引用；Tier-2 每條有四鍵之一或 `UNMEASURED` 具名。
5. `pnpm verify:all` 五步全綠（母體 67）；**算術寫出來**（M79 基線 3133 ＋ §2.5 的案例數；`CAPABILITIES-DETAIL` 的 telemetry 四處 23 → **24** 同批更新——**實測為準**）。
6. **四份文件**（closure plan／CAPABILITIES／CAPABILITIES-DETAIL／queued-work）都指回 readiness 紀錄。

## 3. 刻意不做（YAGNI）

- 不修**快照**（audit／research／superpowers／其餘 roadmap）——dated 指針是例外。
- §2.5 **不做 A3**（seam 層）；**不碰** compaction／session-title。
- **不重寫** `CAPABILITIES-DETAIL` 的結構；**不重寫** roadmap 的歷史。
- 不做 provider variants、不做 bedrock live probe。
- **不刪**任何 dated 紀錄。

## 4. 它不保證什麼（明說）

1. **不保證掃到了所有過期宣稱**：清單來自五份量測（活文件全掃、快照抽樣）——「沒被列出」不等於「為真」。
2. **不保證 Tier-2 的每一鍵都無爭**：③與④的界線是判斷（逐條附理由）。
3. **不保證 §2.5 之後沒有靜默空成功**：A3 的範圍與「有欄位卻帶著不可累積 parts」的角落仍未覆蓋（具名）。
4. **不保證文件之後不再漂**：這一輪修的是**當下**；防漂的是**規則**（dated 更正）與**指針**。

## 5. 殘餘（寫出來，不是藏起來）

- **A3**（seam 層的 `empty` 位元）與 compaction／session-title 的覆蓋。
- **bedrock live probe** 與 **provider variants**（R-E11 餘項）。
- **真 provider 前的所有 `UNMEASURED`**（§2.45 的觸發條件）。
- W6 §7 的 deferred minors 與各紀錄的「量過但驅不動」——**逐條在 Tier-2 表**。
- **「沒有任何測試碰外部 AS」**——H-3 的契約面（m28-design 已標「可選升級」）。

## 6. 取樣與自創

| 部分 | 來源 |
|---|---|
| 三分處置規則 | 本樹既有規矩（`reachability-baseline:1359`）＋本輪量測 |
| 兩層稽核 | **本輪的判斷**（200 條逐條重量不現實；成鏈者引關閉者） |
| §2.45 明說接受 | **本輪的判斷**（沒有真 provider 就沒有讀數；紅利側已量） |
| §2.5 做 A0 | **本輪的判斷**（成本量到；否決更小的形狀是紀律理由） |
| 四鍵 | 計畫 §3.2 的原文 |
