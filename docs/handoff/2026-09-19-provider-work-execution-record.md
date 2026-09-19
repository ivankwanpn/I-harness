# 執行記錄 — provider 生命週期 · 協議選擇 · 代理角色

**日期：** 2026-09-19 · **分支：** `d4-endpoint-cache`（分叉自 `m65` = `5f317641`）
**性質：** 這份是**給複核者的記錄**。每個決定都可以檢查；**錯了的代價寫在旁邊**。
**為什麼有這份：** SDD 的 ledger 是 gitignored 的暫存（已刪除）。**決定若只留在對話裡，複核者看不到。**

---

## 1. 這條分支載著什麼

| 單元 | 狀態 | 它的文件 |
|---|---|---|
| **provider 生命週期** | **已實作** | `docs/superpowers/specs/2026-09-19-provider-lifecycle-design.md` + `plans/2026-09-19-provider-lifecycle.md` |
| **協議與模型的選擇** | **spec 完成，未實作** | `specs/2026-09-19-protocol-selection-design.md` |
| **代理角色** | **已實作** | `specs/2026-09-19-agent-roles-design.md` + `plans/2026-09-19-agent-roles.md` |
| （更早）model catalog D1–D3 | 已實作 | `specs/2026-09-19-provider-model-catalog-design.md` |

**分支名是上一個單元留下的**（D4 的 prompt-cache 量測）—— 它已經不足以描述內容，但**不改名**，因為工作電腦認得這個名字。

---

## 2. 怎麼驗

```bash
pnpm -r --no-bail test                        # 66 Done / 0 Failed（複核時實測）
pnpm typecheck                                # 0 error lines
node scripts/audit/check-reachability.mjs --gate   # gate PASS -- no new rows
```

**這條分支的硬約束**（全程遵守，違反就是缺陷）：

- **一個新 export 必須與它的消費者同一個任務落地。** 儀器把 `export interface` / `export type` 也算成 row。**這條抓到了兩次**：`8ec8fda0`（catalog 的讀者）與代理角色計劃的 Task 1（兩個型別被宣告成 export，而消費者在三題之後）。
- **提交不得有 `Co-Authored-By` trailer。**
- **不靜默降級**：宣告了模型卻拿不到，就**大聲失敗**，不偷偷用別的。

---

## 3. 我做的決定（rulings）與錯了的代價

### 3.1 provider 生命週期

| # | 決定 | 錯了的代價 |
|---|---|---|
| R1 | 用既有的 `d4-endpoint-cache`，不開 worktree | 混進無關提交 |
| R2 | Task 2 先於 Task 5（`setModel` 可寫一個 `SettingsModel` 尚未宣告的鍵） | T2 冒出型別錯誤 |
| R3 | `models set` 只收一個 id | 同組數字要多打幾次 |
| R4 | **runtime 錯誤訊息不得指名兄弟方法** | 函式庫呼叫者少一個提示 |
| R5 | `--protocol` 加進 `models add/set` | 無 |
| R6 | `ModelFields` / `ProviderPatch` **不 export** | 呼叫者無法命名那個形狀 |
| R7 | **空的探測結果是合法的**，不拋錯 | 回傳零模型的閘道會安靜保留舊清單（＝計畫之前的行為） |
| R8 | 刪掉 `stripBaseURLSuffix`（私有、且 store 本來就 strip） | 傳進 store 的物件暫時留著 `/v1`，讀回前被 strip |
| R9 | legacy `tui.providers` 的不對稱**記錄不修** | 一條 legacy-only 路由要先 `provider add` 才能 patch |
| R10 | `patchProvider` 的白名單**當場修** | 一輪修正花在一個 Minor 上 |
| R11 | `provider key` 那一叢**當場修**（短金鑰會被自己的遮罩印出來） | 同上 |
| R12 | `128k` = 二進位 131072（照測試與走查，不照計畫的實作） | `128k` 不是 128,000；CLI 會印出實際寫入的數 |
| R13 | `--reasoning-effort` **實作**，不從 usage 拿掉 | 六行介面 vs 一行會說謊的用法說明 |
| R14 | Task 7 的三個 Important **全部進修正迴圈** | 給一個已審兩次的方法加參數 |
| R15 | 最終審查範圍 = `5860adfb`，不是 merge-base main | 計畫之前的工作不在那裡複查 |
| R16 | 殘留 Minor **parked**：`add <既有列> --max-tokens V` 的警告可能講到沒被寫入的值 | 一個窄情況下的誤導警告；無資料損害 |

### 3.2 代理角色

| # | 決定 | 錯了的代價 |
|---|---|---|
| R1 | 同上（分支、不開 worktree） | 同 R1 |
| **R1′** | **用 `plugins.subagentModel` 當開關**（預設 false），而不是刪掉一個已宣告的設定或讓功能永遠開著 | 功能是 opt-in；宣告了角色模型卻沒開開關 → spawn 失敗並說出兩個修法 |
| **R2′** | **開關關著 + 角色宣告了模型 ⇒ spawn 失敗**，絕不靜默回退 | 一個原本「會動」（其實跑錯模型）的 spawn 現在會停 —— 而那正是重點 |
| **R3** | Task 6 **在 spawn 時記下**解析出來的模型（`AgentEntry.modelLabel`），而不是在讀取時重新推導 | 一個舊快照沒有 label 時會印「inherited」，即使它其實不是 |
| **R4** | `SettingsRoleModel`/`SettingsAgents` **保持 module-private**（我的計畫把它們 export 了，而消費者在三題之後） | 未來若真的需要「指名」它，那時再 export —— 那時它就有消費者了 |
| — | Task 3：解析出來的 client **必須被斷言**，不是只斷言「resolver 被呼叫了」 | 一輪修正花在已過閘的任務上 |
| — | Task 3：**刪掉 `SubagentRole.model.extra`**（它唯一的消費者正是被移除的那段） | 無；未來有需要時連同生產者一起回來 |
| — | Task 5：`roles list` 的標記原本說 **「nothing spawns it」** —— 對插件角色與 `reviewer` 是假的 | 那一行改成只說工具能知道的事，列本身留著 |
| — | Task 6：重建路徑（resume／followup／post-restore sweep／team deliver）也要**雙向重記** label | 一輪修正 |
| — | 最終修正波：**A** 角色的 `reasoningEffort` 現在真的交給子代理（原本被解析、驗證、丟掉）；**B** team/guardian 路徑拿到那兩個選項（原本**靜默忽略**設定宣告的角色模型，而同一條路徑的**重建**卻會套用它）；**C** 五個說得太滿的註解；**D** 拒絕訊息指向一個**真的能跑**的修法 | 再一輪的代價比一波大 |

**殘留三個 Minor（已 parked，僅註解與測試內重複，無行為影響）**：`provider/src/index.ts` 一個註解仍用 runtimeProfile 的舊參數名；`roles.ts` 說「上面的註解」而它印在下面；`child.test.ts` 重複了一個既有的 request-recording client。

---

## 4. 已知的邊界（複核時請特別看這裡）

1. **`plugins.subagentModel` 關著時**，一個手寫的 `agents.roles.reviewer` / `.teammate` 會讓**那條路徑 fail closed**（帶著拒絕訊息），而不是靜默繼承。**這是修正波 B 的預期行為** —— 它讓「宣告了卻被無視」變成「宣告了就大聲」。
2. **`plugins.subagentModel` 是每次 dispatch 讀一次**（不是每次 spawn）；`agents.roles` 是 live getter。兩者在 `apps/cli/src/provider-runtime.ts` 的 `roleModelOptionsFor` 一處說明，`assembly.ts` 的那段註解說的是閘門與 resolver 的關係。
3. **插件的 provider 邊界不動**：插件**不能**指定 provider（`plugin-registry/src/mount.ts:87-91`，刻意的）。「只指定 model」那道門**沒開**。
4. **`--max-tokens` 至今沒有消費者** —— 卡片的 `maxOutputTokens` 仍然在 `provider-runtime` 被丟掉。記錄在 provider 生命週期 spec §8。

---

## 5. 這條分支**沒有**做的（不是缺陷，是範圍）

- **協議選擇計劃**（spec 二）整份未實作：session 級的協議覆寫、rebind 機制、`run --protocol`。
- **代理角色 spec §11**：使用者自訂角色、角色的 tools/systemPrompt、in-session 角色編輯器、插件指定 model。
- **spec 二 §8 的未決項**：baseURL × 協議的相容性預檢**不做** —— 提供者才是權威。

---

## 6. 這次執行裡，工具抓到的東西（值得記的形狀）

- **「消費者被刪掉」模式在這一輪又出現三次**：`SubagentRole.model` 兩端都空（沒有生產者、消費者指向一個空 registry）、`plugins.subagentModel` 沒有讀者、`ensureResidentAgent` 重建後 label 變舊。
- **false comment 是一再出現的缺陷類**：五個註解說得比程式碼滿，而每一個都是**這次的修改讓它變假的**。修它們列進「merge 前必修」。
- **計畫說「三個套件」，實際是五個**：一個 **required** seam 迫使 pass-through 也改（`guard-approval`、`agent-team`）—— 複核者判定**必要，不是蔓延**。
