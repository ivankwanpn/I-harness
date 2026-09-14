# I-harness 後端權限與沙箱模型設計

**日期** 2026-09-14 · **分支** `m62` · **依據** `docs/audit/2026-09-11-sevenway-backend-mechanisms.md`（434 列、七源機制矩陣）

---

## 0. 這份文件要解決什麼

`safety` 是 D3 裡缺口最大的域：**45 個缺口、其中 33 條是 `rewrite`**——意即 IH 沒有、需要自己建。同時那裡有三個我剛修完缺陷二之後仍留下的洞（`terminal` 的 PTY、`fs-search` 的 rg 子行程、讀取隔離）。

在動手之前，先把七個參考源**實際怎麼做**看清楚，再決定 IH 要走哪條路。以下每一條都有出處，不是印象。

---

## 1. 七源其實是三種架構，不是七種實作

看機制的**組成**而不是數量，七源清楚分成三類：

### A 類：OS 圍堵優先（ih、dsh、codex、grok）

安全邊界是**核心層**（bwrap／seatbelt／Windows restricted token），權限層是**審批**。

| 源 | 形狀 |
|---|---|
| **ih**（13） | OS 沙箱扎實且 fail-closed（無 provider 就 `SandboxUnavailableError`、runner 失敗 exit 125/127 轉成同樣的錯誤），**但權限層很薄**——只有三層審批政策＋一個**諮詢性**的危險指令分類器。升級階梯存在但無生產呼叫者 |
| **dsh**（16） | 這一類裡最完整的。**政策是 per-call 攜帶的**（`SandboxExecutionPolicy` 隨每次能力呼叫傳遞，**不固定在 provider 上**），platform runner chain 先選後探、per-runner dialect 合成、Windows SID 生命週期、**fs mutation containment fence**、審批政策與同回合稽核配對 |
| **codex**（6） | 精簡但有結構：permission profile model + requirement/allowed catalog、session 級審批快取、**sandbox violation classification** |
| **grok**（18） | 一半是 OS 圍堵，一半是**企業治理**（見 C 類） |

### B 類：權限引擎優先（opencode、cc-custom）

邊界是**可設定的規則引擎**，OS 沙箱**缺席**（opencode 明確是 `no-os-level-sandbox`）或**委外**（cc-custom 的 `os-sandbox-delegation`）。

| 源 | 形狀 |
|---|---|
| **opencode**（6） | permission rule engine＋ask queue＋session 持久化＋core permission service v2。**沒有 OS 沙箱**，靠規則與目錄閘（MCP、外部目錄） |
| **opencode-fork**（7） | 加上 V1→V2 遷移、remembered rules、**subagent grant 與 blocked permissions**、plugin 接縫 |
| **cc-custom**（16） | 規則階梯＋mode model＋**bypass killswitch**＋denial circuit breaker＋dangerous-allow stripping＋rule shadow detection＋LLM 危險分類器＋SSRF 防護。是七源中權限**UI／治理面最厚**的 |

### C 類：治理與來源信任（grok 的另一半）

這是**只有 grok 有**的一層，而且是為企業部署設計的：

- `root-owned-managed-policy-pin`、`macos-mdm-forced-managed-preferences`——政策由組織下壓，使用者改不動
- **`ed25519-signed-policy-at-rest-fail-closed-arm`**——靜態政策有簽章
- **`build-provenance-folder-trust-gate`**——**載入專案設定前先驗證資料夾信任**
- `config-overlay-confinement-allowlist`——環境覆寫需白名單收斂
- `managed-mcp-and-marketplace-denylists`、`enterprise-proxy-ca-bundle`

---

## 2. IH 的定位與四個結構缺口

**IH 屬於 A 類**，與 dsh 最接近。但與 dsh 相比，四個差距是**結構性**的，不是功能數量問題：

### 缺口 1：政策**不是 per-call 的**（最根本）

IH 在 `packages/session-executor/src/assembly.ts:298-303` 解析一次：

```js
const sandboxPolicy = opts.sandbox === undefined ? undefined
  : createSandboxPolicy({ mode: opts.sandbox, workspaceRoot: opts.workspace })
      .resolve({ session: opts.policySession })
```

之後 `writeGuard`（L368）與 `registerShell`（L304-310）**閉包捕獲了那個物件**。而 `packages/sandbox-policy/src/session-mode.ts:9` 明明會讀最後一個 `sandbox/mode` 事件——**機制存在，但只在建構時讀一次**。

**後果**：session 中途附加 `sandbox/mode` 事件**不會生效**，必須整個 session 重新組裝。而**升級階梯（escalation）本質上就是中途改模式**——所以缺口 3 不只是「沒有呼叫者」，而是**現有架構接不上**。

dsh 的做法是把政策**隨每次呼叫傳遞**。這一點值得直接取用。

### 缺口 2：拒絕沒有分類

dsh 有 `shell-confinement-wrap-and-denial-classification`、codex 有 `sandbox-violation-classification`、cc 有 `sandbox-violation-surfacing`。IH 在修缺陷二時我加了 `FS_SANDBOX_DENIED`——**那是起點，不是終點**：目前 shell 的拒絕與 fs 的拒絕是兩套不同的錯誤形狀，模型看到的話不一樣。

### 缺口 3：升級階梯不可達，且**現有架構接不上**

`packages/sandbox/src/index.ts:75-82` 有 `WIDER_MODES`、`approveEscalation`、`sandboxDenialMarker`、`escalationHintMarker`——**全部只在測試裡**。而且我在 D1 記過：**沒有任何 tool schema 宣告它廣告的 `sandbox_permissions`／`justification` 參數**。

缺兩塊：**（a）** 工具要用 schema 宣告參數並在拒絕時回傳標記；**（b）** 政策要能在同一 session 內改變（缺口 1）。

### 缺口 4：讀取隔離完全沒有實作——**而 grok 是唯一解掉的**

IH、dsh、codex、cc 都宣告 `readIsolation: false`：bwrap 用 `--ro-bind / /`（**寫入隔離了，內容沒有**），Windows 的 `WRITE_RESTRICTED` 只交寫入權限。IH 的 `requireReadIsolation` 閘**只被測試上膛**。

**grok 的 `bwrap-reexec-with-read-deny-placeholders` 是七源中唯一真正的讀取拒絕實作**——用不可讀的佔位掛載覆蓋敏感路徑。這是可以參考的具體做法。

---

## 3. 設計

### 3.1 政策改為 per-call 解析（先做這個）

**問題**：政策在 assembly 固定，中途改模式無效。

**設計**：把 `writeGuard` 從「捕獲一個 policy 物件」改成「每次呼叫解析」：

```
// 現在（固定）
const sandboxPolicy = resolve(...)
const writeGuard = (abs) => checkWrite(sandboxPolicy, abs)

// 改為（per-call）
const writeGuard = (abs) => checkWrite(resolvePolicyNow(session), abs)
```

代價是每次寫入多一次事件掃描。`effectiveSandboxMode` 是**反向掃描到最後一個事件**，所以最壞情況是 O(事件數)。**要先量測**——若太慢，改成「快取 + 在 `sandbox/mode` 事件時失效」。

**取用來源**：dsh `sandbox-mode-vocabulary-and-per-call-policy`（`packages/sandbox/sandbox-policy/src/index.ts:163-170`）與 `session-sandbox-mode-override-log`。

### 3.2 統一拒絕形狀

shell 與 fs 的拒絕要走同一個可分類的形狀，讓模型能用同一套邏輯反應：

- 穩定代碼（`SANDBOX_DENIED`，附 `surface: "shell" | "fs" | "search" | "terminal"`）
- **人可讀的原因**（現在的 `checkWrite` 已經有了）
- **升級提示**：拒絕時附上「若確需此操作，可用 `sandbox_permissions` 提出」——**並讓工具 schema 真的宣告那個參數**

**取用來源**：codex `sandbox-violation-classification`、dsh `shell-confinement-wrap-and-denial-classification`、cc `sandbox-violation-surfacing`。

> **2026-09-15 補充：升級提示必須指名「足夠的」模式，不是「更寬的」模式。**
>
> 初版把升級提示寫成「附上可用 `sandbox_permissions` 提出」，而實作取的是 `WIDER_MODES[mode][0]`——**第一個更寬的模式**。Task 4 的審查在真實裝配上證明那是錯的：terminal 在 `read-only` 下拒絕、建議 `workspace-write`，**而它在 `workspace-write` 下也拒絕**，所以照著重試會拿到**一模一樣的拒絕、開出 0 個 PTY**。只有 `danger-full-access` 能解鎖。
>
> **規則應該是：拒絕要指名「這個操作會被允許的模式當中最窄的那一個」。** 兩者在**門檻形**的拒絕上重合（fs：`workspace-write` 就夠；shell 同理），在**所有受限模式都拒絕**的表面上分岔（terminal）。`denialFor` 因此在 2026-09-15 增加了一個可選的 `escalationTarget`；預設維持舊行為，所以 fs 與 shell 不動。
>
> **兩個推論，兩者都是同一類錯誤：**
>
> 1. **測試必須真的照著建議重試。** 只斷言「句子裡含有某個模式名稱」的測試，會在**無法照做的建議上照樣通過**——這正是它出貨的原因。
> 2. **對「升級請求本身」的拒絕，不該附帶升級提示。** 參數錯、被使用者拒絕、被取消、管道不可用、要求的模式不是嚴格更寬——這些都是「**你的請求本身有問題**」，模型該做的是修正請求，不是重複它。附上提示等於叫它再送一次同樣的東西。
>
> 3. **（2026-09-15，Task 4 第二輪審查後補）「不附提示」必須是**可表達的**，不能只是被規定的。** `denialFor` 原本只能改變提示**指名哪一個模式**，沒有辦法說「不要提示」——所以 shell 只能手寫一個 `SandboxDenial` 字面量來繞過它（`packages/shell/src/index.ts:190-198`）。**一條不能被表達的規則會被繞過，而不是被遵守。** 因此 `escalationTarget` 擴寬為 `SandboxMode | null`：`null` = 這個拒絕**不附**升級提示（用在「請求本身有問題」的那些分支），`undefined` = 維持舊行為（第一個嚴格更寬的模式），既有三個呼叫端逐字不變。
>
>    同一輪審查也指出第二個同類漏洞：**指名一個不比當前模式嚴格更寬的目標，等於附上一條做不到的建議**——與 terminal 的錯誤同類。所以 Task A 把「目標必須嚴格更寬」從文件提升為**檢查**：不成立時就當作沒有可用的升級路徑，不發出提示（而不是發出一個會被同一模式拒絕的建議）。
>
> **兩者共同的教訓**：一條**只被舉例、沒有被陳述**的規則，會在第三個例子上失效。`denialFor` 的「取第一個更寬的模式」對它被寫下時存在的兩個表面都是對的。

### 3.3 完成升級階梯

**（a）** 工具 schema 宣告 `sandbox_permissions`／`justification`——這兩個名字**已經寫在標記文字裡**，只是沒有人宣告。
**（b）** `approveEscalation` 接上真實的審批服務（現在沒有生產呼叫者）。
**（c）** 政策 per-call 化（3.1）之後，升級才有意義。

**取用來源**：dsh `escalation-ladder-and-approval-choreography`（含稽核配對）、grok `permission-mode-projection-and-queue-drain`。

> **2026-09-15 補寫。** 上面四行只說了「要做哪三塊」，沒說**升級到底是什麼語意**。動手前先把問題查清楚了，以下每一條都是從程式碼讀出來的，不是選出來的。

**（1）升級是 per-call 且暫時的，不是改 session 模式。**

這不是我挑的，是模組自己寫死的：`EscalationOutcome` 有一個字面上的 `"allowed-once"`（`packages/sandbox/src/escalation.ts:35`），而 `escalationHintMarker` 告訴模型「retry this exact … **once**」（同檔 `:31-33`）。

**後果很重要，而且先前有人（我）搞錯過**：一次獲准的升級**不附加 `sandbox/mode` 事件**，session 的 standing mode 從頭到尾不動，系統提示也不用跟著改。所以升級**不是**「讓中途模式變更可達」的那個生產者——3.1 的 per-call 解析是為**宿主驅動**的模式變更準備的，兩者是不同的路徑。（也因為如此，它與 §5 不衝突：升級不放寬 standing mode，只放寬**一次呼叫**。）

**（2）（b）是一個轉接器，不是一個子系統。**

IH 今天已有的審批縫是 `packages/interaction/src/index.ts` 的 `approval/answerer`：`(req: ApprovalRequest) => Promise<boolean>`，而且**在服務邊界就正規化**，所以宿主回傳一個真值物件不可能意外 fail-open。對映是機械的：

| approval/answerer | `EscalationOutcome` |
|---|---|
| `true` | `"allowed-once"` |
| `false` | `"rejected"` |
| 服務不存在（`ctx.services.get` 拋） | `"unavailable"` |

第三列是重點：**管道不存在時絕不靜默放行**。

**（3）每一條非授予路徑都是 throw，而工具 body throw 會殺掉整個回合。**

`approveEscalation`（`escalation.ts:79-81`）與 `validateEscalationArgs`（`:17,20,23`）都是丟例外。而 core-agent 的規則是：**工具 body 丟例外 → 整批結果丟棄、不附加 `tool/result`**，模型看到的是一次「卡住」的呼叫（`packages/fs/src/error.ts:19-31` 為 fs 寫下了同一條規則，`softFail` 就是為此存在）。**所以升級的呼叫端必須 catch 並回傳失敗，不可以讓它冒出去。** 這是這個功能最可能被寫錯的地方。

**（4）審批者只能從工具 deps 注入——沒有任何既有通道。**

`ToolExec`（`packages/core-tools/src/index.ts:24-36`）只帶 `abortSignal`／`sessionId`／`callId`／`callEventSeq`；`tools/pre-execute` 的 `{kind:"ask"}` 決定也**沒有回到工具 body 的路**。所以做法與 `sandboxPolicy` 相同：裝配時把審批者放進 deps，工具每次呼叫自行組出 `EscalationApproval`（`agent` 用當次的 `ToolExec`，`callId` 用它帶的 `callId`）。

**（5）沒有政策時，升級無意義——由型別強制。**

`approveEscalation` 要求 `effectiveMode: SandboxMode`（非 optional）。宿主沒要求沙箱時 `sandboxPolicyNow()` 回 `undefined`，**連請求都組不出來**。所以那一格的行為是：**不諮詢升級、直接照常執行**（那個呼叫本來就無圍堵，而且沒有政策就不會產生叫模型去升級的拒絕）。

**（6）fs 與 shell 必須共用同一段請求端邏輯，否則就是把 3.2 的錯再犯一次。**

3.2 要求**拒絕**只有一個形狀；同一個論證適用於**請求**。兩個套件各自實作一次「驗證參數 → 組請求 → 問審批 → 用獲准的模式跑這次呼叫」，會產生兩份會漂移的實作。**放在 `@i-harness/sandbox`（`denialFor` 旁邊）的理由與 3.2 相同**：它是零依賴的詞彙套件，而且 `fs` 已經因為 3.2 依賴它了。

**（7）子代理沒有特例。**

子代理的註冊表是**父代理的工具物件**（`packages/subagent/src/child.ts:105-110`），所以子代理的升級會用父代理的審批者、問同一個使用者、拿到同樣的 per-call 授予。**不為子代理加規則**——加一條「子代理不得升級」會是發明政策，而不是執行既有政策。

**（8）這一節不做什麼。** 不新增規則引擎（§5）；不改 standing mode；不把升級寫成一條可授予的持續權限。

### 3.4 把 `terminal` 與 `fs-search` 納入圍堵

> **2026-09-15 更正。** 本節原本寫：`terminal`「**在 `sandbox !== "danger-full-access"` 時不掛載**」，`fs-search`「走 shell 的同一條 exec 路徑」。兩條都在動工前被推翻，理由如下，原文保留在上面供對照。推翻的理由不是偏好，是**照原文做會留下它想堵的洞**。

- **`terminal`：掛載，但每次呼叫拒絕「創造能力」的操作。**

  原文的「不掛載」是一個**掛載期**決定，而這份設計的整個前提（§3.1）就是模式會在中途改變。一個以 `danger-full-access` 掛載、之後被收緊的 session，**它的 PTY 工具仍然在、仍然無圍堵**——正是 §3.1 存在要解決的那個情況。而且 `opts.sandbox === undefined` 是「宿主沒要求沙箱」（provider 對 `undefined` 與 `danger-full-access` 都是 `undefined`），所以 `!== "danger-full-access"` 這條規則會把 terminal 從**每一個從未要求沙箱的宿主**上拿掉。

  改為：`TerminalToolDeps` 收一個 `() => SandboxExecutionPolicy | undefined` resolver，每個工具在 `execute` 開頭解析——

  | 工具 | 受限模式下 | 為什麼 |
  |---|---|---|
  | `terminal_open`、`process_spawn` | **拒絕** | 這是能力的創造點。受限模式下不該有新的無圍堵 PTY。 |
  | `terminal_send` | **拒絕** | 一個在寬鬆模式下開的 PTY，收緊後繼續餵它輸入＝繼續無圍堵執行。 |
  | `terminal_read`、`terminal_signal`、`terminal_close`、`terminal_list` | 允許 | 只能觀察或**收束**（signal／close 讓模型收得掉自己開的東西）。拒絕它們只會把殘留的 PTY 變成關不掉的孤兒。 |

  拒絕用 §3.2 的同一個形狀（`denialFor("terminal", mode, reason)`）——所以模型拿到的是「為什麼被拒、以及怎麼要求更寬」，而不是一個**默默消失的工具**。工具不在等於在說「IH 沒有 terminal」，那對 IH 是**不實陳述**；一次分級拒絕才是誠實的不可用。

  **仍然為真**：PTY 無法被 kernel 圍堵。這條只是拒絕在受限模式下啟動，不是假裝圍堵。

- **`fs-search`：不改。rg 沒有寫入面，包 runner 只會讓兩個可用的唯讀工具開始失敗。**

  §7 原本記「rg 的寫入面（`--replace`？）我沒有查證」。**已查證**：ripgrep 15.0.0（`@vscode/ripgrep` 1.18.0 隨附）的完整旗標清單裡**沒有任何寫檔旗標**——`--replace` 是**在輸出裡**代換，`--files` 是列出檔案，沒有 `--output`。IH 的兩個呼叫點（`fs-search/src/index.ts:87`、`:134`）也只傳 `--files`／`--json`／`--regexp`。
>
>   **2026-09-15 補上行為證據（同一顆二進位，控制器實跑）**，因為「旗標清單裡沒有」是對清單的宣稱，而下面是對行為的：對一個真實檔案跑 `--replace BYE`，**stdout 是代換後的內容、磁碟上的檔案逐字不變**；`--output` 回 `rg: unrecognized flag --output`；該二進位列出的 145 個旗標裡，唯一匹配 `write|output|out` 的是 `--files-without-match`（比對過濾，不是寫入）。
>
>   **順帶記下一個差點誤導我自己的事實**：**PATH 上的 `rg` 是 14.1.0（Chocolatey），與 `fs-search` 實際使用的那一顆不是同一個**（後者由 `@vscode/ripgrep` 的 `rgPath` 解析，見 `fs-search/src/index.ts:14-18`；版本按鈕在 `node_modules/.pnpm/@vscode+ripgrep-win32-x64@1.18.0/…/bin/rg.exe`）。所以這條查證**必須指名二進位**，「ripgrep 的旗標」這種寫法會讓下一個人量到另一顆程式並得出相反結論。

  所以包 runner 能圍堵的東西**是空的**：讀取本來就不受限（§3.5），而 rg 寫不了檔。代價卻是真的——`glob`／`grep` 會在 runner 起不來的宿主上丟 `SandboxUnavailableError`，把兩個今天能用的唯讀工具變成失敗，換不到任何security。**當 §3.5 有了具體的政策輸入時再回來做**：那時「rg 走同一條 runner」正是讀取隔離的實作方式。

  **順帶查到、但這次不動的**：rg 讀 `RIPGREP_CONFIG_PATH` 指定的設定檔，而設定檔可以注入 `--pre`（對每個檔案執行任意命令）。IH 沒有傳 `--no-config`。這要使用者自己設了那個環境變數才成立，而且是行為改變（會蓋掉使用者刻意的 rg 設定），所以只記錄，不順手改。

### 3.5 讀取隔離：參考 grok，但先量測需求

grok 的 `bwrap-reexec-with-read-deny-placeholders` 用**不可讀的佔位掛載**覆蓋敏感路徑。方向上可參考，但 IH 要回答一個 grok 不必回答的問題：**要遮蔽什麼？**

grok 有企業政策來源可以列舉敏感路徑；IH 沒有。所以這一步**不應該先做**——先做會變成一個沒有輸入的機制。

> **2026-09-15 結案：答案就是「不要建」，並記下會改變這個結論的前提。**
>
> 這個問題從設計寫下到今天一直是「等使用者回答」。現在把它答完：**IH 沒有任何會列舉路徑的輸入，而自己編一份預設清單，等於把「我猜的別人的威脅模型」當成安全承諾出貨。** `~/.ssh`、`~/.aws`、`*.env` 這類清單看起來很合理，但那是我的判斷，不是 IH 的需求；而且 §3.5 已經定下誠實的立場——**每一個後端都允許讀取**（bwrap 用 `--ro-bind / /`，Windows 後端的檔頭自己寫明讀取不受限，dsh 完全相同）。
>
> **代價（若這個判斷是錯的）**：受限模式下的 session 仍然讀得到使用者讀得到的一切。想要「把某些檔案藏起來」的使用者拿不到那個功能。
>
> **會推翻它的前提**：出現一個**真的提供具體路徑清單的宿主**——專案設定、組織政策檔，或一個 `--deny-read` 介面。在那之前動手，產出的就是這份設計自己點名的那種失敗：**一個沒有輸入的機制。**

---

## 4. 從各源取什麼（對照表）

| 設計項 | 主要參考 | 出處 |
|---|---|---|
| per-call 政策 | **dsh** | `sandbox-mode-vocabulary-and-per-call-policy`、`session-sandbox-mode-override-log` |
| 拒絕分類 | **codex** 最精簡、**dsh** 最完整 | `sandbox-violation-classification`、`shell-confinement-wrap-and-denial-classification` |
| 升級編排 | **dsh** | `escalation-ladder-and-approval-choreography` + `approval-service-policy-and-audit-pair` |
| fs 圍堵 | **dsh** | `fs-mutation-containment-fence`（我修缺陷二時已做，語意對齊它） |
| 權限規則引擎 | **cc-custom**／**opencode** | `permission-rule-decision-ladder`、`permission-rule-engine`——**不取，見 §5**（本表列它是為了標明「知道它存在而且刻意不取」，不是備選方案） |
| 安全閥 | **cc-custom** | `denial-tracking-circuit-breaker`、`dangerous-allow-rule-stripping`、`permission-rule-shadow-detection` |
| 來源信任 | **grok** | `build-provenance-folder-trust-gate`（若 IH 要載入專案設定） |
| 讀取拒絕 | **grok** | `bwrap-reexec-with-read-deny-placeholders` |

---

## 5. 刻意**不**取的部分

**本節是約束，不是建議。** 下列三項在後續實作中不得引入；要推翻必須先改這份文件並說明理由。

**權限規則引擎（B 類的核心）**——cc-custom 與 opencode 的規則階梯很完整，但 IH 的邊界是 OS 圍堵，不是規則。引入一套可設定規則會產生**兩個真相來源**：規則說可以、沙箱說不行。IH 該做的是**把沙箱的判定講清楚**，而不是在上面再疊一層可繞過的規則。

**grok 的企業治理層**——`root-owned-managed-policy-pin`、MDM、簽章政策，是為**組織部署**設計的。IH 的宿主是自己與開發者，沒有那個信任模型。**取了會是儀式而非安全。**

**`auto-mode-llm-danger-classifier`**——IH 已經有 guardian（同樣是 LLM 審批，但**只能收緊**）。cc 那個的存在目的是**放寬自主性**。方向相反，同時裝會互相抵消。

---

## 6. 建議順序

1. **3.1 per-call 政策**——沒有它，3.3 無處可依，而且它本身修掉一個真實的「中途改模式無效」
2. **3.2 統一拒絕形狀 + 3.3(a) 宣告參數**——低成本、讓模型能自我修正
3. **3.4 terminal**——per-call 拒絕創造能力的操作（見該節更正）；`fs-search` 已查證為無需改動
4. **3.3(b)(c) 完成升級階梯**——依賴 1
5. **3.5 讀取隔離**——**先回答「要遮蔽什麼」再動手**

---

## 7. 這份設計沒有回答的問題

- **3.1 的效能**：**已量測**（2026-09-14）。per-call 解析的事件掃描在 20,000 事件的 session 上是 **0.056–0.125 ms**（九次取樣、兩個代理）。遠低於計畫設的 0.5 ms 門檻，所以**沒有加快取**，也沒有為了不存在的需求發明失效規則。
- **`terminal` 的產品衝擊**：**原記「TUI 的 PTY 功能在受限模式下會消失」是錯的**（2026-09-15 更正）。`node-pty` 是 `tui` 與 `tui-core` 的 **devDependency**（只給測試 harness 用），`packages/tui/src` 開編輯器／pager 走的是普通 `child_process.spawn`，**TUI 自己不使用 PTY**。唯一的生產 PTY 消費者是 `packages/terminal`（模型面的 `terminal_open`／`process_spawn`），而 `terminal/service` 除了那個套件與一支測試之外無人讀取。所以這個決定的衝擊**只限於模型能不能開 PTY**，不是產品功能。
- **`fs-search` 的 rg**：**已查證**（2026-09-15）——rg 沒有寫檔旗標，包 runner 換不到安全。理由與證據見 §3.4。
- **IH 要不要有專案層設定信任**：grok 有明確答案（`build-provenance-folder-trust-gate`），IH 目前的 `settings` 是使用者層。這牽涉產品定位，我沒有足夠資訊下判斷。
