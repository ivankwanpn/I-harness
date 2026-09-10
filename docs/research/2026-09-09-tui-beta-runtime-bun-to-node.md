# tui-beta 執行期研究：能不能不用 Bun 跑？（Bun → Node 22/24）

日期：2026-09-09 · 方式：**唯讀走查**（三棵樹與本機 Node 二進位皆未執行、未安裝、未建置、未連網）
範圍與代號：

| 代號 | 路徑 | 說明 |
|---|---|---|
| **TB** | `.worktrees/tui-beta-1/tui-beta/`（= `D:\I-harness-main\.worktrees\tui-beta-1\tui-beta`） | opencode 1.18.30 `packages/tui` 的逐檔副本（27,044 行 / 152 檔，`tui-beta/README.md:11`） |
| **OC** | `D:\agent-complete\opencode-1.18.30\` | 上游 opencode 1.18.30 原始碼樹 |
| **FORK** | `D:\opencode-fork-private-999.0.13\` | 本機已安裝的 opencode 私有 fork（含 `node_modules`，內有 **@opentui 0.4.5 實體套件**） |
| **IH** | `D:\I-harness-main\` | 本 monorepo |

`@opentui/*` 在 TB 內**沒有 node_modules**（TB 是複製檔，`tui-beta/README.md:24`），但 FORK 的 pnpm store 內有同版本 0.4.5 的實體檔案（`FORK/node_modules/.bun/@opentui+core@0.4.5+.../`、`@opentui+solid@0.4.5+.../`、`@opentui+keymap@0.4.5+.../`、`@opentui+core-win32-x64@0.4.5/`），因此本報告的 @opentui 結論是**讀實物**得出的，不是推測。

---

## 一頁結論

**1. 「不用 Bun 跑 TB」在我們的 Node 上不可行——但卡點不是 `Bun.*`。**
TB 對 Bun 自身 API 的耦合極小：**production 只有 18 個呼叫點、8 個檔案**（§2）。其中 12 個有直接 Node 對應物（`node:url` / `node:fs/promises` / `node:sqlite` / koffi / `string-width`），`with { type: "file" }` ×6 沒有等價、`bun:sqlite` 非 drop-in；測試面另有 45 檔 `bun:test`。真正的死結在渲染核心：

**2. `@opentui/core` 0.4.5 確實有 Node 建置，但它的 Node 建置需要 `node:ffi`——本機 Node 沒有這個內建模組。**
證據：`@opentui/core/package.json` 的 exports 是 `bun → index.bun.js`、`node → index.node.js`（`FORK/.../@opentui/core/package.json`，exports 區塊）；Node 建置內的 FFI 後端邏輯是
`if (isBun) return createBunBackend(require("bun:ffi")); try { return createNodeBackend(require("node:ffi")) } catch { return createUnsupportedBackend(error) }`
（`FORK/.../@opentui/core/chunk-node-q0cwyvm9.js`，`// src/platform/ffi.ts` 段落）。`createUnsupportedBackend` 的 `dlopen()` 直接拋
`"OpenTUI native FFI is not available for this runtime yet"`（同檔，`FFI_UNAVAILABLE`）。
本機 Node 是 **v24.15.0**（`C:\Program Files\nodejs\node.exe` 內版本字串），以唯讀方式掃描該二進位：**`node:ffi` 出現 0 次、`experimental-ffi` 0 次、`allow-ffi` 0 次、`getRawPointer` 0 次**；對照組 `node:sqlite` 出現 4 次、`experimental-sqlite` 4 次。→ 這顆 Node 的 `require("node:ffi")` 必然失敗，FFI 後端退化為 unsupported，`createCliRenderer()`（`TB/src/app.tsx:194`）當場失敗。**推論（高信心）**：不是「跑得慢」或「畫面壞掉」，是**起不來**。

**3. `@opentui/solid` 的 `preload` 是硬性 Bun-only。**
`bunfig.toml:1` 的 `preload = ["@opentui/solid/preload"]` 在 Node 上會載到 `scripts/preload.node.js`，其內容只有一句 `throw new Error("@opentui/solid/preload is Bun-only and is not available in Node.js...")`（`FORK/.../@opentui/solid/scripts/preload.node.js`）。這個 preload 的作用是用 `Bun.plugin` 註冊 `babel-preset-solid` 的 TSX 轉換（`FORK/.../@opentui/solid/scripts/solid-plugin.js`、`solid-transform.js`）。少了它，`tsconfig.json:5-6` 的 `"jsx": "preserve"` 在 Node/tsx 下會把 JSX 原樣留給 Node 的 ESM loader → **語法錯誤**（推論；esbuild 的 `preserve` 語意）。要救就得換成 `jsx: "react-jsx"` + `jsxImportSource: "@opentui/solid"`，走 `@opentui/solid/jsx-runtime`（`FORK/.../@opentui/solid/jsx-runtime.js`，它用 `createElement`/`createComponent`/`spread`，語意上等價於 universal 模式，**推論**）。

**4. 三個選項的誠實結論**
- **(a) 在 Node 上 shim Bun：可行但無用。** 18 個 production 呼叫點可 shim（估 150–250 行），但 shim 完**TUI 還是起不來**，因為卡點在 `node:ffi`——那是 `node:` 內建 specifier，**不能**用 npm 套件補（Node 對 `node:` 前綴不查 node_modules）。唯一的解是**改 @opentui/core 的 Node 建置**（把 `platform/ffi.ts` 的 node backend 換成 koffi），那是對 1.33 MB 打包檔 + ~347 個原生符號表的 fork，不是 shim。
- **(b) 換渲染器（保留 SolidJS 元件樹，改接 IH `packages/tui-core`）：戰略上正確，但這是重寫引擎。** TB 用到 ~10 種 intrinsic（box 331、text 337、span 98、scrollbox 9、textarea 5、diff 4、input 2、code 2、line_number 1、markdown 1；`grep -rho "<tag" TB/src --include=*.tsx`）。tui-core **沒有 layout engine**（`IH/packages/tui-core/src/` 2,755 行只到 cell grid + diff + wcwidth + input parser），Yoga 佈局在 `opentui.dll` 裡（FFI 符號 `yogaNodeCalculateLayout` 等）。**推估 8,000–15,000 行**（§4b）。
- **(c) 這個前端單獨留在 Bun：唯一今天就能動的路。** 不碰 TB 一行；代價是第二個 runtime 進 CI/打包（Windows 有 x64/arm64/baseline 三目標 + 簽章，`OC/.github/workflows/publish.yml:109-218`），且仍需自備 `@opencode-ai/*` 四個 workspace 套件（§2.4）與 `TuiInput` driver。

**5. 建議：選 (c) 做隔離 spike（Bun sidecar process ↔ IH backend）；(b) 只有在 spike 證明 UX 值得 8k–15k 行時才啟動；(a) 不要單獨做。**

---

## 2. Bun 耦合清單

### 2.1 production（`TB/src/`，共 18 個呼叫點 / 8 檔）

| # | file:line | API | 做什麼 | Node 22/24 對應 |
|---|---|---|---|---|
| 1 | `tui-beta/src/util/persistence.ts:5` | `Bun.file(p).text()` | 讀 KV/plugin 狀態檔 | `readFile(p, "utf8")`（`node:fs/promises`） |
| 2 | `tui-beta/src/util/persistence.ts:9` | `Bun.file(p).json()` | 讀 JSON 狀態 | `JSON.parse(await readFile(p, "utf8"))` |
| 3 | `tui-beta/src/util/persistence.ts:14` | `Bun.write(p, s)` | 寫檔（含建目錄） | `writeFile(p, s)` |
| 4 | `tui-beta/src/util/persistence.ts:25` | `Bun.write(tmp, json)` | 原子寫入（temp + rename） | `writeFile(tmp, json)` |
| 5 | `tui-beta/src/prompt/display.ts:7` | `Bun.stringWidth(seg)` | prompt 游標/offset 的欄寬 | **無內建**；`string-width@7.2.0`（已是 @opentui/core 的 dep）或 IH 既有 `@i-harness/tui-core` 的 `clusterWidth`（`IH/packages/tui-core/src/wcwidth/index.ts:48-61`） |
| 6 | `tui-beta/src/component/prompt/autocomplete.tsx:190` | `Bun.stringWidth(virtualText)` | extmark 範圍寬度 | 同上 |
| 7 | `tui-beta/src/component/prompt/autocomplete.tsx:461` | `Bun.stringWidth(newText)` | 設定 `cursorOffset` | 同上 |
| 8 | `tui-beta/src/component/prompt/index.tsx:512` | `Bun.stringWidth(normalized)` | 設定 `cursorOffset` | 同上 |
| 9 | `tui-beta/src/component/dialog-status.tsx:2` | `import { fileURLToPath } from "bun"` | 解析 `file://` plugin 路徑 | `import { fileURLToPath } from "node:url"`（**語意相同**） |
| 10 | `tui-beta/src/component/prompt/autocomplete.tsx:2` | `import { pathToFileURL } from "bun"` | 檔案路徑 → URL | `import { pathToFileURL } from "node:url"`（**語意相同**） |
| 11 | `tui-beta/src/terminal-win32.ts:1` | `import { dlopen, ptr } from "bun:ffi"` | 呼叫 `kernel32.dll` 的 `GetStdHandle/GetConsoleMode/SetConsoleMode/FlushConsoleInputBuffer`（`:7-13`） | **無內建**（本機 Node 無 `node:ffi`）。IH 既有做法：**koffi**（`IH/packages/sandbox-windows-acl/src/ffi.ts:12`、`IH/packages/fs-lock/src/win32.ts:24-26`） |
| 12 | `tui-beta/src/editor-zed.ts:1` | `import { Database } from "bun:sqlite"` | 讀 Zed `db.sqlite` 取選取範圍（`readonly: true`、`.query(sql).all()/.get()`、`$editorID` 具名參數，`:92,109,143-145,170-172`） | `node:sqlite` 的 `DatabaseSync`（IH 已用，`IH/packages/session-query/src/file-backed.ts:10`）。**非直接替換**：選項名 `readOnly`、`.prepare()` 而非 `.query()`、具名參數要改成 bare 名或位置參數（IH 現有程式只用 `?` 位置參數，`IH/packages/session-query/src/file-backed.ts:308-430`） |
| 13-18 | `tui-beta/src/attention.ts:17-22` | `import x from "...mp3" with { type: "file" }` ×6 | Bun 專屬 import attribute，回傳**檔案路徑字串** | **無等價**。Node 只認 `with { type: "json" }`。要改成 build-time 複製資產 + 執行期組路徑（`audio.d.ts` 的 `declare module "*.mp3"` 也一併失效） |

### 2.2 設定面（Bun-shaped）

| file:line | 內容 | 影響 |
|---|---|---|
| `tui-beta/bunfig.toml:1` | `preload = ["@opentui/solid/preload"]` | **硬性 Bun-only**（Node 分支直接 throw，見 §1.3） |
| `tui-beta/bunfig.toml:3-4` | `[test] preload = [...]` | Bun test runner 專屬 |
| `tui-beta/package.json:9` | `"test": "bun test --timeout 30000 --only-failures"` | `--only-failures` 是 Bun 專屬旗標 |
| `tui-beta/package.json:69-71` | `@tsconfig/bun`、`@types/bun`、`@typescript/native-preview` | 型別/編譯設定依賴 Bun 生態 |
| `tui-beta/tsconfig.json:3` | `"extends": "@tsconfig/bun/tsconfig.json"` | 該 base 設 `module: Preserve`、`jsx: react-jsx`、`moduleResolution: bundler`、`verbatimModuleSyntax`（`FORK/node_modules/.bun/@tsconfig+bun@1.0.9/.../tsconfig.json`）；TB 自己再覆寫 `jsx: preserve` + `jsxImportSource`（`:5-6`） |
| `tui-beta/sst-env.d.ts:7-9` | `/// <reference path="../../sst-env.d.ts" />` + `import "sst"` | 指向**不存在**的 `tui-beta-1/sst-env.d.ts`（實測 MISSING）且 `sst` 未安裝 → typecheck 直接報錯（不影響 runtime） |
| `tui-beta/package.json:12-49` | exports 全部指向 `.ts`/`.tsx` 原始檔 | Node 需 tsx/loader；且依賴 `@opencode-ai/*` workspace 套件（見 §2.4） |

### 2.3 測試面

| 項目 | 數量 | 證據 |
|---|---|---|
| `import ... from "bun:test"` 的檔案 | **45 / 51** | `grep -rl 'from "bun:test"' TB/test \| wc -l` |
| `Bun.sleep` | 6 | `TB/test/cli/tui/data.test.tsx:16`、`dialog-prompt.test.tsx:18`、`use-event.test.tsx:18`、`prompt-submit-race.test.ts:43`、`sync-fixture.tsx:19`、`sync.test.tsx:53` |
| `Bun.write` | 10 | `TB/test/cli/cmd/tui/sync*.test.tsx`、`TB/test/cli/tui/dialog-prompt.test.tsx:29` |
| `Bun.stringWidth` | 12 | `TB/test/prompt/display.test.ts:12-18`、`TB/test/prompt/part.test.ts:31-47` |
| Bun snapshot | 1 檔 | `TB/test/cli/tui/__snapshots__/inline-tool-wrap-snapshot.test.tsx.snap` |
| 測試渲染器 | `testRender` from `@opentui/solid` | 需要**原生 renderer**（`@opentui/core/testing`）→ 同 §3 的 FFI 死結 |

### 2.4 依賴面（非 Bun 語法，但同樣擋住「跑起來」）

TB 的 `package.json:51-54` 依賴 4 個 **workspace 套件**，在 IH worktree 內**不存在**（`tui-beta-1/packages/` 是 IH 自己的套件）：

| 套件 | TB 內引用 | 上游體量（FORK/OC） | 缺它的後果 |
|---|---|---|---|
| `@opencode-ai/core` | 5 個模組：`global`、`flag/flag`、`installation/version`、`util/glob`、`util/flock`，12 檔引用（`TB/src/app.tsx:5-7`、`TB/src/context/kv.tsx:4-5`、`TB/src/context/theme.tsx:27-28`、`TB/src/context/sdk.tsx:3`、`TB/src/ui/dialog.tsx:7` 等） | `Global` 94 行、`Flag` 82、`InstallationVersion` 8、`glob` 34、`flock` 358 ≈ **576 行** | 起不來（Effect service `Global.Service` 是 `run()` 的第一行，`TB/src/app.tsx:187`） |
| `@opencode-ai/plugin/tui` | 20 檔引用（`TB/src/plugin/runtime.tsx:1-6`、`TB/src/attention.ts:1-12` 等） | 1,919 行 | 起不來（plugin host 是 `TuiInput` 必填欄位，`TB/src/app.tsx:151`） |
| `@opencode-ai/sdk/v2` | 27 檔引用（`TB/src/context/sdk.tsx:1`） | 生成程式碼 **20,862 行** | 起不來（HTTP/SSE 客戶端） |
| `@opencode-ai/ui` | 只用到 6 個 `.mp3` 資產（`TB/src/attention.ts:17-22`） | 24,472 行（多為 web 元件） | 只有音效失效；但 `with { type: "file" }` 一併要處理 |

---

## 3. @opentui 是什麼

### 3.1 三個套件的性質

| 套件 | 性質 | 證據 |
|---|---|---|
| `@opentui/core` 0.4.5 | **Zig 原生核心 + FFI 綁定**。核心是 `opentui.dll`（win32-x64，**3,786,120 bytes**），JS 只是 ~340+ 個符號的 FFI 表 | `FORK/.../@opentui+core-win32-x64@0.4.5/node_modules/@opentui/core-win32-x64/{package.json,opentui.dll}`；符號表在 `FORK/.../@opentui/core/chunk-node-q0cwyvm9.js` 的 `getOpenTUILib()`（`dlopen(resolvedLibPath, { ...setLogCallback..., createRenderer..., yogaNodeCalculateLayout... })`，該區塊量到 **347 個 `returns:`**） |
| `@opentui/solid` 0.4.5 | **純 JS 的 SolidJS reconciler**（1,588 行 `index.js`）+ **Bun-only 的 build plugin** | `FORK/.../@opentui/solid/index.js`（`wc -l` = 1588）；`scripts/preload.node.js` 全檔就是 throw；`scripts/solid-plugin.node.js` 同 |
| `@opentui/keymap` 0.4.5 | **純 JS**，唯一 dep 是 `@opentui/core` | `FORK/.../@opentui/keymap/package.json`（`"dependencies": {"@opentui/core": "0.4.5"}`，無 bun/node 條件分支） |

### 3.2 是 native addon 還是 FFI？

**是 FFI，不是 N-API addon**：平台套件內只有 `opentui.dll`，**沒有任何 `.node` 檔**（`find FORK/.../@opentui/core -name "*.node"` 無結果）；載入方式是 `dlopen(<dll path>, <符號表>)`。dll 路徑的取得方式兩邊不同：
- Bun：`import("./opentui.dll", { with: { type: "file" } })`（`FORK/.../@opentui/core-win32-x64/index.bun.js`）
- Node：`fileURLToPath(new URL("./opentui.dll", import.meta.url))`（同套件 `index.js`），再由 `resolveNativeLibraryPath()` 動態 `import("@opentui/core-win32-x64")` 取 default（`FORK/.../@opentui/core/chunk-node-q0cwyvm9.js`，`// src/platform/runtime-assets.node.ts` 段）

### 3.3 Node 能不能載入？——**條件是 `node:ffi`，而我們的 Node 沒有**

`FORK/.../@opentui/core/chunk-node-q0cwyvm9.js`（`// src/platform/ffi.ts`）的三分支：

```
isBun → createBunBackend(require("bun:ffi"))
非 Bun → try { createNodeBackend(require("node:ffi")) } catch → createUnsupportedBackend(error)
```

`createUnsupportedBackend` 的 `dlopen()` 拋 `FFI_UNAVAILABLE = "OpenTUI native FFI is not available for this runtime yet"`（同檔）。
`bun-ffi-structs@0.2.4`（`@opentui/core` 的 dependency）自己的錯誤訊息也寫死條件：`"bun-ffi-structs requires Bun or Node.js with node:ffi enabled (--experimental-ffi --allow-ffi)."`（`FORK/.../@opentui/core/chunk-node-q0cwyvm9.js` 內嵌的 `bun-ffi-structs/dist/index.js` 段）。

**本機 Node 探測（唯讀掃描 `C:\Program Files\nodejs\node.exe`，91,694,408 bytes）**：

| 字串 | 出現次數 | 意義 |
|---|---:|---|
| `v24.15.0` | — | 本機 Node 版本 |
| `node:ffi` | **0** | 沒有這個內建模組 |
| `experimental-ffi` | **0** | 連旗標都不存在 |
| `allow-ffi` | **0** | 同上 |
| `getRawPointer`（node:ffi 專屬 API） | **0** | 同上 |
| `node:sqlite` | 4 | 對照組：`node:sqlite` 確實存在 |
| `experimental-sqlite` | 4 | 對照組：僅有 experimental 警告 |

→ **結論（證據式）**：在我們鎖定的 Node 上，`@opentui/core` 的 Node 路徑會退回 unsupported backend，**原生渲染核心無法載入**。這也意味著 `testRender`（`@opentui/core/testing`）一併失效——45 個用它的測試檔案全部無法執行。

**不確定處**：`node:ffi` 是否在「某些」Node 版本（或未來版本）已落地，本機離線無法確認；本報告只斷言**這一顆 Node v24.15.0 沒有**。

### 3.4 附帶事實

- `@opentui/core` 的 Node 建置**其餘部分對 Node 友善**：stdin 走 `process.stdin` + `setRawMode`（`chunk-node-51kpf0mz.js` 內 8 處 `setRawMode`）、tree-sitter worker 走 `node:worker_threads`、`process.versions.bun` 只用來切換 `ThrowAcrossNativeCallback` 行為（`chunk-node-51kpf0mz.js:116438`、`chunk-node-q0cwyvm9.js:22369`）。**唯一且致命的缺口就是 FFI**。
- 佈局是原生 Yoga（FFI 符號 `yogaNodeCalculateLayout`、`yogaConfigCreate`…，`chunk-node-q0cwyvm9.js`），**JS 端沒有 fallback 佈局器**（掃 `softwareRenderer|jsFallback|fallbackRenderer` 皆 0 命中）。
- 語法高亮是 `web-tree-sitter` WASM（peerDependency，`@opentui/core/package.json`），這部分**在 Node 上本來就能跑**。

---

## 4. 三個替換選項

### (a) 在 Node 上 shim Bun

**規模**：production 18 個呼叫點 / 8 檔（§2.1）。逐一對應：

| 子項 | 行數推估 | 難度 |
|---|---|---|
| `Bun.stringWidth` ×4 | 20–60 行（用 `string-width` 或 tui-core `clusterWidth` 包一層） | 低。**注意語意**：TB 自己在 `TB/src/prompt/display.ts:6` 註記「Bun 把換行算 0 寬、Textarea offset 算 1」；emoji/ZWJ 寬度需與 `TB/test/prompt/display.test.ts:16-18` 對齊（推論：tui-core `clusterWidth` 對 U+1F468 回 2，可過） |
| `Bun.file` / `Bun.write` ×4 | 20 行（`node:fs/promises`） | 低 |
| `from "bun"` 的 `fileURLToPath`/`pathToFileURL` ×2 | 2 行 | 極低 |
| `with { type: "file" }` ×6 | 30–60 行 + build 資產步驟 | 中（要改 import 形態與打包流程） |
| `bun:sqlite` ×1 檔（`editor-zed.ts`） | 60–120 行（改 `DatabaseSync`、`prepare`、具名參數） | 中；**Windows 上 Zed 路徑本來就沒候選**（`TB/src/editor-zed.ts:187-195` 只列 macOS/Linux 路徑），此檔在 Windows 是死碼 |
| `bun:ffi` ×1 檔（`terminal-win32.ts`，131 行） | 80–120 行改 koffi（IH 有現成範式） | 中 |
| `bun:test` ×45 檔 | 換 vitest 需改 import 與 `mock` API（`TB/test/app-lifecycle.test.tsx:1` 用了 `mock`） | **中高**，且 `testRender` 仍缺原生 |

**合計：約 250–400 行 shim + 測試遷移。**

**它為什麼無用（關鍵）**：shim 只覆蓋 **TB 自己**的 Bun 呼叫。**依賴內部的 Bun 用法 shim 不到**——`@opentui/core` 的 Node 分支要求 `node:ffi`，而 `node:ffi` 是 `node:` 前綴的內建 specifier：Node 對 `node:` 不查 `node_modules`（**推論，但屬 Node 的既定解析規則**）。所以：
- 要嘛**改 @opentui/core**（把 `platform/ffi.ts` 的 node backend 從 `node:ffi` 換成 koffi），這是 fork 一個 1.33 MB 打包檔 + ~347 符號 + 結構體/回呼 ABI 的工程；koffi 有能力做（`IH/packages/sandbox-windows-acl/src/ffi.ts:12` 就在用結構體與指標），但**無法離線驗證**（§6）。
- 要嘛用 Node 的 loader hooks（`module.registerHooks`）偽造 `node:ffi`——依賴 loader 內部行為，且仍得用 koffi 實作 `dlopen/getRawPointer/toArrayBuffer/registerCallback` 全套語意。

**判定**：(a) 是 (b)/(c) 的**前置工作之一**，不是獨立方案。單獨做 (a) 得到的是「編譯得過但起不來」。

### (b) 換渲染器：保留 SolidJS 元件樹，改接 IH `tui-core`

**接縫在哪裡**：`@opentui/solid` 的 reconciler 其實**已經參數化**——`FORK/.../@opentui/solid/src/renderer/universal.d.ts` 的 `createRenderer({ createElement, createTextNode, createDynamicTextNode, createSlotNode, isTextNode, replaceText, insertNode, removeNode, setProperty, getParentNode, getFirstChild, getNextSibling })` 是一組 node-ops 轉接面。理論上可餵自製實作。**但**型別與執行期都綁死 `@opentui/core` 的 `BaseRenderable`（`src/reconciler.d.ts:1`），而 `BaseRenderable` 的每個具體子類別都是**原生物件代理**（`createNativeRenderable` FFI 符號）。

**必須重做的部分（按大小排序）**：

| 元件 | 現況 | 重做內容 | 推估行數 |
|---|---|---|---|
| **Layout** | 原生 Yoga（FFI）；tui-core **零佈局**（`IH/packages/tui-core/src/index.ts` 匯出面無 layout） | JS flexbox 子集（flex-direction/grow/shrink/wrap/padding/gap/absolute）+ 文字量測 | 1,500–3,000 |
| **Renderables** | box/text/span/scrollbox/textarea/input/diff/code/line_number/markdown + text modifiers（實際用量見 §1.4） | 每個都要重寫成「畫進 tui-core `CellBuffer`」的物件：文字緩衝（grapheme/寬度/換行/裁剪）、scrollbox（視窗 + 捲軸 + 加速）、textarea/input（編輯、游標、extmark）、diff、code（tree-sitter 可留 WASM）、markdown、line_number | 4,000–8,000 |
| **Reconciler 適配** | `@opentui/solid` 1,588 行 | 可重用其演算法，但 node-ops 與型別要重接；或直接移植該檔 | 800–1,500 |
| **Input / focus** | `@opentui/core` 的 `KeyHandler`/`MouseParser`/`StdinParser`（原生 parser 在 dll） | tui-core 已有 `InputParser`（634 行，`IH/packages/tui-core/src/input/parser.ts`）可重用；但 **focus 樹、tab 順序、key routing** 要自建 | 500–1,000 |
| **Clipboard** | TB 自己就是 Node 原生（`TB/src/clipboard.ts:1-6` 用 `child_process`/`fs`；OSC52 在 `:25-28`），**不依賴 @opentui** | 幾乎不用動 | 0–200 |
| **音效 / 其他** | `Audio` 來自 @opentui/core（原生） | 直接閹掉或另外接 | 0 |

**合計推估 8,000–15,000 行**，且會**丟掉** 45 個 `bun:test` + `testRender` 測試（改寫成 IH 的 `@xterm/headless` + node-pty harness 是另一筆帳，`IH/packages/tui/test/harness/` 57 檔的既有資產可參考但不可直接套）。

**判定**：這是唯一「長期不背 Bun」的路，但它**不是橋接，是換引擎**。若做，範圍應該縮到 TB 真正用到的 ~10 個 intrinsic + 最小 flexbox，而不是重做整個 @opentui。

### (c) 這個前端單獨留在 Bun（獨立 process，跟 IH backend 通訊）

**做法**：Bun sidecar process 跑 TB（`run(TuiInput)`，`TB/src/app.tsx:142-152` 接受注入的 `fetch` + `events`），IH 端提供 adapter（該接縫的成本見 `docs/research/2026-09-09-opencode-tui-graft-feasibility.md` §6.2，推估 6,200–12,600 行）。

**成本**：

| 項目 | 內容 | 證據/備註 |
|---|---|---|
| Runtime | Bun（`packageManager: bun@1.3.14`，`OC/package.json:7`） | 每個平台一份 binary |
| 原生二進位 | `@opentui/core-{win32-x64,win32-arm64,darwin-*,linux-*}`（optionalDependencies，`FORK/.../@opentui/core/package.json`） | 由 pnpm/npm 依 `os`/`cpu` 安裝；TB 的 `bunfig.toml` 不需要它，是 package.json 拉的 |
| 打包/簽章 | 上游 Windows 三目標（x64 / x64-baseline / arm64）+ Authenticode 簽章 | `OC/.github/workflows/publish.yml:109-218`、`OC/script/sign-windows.ps1` |
| 缺件 | 仍要自備 `@opencode-ai/{core,plugin,sdk,ui}`（§2.4，≈47k 行）與 `TuiInput` driver | TB 目前沒有 `node_modules` |
| 測試 | 45 檔 `bun:test` **原樣可跑**（但需原生 renderer，在 Bun 下有） | 這是 (c) 相對 (b) 的最大優勢 |

**判定**：**風險最低、今天可動**。代價是「第二個 runtime + 第二套測試基礎設施 + Windows 簽章鏈」。對 IH 而言它是**隔離的 sidecar**，不污染主線（TB 現在刻意不進 workspace，`tui-beta/README.md:24`）。

### 選擇

**選 (c) 做 spike。** 理由：
1. (a) 不成立——shim 完仍缺 `node:ffi`，而補 `node:ffi` 等於 fork @opentui（不可離線驗證）。
2. (b) 的投報率要等 (c) 的 UX 證據——先花 1–2 週讓 (c) 跑起來、用真資料判斷「這個 UX 值不值得」，再決定要不要花 8k–15k 行重寫渲染層。
3. (c) 的成本主要是**維運**（Bun binary、簽章、CI），而 IH 主線完全不動；這與 `tui-beta/README.md:24` 的既有紀律一致。
4. 若 (b) 要做，**先做最窄的 vertical slice**（box + text + scrollbox + 一種輸入元件 + 一個 flexbox 子集）驗證可行性，不要一次吃下整個 @opentui。

---

## 5. Windows 風險

| 風險 | 現況 | 證據 | 對策/影響 |
|---|---|---|---|
| **`terminal-win32.ts` 用 `bun:ffi`** | TB 在 Windows 靠它清 `ENABLE_PROCESSED_INPUT`（Ctrl+C 才會以 stdin 抵達）、清空輸入緩衝 | `TB/src/terminal-win32.ts:1,30-54`；呼叫點 `TB/src/app.tsx:214`、`:358`；另有 `win32InstallCtrlCGuard`（`:69-130`）由 **OC 的 CLI** 呼叫（`OC/packages/opencode/src/cli/cmd/tui.ts:16,189`）——TB 副本內**沒有**呼叫點 | 選 (a)/(b) 時必須用 koffi 重寫（IH 已有兩處 koffi Win32 綁定範式）。**不做這個，Windows 上 Ctrl+C 行為會退化** |
| **原生二進位 per platform** | `opentui.dll` 只隨 `@opentui/core-win32-x64` 發佈（另有 arm64 條目） | `FORK/.../@opentui+core-win32-x64@0.4.5/.../package.json`（`os: ["win32"]`, `cpu: ["x64"]`） | Windows arm64 需另一顆 dll；Linux musl 另有 `-musl` 變體（`@opentui/core` optionalDependencies 共 8 個平台包） |
| **ConPTY** | TB **本身不用 PTY**（它是終端機前端，直接吃 stdin/stdout）；IH 的 PTY 測試 harness（`IH/packages/tui/test/harness/`，57 檔）驅動的是 **IH 的 TUI**，與 TB 不相容 | `TB/src/app.tsx:194` 的 `createCliRenderer` 直接操作 console | (c) 之下無此風險；(b) 之下 TB 的 45 個測試要改寫到 IH 的 PTY harness，是另一筆成本 |
| **鍵盤輸入** | `createCliRenderer({ useKittyKeyboard: {} })`（`TB/src/app.tsx:199`）；`@opentui/core` 有 `MouseParser`/`KeyHandler` 與 kitty keyboard flags | `TB/src/app.tsx:199`、`FORK/.../@opentui/core/chunk-node-51kpf0mz.js`（`setRawMode` ×8） | Windows Terminal 對 kitty protocol 支援不一（**推論**）；`win32DisableProcessedInput` 是上游對此的補丁，兩者要一起看 |
| **剪貼簿** | TB 自己實作，**不靠 Bun**：macOS `osascript`、Windows `powershell.exe` + `System.Windows.Forms`、OSC52 | `TB/src/clipboard.ts:54`（win32/WSL）、`:23-27`（OSC52） | Windows 可用；`powershell.exe` 啟動成本是已知延遲 |
| **Zed 整合** | `editor-zed.ts` 的路徑候選**只有 macOS/Linux** | `TB/src/editor-zed.ts:187-195` | Windows 上是死碼（不影響） |
| **音效** | `Audio.create()` 走原生 dll | `TB/src/audio.ts:1,7-10` | 選 (b) 時失效；選 (c) 時可用 |
| **打包/簽章** | 上游：Windows x64 / x64-baseline / arm64 三包 + 憑證簽章 | `OC/.github/workflows/publish.yml:109-218`、`OC/script/sign-windows.ps1` | (c) 若要做到可發佈，簽章鏈要自建 |

---

## 6. 不確定處（離線無法確定）

1. **`node:ffi` 的存在性**：只確定了本機 Node v24.15.0 沒有（二進位字串掃描）。`node:ffi` 是否已在其他 Node 版本/未來的 Node 落地、其 API 是否與 @opentui 期望的 `dlopen/getRawPointer/toArrayBuffer/registerCallback` 完全一致——**未驗證**（不能執行、不能連網）。
2. **koffi 能否 1:1 覆蓋 @opentui 的 FFI 需求**：~347 個符號含結構體、回呼、指標運算；koffi 3 有這些能力（IH 有結構體/指標實例），但**回呼的執行緒模型**（`NODE_CALLBACK_THREADSAFE` 是 @opentui 自己擋的）與 `bun-ffi-structs` 的 struct 佈局是否能對上——**必須實際跑才知道**。
3. **`jsx: preserve` 在 tsx 下的行為**：tsx 4.23.12（`IH/node_modules/tsx/package.json`）對 `preserve` 的處理未實測。推論是「原樣輸出 → Node 解析失敗」，但未驗證；替代路徑（`jsx: react-jsx` + `jsxImportSource`）是否與 `babel-preset-solid` 的 universal 輸出**語意等價**，也未實測（`TB/src/context/*.tsx` 有大量 `createEffect`/`createMemo` 依賴細粒度更新）。
4. **`Bun.stringWidth` 與 tui-core `clusterWidth` 的逐案等價性**：只核對了 TB 測試裡的 CJK 與 ZWJ emoji 兩個案例（推論可過），沒有全面對照表。
5. **`node:sqlite` 具名參數**：`editor-zed.ts` 用 `$editorID`/`$workspaceID`（`:143,171`），node:sqlite 的 bare-name 行為未實測（IH 現有程式全用 `?`）。
6. **@opentui 的 Node 分支在真實終端下的行為**（滑鼠、resize、kitty keyboard、Windows console mode 互動）：全未執行過。
7. **Bun 在 Windows 的實測表現**（(c) 的前提）：本機沒有 Bun，未驗證。
8. **TB 是否真的能只用注入的 `fetch`/`events` 驅動**（不依賴 `@opencode-ai/sdk` 的生成客戶端細節）：`TB/src/context/sdk.tsx:24-31` 仍呼叫 `createOpencodeClient`，替換點存在但未驗證。

---

## 附錄：一句話問答

- **能不用 Bun 跑嗎？** 在我們的 Node v24.15.0 上不行，卡點是 `@opentui/core` 需要 `node:ffi`（本機 Node 無此內建模組），不是 `Bun.*` API。
- **`Bun.*` 有幾個呼叫點？** production **18 個 / 8 檔**；測試另有 45 檔 `bun:test` + 28 個 `Bun.*`。
- **@opentui 是什麼？** Zig 寫的原生核心（`opentui.dll`，3.7 MB，~347 個 FFI 符號，含 Yoga 佈局）+ 純 JS 的 Solid reconciler；官方有 Node 建置，但 Node 路徑綁 `node:ffi`。
- **選哪個？** (c) Bun sidecar 做 spike；(b) 換渲染器推估 8,000–15,000 行，等 spike 證明值得再做；(a) 單獨做沒有意義。

---

## 附錄（controller 附註，2026-09-09）：上游正在「去 Bun 化」，而我們搬的是遷移前的版本

**事實**（網路查證 + 本地副本對照）：

1. **opencode 正在把 runtime 從 Bun 換到 Node**（2.0 重寫，漸進式透過 v1.18.x 發布）。官方 PR/issue：
   - `anomalyco/opencode#18335`：`Bun.serve` → Hono 的 Node adapter（`@hono/node-server`/`@hono/node-ws`）。
   - `anomalyco/opencode#18327`：MCP OAuth callback server 的 `Bun.serve` → `node:http.createServer`。
   - `anomalyco/opencode#10860`（feature request）：Bun 在複雜環境/低層 shell/記憶體密集/非 POSIX 平台有相容性問題，且單檔打包迫使使用者依賴 Bun。
   - v1.2.7 changelog：`Bun.file()`/`Bun.write()` 全面遷到集中的 Filesystem 模組（Node fs）；`Bun.Glob` → npm `glob`；Bun shell `$` → `util/process.ts` 的統一 Process API。
   - 動機（官方口徑）：**穩定性**、**記憶體**（1.x server 綁 Bun API，常駐 2GB+）、**runtime 無關**。

2. **本地三份副本都還沒吃到 serve/file 的遷移**（實測）：

   | 版本 | `Bun.serve` 命中檔數 | `Bun.file`/`Bun.write` 命中檔數 | `util/process.ts` |
   |---|---:|---:|---|
   | 1.18.15 | 17 | 107 | 有 |
   | 1.18.18 | 17 | 107 | 有 |
   | **1.18.30（本目錄所搬）** | **17** | **111** | 有 |

   即：shell 遷移已落地，serve/file 尚未。**`tui-beta/` 是「去 Bun 化之前」的 TUI。**

3. **對本報告結論的影響**：
   - 上游的去 Bun 化針對的是 **server**；**TUI 的渲染層仍需要 `@opentui` 的 FFI**（見正文 §2）。因此「等上游清乾淨 Bun」**不會**自動產生一個 Node 可跑的 TUI——本報告指出的 `node:ffi` 牆仍在原地。
   - 若要把這個 TUI 跑在 Node 上，**把 `@opentui` 的 FFI 後端 fork 到 koffi** 仍是最具體的解法（koffi 已是本倉既有依賴）。
   - 決策含義：把 Bun 依賴一起搬進來，等於**承接一個上游自己正在丟棄的 runtime**；若真要採用它的 UX，宜在更晚的（已去 Bun 的）版本再取，或先以 Bun sidecar 形式做 spike。
