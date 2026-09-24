# M80 — 文件債 ＋ 後端收線稽核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收線——把**活文件**上量到為假的宣稱修成真、四處矛盾以最新量測解掉、**~200 條具名殘餘**沿鏈關閉或逐條歸類、順手把 **§2.5 的靜默空成功**關掉（A0：5 src ＋ 2 測試檔），最後用讀數回答「後端打磨完成了沒有、可不可以進前端」。

**Architecture:** **Task 1 是唯一的 code 任務**（§2.5 A0，照 M77 的形狀），**先做**——它會把 telemetry 的列數從 23 變 24，文件任務必須照**最終樹**寫。其餘是文件任務（各自的 allowlist）與兩份稽核量測任務（產出一份 tracked 的稽核表）。**就緒紀錄**由控制器在最後寫（`docs/handoff/2026-09-24-m80-backend-readiness.md`）。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest · Markdown（tracked 文件）

**Spec:** `docs/superpowers/specs/2026-09-24-m80-backend-readiness-design.md`（權威；§0 全部量測、§1 設計、§2 驗收）

## Global Constraints

- **`docs/` 是本單位的主體，但有嚴格 allowlist**：每個任務**只准動 brief 指名的那幾個檔**。**一律不動**：`docs/superpowers/**`（歷史 spec／plan）、`docs/audit/**`（**唯一例外：Task 5 對 `2026-09-15-reachability-baseline.md` 只加一行指針**）、`docs/research/**`、`docs/roadmap/` 的其餘檔、以及**任何沒被 brief 指名的 `docs/handoff/` 紀錄**。
- **三分處置規則**（spec §1.1）：**fix**（活文件、改成量到的真）／**date-stamp**（dated 紀錄被推翻 ⇒ 不改本文，加一行 `▶ 已收線（Mxx）` 或 dated 指針）／**leave**（純歷史）。
- **每一條修復都要附指令＋讀數**（量到的真）——不接受「看起來對」。**日期與 commit 要真的**（寫進文件前先 `git log` 查到）。
- 對 **Task 1（唯一 code 任務）**：**紅先 ＋ 變異證明**（照 M77 的樣板）；`provider/empty` 的**字面必須真的發**（只加 manifest 列 = reachability 多一列 ⇒ gate exit 1）；述詞**必須帶** `!truncated && !refused`；**既有斷言零放寬**（M77 的獨立性釘子會證明）。
- **不加 attribution trailer**（無 `Co-Authored-By`／🤖）；**不 amend**；檔案用 Write/Edit 工具寫（**blobs LF**）；**不新增 export**（Task 1 例外：telemetry 的型別成員與 manifest 列——那是 schema 的加法，`--gate` 不新列因為有人消費）。
- **不要跑 `pnpm verify:all`**（Task 8 是唯一例外）。
- **變異是預測**：實際用哪一行編輯由你量測決定並記錄；殺不死 ⇒ 那是發現，回報它。

---

### Task 1: §2.5 A0——非內容空成功變可見（`provider/empty`）

**Files:**
- Modify: `packages/core-agent/src/index.ts`（判定＋telemetry）
- Modify: `packages/core-session/src/index.ts`（`step/end` 加 `empty?: true`）
- Modify: `packages/telemetry/src/types.ts`、`packages/telemetry/src/manifest.ts`
- Modify: `apps/cli/src/run.ts`（述詞＋`[empty]` 行＋`HeadlessResult.empty`）
- Test: `packages/core-agent/test/agent.test.ts`（4 個新案例）、`apps/cli/test/metrics-summary.test.ts`（3 個新案例）
- **不動**：`llm-mock`（`{ role: "assistant" }` 已是空步）、`compaction`／`session-title`、`apps/cli/src/index.ts`（R14 不重報）

**Interfaces:**
- Consumes: M77 的形狀（`truncatedThisStep`／`refusedThisStep` 的 locals、`deps.telemetry?.emit`、`step/end` 的 spread、`run.ts` 的 `lastTurnStart` 述詞）
- Produces: 新的耐久位元 `step/end.empty?: true`、telemetry 碼 `provider/empty`、`HeadlessResult.empty?: boolean`、CLI `[empty]` 行——**與 `truncated`／`refused` 逐點對稱**

- [ ] **Step 1: 寫紅測試（七個）**

1. core-agent：一個空步（`llm-mock` 的 `{ role: "assistant" }`）⇒ 耐久 `step/end` **帶 `empty: true`**、**一則 `provider/empty`** telemetry、空 assistant 訊息照寫。今天紅（沒有位元）。
2. core-agent：乾淨步（有文字）⇒ **沒有** `empty`、沒有 telemetry。
3. core-agent：`refused` 的步 ⇒ **沒有** `empty`（不雙報）；`truncated` 的步同理。
4. core-agent：**只有 tool call、沒有文字**的步 ⇒ **不是** empty（新對照——(a) 的述詞比 M77 的寬，這條是它的牙）。
5. CLI：一個空步的 headless run ⇒ stderr 一行 `[empty] …` ＋ `result.empty === true`。
6. CLI：乾淨 run ⇒ 兩者皆無（**既有案例可能已覆蓋 ⇒ 量了再寫**）。
7. CLI：真 CLI 的 SSE fixture（照 `:245-249` 的寫法：compatible wire 送一幀無內容＋`finish_reason:"stop"`）⇒ `[empty]` **恰一次**。

- [ ] **Step 2: 跑，看到紅**（逐條記錄紅在哪裡）

Run: `pnpm --filter @i-harness/core-agent test`、`pnpm --filter @i-harness/cli test`（或該檔的 focused 跑法——量了再寫）。

- [ ] **Step 3: 實作（5 個 src 檔，照 spec §0.5 的逐一清單）**

`core-agent:502` 之前加 `const emptyThisStep = stepText === "" && toolCallsThisStep === 0 && !truncatedThisStep && !refusedThisStep`；emit `provider/empty`（照 `:450` 的形狀）；`step/end` spread 加 `...(emptyThisStep ? { empty: true } : {})`。`core-session:25` 加 `empty?: true`。`telemetry/types.ts` 加 `| "provider/empty"`、`manifest.ts` 加一列（`domain: "provider"`、描述照 `:40` 的 count-denominator 寫法）。`run.ts` 加述詞（照 `:835`）、`[empty]` 行（照 `:903`）、`HeadlessResult.empty`、return 的 spread（照 `:906`）。

- [ ] **Step 4: 跑，看到綠＋既有全綠**

Run: 兩個套件的 test 與 typecheck、`node scripts/audit/check-reachability.mjs --gate`（**不新列**——字面真的發）。

- [ ] **Step 5: 變異證明（至少兩條）**

(a) 把 `core-agent` 的 emit 拿掉 ⇒ 測試 1 紅＋**`--gate` 多一列**（證明「不發字面就多列」的硬邊）——量到哪個就記哪個；(b) 把述詞的 `!refusedThisStep` 拿掉 ⇒ 測試 3 紅。Edit 還原、`sha256sum` 相符。

- [ ] **Step 6: Commit**

```bash
git add packages/core-agent/src/index.ts packages/core-session/src/index.ts packages/telemetry/src/types.ts packages/telemetry/src/manifest.ts apps/cli/src/run.ts packages/core-agent/test/agent.test.ts apps/cli/test/metrics-summary.test.ts
git commit -m "feat(core-agent,core-session,telemetry,cli): a non-content empty success stops being silent — provider/empty, step/end.empty, [empty] (M80)"
```

---

### Task 2: `queued-work.md` §9.2 重寫 ＋ §6 的重量

**Files:**
- Modify: `docs/handoff/2026-09-20-queued-work.md`（**只准動 §9.2 與 §6 的「本地結構化診斷日誌」列**）

**Interfaces:**
- Consumes: spec §0.2A 的實測（B4／C3 已完成、三堆標題過期、banner 引用漂到 `:310`、`:535` 的 107/94/13 已不可重現）
- Produces: §9.2 的終態（**指向 `docs/handoff/2026-09-23-backend-closure-plan.md` 的短節**，不再是一份落後的待辦）

- [ ] **Step 1: 重量（先量再寫）**

- `pnpm`／`grep` 重跑 §6 那條普查指令（`grep -rn -F -e "console.warn(" -e "console.error(" packages/*/src apps/*/src --include=*.ts | grep -v "\.test\.\|/test/"`）⇒ 今天幾行、逐檔分佈、扣掉哪些註解；**新的「分級／例外」切分若量得出來就寫，量不出來就明說 `UNMEASURED`**（spec §0.2A 已量到「25 行、兩條新站（`run.ts:895`／`:903`）是 M72／M77 的、例外的行號漂了」）。
- `grep -n "maxOutputTokens" packages/llm-seam/src/index.ts` ⇒ banner 的引用改成量到的行（`:310`）。
- `grep -n "stream_options" packages/llm-openai-compatible/src/index.ts` ⇒ B4 的引用位置。

- [ ] **Step 2: 重寫 §9.2**

原則：**把「還沒做」變成「已收線」的短節**——三個堆標題改成事實（A 堆全 ✅、B 堆全裁定、C 堆全 ✅）、B4／C3 兩列改成量到的完成句（附 commit／檔案）、保留「本節是當時的量測」的 banner（`已落後` → 指向收線計畫與**本紀錄**）。**保留歷史噪音**（各格的原句）還是**收成短節**：**收成短節**（`§9.2` 的用途是待辦；已收線後留著整面歷史反而騙人）——原句已在 git 歷史裡。

- [ ] **Step 3: 改 §6 那一列的讀數**

把「現量：107 ＝ 94 ＋ 13」換成今天量到的讀數（或 `UNMEASURED`＋原因）；指令與輸出貼進報告。

- [ ] **Step 4: 驗收（量）**

```bash
grep -n "107 ＝ 94\|107 = 94" docs/handoff/2026-09-20-queued-work.md   # 0 命中
grep -n "maxOutputTokens" docs/handoff/2026-09-20-queued-work.md        # 若引用，行號 = 量到的
```

- [ ] **Step 5: Commit**

```bash
git add docs/handoff/2026-09-20-queued-work.md
git commit -m "docs(queued-work): §9.2 stops being a five-milestone-old todo list — the two live items closed in M72/M73 and the census row carries today's reading (M80)"
```

---

### Task 3: `CAPABILITIES-DETAIL.md` 的宣稱 ＋ `CAPABILITIES.md` ＋ `contracts.md`

**Files:**
- Modify: `docs/CAPABILITIES-DETAIL.md`（**只准動**：`:3`、`:21`、`:22`、`:24`、`:25`、`:31`、`:83`、`:118`、`:215`、`:255`、`:293`、`:295`、`:508`、`:535`、`:617`、`:623`、`:624`、`:635`、`:636`、`:659`、`:674`，以及 §12 的四條**帶宣稱**項（items **6／12／13／30**））
- Modify: `docs/CAPABILITIES.md`（**只准動**：`:3`、`:80`）
- Modify: `docs/contracts.md`（**只准動**：`:20`、`:73`、`:119`、`:161`、`:194`、`:200`）

**Interfaces:**
- Consumes: **Task 1 的最終樹**（telemetry 列數 **24**——四處 `:22`／`:293`／`:295`／`:674` 要 23 → 24、列舉補 `provider/empty`）；spec §0.2C/D/E 的實測
- Produces: 這三份活文件裡**沒有已量到為假的宣稱**（brief 指名的行）

- [ ] **Step 1: 逐條重量（先量再寫）**

對 spec §0.2C/D/E 的每一條跑一次量測（`grep`／`sed`／`awk`；兩個代理對 SessionEvent 34→36/37、sdk 方法 6/19 的讀數不一致 ⇒ **以你量的為準**、把指令貼進報告）。「未掛載」家族：`grep -n "createTodoTool\|createReadImageTool" packages/session-executor/src/assembly.ts`。

- [ ] **Step 2: 改**

逐條 fix：`todo_write`／`read_image` **已掛載**（附 `assembly.ts` 行號）；SessionEvent 改成量到的數＋列三個缺的成員（`tool/dispatch`／`rewind/point`／`operator/run-end`）；HTTP 路由列改成事實（web-host 已刪——**照 §4.1／§11 既有 banner 的寫法**）；`65 包 → 66`（兩份文件都改）；sdk 方法改成 switch 量到的清單；telemetry 四處 23 → **24**＋列舉補 `provider/empty`；`:535` live discovery 改成存活面（`probeModels`／`discoverModels`＋CLI `models probe|refresh`）；`:659`、`:31`／`:508`、`:3`／`:80`、`contracts.md` 五處照 spec §1.2。

- [ ] **Step 3: 驗收（量）**

```bash
grep -n "均未被掛載\|無掛載點\|read-image.*不存在\|read_image.*不存在" docs/CAPABILITIES-DETAIL.md   # 0 命中
grep -n "34 種\|~53（24 靜態）\|65 包" docs/CAPABILITIES-DETAIL.md docs/CAPABILITIES.md               # 0 命中
grep -n "probe-apply\|fingerprint" docs/CAPABILITIES.md docs/CAPABILITIES-DETAIL.md                   # 只在歷史註記（若有）出現
grep -cn "web-host" docs/contracts.md                                                                  # 0（或僅 dated 註記）
```

- [ ] **Step 4: Commit**

```bash
git add docs/CAPABILITIES-DETAIL.md docs/CAPABILITIES.md docs/contracts.md
git commit -m "docs(capabilities): the false claims go — todo_write/read_image ARE mounted, the counts are today's, and web-host's remnants stop pointing at deleted code (M80)"
```

---

### Task 4: `CAPABILITIES-DETAIL.md` 的**引用**（同檔、接在 Task 3 之後）

**Files:**
- Modify: `docs/CAPABILITIES-DETAIL.md`（**只准動引用**：§1.2 整張表的行號、§2 的 `path:line`（`:206`／`:289`／`:305`／`:332`／`:483`／`:486`）、§12 items **20-24**（純引用））

- [ ] **Step 1: 逐條重量（先量再改）**

每一條舊引用：先在當前樹 `grep -n` 找**該符號**，記下量到的行號；**找不到符號的**（如 `sessionContextWindow`、`command/run|done` 的生產者）⇒ 改成符號名或刪除引用＋改寫成事實（spec §0.2C 已把兩者的實況量好）。

- [ ] **Step 2: 改**（引符號名優先於行號——本樹的規矩）

- [ ] **Step 3: 驗收（量）**

抽 5 條新引用逐條 `sed -n '<line>p'` ⇒ 必須是該符號（貼進報告）。§1.2 的表：`createSessionAssembly` 的引用改成 `:405`。

- [ ] **Step 4: Commit**

```bash
git add docs/CAPABILITIES-DETAIL.md
git commit -m "docs(capabilities): the citations point at the symbols again — assembly grew 1200 lines since the stage table was written (M80)"
```

---

### Task 5: 其餘活文件與 dated 指針

**Files:**
- Modify: `docs/handoff/2026-09-20-queued-work.md`（**追加 allowlist（執行期更正——Task 2 的量測抓到它們在同檔的舊 allowlist 之外）**：`:64` 的 §1 W6 列、`:917` 的 §9.1 M3 列〔同一個「107 ＝ 94」過期讀數〕、以及 §1 那句因 §9.2 的 A2 被刪而變假的話〔「本列與 §9.2 的 A2 是舊檔名唯二的 tracked 引用」〕）
- Modify: `docs/handoff/2026-09-18-backend-backlog.md`（**只准動** spec §0.2B 的 11 行）
- Modify: `docs/roadmap/2026-08-31-roadmap-E-platform.md`（**只准動** `:26`／`:57`／`:85`）
- Modify: `docs/roadmap/2026-08-31-m27-backlog.md`（**只准動** `:30`／`:73`／`:75`）
- Modify: `docs/handoff/2026-09-23-backend-closure-plan.md`（**只准動** `:11`／`:20`／`:29`／`:30`／`:48`）
- Modify: `docs/handoff/2026-09-22-w6-diagnostics.md`（**只加** `:167` 後一行 dated 指針）
- Modify: `docs/handoff/2026-09-24-m77-refusal-channel.md`（**只加** `:94` 後一行 dated 指針）
- Modify: `docs/handoff/2026-09-24-m79-coverage-completion.md`（**只加**標頭一行 dated 指針：已合併 PR #15 → `bc45dce`）
- Modify: `docs/handoff/HANDOFF.md`（**只加** `:16` 後一行 dated 指針）
- Modify: `docs/audit/2026-09-15-reachability-baseline.md`（**只加** `:858` 後一行指針 → §9.4）——**這是唯一准動的 audit 檔，且只加一行**

**Interfaces:**
- Consumes: spec §0.2B／F／G／H／I 的實測與 §1.2 的四處矛盾解法
- Produces: 其餘活文件不再有已量到為假的宣稱；所有 dated 紀錄都有一行指向收線紀錄的指針

- [ ] **Step 1: 逐條重量**（backend-backlog 11 行逐行；roadmap／m27 的列；計畫自身的 `:29`〔M77 缺 PR #13 → `bb266229`〕、`:30`〔M78「兩件」→ 五條〕、`:11` 行範圍、`:20` 路由句、`:48` 第 3 條）

- [ ] **Step 2: 改**：fix 的照 spec；date-stamp 的一律寫成 `▶ 已收線（Mxx）：<一句事實>（<commit>）` 的既有慣例。**`m27-backlog` 與 `roadmap-E` 的修法照 spec §1.2 的四處矛盾解法**（H-3 → M28 的自建 AS；R-E11 → M30 的用戶拍板；live discovery → 已落地）。

- [ ] **Step 3: 驗收（量）**

```bash
grep -n "只差 Q8" docs/handoff/2026-09-18-backend-backlog.md          # 0 命中
grep -n "遠期" docs/roadmap/2026-08-31-roadmap-E-platform.md | grep -n "live discovery"   # 0（或只剩 variants）
grep -n "後補" docs/roadmap/2026-08-31-m27-backlog.md | grep -n "H-3"                     # 0
grep -c "m80-backend-readiness" docs/handoff/HANDOFF.md docs/handoff/2026-09-24-m79-coverage-completion.md docs/handoff/2026-09-22-w6-diagnostics.md docs/handoff/2026-09-24-m77-refusal-channel.md docs/audit/2026-09-15-reachability-baseline.md
```

（每檔 ≥1；指針一律指向 `docs/handoff/2026-09-24-m80-backend-readiness.md`。）

- [ ] **Step 4: Commit**

```bash
git add docs/handoff/2026-09-18-backend-backlog.md docs/roadmap/2026-08-31-roadmap-E-platform.md docs/roadmap/2026-08-31-m27-backlog.md docs/handoff/2026-09-23-backend-closure-plan.md docs/handoff/2026-09-22-w6-diagnostics.md docs/handoff/2026-09-24-m77-refusal-channel.md docs/handoff/2026-09-24-m79-coverage-completion.md docs/handoff/HANDOFF.md docs/audit/2026-09-15-reachability-baseline.md
git commit -m "docs(handoff,roadmap): the living docs stop contradicting the tree, and the dated records get their pointers (M80)"
```

---

### Task 6: 稽核表 Part 1——Tier-1 鏈關閉 ＋ 舊半 Tier-2

**Files:**
- Create: `docs/handoff/2026-09-24-m80-residual-audit.md`（Part 1）

**Interfaces:**
- Consumes: spec §0.4 的兩份清單（舊半 ~115 條）＋ §1.3 的兩層方法
- Produces: 一份 **tracked** 的稽核表（Part 1）：Tier-1 的鏈關閉表（來源 → 關閉者＋commit）＋舊半的 Tier-2 四鍵逐條

- [ ] **Step 1: Tier-1 表**：把舊半裡**被後續里程碑關掉**的每一條，查關閉它的紀錄／commit（`git log --grep` 可用）⇒ 一行一條：`來源:line — 一句話 — 關閉者（紀錄＋commit）`。

- [ ] **Step 2: Tier-2**：仍開的每一條在 **HEAD 量現況**（`grep`／讀碼），落四鍵（①修掉了 ②等前端〔附來源〕③產品決定〔附問題〕④明說接受的成本〔附數字〕）；量不到的標 `UNMEASURED` 並具名。**成鏈的可以合併成一列**（例：anthropic 未夾 → … → reset 的鏈若整條關了就一條）。

- [ ] **Step 3: 驗收**：每一條都有四鍵之一（或 `UNMEASURED`）；Tier-1 的 commit 抽查 5 條存在。

- [ ] **Step 4: Commit**

```bash
git add docs/handoff/2026-09-24-m80-residual-audit.md
git commit -m "docs(handoff): the residual audit, part 1 — the old half, by chain (M80)"
```

---

### Task 7: 稽核表 Part 2——新半 Tier-2

**Files:**
- Modify: `docs/handoff/2026-09-24-m80-residual-audit.md`（**追加** Part 2）

- [ ] **Step 1: 新半（M76–M79＋計畫的 §2.4/§2.45/§2.5/§4）逐條**，同 Task 6 的方法；**§2.45／§2.5 照 spec §1.4／§1.5 的裁定入表**；計畫的 §4「不是後端的事」清單**逐條驗證仍是事實**（`git ls-files`／`grep`）。

- [ ] **Step 2: 驗收**：同 Task 6；另外**§4 的每一條附一個「仍是事實」的量測**。

- [ ] **Step 3: Commit**

```bash
git add docs/handoff/2026-09-24-m80-residual-audit.md
git commit -m "docs(handoff): the residual audit, part 2 — the new half, and the not-backend list re-measured (M80)"
```

---

### Task 8: 收尾（閘門＋由控制器寫就緒紀錄）

**Files:** 無（Task 1–7 的成果）＋ `docs/handoff/2026-09-24-m80-backend-readiness.md`（**控制器寫**）

- [ ] **Step 1: `pnpm verify:all`（單獨跑、不與 subagent 並行）**

Expected: 五步全綠（母體 67）；**算術寫出來**（M79 基線 3133 ＋ Task 1 的案例數；實測為準）；reachability **不新列**（456 或 Task 1 之後的量——`provider/empty` 有真的生產者 ⇒ 不新列）。**若 suite 紅在已量測的負載 flake**：隔離跑、兩個讀數都記。

- [ ] **Step 2: 控制器寫就緒紀錄**（照 spec §1.6 的六點契約）：五讀數、Tier-1 表、Tier-2 四鍵、四份文件的指針、§2.45／§2.5 的處置、**判決**。

- [ ] **Step 3: Commit**（紀錄＋收線計畫的 M80 列 ✅ ＋ §1 的表）

---

## 驗收（照 spec §2）

1. spec §0.2 的 A–I 逐條為真（附指令）——Task 2–5。2. 四處矛盾的兩側都被處理——Task 3／5。3. §2.5 A0 紅先＋七案例＋`--gate` 不新列——Task 1。4. Tier-1 有關閉引用、Tier-2 有四鍵或 `UNMEASURED`——Task 6／7。5. `pnpm verify:all` 五步全綠、算術寫出來——Task 8。6. 四份文件都指回就緒紀錄——Task 5／8。

## 殘餘（本階段**不做**，寫出來不是忘了）

- A3（seam 層的 `empty`）與 compaction／session-title 的覆蓋。
- bedrock live probe、provider variants（R-E11 餘項）。
- 真 provider 前的所有 `UNMEASURED`（§2.45 的觸發條件）。
- 快照的**本文**一律不改（只加指針）——未加的指針（若掃到第三份路由文件）具名。
