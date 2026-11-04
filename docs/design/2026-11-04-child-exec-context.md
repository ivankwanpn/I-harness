# Child exec context — 實作方案（2026-11-04）

## 現況（為什麼子代理沒有 shell）

1. 父 assembly 建立 shell 工具時，`createScopedExecWithReservation(pair, cwd, policy, prepare, context)` 會把「claim → 跑哪個 exec」的對應註冊在 `directContexts`（`packages/session-executor/src/scoped-exec.ts`），key 是**父層的 plugin context**。
2. `resolveRoleTools`（`packages/subagent/src/child/role-tools.ts`）把父 registry 的 tool **物件本身**註冊到 child registry。
3. 子代理執行 `bash`/`shell`/`pwsh` 時，claim 的 context 是**child ctx**；`directContexts.get(child ctx)` 不存在 → `Original scoped Exec context unavailable`。
4. `code_exec` 走 code-mode 的 generation/execution 綁定，child 沒有自己的 managed execution attachment → `GENERATION_STALE`。
5. read/write/list 等 fs 工具不經過 scoped exec，所以正常。

參考實作：Codex 每個 thread 有自己的 session/config/rollout，工具與 sandbox 在該 thread 內建立；opencode 每個 session 有自己的服務實例。兩者都不會把父層的 execution binding 直接複製給 child。

## 需要的分層改動

### L1. Coordinator 暴露 child execution attachment（前置）

- 目標：給定 child session id，取得 `{ execution: ManagedExecutionAttachment, domain, recipient }`，或等價的 `openChildExecution(childSessionId)`。
- 現況：這些只存在 coordinator 內部的 WeakMap（`originalManagedExecution(document, ownership)` 需要 coordinator 的 `ownership`），subagent 拿不到。
- 改動：`SessionCoordinator` 新增方法（僅 host 可用、不在 model surface）：
  - `childExecutionFor(sessionId): Promise<ChildExecutionHost>`，回傳 private exec 所需的 attachment/domain/recipient（recipient 由 `receivedExecutionInputsFor` 建立）。
  - 生命週期：與 child document 綁定，child 關閉即 release。
- 驗收：單元測試建立 parent+child，取得 child execution 並 assert domain.sessionId = child。

### L2. Session-executor 提供 child shell factory

- `registerSubagent` 的 opts 增加 `childShellFactory?(input: { childCtx; childRegistry; childSession; factOwner; sessionId })`。
- 實作：用 `createScopedPrivateExecWithReservation(pair, workspace, policy, childExecution.execution, childExecution.domain, childCtx, childExecution.recipient)` 建 child 專屬 scoped exec，再 `createShellTools` 註冊到 child registry。
- child 的 approval/authority：child ctx 繼承父 scope 的審批服務；private exec 的 delivery owner 以 child session 為 target。

### L3. Subagent 的 role tools 不再複製 shell

- `resolveRoleTools` 對 shell-family（`bash`、`shell`、`pwsh`、`code_exec`）改為：
  - 若 host 提供 `childShellFactory` → 由 factory 重建，不複製父物件；
  - 若沒有 → 回報 missing 並在 diagnostic 說明「此 host 不支援 child exec」，**不要**註冊無法運作的父物件。
- 驗收：child 可執行 `bash -c "echo hi"`，且結果出現在 child session；無 factory 時 child schema 不出現 shell，spawn 仍成功。

### L4. code-mode

- `code_exec` 需要 child 的 generation lifecycle（`opts.generationFactoryFor` 已有）；改為以 child session 建立 code-mode runtime，而不是繼承父 mount。此層可獨立排程。

## 過渡（L1/L2 未完成前）

- 不再讓 child 拿到會拋 `Original scoped Exec context unavailable` 的父 shell 物件：`resolveRoleTools` 略過 shell-family 並在 diagnostic 標明不可用（模型不會嘗試，錯誤不再誤導）。
- 已在 `docs/design/2026-11-04-design-deviation-audit.md` D-03 記錄為設計偏離。

## 風險

- child private exec 會改變 approval/結果的歸屬；必須確保 delivery owner 綁 child session，不能落到 parent。
- 舊 session（無 child execution attachment）要 fallback 為「不可用」，不能半開。
- 需要 regression：child shell 成功、parent 不受污染、並行 child 各自 exec、child 關閉後 lease 釋放。
