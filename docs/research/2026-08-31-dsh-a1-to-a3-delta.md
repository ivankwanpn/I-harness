# dsh 0.1.2-alpha.1 → alpha.3 版本增量研究

日期：2026-09-02（分析 2026-08-31；日期沿用事件日）· 方式：雙樹唯讀 diff（無 git——文件級 `comm/diff` + 逐包 src 比對 + 官方決策註記閱讀）

**樹**：`D:\agent-complete\deepseek-harness-dsh-v0.1.2-alpha.1`（a1，含舊 lib/ 構建產物——對比時排除）vs `D:\agent-complete\deepseek-harness-dsh-v0.1.2-alpha.3`（a3，無構建產物）。

## 0. 一句話結論

**收斂與淨化版——不是功能大爆炸**：四道主線（錯誤契約統一、投影體系統一、輔助工具集中化、SQLite 後端移除），無新能力面。I-harness 已吸收的 dsh 概念（interaction / guard / subagent / jobs / goal / schedule 域）在 a3 中 100% 零變動——**沒有「IH 落後 dsh 最新」的緊急項**。

## 1. 主線一：錯誤契約統一（RemoteError 體系）

- 新增 `typert/protocol/src/remote-error.ts`：`RemoteError<Code>`（code + message + typed details `RemoteErrorDetailsMap[Code]` + 結構性探測 `remoteErrorOf`，跨 realm 安全，never `instanceof`）
- `RemoteFailure` 變 **code-discriminated union**（`switch(error.code)` 可收窄 details）
- 舊類全滅：`TypertRemoteFailure` / `TypertLookupFailure` / `ClientResult` / `ClientFailure` / 各包自帶錯誤接口（`SessionErrorDetailsMap`、`WorkspaceErrorDetailsMap`、`AgentPresetErrorDetailsMap` 等）→ 全部改 `RemoteErrorDetailsMap` 模塊增強註冊
- 線上代碼命名空間化：`session/not-found`、`gateway/internal`、`gateway/bad-request`、`session/conflict`、`agent-preset/locked`、`subagent/not-found`、`workspace/name-conflict`…（gateway 17 個 infra 碼）
- 附帶：heartbeat **30s → 2s** + `MAX_MISSED_HEARTBEATS=2` 連失 pong → `terminate()`；新增 `$host { home, isLoopback }` 事實；`reconnect()+revision` 重構

## 2. 主線二：投影體系統一（最大架構事件）

- 所有 **ad-hoc `session.events` 掃描 / WeakMap 摺疊 → 註冊投影單元**（`ctx.sessionProjections.register({key, stateVersion, stateSchema, init, apply})`；register 返回 disposer）：
  - `turnBoundary`（agent-loop；`agent-instructions` / `hooks-claude-code` / `hooks-codex` 改讀它，turn 數不再掃描 `turn/start`）
  - `turnOutline`（**新包** `session-turn-outline`：整頁 turn 大綱——entry 錨定 turn/start seq、50/120 字符預覽、"每 turn 至多 3 次推送"（引用門控））
  - `sandboxMode`（原 `effectiveSandboxMode(events)` 摺疊刪除）、`schedule`（`applyScheduleChanges` 單一轉移權威）、`agentTeam`（**fold.ts 刪除**；roster/mailbox/task-board 語義保留，改讀數組型投影狀態）、`permissions`、`timeContext`、`tmuxContext`
- 註冊表本體升級：**兩槽原視圖緩衝** + `Object.is` 引用門控（state 引用變了才比較/解析；視圖對象需在內部狀態變化中保持身份）
- 投影成為 **required injection**（不再 optional-child）

## 3. 主線三：輔助工具集中化（大型機械遷移）

- 新包 `util/values`（`JsonValue / assertNever / isJsonValue / snapshotJsonValue / deepFreeze` 從 llm/session/tools 遷出 + **新 `deepEqualJson`**）
- 新包 `util/deque`（環形 `Deque`：pushBack/popFront/clear/size，容量 16 起、縮半、無迭代器）——替換 gateway / session-controller / workspace feed 的 `push/shift` 緩衝
- 新包 `util/time`（`canonicalClientTimeZone(v)`——IANA zone 正規化，無格式化）
- `dsh-brand`：`brandString<T>()` 取代手工 brand 構造函數

## 4. 主線四：SQLite 持久化後端被移除（詳見 §6）

- `session-persistence-sqlite` 整包消失（src/{codec,compression,index,schema,sql,store}）；coordinator 保持後端中立；`session-query-sqlite`（FTS 觀察者）與 `storage-sqlite`（通用域 KV）獨立存活

## 5. 其他細節

- `SessionEvent.ignorable?: true` 前向相容：未知型別**無標記 → 讀端必須拒絕**（不變事件名註冊表；`known-event-types.ts` 顯式記錄「註冊表被拒，用持久化標記」）
- `FIRST_PARTY_SECTION_ORDER` 常數 → 運行時 `getSectionOrder(name)`（system-prompt / tools / sandbox-policy / approval / terminal）
- **sandbox-windows-acl 11 個 src 文件 byte-for-byte 凍結**（win32 隔離在 a1 已發布）；sandbox-local / sandbox / mcp-client / guard 零邏輯變化；subprocess-win32 零變化
- session-controller：`prompt()` 加 `mode: queue|steer`；`loadThrough(seq)` turn-jump 分頁（`JUMP_PAGE_MESSAGES=200`、共享低水位、重定向去重）
- `examples/` 移除以 `2026-08-26-remove-agent-spine-demo` 註記
- `RemoteMethod` 標記：WeakMap → class prototype 上版本化描述子（bundle/realm 複製後仍可用）

## 6. 官方決策：為什麼砍 SQLite 後端（註記全文解讀）

來源：`.agents/notes/implemented/simplification/2026-08-30-jsonl-only-session-persistence.md`（status: implemented）

**問題**：JSONL 是發貨的權威 Session 存儲；SQLite 提供者用第二種物理格式複製同一邏輯服務——每個 Session 契約 / 事件封套 / 恢復規則 / 包圖 / 平台車道 / 格式轉移都因此**雙實現雙矩陣，而發貨 profile 根本不選它**。格式遷移還需要"每 Session 精確源工件"可歸檔替換（單 DB 需單獨發布設計、無現役部署）。

**決策**：JSONL 是唯一第一方實現；抽象（Service Definition / PersistenceCoordinator）保持後端中立，外部提供者可實現同一服務；sqlite 的兩個獨立角色留下（session-query FTS 觀察者 + storage 通用 KV）；現有 DB 不打開不遷移（運行期有意斷兼容，操作員用舊 build 導出）。

**否決的替代**：①保留 opt-in differential 後端（未被選仍乘上全部職責）②只讀導入包（保留包圖+schema 維護、無部署需求）③用 session-query sqlite 兼任持久化（那是可棄投影，兩種存儲角色合併是錯）。

**IH 對照**：IH 的 sqlite **不是備援**——`--session-backend sqlite` 是第一方產品路徑，且 M23 所有權鎖、revision、**FTS 同事務**、migration chain 都長在它上。砍 dsh 式（jsonl-only + 獨立觀察者）在 IH 語境下 = **FTS 得先拆成「可重建的獨立索引」才能成立**——這是 m29 研究的主題（見 `docs/research/2026-09-02-ih-sqlite-removal-study.md`）。

## 7. 對 I-harness 的意義（分級）

| 等級 | 項目 | 判斷 |
|---|---|---|
| IH 優勢確認 | SQLite 後端 | dsh 砍掉；IH 的 sqlite+FTS+文檔鎖是**差異化優勢，保留** |
| ✅ 記錄 | win-acl 凍結 | 與 a1 相同——IH M22 已對齊 |
| ⭐ 吸收（S） | `ignorable` 免註冊 | IH union 已有 `ignorable?` 交集但 load gate 仍靠 `registerEventType`；「未標記才拒絕」對外部/插件事件更友好 |
| ⭐ 吸收（S） | mux missed-pong 終結 | IH mux 有 heartbeat 但無連續失 pong 終止判定 |
| ⭐ 吸收（S） | 錯誤碼命名空間化 | web-host/SDK 尚無統一錯誤碼契約 |
| 中期評估 | 投影註冊表統一 | IH 的 goal/jobs/schedule/team 摺疊分散——dsh 摺疊體系成熟化可為藍本（M29+） |
| 不急 | turnOutline / turn-jump 分頁 | UI 軌道面（前端未做） |

## 8. 參考

- 雙樹源路徑（見 §0）；官方註記：`2026-08-30-jsonl-only-session-persistence{,.zh}.md`、`2026-07-12-simplify-session-log-representation`（前導）、`2026-07-23-collapse-persistence-flush-state`（前導）
- 本倉庫對照：`docs/audit/2026-08-20-i-harness-vs-dsh-parity.md`（a1 基線）、`docs/audit/2026-08-31-fiveway-comparison.md`
