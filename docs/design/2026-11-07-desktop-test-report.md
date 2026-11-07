# IH Desktop 實測報告（2026-11-07，rc22）

環境：`D:\ih0113rc2test_env`（portable app、獨立 userdata／config、Windows x64）
建置：0.1.13-rc2 → rc22（未合併測試分支；rc22 為目前最新交付）
測試方式：CDP 驅動 `window.ihDesktop.request`、repo 單元／整合測試、實際會話。

## 一、修正總覽（依版本）

| 版本 | 主題 |
|---|---|
| rc3 | 首 prompt 暫時讀取失敗導致誤 reload（IPC 讀取重試） |
| rc4 | 首 write 誤報 unseen-rules（instruction preflight 重取 evidence） |
| rc5–rc6 | legacy fork 續傳、forked child 刪除 selection 修正 |
| rc7 | 大型 workspace watch `FS_WATCH_GAP`（ignoreInitial） |
| rc8 | rewind 後壓縮 `ambiguousTurn`、replacement 錯誤映射 |
| rc9 | unpriced replay 導致壓縮被 block（bridge 降級） |
| rc10 | 受限沙箱 `koffi.view` × Electron crash |
| rc11 | unpriced auto-compaction fallback、partial reduction 發布 |
| rc12 | CJK token 計價（1.8x→1.29x）、cache 用量記錄 |
| rc13 | signature 計價，容量計算保持啟用 |
| rc14 | Context Mode read page budget clamp |
| rc15 | fixed surface 下的壓縮（不再 fixed-input 全阻擋） |
| rc16 | managedResults／managedBytes、managed search 實作 |
| rc17 | stale-source owner grant（重啟後仍可讀自己的結果） |
| rc18 | Context Mode 工具 direct exposure |
| rc19 | Code Context 工具 direct exposure |
| rc20 | MCP 移出 selection witness → live enable/改 command/移除可用 |
| rc21–rc22 | plugin 安裝／重裝 staging 與 EPERM 修正 |

## 二、驗證矩陣（最新）

| 套件 | 結果 |
|---|---|
| token-meter | 55/55 |
| context-engine | 100/100 |
| core-agent | 649/649 |
| core-session（replacement／usage／attribution） | 50/50 |
| fs-watch | 70/70 |
| context-output（managed／service／result-page） | 49/49 |
| plugin-registry | 245/245 |
| session-executor（code-final-output-process-reader） | 1/1 |
| desktop-gateway（mcp-settings／adoption／host 專項） | 4/4 |
| desktop-gateway live-plugins | 10/11（唯一失敗為既有 flake，未套用本次變更時亦失敗） |

## 三、實機驗證（packaged）

* 一般對話＋工具、排程觸發、手動／自動壓縮、prune、rewind；
* CJK 長對話（window 22k）：11 回合 0 失敗；fixed-surface 修正後 context 由 88% 降到約 69%；
* Context Mode：>60KB 輸出 managed artifact、`context_output_search` 命中、`context_output_read`（含重啟後）成功；
* Code Context：91 files／250 chunks，direct 呼叫 4 hits；關閉時 `TOOL_FAILED`；
* MCP stdio／streamable-http；live enable → `pong`、改 command → `B:two`、disable／remove → 工具消失；
* Marketplace：source add → install → enable → skill_get／command 展開；重裝後內容更新；uninstall 清理 install dir 與 materialize；
* Hooks（信任／核准／prompt-submit 觸發）、Skills、Memory、子代理、Git／worktree、WSL、專案／會話搜尋。

## 四、已知限制／未解

1. （已修）`live-plugins` atomic state replacement：watcher 漏事件導致 refreshError 殘留，`state()` 現會自癒重試；live-plugins 11/11。
2. Code Context hybrid 模式未測（環境無 embedding server）；
3. heuristic 仍約 1.29x provider 上報值（保守）；
4. plugin 重裝在 EPERM 時採「刪舊再 swap」，非原子窗口極小但存在；
5. Context Mode 的 legacy `results` 與 managed 計數分開呈現（語意已文件化）。

## 五、交付建置（未簽署、不合併）

| 版本 | Setup SHA256 | Zip SHA256 |
|---|---|---|
| rc22 | `ec40e7f94c06ff70518ae4fd586adde5dddfd76643b040b0af8f2aab5c4ce05b` | `719850e6dca849c1ae4ddc0e4d16215af2175237e8085296d5226212885616d6` |
| rc21 | `ed24155858b06eb949ff19da9d3b2dbab9674b612fd5de0a31a0df83759fce40` | `287e82d85d1568033e1b8832a9d9f73a09a290f699f98f46090dd3d937252b7c` |
| rc20 | `5b7113f60524a676e89f66c7c8877a0f188099e3f13f39455f028e6cc3137675` | `6f5737fcc5857f3aae51b7330511d18afcff7c75feb955a2b4934802cc8740a8` |

## 六、目前測試環境狀態

- app：rc22；window 1,000,000；
- Context Mode／Code Context：ON（Code Context 已索引 91 files）；
- Memory：停用；Hooks：清空；MCP：清單空；plugins／sources：0；
- `workspace/demo/codecorpus`（91 個 .ts）保留供 Code Context 測試。