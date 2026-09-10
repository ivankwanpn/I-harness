# M62 附錄 3：`case-027` 的 spawn-running flake——這一輪**沒有**修好，但讓它下次會說話

日期：2026-09-10 · 基線：`origin/m62` · 前置：L3 交接 §4b/§5、接手核查 §1c-2、M61 交接 §5d/§7c

**任務**：把 `case-027` 在滿載下 `step 3 (await-marker): marker "spawn-running" not found after 150000ms` 這條 flake 查清楚。

**結果**：**沒能複現，因此沒有動手「修」它。** 取而代之的是把那個 150 秒的盲等待變成**會自己說出病因**的失敗。下面是我試過什麼、量到什麼、以及為什麼我拒絕在沒有複現的情況下改動它。

---

## 1. 它是什麼（讀碼 + 實跑）

`host-027` 讓 mock 模型的 parent 回合發出 `spawn_agent`（`task_name: "helper"`），child 模型則**卡在 `childGate`** 上，所以子代理會**一直停在 `running`**，直到場景後面把 gate 放開：

```ts
if (isChild) { await childGate; yield text "child ok"; ... }   // 子代理 RUNNING
if (!spawned) { spawned = true; yield tool_call spawn_agent }  // parent 第一回合
await parentGate; ...                                          // parent 第二回合
```

host 每 100ms 輪詢 `service.tasks(sessionId)`，看到 `t.id === "root/helper" && status === "running"` 就寫 `spawn-running` 標記檔（`host-027.ts:311-313`）。場景第 30 行等這個標記，預算 150 秒。

**所以那個 marker 觀察的是「子代理真的進入 running」**，不是真的 spawn 一個 process（M61 交接 §5d 已更正過這個直覺）。

## 2. 我量到什麼

| 情境 | case-027 耗時 |
|---|---|
| 完全單獨跑 | **4.4s**（多次一致；隔離閘門 5 次中 4 次綠的紀錄與此吻合） |
| 與**全套 `pnpm test`（70 專案）並行** | **8.2s** — 慢了一倍，但**仍然遠低於 150 秒** |

**→ 一次全套的負載只讓它慢 2 倍，不會让它停在 150 秒。** 所以這不是「慢」，是**某種停滯**（真正的 race／deadlock／單一資源飢餓），而我在這一輪**無法穩定複現**。

我也試過用 24 個 background CPU burner 製造負載，**沒成功**（那些 detached process 沒活下來，load 只在 23–26%）。

## 3. 一個意外收穫：**並行跑 vitest 會互相污染判定**

在做上面的對照實驗時，我讓 `pnpm test` 在背景跑、同時單獨跑 `case-027`。結果：

```
packages/tui test:  Test Files  70 passed (70)
packages/tui test:       Tests  772 passed (772)
...
× "pnpm recursive run" failed in D:\I-harness-main\packages\tui
```

**那個 package 自己回報全綠，pnpm 卻判定它失敗。** 這強烈指向：兩個 vitest 實例在**PTY 子程序／temp 目錄／原生模組**上互相干擾，導致**退出碼與測試結果不一致**。

這同時解釋了本輪兩次「閘門紅燈但單獨重跑就綠」的現象（gate-5 的 `apps/cli` 子程序 `0xC0000409`、gate-7 的 `case-027`）——**我的驗證流程本身是那些紅燈的成因之一**。

**教訓（給自己與下一個人）**：**跑閘門時不要同時跑任何其他測試或重量級指令。** 這條以前只是「建議」，現在有實測數據支撐。

## 4. 我做了什麼（唯一的改動）

`packages/tui/test/harness/runner.ts` 的 `awaitMarker`：逾時錯誤**附上整個 marker 目錄的時間軸**。

```
marker "spawn-running" not found in <dir> after 400ms
  3 markers: scene-ready@+0.0s service-ready@+0.1s [wait@+0.2s] input-1@+0.2s
```

時間軸以**第一個標記**為錨點，並用 `[wait@+Xs]` 標出「這次等待是從哪裡開始的」。這個箭頭是關鍵：它讓兩種失敗形狀**一眼可分**——

- 箭頭**之後**還有標記 → 場景在等待期間**還活著、還在推進**（只是沒推到目標狀態）
- 標記在箭頭**之前就停了** → 場景（或 host）**在這次等待開始前就停了**

而原本的訊息 `marker "spawn-running" not found after 150000ms` 對兩者**完全無法區分**——這正是 M61 說的「只把預算往上調不會有幫助」的深層原因：**它根本沒告訴你任何事**。

改動**只影響失敗路徑**（成功時一行都不多跑），且已驗證：單獨跑 `case-027`（4.49s 綠）與另一個用到 `awaitMarker` 的 `case-010`（5.68s 綠）都照常。

## 5. 為什麼我沒有「順手把它修好」

1. **沒有複現就沒有根因。** 我試過單獨、並行、CPU burner 三種，只量到 2 倍慢化，沒有一次停滯。憑一次猜測改動一條 **300 秒預算、承載 74 個標記與真實 PTY** 的場景，風險是把它從「偶爾紅」變成「偶爾紅但更難懂」。
2. **它的唯一正當解法是「量測證明預算真的夠」或「接受它是獨立閘門」**（M61 §5d 已立下這條規矩），而不是再調數字。我沒有量測支撐任何新數字。
3. **我這一輪的實驗反而證明了一件更重要的事**（§3）：**閘門紅燈有一部分是我自己的並行驗證造成的**。在把驗證流程弄乾淨之前，任何關於「這條測試有多不穩」的結論都還掺著雜訊。

## 6. 下一步（有清楚的判準）

下次它再紅時：

1. **先讀新的錯誤訊息**。箭頭前後的分佈直接指向兩條完全不同的路：
   - 標記停在箭頭前 → 查**輸入路徑**（keystroke 有沒有到 app）與 host 早期階段（`scene-027-ready` / `service-ready` / `backend-ready` 有沒有寫）。
   - 標記在箭頭後仍推進 → 查**子代理啟動鏈**（`spawn_agent` → `tasks()` 狀態機 → watcher 輪詢），以及 watcher 的 100ms 輪詢是否被餓死。
2. 只有在那之後才決定：調預算（要有量測）、修真正的停滯、或正式承認它是獨立閘門。
3. **跑閘門時保持機器乾淨**（§3）。

## 7. 收尾驗證（乾淨序跑）

在**什麼都沒並行**的情況下跑完整閘門：

```
pnpm test   →   exit 0
  70/70 專案 · 323 測試檔 · 3,288 測試 · 0 失敗
  第二段隔離閘門：case-027 ✓ 4,585ms（同一次執行裡就是綠的）
pnpm -r typecheck  →  exit 0
```

**對照 §3 的結論**：這一輪閘門紅過三次（gate-5 的 `apps/cli` 子程序崩潰、gate-6 與 gate-7 的 `case-027`），而**每一次旁邊都有我自己的另一個重量級指令在跑**。乾淨序跑則一次全綠、`case-027` 也綠。所以「閘門不穩」這個判斷，在把驗證流程弄乾淨之前，**掺著我自己的雜訊**——這點已寫進 §3 的教訓。
