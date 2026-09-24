# M80（文件債 ＋ 後端收線稽核）交付紀錄 —— **後端就緒紀錄**

**一句話**：**收線**。活文件上量到為假的宣稱全部改成量到的真（或加 dated 指針）、四處矛盾以最新量測解掉、**200 條具名殘餘逐條沿鏈關閉或落四鍵**、§2.5 的靜默空成功關掉（`provider/empty` 四個表面）——然後回答那個問題：**後端打磨完成，可以進前端**（逐條前置在 §5）。

- **分支**：`m80`（from `main` `bc45dce`）。**執行段**：spec＋計畫（`b7b5659`）＋ 八個任務（T1 code、T2–T5 文件、T6／T7 稽核）＋ 控制器的四次就地更正（`639a831`、`444f5a7`、`aeb556d`、`10c6558`）＋ 稽核後的一行指針更正（`a2a2bdd`）＋ 終審的**單一 fix wave**（`441f810`）＋ 本紀錄。**合併尚未進行**。
- **spec（權威）**：`docs/superpowers/specs/2026-09-24-m80-backend-readiness-design.md`
- **計畫**：`docs/superpowers/plans/2026-09-24-m80-backend-readiness.md`
- **稽核表**：`docs/handoff/2026-09-24-m80-residual-audit.md`（391 行；Part 1 ＋ Part 2）
- **它屬於**：`docs/handoff/2026-09-23-backend-closure-plan.md` 的 **M80／M76–M80**（**最後一個單位**）

---

## 1. 閘門與算術

**`pnpm verify:all` 在最終樹上 PASSED**（單獨執行）：

| 步驟 | 讀數 |
|---|---|
| suite | exit 0 · **3140 passed｜9 skipped｜0 failed** |
| population | **67 of 67** |
| typecheck | exit 0 |
| e2e | exit 0 · 5 檔 |
| reachability | exit 0 · **456 列** · `gate PASS -- no new rows`（digest `49399a6d…`） |

**算術**：M79 終態 **3133** ＋ **7** ＝ **3140**（T1 的七個案例：core-agent 4 ＋ CLI 3）。reachability 維持 **456**（`provider/empty` 有真生產者 ⇒ 不新列；拿掉 emit 的突變會多一列 `producerless-event` ⇒ exit 1——量過）。

---

## 2. 交付物

**①§2.5 A0——非內容空成功變可見**（`2f9147e`，5 src ＋ 2 test，+258/−3）：四個表面與 M77 的 `truncated`／`refused` **逐點對稱**——`provider/empty` telemetry、耐久 `step/end.empty?: true`、CLI `[empty]`、`HeadlessResult.empty`；述詞帶 `!truncated && !refused`（不雙報）；**新增一個 M77 沒有的牙**：只有 tool call、沒有文字的步**不是** empty。三顆變異全中（拿掉 emit ⇒ 案例紅＋`--gate` 457 列 `producerless-event`）。

**②文件債**（T2–T5 ＋ fix wave `441f810`）：`queued-work` §9.2 **收成短節**（banner→收線計畫與本紀錄；B4／C3 的完成句附 commit）＋ §6 列重量（census **26**）；`backend-backlog` 20 行（「只差 Q8」×3、M7、findings 445→456、Q 全答、schedule、§5/§6.3/§7 各列）；**`CAPABILITIES-DETAIL`**：**「todo_write／read_image 未掛載」家族 8 行**（M40 早就掛了）、SessionEvent 34→**37**、HTTP ~53／WS 7→**0**、65→**66** 包、sdk 方法→**19**（switch 順序）、telemetry 23→**24**（四站＋列舉）、§1.2 全表 19 列改引符號、§2 六處、§11 兩列、§12 items 6／12／13／18／20-24／30、`:268` 的 `step/end` 三欄；`CAPABILITIES.md` 2 行；`contracts.md` 5 行 web-host 殘留；`roadmap-E` 3 處（live discovery **已落地**）；`m27-backlog` 4 處（H-3 由 M28 自建 AS 完成、H-1 隨 M65 死）；**五條 dated 指針**（w6／m77／m79／HANDOFF／reachability §6.2）＋一條更正（`a2a2bdd`：五條相位斷言是 **M71 T3 的**、不是 M79 的）。三分規則：fix／date-stamp／leave（快照本文一律不改）。

**③收線稽核**（T6 `9d6d59f`／T7 `3e7723a`）：`docs/handoff/2026-09-24-m80-residual-audit.md`——**Part 1（舊半 M69–M75＋W6）113 條**、**Part 2（新半 M76–M79＋計畫）87 條＋§F 9 列**。合計 **200 條**：**Tier-1 30**（沿鏈關閉，逐條附關閉者＋commit，複審全部 `cat-file` 命中）／**Tier-2 162**（①**1**｜②**0**｜③**8**｜④**151**｜`UNMEASURED` **2**）。六處紀錄／計畫矛盾 **D1–D6** 逐條收；兩個候選照裁定入表；計畫 §4「不是後端的事」**9 列逐條在 HEAD 重驗**。

**④終審與它的 fix wave**（`441f810`）：終審（opus）＝ **Ready to merge — With fixes**（0 Critical／**3 Important**／7 Minor）——三條 Important 全是**本單位的核心類別**：稽核檔自己的**自匹配 grep 讀數**（3 站＋fix wave 自抓的第 4 站）、標題算術（79＋9≠87 ⇒ 79＋8 落 9 列）、**三個「no content」措辭**比述詞寬（reasoning-only 的步可達）；另修六個行號座標、兩個 T5 nits、`:268`。fix wave 後限定複審：**All findings addressed、無新 Critical／Important**。

---

## 3. ⚠️ 這一輪最重要的那條：**收線稽核的最大產物是「④＝151 條已計價、仍開」**

稽核的誠實讀數不是「殘餘都修好了」，是：**Tier-1 的 30 條有跡可循地關掉了；仍開的 162 條每一條都具名落鍵**——其中 **④ 151 條是「已具名、已計價、接受的成本」**（不是關閉）、**③ 8 條是產品決定**（附問題）、`UNMEASURED` 2 條（M69 的兩項，卡在 gitignored ledger）。**§3.2 要求的「每一條都被歸類」因此成立**——而「打磨完成」的正確讀法是：**沒有未知的洞**，不是「沒有洞」。

---

## 4. 裁決（Rulings）— M80 的，逐條附代價

1. **工作區＝分支 `m80` 就地執行**（不建 worktree）。*代價*：無。
2. **T2 把 §9.2 收成短節**（歷史表格不留在本文）。*代價*：想讀當時量測的人多開一次 git。
3. **T1 選 A0** 而非更小的 A2／A1；否決 A2 的理由是**紀律**（`run.ts` 自己那條「不是關於 `finalText` 的宣稱」）。*代價*：多四個 src 檔。
4. **T6／T7 允許 `UNMEASURED`＋具名**。*代價*：一個沒量到的其實量得到（複審會抓）。
5. **parked：fix wave 自己造成的引用位移**（audit `:336`／`:259`／`:270`／`:267` 與兩個 doc 的 `run.ts:909/917/931/934`、`manifest.ts:44` 在新 HEAD 各差 1–2 行）——每條對**它指名的樹**有效（Part 2 釘 `a2a2bdd`），是引用的腐、不是假的量測。*代價*：合併後的讀者落點差 1–2 行（已具名）。

---

## 5. 後端就緒判決（收線計畫 §3 的四條判準，逐條用讀數）

1. **`pnpm verify:all` 在最終樹上 PASSED** ⇒ §1 的五個讀數。✓
2. **殘餘清單每一條都被歸類** ⇒ 稽核 200 條：Tier-1 30（附關閉者）＋ Tier-2 162（①1／②0／③8／④151／UNMEASURED 2）＋ §F 9。**兩個候選已裁定**：§2.45 **明說接受**（觸發條件＝第一次有真 provider 的部署量 `cacheReadTokens`）；§2.5 **做 A0** 且已交付（`2f9147e`）。✓
3. **沒有「註解宣稱有效、其實無效」的已知未具名者**——本單位的主題就是獵它（文件債整條線）；終審自己抓到的三條 Important 全屬這一類且已修；**仍具名的**（措辭寬一點的三站＋`agent.test.ts:639` 一站＋引用位移）逐條在 §6。✓（以 §3.3 要求的「具名」形式）
4. **四份文件互相一致且都指回本紀錄** ⇒ closure plan／`CAPABILITIES.md`／`CAPABILITIES-DETAIL.md`／`queued-work.md` 各有一行指針（本提交）。✓

**判決：後端打磨完成，可以進前端。** 前置（逐條）：

- **8 條產品決定**（稽核 ③）在它們被碰到的時候要拍板（清單在稽核表）。
- **§2.45 的快取量測**等第一次有真 provider 的部署（觸發條件已寫）。
- **151 條 ④ 是已計價的 accepted cost 清單**——進前端時照它讀，不要當成「沒有」。

---

## 6. 殘餘（寫出來，不是藏起來）

- 稽核 **§G** 的兩條 `UNMEASURED`（M69，卡在 gitignored ledger：block 無法由內容指認、R11 措辭在 ledger 裡）。
- **fix wave 的引用位移**（parked，§4.5）。
- **三個「no content」措辭站**（`core-session:25`／`core-agent:507`＋沒人點過的 `agent.test.ts:639`）——與 A2 同族、比述詞寬一個詞。
- **A3**（seam 層的 `empty` 位元）與 compaction／session-title 的覆蓋；**bedrock live probe**；**provider variants**。
- **M79 的三條 parked**（紀錄已載）與 M76–M79 各紀錄的 deferred minors（稽核表逐條在案）。
- `CAPABILITIES-DETAIL:296` 之外仍有**目前正確**的行號引用（引用會腐——本樹的既有認識）。

## 7. 給下一個動這條鏈的人

1. **入口是這份紀錄**：判決在 §5、殘餘在 §6、逐條分類在稽核表。
2. **收線文件自己也會被自匹配的 grep 打敗**（終審 I1——修了四站）。寫「可重跑」的讀數，要在**出貨的那個 commit 上**跑。
3. **本單位的四個字面又錯了**（T3 的驗收 grep、T6 的「…只命中兩行」自指句、終審的 79＋9、fix wave 的位移）——**量測永遠是最後裁判**；這一輪四次都由複審或實作者抓到。
