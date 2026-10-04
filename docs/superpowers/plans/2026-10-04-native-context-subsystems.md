# IH native Context Mode and Code Context implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver native Context Mode and Code Context services with actual Agent/Code Mode integration and independently controlled Desktop settings.

**Architecture:** Two focused packages own output artifacts and source indexing. Host admission, settings and assembly connect their typed services to existing broker paths. Local SQLite is the index baseline; hybrid uses optional explicitly configured embeddings and local vectors.

**Tech Stack:** TypeScript, Node >=22.18, node:sqlite, existing TypeScript parser, React, Vitest, Electron.

**Spec:** `docs/superpowers/specs/2026-10-04-native-context-subsystems-design.md` plus the two accepted subsystem proposals and local source audit.

## Global Constraints

- Work only in `D:/frontend-test`, branch `codex/desktop-workbench`, baseline `5719dd718ab5aa29363a398cb5fbca59d5924039`.
- Preserve `packages/desktop/electron.vite.config.ts` byte for byte; never stage it. Original checkout, reference projects, reports, real sessions/settings/credentials remain read-only.
- Page label「上下文與檢索」; section labels **Context Mode** and **Code Context**; visible design attribution to context-mode and claude-context respectively.
- Both services default off. Model arguments cannot grant session/workspace/source authority. Normal execution and Code Mode share the existing broker; retrieved text keeps source-material trust.
- Default Context limits: preview 16 KiB; capture 8 MiB/result; read 32 KiB; serialized search 16 KiB; disk 512 MiB/workspace; seven-day retention.
- Default Code limits: 20,000 files; 1 MiB/file; 128 MiB/job; 50,000 chunks; 4 KiB/chunk; disk 512 MiB/workspace; search 16 KiB serialized; 60-second deadline.
- External references receive zero writes. Internal data belongs under the host storage root. No mandatory server, embedding, cloud provisioning or copied context-mode implementation.
- Disable, clear and close differ. Cancellation waits for owned I/O/provider/index work; late completion is fenced. Preserve committed generations and owner/lineage visibility.
- Tests prove production behavior with real owned SQLite/files and controlled transport where needed; no live credentials/providers or user data. Root serializes final full gates.
- Implementer agents do not spawn agents or edit another task's files. Package operations/commits and integration remain sequential; Root may do disjoint integration while a package worker implements.

## Shared interface decisions

The following public signatures are the integration contract. Extra private helpers may be factored into focused source files. Report any necessary public signature change before making it.

```ts
// packages/context-output/src/index.ts
export interface ContextOutputConfig {
  enabled: boolean; maxPreviewBytes: number; maxCaptureBytes: number;
  maxReadBytes: number; maxSearchBytes: number; maxDiskBytes: number; retentionDays: number;
}
export interface ContextAccess { sessionId: string; signal?: AbortSignal }
export interface ContextCapture {
  sessionId: string; callId: string; label: string; text: string; complete: boolean;
  source?: { sourceId: string; path?: string; revision?: string; readonly?: boolean };
}
export interface ContextResultRef {
  id: string; workspaceId: string; sessionId: string; callId: string; label: string;
  revision: string; bytes: number; originalBytes: number; complete: boolean; expiresAt: number;
}
export interface ContextOutputStatus {
  enabled: boolean; state: 'disabled'|'ready'|'stopping'|'error'; config: ContextOutputConfig;
  retainedBytes: number; results: number; activeJobs: number; error?: string;
}
export interface ContextReadResult {
  ref: ContextResultRef; text: string; offset: number; nextOffset: number|null; eof: boolean;
}
export interface ContextSearchResult {
  hits: { ref: ContextResultRef; text: string; offset: number; endOffset: number }[];
  partial: boolean; reasons: string[];
}
export interface ContextOutputService {
  configure(patch: Partial<ContextOutputConfig>): Promise<ContextOutputStatus>;
  status(): ContextOutputStatus;
  capture(input: ContextCapture, signal?: AbortSignal,
    producer?: (access: {maxBytes:number; signal:AbortSignal}) => Promise<{text:string; complete:boolean; originalBytes?:number}>
  ): Promise<ContextResultRef|undefined>;
  read(access: ContextAccess, query: { refId: string; offset?: number; maxBytes?: number }): Promise<ContextReadResult>;
  search(access: ContextAccess, query: { query: string; refIds?: string[]; limit?: number; maxBytes?: number }): Promise<ContextSearchResult>;
  grant(access: ContextAccess, refIds: string[], targetSessionId: string): Promise<void>;
  clear(sessionId?: string): Promise<ContextOutputStatus>;
  close(): Promise<void>;
}
export function createContextOutputService(options: {
  root: string; workspaceId: string; config?: Partial<ContextOutputConfig>;
  authorize?: (access: ContextAccess, ref: ContextResultRef) => boolean|Promise<boolean>;
}): ContextOutputService;
export function createContextOutputTools(service: ContextOutputService): import('@i-harness/core-tools').Tool[];
export function renderContextRecovery(refs: readonly ContextResultRef[], maxBytes?: number): string;

// packages/code-retrieval/src/index.ts
export interface CodeEmbeddingConfig {
  provider: 'openai-compatible'|'ollama'; endpoint: string; model: string;
  credentialRef?: string; dimensions?: number;
}
export interface CodeRetrievalConfig {
  enabled: boolean; mode: 'lexical'|'hybrid'; autoRefresh: boolean;
  maxFiles: number; maxFileBytes: number; maxInputBytes: number; maxChunks: number;
  maxDiskBytes: number; maxSearchBytes: number; deadlineMs: number;
  ignorePatterns: string[]; embedding?: CodeEmbeddingConfig;
}
export interface CodeAccess { sessionId: string; signal?: AbortSignal }
export interface CodeFileSnapshot {
  sourceId: string; path: string; revision: string; text: string; complete: boolean;
}
export interface CodeHit {
  sourceId: string; path: string; revision: string; generation: number; text: string;
  startLine: number; endLine: number; startOffset: number; endOffset: number; score: number;
}
export interface CodeRetrievalStatus {
  enabled: boolean; state: 'disabled'|'unindexed'|'indexing'|'ready'|'stopping'|'error';
  config: CodeRetrievalConfig; generation: number; files: number; chunks: number;
  storedBytes: number; activeJobs: number; jobId?: string; progress?: { files: number; bytes: number };
  partial: boolean; reasons: string[]; error?: string;
}
export interface CodeSearchResult { hits: CodeHit[]; mode: 'lexical'|'hybrid'; partial: boolean; reasons: string[]; generation: number }
export interface CodeSnapshotReader {
  snapshots(access: CodeAccess, options: { sourceIds?: string[]; config: CodeRetrievalConfig }): AsyncIterable<CodeFileSnapshot>;
  revalidate(access: CodeAccess, hit: CodeHit): Promise<boolean>;
  status?(): { partial: boolean; reasons: string[] };
}
export interface CodeRetrievalService {
  configure(patch: Partial<CodeRetrievalConfig>): Promise<CodeRetrievalStatus>;
  status(): CodeRetrievalStatus;
  startIndex(access: CodeAccess, options?: { sourceIds?: string[]; force?: boolean }): Promise<{ jobId: string }>;
  wait(jobId: string): Promise<CodeRetrievalStatus>;
  search(access: CodeAccess, query: { query: string; sourceIds?: string[]; pathPrefix?: string; limit?: number; maxBytes?: number }): Promise<CodeSearchResult>;
  cancel(): Promise<CodeRetrievalStatus>;
  clear(): Promise<CodeRetrievalStatus>;
  close(): Promise<void>;
}
export function createCodeRetrievalService(options: {
  root: string; workspaceId: string; reader: CodeSnapshotReader; config?: Partial<CodeRetrievalConfig>;
  resolveCredential?: (ref: string) => string|undefined;
  fetch?: typeof globalThis.fetch;
}): CodeRetrievalService;
export function createCodeRetrievalTools(service: CodeRetrievalService): import('@i-harness/core-tools').Tool[];
```

### Task 1: Context Mode package and meaningful persistence tests

**Files:** Create `packages/context-output/{package.json,tsconfig.json,src/index.ts,src/types.ts,src/config.ts,src/store.ts,src/service.ts,src/tools.ts,src/recovery.ts,test/service.test.ts}`. Additional focused chunk/budget helpers belong in this package. Do not edit existing packages; Root owns assembly and existing search projection.

**Interfaces:** Produce the Context signatures above. Consume Node SQLite and `@i-harness/core-tools`. Lazy construction creates no store when disabled. Opaque IDs bind workspace/session/call and immutable SHA256 text. Capture prefix at quota with complete=false; use byte-safe exact windows. Search results are full-envelope bounded and authorization checked per hit. Keep immutable artifacts authoritative and index rebuildable.

- [ ] Write RED tests against the public factory. The first meaningful case is:

```ts
const service = createContextOutputService({ root: ownedTempRoot, workspaceId: 'w', config: { enabled: true } });
const one = await service.capture({ sessionId: 'a', callId: '1', label: 'same', text: 'first middle error', complete: true });
const two = await service.capture({ sessionId: 'a', callId: '2', label: 'same', text: 'second output', complete: true });
expect(one!.id).not.toBe(two!.id);
expect((await service.read({sessionId:'a'}, {refId:one!.id})).text).toBe('first middle error');
await expect(service.read({sessionId:'b'}, {refId:one!.id})).rejects.toThrow();
```

Also cover real restart, lower capture quota, expired results, CJK/emoji cursor boundaries, search middle hits, byte budgets including metadata, independent session clear, explicit authorize for fork visibility, disabled zero writes, held capture/query drainage and close persistence. `grant` is a host API, not a model tool: grant only refs readable by source access, durably add target ownership, and preserve a granted blob when the original owner is cleared. Record RED command/output in the task report.
The optional capture producer is also host-only: trusted exec/shell object identities supply bounded readers of immutable producer-owned spill snapshots. Invoke it inside the service's owned capture job so disable, clear and close abort and drain it. Arbitrary returned path fields never authorize native reads.
- [ ] Implement the public contracts using a lazy owned SQLite/blob root, immutable records, transactionally derived lexical chunks, serial mutations and AbortController job ownership. Assert caller identity; ref lookup never resolves an arbitrary path. Stop admission before cancellation/drain; retain data on disable/close. Private storage is not a source write root.
- [ ] Register stable deferred `context_output_search`, `context_output_read`, `context_output_status` tools. ToolExec supplies session/signal; tool args cannot choose owner. Read operations are read-only and concurrency safe. Render recovery as bounded IDs/metadata, never raw captured prose or instructions.
- [ ] Run complete package Vitest/typecheck once, self-review, commit only owned paths. Write report with RED/GREEN evidence, exact signatures, storage/lifecycle and limitations.

### Task 2: Code Context package, local index and optional hybrid

**Files:** Create `packages/code-retrieval/{package.json,tsconfig.json,src/index.ts,src/types.ts,src/config.ts,src/chunker.ts,src/store.ts,src/service.ts,src/embedding.ts,src/tools.ts,test/service.test.ts,test/embedding.test.ts}`. Focused helpers allowed in this package. Do not edit host readers/settings/UI.

**Interfaces:** Produce the Code signatures above. Reader supplies all source bytes and authority; the package never opens source paths. Local SQLite holds lexical chunks and vectors. Store schema/generation/model identity invalidates cache. Revalidate every returned candidate against current host authority and revision.

- [ ] Write RED tests with admitted in-memory snapshots and a real owned SQLite root:

```ts
const service = createCodeRetrievalService({root:ownedTempRoot,workspaceId:'w',reader,config:{enabled:true}});
const {jobId} = await service.startIndex({sessionId:'s'});
await service.wait(jobId);
const result = await service.search({sessionId:'s'}, {query:'approveDeployment',pathPrefix:'src/auth'});
expect(result.hits.map(hit=>hit.path)).toEqual(['src/auth/approval.ts']);
expect(result.hits[0]!.text).toContain('approveDeployment');
```

Cover changed/deleted snapshots, failed embedding/write leaves old generation and retries, clear/force/disable with held reader/provider, late completion fencing, restart, source/subdirectory restriction, revalidation suppression, non-contiguous AST data, Chinese/identifier recall, metadata budget, quotas and exact range equality to the admitted snapshot. Provider tests use local controlled HTTP/fetch response bodies and demonstrate cancellation, finite/dimension validation and content/model cache invalidation.
- [ ] Implement byte-bounded contiguous chunks; use existing TypeScript AST for TS/JS when useful, explicit line-window fallback elsewhere. Enforce all job quotas and serialized envelopes. Commit only complete staged generations; truthful partial/reason fields survive caps. After snapshot iteration include optional reader.status() reasons for traversal/ignore/read limits, so omissions cannot look complete. Record durable counts, not attempted counts.
- [ ] Implement OpenAI-compatible `/embeddings` and Ollama `/api/embed` with explicit endpoint/model, credential resolver, abort/deadline/batch/response bounds and no implicit cloud action. Cache successful chunk embeddings by complete identity; local cosine plus lexical ranking yields hybrid results. Lexical mode never calls embedding. No mandatory new native dependency.
- [ ] Register stable deferred `code_context_search`, `code_context_index`, `code_context_status` tools, using ToolExec identity. Index mutates internal storage and is not read-only/concurrency safe; search/status are read-only. Clearing is a human control API.
- [ ] Run complete package tests/typecheck, self-review and commit only package paths. Report RED/GREEN, API, generation and provider evidence.

### Task 3: Settings schema, controller contracts and Desktop page

**Files:** Modify `packages/settings/src/index.ts` plus settings tests; create `packages/desktop-gateway/src/context-subsystems.ts` and tests; create `packages/desktop/src/renderer/settings/ContextSubsystemSettings.tsx` and UI tests; modify `SettingsPane.tsx`, `design/i18n.ts`. Root owns host/router/types/bridge/native dispatcher integration and package manifests/lock links.

**Interfaces:** Export from settings `SettingsContextSubsystems`, `normalizeContextSubsystems`, with `contextOutput`, `codeRetrieval`, `references: {id:string;path:string;label:string}[]`, and `workspaceOverrides: Record<string,{contextOutput?:Partial<ContextOutputConfig>;codeRetrieval?:Partial<CodeRetrievalConfig>;references?:...}>`. Use structural types matching package configs; settings must not depend on new runtime packages. Key overrides by host-provided workspaceKey, not user labels. Controller export `createContextSubsystemSettings({settingsPath,workspaceKey,workspaceId,contextOutput,codeRetrieval,onReferencesChanged})` with `state()`, `configure({scope:'global'|'workspace',contextOutput?,codeRetrieval?,references?,resetOverride?})`, `action({target:'context'|'code',action:'clear'|'update'|'rebuild'|'cancel',sessionId?})`, `sync()`. State carries `workspaceId`, `workspaceKey`, `source:'global'|'workspace'`, `saved:{contextOutput,codeRetrieval,references}`, `context:ContextOutputStatus`, `code:CodeRetrievalStatus`. Controller commits settings through `withDesktopSettings`, then awaits effective configure/drain; invalid patches reject and state shows saved/effective discrepancy if application fails.

- [ ] Write meaningful RED normalization/controller tests for both-off old files, full configs, workspace overrides, invalid/unknown fields, lease-preserving saves, disable drainage, secret-free settings and reference updates. UI test a user toggle, failure and reload; assert visible scope/status and branding.
- [ ] Implement normalized defaults/bounds and strict controller validation. Reference paths are explicit human inputs; no implicit defaults outside selected workspace. `action` supplies actual tool identity only from controller/session; no arbitrary model grants. Keep controller factory free of hidden global service creation.
- [ ] Add the「上下文與檢索」section gated by `desktop-context-subsystems` capability. UI talks through `bridge.request` kinds `desktop/context-subsystems/state`, `desktop/context-subsystems/configure`, `desktop/context-subsystems/action`, all carrying workspaceId. Section headers Context Mode and Code Context, with visible「設計參考 context-mode」and「設計參考 claude-context」. Include independent switches, scope selector, meaningful limits, reference editing, index progress and explicit clear/rebuild/cancel. Embedding provider, endpoint, model and credential reference are subordinate to hybrid selection; explain transmitted code and local index storage.
- [ ] Verify settings/controller/renderer tests and typechecks, self-review and commit owned paths. Cross-task type errors from unmounted Root integration are reported with exact diagnostics, not ignored.

### Task 4: Root host, reader, Agent/Code Mode and five-protocol integration

**Files:** Root owns `desktop-gateway/src/{host.ts,types.ts,router.ts,context-source-reader.ts,context-runtime.ts}` and tests; `desktop/src/{shared/bridge.ts,main/context-requests.ts}`; package dependency manifests/lock; `session-executor/src/{assembly.ts,service.ts}` and tests; `core-session/src/index.ts` plus projection tests; `subagent/src/roles.ts` and role tests if new read tools need role visibility; output-retention/Code Mode source only for concrete producer integration.

- [ ] Write RED producer/search/projection tests. Core-session `deriveSearchText` must find actual code call/result/output text and exclude image/binary data. Native capture tests obtain a real context ref from a direct tool and Code Mode path, then read/search it through the same broker after compaction/restart. Provider fixture requests preserve valid tool call/result association across Responses, Chat, Anthropic Messages, Gemini and Bedrock Converse.
- [ ] Build pinned snapshot reader with `createPinnedProjectContentReader` for selected workspace plus explicit read-only sources. Hash the admitted snapshot, enforce configured quotas/ignore/extension rules, revalidate current scope/root/descriptor/revision at result admission. Resolve credentials only by configured reference through `createCredentialStore`; no secret values in UI diagnostics.
- [ ] Compose services under the gateway sessionDir/native-context root, pass ToolExec/session authority, enable synchronization through existing settings sync and await close. Model tools and child bindings use common services and broker. Capture before existing preview loss where possible; respect earlier producer caps and mark incomplete otherwise. Preserve typed failures/exit codes/media and avoid changing authorized nested execution into a second executor.
- [ ] Use opaque refs plus bounded previews in model-facing long results. Existing saved event protocol remains compatible, with additive reference metadata. Recovery rendering only uses actually visible event refs and remains stable when state is unchanged. Fork visibility comes from actual retained event/lineage ownership, not newest-session inference.
- [ ] Wire typed bridge/validated native request dispatcher/router/capability to Task 3. Reuse settings lease, source the current workspace identity, handle update/rebuild/cancel/clear and show effective state after drainage. No source files are written by indexing.
- [ ] Run focused integration suites and typechecks; independently review this Root diff after all workers are idle. Commit only intended files, excluding protected config.

### Task 5: Full review, verification and local delivery

- [ ] Collect per-task spec/quality verdicts, resolve concrete findings with scoped tests and a bounded fix loop. Run one final broad branch review on the complete implementation.
- [ ] With all worker tests/builds idle, run `pnpm verify:all`, inspect every package/type/E2E/reachability outcome and fix actual regressions. Do not change gates/allowlists/timeouts to obtain a pass.
- [ ] Build Desktop, create a fresh owned portable build and test the copied backend with isolated fixture storage. Verify native settings capabilities, off-state zero work, both-on tool discovery, actual output retrieval/index query, shutdown and packaged source parity. Keep latest Desktop release only; preserve user files.
- [ ] Update product docs and acceptance report with behavior, limits, metrics and tested boundaries. Preserve compilation/test evidence, locally commit source/docs and present reviewable delivery. Shared GitHub publication is not inferred from this implementation authorization.
