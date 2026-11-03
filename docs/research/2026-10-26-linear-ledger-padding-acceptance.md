# Canonical／rewrite padding內容讀取限定驗收

主線已整合`238f5bfc`，來源候選`2a9628eb`，起點`f564e701`；測試檔末尾空白另以`56e9048c`正規化，完整diff檢查通過。只有OwnerLedger私有padding的一個分支及兩個既有測試／觀察器檔案改動。這關閉原funding審查R5的重複前綴讀取問題，不代表LP08耗時、R6或版本完成。

實作依根代理明確批准的LPF01／LPF02。Canonical和rewrite每次追加前仍核對實際原檔案身份、單一連結、大小、操作／配置仍有效及發出原生請求的條件；內容在入口、sync前及sync後完整檢查。原本每8KiB再讀全部已寫前綴的迴圈只保留在固定容量journal。Journal／slot／application、一般非batch操作、額度、原始恢復與後續授權均未改動。

這是明確的內容偵測時點調整：入口後若外部修改同一inode、同一大小的內容，可能先追加完這一份已獲額度的剩餘padding，再於完整hash比對拒絕；不能sync、進入後續primitive或授予新owner。已落盤的改動與清理責任保留。身份／硬連結／大小／當前操作失效仍須在下一次請求前拒絕，沒有以stat或快取代替內容驗證，也沒有連續排除任意外部寫入的承諾。

保存的原因重現有四個預期失敗，修正後四個成本控制通過。實際內容讀取為`2S+2C`，包含原快照S和已取得handle的S+2C；canonical／rewrite迴圈hash讀取為0。32／64KiB及真實一／七byte部分寫入都核對原操作與每次native條件。小型Store實際只加入一個target，因此canonical用真實九byte成長／部分續寫，rewrite覆蓋多個完整chunk；沒有捏造owner集合。

受影響控制69項、最後四個成本控制、直接型別檢查及普通gate453通過／2未選入、37檔均有保存輸出；這些人口重疊，不相加。Late drift控制保留canonical額外7bytes、rewrite額外24,569bytes，並證明sync0／後續工作0。清理控制保留真實7bytes、原生close、primary／close／inventory錯誤身份與未知收尾責任。

獨立完整審查無Critical／Important問題。唯一minor為測試末尾空白，整合時僅刪除該空行；根代理核對3個候選Git／執行內容與12個scoped來源身份，沒有因這一空行再跑套件。原受測bytes與正規化差異分開保留，沒有冒稱runtime執行了後來的空白版本。

仍需另外執行真正的101／1001耗時、熱到期、公開fork總體成本與其餘R6資料規模工作。線性padding內容讀取不是整個公開fork線性時間，沒有新增測量、放寬門檻或效能完成宣告。證據位於 `.superpowers/sdd/2026-10-26-linear-ledger-padding/`。
