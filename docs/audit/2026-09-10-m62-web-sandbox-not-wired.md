# M62 附錄 2：web 路徑完全不隔離外殼——而且 `settings.sandboxMode` 從來沒有被讀過

日期：2026-09-10 · 基線：`origin/m62` · 前置：`docs/audit/2026-09-10-ih-l3-web-prompt-ui-handoff.md` §7、`docs/audit/2026-09-10-m62-shell-danger-classifier-measurement.md`

**一句話**：L3 交接 §7 把「外殼沒有 workspace 邊界」列為**尚未量測**的一格。我量了。**沙箱本身是好的**（`workspace-write` 真的擋下 workspace 外的寫入），**但 web 路徑根本沒把沙箱接上去**——所以經由網頁送出的 agent 可以在 workspace 外任意寫檔，即使你的 `settings.json` 寫著 `"sandboxMode": "workspace-write"`。而那個設定值**全倉庫只有寫入者、沒有讀取者**。

---

## 1. 先確立沙箱本身有效（對照組）

用**與 `assembly.ts` 完全相同**的組成（`createLocalSandbox` + `createSandboxPolicy`），經由真的 `registerShell` → 真的 `pwsh` 工具，嘗試寫入 workspace 外的檔案：

| 模式 | 工具回報 | 檔案真的被寫出來？ |
|---|---|---|
| `undefined`（無沙箱，M16 前的行為） | `exitCode=0` | **是**（`WRITTEN`） |
| **`workspace-write`** | **`exitCode=1`** | **否** |
| `danger-full-access` | `exitCode=0` | 是 |

→ **沙箱是有效的**，而且 `workspace-write` 正是擋住這一格的那個模式。這一點沒有問題。

## 2. 但 web 路徑沒有掛沙箱（實測）

起一個**真的** `createWebServer`，`settings.json` 設成最嚴格的 `"sandboxMode": "workspace-write"`，用 mock 模型讓 agent 跑

```
Set-Content -Path '<root>\outside.txt' -Value ESCAPED
```

結果：

```json
{ "settingsSandboxMode": "workspace-write",
  "frames": ["started", "ok"],
  "outsideWritten": true,
  "content": "ESCAPED" }
```

**→ 逃逸成功。** 設定寫著最嚴格，網頁路徑照樣讓它寫到 workspace 外。

## 3. 根因：整條鏈斷在「沒有人讀設定」

| 事實 | 證據 |
|---|---|
| `AssemblyOptions` **有** `sandbox?: SandboxMode`（且會真的組出沙箱） | `session-executor/src/assembly.ts:102, 284-307` |
| **`SessionServiceOptions` 完全沒有 `sandbox` 欄位**——`packages/session-executor` 底下「sandbox」一字不出現在 `service.ts` | 實查 grep |
| `apps/cli/src/web.ts` **從來沒有**傳 `sandbox` 給 `createSessionService` | 實查 grep：web.ts 只有 `/sandbox` 指令**寫**設定 |
| `settings.sandboxMode` 的讀取者：**沒有** | 全倉庫 grep `sandboxMode`：`web.ts` 只寫、`settings` 只定義 schema/default；**沒有任何一行把它讀出來餵給 assembly** |
| 唯一真的傳 `sandbox` 的地方 | `apps/cli/src/run.ts:248`，而它的來源是 `opts.sandbox`（呼叫端給的），**不是設定** |

**所以**：`/sandbox` 指令（web 的內建指令）會回你「沙箱模式已設為 X」，但**那個值沒有任何消費者**。這是**假保證**——比沒有這個指令更糟。

## 4. 這為什麼在 L3 之後特別要緊

我在 L3 那一輪證明了：**外殼工具只在指令被歸類為危險時才問批准**（L3 交接 §7），而分類器有已知的 denylist 弱點（同日的 classifier 量測）。也就是說，外殼這條路上**批准常常不發生**。那麼「不發生批准時誰在擋」就變成唯一的問題——而答案是：

- `write` **工具** → 有 `isInsideWorkspace` 把關 ✅
- 外殼（`bash`/`pwsh`） → **分類器（只有危險指令才問）＋ 沙箱（web 路徑沒接）** ❌

**兩道防線在 web 路徑上等於都沒有。**

## 5. 我沒有動手，以及為什麼

修法本身不複雜（讓 `createWebServer` 從 settings 讀 `sandboxMode` 並傳給 `createSessionService`，需要它把 `sandbox` 轉發給 assembly），但**這不是純機械修改**，有三個必須先裁定的點：

1. **來源與優先序**：`settings.sandboxMode` 成為真源之後，與 `run.ts` 既有的 `opts.sandbox`、以及 TUI 的 `guardian`/sandbox 控制面板如何排序？（TUI 目前用自己的路徑，不動它才不會踩到凍結區。）
2. **預設值**：`SETTINGS_DEFAULTS.sandboxMode` 是 `"workspace-write"`。一旦它開始生效，**所有 embedder 的預設行為會從「無沙箱」變成「受限」**——包括既有的 web 測試（`withHost` 傳自己的 `SettingsStore`，預設即 `workspace-write`，而工作目錄是 temp，寫入會被 ACL 擋），**預期會有一批測試需要明確 pin `danger-full-access`**。這是可預期的遷移成本，但要有意識地做。
3. **範圍**：要不要同時讓 `--sandbox` 這種命令列旗標存在（目前 `run` 只能由程式化呼叫端給 `opts.sandbox`，沒有 CLI 旗標）。

**我的建議**（等你一句話就能做）：先做最小且安全的那一半——
- `WebServerOptions.sandbox?: SandboxMode`（明確覆寫，給測試與 embedder）；
- 未給時**從 settings 讀**（讓 `/sandbox` 變成真的有效，也讓使用者的 `"workspace-write"` 生效）；
- `createSessionService` 轉發 `sandbox` 給 assembly（`SessionServiceOptions extends AssemblyOptions`，加一個欄位即可）；
- 既有的 web 測試明確 pin `sandbox: "danger-full-access"`，讓「不受限」變成**測試裡寫明的**而不是巧合；
- 加一條 regression：**settings 說 `workspace-write` 時，經由 web 送出的外殼指令寫不到 workspace 外**——也就是這份量測的 green 版。

**沒有做的**：我沒有擅自改，因為第 2 點的預設值變更會改變所有 embedder 的行為，那是你的產品決定。我也**沒有**把 `sandboxMode` 接進 TUI（凍結區）。
