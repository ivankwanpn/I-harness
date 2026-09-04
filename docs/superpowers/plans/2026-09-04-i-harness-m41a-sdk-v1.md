# M41a 執行計劃 — SDK wire v1

日期：2026-09-04 · spec：`docs/superpowers/specs/2026-09-04-m41a-sdk-v1-design.md`。

## 分組

- **G1（sdk wire v1）✅** protocol/server/client 三處 + apps/cli list 源 + tests（29/29）+ contracts.md 附錄。
- **G2（tui remote 消費）✅** remote.ts v1 消費（history/list + v0 降級）+ e2e 真 v2 子進程（12/12）+ 255/255。
- **G3（docs + 驗證）✅** README/CAPABILITIES 增量 + §11 缺口移出 + 全量。

## 執行發現

1. **回放首事件 = turn/start**（core-agent 循環先追加 turn 邊界——live 與 replay 同序；測試斷言 `replayed[0]=turn/start`、首用戶事件 = `replayed[1]`）。
2. **CLI 列表行只載 id(+title?)**（profile() 表頭行；updatedAt/turnCount 契約可選——client 端誠實默認填充；行豐富提議 G3 後續）。
3. **命名差異調和**：server 落 `listingUnavailable?`（spec 曾寫 status 場）——G2 雙標記歸一化接受。
4. v0 降級路徑實證：舊 server 下 replay=[]/list=stub 恰如事前。
