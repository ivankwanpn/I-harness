# dsh 0.1.2-alpha.4 → alpha.5 版本增量研究

日期：2026-09-02 · 方式：雙樹唯讀 diff（無 git）——包清單 `comm`、文件級 `diff -rq`（排除 node_modules/lib/dist/build）、官方註記新增 `comm`、逐文件語義比對。

**樹**：`D:\agent-complete\deepseek-harness-dsh-v0.1.2-alpha.4`（a4）vs `D:\agent-complete\deepseek-harness-dsh-v0.1.2-alpha.5`（a5）。

**統計**：頂層 55 包**零增改名**；修改文件 263（其中 **249 = package.json 版本號 bump** 至 alpha.5、3 = README）；**新增 src 文件 = 0**（新增僅 `tests/fixtures.spec.ts` + `tests/fixtures/` 存檔樣本）；實質語義變更僅 **10 個文件**（storage 系列 7 + session-projection-cache 3）+ 1 個純文檔同步（tool-cordis api-catalog 描述字串）。

## 0. 一句話結論

**單一 hotfix 型版本**：「投影緩存跨版本讀相容」修復（`session_projcache` v3/v4/v5 三世代 on-disk 升級矩陣）+ 配套 storage 域擴展 + 全倉版本號 bump。**無新能力面、無新架構事件**——對比 a1→a3（收斂）與 a3→a4（類型修正），a5 是「發布事故修復」：自家升級失敗後的回補工程，附帶一套值得參考的**持久化版本相容政策**。

## 1. 官方註記（新增僅 1 個，全文精讀）

`.agents/notes/implemented/architecture/2026-09-02-projcache-cross-version-read-compat.md`（status: implemented）

**事故**：`session_projcache` 存儲域跨三世代（v3 單檔 0.1.1-rc.2 → v4 per-record 0.1.2-alpha.3 → v5 +lineage 字段 0.1.2-alpha.4），升級 DSH_HOME 後兩種失敗：
- **v3 家園直接 brick**：legacy bootstrap 遷移舊整檔時**不檢查 `unit.version`**，把 v3 記錄以當前版蓋章寫進新樹 → domain 層 zod 驗證（缺新必填 lineage 欄位）→ `invalid-record` → 整個域拒開 → 插件樹載入崩潰。且 bootstrap 在驗證**前**寫入 → **首次開機永久寫入壞文檔（poisoning）**——之後每次開機見非空樹、再不走 legacy 路徑、家園永久不可用。
- **v4 家園丟標題**：v4 文檔被版本戳檢查靜默丟棄；SessionList 是零 I/O 純緩存讀，miss 即顯示無投影行——標題要等每個 session 各自重開才回來。

**修復決策（4+1 件）**：
1. **`DomainSpec.compatibleVersions`**（新選填）：域主聲明「這些舊版本下存的記錄在當前 schema 下也可讀」（典型做法 = 把舊記錄缺的欄位聲明為 optional；`defineDomain` 驗證每項為當前版本以下的非負整數；`descriptorOf` 投射到後端）。
2. **json per-record 讀取接受「current ∪ compatibleVersions」**；集合外仍當外來丟棄。**寫入永遠蓋現版**（讀舊記錄後的第一個 checkpoint 自然推進）。single 布局仍嚴控版本。
3. **Legacy-bootstrap 版本閘（真 bug 修復）**：舊整檔的 `unit.version` 落在接受集合內才遷移；否則留原檔、單元讀空——**絕不蓋章未經擔保的記錄**。
4. **projcache 域聲明 `version: 5, compatibleVersions: [3, 4]`**，兩個 lineage 欄位改 `.optional()`；唯一身分讀者 `identityMatches` 把缺省正規化為未分叉 lineage（`?? false/?? 0`）；分叉方期望 seeded → 自然不匹配 → 丟棄冷重建——lineage 綁定保護不減。**poisoned 自愈**：蓋 5 但無 lineage 的文檔按可選 schema 解析 → 開機恢復、標題立即可用。
5. **`invalidRecords: 'backup-and-skip'`**（本域獨有、明確**域級聲明**；默認保持 fail-loud）：存儲記錄仍解析失敗時不再拒絕整個域——後端 `KvUnit.backupRecord`（json per-record = 文檔改名 `<key>.json.bak.<ts>`，字節保留永不重讀）+ `logger.error` 具體原因，開機繼續、記錄缺席、下次冷讀重建該 session。無 `backupRecord` 後端（single 布局/行式）自動回退 fail-loud；global 槽總拒絕。命名史：quarantine → backup-and-skip（用戶裁定：「備份」與「跳過」都要體現，共享 `.bak` 詞根）。

**升級矩陣**（修復後）：v3 純（遷移即標題可用）/ v3 poisoned（direct read，開機恢復）/ v4（direct read）/ v5 健康（無影響）/ 分叉後代記錄（身分不匹配 → 丟棄冷重建——安全側）。

**被否替代**：①僅 discard-and-rebuild（bump v6）：修開機但升級即全部標題丟失直到重開——不服「升級即用」要求 ②schema `.default()` 填充：行為等價但把「缺省=未分叉」解讀**烙進持久 schema 輸出型別**——裁定 optional（schema 誠實描述每個接受形狀，解讀留在消費者）③域版本 5→4 回滾：最小 diff 但破壞版本單調、依賴 bootstrap bug 本身、丟所有 v5 健康家園。

**後果**：路由到 sqlite 後端的部署**得不到任何容忍**（sqlite 不實作 compatibleVersions 也無 backupRecord → 仍是舊嚴格版義；發貨組合走 json，屬部署配置風險）；`backupRecord` 同名同分鐘會覆蓋（更新者勝）。

**測試**：storage-json/domain/projcache unit + **真實釋出構件存檔套件**（`fixtures/`：0.1.1-rc.2 真 v3 單檔、0.1.2-alpha.3 真 v4 文檔、現 v5、合成 poisoned v5-lineageless>）逐個經真實 storage stack 開機，斷言標題即時可用 + 活寫重寫為現版；**端到端用發布的 npm 構件實跑**（0.1.1-rc.2/alpha.3 造 homes、alpha.4 復現兩失敗、修復版逐形狀開機）。

## 2. 語義變更清單（10+1 文件）

| 文件 | 語義 |
|---|---|
| `storage/storage-domain/src/spec.ts` + `index.ts` | `compatibleVersions`/`invalidRecords` 聲明與動態驗證（compat 項須 < version） |
| `storage/storage/src/backend.ts` | `KvUnit.backupRecord?` 選填面 + `KvUnitDescriptor.compatibleVersions?` |
| `storage/storage-json/src/{format.ts, per-record-unit.ts}` | compat 蓋章讀取/集合外丟棄/寫蓋現版/legacy 遷移版本閘/backupRecord 移動 |
| `session/session-projection-cache/src/{index.ts, spec.ts}` | `version 5, compatibleVersions [3,4]` + lineage 欄位 optional + identityMatches 正規化 + `invalidRecords:'backup-and-skip'` |
| 對應測試 3 檔（cache/json-backend/domain）+ `fixtures.spec.ts`（新增） | 註記 §Testing 逐項 |
| `extensions/tool-cordis/src/api-catalog.ts` | **純文檔字串**：storage-domain 的描述隨新 spec 同步——無語義 |
| 249 × `package.json` + 3 × README | 版本號 bump 至 0.1.2-alpha.5 + 多語言同步 |

## 3. 對 I-harness 的意義

| 等級 | 項目 | 判斷 |
|---|---|---|
| ✅ 記錄（無緊急項） | 本版整體 | 無新能力、無 IH 已吸收域的變動——a4 期結論（「無 IH 落後」）續延 |
| ⭐ 參考（投影語義） | **IH 的 file-backed 索引已是「discard-and-rebuild」語義** | IH 索引 schema（`application_id=0x49485155` + `user_version=1`）版本不符→foreign 拒絕→重建——即 dsh 考慮過的「僅 discard-and-rebuild」；對**可棄索引**這是正確默認（IH 索引無標題型需求）。**守則**：未來索引加欄位時，走「bump 版本 → 允許舊版重建」即可，**不需要** compatibleVersions——除非索引要承載「升級保留」型狀態 |
| 🟢 吸收（如未來建 derived KV 域） | `backup-and-skip` 概念 | IH 目前無 dsh 式 storage-domain/KV 域（M29 後索引是唯一 derived 數據）。若未來把 workspace-registry/subagent state 從 coordinator documents 搬進「可棄域」，此政策的「域級聲明、默認 fail-loud、備份文件 + 具體原因日誌 + 下次重建」應作為 IH 版藍本 |
| 🟢 吸收（bump 程序） | 「版本 bump 必須帶存檔樣本 + 測試證明處置」 | dsh 的程序性守則（包 README 要求）——適用於 IH 索引 schema 迭代與 session format 未來 bump（registerUpgrade 鏈空置至今） |

## 4. 方法與參考

- 同前代（`2026-08-31-dsh-a1-to-a3-delta.md` §8 / `2026-09-02-dsh-a3-to-a4-delta.md` §8）方法。
- 官方註記（新增 1）：`architecture/2026-09-02-projcache-cross-version-read-compat{,.zh}.md`（全文精讀，本報告 §1）。
- 前代：`docs/research/2026-09-02-dsh-a3-to-a4-delta.md`（a4 的四條主線——本版與之對照：a4 的 seq/offset 品牌正是 a5 修復中「lineage 欄位」的由來）；本倉庫對照：`docs/research/2026-09-02-ih-sqlite-removal-study.md`（M29 索引語義）。
