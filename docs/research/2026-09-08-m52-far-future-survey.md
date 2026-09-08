# M52 遠期隊列評估（本輪排除 web/desktop 面）

日期：2026-09-08 · HEAD d7c1631 · 方式：唯讀走查（src 為準，非 README 聲稱；兩條平行子代理分別深挖 macOS 沙箱與單檔發行）
範圍：`README.md:215`「遠期隊列」中非 web/desktop 的四項——R-B4 git undo、R-A10 memories、macOS 沙箱、單一執行檔（single-exe）。web/desktop 面本輪明確排除。

**一頁結論**：四項之中只有「單檔演化的 A 案（dist 自足）」是切片（S–M）；R-B4 與 macOS 沙箱各有一個中型可做面；其餘（git checkpoint 引擎、SQLite 記憶庫、模型自動記憶、Node SEA、bun compile）都是多里程碑或棧變更。建議順序：**單檔 A → R-B4 A → 其餘等產品定義/平台化**。

---

## 1. R-B4 git undo（git 快照/回滾）

### 1.1 現狀（file:line）

**引擎本體 `packages/rewind`（M42，已完成）**

- 儲存：`packages/rewind/src/store.ts:1-8,42`——`rewind/<sessionId>/{points.jsonl, blobs/<sha256>}`，blob 為 content-addressed pre-image，temp+rename 原子寫。
- 資料形狀：`packages/rewind/src/types.ts:5-30`——`RewindFileRecord{path,status,preBlob,isNewFile,afterHash}`；`:64-79` 的 `RewindPlan{clean,conflicts,unTracked,ops}` 註解**明文寫死 v1 誠實邊界**：「SHELL-only changes (the recorder never saw them) are entirely invisible」。
- 錄製器：`packages/rewind/src/recorder.ts:1-10,74-105`——per-turn take-once（首個 pre-image 勝）、`finalize()` 重讀 touched 集算 afterHash。
- 服務：`packages/rewind/src/service.ts:1-40`（誠實範圍頭註）、`:100-140` plan 惰性比對三型 conflict、`:150-215` execute（先檔案後 `rewind/point` 事件再 truncate；had_errors 保留 points 供重試）。
- 通道：`packages/fs/src/index.ts:39-76`（`capturePreimage`）、`:100-116` write、`:133-200` edit、`:213-214` apply_patch——**只有 fs 工具**；bash/pwsh 不攔截。
- 組裝：`packages/session-executor/src/assembly.ts:258-336`（store+recorder，`user/message`→begin、`turn/end`→finalize；`:117` `rewindStoreRoot`）、`:564` handle。
- 事件與投影：`packages/core-session/src/index.ts:128`（`rewind/point` 事件）、`:224-256`（cutSeq 投影，append-only 鐵則）、`:399-411`。
- UI：`packages/tui/src/contracts.ts:51-54,250-254,369-374`；`packages/tui/src/views/rewind.ts`（六相位）；`packages/tui/src/backend/embedded.ts:244-249,748-802,888`。
- wire：`packages/sdk/src/client.ts:304-324,431-443`（`session/rewind/points|plan|execute`，M41b v1.1）。
- 啟用條件：**只在 `--session-dir`（durable session）下**——`apps/cli/src/index.ts:280-285`、`apps/tui/src/index.ts:113-119`。

**倉庫現有的 git 接觸面（唯讀/隔離）**

- 分支探測：`apps/tui/src/index.ts:242-250`（`git rev-parse --abbrev-ref HEAD`，execFileSync 1s cap，失敗即省略）。
- 安全 git exec 先例：`packages/plugin-registry/src/install.ts:290-307`（`GIT_TERMINAL_PROMPT=0`、60s timeout、maxBuffer）。

**先前的明確決策（都指向延後）**

- M42 spec §6 非目標：「持久鏡像/git 域（grok overkill 不抄）」——`docs/superpowers/specs/2026-09-05-m42-rewind-engine-design.md:51`。
- roadmap B 取捨：R-B4「後補 待 UI 產品反饋定 undo 形狀（M27+）」——`docs/roadmap/2026-08-31-roadmap-B-tools.md:87`（候選表 :18、詳情 :46）。
- M27 backlog：列在 M27e「L 級，觀望」——`docs/roadmap/2026-08-31-m27-backlog.md:46-47,64`。
- `docs/CAPABILITIES.md:129-130`、`README.md:215` 同列遠期。

### 1.2 缺口

1. **shell/外部編輯不可見**（`types.ts:64-70`、`service.ts:28-38`）：bash、外部編輯器、其他進程的寫入永遠不在 points 裡，plan() 也列不出來。這是 git 能補的**唯一結構性缺口**。
2. **每 session 一本帳**：store keyed by sessionId；同一 workspace 的兩個 session 互不知情——A 的 plan 只會把 B 的改動報成 `modified` conflict，但 execute **仍然覆蓋**（service.ts 語義：衝突照執行、誠實標記）。多 session 併發下 rewind 會吃掉別的 session 的工作。
3. **無 workspace 級基線**：只能回滾「本 session 記錄過的檔案」，不能回答「這個 workspace 相對 turn N 到底變了什麼」。
4. **無 undo-of-undo**：execute 成功即 truncate points.jsonl，回滾後的磁盤狀態沒有再快照。
5. **預設關閉**：無 `--session-dir` 就完全沒有 rewind（零成本設計，但也意味著多數使用者沒這功能）。

### 1.3 選項

| 案 | 內容 | 成本 | 風險 |
|---|---|---|---|
| **A. git 只讀對照** | plan() 時若 workspace 是 git repo，跑 `git status --porcelain -z` / `git diff --name-status` 補強 `unTracked`/`conflicts`（唯讀，不動磁盤、不碰 index/refs）。無 git → 維持現狀。 | **S**（一個探測模組 + plan 可選注入 + 測試） | 低。只增加誠實度，不增加破壞面。 |
| **B. git checkpoint 引擎** | 私有 `GIT_DIR`/object dir（`git --git-dir=<store>/git/<sid> --work-tree=<workspace> add -A && write-tree`），turn 邊界產 checkpoint；restore 用 `read-tree`/`checkout-index` 或 `git diff` 產 patch。**能覆蓋 shell/外部/子代理的變更**。 | **L**（多里程碑） | 高：node_modules/.gitignore 成本、submodule/LFS/symlink/大小寫、Windows 路徑、與使用者 repo 併發、restore 覆蓋語義、與現有 points/plan/execute 契約的 backend 抽象、冷啟動恢復。 |
| **C. `git stash create` + checkout** | 直接用使用者 repo 的 object DB 造 dangling commit，restore 用 `git checkout <sha> -- paths`。 | **M** | 高：依賴使用者 repo（非 git workspace 不可用）、動 index/鎖/hooks、GIT_* 環境干擾、restore 是 merge 語義。 |

### 1.4 建議：**後做（later）；先做 A（S），B 需產品需求確認，C 不做**

- A 用 1/10 的成本把最大的誠實缺口（shell/外部變更）從「完全隱形」變成「plan 裡列出」，且完全不動破壞面——符合本倉「誠實降級」的既有立場。
- B 的真正價值是**能回滾 shell/外部變更**，但這也意味著 restore 要覆蓋 agent 沒寫過的東西；在沒有「使用者明確要求」與「衝突裁決 UI」之前，這是一個資料安全風險而非功能。且 M42 已明確不抄 git 域，翻案需要新理由。
- C 把使用者的 repo 當我們的工作區，任何 index/refs 意外都不可接受——**never**。
- 若要 B：應做成 `RewindBackend` 抽象（blob 引擎與 git 引擎並存，points/plan/execute/wire/UI 契約不變），而非替換現有引擎；先解「同一 workspace 多 session」的歸屬問題，否則 git 只是把覆蓋範圍放大。

---

## 2. R-A10 memories（跨 session 持久記憶）

### 2.1 現狀：**不存在**

全樹 grep 無 memory 套件/工具/儲存。相鄰但不同質的面：

- **session-query（逐字檢索，非記憶）**：`packages/session-query/src/index.ts:5-44`（node:sqlite FTS5；預設 `:memory:`，file-backed 索引 `file-backed.ts:78,238`）；工具 `tools.ts:4-48`（`session_search`/`lineage`），僅在有 sessionQuery 時註冊（`docs/CAPABILITIES-DETAIL.md:69,162-163`）。
- **skills（可複用形狀）**：`packages/skills/src/registry.ts:1-2,78`（workspace `skills/` + 全域 `~/.i-harness/skills`，body deferred、BM25 檢索）；`tool.ts` 的 `skill_search`/`skill_get`。
- **instructions（注入形狀）**：`packages/instructions/src/index.ts:1-53`（AGENTS.md > CLAUDE.md，24_000 字元上限，mtime/size 快取）。
- **runtime-context（唯一注入縫）**：`packages/runtime-context/src/index.ts:33-61`——`registerSection(name, getter)`，於 `agent/pre-step` 渲染，**文字變更才** append 快照 `user/message`（`source.kind="plugin"`），冷重啟以最後快照重構；assembly 已掛 instructions section `packages/session-executor/src/assembly.ts:353-356`。
- **compaction（關鍵交互）**：`packages/compaction/src/region.ts:8-43` 只排除 `compaction/*` 標記 → **runtime-context 快照是可被 shadow 的**；而 `render()` 只在文字變化時 append，所以被壓縮掉的舊快照**不會自動重放**。任何「把記憶當 runtime-context section 注入」的方案都會踩到這個坑。
- **coordinator documents（現成跨 session 鍵空間）**：`packages/session-persistence-jsonl/src/index.ts:168-187`（storeRoot 下 `<key>.doc.jsonl`，MCP OAuth token 已這樣用）——但只在 durable session 下存在。
- **排除面**：`packages/tui/src/app/slash/registry.ts:6`（`/remember` 等未註冊，無 hidden skip-list）；M49 spec 明確排除 `/remember /recap /dream /flush /loop`（`docs/research/2026-09-06-m49-grok-tui-parity-inventory.md:307-315`）。
- **路線圖**：`docs/roadmap/2026-08-31-roadmap-A-core.md:24,69-70,102`（L、遠期、「記憶進模型 prompt 的產品型態尚未定義」）；`docs/roadmap/2026-08-31-m27-backlog.md:52`；`docs/audit/2026-08-31-fiveway-comparison.md:40,105,137`（codex `memories_1.sqlite` + 四工具，唯一來源）。

### 2.2 缺口

1. **無持久事實層**：session_search 只能檢索逐字 transcript——沒有提煉、去重、生命週期、來源追蹤。
2. **無注入機制**：唯一注入縫是 runtime-context，但它會被 compaction shadow（見上），且沒有「記憶區塊」的語義。
3. **無使用者控制面**：檢視/編輯/刪除都沒有；`/remember` 被 M49 明確排除。
4. **與 rewind 無語義**：記憶寫入不會是 session 事件，因此 rewind 回滾對話時**不會**回滾記憶（反之亦然）；這點必須在實作前寫死。
5. **無安全模型**：模型自寫記憶 = 跨 session 的 prompt injection 面（未來 session 會把它當指令讀）。

### 2.3 選項

| 案 | 內容 | 成本 | 風險 |
|---|---|---|---|
| **A. 檔案式最小面** | `<workspace>/.i-harness/memory.md`（或 `$IH_CONFIG_DIR/memory.md`）append-only 條目 + `memory_write` 工具（模型可寫、使用者可見）+ runtime-context `memory` section（硬 byte cap）+ `/memory` TUI 檢視/刪除。零新依賴。 | **S–M** | 中：需同時決定儲存位置（workspace vs 全域）、注入上限、**compaction shadow 重放**（否則記憶會被壓掉）、rewind 語義。 |
| **B. SQLite 記憶庫** | codex 形狀：`memories_1.sqlite` + list/read/search/add_ad_hoc_note 四工具；檢索走 deferred 曝光，注入可選。node:sqlite 已在用（session-query），零新依賴。 | **M–L** | 中高：產品形狀仍未定；檢索品質/去重/衰減需評估；多一個 DB 生命週期。 |
| **C. 模型自動提煉記憶** | 在 session/compaction 邊界由模型抽取事實寫入（含去重、衝突解決、衰減）。 | **L** | 最高：需要評估機制與安全審查（模型寫入的文本在未來 session 被當指令）；這是「記憶」真正的產品，也是最容易做壞的。 |

### 2.4 建議：**後做（later）；若做切片選 A，B/C 先等產品定義**

- roadmap 的判詞「產品型態未定義」**今天依然成立**。A 是唯一能在不承諾產品形狀的前提下取得真實回饋的切片（使用者看得見檔案、能刪、能評估注入是否有用）。
- 若做 A，三件事必須同批決定，否則會做出一個假功能：(1) 儲存位置與作用域（workspace vs 全域——skills 已經兩種都有，可沿用其形狀）；(2) 注入上限與「被 compaction shadow 後怎麼辦」（最乾淨是讓 memory section 排除於 shadow 範圍，或每次 render 前檢查是否被遮蔽並重放）；(3) rewind 不會回滾記憶的明文聲明。
- B 只有在「使用者要模型自己檢索記憶」的需求出現後才值得；C 必須先有使用者可見的控制面（沒有檢視/刪除面就自動寫記憶 = 不可接受的注入面）。**Never：無控制面的 C。**

---

## 3. macOS 沙箱

### 3.1 現狀

- **縫**：`packages/sandbox/src/index.ts:34-40`——`SandboxProvider{capabilities?:{readIsolation:boolean}, confine(argv,policy)}`；`:35-37` 未宣告即視為 `readIsolation:false`（fail closed）；`:64-71` `assertSandboxCapable`（`requireReadIsolation:true` + backend 不支援 → throw）；`:42-55` `SandboxUnavailableError` 的補救文案**只提 Linux bwrap / Windows ACL**。消費點：`packages/exec/src/index.ts:107-119`（:116 gate）。
- **平台鏈**：`packages/sandbox-local/src/index.ts:32-98`——win32 :33-56（注入 backend 否則 throw）、linux :58-90（`probeBwrap` :103-110）、**其餘（含 darwin）:92-97 `throw SandboxUnavailableError("unsupported platform")`**。bwrap profile 是 Linux 專屬：`packages/sandbox-local/src/profiles.ts:3-10`（`--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent`）。
- **Windows backend**：`packages/sandbox-windows-acl/src/index.ts:1-41`（WRITE_RESTRICTED token + per-workspace write SID + per-session temp SID）；`readIsolation:false` 由 wrapper 宣告（`sandbox-local/src/index.ts:47`）；誠實邊界由**故意通過的測試**釘住：`packages/sandbox-windows-acl/test/read-visibility.e2e.ts:14-46`（「confined child CAN read outside workspace … by design」）。
- **組裝**：`packages/session-executor/src/assembly.ts:232-239`——**只有 win32 分支**（動態 import ACL backend + `createLocalSandbox({windowsAclBackend})`），dispose :603-609；其他平台走 sandbox-local 的 throw。
- **darwin 在 `packages/*/src` 與 `apps/*/src` 中零出現**（僅 `packages/fs-lock/src/index.ts:72,81` 的註解/測試提到它 fail-closed）。
- **發行面**：無 CI（倉庫根無 `.github/`）、無 `os`/`cpu` 欄位、installer Windows-only（`installer/README.md:3-7`）、README 無 macOS 宣稱。
- **文件**：M16 spec `docs/superpowers/specs/2026-08-25-i-harness-m16-sandbox-design.md:67`（「macOS Seatbelt: out of M16's dual-platform scope」）、`:507`（no Seatbelt）、`:518-521`（dsh 參考：`PLATFORM_CHAINS={linux:[bwrap,landlock],darwin:[seatbelt],win32:[windows-acl]}`，seatbelt denial signature `operation not permitted`）；`docs/research/codex-research.md:61`（sbpl base policy）；`docs/CAPABILITIES.md:129`、`README.md:215`。

### 3.2 缺口

1. macOS 上任何 confined 模式直接 fail-closed——**安全但不提供任何隔離功能**。
2. 沒有 seatbelt 後端、沒有 SBPL profile 產生器、沒有 darwin 探測/組裝/測試，也沒有可跑的 e2e（無 CI）。
3. 錯誤文案與文件不提 macOS（使用者拿到的是「unsupported platform」）。
4. 產品現實：沒有 macOS 安裝器/發行鏈。**macOS 沙箱不是 macOS 支援的瓶頸**——先有 macOS 產品化，才輪到它。

### 3.3 選項

| 案 | 內容 | 成本 | 風險 |
|---|---|---|---|
| **A. seatbelt 後端** | 新 `sandbox-macos-seatbelt`（或 sandbox-local darwin 分支）：生成 SBPL（`deny default` + `file-read*` allowlist + `file-write*` 限 writableRoots/tmp + `process-exec`，可選 `deny network*`），`confine` 回 `[sandbox-exec, -p, <profile>, --, ...argv]`；`enforcement:"full"`、denial signature `operation not permitted`（dsh 先例）、runnerFailureRules 對應。 | **M** | 中高：`sandbox-exec` 自 10.15 起 **deprecated**（仍存在但 Apple 不保證）；SBPL profile 正確性（dyld/mach/sysctl/`/usr/lib` allowlist）；已被沙箱化的宿主（App Store app）不能再 sandbox-exec；無 CI 可驗證。 |
| **B. 容器/VM** | Docker/Podman/lima/Apple Containerization 執行命令。隔離最強。 | **L** | 高：換執行模型（mount/路徑映射/網路/生命週期），不是 local sandbox 縫內的事；與「本機 workspace 直改」的產品假設衝突。 |
| **C. 維持 fail-closed** | 只改進錯誤文案與文件，明確標 macOS 未支援。 | **S** | 無。 |

**誠實姿態怎麼延續**：`readIsolation` 的契約允許 macOS 後端先宣告 `false`（與 bwrap/Windows 同），`requireReadIsolation:true` 照樣 fail-closed——**第一版不需要、也不應該宣告 true**（seatbelt 理論上能拒讀，但「能拒讀」與「profile 真的擋住」需要獨立驗證，另開一輪再翻）。這樣 macOS 後端可以是一等公民，且不破壞既有的誠實模型。

### 3.4 建議：**後做（later），且與 macOS 產品化同批；若做選 A，B 不做**

- 縫本身是真的可插拔（兩個真後端已證明：sandbox-local 的平台鏈 + 注入形狀），darwin 分支 + 一個新 backend 是邊界清楚的中型工作。
- 但在沒有 macOS 安裝器/CI 的前提下，做 sandbox 等於為一個不能發行的平台寫安全代碼——**排序上應等 macOS 平台化**。
- **Never**：B（除非遠程/容器執行成為獨立產品需求，那時它是一個新的執行後端，不是沙箱後端）。

---

## 4. 單一執行檔（single-exe）演化

### 4.1 現狀（實際產物，非聲稱）

```
build/I-harness-Setup-0.1.0.exe   50.4 MB（NSIS，admin 版；另有 -test 版）
dist/                             76 MB（ih.mjs 4.26 MB + node_modules 72 MB）
installer/staging/{dist,node,*.cmd}
build/node-win-x64/               82 MB（官方 Node v22.16.0，npm 已剝離）
```

- **bundle**：`scripts/build-dist.mjs:37,39-40,119-148`——esbuild ESM bundle `apps/cli/src/index.ts` → `dist/ih.mjs`（target node22），`external:["node-pty","koffi","@vscode/ripgrep"]`；`:129-135` `define I_HARNESS_DIST=1`（避免 apps/tui 的直接入口守衛雙啟動）；`:142-147` 注入 `createRequire` 讓 bundle 內 CJS require 可解析 externals。
- **natives**：`:159-189` scratch 專案 `pnpm install --prod` → `dist/node_modules`（**hoisted flat 是硬需求**：koffi 相對解析 `@koromix/koffi-<triplet>`、ripgrep 用 `require.resolve`）；`:95-107` pin drift 檢查（`installer/dist-package.json:6-10` 精確 pin node-pty 1.1.0 / koffi 3.1.6 / @vscode/ripgrep 1.18.0）。
- **資產**：`:199-205` 複製 `model-catalog.json`（provider 於**模組載入期**以 `new URL("./model-catalog.json", import.meta.url)` 讀取）；`:223-236` 寫 `dist/package.json`（`apps/cli/src/web.ts:78-86` 用 require 讀版本）；`:237-272` README-dist.txt（明載兩個 tsx 依賴面與 `I_HARNESS_HOME`）。
- **安裝器**：`scripts/build-installer.mjs:39-41`（`NODE_RUNTIME_VERSION=22.16.0`、NSIS 3.11）、`:194-224` 下載官方 node zip、`:228-239` 寫 `.cmd` launcher（`"%~dp0node\node.exe" "%~dp0dist\ih.mjs" %*`）、`:257-270` staging、`:319-331` 編譯 admin+test 兩版；`installer/ih.nsi:71`（`$PROGRAMFILES64\I-harness`）、`:194-205`（`File /r` staging）、`:110-142`（HKLM PATH）、`:243-273`（卸載）。
- **磁盤上必須存在的執行期資產**（單檔化要全部處理）：
  1. Node runtime（安裝器帶 `node/node.exe`）。
  2. `node-pty/prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node` + `conpty/conpty.dll`、`conpty/OpenConsole.exe`、`winpty-agent.exe`、`winpty.dll`——`packages/terminal/src/service.ts:1` **頂層靜態 import**（bundle 內 `dist/ih.mjs:87004`），載入期即需。
  3. `koffi` + `@koromix/koffi-win32-x64/win32_x64/koffi.node` **必須是檔案系統兄弟**（`koffi/src/koffi/index.cjs` 用 `${__dirname}/../../../@koromix/...`）——`packages/sandbox-windows-acl/src/ffi.ts:12` **頂層靜態 import**（`dist/ih.mjs:99041`）。
  4. `@vscode/ripgrep-win32-x64/bin/rg.exe` **必須是可 spawn 的真檔**（`packages/fs-search/src/index.ts:16-19,60,74,115,119`，rgPath 當 argv[0]）。
  5. `model-catalog.json`、`dist/package.json`（見上）。
- **三個 tsx/源碼依賴的 spawn 面**（dist 的誠實限制）：
  1. `--attach` SDK spawn：`apps/tui/src/index.ts:397-406,675-679`（`REPO_ROOT = process.env.I_HARNESS_HOME ?? ...` + `TSX_LOADER` + `apps/cli/src/index.ts`）。
  2. Windows-ACL runner：`packages/sandbox-windows-acl/src/index.ts:464-467`（`[process.execPath, "--import", "tsx/esm", <runner.ts>]`）。
  3. minimal/fullscreen 自重啟：`packages/tui/src/minimal/mode.ts:69-81`（`process.execPath --import tsx process.argv[1]`）。
  4. 另有 `loadMinimalHost()` 的動態 `import("./minimal/inline.ts")`（`packages/tui/src/index.ts:230-243`）——dist 中直接 fallback fullscreen。
- **驗證不變量**：`scripts/verify-dist.mjs:83-112`（layout + 三個 natives + platform triplet + `.node`/`rg` 掃描）、`:116-135`（smoke 用 `spawnSync(process.execPath,[IH,...])`）；`scripts/verify-installer.mjs:150-186`（installed tree、`.cmd --version`、bundled node 版本）。
- **政策**：esbuild 只進 devDeps（`docs/superpowers/specs/2026-09-05-m45-packaging-design.md:39`）；依賴政策已修訂為「允許通用公開庫，禁止私有庫」（`docs/superpowers/specs/2026-08-31-m28-design.md:4`）；歷史明文「**No bun**」（`docs/superpowers/handoff/2026-08-18-m10a-complete-handoff.md:81`）。
- **已存在的版本漂移**：`package.json:8-10` `engines.node >= 22.18` vs 安裝器捆的 **22.16.0**（`scripts/build-installer.mjs:40`）。

### 4.2 缺口

1. 目前是「安裝器 + 目錄樹」（`Program Files\I-harness\{node,dist,*.cmd}`），不是單一檔案。真正的單檔要同時容納：Node runtime + JS bundle + 四個原生資產 + 兩個 JSON 資產，並在首次執行時解出（或改寫原生載入）。
2. **功能缺口與單檔無關**：`--attach`、ACL runner、minimal 自重啟、`inline.ts` 在 dist 中都不完整（前三者需要源碼 + tsx）。**這些可以用比單檔低一個數量級的成本補齊**。
3. 版本漂移（>=22.18 vs 22.16.0）與原生 prebuild 的 ABI 耦合，是任何「自帶 runtime」方案都要先釘死的前提。

### 4.3 選項

| 案 | 內容 | 成本 | 風險 |
|---|---|---|---|
| **A. 維持目錄式發行，補齊 dist 自足** | 不追求單檔：把 ACL runner 與 minimal 重啟改成 bundle 內入口（新增 `dist/runner.mjs` 或條件式 spawn），把 `inline.ts` 納入 bundle，讓 dist 不再需要 `I_HARNESS_HOME`/tsx；同步修 `engines` vs 捆綁 runtime 的版本漂移。 | **S–M** | 低（不動發行模型；verify 只需擴充 smoke）。收益：關掉 README 三條誠實限制中的兩條。 |
| **B. Node SEA** | `node --experimental-sea-config` 把 blob 注入 node.exe 副本。必須解：頂層靜態 native import 要延後或首次執行解壓到 `%LOCALAPPDATA%`（SEA 虛擬 FS 不能 require `.node`）；koffi/node-pty 的相對路徑解析、rg 必須是真檔；`model-catalog.json`/`package.json` 用 `sea.getAsset` 或內嵌；三個 tsx spawn 改成「重入自身 exe + 隱藏子命令」；SEA 對 ESM 入口與 `import.meta.url` 的支援需逐 Node 版本實測。 | **L**（多輪 spike + spawn 協定改寫 + 驗證腳本重寫） | 高：啟動延遲、AV 誤判、ABI/版本耦合、解壓目錄生命週期、Node 版本行為差異。 |
| **C. bun compile** | `bun build --compile` 產單檔。 | **L**（且是棧變更） | 最高：本倉明文「No bun」；node-pty/koffi/`node:sqlite`（session-query 的基礎）在 Bun 的相容性需實測；等於換 runtime，與「Node >=22.18 + 零新依賴」政策衝突。 |
| **D. 自解壓 SFX**（可選） | 現有 dist + node 打成 7z SFX，首次執行解到 `%LOCALAPPDATA%\I-harness\<version>`。 | **M** | 中：AV 誤判、首次延遲、快取失效/清理；且「單檔」只是下載物，執行時仍是目錄。 |

### 4.4 建議：**單檔不做（later/never）；先做 A（now，S–M）**

- 單檔的收益（一個檔案好分發）在本產品的實際瓶頸上幾乎不存在：安裝器已 ~50 MB 自足、目標機零前置、PATH/開始選單/卸載都已解決。成本卻集中在**原生模組載入**與 **tsx-spawn 協定**的重寫——而這兩者的 90% 可以在 A 裡用遠低的代價拿到（dist 自足、移除 `I_HARNESS_HOME`、`/minimal` 與 ACL runner 在 dist 可用）。
- 若未來真的要做，**優先 Node SEA**（不換 runtime、不新增依賴），且第一步必須是一個 spike：驗證 node-pty/koffi 解壓載入 + ESM SEA + `sea.getAsset`，再決定是否值得 L 成本。**Never：bun compile**（換 runtime 的代價遠超收益，且與倉庫歷史決策衝突）。

---

## 5. 橫向：規模與排序

| 項 | 切片 | 中型 | 多里程碑 | 建議 |
|---|---|---|---|---|
| R-B4 A（git 只讀對照） | ✅ S | | | **now/later**（先於 B） |
| R-B4 B（git checkpoint 引擎） | | | ✅ L | later，需產品需求 + backend 抽象 |
| R-A10 A（檔案式最小記憶） | | ✅ S–M | | later，需先定儲存/注入/compaction 三題 |
| R-A10 B/C（SQLite / 自動提煉） | | | ✅ M–L | later，需產品定義 + 安全審查 |
| macOS A（seatbelt） | | ✅ M | | later，與 macOS 產品化同批 |
| 單檔 A（dist 自足） | ✅ S–M | | | **now**（最高性價比） |
| 單檔 B（Node SEA） | | | ✅ L | later/never，先 spike |
| 單檔 C（bun） | | | ✅ L | **never** |

**先做哪一個**：**單檔 A（dist 自足）**。它是四項中唯一「成本確定為切片、收益立刻可驗證（verify-dist/installer 的 smoke 擴充即可）、且直接關閉 README 已承認的兩條誠實限制」的工作；其餘三項都卡在產品定義（記憶/git undo 形狀）或平台化前提（macOS 發行）上，現在動只會做出沒有消費者的代碼。

**交叉依賴備註**：
- R-B4 B 若啟動，必須先解「同一 workspace 多 session 的變更歸屬」——這與 R-A10 無關，但與 git 的 workspace 級視圖直接相關。
- R-A10 與 compaction 的 shadow 交互（`packages/compaction/src/region.ts:8-43`）是實作前必須驗證的第一件事；與 rewind 的關係是「互不撤銷」，需明文寫入文件。
- macOS 沙箱與單檔無依賴，但兩者都受「Windows-first 發行面」的約束：單檔 A 的 `dist/runner.mjs` 改法在 macOS 上同樣適用，反之 macOS 後端不影響 dist 佈局。
