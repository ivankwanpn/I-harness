# M60 交接：m58 + m59 整合進 main（含兩輪獨立審查的修復）

日期：2026-09-09 · 整合分支 `m60`（自 `origin/main` @ `464c1ea` = m57 尖端）
來源分支：`origin/m58`（5 commits，R-B4 A git 唯讀對照）、`origin/m59`（11 commits，grok 對齊第一批 + dist/installer/headers 等）
**本檔案是交接入口**：`.superpowers/sdd/**` 是 gitignored、不隨分支推送，故所有裁定、審查結論與殘留都重述於此。

---

## 1. 整合結果

| commit | 內容 |
|---|---|
| `441e109`… | `origin/m58`（尖端 `441e109`）以 **fast-forward** 併入（m58 直系於 main，無 merge commit） |
| `4727ea2` | Merge `origin/m59` into m60（零衝突） |
| `a33a646` | **控制器修**：m59 讓 `busyEnter` 成為 `SettingsSnapshot` 必填卻沒更新唯一全量 literal helper → `@i-harness/tui` typecheck 在 **m59 本身就是紅的** |
| `ab9c463`…`0f888f3` | fix wave（9 commit，審查 A–I 九項） |
| 本次最後一個 commit | 控制器收尾：注入探針非陣列解析的 fail-soft + 兩處文檔滯後 |

`merge-tree` 預檢與實際合併皆**零衝突**（兩分支同源於 `464c1ea`，檔案集大面積重疊但 hunk 不衝突）。

## 2. 驗證（本機實跑）

| 命令 | 結果 |
|---|---|
| `pnpm -r typecheck` | exit 0（修 `a33a646` 前為 exit 2） |
| `pnpm --filter @i-harness/rewind test` | 7 files / 71 passed |
| `pnpm --filter @i-harness/tui test` | 70 files / 767 passed（一次全套並行時 case-027 逾時，單獨跑 4.5s 綠——見 §5） |
| `pnpm --filter @i-harness/tui typecheck` | clean |
| `provider` 85 · `provider-runtime` 20 · `llm-openai` 16 · `llm-openai-compatible` 13 · `llm-anthropic` 18 · `llm-gemini` 19 | 全綠 |
| `sdk` 53 · `cli` 101(+1 skipped) · `core-session` 91 · `runtime-context` 5 · `guard-repeat-tool` 8 · `settings` 64 · `shell` 33 · `tui-core` | 全綠 |
| `pnpm e2e` | 5 files / 12 passed |
| `node scripts/build-dist.mjs` + `verify-dist.mjs` | PASS（bundle 4941.2 KiB） |

## 3. 兩輪獨立審查

兩名審查者分別審 `origin/main..origin/m58` 與 `..origin/m59`，**逐條驗證交接的每一項聲稱**（不信任作者報告）。

| 分支 | 初審 | 修復後 scoped re-review |
|---|---|---|
| m58 | APPROVED WITH FIXES（2 Important + 8 Minor） | **CLEAN** |
| m59 | APPROVED WITH FIXES（4 Medium + 3 Low + 4 條假陳述） | **CLEAN** |

### 修掉的缺陷（全部 CONFIRMED，多數有 runtime 複現）

- **A** `overlay-seam.ts:169`：rewind confirm 相位漏算 `unseen` 行 → 動作列被裁（**兩名審查者獨立撞到**）。修：`+ capped(unseen.length)`。
- **B** `remote.ts`：`parseRewindPlan` 未映射 `unseen` → `--attach` 永遠 0 行。修：選項化、逐筆驗證的映射。
- **C** `views/prompt.ts`：貼上晶片吃掉唯一文字列 → 輸入文字不可見、游標落在資訊邊框。修：slot 隨晶片增高 + 保留一列文字。
- **D** `backend/embedded.ts`：`executeOutputText`/`toolResultIsError` 忽略 `exitCode` → 失敗且無輸出的命令顯示為成功。修：非零退出即 `status:"error"`，body 附 `exit N`，原始 envelope 仍可經 `r` 檢視。
- **E** `provider`/`provider-runtime`：配置的 `headers` 沒進**模型發現**（正是 OpenCode Zen 這類網關的動機場景）。修：`ProbeRequest.headers` + 大小寫無關碰撞丟棄。
- **F/H** `rewind`：注入式探針拋出時 `plan()` 可拋（fail-soft 破洞）；session store 未被排除 → 自家 JSONL 被列成 `unseen`。
- **G** 四個 LLM 適配器：大小寫變體的自訂 header 會被 Fetch 與適配器自帶的合併成一個值。修：統一丟棄碰撞鍵。
- **I** 兩份交接的假陳述就地更正（見 §4）。

### 交接假陳述（已更正）

- m59 交接「13 個 yaml」→ 實為 **17 個 yaml + 5 個 host**。
- m59 交接「`tui test` 70 files / 761 passed」→ 全套並行時 case-027 `spawn-running` 在 90s 逾時（單獨跑 4.5s 綠）；該數字只是單次結果。
- m59 交接「`tui typecheck` clean」→ **在 m59 上為假**（vitest 不做型別檢查，所以測試照樣綠）。
- m59 交接「各 seam 自報高度…保證每個選項都可見」→ 對 rewind confirm 為假（A 修掉）。

## 4. 裁定與取捨

1. **`a33a646` 由控制器直接修**（整合 blocker，1 行測試 helper），並在提交訊息寫明 m59 的驗證表與事實不符。
2. **fix wave 收 A–I**：A–E 是 CONFIRMED 缺陷；F/G/H 便宜且屬本輪新代碼的誠實/健壯性；I 是文檔誠實——假陳述會污染後續所有判斷。
3. **`web-host` 的 `/api/llm/probe` 仍未帶自訂 headers**——審查者裁定**範圍外**（非迴歸；該端點的 draft body 沒有 headers 欄位，屬表面重設計），等 web/desktop 面解禁時一併處理。
4. **四個適配器各帶一份 `mergeConfiguredHeaders`**（與其既有 standalone 風格一致）——若日後要收斂成 `llm-seam` 的共用導出，屬機械性跟進。

## 5. 已知殘留（刻意或延後）

- **`promptCap = floor(rows/2)`**（`views/agent.ts:215`）：`minRows` 現在精確，但授予高度仍受此上限壓制——clean+conflicts+unseen 都很大時底部仍會被裁。**M58 之前即存在**（當時 clean+conflicts 就夠觸發），非本輪引入。
- **延後的審查 Minor**：m58 #4（rename 後重建同路徑可重複列且 kind 矛盾）、#5（畸形 porcelain 流誤配對）、#6（`..foo` 被誤判越界）、#7（memoize 語義未文檔化）、#9（測試覆蓋：cap 走生產不呼叫的函數、C 條目/子模組無覆蓋）；m59 Low 6（`selection-timeline` 的 idle tick 不再真的被走到；`openBlockViewerAt` 直接命中路徑無覆蓋）。全部記在帳本，使用者不易觸發。
- **非零 shell 退出碼現在一律顯示為紅色失敗**（含 `grep`/`test`/`diff` 這類「退出碼是資料」的命令）——刻意；模型仍收到原始 envelope。
- **case-027 全套並行 flake**：`spawn-running` 在 90s 逾時、單獨跑 4.5s。倉庫既有 PTY/spawn flake 同類（`docs/CAPABILITIES.md:80`）。

## 6. 下一步

- **§4a settings 對齊（使用者已點名、尚未動）**：grok 的單一捲動面板（`/ to search` + 分節 + 右對齊值 + 底部提示列）。落點 `packages/tui/src/views/settings.ts`（701 行）+ `settings-modal.test.ts` + case-028 的 `region.startRow` 三組斷言需重釘。
- §4b 其餘 7 項外觀對齊（時間戳右對齊、`Worked for X`、頂欄 token 用量、`✦ Thought for X`、模型顯示名、底部提示精簡、Always-Approve 第三檔）。
- §4c installer 未重建（`pnpm tsx scripts/build-installer.mjs`）。
- R-B4 B 案（git checkpoint 引擎）、R-A10 記憶、macOS 沙箱、web/desktop 面——皆遠期。

## 7. 接手

```bash
git fetch origin && git checkout main && git pull   # 推送後 main = M60 尖端
```

- worktree 不推送；`.superpowers/` 帳本不隨倉庫走（本檔案即其摘要）。
- 環境：`pnpm` 不在 PATH 的機器用 `'/c/Program Files/nodejs/corepack' pnpm`；`build-dist`/`build-installer` 會內部 spawn `pnpm`。
