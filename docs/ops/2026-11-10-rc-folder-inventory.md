# 舊開發版本資料夾清單（2026-11-10）

## 總結

- `release-rc*`：20 個資料夾，合計 **22.3 GB**；
- `build/desktop-installer` staging：**430.4 MB**；
- `D:\ih0113rc30test_env\app`：**740.8 MB**；
- `userdata-clean`：**9.3 MB**；
- 目前 D: 剩餘 **36.7 GB**。

## release-rc* 清單

| 資料夾 | 大小 | 內容 | GitHub release | 建議 |
|---|---:|---|---|---|
| rc63 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc64 | 1.02 GB | zip | 無 | 刪除 |
| rc65 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc66 | 1.02 GB | zip | 無 | 刪除 |
| rc67 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc68 | 1.02 GB | zip | 無 | 刪除 |
| rc69 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc70 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc71 | 1.02 GB | zip | 無 | 刪除 |
| rc72 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc73 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc74 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc75 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc76 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc77 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc78 | 1.02 GB | zip | 無 | 刪除 |
| rc79 | 1.17 GB | zip＋setup | 有 | 刪除 |
| rc80 | 1.17 GB | zip＋setup | 有 | 可保留作離線備份 |
| rc81 | 1.02 GB | zip | 無 | 刪除 |
| **rc82** | **1.17 GB** | zip＋setup | 有 | **保留（現行版本）** |

已發布舊版都在 GitHub release；rc64/66/68/71/78/81 從未發布，刪除後不保留。

## 其他候選

| 路徑 | 大小 | 建議 |
|---|---:|---|
| `I-harness\build\desktop-installer\*` | 430.4 MB | 刪除全部 staging |
| `D:\ih0113rc30test_env\app` | 740.8 MB | 確認無測試依賴後可刪 |
| `D:\ih0113rc30test_env\userdata-clean` | 9.3 MB | 可刪 |
| `D:\ih0113rc30test_env\userdata-big` | 204.1 MB | 保留（rc81/rc82 實測） |
| `D:\ih0113rc30test_env\userdata` | 14.2 MB | 保留 |
| `D:\ih0113rc30test_env\config` | 0.9 MB | 保留 |
| `D:\ih0113rc30test_env\testdata` | 0.1 MB | 保留 |
| `I-harness\.tmp` | 5 MB | 只清 log，保留 cdp.mjs |
| `I-harness\build\tools` | 13.6 MB | 保留（NSIS） |

## 保守清理方案

保留 `release-rc82`、`config`、`testdata`、`userdata`、`userdata-big`、`build/tools`。

刪除 `release-rc63` 至 `release-rc81`、`build/desktop-installer/*`、`userdata-clean`。

可回收約 **21.5 GB**（不含 `app`）。

## 進取清理方案

再加 `D:\ih0113rc30test_env\app`，可回收約 **22.2 GB**。

## 建議指令（尚未執行）

```powershell
$repo='D:\dsh_ih_development\I-harness'
Get-ChildItem "$repo\packages\desktop" -Directory -Filter 'release-rc*' |
  Where-Object { $_.Name -ne 'release-rc82' } |
  Remove-Item -Recurse -Force
Remove-Item "$repo\build\desktop-installer\*" -Recurse -Force
Remove-Item 'D:\ih0113rc30test_env\userdata-clean' -Recurse -Force
```

執行前：

1. 不再需要 rc63–rc81 的本地 installer；
2. GitHub release 仍可作舊版備份；
3. 先關閉所有 I-harness 程序。
