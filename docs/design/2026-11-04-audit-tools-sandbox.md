# IH「工具／沙箱／建置」子系統設計審計（2026-11-04）

- 倉庫：`D:\dsh_ih_development\I-harness`，分支 `experiment/audit-fixes-v0.1.13`
- 範圍：`packages/exec`、`shell`、`fs`、`fs-search`、`sandbox`、`sandbox-local`、`sandbox-windows-acl`、`sandbox-windows-psec`、`sandbox-wsl`、`media`、`workflow`、`mcp-client`，以及 `scripts/`、`packages/desktop/scripts`（建置／打包）。**未審 `packages/subagent`。**
- 對照：`D:\ih_reference_project\codex-rust-v0.166.0\codex-rs`（`core/src/exec.rs`、`core/src/tools`、`apply-patch`、`utils/pty`、`rmcp-client`、`exec-server`、`windows-sandbox-rs`）、`opencode-2.1.4/packages/core`（`shell`、`job`、`tool`、`file-*`、`tool/plugin/patch`）、`deepseek-harness-dsh-v0.2.2-alpha.2`（`packages/subprocess/win32-process`、`packages/sandbox/sandbox-windows-acl`）。
- 方法：只讀產品程式碼，逐套件追「子行程擁有者 → 取消 → 輸出保留 → 資源釋放」生命週期，再與參考實作對照；每一條都給出可單檔驗證的路徑。
- 嚴重度：**C** 功能不可用或資料錯亂；**H** 常見情境不穩定／可觀測性錯誤；**M** 可維護性、可診斷性、供應鏈；**L** 體驗或一致性。

> 先講結論：這批套件的「單一擁有者 + fail-closed 結算」骨架比參考專案更嚴格（`execution-lease`、`supervision/*`、WSL worker 的 mount-identity fence 都是加分項）。真正的問題集中在三個接縫：**(1) 模型看到的 deadline 與輸出契約，和底層實際語義不一致；(2) 跨行程／跨 session 的 job 歸屬與持久化；(3) 建置與打包的可重現性沒有被任何 CI 閘門覆蓋。**

---

## A-01（H）前景 shell 沒有 exec 層 deadline；promoted／background job 完全沒有上限，模型既看不到也設不了

- **問題**：`bash`/`pwsh`/`shell` 只把 `timeoutMs` 掛在 `Tool.timeoutMs` 上，交給 `guard-timeout` 以 AbortSignal 中止；`ExecCommand.timeoutMs` 從未被 shell 工具設定，而 `background:true` 與 promoted job 連 guard 都沒有，因此「前景 120s 被殺」與「背景永不逾時」是同一份程式碼的兩個極端。
- **證據**：
  - `packages/shell/src/tools/foreground.ts:81`（`runBackground` 傳入的 cmd 無 `timeoutMs`）、`:86`（前景 cmd 只有 `abortSignal`）、`:144`；`packages/shell/src/tools/selected.ts:67,73` 同型。
  - `packages/exec/src/capture/output.ts:203-204`：唯一的 deadline timer 只讀 `command.timeoutMs`；未設定就沒有 timer。
  - `packages/exec/src/jobs/observation.ts:41-42,63-67,82-85`：promotion 只用 `backgroundAfterMs` 換手，成立後 job 不再有任何時間界線；`packages/exec/src/index.ts:65` 的 `ExecRunOptions` 也沒有 job-level deadline。
  - `packages/session-executor/src/assembly.ts:602,615`：預設 `shellTimeoutMs=120_000`、`shellBackgroundAfterMs=30_000`，且在 `:631-633` 自承「deadline 到達＝工作丟失」。
- **影響**：模型無法預期或要求 deadline（schema 沒有 `timeout` 參數），長時間指令只能靠「30s 被自動轉背景」逃過 120s 被殺；一旦轉背景，跑飛的建置／伺服器就再也沒有終止條件，只能靠 `job_kill`。反過來，若 host 沒配置 promotion（standalone／直接使用 `createShellTools`）或把 `backgroundAfterMs` 設到不小於 `timeoutMs`（assembly 會在 `:624-633` 警告），120s 到點就是**直接殺掉並丟棄工作中間結果**，模型看到的是被替換的 synthetic `TOOL_TIMEOUT`（`packages/guard-timeout/src/index.ts:42-49,59-73`），不是可續跑的 job。
- **參考**：codex 每次 exec 都帶 `ExecExpiration`（`core/src/exec.rs:63` 預設 10s、`:150-252`），逾時走 process-group kill 並有 `IO_DRAIN_TIMEOUT_MS`（`:94`）收拾繼承管線的孫行程；opencode 把 `timeout` 放進 tool schema（`tool/plugin/shell.ts:54-56`，默認 2 分鐘、可設 0 關閉，`:201` 前景/背景不同默認），並在描述裡明講。
- **方向**：`ShellToolDeps` 增加「每呼叫 deadline」並落到 `ExecCommand.timeoutMs`；schema 開放 optional `timeout`（沿用 opencode 語義，含 0=關閉）；promoted/background job 至少要有一個 job-level deadline 或「最長存活」策略，並在 `promotedResult` 誠實寫出。
- **單檔測試**：可。`packages/shell/test/shell.test.ts` 以 fake exec 斷言 `command.timeoutMs` 被填入；`packages/exec/test/capture-lifecycle.test.ts` 可補一條「無 command.timeoutMs ⇒ 無 timer」的反向鎖定。

## A-02（H）shell 輸出在 64KB 處被靜默截斷：模型只拿到頭段、沒有 notice、沒有檔案路徑，`truncated` 還不在宣告的 schema 裡

- **問題**：一旦注入 `resultRetention`（正式 assembly 一定有），exec 的 stdout/stderr 就只保留 **head 64KB 的 preview**；shell 的 retainer 只看到這 64KB，因此判定「自身未截斷」，而 spill notice 只有在 `spillStore` 存在時才會生成 —— 正式組態沒有 `spill`，於是最終工具結果是「被截斷的內容 + 一個未宣告的 `truncated` 欄位 + 沒有任何說明」。
- **證據**：
  - `packages/exec/src/capture/retention.ts:19`：有 owner 時用 `CapturePreview(owner.previewBytes ?? …)`，不是 `OutputCollector`；`packages/exec/src/capture/preview.ts:11-18` 只保留前 N bytes，`spillPath` 永遠 undefined。
  - `packages/exec/src/capture/completion.ts:85-88`：`stdout` 直接來自這份 preview；`truncated` 有值但 `stdoutSpillPath` 為 undefined。
  - `packages/shell/src/tools/retention.ts:44,52-67`：notice 需要 `spillPathForNotice`；預設 `deps.retention.spill` 未配置（`packages/session-executor/src/assembly.ts:795` 只給 `{maxBytes: 64_000}`），故 `:62` 的條件不成立，notice 不會出現。
  - `packages/shell/src/tools/foreground.ts:23`：`bash` 宣告的輸出型別沒有 `truncated`；模型只能看到一個沒被描述的欄位。
  - `packages/exec/src/jobs/views.ts:12-13`：job view 同樣只有 preview 的 `truncated`，沒有可讀取完整內容的位置。
- **影響**：長測試／建置日誌的**錯誤通常在尾端**，而 IH 保留的是頭端；模型據此下的結論會是錯的，且它無從得知「後面還有內容」。這比 codex/opencode 的「截斷但有明確警告＋完整檔位置」更危險，因為失敗模式是靜默的。
- **參考**：codex 以 `DEFAULT_OUTPUT_BYTES_CAP = 1 MiB`（`utils/pty/src/lib.rs:25`）保留並用 `TruncationPolicy` 產生 `…N tokens truncated…` / `Warning: truncated output (original token count: N)`（`core/src/tools/mod.rs:91-126`）；opencode 把完整輸出寫檔、記憶體只留 tail，並在結果附 `[showing lines X-Y of N; full output saved to <file>]`（`tool/plugin/shell.ts:246-258`）。
- **方向**：把 `truncated`/`omittedBytes`/完整內容位置正式納入 shell 輸出契約；沒有 spill store 時至少給 head+tail 視窗與明確 notice；`previewBytes` 與 `shellRetention.maxBytes` 不該被當成同一件事（前者是呈現上限，後者是模型預算）。
- **單檔測試**：可。`packages/exec/test/foreground-retention.test.ts` 或 `packages/shell/test/shell.test.ts`：餵 100KB 輸出，斷言結果含 notice 與位元組數，且尾端錯誤字串可見。

## A-03（H）背景工作只存在記憶體：沒有 durable job record／recovery，重啟後 job id 消失，原生 owner 只能靠會拋錯的 `dispose()`

- **問題**：job registry 是 `Map` + 單調 id，`ExecServiceOptions` 沒有任何 store 注入點；行程結束後 job 事實完全消失，而清理唯一入口是 `dispose()`，它在「結算不完整」時會拒絕完成。
- **證據**：
  - `packages/exec/src/jobs/records.ts:28`（`const jobs = new Map<string, Job>()`）、`:142`（id 為 `bash-<n>` 的單調計數）、`:304-320`（`getOutput`/`listJobs` 只查這個 Map，disposed 後一律 `unknown job`）。
  - `packages/exec/src/index.ts:109-118`：`ExecServiceOptions` 只有 spill/retention/execution，沒有 job store。
  - `packages/exec/src/jobs/records.ts:368-396`：`dispose()` 對每個 pending attempt 要求 `retire()` 成功，未結算就 `throw AggregateError`（`ARTIFACT_RECOVERY_REQUIRED`）。
- **影響**：桌面 app 重啟或 gateway crash 後，模型手上的 `job_id` 全部失效（`job_kill`/`job_output` 回 unknown），但底層原生 owner（psec helper、ACL runner、WSL wsl.exe）不保證已死；使用者看到「工作仍在跑」的 UI 與實際擁有者脫節。相對地，IH 有 `packages/exec/test/background-recovery.test.ts`，但那只覆蓋**同一個 service 實例內**的 recovery。
- **參考**：opencode 的 job 是 durable 的：`Background` schema 帶 `recovery`/`sessionID`/`status`（`job.ts:9-33`），`persistBackground` 寫入 kv（`:199-206`），啟動時有 `pendingBackground`/`runningBackground`（`:135-136`）做 recovery 與補償；codex 的 background 程序則由長壽 `exec-server` 以 `ProcessId` 擁有（`exec-server/src/lib.rs:87,146-152`），不依賴單一次工具呼叫。
- **方向**：把 job record（id、native identity、owner、狀態、輸出 artifact ref）寫進 session journal／store，啟動時 reconcile；`dispose()` 的失敗應降級為 job-level error 而非讓整個 service teardown 失敗。
- **單檔測試**：可。擴充 `packages/exec/test/background-recovery.test.ts`，用假的 store 重建 service 後查 `getOutput`。

## A-04（H）`apply_patch` 與 codex patch 文法不相容：End Patch 前的空行、`*** Move to:`、寬鬆 marker 全部直接失敗

- **問題**：IH 的 parser 是「嚴格子集」：chunk 迴圈遇到空行就結束，接著空行落到 unknown-line 分支丟 `FS_EDIT_NOT_FOUND`；`*** Move to:` 明文拒絕；`*** Begin Patch` 必須是第一個 byte 起的完整行。模型用 codex 的本家文法輸出時，整份 patch 直接失敗（不是部分套用）。
- **證據**：
  - `packages/fs/src/patch.ts:38-40`（第一行必須精確等於 `*** Begin Patch`）、`:82`（chunk 迴圈以 `lines[i].trim() !== ""` 為條件）、`:105-106`（任何未知行／空行即丟錯）、`:77-80`（`Move to` 直接拒絕）。
  - 對照 codex 的 parser 文法：`apply-patch/src/parser.rs:18-25` 明列 `*** Move to: ` 與「markers 前後允許空白」，且其測試 fixture `:432` 就是 `…+quux\n*** End of File\n\n*** End Patch`（空行在 End Patch 前）——這份輸入在 IH 會失敗。
- **影響**：`apply_patch` 是 fs 的主力寫入路徑；一次多檔 patch 因為格式差異整份被拒，模型會退回 `write`/`edit` 逐檔改寫，放大 token 與失敗率。這是「模型訓練分佈 vs 工具文法」的相容性 bug，不是風格問題。
- **參考**：codex 容忍 marker 周圍空白、支援 `Move to`（`apply-patch/src/lib.rs:1033-1038` 有測試）、`is_end_of_file` 為獨立旗標；opencode 亦支援 `movePath`（`tool/plugin/patch.ts:91-92,225-231`）。
- **方向**：parser 改為容忍空行與 marker 前後空白；`Move to` 以「add + delete」或 rename 實作（至少不要讓整份 patch 失敗，可回 per-hunk error）；保留現有 strict 模式作為可選。
- **單檔測試**：可。`packages/fs/test/fs-patch.test.ts` 直接餵 codex `parser.rs` 的 fixture。

## A-05（M）換行處理是「偵測單一風格後整檔改寫」：混合行尾、無尾換行、CR 檔都會被改寫

- **問題**：`detectLineEndings` 取前 4KB 的多數風格，`restoreLineEndings` 把**整個檔案**統一成該風格；patch 路徑則先 pop 尾端空元素，最後一律補一個 `\n`。任何混合行尾檔案（Windows 上常見）在 edit/apply_patch 後會產生「全檔 diff」。
- **證據**：
  - `packages/fs/src/text.ts:7-16`（sample 4KB、`crlf > lfOnly` 二選一、整檔 replace）。
  - `packages/fs/src/index.ts:433-440`（edit：normalize → 改 → restore 整檔）。
  - `packages/fs/src/patch.ts:127-128`（丟掉尾端空元素）、`:162`（一律 `join("\n") + "\n"`）、`:244-255`（整檔 restore 後寫回）。
- **影響**：對 `.bat`/`.cmd`/`.sln` 等混合行尾或 CRLF-only 檔案，一次小編輯會變成數百行 changed；對「原本沒有結尾換行」的檔案會多一個換行，可能觸發下游 diff/lint/簽章檢查。這也讓 rewind 的 pre-image 與實際寫入內容之間的差異變得難以解釋。
- **參考**：codex `apply-patch/src/text_file.rs:35-73` 逐行保留 `LineEnding`（LF/CRLF/CR 可混合），插入行使用檔案偏好的結尾（`:84-108`），而不是全檔重寫。
- **方向**：改為「逐行保留原結尾、只改動被觸及的區段」；沒有結尾換行的檔案保持沒有；`detectLineEndings` 僅作為**新增行**的預設。
- **單檔測試**：可。`packages/fs/test/fs-text.test.ts`（純函式）與 `packages/fs/test/fs-patch.test.ts`（混合 EOL fixture 斷言未觸及行的 bytes 不變）。

## A-06（H）workflow 的 job store 是 process-wide 且 API 不帶 owner：任何 session 都能讀／殺別人的 workflow job

- **問題**：`sharedJobs` 是模組級單例，`getOutput`/`listJobs`/`killJob` 只吃 job id，完全沒有 owner 或 caller 檢查；`owner` 只是被記錄下來的字串，不用於授權。模型只要猜／看到 `workflow-3` 就能讀取或中止別的 session 的工作。
- **證據**：
  - `packages/workflow/src/runner.ts:161-162`（`const sharedJobs = createWorkflowJobStore()`）。
  - `packages/workflow/src/runner.ts:455`（預設 `jobs = sharedJobs`）、`:461-471`（`getOutput`/`listJobs`/`killJob` 直接轉呼 store，無 owner 參數）、`:122-126`（`view` 只檢查存在）、`:149-157`（`kill` 只檢查狀態）。
  - 對照 exec 自己是有權限面的：`packages/exec/src/jobs/records.ts:237,240-245,304-306,319-320` 一律 `canAccess(job.owner)`，並在有 `jobInstanceId`/`sourceId` 時比對 native identity。
  - 消費端（未審、僅作影響證據）：`packages/subagent/src/tools/status.ts:75-78`、`packages/subagent/src/tools/cancel.ts:80-81` 以模型提供的 `job_id` 直接呼叫這個 facade。
- **影響**：跨 session 的資料面與控制面洩漏；在 team/subagent 情境下，child 可讀父或其他 child 的 workflow 輸出，也可中止它們。這與 exec 的 owner 模型不一致，屬於設計偏離而非單點 bug。
- **參考**：opencode 的 job metadata 一律帶 `sessionID`（`job.ts:15,244`），`backgroundAll({sessionID})` 以 session 過濾（`:122-123,132-133`）；exec 的 `canAccessOwner` 也有 lineage 概念（`packages/session-executor/src/execution-runtime.ts:99-107`）。
- **方向**：`WorkflowJobStore` 的讀／殺 API 收 caller owner（或 executor 建構時綁 session），store 內比對 `job.owner`（含 parent lineage），未知／無權限一律 `unknown job`。
- **單檔測試**：可。`packages/workflow/test/workflow.test.ts`：以 owner A 建立 job，owner B 的 facade 讀／殺應被拒。

## A-07（M）workflow 輸出無上限累積，且完成的 job 常駐 64 筆、全量 stdout/stderr 再嵌入 durable result

- **問題**：每一步的 stdout 以字串 `+=` 累積，沒有 byte 上限；完成的 job 保留 64 筆在 process 記憶體；`WorkflowLoopCompletion.result` 又完整帶上 `job.stdout/stderr` 進入 workflow 結果（後續會被持久化／進入 artifact）。長 workflow 會同時在三個地方持有同一份大輸出。
- **證據**：
  - `packages/workflow/src/runner.ts:266-273`（`appendLine`/`appendRaw` 直接字串串接）、`:100-108`（`MAX_RETAINED_FINISHED_JOBS = 64`）、`:416`（`result` 內含 `stdout: job.stdout, stderr: job.stderr`）。
  - 對照 exec 的有界設計：`packages/exec/src/capture/retention.ts:19-22`（preview/collector 有上限）、`packages/exec/src/jobs/views.ts:6-26`（view 只給有界呈現，完整內容走 frames）。
- **影響**：一個輸出 50MB 的 workflow 會讓 gateway 持有 3 份 50MB（job、result、artifact 序列化）；在桌面 app 常駐數小時後是穩定的記憶體成長來源。與 IH 自己在 exec 層的「有界呈現 + artifact」契約也不一致。
- **參考**：codex 以 1MiB cap + truncation policy（`utils/pty/src/lib.rs:25`、`core/src/tools/mod.rs:91-126`）；opencode 把 shell 輸出寫檔、記憶體只留 `maxBytes/maxLines` tail（`tool/plugin/shell.ts:244-261`），且 exited shell 只保留 25 筆（`shell.ts:31-32`）。
- **方向**：workflow job 的 stdout 改為 artifact-backed（沿用 exec 的 frame capture），記憶體內只留 bounded tail 與統計；result 只帶 artifact ref 與摘要。
- **單檔測試**：可。`packages/workflow/test/runner-lifecycle.test.ts`：大量輸出步驟後斷言記憶體中 view 長度有界且 result 不複製全文。

## A-08（M）assurance／qualification 是裝飾性的：`minimumAssurance` 永遠是 `unverified`，PSEC 的歷史資格從不參與選擇或拒絕

- **問題**：需求物件有 `minimumAssurance` 與排名邏輯，但唯一的生產者是 `transport-launch` 寫死的 `"unverified"`；PSEC 自報 `experimental`、`qualification.json` 是 `result: "incomplete"` / `historical-one-host`，runtime 卻從不要求它。於是「experimental、4 項 unsupported、單一主機歷史證據」的後端與 unrestricted 後端在選擇上等價。
- **證據**：
  - `packages/exec/src/transport-launch.ts:43-49`（`minimumAssurance: "unverified"` 硬編）。
  - `packages/sandbox/src/backend-requirements.ts:33,49`（排名比較存在，但永遠不會被觸發）。
  - `packages/sandbox-windows-psec/src/index.ts:424-441`（probe 的 assurance 是 `experimental`/`unverified`）、`qualification.json`（`result: "incomplete"`, `observationScope: "historical-one-host"`, `assurance: "experimental"`）。
  - `packages/session-executor/src/execution-runtime.ts:189-193`：qualification 只被放進 `status()` 顯示，並以 `limits` 文字自我說明「不構成當前安全認證」。
  - `packages/sandbox-local/src/execution-backends.ts:57-63`：`selection === "psec"` 直接回傳 psec，不看 probe/qualification；`wsl` 模式在 `legacy` 不可用時也會 fallback 到 psec。
- **影響**：使用者／host 無法用一句「只准已驗證後端」表達政策；實驗性後端在 `IH_WINDOWS_SANDBOX=wsl` 且 legacy 不可用時會被自動選中。這不是立即的漏洞，而是「安全等級」在這個子系統裡沒有消費者的設計缺陷。
- **參考**：codex 把 Windows sandbox level 做成顯式選擇並在後端不可用時拒絕執行（`core/src/exec.rs:312-318`、`sandboxing` 的 `SandboxType` 選擇），沒有「等級只是 UI 欄位」的狀態。
- **方向**：讓 requirements 真的可由 policy/host 設定（例如 `minimumAssurance: "experimental"` 是預設，`verified` 需明確 opt-in），並在 `select()` 前用 `checkBackendRequirements(probe, requirements)`；qualification 的 `incomplete` 應阻擋需要完整支援的來源族（PTY/MSYS）。
- **單檔測試**：可。`packages/sandbox/test/backend-requirements.test.ts` 已有純函式測試；再於 `packages/exec/test/execution-contract-consumer.test.ts` 斷言 requirements 會隨 host 設定改變。

## A-09（H）ACL 原生資產未入版控且只能在別的 checkout 建置：乾淨 clone 連 `build-dist`／打包都跑不起來，而 CI 也不跑這些 gate

- **問題**：`sandbox-windows-acl` 的 wait bridge 是一組「ROOT 審查過的生成資產」（DLL + manifest + worker），但 `native/runtime/` **沒有被 git 追蹤**（`git status --porcelain` 顯示 `?? packages/sandbox-windows-acl/native/runtime/`），而唯一的建置腳本又把輸出硬編到另一個 checkout 的路徑；`scripts/build-dist.mjs:72` 在**任何**打包之前就呼叫 `verifyAclWaitSourceAssets`，因此乾淨 clone 的建置在第一行就失敗。PSEC 的 helper 則是 committed binary，但需要本機 VS2022 + 外部 staged 的 MSYS SDK 才可能重建；安裝器另外下載未驗證的 node.exe/NSIS。這些 gate 沒有一個在 CI 或 `verify:all` 裡。
- **證據**：
  - `packages/sandbox-windows-acl/native/build-bridge.ps1:6-8`：輸出必須落在 `D:/I-harness-main/.superpowers/sdd/.../bridge-build/`（另一個 checkout 的私有路徑），否則直接 `throw`；`:9-11` 再釘死 `MSVC14.41.34120` 與 SDK `10.0.22621.0`。
  - `git ls-files packages/sandbox-windows-acl/native` 只有 `acl-wait-bridge.c` 與 `build-bridge.ps1`；`native/runtime/ih-acl-wait-bridge.dll`（105,472 bytes）與 `acl-wait-assets.json` 都不在版控。`scripts/build-dist.mjs:72`、`packages/desktop/scripts/build-gateway.mjs:39`、`package-app.mjs:34-35` 都要求它們存在且 hash 相符（`src/native-wait-assets.mjs:6-20`）。
  - `packages/sandbox-windows-psec/scripts/build-native.ps1:35-51`：要求固定路徑的 VS2022 BuildTools 與外部 staged 的 MSYS SDK（`../../build/pty-msys-sdk`），且 pin 了 4 個 SDK 檔的 hash；`artifacts/win32-x64/i-harness-windows-helper.exe`（758,784 bytes）同樣是 committed binary。
  - `scripts/build-installer.mjs:48-52,235-245,331-338`：從 nodejs.org 下載 node zip、從 sourceforge 下載 portable NSIS，「corrupt download?」只檢查解壓後有無 `node.exe`/`makensis.exe`，**沒有任何 sha256/簽章比對**，下載物直接進 installer。
  - `.github/workflows/verify.yml`：只有 `typecheck` 與（手動／排程的）`verify:all`；`scripts/verify-all.mjs:97-167` 的五個步驟是 reader build、單元、typecheck、e2e、reachability，**沒有 build-dist/build-gateway/package-app**。`scripts/build-dist.mjs:97-109` 的 native pin drift gate 因此形同虛設。
- **影響**：**乾淨 clone 無法建置 dist 或任何打包產物**，只能靠某台機器上已有的未入版控 DLL 手工補齊；commit 的 PSEC binary 與 source 的對應只靠 manifest 手動更新；安裝器打包的 node runtime 沒有供應鏈驗證。這與 IH 其他資產（psec/wsl 都有 hash manifest 且 commit）呈現「局部嚴格、整體無閘門」的不一致。
- **參考**：codex 的 `windows-sandbox-rs` 由 cargo 從原始碼建置（`build.rs`，repo 內無 committed `.exe/.dll`），CI 直接編譯；dsh donor 的 `sandbox-windows-acl` 根本沒有 native bridge（純 koffi + Node），IH 額外引入的 DLL 是其自創且只在單一 checkout 可建。
- **方向**：把 ACL bridge 產物改為 repo 相對（或入版控 + `build-command.json` 記錄 provenance），把三個 `verify*Assets` 接進 `verify:all`（至少 source/hash drift），安裝器下載加 pin 的 sha256。
- **單檔測試**：可。`packages/sandbox-windows-acl/test/wait-assets.test.ts`、`scripts/test-runtime-artifacts.mjs` 已是現成的單檔入口；另可對 `build-bridge.ps1` 加一條「輸出前綴不得含外部 checkout 名」的腳本測試。

## A-10（M）桌面 app 以 TS 原始碼 + tsx 執行 gateway，CLI 用 esbuild bundle；兩條建置路徑只有 CLI 有 verify gate

- **問題**：同一個後端有兩種出貨形態：CLI 是單一 `ih.mjs` bundle（`I_HARNESS_DIST=1`），Desktop 的 gateway 是「把 workspace 套件原始碼 + tsx loader 一起複製，執行時用 tsx 轉譯」。`package-inputs` 甚至把 `node_modules/tsx/dist/loader.mjs` 列為必要的 runtime 檔案。只有 CLI 有 `verify-dist`，Desktop 只驗 native 資產。
- **證據**：
  - `packages/desktop/scripts/build-gateway.mjs:70-88`：`cli/src/cli.ts` 是一段 `import "../../node_modules/@i-harness/desktop-gateway/src/cli.ts"` 的 shim，靠 tsx 跑 TS；`:87-88` 強制 `copyDependency("tsx", repoRoot, true)`。
  - `packages/desktop/scripts/package-inputs.mjs:49-55`：把 `tsx/dist/loader.mjs` 與 `cli/src/*.ts` 當成 gateway runtime 的必要檔案。
  - `packages/desktop/scripts/package-app.mjs:32-35`：只 `verifyNativeAssets`/`verifyWslAssets`/`verifyAclWaitAssets`，沒有任何「gateway 與 CLI 行為等價」或「TS 來源是否可載入」的 gate。
  - 對照 `scripts/build-dist.mjs:1-40` 與 `scripts/verify-dist.mjs`：CLI 有 bundle + gate。
- **影響**：兩個形態的程式碼解析、資產佈局（`new URL(..., import.meta.url)` 的相對位置）、以及 `I_HARNESS_DIST` 分支行為都不同；任何依賴「bundle 內路徑」的修正在 Desktop 上不會生效，反之亦然。`tsx` 變成產品 runtime 依賴（而非 devDependency 語義），也讓 TypeScript 版本／轉譯行為進入供應鏈。
- **參考**：dsh donor 的套件以 `tsdown` 產出 build 後再打包（例如 `sandbox-windows-acl/tsdown.config.ts`），runtime 不帶轉譯器；codex 出貨編譯後的 binary。
- **方向**：Desktop gateway 也改為 bundled 產物（或至少把 `I_HARNESS_DIST=1` 的同一份 bundle 給兩邊用），並加一個「gateway 啟動自檢」與 CLI 對等的 gate。
- **單檔測試**：可。`packages/desktop/test/package-app.test.ts`、`packages/desktop/test/installer-builder.test.ts` 可加「必須存在 bundle 指紋／不得含 tsx loader」的斷言。

## A-11（M）MCP stdio 子行程沒有樹狀擁有者：SDK 只對直系子行程 SIGTERM/SIGKILL，5 秒關不掉就永久 lost，後代成孤兒；stderr 也沒有有界擷取

- **問題**：`mcp-client` 把 stdio server 交給 SDK 的 `StdioClientTransport`（cross-spawn）管理，關閉時只對**直系**子行程送 SIGTERM→SIGKILL；IH 的「overlap guard」在 5 秒內關不掉就 `goLost` 並停止重連，但那個子行程（以及它透過 `npx`/`uvx` shim 生出的真正 server）沒有任何後續擁有者。stderr 預設 `inherit`，直接落到 host 的 stderr，沒有 bounded 擷取、也無法在 `McpServerStatusEvent` 裡診斷。
- **證據**：
  - `packages/mcp-client/src/transport.ts:13-19`：`new StdioClientTransport({ command, args, env, cwd })`，沒有 tree/job 概念。
  - `packages/mcp-client/src/supervisor/disposal.ts:14-29`：`closeWithin(gen, 5_000)` 回 `false` 就放棄；`packages/mcp-client/src/supervisor/recovery.ts:138-143` 直接 `goLost(...)`，`:155-157` 另一條路徑也只 close 不重試。
  - 依賴行為：`node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0/.../client/stdio.js:168,177`（`processToClose.kill('SIGTERM')` → `kill('SIGKILL')`，只對 `this._process`），`:78`（`stdio: ['pipe','pipe', this._serverParams.stderr ?? 'inherit']`）。
  - `packages/mcp-client/src/client.ts:157`：`toolCallTimeoutMs ?? 60_000` 只管 RPC 應答，不管行程生命週期。
- **影響**：MCP server 卡死或 shim 多一層時，IH 會留下孤兒行程並永久停止該 server（只能重啟 app）；`npx -y ...` 這種常見配置在 Windows 上尤其容易只殺到 shim。相對地，IH 的 shell/exec 對「子行程樹」有完整擁有者（job object / process group），MCP 這條路是唯一沒有樹狀擁有者的子行程來源。
- **參考**：codex 的 MCP stdio 由 executor 擁有行程（`rmcp-client/src/executor_process_transport.rs:1-20`：process 由 `stdio_server_launcher` 啟動、transport 只接 bytes），並對 stderr 做 1MiB 行緩衝（`:52-53`），對協議行有 8MiB 上限（`bounded_stdio_transport.rs:24`）。
- **方向**：把 MCP stdio 也接到 exec 的 supervision owner（或至少自建 job object / process group 並在 close 時關 job）；`closeWithin` 失敗要有「留下 debt + 可見診斷 + 可重試 kill」的路徑，而不是永久 lost；stderr 以 bounded ring buffer 進 diagnostics。
- **單檔測試**：可。`packages/mcp-client/test/lifecycle.test.ts`（fake connect 拒絕 close，斷言仍會回報 debt 並可重試）與 `test/reconnect.test.ts`。

## A-12（M）WSL 後端每一條命令都重新開一個 wsl.exe + guest Python（外加一次 `wsl --list` 驗證），沒有 per-session worker 重用

- **問題**：`reserve()`/`open()` 是每個 execution 一份 `WorkerClient`：`verifyDistribution`（exec `wsl.exe --list`）→ spawn `wsl.exe --exec python3` → 送 ~71KB base64 bootstrap → 等 hello → prepare → commit。一個 turn 跑 10 條 bash 就是 10 次 WSL 啟動 + 10 次 distro 列舉 + 10 個 Python 直譯器啟動，全部在單一命令的關鍵路徑上。
- **證據**：
  - `packages/sandbox-wsl/src/index.ts:155-160`（`reserve()` 每個 Entry 一份）、`:165-177`（`open()` 先 `verifyDistribution` 再 `new WorkerClient`）、`:190-226`（`prepare` 每次開一個 entry）。
  - `packages/sandbox-wsl/src/transport.ts:6,129-130`（spawn `C:\Windows\System32\wsl.exe ... python3 -I -B -u -c BOOTSTRAP`）、`:228`（`ready()` 等 hello）。
  - `packages/sandbox-wsl/src/index.ts:37-39`（`verifyDistribution` 每次 `execFile(wsl.exe --list --verbose)`）。
- **影響**：WSL 模式下的命令延遲以「WSL 服務啟動 + Python 啟動」為單位，且 `wsl.exe --list` 在 WSL 服務冷啟動／忙碌時容易超時（10s），造成原本可用的命令變成 `WSL inventory unavailable`。這也讓「experimental」的失敗率更難歸因（是沙箱拒絕、還是 launcher 超時）。
- **參考**：codex 由長壽的 `exec-server` 擁有 `ExecProcess`/`ProcessId`（`exec-server/src/lib.rs:87,146-152`），每次工具呼叫只送命令而不是重開執行環境；opencode 的 `Shell` 服務同樣把行程留在服務內（`shell.ts:64-74`）並用 file-backed output 重用。IH 的 `WorkerClient` 本身已支援「一個 launcher 一個 workload」，但被用成「一個 workload 一個 launcher」。
- **方向**：per-session（或 per-workspace）保留 worker，命令走 `prepare/commit` 循環；`verifyDistribution` 只在 worker 建立時做一次並快取；worker 閒置時再回收。這同時會讓 A-03 的「背景工作擁有者」在 WSL 上有一致的生命週期。
- **單檔測試**：可。`packages/sandbox-wsl/test/controller.test.ts`（fake transport 計算 spawn 次數：連續兩次 prepare 應只 spawn 一次）。

---

## 覆蓋說明（已讀、未列為 12 條的觀察）

- `sandbox-windows-acl` 的 ACL／token／grant 邊界寫得比 donor 更嚴（`grant.ts:92-119` 對 standing vs revocable 的區分、`AclWriteGrant` 的 cleanup debt 保留下來可重試），README 也誠實標明 reads/network/process visibility 不受限、MSYS 在受限權杖下必死。**唯一沒有被 runtime 消費的是 `assurance`（見 A-08）與 native bridge 的不可重建（見 A-09）**，不另外列出純文件／已知限制。
- `sandbox-wsl` 的 guest 端路徑圍籬（`worker/runner.py:85-278` 的 mount identity + `canonical_directory`）與協議 frame 驗證（`src/protocol.ts:60-136`）是本子系統最紮實的部分，沒有找到可單檔重現的漏洞；A-12 只針對「每次重開執行環境」的生命週期設計。
- `fs-search` 的 deadline/reservation/partial-result 會計（`src/model-search.ts:18-45,136-168`）與 `media` 的 bounded spawn（`src/process.ts:4-32`）沒有發現與參考實作衝突的偏離；`media` 的 ffmpeg/ffprobe 由 `ffmpeg-static`/`@ffprobe-installer` 提供，屬 A-09 同一類供應鏈議題（未重複列）。
- `exec` 的 `spill.ts` 每建一個 collector 就 `mkdtempSync` 一個新目錄、spill 檔沒有 TTL／清理（`spill.ts:37,103-112`），正式組態目前沒有啟用 spill，因此只記為 L 級待辦，不佔一條發現。

## 建議修復順序

1. **A-04 / A-02**：模型面契約（patch 文法、截斷可見性）——影響每一次工具呼叫，且單檔可測。
2. **A-09**：乾淨 clone 的建置阻塞與資產 provenance——這是 release 的前置條件，先讓 build 在任何機器上可重現。
3. **A-01 / A-03**：deadline 與背景工作的擁有者／持久化——對齊 codex `ExecExpiration` 與 opencode durable job。
4. **A-06 / A-07**：workflow 的授權面與輸出上限。
5. **A-05 / A-08 / A-12**：資料正確性、assurance 閘門、WSL 生命週期。
6. **A-10 / A-11**：桌面建置路徑收斂與 MCP 孤兒行程，排在第 2 項之後但要在下一個 release 前。

## 修復與覆核狀態（2026-11-05）

- **A-02（截斷可見性）**：shell 的 `retainedRunResult` 已有 `truncated: {stdoutBytes, stderrBytes}` 與 spill notice（`packages/shell/src/tools/retention.ts:40-120`）；保留路徑有覆蓋，未另改。
- **A-03（背景工作）**：**部分已由 saved-fact projection 覆蓋**。`saved-process-index.ts` 由 `tool/call`＋`tool/result` 重建 job id、native identity、宣告與輸出預覽，execution surface 對還原列一律標 `live:false`／`saved-preview`／`retained-unverified`，不會謊稱程序仍在跑；`saved-process-index` 31/31（含新增「重啟後 shell job 仍可定位」案例）。**仍缺**：exec service 本身的 job store 注入與 `dispose()` 失敗降級（無法讓模型對舊 job id 執行 `job_kill`）。
- **A-04／A-05（patch 文法）**：`*** Move to:` 已支援（`4b686a50`）；`*** End Patch` 前空行已支援（`2123874b`）；`*** Begin Patch` 前導空白仍未放寬。
- **A-06（workflow 授權）**：已改為 per-session owner 過濾（`863a2841`）。
- **A-07（workflow 輸出）**：stdout/stderr 各自 1M 字元上限＋截斷提示（`1764f32d`）。
- **A-09（原生資產）**：ACL wait bridge 五個檔案已入版控並附 provenance（`297b496e`）。
- **A-01（shell deadline）**：**覆核後不改**——exec 的 `timeoutMs` timer 會連 promoted 背景工作一起中止，前景 deadline 已由 guard 的 abortSignal 生效。
- **仍待處理**：A-08（assurance/qualification）、A-10（desktop 以 TS+tsx 出貨）、A-11（MCP 後代行程）、A-12（WSL worker 重用）。

### A-03 dispose 降級的覆核（2026-11-05）

嘗試把 `attempt.retire()` 失敗降級為 job-level `error`（native supervisor／retention 仍拋錯）：

- 修改後 `capture-lifecycle` 的兩個 recovery 測試由「dispose rejects」變成 resolve——它們的 retire 失敗同時代表 **descriptor/spill 尚未結算的 recovery debt**，不只是 job 狀態。
- 因此**還原**該修改，維持 dispose 拋錯。要安全降級，必須先在 attempt/owner 上區分「descriptor debt」與「job-only debt」，否則會吞掉真正需要 recovery 的訊號。
- **A-11（MCP 後代行程）**：stdio transport 現在在 SDK 關閉直系子行程前，先用 `taskkill /PID <pid> /T /F` 終止整個 process tree（Windows）；helper 有單元測試，非 Windows 行為不變。
- **A-08（assurance）**：`minimumAssurance` 不再硬編 `unverified`。`IH_MINIMUM_EXEC_ASSURANCE=verified|experimental|unverified` 可設定後端等級下限；`launchExecution` 在 probe 後以 `checkBackendRequirements` fail-closed（例如 `verified` 下 experimental 後端會被拒絕）。預設 `unverified` 與舊行為相同。
- **A-12（WSL worker 重用）部分完成**：`verifyDistribution` 現在每個 backend 只做一次（成功後快取，失敗可重試），不再每條命令都跑 `wsl --list --verbose`，移除了每次 execution 的 10s 冷啟動 timeout 風險。**worker 本身仍是一 execution 一 launcher**：`WorkerClient` 的 protocol 是單一 workload 設計，要支援 prepare/commit 循環需要重新設計 frame 所有權、輸出邊界與取消語義，屬獨立重構；本次先做安全且可測的快取部分。
