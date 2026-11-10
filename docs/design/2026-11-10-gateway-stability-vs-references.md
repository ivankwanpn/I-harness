# Gateway 穩定性與參考項目對照（2026-11-10）

## 目前觀察

- desktop 啟動後，每個 workspace 各有一個 gateway child；
- 目前 rc83 測試 instance 有 **10 個 gateway process**；
- Working Set 合計約 **2,989 MB**，單一 process 約 280–433 MB；
- process command line 顯示它以 `tsx` loader 直接執行 `gateway/cli/src/cli.ts`：

```text
--import .../tsx/dist/loader.mjs .../gateway/cli/src/cli.ts
```

也就是 packaged app 仍然在 runtime 跑 TypeScript，而不是預先 bundle 的 JS。

## 使用者截圖的 disconnect

使用者 runtime diagnostics 統計：

```text
manager-closed   119
scope-changed      1
subprocess-exited  0
```

也就是目前記錄到的 disconnect 主要是 **manager 關閉**，不是 gateway child crash。

但這不代表 gateway 穩定：

- 多 process、記憶體高；
- runtime 用 tsx 執行 TS；
- 一個 workspace 的 gateway 出問題只影響該 workspace，但 process 數量線性成長；
- renderer 看到 disconnect 只有 toast，沒有自動 reconnect。

## 參考項目

| 專案 | 架構 | 程序數 |
|---|---|---|
| DSH | Electron main → 一個 desktop-host child（Web server） | 1 |
| OpenCode | 背景 service（CLI serve），多 window 共用，ensure/reconnect | 1 |
| ZCode | 每個 window 一個 utilityProcess host | window 數 |
| Codex | app-server daemon | 1 |
| IH | 每個 workspace 一個 gateway child | workspace 數 |

參考項目的共通點：

- 一個 host 管所有 session；
- 已編譯的 JS／binary；
- host 有明確 lifecycle／fatal／restart；
- renderer 有 reconnect 状态。

## IH 的具體弱點

1. **per-workspace process**：開越多 workspace，process 與記憶體越多。
2. **runtime tsx**：每次 child 啟動要載入 tsx loader、編譯 TS，啟動慢且增加不穩定因素。
3. **沒有 host-level 狀態機**：supervisor 有 restart，但 renderer 只看到 disconnect toast。
4. **沒有 idle eviction**：所有 workspace 的 gateway 常駐。
5. **health check 只看 ping**：不能區分 busy／hung／dead。

## 建議重設計

### 方案 A：單一 desktop host（推薦長期）

```text
Electron main → desktop-host child（compiled JS）
  → workspace actors / session actors
```

- 一個 process 管所有 workspace；
- workspace 隔離改成 actor 隔離；
- host crash 由 supervisor 重啟；
- 與 DSH／OpenCode 對齊。

### 方案 B：保留 per-workspace，但修包裝與 lifecycle（低風險）

- gateway 預先 bundle 成 JS，不再 runtime tsx；
- 只啟動目前 workspace，其他 lazy；
- idle workspace eviction；
- supervisor 狀態機＋renderer 自動 reconnect。

### 方案 C：per-window host（ZCode 模式）

- 每個 window 的 workspace 共用一個 host；
- 多 window 隔離；
- 比 per-workspace 少 process。

## 建議順序

1. **先做 B**：bundle JS、lazy workspace、idle eviction；風險低、立即降記憶體與啟動時間。
2. **再做 supervisor/reconnect**：host 狀態機、fatal、自動重連。
3. **最後評估 A**：單一 host 多 workspace；需要 actor 隔離與 crash 半徑設計。

## 驗收指標

- 閒置 workspace 不常駐 gateway；
- 10 個 workspace 的 gateway 記憶體從 ~3 GB 降到 <1 GB；
- 單一 gateway cold start <1s（bundle 後）；
- disconnect 後 renderer 自動 reconnect，不需要使用者按鈕；
- host crash 有 structured reason／stderr／restart count。
