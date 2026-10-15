# 2026-10-15：續做修復、完整驗證與候選產物

**本分支的長會話修復已通過具名程式碼審查；整體候選資格仍未取得 PASS。產物只供未公開 draft prerelease 保存與檢查。** 產品來源固定為 `15563d70de680ecf2285926dbe172cb4f275650d`。以下結果區分程式碼審查、完整測試、受控封裝執行和實際產物檢查，不互相替代。

## 原事故與這台電腦

已唯讀找到文件提及的同一份 Session：5,188,017 bytes、3,282 事件，現行純匯入可投影出 918 messages。SHA-256 為 `e987274691777110a2546bda6eb8120a181f40687edb82887f1253666aa88870`；本報告採用的再次核對時間為 **2026-10-15T13:50:02.8923898+08:00**，原檔保持相同雜湊。這是一份可完整解析的 JSONL，反覆請求失敗不等於檔案損毀。

獨立用量紀錄補回最後成功請求的數值：162 input + 760,448 cache read + 0 cache creation = **760,610 總輸入 tokens**，output 587。其後四次失敗沒有保存上游 body、request metrics 或事故當時的完整 system/tools/options/cap，故仍無法定案 HTTP 400 的原因。原 437,837／43.8% 是不同時間和投影界線的歷史粗估，不能當成同一 payload 的精確對照。現時的 auto=true、1M window 設定修改時間晚於事故，也不能冒充當時設定。

正常的保護應按實際模型容量、輸出預留和安全餘量提早處理累積輸入。760k 在某些 1M 設定下仍可能合法，因此修復不採用任意通用 token 上限。供應商前綴校準改善估計；新文字、圖片和 opaque continuation 仍有估計誤差，不能宣稱是 tokenizer 上界。詳見[本機事故證據](2026-10-15-local-session-evidence.md)及[唯讀 proactive source audit](2026-10-15-proactive-context-verification.md)；後者的來源檢查不是執行測試收據。

## 續做後完成的修復

- `7u / 4e9c6662`：容量介面沿用 IH 原有樣式及共用 Refresh，保留語意狀態和短視窗操作。116 項針對性檢查、Desktop types 及 18 組受控元件視覺／存取案例通過；元件圖片不代表原生安裝測試。
- `7b / 3b788e66`：Desktop／gateway 完整版本為 `0.1.13-rc.1`，Windows 數字版本獨立為 `0.1.13.0`。封裝可重用一份已驗證、位於 repo 內的 canonical gateway，且在清理輸出前檢查路徑重疊。70 項 focused checks、兩個 types 及四個腳本語法檢查通過；當時的 fake compiler 不代替下列實際 PE 檢查。
- `Task8`：修復 exact-model auto fallback、空白容量活動、連續自主工具回合的摘要切分、原始未切分前綴相容性、子會話授權前的 seed 持久化、失敗 CLI 的 ending／一次性 raw usage，以及 cold context recovery 的綁定選擇。
- `15563d70`：實際封裝啟動找出的 catalog／Code Mode worker 相對路徑錯誤，透過既有 dist marker 選擇 bundle 旁的資產，保留 source／gateway 路徑。有效 runtime RED 兩項失敗，修復後兩項通過；provider 164/164、Code Mode 86/86 及兩個 types 通過。早期 `--help` 只證明啟動；完整 worker 執行另列如下。

受控增長案例走實際 Desktop host／service／assembly、shipped read tool 和 Chat adapter：12 次工具讀取、13 次主 transport，保留低於 spill/prune 門檻的結果及 matching thinking。原先 hard admission 正確擋下 96,383-token 主候選，但 97,444-token 摘要因只有 interior-user 切點而錯判為不可切分。新增 summary-only 閉合工具回合切點及量入準備的 standalone opener 後，反覆摘要能縮減下一份輸入，原始結果不刪除，副作用不重播。既有 8-call／2-shrink、Stop 和持久化界線保留。

實際六種 adapter 變體還涵蓋 changed-input retry、第二次超限後保存阻塞、Stop、checkpoint 失敗和普通／schema 400；public Responses 和 subscription 的 cap 能力分開。重啟、parked child、原生結果 owner、raw cache counters 和 cold/live 一致性均有具名回歸，詳細收據見[組合驗證報告](2026-10-15-long-session-reliability-verification.md)。Focused selections 有重疊，未相加成虛構總數。

## 完整門檻與中斷紀錄

| 完整執行 | 實際結果 |
| --- | --- |
| 首輪 unexpected-shutdown prefix | 318,248-byte 日誌；沒有 producer exit，未完成全部 population／types／E2E／reachability。 |
| `4802d235` 已安全終止的舊來源 | 核實 owned PID tree 後終止，qualification exit 未知。gateway 實際為 494 pass／1 fail，495 total；先前 495 pass 的口頭更新已更正。 |
| `e0e66c7f` | exit 1；81/81 projects，7,396 pass／45 skip／9 fail；types 0；E2E 六檔 12 pass／1 fail；reachability 0、沒有 new rows。 |
| `7f9f8750` | exit 1；81/81 projects，7,402 pass／45 skip／3 fail；types 0；E2E 六檔 13/13 pass；reachability 0、沒有 new rows。 |
| 首次 `15563d70` | 238,725-byte prefix、15 個已報結果套件，04:44:02.2629818Z 後程序消失；沒有 producer JSON／final summary，qualification exit 未知。工具 session exit 1 不代替它。 |
| 最後 durable `15563d70` | 2026-10-15T04:49:31.987Z–05:16:53.648Z，status completed／exit 1；81/81，7,401 pass／45 skip／4 fail。完整日誌已 flush／close 後才產生最終 producer receipt。 |

最後一輪使用相同程式碼和 `pnpm verify:all` 範圍，於 `2026-10-15T04:49:31.987Z` 以 hidden 背景程序啟動，stdout／stderr 直接寫專用檔案；記錄初始 PID、來源、running/exit-null，完整日誌 fsync／close 後才記錄實際退出。前一輪遺失程序的原因仍未知：runner 沒有 timer／kill path，窄範圍 Windows event 查詢也沒有對應的 selected shutdown/resource/Node fault；這不構成原因證明。所有中斷及失敗收據保留，不用 prefix 冒充完整驗證。

| 最後來源的驗證項目 | 收據結果 |
| --- | --- |
| 81 個 workspace 測試與 population | exit 1；81/81，7,401 通過、45 跳過、4 失敗：gateway approval deadline 1、guard identity deadline 1、PSEC 2。 |
| 所有 workspace types | 所有 workspace typecheck 完成，exit 0。 |
| Root E2E `**/*.e2e.ts` | exit 0；7 個檔案、15/15 測試通過，包括兩個新增的 source／emitted-runtime 資產案例。 |
| Reachability，既有 baseline 未放寬 | exit 0，gate PASS、沒有 new rows；411 current rows／55 baseline rows gone。既有 inert SdkRunError allowlist 警告不豁免任何 live row，沒有放寬 baseline。 |
| 新 CLI／gateway build | 兩個全新 runtime build 均 exit 0；gateway 包含 241 packages。來源為 155，artifact capture 在文件提交前完成；CLI 558 檔、gateway 8,550 檔。 |
| Responses／Anthropic × CLI／SDK／gateway | 六項均 exit 0；每項兩個主請求、一次 read、實際主 wire cap 20,000，以及保存的 format2／budget／工具結果。首次 155 嘗試因 ignored helper 將 SDK server-info version 當成 release version 而中止，只有前兩項完成；保留該失敗後，按既有契約分開斷言 gateway manifest 0.1.13-rc.1、SDK server-info 0.1.0 和 protocolVersion 3，再完成全部六項，沒有修改產品來源。 |
| 完整 CLI 的真實 Code Mode worker | exit 0；一次 exec／dispatch、初次 running、一次同一 cell 的 wait、最終 completed／PACKAGED_WORKER_OK，durable format2／budget 保留。實際使用全新完整 CLI 的 shipped worker、CPU-budget 和依賴樹，沒有 unit fixture 的依賴 junction。 |

兩個 PSEC 真實 driver 測試維持原生驗證失敗。未改動的 helper 連既有 `--create-close` 都在子工作開始前回傳 `created:false`、`CreateProcessSecurityEnvironment`、`0x8007000f`；helper SHA-256 `6426b786d0d5140beb11d66a957847f90f665d5755072267457a8dd99ac68ed5` 與 Task8 base 相同。Microsoft 的[系統錯誤碼文件](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-)將低碼 15 列為 `ERROR_INVALID_DRIVE`，但不能由此判定哪個 volume／政策造成拒絕。Mapped/optical root 假說未證實，沒有改動映射、登錄、native policy、helper 或 launcher 資格。

7f 的另一個失敗是既有 guard-approval shipped-size identity 案例在固定 5 秒 deadline 下耗時 5,723 ms。它對 246,032,896-byte 映像做三次完整 hash，保留 restart、mutation 和 bounded-memory 檢查。唯一一次同檔／同 worker／同大小／同期限 focused run 為 7/7 pass，該案例 4,189 ms；這不抹去原完整執行的失敗，也沒有修改 deadline。在最後 155 durable 完整執行中，同一案例再次以 5,646 ms 超過相同 5 秒期限；此實際失敗也保留，沒有反覆 targeted 重跑尋求通過。 既有平台 skips 也保留；特別是目前 Git/bin launcher 雜湊不符 audited identity 的 22 項，沒有透過放寬資格取得通過。

本輪 gateway 另外記錄了未改動 `approval-rules.test.ts` 的實際 write／restart／revocation／policy 案例超過 5 秒期限：案例 5,062 ms，整個三案例檔案 5,113 ms。相同檔案在 7f 完整執行中三項通過，檔案總耗時 4,384 ms；7f 至 155 沒有 gateway 差異。完整門檻後唯一一次 unchanged focused run 為 exit 0、3/3 pass；write 案例 4,489 ms、檔案 4,547 ms，仍使用原 5 秒期限及 maxWorkers=2／minWorkers=1。前後 Git blob 均為 9ebccc525ff40f03f7a66a38efd723138361fed7，與 frozen source 相同且沒有 diff。 完整執行的失敗保留，沒有藉此放寬授權、政策、assertions 或 deadline，原因也未由一次 focused 結果定案。

## 實際產物與來源一致性

最後產品 inventory v2 為 2,202 個 tracked code/config/fixture/runtime-asset/license/prompt 檔案，digest `8f6426866c4a8c76a8d5c033a1d367b7d3026c4678668155d96b70c599e97cac`。篩選在開檔前排除 `.superpowers/`、`docs/` 和根目錄 README，保留套件 runtime Markdown。文件提交後再比較相同路徑及每一個 SHA；沒有讀取或改動其他 plan workspace。Root 的 docs-ccba9d46-product-scope.json 獨立核對文件提交 ccba9d46 後的全部 2,202 路徑與檔案 SHA，canonical digest 仍精確等於上述 8f642686…；不是只比較檔名或 Git stat。最終文件提交另作同範圍核對。

Root 在唯一 runner 交接後執行 Desktop build，使用同一份 smoke 通過的 qualified gateway，產生全新輸出目錄 `D:/ih/packages/desktop/release-rc1-20261015-15563d70-durable`。逐檔核對包含來源 handoff、打包前 gateway 和 payload copy，保留 traversal-order digest 與獨立排序 digest 的區別。Root 核對 8,550 檔、332,762,658 bytes，與 smoke handoff 及 payload 每一個 path/byte/SHA 相同。Producer traversal digest 31b397e26e1cc52153e26eebf473caffe971530b98c8eacb03c9d9b3c19827a7 與 Root 獨立排序 digest 6baa656548113d8c7c7cfa120f4e50ce6e962e039a71d0b089680d708fbca7f0 分別保存；順序不同沒有混稱同一 digest。ZIP 另比對全部 8953 檔／769844941 uncompressed bytes，path／length／SHA 全部相同。

第一次 Root 前景 portable 工作的程序群組在沒有 final receipt 下消失，留下零長度 log 和部分 app 目錄，沒有完整 ZIP；其 producer exit 和原因未知，Root 沒有終止它。之後以 hidden durable runner、相同來源和 qualified gateway，在另一個全新且事前確認無重疊的目錄完成打包，實際 exit 0；後續 NSIS 編譯也實際 exit 0。只使用後一份完整核對的產物上傳，保留第一次診斷及部分輸出。

| 產物 | Bytes | SHA-256 |
| --- | ---: | --- |
| `I-harness-0.1.13-rc.1.zip` | 286281390 | `7583b986a6df6b92a33a969d2f1d42c5086fbcd32e86b72e17e5f86af72f808a` |
| `I-harness-Setup-0.1.13-rc.1.exe` | 188427746 | `3ca3b9ca3fe27437c0b0f54fd462904c8d1e0299de94a5be29461444c1852e18` |

實際 compiler：NSIS v3.11，launcher SHA-256 f497e92deb9f179f7b8f7553fcb3bd04f511bb2949e5e4a2aee80a10f7b20431；Bin engine SHA-256 42850802704ecb11163f7e0329d35ee54bd288953200d4966e226d572848cfc5。Installer PE 數字 File/Product version：**0.1.13.0**；File/Product 字串：**0.1.13-rc.1**。Payload 的 app／gateway manifest：**0.1.13-rc.1**。Electron 本體版本與應用 manifest 分開記錄。實際 installer metadata 與 Root 的獨立 byte/hash/PE 檢查一致，payload ID 48f9301c301af061bbccb0ed92c87fc5d45e70b5545eb13855456f7e2bb82520。首次 ZIP 核對 helper 在最後 bytes 彙總時發生 PowerShell collection 錯誤，其 exit1 診斷保留；修正 helper 後以相同 ZIP 重跑完整逐檔核對，實際 exit0。未修改產品或 assertions。 首次 PE inspection helper 在 child PowerShell 缺少 Get-FileHash 時退出 1；保留診斷後，僅將 ignored helper 的 hash 實作改成 .NET stream，再以相同產物重跑全部檢查，實際 exit 0。

`release-manifest.json` 和 `SHA256SUMS` 隨 ZIP／EXE 保存。GitHub 保持 [PR #17](https://github.com/ivankwanpn/I-harness/pull/17) 為 draft，候選只上傳到 **[v0.1.13-rc.1 draft prerelease／Release ID 413279159](https://github.com/ivankwanpn/I-harness/releases)**，未公開／未 merge。首次上傳於 2026-10-15T05:59:50.549Z 核對，target 為完整產品來源 15563d70；四個 remote assets 均為 uploaded，names／bytes／GitHub SHA-256 與本機檔案全部相同。Manifest 為 6,007 bytes、SHA-256 0d18a5fe0646cd897050930ef0d80531a9396f01f9bd73869487a8ef522ac96c；SHA256SUMS 為 278 bytes、SHA-256 778f7a608f2b3683122d8d6499c74213ee42aaad13241942ef375e1bb48ec7a8。使用固定 release ID 保存關聯，GitHub draft 的暫存網址另記於每次 remote receipt。 最後 branch／draft target 的文件提交同步有獨立 remote receipt；產品內容以固定的 15563d70 和逐檔核對為準。

未執行安裝／移除生命週期；成功編譯與 PE 檢查不等於該生命週期取得資格。CLI builder 保留 36 個 dynamic TypeScript import 的警告；本輪只驗證明列的實際執行範圍，不把其餘路徑說成已修好。所有模型 transport 為受控 fixture／loopback，沒有使用真實模型帳戶，私人事故對話未放入 Git、測試 fixture 或 release assets。

## 審查界線、證據與尚未完成的工作

產品來源的詳細修復範圍為 `1332a465..15563d70`，36 commits、269 files、9,602 insertions／1,888 deletions；同 SHA 的完整候選 manifest 為 `460a2aee..15563d70`，81 commits、549 files、50,425 insertions／19,302 deletions。Fresh 7u／7b、resumed Task8 scoped approvals、4802 broad review 和後續完整 deltas 均有獨立報告。最後 asset rereview 為 spec PASS／quality PASS，0 個新 Critical／Important／Minor；cold-binding Minor 已修復。這是具名差異、耦合及沿用的歷史 owner 審查，不宣稱重新逐行審過全部 549 檔。穩定研究文件的獨立 evidence pass 為 factual/spec PASS，只有 internal citation 的 Minor；Root 已依該意見將 45 個內部來源 target 固定到 81bec643 的 GitHub #L 位置，並逐字核對只有 URL 和 EOF 空白改變。最後文件差異和原始收據另列於本輪的獨立文件審查報告，其狀態以實際審查收據為準，與產品來源的程式碼審查分開。

另一台電腦未隨 Git 帶來的 ignored 舊日誌／圖片／review 仍屬歷史證據缺口，沒有重建成假收據。額外 direct native-descendant 第二次超限測試屬明列的非阻塞 coverage 改善，已延期；既有六 adapter split／shared 8-call／2-shrink 保留，這不豁免任何已發現的產品缺陷或門檻。

原計畫維持原狀：E1–E9 實作待完成、E8a feasibility 已做；I1–I7 實作待完成；S0–S19 歷史上審查 27/43 原目標，剩 16 檔／13 units，S20 baseline 未跑。本次修復不冒充它們的進度。[前次續做紀錄](2026-10-15-release-candidate-progress.md)與[原 35 項決策](2026-10-15-release-candidate-rulings.md)另行保存。

完整 qualification 仍有失敗，因此 Task8／原生資格保持開放，這個 plan workspace 不清理。所有本輪報告、diff、receipt、log、capture 和包含 inline 的每一條 `Ruling:` 均保存，複本逐檔 SHA 核對：**封裝階段快照 candidate-evidence-packaging-20261015/preservation-manifest.json：366 檔、22,535,743 bytes、22 條 Ruling，manifest SHA-256 864a878aae90132dd82368e4ec65d92387bf16fdb5561fe9babc3b80fbfdb555。Root 產物收據另保留於 verification/root-candidate-20261015；最後獨立文件審查及範圍資料也保留在原 workspace，交付時另存 candidate-evidence-final-20261015 完整快照。**。以下按時間逐項保留本輪裁決、理由及判斷錯誤的代價。

## Rulings I made

1. Ruling: reuse the newly cloned dedicated requested development branch in D:/ih — the user requested this branch and the saved in-place workflow applies, with no attached worktree or existing changes — cost if wrong: subsequent local commits share this development branch; keep per-unit commits and exact review bases.

2. Ruling: resume 7u → 7b → 8 from the tracked approved shutdown contract without redispatching completed units — Git excludes the prior machine's scratch evidence but its reviewed commits and explicit pending order are durable — cost if wrong: final review relies on historical review claims for unchanged units; disclose the boundary and run fresh combined/repository/package gates.

3. Ruling: Task8 will verify the existing per-model auto overlay and apply a minimal contract bugfix only after a real failing case, alongside the user-requested proactive shipping-growth regression — this is existing model-policy/admission reliability, not a new scheduler — cost if wrong: the extra focused fixture or precedence choice needs revision; preserve explicit live host authority and manual/hard/recovery availability.

4. Ruling: interpret7b fixture-only/no-actual-installation boundary as no executed NSIS install or uninstall, including isolated TEST_ROOT; use synthetic payload/fake compiler/definition and existing safety controls — actual candidate compilation belongs toRoot after8, installed lifecycle was explicitly excluded — cost if wrong: no new executed installer lifecycle qualification, which final report must disclose.

5. Ruling: permit a summary-only opt-in closed-tool-round slicing fix and measured summary-only user opener under existing bounded-compaction scope, preserving default legacy slicing, exact original order/pairs/history and protectedtask, sharedcall/shrink/Stop/durability bounds — actual autonomous RED demonstrates lawful reduction was incorrectly unavailable — cost if wrong: summary wrapper/protocol compatibility or cut safety needs correction; actualprepared allprotocol/autonomous tests and freshreview remain required.

6. Ruling: preserve the interrupted fullgate prefix and restart a complete fixedtree verification after bounded proven corrections, rather than infer totals or resume midpopulation — unexpected shutdown removed runner and actual final receipt — cost if wrong: additional wholegate runtime; prevents claiming unexecuted projects/types/E2E/gate as passed.

7. Ruling: repair the CLI failure-result integration under Task8 when authoritative truncated/refused core errors bypass success-only metrics/ending reporting — the observed fullgate failures identify lost Session/flags/observability, not grounds to restore unsafe success — cost if wrong: shared reporting/order needs revision; keep exit1, exact once notices/raw metrics and zero rejected-turn effects under fresh review.

8. Ruling: require child seed persistence before the existing trusted native-reference inheritance snapshot, retaining parent/origin/seedLength checks and propagating storage failure — source trace finds queued seed invisible to durable backend before first child request, so parent clear can revoke the sole owner before the child grant exists — cost if wrong: extra ordered child flush or metadata revalidation needs correction; no broader authorization or fallback grants permitted.

9. Ruling: preserve raw ended-response usage/cache telemetry when main truncation/refusal is rejected, by sharing the existing internal finalization emitter while never accepting its usage as a budget anchor — focused CLI RED exposes physical input12/output7/cache400 lost before completeModelStep, even after reporting repair — cost if wrong: duplicate accounting or invalid calibration; require once-only accepted/refused/both-flag assertions, zero tool effects and fresh review.

10. Ruling: defer the reviewer's nonblocking extra native-descendant second-overflow robustness test while retaining its explicit coverage limit — both split paths correctly propagate standalone by inspection; actual6adapter local slicing and existing2-shrink/shared8-call tests already exercise required contracts — cost if wrong: a future path-specific marker regression could evade this direct native case; final review receives this limit, no product defect or qualification waiver inferred.

11. Task8 shutdown continuation sourcefreeze4802d235447ada30be97011fa104f4641e9795b4: summaryprefixd1cf7adf, failedCLI/rawmetrics91581205, nativeforkseedec8d75fb, coherentruntimefixtures4802d235. Solewriter/runner unchanged. Current scopedcovering GREEN: compaction39, protocol/usage36, autonomous1(2filtered), core48+mainfence5, metrics19/graceful6, team2(68filtered), gateway53, Desktopsearch28; fiveaffectedtypes0. Ruling: preserve sourcefreeze and start a newcomplete verify:all after exactbase diagnosis/minimal repairs; old interruptedprefix has noexit — cost: one additional repository gate. No skip/timeout/audit/grant weakening. Root readonlyreviews newimmutable delta; candidatebuildrunner still Task8untilhandoff.

12. Ruling: overlap the independent broad code review of the frozen reviewed4802d235 source with the sole runner's remaining complete qualification, without markingTask8 complete or waiving any gate — source/tests have both scoped approvals and readonly review is independent of test/build execution — cost if wrong: any later productfix invalidates affected finalrange and requires explicitdelta review plus relevant freshqualification; final approval remains conditional until actualreceipts inspected.

13. Ruling: curtail the safely identifiable owned4802qualification runner, if clean termination is available, to repair the final confirmed cold-status defect before the actual complete finalfixedtree gate — finishing a known superseded tree then repeating all work adds no final-source qualification — cost if wrong: a second partial diagnostic census, preserved with real termination/exitnull limits; no oldpartial can substitute final81/type/E2E/reachability results, and unrelatedprocesses must remain untouched.

14. Finalboundedreviewwave: broad4802review0Critical0Important1Minor coldtuple; 3f68bfff fixesviaexistingvalidatedmetadatafilter withrealRED2/10 ->service17/SDK4/types0/cold12. Superseded4802fullrunstoppedonlyverifiedownedPID16600tree(taskkill0/remainingIDs[],actualqualifierexitunknown), prefix40packagesincludesgateway494pass/1fail(CodeModefixture), not495pass. Overstatementexplicitlycorrected. e0e66c7f teachesfixtureactualboundedownedcode_wait afterforcedlegalrunningreturn; keeps16tokenpreview/15sdeadline/executiononce/2refs/allcoldforkchecks,RED1/1->GREEN2/2/types0. Sourcefreezee0e66c7f9e443100182b8d2a0a85be177d9077af; canonicalproductv2hash1defdf8b57f9552d76340133300d7ab1022efb99cc3bac063b22549531c0da8d2201files. Restartfinalcompletegatefreshlabel; no isolatedbuilduntilactualfinalresult. Ruling: supersededprefixisnotqualification; costnewcompletegate, retainsallactualfailure/stopreceipts.

15. Ruling: permit bounded native acceptance-fixture diagnosis using the installed actual usr/bin/bash.exe, which the existing production PE/MSYS recognizer explicitly supports, while preserving every byte/argv/signal/tree assertion and keeping the unaudited Git/bin launcher outside new qualification — current0010 shim is not the audited9aa identity and falls through to ConPTY, so the named MSYS fixture targets the wrong transport — cost if wrong: fixture correction may not explain the failures and the direct-entry route still needs actual execution/review; this grants no new launcher eligibility or general platform certification.

16. Ruling: bound native PSEC investigation to unchanged-source and pre-workload failure evidence, retain both actual native test failures and the failed create-close control, and continue isolated smoke/artifact work only as unpublished draft preparation — this repair did not change the helper and the existing API/schema seam offers no bounded volume-substitution control; rebuilding native policy or changing system mappings would reopen a separate platform owner — cost if wrong: a correctable native compatibility defect remains unresolved on this host; overall verify:all and native release qualification stay FAILED, no skip/green/release-ready claim or formal publication/merge is permitted.

17. Ruling: treat the unchanged guard file's same-deadline focused PASS as corroborating evidence while preserving the completed whole-run timeout and all three final failures, without another unchanged full run merely to seek a green census — actuale0 andfocused7f passed the same substantive identity checks, while the full7f case crossed its fixed5s deadline — cost if wrong: a load-sensitive identity/performance issue remains unresolved by the focused run; overall verify:all stays FAILED and the candidate remains unpublished draft with explicit native and timing qualification limits.

18. Ruling: repair the two proven bundled asset-relocation seams through the existing I_HARNESS_DIST marker, selecting sibling catalog/worker paths for the bundle and preserving current source/gateway paths — actual built CLI startup and emitted Code Mode execution fail before their required consumers can run, so successful build exits are insufficient — cost if wrong: bundle/source path selection or global marker assumptions may need revision; require meaningful actual emitted-runtime RED/GREEN, source controls, affected tests/types, fresh canonical source freeze/review, one new complete fixed-tree gate, fresh CLI/gateway outputs and six smokes plus one actual built-CLI Code Mode control. No general dynamic-import rewrite, new framework, native policy change or eligibility weakening is included.

19. Ruling: preserve the abrupt same-source155 prefix with unknown qualification exit and restart one complete gate under a fresh label with durable hidden file logging and initial/final receipts — the prior process tree disappeared without a producer result, so no prefix can qualify the source — cost if wrong: another complete-gate runtime and an unresolved host/tool interruption; this is recovery from incomplete execution, not a rerun to erase failed native/timing results, and no product, scope, worker, deadline or assertion changes are permitted.

20. Ruling: after the complete durable155 gate, run the unchanged gateway approval-rules file once under the same five-second deadline, worker limits and full authority assertions, recording exact before/after source identity while retaining its formal complete-run timeout — prior source-identical full evidence passed and this new failure is a deadline crossing, so a bounded control can distinguish reproducibility without changing behavior — cost if wrong: an approval lifecycle or load-sensitive performance defect remains unresolved; focused success cannot erase the actual full failure, and no grant/policy/assertion/deadline weakening or unchanged full rerun for a green count is permitted.

21. Ruling: correct only the ignored packaged-smoke assertion to check the gateway release manifest0.1.13-rc.1 and existing SDK initialize server-info version0.1.0 independently, retaining separate protocolVersion semantics and all runtime/effect checks — the normative7b contract preserves SDK version ownership and current host deliberately uses its documented default, so the failing assertion conflates different identities — cost if wrong: release-linked SDK advertising may require a separately scoped future contract change; candidate manifest/payload/PE ownership checks remain strict, and no product/version/protocol behavior or complete-gate result is changed to satisfy the harness.

22. Ruling: preserve the incomplete first Root portable output and unknown producer exit, then repeat only packaging in a second fresh validated directory using hidden durable file logging and initial/final flushed receipts, reusing the same independently proved155 product and qualified gateway — another foreground process group vanished without a completed artifact result, while the durable qualification runner completed — cost if wrong: extra disk space and packaging runtime while the interruption cause remains unresolved; no partial ZIP/setup can be uploaded, no source/native policy changes or complete test rerun are inferred, and final artifacts must independently pass payload/hash/PE checks.
