# MiMo-Code 0.1.14 的 fork delta（唯讀走查）

日期：2026-09-09 · 方式：唯讀（`D:\agent-complete\MiMo-Code-0.1.14` 未執行、未安裝、未建置；與 `D:\agent-complete\opencode-1.18.30`、`opencode-1.18.15`、`opencode-1.18.18` 對照）
前置報告：`docs/research/2026-09-09-opencode-tui-graft-feasibility.md`（以下簡稱 baseline）
問題：MiMo-Code 是 opencode 的 fork 嗎？他們改了哪一層、各改多少？server↔TUI 邊界還在嗎？這對 `tui-beta-1` 的 fork 構想證明／不證明什麼？

---

## 一頁結論

**1. 是 fork，而且是「保留 opencode 全部核心、只做加法」的 fork。**
`README.md:527-529` 自己寫明：「MiMoCode is built as a fork of [OpenCode](https://github.com/anomalyco/opencode). It keeps all core OpenCode capabilities (multiple providers, TUI, LSP, MCP, plugins)…」；`LICENSE:3-4` 同時保留 `Copyright (c) 2025 opencode` 並加上 `Copyright (c) 2026 MiMo Code, Xiaomi Corporation`；根 `package.json:3` 甚至還叫 `"name": "opencode"`、`:105-108` 的 repository 還指向 `github.com/anomalyco/opencode`。沒有 `.git`，無法指名 base commit；由結構推斷 fork 點落在 **opencode 1.15.13–1.18.0 之間**（見 lineage 節）。

**2. delta 的形狀是：rebrand（全層）＋ provider 加值（加）＋ agent core 新子系統（加）＋ TUI 加值（加）＋ runtime 補 Node 逃生口（加）。沒有任何一層是「換掉 opencode 的協定或重寫核心」。**
- 核心本體 `packages/opencode/src`：141,012 行 / 674 檔（上游 1.18.30 的 `packages/opencode/src` 81,202 ＋ `packages/core/src` 32,974 ＋ `packages/server/src` 1,682 ≈ 115.9k，見 baseline §6.1）。新增子系統 workflow 2,929、actor 2,445、llm-server 2,221、cron 1,256、history 712、task 596、inbox 574、memory 498 等，合計約 **11.6k 行**；opencode 的 session/tool/permission/question/agent 結構原樣保留。
- TUI：33,526 行 / 199 檔，位置在 `packages/opencode/src/cli/cmd/tui/`（上游 1.18.30 是獨立套件 `packages/tui/src`，27,044 行 / 152 檔）。無上游同名檔案的 TUI 檔合計 12,229 行；扣掉被搬移／改名的上游檔（`win32.ts` 與上游 `terminal-win32.ts` **逐字相同**、`thread.ts`←`cli/cmd/tui.ts`、`worker.ts`、`attach.ts`、`plugin/api.tsx` 等）後，真正 MiMo 新增的 TUI 內容約 **10k 行**，其中 i18n 七語系 4,399 行、語音堆疊（voice/vad/sound/voice-edit）1,066 行。

**3. server↔TUI 邊界：完全沒動。**
TUI 仍用 `@mimo-ai/sdk/v2` 的 `createOpencodeClient`（原 `@opencode-ai/sdk/v2`，只改 scope），仍吃 opencode 的 HTTP＋SSE 與 `/global/event` 信封，仍由 `TuiInput` 注入 `fetch`/`events`。最強證據是 `thread.ts:326-336`：in-process 模式仍把 TUI 指向 **`http://opencode.internal`**，用 RPC 把 fetch 代理進 `worker.ts:49-70` 的 `Server.Default().app.fetch(request)`——TUI 講的就是 opencode 的 Hono server，一字未改。他們**沒有**把 TUI 改成對接別的協定。

**4. 對 `tui-beta-1` 的意義：這是最弱的 fork 證據類型，不是最強的。**
最強證據會是「換掉 server、保留 TUI」；MiMo 是「**兩邊都保留、兩邊都加值**」。它證明了 (a) fetch/events 注入縫隙是真的、可長期存活（`context/sdk.tsx` 對上游 1.18.30 只有 61 行 diff）；(b) 大量功能可以在不改縫隙的前提下長進 TUI。它**不證明**換一個外來 agent core 的成本——因為 MiMo 從未做過那件事：他們的 TUI 是對著自家 server 產生的型別編譯的（`packages/sdk/js/script/build.ts` 用 hey-api 從自家 openapi.json 生成），沒有版本協商、沒有 adapter 層。

**建議：維持 baseline 的結論（選項 C：選擇性吸收，不做全量移植）。** 若仍要評估 fork TUI，MiMo 提供的可複用資產是**接縫設計與 attach 模式**（一份 TUI、兩種 transport），而不是「他們證明了換 backend 可行」——他們沒有證明這件事。

---

## 2. Lineage 證據

| 證據 | 內容 | 位置 |
|---|---|---|
| 自述 | 「MiMoCode is built as a fork of OpenCode. It keeps all core OpenCode capabilities…」 | `README.md:527-529`；中文版 `README.zh.md:508-510` |
| LICENSE | MIT，雙著作權：`Copyright (c) 2026 MiMo Code, Xiaomi Corporation` ＋ `Copyright (c) 2025 opencode` | `LICENSE:1-4` |
| 上游 LICENSE 對照 | 上游只有 `Copyright (c) 2025 opencode`（其餘逐字相同） | `opencode-1.18.30/LICENSE:1-3` |
| 根 manifest 未改乾淨 | `"name": "opencode"`、`"repository": { "url": "https://github.com/anomalyco/opencode" }`、但依賴已是 `@mimo-ai/plugin|script|sdk` workspace | `package.json:3, 99-101, 105-108` |
| 套件改名 | `packages/opencode/package.json:3-4` → `@mimo-ai/cli` `0.1.14`、bin `mimo`；`packages/plugin` → `@mimo-ai/plugin`，repository `github.com/XiaomiMiMo/MiMo-Code` | `packages/plugin/package.json:3, 11-13` |
| 產物仍署名 opencode | `packages/sdk/openapi.json:3-6`：`title: "opencode"`、`description: "opencode api"` | 同左 |
| 程式碼內殘留 | TUI 用 `createOpencodeClient`（`context/sdk.tsx:1`）；Worker 路徑常數 `OPENCODE_WORKER_PATH`（`thread.ts:23`）；host 常數 `http://opencode.internal`（`thread.ts:333`）；`OPENCODE_MIGRATIONS`（`src/storage/db.ts:19`）、`OPENCODE_SKILLS`（`src/skill/index.ts`）、`OPENCODE_CALLER`（`src/ide/index.ts`） | 同左 |
| 追蹤上游 PR | `docs/compose/reports/*` 引用上游 `anomalyco/opencode` PR #4062、#19483 | `docs/compose/reports/align-last-step-handling.md:39, 56` |

**Base 版本推斷（明確標記為 inference，離線無法指名 commit）：**
- 上界：**早於 1.18.15**。本地最舊的上游副本 `opencode-1.18.15` 已經把 TUI 拆成獨立套件 `@opencode-ai/tui`（`packages/tui/package.json:3`），`packages/opencode/src/cli/tui/` 只剩 `worker.ts`/`layer.ts`/`validate-session.ts`；MiMo 仍保有**整個 TUI 在 `packages/opencode/src/cli/cmd/tui/`**，且 `tsconfig.json` 用 `"@tui/*": ["./src/cli/cmd/tui/*"]`。1.18.18、1.18.30 亦然。
- 下界：TUI 已使用 v2 SDK client（`@mimo-ai/sdk/v2`）、`/global/event` 的 `GlobalEvent` 信封、experimental workspaces（`flag.ts:396`）、`sdk.sync.start()`（`context/sdk.tsx:93`）——這些是 1.18.x 世代的功能。
- 旁證：`bun.lock:1550-1552` 解析出 `@opencode-ai/plugin@1.15.13` ＋ `@opencode-ai/sdk@1.15.13`（由 `@gitlab/opencode-gitlab-auth@1.3.3` 的 `"@opencode-ai/plugin": "*"` 傳入），可視為安裝時的快照提示；MiMo 的 `@opentui/core` 仍是 **0.1.101**，而上游 1.18.15 已是 **0.4.5**。
- 綜合：fork 點約在 **opencode 1.15.13–1.18.0**，無法更精確。這對結論無影響（接縫與 server 形狀的判斷不依賴精確 base）。

---

## 3. Delta 表（依層）

| 層 | 檔案 / 量體 | additive vs rewrite | 證據 |
|---|---|---|---|
| **品牌 / 設定** | 全 repo 的 scope 改名 `@opencode-ai/*` → `@mimo-ai/*`（plugin/script/sdk/ui/shared）；env `MIMOCODE_*`（flag.ts 數十個）；設定路徑 `~/.config/mimocode`、`.mimocode/`、`MIMOCODE_HOME`；TUI 品牌資產：`component/logo.tsx` 61→988 行、`starry-background.tsx` 322、`background-image.tsx` 159、`dialog-mimo-login.tsx` 258、`dialog-go-upsell.tsx` 157、`theme/mimocode.json`；i18n 七語系 4,399 行 | **改寫（機械式、但未完成）** | `flag.ts:37, 307-351, 394-396`；`context/theme/`；`i18n/{en,es,fr,ja,ru,zh,zht}.ts`；ts/tsx 中 `mimo` 出現 3,823 行 vs `opencode` 殘留 3,545 行 |
| **Provider / model** | `src/provider/` 10,405 行；新增 `xiaomi`/`mimo` provider id 與 MiMo gateway 錯誤映射、MiMo Router 標頭；TUI 加 MiMo 登入／方案對話框；新增依賴（如 `@hono/node-server`、`pinyin-pro`、`jpeg-js`、`cli-sound`） | **additive**（opencode 的 provider 註冊表原樣保留） | `provider/provider.ts:330, 1123`；`provider/error.ts:166-181`；`component/dialog-mimo-login.tsx`；README「Xiaomi MiMo Platform / Codex / Import from Claude Code」 |
| **Agent core** | `packages/opencode/src` 141,012 行 / 674 檔；**新子系統**：workflow 2,929、actor 2,445、llm-server 2,221、cron 1,256、history 712、task 596、inbox 574、memory 498、metrics 197、team 166（≈11.6k 行）；**保留**：session 20,906（`message-v2.ts:442-504` 的 `Part`/`ToolPart` 模型）、tool 13,978、permission 1,104、question 269、agent 750 | **additive**（不是換核心；新增子系統接在 opencode 的 bus/session/tool 上） | `src/{workflow,actor,llm-server,cron,task,inbox,memory,team}/`；`session/message-v2.ts:442-504`；`agent/agent.ts:134-173`（build/plan/compose agents） |
| **TUI** | 33,526 行 / 199 檔（上游 1.18.30 `packages/tui/src` 27,044 / 152）。無上游同名檔 12,229 行；扣除搬移/改名者後 MiMo 新增大約 10k 行。共享檔的成長集中在 `routes/session/index.tsx` +1,360、`context/theme.tsx` +981、`component/logo.tsx` +927、`context/sync.tsx` +411、`app.tsx` +377、`permission.tsx` +59。**接縫檔幾乎沒動**：`context/sdk.tsx` 對上游只有 61 行 diff | **additive**（功能與品牌），**非** backend 適配 | 檔案清單與行數見 §1；`context/sdk.tsx` diff；`thread.ts:326-336`；`worker.ts:49-70` |
| **Runtime / build** | Bun `1.3.14`、`@opentui/core|solid` **0.1.101**（對 minified bundle 打 patch）＋ `solid-js@1.9.10` patch ＋ 平台原生二進位；**額外補了 Node 逃生口**：`script/build-node.ts`、`src/node.ts`、`server/adapter.node.ts`、`storage/db.node.ts`、`pty/pty.node.ts`（package.json `imports` 的 `bun`/`node` 條件分流） | **additive**（沒有換掉 Bun；是加一層 Node 出口） | 根 `package.json:7`；`packages/opencode/bunfig.toml:1-2`；`patches/@opentui%2Fcore@0.1.101.patch`；`packages/opencode/package.json:31-49`；`AGENTS.md:25`；`script/build-node.ts:72` |

> 註：上游對照的「1.18.30」不是 MiMo 的真正 base（見 §2），因此共享檔的成長量同時混入上游漂移與 MiMo 改動；此表用於判斷**性質與量級**，不是精確 diff。

---

## 4. 邊界判定：保留，且可引用的三處程式碼

**判定：MiMo 沒有 fork TUI 去講別的協定。** server 仍是 opencode 的 Hono app、仍是同一組 HTTP 路由與 `/global/event` SSE 信封；TUI 仍由 `fetch`/`events` 注入驅動。

**(a) TUI 入口仍接受 `fetch`/`events` 注入（`packages/opencode/src/cli/cmd/tui/app.tsx:139-147`）：**
```ts
export function tui(input: {
  url: string
  ...
  fetch?: typeof fetch
  ...
  events?: EventSource
```
（與上游 `packages/tui/src/app.tsx:142-150` 的 `TuiInput` 同構。）

**(b) TUI 的資料層仍是 opencode SDK client（`context/sdk.tsx:1, 27-33, 85-105`）：**
```ts
import { createOpencodeClient } from "@mimo-ai/sdk/v2"
...
return createOpencodeClient({ baseUrl: props.url, signal: abort.signal, directory,
  fetch: props.fetch, headers: props.headers })
...
const events = await sdk.global.event({ signal: ctrl.signal, sseMaxRetryAttempts: 0 })
...
for await (const event of events.stream) { handleEvent(event) }
```

**(c) CLI 仍用同一條 Worker RPC 假 fetch（`thread.ts:28-54, 326-336`）：**
```ts
function createWorkerFetch(client: RpcClient): typeof fetch { ... client.call("fetch", {...}) ... }
function createEventSource(client: RpcClient): EventSource {
  return { subscribe: async (handler) => client.on<GlobalEvent>("global.event", (e) => handler(e)) }
}
...
const transport = external
  ? { url: (await client.call("server", network)).url, fetch: undefined, events: undefined }
  : { url: "http://opencode.internal", fetch: createWorkerFetch(client), events: createEventSource(client) }
```
`worker.ts:49-70` 那端把它接回真正的 server：
```ts
async fetch(input) { ... const response = await Server.Default().app.fetch(request) ... }
...
GlobalBus.on("event", (event) => { Rpc.emit("global.event", event) })
```
另外 `attach.ts:7-8` 提供 `mimo attach <url>`，同一 `tui()` 入口走真 HTTP＋SSE——**一份 TUI、兩種 transport**，正是 baseline 描述的 opencode 模式。

**他們是怎麼讓「不同 backend」工作的？答案：沒有不同 backend。** MiMo 的「backend 差異」只是自家 server 的同構延伸：新增 `/workflows` 等路由（`src/server/routes/instance/workflows.ts` 142 行）、重跑 `bun dev generate > openapi.json`、用 hey-api 生成 `packages/sdk/js/src/v2/gen`（`packages/sdk/js/script/build.ts:12-20`），TUI 直接吃新生成的 `sdk.client.workflow.*`（`context/sync.tsx:1057-1073`）。

---

## 5. 授權 / 姓名標示

| 項目 | 內容 | 位置 |
|---|---|---|
| 授權 | **純 MIT 條文**，雙著作權（Xiaomi 2026 ＋ opencode 2025） | `LICENSE:1-22` |
| 額外限制 | `USE_RESTRICTIONS.md`：合法使用、不得軍事用途、不得惡意網路活動、不得在無人監督下自主執行高風險動作等；README 明說「Use of MiMoCode is also subject to the Use Restrictions」 | `README.md:545-549`；`USE_RESTRICTIONS.md:1-19` |
| 商標 | README 同段聲明 MiMo 名稱/標誌/商標另有 Trademark Policy | `README.md:550` |
| NOTICE | 根目錄**沒有** NOTICE 檔；第三方授權以子目錄 LICENSE 形式存在 | `find` 結果 |
| 內含第三方 | 語音 VAD：`ten_vad.wasm`/`ten_vad_loader.js` 為 Apache-2.0（Agora ten-vad）；內建 skills bundle 多為 Apache-2.0（docx/pdf/pptx/xlsx/playwright/frontend-design 等）；`skill/compose/LICENSE-karpathy`、`LICENSE-superpowers` | `cli/cmd/tui/asset/TEN_VAD_LICENSE`；`skill/builtin/.bundle/*/LICENSE*` |

**若把 TUI 程式碼抄進 IH（MIT）意味什麼：**
1. **從上游 opencode 抄**：MIT 允許，只要在副本或實質部分保留著作權與許可聲明（`LICENSE:6-14` 的條件）。與 IH 的 MIT 相容。
2. **從 MiMo 抄**：MiMo 自寫部分名義上也是 MIT，但 README 把「Use Restrictions」連結為使用條件；那是一份**非 OSI** 的額外限制，且自稱約束「Xiaomi MiMoCode and any derivatives thereof」。抄 MiMo 自寫碼會把這個不確定性帶進 IH。**保守做法：只從上游 opencode 取碼，不要抄 MiMo 自寫檔**（i18n、voice/vad、logo/theme、dialog-mimo-*、workflow UI 等）。
3. **商標**：MiMo 名稱/標誌不得使用（我們本來也不會用），但這也意味著不能直接沿用 MiMo 的品牌資產。
4. **第三方**：若連 `asset/`、`skill/builtin/.bundle/` 一起搬，會引入 Apache-2.0 的 NOTICE 義務；只搬 TUI 程式碼可避開。

---

## 6. 對 `tui-beta-1` 的具體教訓

**值得學／可以複製的模式：**
1. **接縫紀律**：`tui(input: { url, fetch?, events? })` ＋ `SDKProvider` ＋ CLI 端 `createWorkerFetch`/`createEventSource`（`app.tsx:139-147`、`context/sdk.tsx:12-34`、`thread.ts:28-54`）。若 IH 要接 opencode TUI，可**不需要 HTTP**——直接注入 fetch/events 到 IH 的 in-process client（opencode 自己的 Worker RPC 就是這個做法）。MiMo 證明了這條縫隙能撐住約 10k 行 TUI 加值而不需修改。
2. **attach 模式**：一份 TUI、`--port/--hostname` 走真 HTTP、預設走 in-process（`thread.ts:318-336`、`attach.ts`）。若真要 fork，這是必留的設計。
3. **i18n 分層**：`context/language.tsx` ＋ `i18n/locales.ts` ＋ 各語系檔（4,399 行）是乾淨的 additive 模式，與 backend 無關，值得借鏡。
4. **TUI plugin 槽位**：`plugin/runtime.ts`(1,057) ＋ `plugin/api.tsx`(402) ＋ `context/plugin-keybinds.ts`，是比 baseline §4.1 所述上游版本更完整的插件 API。

**他們的 fork 暴露的坑（也是 IH fork 會踩的）：**
1. **TUI 對 server 是「編譯期綁死」**：TUI import 的型別來自 `@mimo-ai/sdk/v2`，而該 SDK 由 `bun dev generate` 從**自家 server 的 openapi.json** 生成（`packages/sdk/js/script/build.ts:12-20`）。沒有版本協商、沒有 capability 閘控。MiMo 不必面對這個問題（兩邊都是自己的）；IH 若保留 TUI，就必須生產 opencode 形狀的型別/路由，或 fork TUI 的資料層——**MiMo 沒有提供任何降低此成本的證據**。
2. **每個功能都是 server＋TUI 成對施工**：workflow/task/actors/memory 各自新增路由（`routes/instance/workflows.ts` 等）＋ 生成型別 ＋ TUI store（`sync.tsx` +411）＋ 對話框（`dialog-workflows.tsx`、`workflow-tree.tsx`）。這正是 baseline §6.2 估計「adapter 要重寫投影層」的同一種耦合。
3. **原生/補丁負擔**：`@opentui/core@0.1.101` 直接對 minified bundle 打 patch（`patches/@opentui%2Fcore@0.1.101.patch`），外加 `solid-js@1.9.10.patch` 與平台二進位。fork 之後這些補丁要自己維護。
4. **Bun-only 是硬約束**：MiMo 為了非 TUI 消費者另建 Node 出口（`script/build-node.ts`、`*.node.ts` adapters、`AGENTS.md:25`），TUI 本身仍走 Bun ＋ `@opentui/solid/preload`（`packages/opencode/bunfig.toml:1-2`）。想用 Node/tsx 跑 opencode TUI 不是換 import 就好。
5. **rebrand 永遠做不完**：根 `package.json` 還叫 `opencode`、repository 還指上游；ts/tsx 裡 `opencode` 殘留 3,545 行。預算要含這筆。
6. **他們放棄了其他介面**：`AGENTS.md:15`「Development focuses on the TUI … The Web, App and Desktop surfaces are not currently maintained.」fork 後維護面會集中到 TUI，這是 IH 要預期的組織成本。

---

## 7. 什麼會推翻本結論（我無法確定的部分）

- **精確 base commit**：無 `.git`、無網路，只能給出 1.15.13–1.18.0 的區間。若取得真正的 base tarball 逐檔 diff，MiMo 自寫行數會更準（目前 12,229 行含搬移/改名檔；已證實 `win32.ts` 與上游逐字相同）。
- **「他們其實換過 backend」的反例**：若發現 MiMo 有另一套非 opencode 的 server/協定實作（例如 Xiaomi cloud API 直連）而 TUI 走它，本報告的邊界結論就會被推翻。目前所有證據（`worker.ts` 的 `Server.Default().app.fetch`、`thread.ts` 的 `opencode.internal`、SDK 由自家 openapi 生成）都指向反面。
- **授權解讀**：若 `USE_RESTRICTIONS.md` 被認定為授權條款的一部分（而非附帶使用政策），MiMo 自寫碼就不是純 OSI MIT，抄進 IH 的風險高於本報告假設。這需要法務判斷，不是程式走查能定的。
- **TUI 縫隙的長期穩定性**：MiMo 證明它撐過一次大規模加值，但他們**同時擁有兩端**。當只有一端是別人的（IH 的 NDJSON/JSON-RPC 對上 opencode TUI 的 HTTP/SSE＋message/part 模型）時，這個縫隙是否還夠用，本 fork 沒有提供數據；baseline §6.2 的 6,200–12,600 行估計仍是目前唯一可用的量體。

---

## 附錄：一句話問答

- **是 fork 嗎？** 是，README/LICENSE/package.json 三處自證；無 git，base 約 1.15.13–1.18.0。
- **改了什麼？** 全層 rebrand ＋ provider 加值 ＋ 約 11.6k 行新 agent 子系統 ＋ 約 10k 行 TUI 加值 ＋ Node 建置出口；**沒有換核心、沒有換協定**。
- **邊界還在嗎？** 在。`http://opencode.internal` ＋ Worker RPC 假 fetch ＋ `createOpencodeClient`，一字未改其形。
- **對 tui-beta-1 證明什麼？** 證明「fork 後大幅加值而不動接縫」可行；**不證明**「換掉 agent core 而保留 TUI」可行。
- **授權？** MiMo 是 MIT（雙著作權）＋ 額外 Use Restrictions ＋ 商標政策；抄碼請從上游 opencode 取，保留其 MIT 聲明。
