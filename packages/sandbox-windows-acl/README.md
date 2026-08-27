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

**未來（M26+ 候選）**：codex 式「帳號式 elevated 後端」（專用本地組/帳號 + DPAPI 存密 +
背景授讀 helper + 提權 setup）——可讓 deny-read ACE 落在專用身分的 SIDs 上。M22 未實作，
因為需管理員安裝期權限與數百行 FFI，且 Windows 環境變數（域控/提權許可）不可控。

**已知不可保護向量（pin 成活文檔）**：全域任意路徑讀取不受限；外部 Everyone-ACL 物件寫入；
NUL 裝置（`cmd > NUL`）；hard link 外部別名寫；FAT 無 SD；console 隔離不可得；named-pipe 孫進程。
（M22 另發現：confined target 無法 spawn 子進程——EPERM；此為比計劃更強的寫隔離副效果，
詳見 test/kill-on-close.e2e.ts 的 descendant-denial pin。）
