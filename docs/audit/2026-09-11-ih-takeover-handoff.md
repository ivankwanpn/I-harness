# 交接報告：換機接手（2026-09-11）

分支 **`m62`** · HEAD **`d9dc22d`** · 已推 `origin/m62`，工作區乾淨，與遠端 **0/0**
本文的目的只有一個：**讓另一台機器上的人能無痛接手**。功能細節見前一份 `2026-09-11-ih-m62-transport-and-dsh-plugin-handoff.md`，本文不重複。

---

## 1. 專案與位置

| 項目 | 值 |
|---|---|
| 本機工作區 | `D:\I-harness-main` |
| GitHub | `https://github.com/ivankwanpn/I-harness`（**不是 fork**，`origin` 直接指向它） |
| 目前分支 | `m62`（領先 `main` **41** 個 commit） |
| HEAD | `d9dc22d` |

**注意**：這個 repo 的 `origin` 就是 `ivankwanpn/I-harness` 本身，與 DSH 那邊（fork + 上游 `origin`）的形狀**不同**，別把兩邊的 remote 慣例搞混。

## 2. 現況快照

- 工作區**乾淨**，`m62` 與 `origin/m62` 完全同步（0 ahead / 0 behind）。
- `main` 停在 `86d6f34`，落後 `m62` 41 個 commit。**分支紀律：不要推 `main`**（見 §6）。
- 既有 branch 一覽：`m29 m30 m49 m50 m58 m59 m60 m61 m62 main`。其中 `m30`、`m50` 顯示 `behind 7`，`m60` 是 `ahead 1`。

## 3. 接手第一件事（照順序）

```powershell
cd D:\I-harness-main
git fetch --all
git switch m62
git pull
pnpm install
```

驗證基線（這三個是這條分支上已實跑過的綠燈）：

```powershell
Remove-Item env:NO_COLOR -ErrorAction SilentlyContinue   # 見 §5 第 1 點
pnpm -r typecheck          # 期望 exit 0
pnpm test:default          # 期望 exit 0 · 70/70 包（已含 --no-bail）
pnpm test:quarantine       # case-027 的獨立閘門
```

`test` 這個 script 已經是 `pnpm -r --no-bail test && pnpm test:quarantine`，所以 `pnpm test` 就涵蓋兩者。

## 4. 這條分支上完成了什麼（一句話版）

| 主題 | 狀態 |
|---|---|
| transport 診斷：連不上模型時指名是哪一層壞 | 完成（`82ed890`） |
| headless `--sandbox`：`run` 不再是唯一無沙箱的介面 | 完成（`935daab`） |
| web 路徑的沙箱接線（先前是假保證） | 完成（`891db14`） |
| guard-approval 的輸出重導向破口 | 完成（`70df427`） |
| per-session workspace 執行 | **未做**（server 仍是單一 workspace） |
| installer 重建 | **未做** —— 上述改動使用者還拿不到 |

## 5. 這台機器的環境事實（換機會不一樣，請重新確認）

1. **`NO_COLOR=1` 會被注入這個 session 的環境**。而部分測試 harness 會設 `FORCE_COLOR=1`，兩者相衝時 Node 會印警告進 PTY，導致 `pnpm -r test` 誤紅。**跑測試前先 `Remove-Item env:NO_COLOR`**（已修在 `packages/tui*/test/harness/runner.ts`，但先移掉最省事）。
2. **`pnpm -r test` 遇第一個失敗就中止** —— 要看全部 70 個包的結果必須 `--no-bail`（`test:default` 已經帶了）。
3. **兩個 repo 共用同一台機器**：`D:\I-harness-main`（本專案）與 `D:\deepseek-harness`（DSH，已 fork）。DSH 的環境變數 `DSH_HOME=C:\Users\IvanKwan\.dsh` 是 harness 自己設的。**做破壞性測試時務必把 `DSH_HOME` / `DSH_AGENTS_HOME` 指向 `$env:TEMP`**，別碰到真實的 `~/.agents/skills`。
4. **此 checkout 的 `core.symlinks=false`**（僅影響 DSH 那邊的閘門，見 DSH 的 handoff）。

## 6. 協作紀律（這條最容易被下一個人破壞）

- **絕不推 `main`。** 前一版已驗證的修訂以 tag `verified-m61-d234f21` 為錨。
- **分工是「作者／驗證者分離」**：由作者（另一個 agent／人）開發，本 session 的驗證者**只驗不寫功能碼**。若你要繼續這個分工，**不要順手改功能碼**再自稱已驗證。
- **驗證必須是實跑出來的、不是聲稱的。** 這條分支上的每個修正都有**突變證明**（把修正拿掉 → 測試要紅）。新增修正請沿用同一標準。
- **不要只驗 config，要驗行為。** §7 記錄了一個假陰性：探針沒安裝 outbound 政策時，設了壞代理照樣回報「網路正常」。

## 7. 殘留 / 待裁定（照建議順序）

1. **`case-027` 的假設尚未驗證。** 隔離閘門跑過 5180ms 綠，但先前紅過一次。讀 marker 時間軸指向一個**具體假設**：`host-027.ts:371` 的 `pollMarker("request-exit", 120_000)`，host 自己的 **120s 上限比 referee 的 150s 場景預算短**，所以 host 永遠先放棄——量到的不是真病因。**若假設成立，要修的是預算關係，不是測試內容。**
2. **installer 重建。** §4d 的 `workspaceWarning`、transport 診斷、headless `--sandbox` 都還沒進安裝版；不重建，使用者拿不到這三個 commit。
3. **`case-027` 已移出預設閘門**（`packages/tui/vitest.config.ts` 的 exclude + 獨立 `vitest.quarantine.config.ts`）。注意：`--exclude ""` **無法**解除，vitest 會把 CLI 的 exclude 疊加上去。
4. **per-session workspace 執行**未做。
5. **另一邊的 `scripts/dsh-net-probe.mjs`** 已由使用者裁定**保留**（我先前建議刪除，已被否決），並且已隨 DSH 的 marketplace commit 一起提交。若要再動它，先讀 DSH 的 handoff。

## 8. 已知的操作陷阱（都真的發生過）

- **不要用時間窗挑選行程來清理。** 曾用「最近 12 分鐘」而非指令列特徵（`--headless`）挑選，誤殺了可能有頭瀏覽器行程。改用 `CreationDate` + `CommandLine` 比對。
- **跑閘門時不要同時編輯檔案。** 曾得到 `exit 2`，原因是背景閘門正好在編輯中間狀態取樣（import 尚未落地）。乾淨重跑即 0 錯——那是**競態**，不是回歸。
- **commit message 不要用 PowerShell 的 `Set-Content -Encoding UTF8` 寫。** 它會加 BOM，subject 開頭會多一個 `\uFEFF`（本 repo 的 `d9dc22d`、`935daab`、`1705e0f`、`82ed890` 都有）。用 `git commit -m` 或 `[System.IO.File]::WriteAllBytes`。
- **中文文件用簡體。** 本 repo 的 `docs/` 與 zh README 一律簡體中文（與程式碼註解的英文並存）。

## 9. 下一步建議

1. 驗 `case-027` 的「host 120s < referee 150s」假設。
2. 重建 installer，否則這條分支的三個 commit 對使用者等於不存在。
3. 其餘見 §7。

---

## 10. 接手後完成（2026-09-13）

### 10a. 基線複驗

`HEAD eb5fcea9` · 與 `origin/m62` **0/0** · `pnpm -r typecheck` **0 錯** · `pnpm test:default` **70/70 · 324 檔 / 3,302 測 · 0 失敗** · `pnpm test:quarantine` `case-027` **4.5s 綠**。

> ⚠️ **`NO_COLOR=1` 確實被注入這個 session**（§5 第 1 點成立）。第一次沒移掉就得到 `packages/settings` 紅（層數 3≠2）與 7 個包沒跑；移掉並在**空閒機器**上重跑即全綠。**這條要照做，不是建議。**

### 10b. installer 重建（§7 第 2 項，**已完成**）

`build\I-harness-Setup-0.1.0{,-test}.exe` 重建、`verify-installer` **VERIFY PASS**（19 項，含 `dist-selfcheck` 在捆入的 node v22.23.2 下自足）。三個先前缺失的 commit 以**行為標記**確認在 bundle 內：transport 診斷（`NODE_USE_ENV_PROXY`）、`--sandbox`（usage 字串 + `sandbox: sandboxMode`）、`workspaceWarning`（`grouping only`）。

**使用者仍需自行執行 `I-harness-Setup-0.1.0.exe`**（寫 `Program Files` 需提權，此 session 無法代跑）。

### 10c. `case-027` 重新設計（§7 第 1 項，**已做**）

**§7 的假設方向對、結論錯。** 實測時序：host 在 `scene-027-ready` 後（約 t≈2s）就進入 `pollMarker("request-exit", 120_000)`，因此在 **t≈122s** 放棄並拆 backend，而 referee 的 `spawn-running` 窗口到 **t≈152s**——host 確實先放棄。**但 referee 只輪詢 marker 檔、不監看 PTY 退出**，所以它仍報正確的 150s 與完整時間軸 → **「量到的不是真病因」不成立**，那份診斷仍有效。

**真正的瓶頸是外層預算**：`case-027.yaml` 全部 timeout 加總最壞 **420s**，而 vitest 外層只有 **300s**（M61 從 120 提到 300，仍未超過）→ 內部每個 `timeoutMs` 仍是裝飾。

**但真正的修法不是調預算，是切掉一條不必要的耦合。** 任務狀態機實測：

```
tasks.submit()    → "accepted"  → 視圖 "queued"    ← 同步回傳
child 首次 claim   → "running"                       ← task-protocol.ts:233
settle            → "completed" / "error"
```

`spawn-running` 這個見證原本等 `status === "running"`，**也就是等一條巢狀 spawn + 子模型串流完成**；而場景要驗的是「dashboard 顯示一個**活著的**任務、然後能取消它」。**測試驗 UI 狀態，卻讓自己依賴子代理的起跑時序**——滿載下那條路徑被餓死，紅的是它自己的時序假設。

**改動**（`host-027.ts`，純測試）：見證改等 `alive(t) = queued | running | waiting`。這**不是放鬆**——`alive` 正是同檔下面**取消見證與計數見證本來就在用**的三態集合，`=== "running"` 才是那個不一致的例外；取消契約完全不變（仍要求任務**離開** active 集合）。順帶把三處重複判定收斂成一個 `alive()`。

**驗證**：單獨跑 **4.56 / 4.52 / 4.64s 綠**（改前 4.4–5.2s，時序未變）；**突變證明仍是判別性的**——停用見證 → 紅在 `step 3 (await-marker): marker "spawn-running" not found after 150000ms`。

**而且突變那次意外重現了真實停滯**，時間軸（本輪新加的診斷）顯示：

```
46 markers: backend-ready@+0.0s … scene-027-ready@+0.0s … input-1@+0.1s … writes@+0.1s
            live-tasks@+120.0s host-failed@+120.1s
[wait@+0.1s]
```

**前 0.1 秒全部發生，然後 120 秒什麼都沒有。** 這更正了先前對這個 marker 的直覺：**停滯不在「子代理起跑慢」，而在更早——prompt 送出後整個 agent 迴圈沒有推進**（連任務都沒被 submit）。它也揭露舊診斷的盲點：`=== "running"` 分不出「任務存在但卡在 accepted」與「任務根本不存在」；**新的 `alive` 版本可以**（箭頭後有沒有 `spawn-running`）。這是這次重新設計最實質的收穫。

### 10d. 另一個 teardown flake（順手修掉，同類）

全量閘門另一次紅在 `packages/session-executor`：

```
Error: EPERM, Permission denied: \\?\C:\…\Temp\ih-t12-wf-ncSPwx
 ❯ test/service.test.ts:898  rmSync(ws, { recursive: true, force: true })
```

**斷言全過，紅在 `finally` 的清理**——handle 在 `service.close()` 之後才釋放。`force: true` 吞 ENOENT 但**不吞 EPERM/EBUSY**（M61 已記過這個 class，而且**同一個包裡**早就有 `test/helpers.ts` 的 `rmWorkspaceSync` 有界重試 helper）。`service.test.ts` 兩處、`rewind.test.ts` 的 `afterEach` 一處都用 raw `rmSync`，三處一併改用該 helper。單獨跑 66/66 綠。

**殘留**：其他包的測試若有 raw `rmSync` 清理，仍屬同一風險類（未全面清查）。
