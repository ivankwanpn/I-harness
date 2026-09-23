# M74（子代理的預算要撐得住）**部分交付** — 停止點與接手

**這是一份 partial handoff**：使用者在 2026-09-23 下班前要求停止、把進度推上 GitHub。**分支 `m74` 沒有合併、沒有 PR**，而且**有一條真實的設計發現尚未處置**（§3）。接手的人請先讀 §3。

- **分支**：`m74`（`8f18763` → `1e7d58b`，**11 個 commit**）
- **spec**：`docs/superpowers/specs/2026-09-23-child-budget-compaction-design.md`（`0d3e86e`）
- **計畫**：`docs/superpowers/plans/2026-09-23-child-budget-compaction.md`（`ab29f4e` ＋ 三次修正）
- **ledger（gitignored，本機）**：`.superpowers/sdd/2026-09-23-child-budget-compaction/progress.md`——**逐任務的裁決、紅先與突變證據都在那裡**

---

## 1. 已完成並複審通過

| 任務 | 狀態 | commit |
|---|---|---|
| **T1 `forkTurns` 的重映射**（前置缺陷） | **complete（複審 clean）** | `496f425`..`92e3d72` |
| **T2 子代理的 compactor（兩個站點）** | **complete（複審 clean）** | `5e33726`..`f87b00d` |
| **T3 兩條性質** | **已實作、未複審**（見 §3） | `21aa809`..`1e7d58b` |
| **T4 缺席即缺席** | **未開工** | — |
| **T5 閘門＋報告** | **未開工** | — |

**測試現狀**：`@i-harness/subagent` **13 檔／178 passed**、typecheck 乾淨。**整棵樹的閘門（`pnpm verify:all`）本階段還沒跑過**（那是 T5）。

**T1 修掉的是一個今天就存在的缺陷**：`forkTurns` 是 12 行的 raw slice，把父的壓縮標記連同**父的 seq 號碼**交給子代理——`"all"` 時索引剛好重合，`forkTurns: N` 時那些引用指向**別的事件**（含它自己）⇒ 無聲藏掉內容。修法是把 `session-persistence` 既有的 `remapSeedEvent` 匯出、接給第二個呼叫者；兩個站點現在**獨立見證**（突變 A 只紅 spawn 側、突變 B 只紅 rebuild 側）。

**T2 給子代理自己的 compactor**（兩個建構點同形、同源、缺席即缺席）；順帶把 M73 那條 fail-closed 斷言改成**更精確**（「零個請求」→「一個請求、且可證明是摘要器的」——實作者**多加了一個斷言** `requests.length > 0`，因為少了它那次改寫會比原本**更鬆**，而它量了牙齒）。

---

## 2. 進行到一半的：T3

T3 是**純測試**任務，要釘兩條性質：
1. **子代理的摘要請求帶的是它自己的 prefix** —— **成立**（`systemPrompt` 長度 950 ＝ 子代理自己的 composed prompt；legacy 文字形式會是 `""`）。
2. **子代理的衍生 surface 上不會同時出現兩份摘要** —— **不成立，已量測**（見 §3）。

---

## 3. ⚠️ 接手的人先讀這一節：一條真實的設計發現，**尚未處置**

**量到的事實**：子代理自己壓縮之後，它的衍生 surface 是

```
user: PARENT-SUMMARY-SENTINEL… | user: CHILD-SUMMARY-SENTINEL… | assistant: child done
```

**兩份摘要**。原因：`selectShadowableRange`（`packages/compaction/src/region.ts:22` 與 `:53`）**兩條臂都跳過壓縮標記** ⇒ 子代理的新 summary 蓋不掉繼承來的那份。

**關鍵脈絡（這決定了它是不是缺陷）**：**主要 session 也一樣**。第二次壓縮之後，它自己的舊摘要同樣不會被 shadow。而本樹自己的先例研究把它記成**刻意的**答案——`docs/research/2026-09-02-compact-fourway.md` §4① 寫著「壓縮選區排除舊摘要（存在）」，緩解只在 **prompt 層**（把舊摘要以 `<previous-summary>` 注入並指示「更新它」，即 anchored 摘要）。

⇒ **M74 的 spec §1.3 要求了一件引擎刻意不做的事**，而那條要求是**控制器自己發明的**，不是本樹既有的契約。所以：

- **它不是 T2 的實作缺陷**，也不該從 `test/` 修。
- **兩個真正的修法站點**（都是產品決定，需要你或使用者點頭）：
  - **(a) 引擎**：讓「已被取代的 `compaction/summary`」變成可 shadow ⇒ **改變每一個 session 的 surface**（包含主要 session），與 M33 的既有裁定衝突。
  - **(b) seed**：在 `fork.ts` 讓父的標記**不進**子代理的種子 ⇒ 只影響子代理，但子代理就看不到「父的歷史曾被壓縮成什麼」這件事。
- **現在樹上的樣子**：那條測試以 `it.fails` 落著（`packages/subagent/test/child.test.ts:1162-1171`）——**套件因此是綠的**，而它會在修法落地的那一刻翻成紅（證明方式：實作者曾暫時讓它通過，觀察到「expected to fail but passed」）。**要把紅的見證留在樹上，就是把它從 `it.fails` 改回 `it`（一個字的差別）。**
- **我（控制器）的判斷（未經使用者確認）**：這是 **spec 的錯**，不是引擎的錯——子代理與主要 session 行為一致是**一致性**，而 §1.3 那條要求應該被改寫成「與主要 session 相同的 anchored 摘要行為」。**但這是可以推翻的**，而且如果使用者要的是真正的「只有一份摘要」，(a) 是跨全樹的決定。

---

## 4. 剩下的工作（接手的順序）

1. **T3 的任務複審**（`f87b00d..1e7d58b`）——**先做這個**，它會把 §3 的發現變成正式的 finding，並可能要求處置。
2. **T4**（缺席即缺席：沒有窗口就沒有 compactor）——純測試，一條案例，brief 已抽好。
3. **T5**（`pnpm verify:all` ＋報告）——**注意**：本階段把 `remapSeedEvent` 匯出（有消費者 ⇒ 不該新增未消費的列）；**本機跑閘門時不要同時跑其他 subagent**（這一台有三個已知的負載 flake：M12 retry 已修在 PR #7、`shell-promotion W10`、`apps/cli` 的 headless promotion）。
4. **終審（opus）→ 單一 fix wave → 限定複審 → PR**。

**所有任務的 brief 都已抽好**在 `.superpowers/sdd/2026-09-23-child-budget-compaction/task-N-brief.md`。

---

## 5. 本階段的裁決（Rulings），逐條附代價

| # | 裁決 | 錯了會怎樣 |
|---|---|---|
| M74-P1 | **把 M73 那條 fail-closed 斷言的重寫從 T4 搬進 T2**——T2 就是讓它變紅的那個改動，而一個紅的 commit 不是可交付的單位 | T2 的 diff 因此含一個刻意的契約變更（複審必須一起判，計畫已具名） |
| T1-fix1 | **補「map 的值側」的案例**——`renumbered.set(seq, seq)`（鍵對、值用父 seq）能存活整個套件，而那正是本缺陷的另一半 | 一條案例 |
| T2-fix1 | **補 rebuild 站點的見證**——突變 B 讓整個套件全綠；那是本里程碑自己的紀錄指名過的失效模式（「只出現在第一次 spawn 的預算會在每次 resume 時消失」） | 一條案例 |
| （控制器）| **計畫的 fixture 不可能成立**（標記放在切片外）⇒ 修計畫，不修測試 | 零（實作者已量到並回報） |
| （控制器）| **多留一個 ` ``` ` 讓圍籬變奇數 ⇒ `task-brief` 對 Task 2 之後的每一個任務都失敗**（症狀與病因距離很遠） | 零（已修；`grep -c '^```'` 要是偶數） |

---

## 6. 尚未處置的清單（給終審三選一）

- **§3 的兩份摘要**（最重要的一條，需要產品決定）。
- `rewind/point` 的 `anchorSeq` 在 `forkTurns` 的切片裡仍保留父座標（共用的重映射從來沒碰它；早於本階段）。
- 三條 fork fixture 都沒有引擎真的會附加的 `compaction/start`／`compaction/end`（全檔的理想化）。
- T2 的三條 cosmetic：測試註解裡留著一句寫給人的指示（明明 import 已在第 3 行）；`mainRequests` 用負向子字串 `summar` 分類；host 給 `0`／`NaN` 時 `budget` 的錯誤訊息指向孿生的鍵。
- 子代理的 telemetry 與 `modelPolicies`（與主要 session 的引擎對等，非本階段造成）。
