# I-harness M24b 設計：Skills-as-Plugins + Workflows

> 2026-08-28。依 M20-M25 設計檔 §7.1①② + M24 研究（skills + workflows 兩份 doc）。M24a（resume 一致性 + nested delegation）已完成；M24b = 剩下的兩個新包。
> 決策產出於 2026-08-28 brainstorming 對話；依「吸收而非移植」原則。研究輸入：`2026-08-28-m24-skills-ai-research.md`、`2026-08-28-m24-workflows-ai-research.md`。

## 1. 目標與範圍

### 1.1 目標
- **skills-as-plugins**：deferred 檢索的可重用知識包（SKILL.md + skill_search/skill_get 工具）——agent 自行發現，不自動注入 catalog。
- **workflows**：靜態可重複的多步驟工作流（YAML 定義 + exec 背景執行 single job + workflow_run/workflow_list 工具）。

### 1.2 範圍（兩個新包，獨立）
- **① `@i-harness/skills`**：Skill Registry（workspace/global 掃描）+ skill_search/skill_get 工具（deferred 檢索）+ BM25 搜尋（重用 tool-search）。
- **② `@i-harness/workflow`**：Workflow Registry（`workflow/*.yml` 掃描）+ runWorkflow（in-process async loop, single background job）+ workflow_run/workflow_list 工具 + job_* 第三層整合。

### 1.3 明確不做（deferred）
- durable skill catalog（dsh digest 原地替換 + session event——M25+）。
- remote skills（URL source）、skill 可註冊工具（M25+ 插件化）。
- workflow DAG/並行/條件/迴圈/矩陣（YAGNI——三個參考皆無靜態先例）。
- worker-thread（dsh 是動態 JS；I-harness 用 exec background jobs）。
- settlement push、user slash 手勢注入（無 user-input 攔截面）。

## 2. 研究關鍵發現（輸入）

### 2.1 skills（`2026-08-28-m24-skills-ai-research.md`）
- 三方（codex/opencode/dsh）SKILL.md 格式一致：`<name>/SKILL.md` + front-matter（name/description 必填 + body）。
- codex：`name≤64`（缺省=目錄名）、description 必填單行化、掃描 depth=6/hidden-skip/entry caps/per-skill 錯誤收錯、BM25 catalog prompt 紀律。
- dsh：kebab name `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` + rank/layer 合併、`<skill_content>` render、durable catalog（digest 原地替換——M25+ 延後）。
- opencode：`skill` 工具 `{name}` + `<skill_content>` + base-directory 提示 + 目錄檔案清單取樣（MODEL_FILE_LIMIT=10 + "Note: file list is sampled"）。
- **零新依賴衝突（處置）**：dsh `yaml`/`chokidar`/cordis 私有庫禁用；codex serde_yaml/include_dir 不可用；opencode Effect/schema 不可用。**處置：front-matter 用通用 `yaml` 包（依使用者「通用套件可用、禁私有庫」裁定）；watcher 不做（rescan-per-access）**。
- 判決：codex 機制 ADOPT（簡化）；dsh name grammar + `<skill_content>` ADAPT；opencode skill 工具形 + files 取樣 ADAPT。

### 2.2 workflows（`2026-08-28-m24-workflows-ai-research.md`）
- **頭條（設計檔修正）**：dsh workflow **不是 YAML**——是 model-authored JS script + worker-thread 執行；dsh 把 saved/bundled registry 列為 deferred non-goal。**I-harness 的靜態 YAML workflow 是新空間**——dsh 只吸收「設計形狀」（meta 語彙/進度事件/失敗紀律/caps config）。
- 判決：meta 語彙 `name/description/whenToUse/phases` ADOPT（phases v0 可省）；phase/log 進度 ADAPT（headless 文本輸出）；observe-only snapshot 事件原則 ADOPT（v0 延後 session event 化）；caps 簡化（per-step timeout_ms + workflow 級）；失敗→非 completed→isError（絕不 partial-as-success）ADOPT;前景/背景反轉 ADAPT（I-harness 背景優先 + 可選 wait）；ralph DISCARD；durable session 記錄延後；"background 語義一次設計" ADOPT（job_output/job_list/job_kill 統一——**已是 I-harness 現實**）。
- **YAML 修正**：設計檔「dsh 用 YAML」錯誤；I-harness 用通用 `yaml` 包（完整 1.2）——不 hand-rolled（edge cases 靜默誤析=錯 command）。

## 3. 設計

### 3.1 skills-as-plugins（`@i-harness/skills`）

#### Skill 格式（SKILL.md）
```markdown
---
name: my-skill            # kebab /^[a-z0-9]+(?:-[a-z0-9]+)*$/，≤64; 缺省=目錄名
description: One line     # 必填（單行化）
---
# body after front-matter
```
（**front-matter 解析用通用 `yaml` 包**——完整 YAML 1.2；非自寫 line-oriented——依「通用套件可用」裁定；支援 scalar keys name/description only，巢狀/非 scalar → 壞檔 skip。）

#### 型別
```ts
export interface Skill {
  name: string; description: string; body: string; path: string; source: "workspace" | "global"
}
export interface SkillSummary { name: string; description: string; path: string; source: Skill["source"] }
export interface SkillRegistry {
  list(): SkillSummary[]                        // 合併 workspace 蓋 global；v0 每次 rescan
  getSkill(name: string): Promise<Skill | undefined>  // 顯式取 body；未知/非法 kebab → undefined
  searchSkills(query: string, opts?: { limit?: number }): SkillSummary[]  // 重用 tool-search search()
}
export function createSkillRegistry(deps?: { workspace?: string; globalDir?: string }): SkillRegistry
```

#### 掃描（簡化 codex 參數）
- `scanWorkspace(workspace)`：`<workspace>/skills/**/SKILL.md`（深度 ≤4、hidden dirs skip、per-skill 錯誤 warn+skip）。
- `scanGlobal()`：`~/.i-harness/skills/**/SKILL.md`（同）。
- 合併：workspace 蓋 global 同名；名稱排序。
- **v0 無 watcher**（rescan-per-access）。

#### 工具面（run.ts 在 registerToolSearch 旁掛）
- `skill_search {query, limit?}` —— deferred 檢索入口（isReadOnly; 回 `{query, matches: [{name, description, path, source}], totalSkills, usage}`）。
- `skill_get {name}` —— 注入（name required; kebab 驗證; 回 `{name, description, path, baseDir, files: string[] (≤10, sampled), body}`; 模型面 render `<skill_content name="…">` + base-directory 提示 + XML escaping; 未知 name → `SKILL_NOT_FOUND`）。

#### 錯誤面
`SkillToolError{code}` — `SKILL_INVALID_NAME` / `SKILL_INVALID_FRONTMATTER`（掃描 warn+skip；skill_get 顯式 fail）/ `SKILL_NOT_FOUND` — 訊息含 remedy。

#### 掛載
`skillsPlugin: Plugin`（name "skills"）— `mount(ctx)` → `ctx.services.register("skills", registry)`；run.ts `registerSkills(ctx, tools, { workspace })`。

### 3.2 workflows（`@i-harness/workflow`）

#### YAML 定義（`workflow/*.yml`，headless 最小子集）
```yaml
name: release-check            # kebab; 缺省=檔名 stem
description: Run build + tests  # 必填（fail-loud）
whenToUse: before cutting a release   # 可選
params:
  target: { description: build target, default: dev }   # 可選, ${param} 內插
steps:
  - name: build
    command: pnpm build --target ${target}
    timeout_ms: 300000
  - name: test
    command: pnpm test
    retry: { attempts: 2, backoff_ms: 1000 }
  - name: smoke
    command: pnpm smoke
    on_failure: continue      # 預設 stop
```

#### 型別（研究 §4.1）
```ts
export interface WorkflowStep {
  name: string; command: string; cwd?: string; env?: Record<string, string>
  timeout_ms?: number; retry?: { attempts: number; backoff_ms?: number }; on_failure?: "stop" | "continue"
}
export interface WorkflowDefinition {
  name: string; description: string; whenToUse?: string
  params?: Record<string, { description?: string; default?: string; required?: boolean }>
  steps: WorkflowStep[]
}
export interface WorkflowRegistry {
  list(): WorkflowDefinition[]; get(name: string): WorkflowDefinition | undefined; reload(): void
}
export function createWorkflowRegistry(deps: { workspace: string }): WorkflowRegistry
export function runWorkflow(def: WorkflowDefinition, params: Record<string, string>, exec: ExecService): { runId: string; jobId: string }
```

#### 執行（single background job）
- `runWorkflow`：in-process async loop → 逐 step `exec.run({ argv: shellArgv(command), cwd, env, timeoutMs, abortSignal })` → 整個 run 註冊為一個 background job（id `workflow-${n}`）。
- 進度：每 step 寫一行 `[step i/N <name>] started/ok/failed(exit=N)/skipped` 進 job 輸出流；step stdout 原樣跟隨。
- kill：run 級 `AbortController` → 當前 step 的 exec killTree。
- `on_failure: "stop"`（預設）→ step 失敗停；`"continue"` → 跳過/記 failed 繼續。
- retry：`attempts` 次重試（backoff_ms）。
- **job_* 第三層**：workflow 自建 workflow registry（jobId 前綴 `workflow-`）+ subagent 的 job_output/job_list/job_kill fallback 鏈認第三層「workflow/job」——job_* 已是 subagent→exec 雙層——**加第三層成本低**。

#### 工具面（run.ts 在 registerSubagent 旁掛）
- `workflow_run {name, params?, wait?}` —— wait 預設 false 回 `{run_id, job_id}` → model 用既有 `job_output(job_id, wait:true)` 收尾；wait=true 阻塞（短 workflow）。
- `workflow_list {}` —— isReadOnly（列 name/description/params/steps 數）。

### 3.3 job_* 整合
- subagent/src/tools.ts 的 job_output/job_list/job_kill：加「第三層 workflow」fallback——`workflow-` 前綴 → workflow registry（getOutput/listJobs/killJob）。

## 4. 接線（run.ts）

- `registerSkills(ctx, tools, { workspace: opts.workspace })` 在 registerToolSearch 旁（deferred 檢索族）。
- `registerWorkflow(ctx, tools, { workspace: opts.workspace, exec: execService })` 在 registerSubagent 旁。
- workflow registry 掃 `<workspace>/workflow/*.yml`。
- job_* 第三層（subagent tools）已定義。

## 5. 測試策略

### skills（skills.test.ts 全單元）
掃描：`<name>/SKILL.md` 正例/nested 深度上限/hidden 跳過/同名 workspace 蓋 global/名稱非 kebab/缺 description → skip + error 收集/entry cap。
front-matter：`---` 缺失/未閉合/CRLF、name 缺省取目錄名、description 空白正規化、非 scalar value → skip。
searchSkills：BM25 排序/`select:name` 精確/`+term` 必含/limit（8/20）/空 corpus。
skill_get：未知 name/非法 kebab/files 取樣 ≤10 排除 SKILL.md/`<skill_content>` escaping（description 含 `<`/`&`）。
掛載：plugin unmount 後 tools/服務回收（core-plugin reclaim）。

### workflow（workflow.test.ts 全單元）
YAML 解析：正例/缺 description fail-loud/kebab 驗證。
執行：step 順序/on_failure stop vs continue/retry 重試/timeout/params 內插。
single-job：jobId `workflow-N`/job_output 認 workflow-N/kill/進度行。

### integration（cli.test.ts 2 e2e）
(a) skill_search + skill_get 在真實 run 可用（setup workspace 放 sample SKILL.md）。
(b) workflow_run 用既有 job_output 收尾（setup workspace 放 sample workflow.yml）。

### 零破壞
subagent 73、agent-team 92、cli 51+1、全 `pnpm -r test` + `pnpm -r typecheck`。

## 6. 風險與取捨

- **yaml 包新依賴**（兩包都用——通用套件，依使用者裁定；純 JS，allowBuilds 不需改）。
- **skill 掃描 rescan-per-access**（v0 無 watcher——掃描成本低；bad skill warn+skip 不炸 registry）。
- **workflow job_* 第三層**——subagent tools 改（job_* fallback 多認一層）——純加法低風險。
- **參數內插信任**：`${param}` plain string substitution（trust 級同 bash 工具——document 明示）。
- **M24a 留的 M24b 項目**：driveFollowups log on updateJob false（M24b 順手補，若乾淨——否則 deferred）。

## 7. 歸屬（Attribution）

- skills：codex skills parser/root 模型（MIT, codex-rust-v0.149.1 `codex-rs/skills`）、dsh name grammar + `<skill_content>` render（MIT）、opencode skill 工具形 + files 取樣（MIT）。
- workflows：dsh meta 語彙/進度事件/失敗紀律（MIT, `packages/workflow/*`）。
- THIRD_PARTY_NOTICES 於 M24b 完成時補。

## 8. 交付檔清單

- `packages/skills/{package.json,tsconfig.json,src/{index,frontmatter,registry,search,tool}.ts,test/skills.test.ts}`
- `packages/workflow/{package.json,tsconfig.json,src/{index,definition,registry,runner,tool}.ts,test/workflow.test.ts}`
- `apps/cli/src/run.ts`（skills + workflow 接線）
- `packages/subagent/src/tools.ts`（job_* 第三層認 workflow-N）
- `THIRD_PARTY_NOTICES`（codex skills + dsh workflow）
- `pnpm install`（兩個新 workspace 包 + yaml dep）

## 9. 研究文件索引

- skills：`codex-rs/skills/src/{parser,model}.rs`、`ext/skills/src/{host_roots,host_prompt,catalog_prompt}.rs`、`loader/{discovery,host}.rs`；opencode `packages/core/src/{skill.ts,tool/skill.ts}`；dsh `packages/skill/{skill,tool-skill}/src/index.ts`；I-harness `packages/tool-search/src/search.ts`（BM25）、`core-tools`、`core-plugin` (services)、`naming.ts`。
- workflows：dsh `packages/workflow/{workflow,tool-workflow}/src/*`、`docs/subsystems/workflow.md`；I-harness `packages/exec/src/index.ts`（ExecService run/runBackground/getOutput/listJobs/killJob）、`packages/subagent/src/tools.ts`（job_output/job_list/job_kill fallback 鏈）、`packages/preset/src/index.ts`（JSON.parse fail-loud 先例——YAML 版）、`packages/shell/src/index.ts`（resolveShell/getArgv）。
