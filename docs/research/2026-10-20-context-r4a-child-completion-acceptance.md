# R4A 子代理完成觀察資格驗收 — 2026-10-20

**接受本輪 tests-only 資格驗證。** 獨立 GPT6.1Sol spec／quality review 通過、沒有 finding，root 已讀完整審查並完成來源／receipt／seal 核對。原三項子代理狀態斷言現在透過真正的通知與原始完成 promise 驗證通過；沒有把它們宣稱為三個已修復的產品缺陷。

BASE：`fd6177c213b7a8872979f1a3d9d5bd4c2d88a4ac`。測試 commit：`3c468c70519e1a6b14939102d2ce8defb600664c`。交付 HEAD：`5de6299c1e57dbdd1cd782b8865a836876897f17`。完整範圍只有兩個測試檔與交付文件，產品程式／exports／版本0.1.13-rc.1／Session10／原拆分27/43不變。

Followup 測試改為等待原 table 的 running patch，保留舊輸出清除、新 controller、startedAt、guest 尚未放行時不能進入 waiting、完整新文字和精確兩次發布。Foreground summary 與 TaskRecord wait 的原斷言保留；resident／job 狀態則等待事先捕捉的那一次 initial completion，不會把未來的 followup 納入等待。

新增兩項 held／rejected settlement 控制經真正 captureChildResult、TaskResultOwner、createResultCapture 與 driveFollowups。原 handle identity 和 current predicate 不變；前一份結果尚未 settle 時不能清掉證據、換 controller、吃掉 inbox、啟動 guest 或多建立 capture。拒絕沿原 drive 回傳原錯誤，放行才執行一次 followup 並取得不同的新 revision。這是 inline lifecycle 證明，不是 durable artifact／權限資格。

最終五個循序 gate：tools69、settlement2、native observation1、retained/task/generation owners31，共103 tests／9 files通過，另有 subagent types exit0。原10,000ms task wait與15,000ms test bound不變。初次 public-stream spy 沒看見 prepared stream 的 instrumentation failure 保留，最終用真正 child 的 turn／step／assistant 事件驗證；不冒稱 live provider 請求次數。

Root 重算43個 sealed files、2,559個最終來源、7個來源穩定且無重疊的 receipts；五個最終 gate皆 exit0且使用同一完整 manifest。歷史三項失敗 log 的副本與原 native evidence byte-identical。核對零不一致。

Source manifest SHA256：`e7c9d9b27b0c7ec6feee3fc16a5a9b29f4390e921f7f672e968ec5e7761d4cb8`。Seal SHA256：`e3614c23d660b20d6ce0b56dfb221bcdba328b160398108168864bc9198cb426`。[交付](2026-10-20-context-r4a-child-completion-delivery.md)、[獨立審查](context-r4a-child-completion-review-20261020/review.md)、[root 核對](context-r4a-child-completion-review-20261020/root-verification.json)分別保存。Reviewer 的 verdict以 root audit為條件，該 audit已完成；沒有聲稱 reviewer另跑測試。

這一輪沒有重新 build/copy，前一輪副本證據沒有被冒稱為新測試的執行結果。沒有 live provider、installed host、自動 wake、cold recovery、全工作區或 release 資格宣稱。接續明確 result page服務／host transport／Desktop卡片，再完成其餘 R4A/R4B/C/R5/R6；沒有 push、merge、tag 或 release。
