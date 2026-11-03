# 拆分重合核對證據

本目錄對應[重合地圖](../2026-10-15-context-decomposition-overlap.md)與[ContextEngine框架](../../superpowers/specs/2026-10-15-context-engine-framework.md)。是設計／量測證據，沒有產品實作。

- `census.json`：HEAD `1b605d0e` 下891個tracked maintained product source的候選量測、43個原目標的目前尺寸、2個原清單外候選。
- `census.mjs`：使用TypeScript AST量測函式，沿用原>=800檔案／>=250函式／>=18,000字元密集函式門檻；只讀產品來源並寫本目錄JSON。tests／scripts／vendor／generated排除；其他語言函式未用TS AST分析。
- `framework-review.md`：GPT6.1Sol的設計完整度審查、四項補強建議及修正／計數覆核結果。
- `validation.json`：本輪文件連結、原台帳數字、範圍集合、產品來源未改動的檢查收據。

重跑量測（repository root）：

```powershell
node docs/refactoring/context-overlap-2026-10-15/census.mjs
```

重跑會更新census的時間、HEAD與目前尺寸，不重寫舊43檔的baseline或reviewed狀態。候選門檻是研究訊號，不能單憑小於門檻標記任務完成。原先27/43的reviewed證據屬歷史來源，不代表本輪重新跑過所有產品測試。
