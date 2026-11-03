# R4A 明確結果分頁 Task1 驗收 — 2026-10-20

**接受結果分頁服務、SDK／CLI／Gateway 接線，以及 PAGE-11 的原來源委派修正。** 獨立 GPT6.1Sol spec／quality review 沒有 actionable finding；root 已讀完整審查並完成來源、兩份副本、EOF 差異和 BASE 還原核對。Desktop IPC／卡片 Task2 接著執行，未在此宣稱完成。

| 固定點 | 值 |
| --- | --- |
| BASE | `c93b056e68e8f87cdb45af287346e4067a42846f` |
| Memory delegation／分頁產品 | `97c6d355`／`6fd98f90` |
| 兩個 test EOF 清理 | `745302f4` |
| 交付 HEAD | `ed6f2b6cca01f437525e826d740ea97cf2358d3e` |
| 版本／原拆分 | 產品0.1.13-rc.1、Session10、27/43，均不變 |

[交付](2026-10-20-context-r4a-result-read-delivery.md)、[獨立審查](context-r4a-result-read-review-20261020/review.md)、[root 核對](context-r4a-result-read-review-20261020/root-verification.json)與[BASE 還原核對](context-r4a-result-read-review-20261020/baseline-restoration.json)分開保存。

## 已接受行為

明確 `session/result/read` 經 host 注入的 SDK 入口、原 SessionService 的短讀取生命週期和原 ContextOutput store 取得有界頁。完整 immutable ref 仍只是資料；原 store 在 body/index I/O 前後檢查已提交的 identity、caller pin 和當前 source。Gateway 另外檢查 conversation visibility、archive 和 management fence，不能用 child pin 繞過會話入口。讀取不建立 assembly／child、不 prepare／authenticate／send model、不 admit／wake input，也不新增 pin 或修復 session。

JSON／text 依 encoded-byte offset，exec 依原 frame cursor 保留原 bytes，page DTO 上限32768 bytes。新 public query 嚴格檢查 codec 和參數；原 model tool 的 legacy refId、exec offset shorthand 和合法大整數 maxBytes clamp 保持相容。共用 parser／type owner，沒有重複權限 store。

讀取與 producer 使用同一 registry，兩者都在 configure 等待之前保留 registration／users，並拒絕已退休的 entry；讀取不 configure 活躍 writer。Read registration 不呼叫 execution project getter，不能用儲存的 projectId 假造 confirmed scope。整個 acquisition／read／release 在第一個 await 前登記，global／per-session close 會 join，晚回的頁面被丟棄。

PAGE-11 修正 genuine memory source 經 agent 包裝後丟失 identity 登記的既有缺陷。原 synthetic validation 保持嚴格，foreign／shape-only／closed 仍拒絕；memory 沒變成 managed，也沒有 storage session ID。真正 `skill_get` 失敗現在產生一次 failed/dispatched inline result，保留完整原錯誤，模型能繼續第二段回應，queue 回到 idle。

## 驗證與來源時點

| 原661來源的最終 gate | 結果 |
| --- | --- |
| core-session 全套 | 436 tests／36 files |
| agent source／synthetic | 43 tests／3 files |
| tool finalization／retention | 5 tests／2 files |
| ContextOutput 全套 | 58 tests／8 files |
| service／original producer／child | 39 tests／12 files |
| SDK／真正 CLI subprocess／原 server | 71 tests／7 files |
| Gateway／真正 host／policy／fence／child route | 40 tests／6 files |
| 七個受影響套件型別 | 全部 exit0 |
| v2 copied public owners | 72 tests／9 files |
| 最終v3 copied codec／Gateway／actual host | 8 tests／3 files，使用b42來源 |

各範圍有重疊，未合計成唯一測試數。原資格來源 SHA256為`661955612947b2b03f8aef377dcba5be16dac9b917eb2c7c71d8eb82544ba5db`；現行為`b42fa3bc76c636d1e51c0b5f067f6cd447e7dc91a6ee313bc373045d9bba777a`。Root 重建兩個原 test EOF suffix 的完整舊 hash，確認只有兩個測試尾端空白改變，另外2,686個來源和全部產品 bytes 不變；沒有把舊執行歸為新 physical test bytes 的執行。

Root 重算2,688個現行來源、363個 sealed evidence artifacts、64個有 manifest 的 run 邊界與22個最終選定 gate；它們按記錄循序完成。針對故意的 mutation／BASE overlay，不把 before/after 相等誤稱為中途未改 source。另以 Git BASE blob核對10個 overlay 檔及完整還原 manifest，零失配。

v2／v3兩份 copy各核對78個 internal packages、1,146個 source-identical payload、322條實際副本內依賴，以及9個 fixture／27個 AST 確認的 import-content 轉換。WSL generator及原 native source／manifest／qualification另驗，沒有新增平台實機資格。Inventory SHA256：`66bcf37fb43e234f8732888516e0a6e89e6cb4617ea76e9c37d9aeb229cb9975`。最終 root 核對零不一致；root verifier 的早期檔名／metadata 解讀修正保留於[setup記錄](context-r4a-result-read-review-20261020/root-verification-setup.md)。

## 限制與接續

早期少數 service／SDK fixture 漏指定設定路徑而走原預設設定讀取，不列入 clean isolation。來源確認該 leaf只 read／parse／normalize，沒有寫入、migration或auth；其後全部資格 gate使用專用空設定與 task-owned IH_CONFIG_DIR。原失敗、BASE discriminator、commit在 whitespace check失敗後仍執行的過程錯誤及獨立清理 commit均保留，沒有隱藏。

這裡接受 Windows offline owner／service／SDK／CLI／Gateway 與指定副本；不含 Desktop UI／IPC、live provider、installed profile、其他作業系統、100MiB／fan-in／crash cuts、全 artifact search、whole R4A 或 release。Task2 會接回原會話結果卡片，使用同一 parser 與權限入口。沒有 dependency／version／拆分計數變更，沒有 push、merge、tag 或 release。
