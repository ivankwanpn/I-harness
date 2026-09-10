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

## 5. 已修（同日，使用者裁定後）

按 §5 原本建議的最小那一半落地：

| 改動 | 位置 |
|---|---|
| `WebServerOptions.sandbox?: SandboxMode`（明確覆寫） | `apps/cli/src/web.ts` |
| 未給時讀 `settings.sandboxMode`，**進入服務前先 `await settings.load()`** | 同上 |
| 傳給 `createSessionService({ sandbox })` → `SessionServiceOptions extends AssemblyOptions` 既有欄位直接流到 assembly | 同上（欄位本來就有，只是沒人傳） |

**回歸測試**（`apps/cli/test/web.test.ts`）：`settings.sandboxMode = "workspace-write"` 時，經由 mux 送出的外殼指令**寫不到** workspace 外；並且斷言工具**真的跑了且被拒**（`exitCode != 0` 且 stderr 帶 denied/unauthorized），所以是「受限」而不是「回合因別的原因失敗」。

**判別性證明（突變測試）**：把 `sandbox:` 這一行整個拿掉 → 紅在

```
AssertionError: a shell command escaped the workspace: expected true to be false
```

也就是**真的逃逸了**。加回去 → 綠。

### 5b. 過程中踩到的兩個坑（都值得記住）

**(1) `SettingsStore.get()` 在 `load()` 之前回的是「預設值」，不是檔案的值。** 實測：

```
new SettingsStore({configDir}).get().sandboxMode          → "workspace-write"   ← 預設
(await load()) 之後 .get().sandboxMode                    → "read-only"         ← 檔案
```

**後果有兩層**：對產品而言，任何嵌入者若交進一個沒 load 的 store，`??` 會**靜默忽略操作者的設定**——所以這一版在解析前主動 `await settings.load()`（load 是冪等的）。對測試而言更陰險：我的第一版回歸測試交的正是**沒 load 的 store**，於是它靠**預設值**通過，**根本沒碰到那個設定**，突變體因此存活。**測試綠了但不是因為它想驗的東西成立**——這是我這輪第二次遇到「測試通過的理由是錯的」（第一次是 outside 路徑落在 Windows 本來就拒絕的 temp 根）。

**(2) `outside` 的路徑必須由測試自己擁有。** 第一版把待寫檔指向 `$env:TEMP` 根目錄，那個位置**純 Windows 就會拒絕寫入**（實測：不經 I-harness 的 `powershell.exe` 對 sibling 目錄可寫、對 temp 根不可寫）。於是「沒逃逸」是作業系統的功勞，不是沙箱的。改成 `mkdtempSync` 之下、與 workspace 同層的 `outside/` 目錄之後才具判別性。

## 6. 仍未做（刻意）

- **`--sandbox` 命令列旗標**：`run` 仍只能由程式化呼叫端給 `opts.sandbox`。
- **TUI**：沒動（凍結區）。TUI 有自己的沙箱路徑。
- **預設值語意**：`SETTINGS_DEFAULTS.sandboxMode` 是 `"workspace-write"`，所以 web 從「實質無沙箱」變成「預設受限」是**行為變更**（這是修復的本體）。既有測試全綠，因為它們的暫存 workspace 本來就在可寫根內。

## 7. 這次裁定留下的優先序（給下一個人）

1. **`settings.sandboxMode` 現在對 web 是活的**；`run` 那條路仍以 `opts.sandbox`（程式化）為準，未與設定串接。要不要讓它也讀設定、要不要有 `--sandbox` 旗標，仍未定。
2. **TUI 不在這條鏈上**（凍結區）。它有自己的沙箱路徑；`/sandbox` 這個 web 指令與 TUI 的設定現在寫的是**同一個** `settings.sandboxMode`，而 TUI 是否消費它**未查**。

