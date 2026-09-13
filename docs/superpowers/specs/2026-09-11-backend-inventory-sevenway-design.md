# I-harness 後端全量盤點 ＋ 七源命令級對比 — 設計

日期：2026-09-11 · 基準：`m62` @ `b5569e03` · 方式：機械抽取（腳本）＋ 逐源並行子代理 ＋ 對抗式引註驗證

## 1. 目的

回答兩個問題，並留下可重跑的證據：

1. **I-harness 的後端到底有什麼、怎麼設計的**——以「每一個命令」為最細粒度。
2. **對比其他六個參考項目，我們缺什麼、別人的做法值不值得吸收**。

本文件是執行契約：子代理的抽取 schema、對帳規則、驗證門檻皆以下文為準。

## 2. 範圍（後端邊界）

**In scope**：`packages/*` 中除 `tui`、`tui-core`、`web` 外的 **65 包**，加上 `apps/cli`。

| 排除項 | 理由 |
|---|---|
| `packages/tui`、`packages/tui-core`、`apps/tui` | TUI 渲染層——前端未完成，非本次標的 |
| `packages/web`（web UI 資產） | 同上 |

**仍算後端**：`web-host`（服務面）、`sdk`、`acp`、`session-executor`——M61/M62 剛補的一塊，是後端的一部分。

**命令面全量列出**：命令是指向後端的索引，即使命令的*註冊點*在 `packages/tui/src/app/slash/`，該命令所驅動的**後端能力**仍屬盤點範圍。

## 3. 七源身份表（命令數為本次實測）

| # | 源 | 路徑 | 語言/棧 | 命令面 | 命令數 |
|---|---|---|---|---|---|
| 1 | **I-harness** | `D:\I-harness-main`（`m62`） | TS ESM strict、零外部依賴 | 集中 registry ＋ 能力門控 | **50** |
| 2 | **dsh** | `D:\agent-complete\deepseek-harness-dsh-v0.1.5-rc.2` | TS、Cordis | 每包一命令（外掛式）＋ interaction ref | **3** `command-*` |
| 3 | **codex-rust** | `D:\agent-complete\codex-rust-v0.149.1` | Rust 2024（104 crates） | 集中 enum ＋ dispatch | **59** 變體 |
| 4 | **opencode** | `D:\agent-complete\opencode-1.18.30` | Bun＋Effect 4 | 內建 2 ＋ 使用者/config markdown | **2** 內建 |
| 5 | **opencode-fork** | `D:\agent-complete\opencode-fork-private-999.0.15` | 同上（fork） | 同上 ＋ fork 增補 | 2 ＋ Δ |
| 6 | **grok-build** | `D:\agent-complete\grok-build-main` | Rust | 一命令一 `.rs` | **~66** |
| 7 | **cc-custom** | `D:\opencode-bugfix\cc-custom` | TS（Claude Code 系） | 巢狀命令目錄 | **75** 目錄 |

**關鍵事實（影響解讀，必須寫進 D2 前言）**：七源在命令層**不同構**。dsh 幾乎沒有 slash 命令（其命令面是 `session-send` 類 interaction ref）；opencode 的命令主要由使用者 markdown 定義。**這些必須記為路線差異，不是缺陷。**

## 4. 產出物

### D1 `docs/audit/2026-09-11-ih-backend-inventory.md`

- 骨架**由腳本機械生成**（遍歷 `package.json` exports ＋ `src/index.ts` 匯出符號）——保證不漏包、可重跑比對。
- 每包：職責 ／ 公開介面（匯出符號清單）／ 關鍵設計決策 ／ `file:line` 出處 ／ 已知缺口。
- 每個命令一節：slash → 能力閘 → 後端服務 → 產生的事件，端到端。
- 另含：CLI 宿主面（`run`/`web`/`sdk`/`acp`/`tui`/`sessions`）與全部旗標。

### D2 `docs/audit/2026-09-11-sevenway-command-matrix.md`

嚴格聯集單表，**按功能家族切子表**（同一套欄位、無重複；避免 250 列無法導航）。

欄位：

```
命令(canonical) | 家族 | IH | dsh | codex | opencode | ocode-fork | grok | cc-custom | 機制/出處 | disposition
```

格值：

| 符號 | 意義 |
|---|---|
| `✓` | 有，同語意 |
| `◐` | 部分（有相近但不完整；須在機制欄說明差在哪） |
| `⊕` | 同能力、不同名稱或機制（**必須**有 crosswalk 條目） |
| `✗` | 該源有此層但無此命令 |
| `—` | 該源不存在此層（如 dsh 的 slash 層） |

附錄：
- A. 各源自身命令清單（**原樣抽出**＋出處，不翻譯、不合併）
- B. **未對帳清單**——不敢硬對的，誠實列出
- C. crosswalk 對照表（canonical ↔ 各源名）

## 5. 抽取 schema（所有來源統一）

```json
{
  "source": "ih|dsh|codex|opencode|opencode-fork|grok|cc-custom",
  "sourcePath": "<絕對路徑>",
  "sourceRev": "<git rev-parse HEAD 或 SOURCE_REV>",
  "commandModel": "registry|per-package|enum|markdown|directory",
  "commands": [
    {
      "rawName": "compact",
      "canonical": "compact",
      "aliases": [],
      "family": "context",
      "gate": "capability:compact | none | config:xxx",
      "summary": "一句話",
      "mechanism": "2-4 句，怎麼做的",
      "evidence": ["packages/compaction/src/index.ts:41"],
      "verified": true
    }
  ]
}
```

**硬規則**：

1. 每個命令至少一條 `evidence`，格式 `<相對路徑>:<行號>`。
2. 拿不出出處 → `"verified": false`，且 `mechanism` 寫 `未驗證`。**不准猜**。
3. 不接受 README／docs 作為唯一出處——必須落到 `src/` 的實現。
4. 命令數與 §3 實測值不符時，必須在回報中說明差異原因。

## 6. 異名對帳（crosswalk）規則

`/compact`（IH/grok/cc）＝ `command-compact`（dsh）＝ `Compact`（codex enum）＝ markdown 模板（opencode）是同一件事。沒有規則，聯集會重複計數、parity 欄會說謊。

1. `canonical name` 取該能力最常見的 kebab-case 人臉名。
2. 每源以**顯式對照表＋出處**映射到 canonical。
3. 對不上的一律**不硬湊**，各自成列並進附錄 B。
4. normalisation：`snake_case` → `kebab-case`（grok 檔名）；去掉動詞前綴差異需個案判斷，不得自動合併。

## 7. 執行階段

### Phase 0 — 機械提取（腳本，非 LLM）

- `scripts/audit/extract-commands.mjs`：按各源自身慣例抽取（IH：registry 檔；grok：`slash/commands/*.rs`；codex：`slash_command.rs` enum；cc-custom：`src/commands/` 目錄；dsh：`command-*` 包 ＋ interaction；opencode：內建 ＋ config schema）。
- `scripts/audit/extract-ih-surface.mjs`：65 包的 `package.json` exports ＋ `src/index.ts` 匯出符號。
- 產出：`docs/audit/data/2026-09-11-<source>-commands.json` ＋ `...-ih-surface.json`。
- **結構不經 LLM**——聯集可重跑、可 diff。

**Phase 0  gate**：原始清單先給使用者過目，確認無誤才進 Phase 1。

### Phase 1 — 逐源抽取（7 個並行子代理，一源一代理）

每代理按 §5 schema 輸出；IH 代理另做 65 包盤點（D1 素材）。無出處即 `verified:false`。

### Phase 2 — 對帳 ＋ 對抗式驗證

- 合併腳本聯集 7 份 JSON → 矩陣骨架（**不經 LLM**）。
- 驗證代理：抽樣 N 格，重開被引用的 `file:line` 核對，**回報偽證率**。任一格造假即全批重驗。

### Phase 3 — 合成

- 域代理標 IH 機制 ＋ disposition（沿用慣例值：`reuse` / `rewrite` / `improved-writing` / `已存在` / `遠期` / `不做`）。
- 組裝 D1＋D2，跑自我審查：佔位掃描、內部一致性、範圍檢查、歧義檢查。

## 8. 驗證門檻（完成前必須全過）

1. D1 的包覆蓋率 = 65/65，且與腳本抽取的匯出符號一致。
2. D2 每一列在 IH 欄為 `✓`/`◐`/`⊕` 者，必有 `file:line`。
3. 抽樣偽證率 = 0（抽 ≥ 20 格）。
4. 附錄 B（未對帳）非空——若為空需說明為何七源命名完全對得上（預期不成立）。
5. 無 `TBD`/`TODO`/佔位。

## 9. 邊界與不做的事

- **不改任何代碼**。發現的缺口只進 disposition，不順手修。
- 不憑 README 聲稱下判斷——走 `src/`。
- 不把 opencode/dsh 的「命令少」寫成缺陷——記為路線差異（§3）。
- 不硬湊 crosswalk 以提高覆蓋率。
- 不重寫 `docs/audit/2026-08-31-fiveway-comparison.md` 與 `docs/CAPABILITIES-DETAIL.md`；新文件交叉連結並註明取代關係（fiveway 的 dsh 基準為 0.1.2-alpha.1、IH 為 M25，均已過時）。

## 10. 已知風險

| 風險 | 對策 |
|---|---|
| 子代理幻覺 parity | §5 硬規則 ＋ §7 Phase 2 對抗驗證 |
| 250 列單表不可導航 | 按家族切子表（同欄位、無重複） |
| crosswalk 過度合併 | §6 規則 3：不硬湊，進附錄 B |
| Rust 兩源（codex/grok）閱讀成本高 | 一源一代理，各自獨立 context |
| opencode fork 與上游難分 | 兩者都抽，Δ 另列 |

## 11. 規模

約 20–25 次子代理；2 份文件（估 120–200 KB）＋ JSON 資料檔 8 份。
