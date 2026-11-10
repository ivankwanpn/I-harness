# 單一 Desktop Host 評估（2026-11-10）

## 目前架構

```text
Electron main
  → 每個 workspace 一個 gateway child（compiled JS）
     → sessions / turns
```

已做的改善：

- compiled gateway JS；
- 啟動只載入目前 workspace；
- idle gateway eviction；
- disconnect 自動重試。

## 實測

- 10 個 workspace 的 userdata：啟動 gateway **1** 個；
- 展開另一個專案才變成 2 個；
- 舊版啟動 10 個 gateway，Working Set 約 2,989 MB；compiled JS 後約 1,508 MB；
- 單一 gateway 約 150 MB；idle eviction 後只留活躍 workspace。

## 單一 host 的優點

- process 數量固定，不隨 workspace 成長；
- 共用 provider／tool registry／cache；
- supervisor 只需管理一個 child。

## 單一 host 的代價

- 一個 crash 影響所有 workspace，需要 actor 隔離；
- 需要 workspace registry、per-workspace session dir、project scope 路由；
- session 排程、queue、event fan-out 全部要改成 actor；
- 現有 per-workspace supervisor／health／fatal 路徑要重寫；
- 舊 session 的 workspace 綁定要遷移。

## 是否值得現在做

**不值得。**

理由：

1. 啟動已從 10 個 gateway 降到 1 個；
2. idle eviction 已把非活躍 workspace 回收；
3. 單一 host 只在他同時活躍多個 workspace 時才有明顯記憶體優勢；
4. 目前 per-workspace 的 crash 半徑更小，符合穩定性優先。

## 何時重新評估

- 同時活躍 workspace > 3；
- gateway process 數 > 5 且記憶體 > 1 GB；
- 跨 workspace 查詢／任務成為常態；
- supervisor 無法可靠處理多 process。

## 建議

保留目前 per-workspace + lazy + idle + compiled JS；
先補 supervisor 狀態機與 auto reconnect 的 UI 驗證，
不要現在重寫成單一 host。
