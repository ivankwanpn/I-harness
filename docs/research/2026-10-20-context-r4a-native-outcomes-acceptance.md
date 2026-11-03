# R4A 原生工具 outcome 驗收 — 2026-10-20

**接受原生工具 outcome 及 NAT-13 同步完成時序修正。** Fresh GPT6.1Sol 獨立 spec／quality review 通過，沒有 actionable finding；root 已讀完整審查並完成來源、副本與證據核對。三項原子代理狀態測試另行驗證，不在這裡宣稱已修復。

| 固定點 | 值 |
| --- | --- |
| BASE | `72a04b02b123ba2371cd78ac21029fe020b4de0e` |
| 產品／測試 commit | `3cf3bc12c4eea5518f0d7753c0dbb9b1e007cb0b` |
| 交付 HEAD | `5a2c60f3951bc78decfdde74e7612eccc7bc3b94` |
| 版本／拆分 | 產品0.1.13-rc.1、Session10、原拆分27/43，均不變 |

[交付報告](2026-10-20-context-r4a-native-outcomes-delivery.md)、[獨立審查](context-r4a-native-outcomes-review-20261020/review.md)、[root 核對](context-r4a-native-outcomes-review-20261020/root-verification.json)分開保存。

## 已接受行為

原 sandbox lease 現在可觀察它自己接納的終止動作；POSIX、WSL、Windows Psec 三個既有 adapter 明確轉接，同時保留原清理次序。Exec 在原有 root／process tree／I/O／取消屏障完成後分類。分類代表整棵執行樹的處置，不宣稱 root 是被哪個訊號終止；原 exitCode、原輸出 bytes、保存完整度各自保留。

支援的「沒有終止動作」與「沒有可用的觀察能力」分開。可靠的原生退出碼0／非0對應成功／失敗；可信的 timeout/output-limit 終止失敗，取消／權限撤銷／shutdown 終止為 canceled。不可靠或未提供的事實維持 unknown。晚到、且原 lease 未接納的取消不能覆寫既有成功。

同一個 host-only 結果 identity owner 同時保存原 reader 與 outcome，保存失敗後重包結果也會保留它們，沒有增加 program JSON 欄位或第二份權威。核心 registry 不再把明確宣告的 unknown 改回 succeeded，也保留原 MCP presentation。原 shell/bash/pwsh 及 code_exec 宣告自己的結果；查詢、控制、啟動／轉背景及 guest 已捕捉的內層失敗保留各自語義。缺少 native identity 的自訂 ExecService 在內建 shell 路徑顯示 unknown；第三方普通工具返回的預設成功規則未改。

NAT-13 修正原 Code Mode terminal owner 的 unconditional await：同步回呼返回後可立即完成；非同步回呼仍等待真正的寫入／F1 屏障。原本失敗的 retained completed-cell／eviction 測試未改並通過。新增 held callback、一般拒絕及 FACT recovery 控制，沒有跳過原保存或清理流程。

## 驗證

| 範圍 | 記錄結果 |
| --- | --- |
| Code Mode 最終 owner 選集 | 69／69 通過 |
| 最終 managed native／MCP／output／store 選集 | 27／27 通過 |
| 最終 native Exec 控制／lease 控制 | 18／18、27／27 通過 |
| Shell owner 選集 | 53／53 通過，含真正 Windows unrestricted helper／pwsh |
| 十個受影響套件型別，及 NAT-13 後四個最終型別 | 全部 exit0 |
| 最終 Gateway copy／registered producer probe | 242 shipped packages；指定 shell、Code Mode、eviction、Windows pwsh 控制通過 |

早期 Exec70／70、managed21／21等記錄保留其來源時點，沒有相加成新的總測試數。完整證據及 RED／GREEN、withdrawal、setup、skip 分類在交付文件中。

Root 重算17,772個封存檔及報告，確認56個 run manifests 來源穩定且沒有執行重疊；最終 manifest 的2,579個來源與當前檔案相符。作者選定的245個 source copies／13個入口／9項 native 或 generated assets 均核對。Root 另外擴展至整個 copied internal closure：78個 packages、1,142個 payload／manifest 檔、322條 runtime dependency，全部維持原 bytes 且依賴留在 candidate 內；唯一 WSL generated manifest 用原 worker 與 generator schema 另行重算。Fixture 只有一個 AST 確認的 import relocation。核對零失配。

Seal SHA256：`aafb41ec5812b60a15542ee7d0ac51cfdcca4695d509444243690c38adc22ae0`。完整 raw 證據保留於 `.tmp/context-r4a-native-outcomes-20261020-implementation/`。早期 RED manifest 未包含當時未追蹤的新測試檔，屬明確的 baseline provenance 限制；最終 candidate 與 copy 已包含這些檔案，兩者不混稱。

## 尚未涵蓋

三項原 `subagent/tools.test.ts` 狀態斷言仍失敗：followup running patch、foreground summary 後 resident waiting、TaskRecord wait 後 job terminal。已查明它們等待的觀察 owner 不同；下一單元保留原安全／內容斷言，使用各自真正的完成通知驗證，若正確 join 後仍不一致才修產品 owner。不加任意 sleep、不加長 timeout，也不把失敗稱為 flaky。

本機實測是 Windows unrestricted helper／PowerShell；controlled native 和 fake Psec protocol 控制不等於實機 Linux/POSIX、WSL 或 confined Psec 資格。Copied probe 不等於完整 IPC／installer。明確 artifact 分頁、剩餘 cold-cut／100MiB／fan-in、R4B/C/R5/R6 及 release readiness 繼續進行。沒有 push、merge、tag 或 release。
