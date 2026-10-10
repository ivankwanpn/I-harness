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
under this restriction scheme — children created with those flags die with
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
（M22 另發現：confined Node target 的 piped-stdio 子行程建立回 EPERM；這不是所有子行程
建立皆被拒絕的保證。handoff 對照中 inherited／ignored stdio 及原生行程建立可成功；
見 test/kill-on-close.e2e.ts 的 descendant-denial pin。）

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

**管線量測與其限制（2026-10-05 審查更正）**：以下保留 handoff 主機上的
in-process 建立結果。`CreateNamedPipeW` 這一列只量測 server 建立，沒有量測 client
以 `CreateFileW` 開啟、寫入及讀回，不能據此排除具名管線的存取檢查。

| 建立方式 | `NULL` SA（token default DACL） | DACL = Everyone GA | DACL = 僅使用者自己 | DACL = Administrators |
|---|---|---|---|---|
| `CreatePipe`（匿名） | ✅ | ✅ | ❌ **error 5** | ❌ **error 5** |
| `CreateNamedPipeW`（具名） | ✅ | ✅ | ✅ | ✅ |

Microsoft 明確記載 named-pipe client 在 `CreateFile`／`CallNamedPipe` 時會做存取檢查。
MSYS2 的公開原始碼也顯示 signal pipe 使用 `sec_user_nih`，先 `CreateNamedPipe`，再
`CreateFile` 開啟 client。因此「pass-2 只作用於匿名管線」及「signal pipe 必定使用靜態
匿名管線 SD」都不是上表能證明的結論。`setTokenDefaultDaclGrant` 只影響沒有明確 SD 的
建立操作，不能視為已修復 MSYS 的使用者專屬 SD。

來源：[Microsoft named-pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)、
[MSYS2 signal pipe](https://raw.githubusercontent.com/msys2/msys2-runtime/msys2-3.6.10/winsup/cygwin/sigproc.cc)、
[MSYS2 pipe server/client](https://raw.githubusercontent.com/msys2/msys2-runtime/msys2-3.6.10/winsup/cygwin/fhandler/pipe.cc)。
公開版本用於核對機制；這次沒有證明它與已安裝 DLL 的每一行相同。

**相容性對照（handoff 主機的量測，尚非替代後端驗收）**：以同一套行程管線
（本 repo 的 `spawnSandboxedInherited`）實測四種權杖，`bash -c 'echo …; uname -s'`：

| 權杖 | bash | node（`child_process` spawn） | 寫入中完整性位置 |
|---|---|---|---|
| `DISABLE_MAX_PRIVILEGE｜LUA_TOKEN｜WRITE_RESTRICTED`（現行） | ❌ `0xC0000142` | ❌ **EPERM** | 拒絕（隔離成立） |
| 同上（去掉 `WRITE_RESTRICTED`） | ❌ 載入器即失敗 | ❌ `0xC0000135`（DLL 找不到） | — |
| 同上 **＋ 低完整性標籤** | ❌ 完全相同的失敗 | ✅ | — |
| **不用受限權杖，只降完整性等級（Low IL）** | ✅ **`MINGW64_NT-10.0-26200`** | ✅ **`NESTED_OK`** | ❌ **DENIED**（該 Medium 測試位置） |

附帶釐清：**`WRITE_RESTRICTED` 的語意是「把 restricting-SID 檢查放寬成只檢查寫入」**；少了它，
限制 SID 對**所有存取**生效（含讀取），所以裝在 `%LOCALAPPDATA%` 的 node 會以 `0xC0000135` 死亡
（該目錄的 DACL 不含 `Everyone`）。這是為何本後端必須帶這個旗標。

**handoff 另記錄的失敗點**：受限權杖下，子行程**連自己的 token 都改不了**——Cygwin 的
`cygheap_user::init` 呼叫 `NtSetInformationToken(TokenDefaultDacl)` 得到 **`0xC0000022`**
（token 物件本身的 DACL 不含任何 restricting SID，寫入被 pass-2 拒絕）。修正此失敗點仍須
驗證後續管線 client-open、真正的 Bash／Node 子行程以及寫入範圍，不能由單一呼叫推論
整條根因鏈已完成驗證。

**Low IL 不能直接取代目前的逐範圍寫入授權**：no-write-up 能拒絕上述 Medium 位置，卻不能
隔離同一使用者其他已降為 Low 的工作區、私有 temp 或既有 Low 目錄。曾授權的根目錄若留著
Low 標籤，後續唯讀命令或移除該根目錄的命令仍可能寫入；並行會話也可能互相寫入。
這不是只需標示 `partial` 的相容性調整，而是改變目前模式及權限收回的保證。本包沒有實作
Low-only 後端，也不應將它描述為已驗收的安全替代方案。

**2026-10-05 原生替代方案驗證**：profile-free AppContainer 試作使用不同 package SID，在
Medium 測試根目錄的個別 ACE 下成功區分兩個可寫身分與唯讀身分；普通 Low 控制組不能
寫入這些根目錄。但這條實測路徑的 Git Bash／MSYS 在
`NtCreateDirectoryObject(\\BaseNamedObjects\\msys-...)` 被拒絕，Node v24.15.0 的同步及
非同步 piped spawn 皆超過整個 Job 的截止時間。它尚不能支援本次要求的工具鏈。
此結果不代表所有 AppContainer 配置都已被排除。

獨立 Windows 身分與特權啟動曾列為研究候選；使用者已明確拒絕帳戶／SYSTEM 排程路線。
本輪改採 DSH 已出貨的 Windows 原生 Shell 選擇：Agent Shell 自動模式優先 PowerShell 7，
其次 Windows PowerShell，再其次 CMD。手動 Shell 選擇保留；受限模式下明確要求 MSYS
仍可能取得上述 `SANDBOX_DENIED`，不會偷偷轉成完整存取。這並未宣稱所有 piped Node
工具鏈已恢复可用。**產品後端仍保留原有 WRITE_RESTRICTED 與 capability ACL 邊界。** 詳見
[後續審查與原生結果](../../docs/audit/2026-10-05-windows-sandbox-toolchain.md)。

# Trusted no-temp composition

`createWindowsAclSandbox` accepts an optional absolute, existing
`privateTempRoot` to locate runner temp metadata. This path alone grants no
write authority. The production legacy adapter sets
`disablePrivateTempWrites: true`: read-only grants no writable temp, and
workspace-write supplies only the declared workspace write SIDs. The runner's
`--no-temp-write true` path does not create a private temp directory, add a
temp SID, or rewrite `TEMP`/`TMP`. A workspace-write call on this path requires
a trusted `sessionId` so the provider can own the standing workspace grants.
Programs needing temp writes outside declared roots can fail.

The public `AclSandboxSpawnOptions.argumentEncoding` defaults to CRT. The
provider's `confineExecution` passes an explicit `cmd-verbatim` request through
the runner; it admits only absolute `cmd.exe /d /s /c` and one raw fifth
argument. The CreateProcess command line preserves that raw tail, including
empty text, Unicode, quoting and redirection, while existing CRT callers keep
their previous encoding.

Provider disposal closes admission immediately. Failed grant or directory
cleanup remains owned and a later `dispose()` retries it; successful grant
release is idempotent. This lets the enclosing native Job owner settle before
the ACL provider's grant lifecycle is acknowledged.
