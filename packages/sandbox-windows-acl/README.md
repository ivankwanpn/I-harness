# @i-harness/sandbox-windows-acl

Windows ACL write-restriction sandbox backend for the `@i-harness/sandbox`
seam. It confines subprocesses through a `WRITE_RESTRICTED` access token whose
restricting-SID list carries capability SIDs, plus Write ACEs this package
adds to the workspace and private-temp directory DACLs.

This backend is an **honest-partial** sandbox. Read this before trusting it.

## Writes are restricted; reads are not

The write restriction is real: a confined child can only write where a
capability Write ACE grants it (the workspace and its private temp dir under
`workspace-write`, nowhere under `read-only`). Every Win32 failure is checked
and throws with the API name and exact code — a child is NEVER spawned
unrestricted.

But `WRITE_RESTRICTED` only intersects *write* accesses. **Reads, network
access, and process visibility are NOT restricted**: a confined process can
read any file the user can read, open sockets, and see/kill any process the
user can. This is inherent to restricted tokens and matches the
deepseek-harness Windows backend's documented vocabulary.

## No console / window isolation

A hidden console (`CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`) is not attainable
under this restriction scheme — children sharing the host console die with
`STATUS_DLL_INIT_FAILED`. Children therefore share the host console (stdio
redirection is pipe-based and unaffected).

## `danger-full-access` is handled at the exec layer

This backend is composed only for confined modes. Mode `danger-full-access`
never composes a provider: the exec layer stays passthrough, so the command
runs unconfined. The backend never sees that mode (`SandboxPolicy` excludes it).

## Enforcement is `partial`, and the boundaries are documented

The provider reports `enforcement: "partial"` — the seam's way of saying "the
mechanism restricts writes, but not everything file-effect might imply". The
known boundary holes: `WRITE_RESTRICTED` + Everyone restricting list preserves
the ambient Everyone write grants, and NTFS hard links can bypass directory
DACLs (a hard link into a writable directory exposes the link target).
Writable directories must be caller-owned (owner-implicit `WRITE_DAC`).

## Composition notes

`createWindowsAclSandbox(options)` returns a `SandboxProvider` *with* a
`dispose()` (the factory-shaped provider that the local wrapper drops — the
compose site owns the backend and must call `dispose()` at teardown to revoke
the revocable temp grants). Only `writableDirs` is consumed by the factory;
the per-call `SandboxPolicy` is the actual enforcement input.

## Read-side confinement (M22 結論)

> **本 sandbox 不提供讀隔離。** WRITE_RESTRICTED 限制**只對寫型存取**做 restricting-SID 檢查；
> 讀存取走正常 token 檢查，而 deny-read ACE 其 deny 主體必須出現於做檢查的 token 的 SIDs——
> 但本 sandbox 的 token 只含 caller 的 ambient 身分（user/groups/logon SID），對其打 deny-read
> 會毒化同一登入工作階段的所有其他進程（含 host CLI、編輯器）。
> 此限制為 **partial（write-only）**——`enforcement: 'partial'`，與 codex/dsh 同源基準一致。

**雙證據**：
- codex 自己寫死（codex-rs/sandboxing/src/windows.rs:110-127）：「WRITE_RESTRICTED token does
  not make capability SID deny-read ACEs participate in read access checks. Read restrictions
  therefore require the elevated backend…」——且 config 要求讀分割而只有 unelevated 後端時拒跑。
- dsh README：「Writes are restricted; reads, network, and process visibility are not. …pair it
  with a read-side policy or an AppContainer/S-1-15-2 capability token for stronger confinement.」
  Known Limitations：「Read-side confinement and network policy are out of scope.」

**未來（讀隔離──若比 partial 更強的可選項）**：codex 的「帳號式 elevated 後端」（專用本地
組/帳號 + DPAPI 存密 + 背景授讀 helper）是其**產品架構選擇**——它把 sandbox 命令當成大規模
服務跑在受管帳號下；**I-harness 是跑在使用者自己機器上的 agent runtime，不做帳號登入/安裝權限
模型**。因此該路徑對本項目是範疇外（out of scope），現記錄為「未來若有明確需求再評估」，而非
「M26+ 候選」。讀隔離的替代方向（若未來需要且成本可接受）：
- 作業系統級容器化（Linux bwrap 已 full；Windows 層的 container/WSL 限制）；
- 純 consent/環境層（approval gate 作為實際安全邊界——本里程碑主軸）。
若無此類需求，M22 的**誠實 partial 標籤 + consent 強化**即為最終姿態。

**已知不可保護向量（pin 成活文檔）**：全域任意路徑讀取不受限；外部 Everyone-ACL 物件寫入；
NUL 裝置（`cmd > NUL`）；hard link 外部別名寫；FAT 無 SD；console 隔離不可得；named-pipe 孫進程。
（M22 另發現：confined target 無法 spawn 子進程（EPERM）——observed；root cause 未調查
（M25 前 follow-up；見 test/kill-on-close.e2e.ts 的 descendant-denial pin）。）

**MSYS/Cygwin 子行程在此權杖下無法啟動（2026-10-05 root-caused）**：Git Bash／Rtools bash／
msys 系工具（`usr/bin/ls.exe` 亦然）在 WRITE_RESTRICTED 權杖下於 **DLL 初始化階段**就死亡：
`*** fatal error - couldn't create signal pipe, Win32 error 5`，status `0xC0000142`（Node 讀回
unsigned `3221225794`），stdout 空。對照組原生 `cmd.exe`／`node.exe`／`git.exe` 在**同一**權杖下
exit 0；read-only 與 workspace-write **皆**失敗，故放寬到 workspace-write 無效，只有
danger-full-access 可跑。此為**子行程**failure 而非 runner failure：runner 正常啟動、只 mirror
子行程的 exit code 並讓 stdio 直通，故它看不到那行 stderr，`windows-acl-run: ` 簽名永不出現。
分類因此只能發生在 exec 層（它捕獲 stderr），現由 provider 的第二條 `runnerFailureRules`
（exit-gated **且** signature-gated）負責，轉成 `SandboxUnavailableError`
（`kind: "command-not-run"`），shell 回可讀的 `SANDBOX_DENIED` 並附真實診斷與
`danger-full-access` 升級路徑（2026-10-05 修正，見
`docs/audit/2026-10-05-ih-environment-audit-and-remediation.md`）。

**機制（2026-10-05 量測後更正）**：失敗在**匿名 pipe 的 pass-2 檢查**，不是具名 pipe、也不是
NPFS 命名空間。以本機受限行程 in-process 實測：

| 建立方式 | `NULL` SA（token default DACL） | DACL = Everyone GA | DACL = 僅使用者自己 | DACL = Administrators |
|---|---|---|---|---|
| `CreatePipe`（匿名） | ✅ | ✅ | ❌ **error 5** | ❌ **error 5** |
| `CreateNamedPipeW`（具名） | ✅ | ✅ | ✅ | ✅ |

即：`WRITE_RESTRICTED` 的 pass-2 只作用在**匿名** pipe，而且**僅當明確 DACL 未列出任何限制
SID** 時才拒絕 —— 成功／失敗與「DACL 是否含限制 SID（`Everyone` 在 restricting list 內、使用者
SID 不在）」完全一致。`msys-2.0.dll` 自身**不建構** security descriptor
（`InitializeSecurityDescriptor`／`SetSecurityDescriptorDacl`／`ConvertStringSecurityDescriptor…`
皆 0 次；沒有任何 SDDL 字面值），只使用 `SECURITY_ATTRIBUTES`(6) 與 `CreatePipe`(3)，因此它傳的是
**靜態編譯進去的 SD**。既然「Everyone 版」的 `CreatePipe` 成功而 Cygwin 的失敗，Cygwin 用的
**不可能**是 Everyone 授權；其 DACL 指向的應是使用者／建立者自身一類的 SID，落在 restricting
list 之外。既有的 `setTokenDefaultDaclGrant` 救不到它，因為那個修法只影響**未附明確 SD** 的物件。
（先前的說法——「具名 signal pipe 在 NPFS 層被拒」——已被上表推翻並更正。）

**已找到可行的替代機制（2026-10-05 量測）**：問題出在**受限權杖本身**，不在 pipe。以同一套
行程管線（本 repo 的 `spawnSandboxedInherited`）實測四種權杖，`bash -c 'echo …; uname -s'`：

| 權杖 | bash | node（`child_process` spawn） | 寫入中完整性位置 |
|---|---|---|---|
| `DISABLE_MAX_PRIVILEGE｜LUA_TOKEN｜WRITE_RESTRICTED`（現行） | ❌ `0xC0000142` | ❌ **EPERM** | 拒絕（隔離成立） |
| 同上（去掉 `WRITE_RESTRICTED`） | ❌ 載入器即失敗 | ❌ `0xC0000135`（DLL 找不到） | — |
| 同上 **＋ 低完整性標籤** | ❌ 完全相同的失敗 | ✅ | — |
| **不用受限權杖，只降完整性等級（Low IL）** | ✅ **`MINGW64_NT-10.0-26200`** | ✅ **`NESTED_OK`** | ❌ **DENIED**（隔離成立） |

附帶釐清：**`WRITE_RESTRICTED` 的語意是「把 restricting-SID 檢查放寬成只檢查寫入」**；少了它，
限制 SID 對**所有存取**生效（含讀取），所以裝在 `%LOCALAPPDATA%` 的 node 會以 `0xC0000135` 死亡
（該目錄的 DACL 不含 `Everyone`）。這是為何本後端必須帶這個旗標。

**根因鏈（可重現）**：①受限權杖下，子行程**連自己的 token 都改不了**——Cygwin 的
`cygheap_user::init` 呼叫 `NtSetInformationToken(TokenDefaultDacl)` 得到 **`0xC0000022`**
（token 物件本身的 DACL 不含任何 restricting SID，寫入被 pass-2 拒絕）；②接著它以一個不含
restricting SID 的 SD 建立匿名 pipe → **error 5**。低完整性等級只改變 ② 的標籤判斷，對 ① 無效，
所以「加重標籤」救不了它。

**因此真正的工作是換掉隔離機制**（Chrome 模型）：以 **Low integrity** 提供 no-write-up 寫隔離，
並把工作區與私有 temp **標記為低完整性**（`icacls /setintegritylevel`），而非用 capability SID 授
ACE。**優點**：MSYS 系程式恢復可用，且 node 子行程 spawn 不再 EPERM（受限權杖下任何會 spawn 的
node 工具鏈都會壞）。**代價／邊界（誠實標註）**：標籤是**單一全域層級**，不像 ACL 能逐目錄授與，
所以「哪些路徑可寫」必須改成「哪些路徑降標籤」；低 IL 子行程建立的新物件會繼承低標籤；以及本包
既有的 ACE 授與／`denialSignatures`／`runnerFailureRules` 機制需要重新設計。這是**重新架構**，不是
調參 —— 本包未實作，僅以量測記錄方向。
