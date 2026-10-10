# I-harness

**在自己的專案裡，與 AI 一起把工作做完。**

I-harness 是開源的 AI 程式開發工作區。連接你選擇的模型服務，開啟本機專案，讓 Agent 搜尋程式碼、讀取檔案、執行命令與完成修改；你可以隨時查看工作過程、核準操作、檢查差異或停止執行。

[下載 Windows 版](https://github.com/ivankwanpn/I-harness/releases/tag/v0.1.4) · [快速開始](#快速開始) · [功能](#在同一個工作區完成開發) · [English](README.en.md)

## 下載

目前提供 **Windows x64 · v0.1.4**，包含 Desktop 與它需要的執行環境。詳見 [0.1.4 更新紀錄](docs/releases/v0.1.4.md)。

| 版本 | 適合你，如果… | 下載 |
| --- | --- | --- |
| **安裝版** | 想要一般 Windows 安裝流程、開始功能表捷徑和解除安裝入口 | [I-harness Desktop Setup](https://github.com/ivankwanpn/I-harness/releases/download/v0.1.4/I-harness-Setup-0.1.4.exe) |
| **Portable 版** | 想解壓後直接執行，或自行選擇放置位置 | [I-harness Desktop ZIP](https://github.com/ivankwanpn/I-harness/releases/download/v0.1.4/I-harness-0.1.4.zip) |

Portable 版解壓到獨立資料夾後，執行 `I-harness.exe`。讓程式與相鄰的 `resources` 資料夾保持一起。

Desktop 不需要另裝 Node.js。模型服務需要自行配置；使用雲端模型時，網路連線、API 權限與用量由所選服務提供。

目前的 Windows 發行檔未進行程式碼簽署。

安裝器預設使用每使用者的 LocalAppData 位置，並可沿用既有安裝位置與舊版資料目錄。更新前請先關閉程式；提權更新的目的地限制與更新方式見 [Windows 安裝說明](packages/desktop/installer/README.md)。

## 快速開始

1. **開啟 I-harness**，進入「專案 → 新增專案」，設定名稱、加入本機資料夾並儲存，再進入專案建立會話。新會話可從輸入框上方搜尋及選擇專案；既有會話會在同一處顯示已保存的歸屬。
2. **設定模型**：進入「設定 → 模型與提供商」，新增你的服務端點、協議與 API 憑證，再選擇模型。
3. **選擇操作範圍**：在「執行與權限」設定唯讀、可寫入工作區或完整存取，以及適合的核準方式。
4. **建立會話並描述目標**，例如「找出登入失敗的原因，提出修正並執行相關測試」。
5. **檢查結果**：查看工作過程、待辦進度、命令輸出及檔案差異，再決定下一步。

會話可保存與繼續，也能重新命名、封存或分叉。執行中可使用停止與取消控制。

## 在同一個工作區完成開發

### 專案、會話與工作過程

以專案整理會話，切換不同工作區；左側導覽可收合成圖示列，兩側面板可調整寬度。思考、工具執行和背景通知集中在工作過程中，最終回覆保持易讀。Todo 浮層顯示進度，長會話可搜尋、跳回最新內容及整理上下文。

### 從查找程式碼到驗證修改

內建檔案搜尋、讀取、編輯與 patch 工具，搭配命令執行、互動終端、檔案預覽和差異檢視。可以先分析專案，再修改與驗證；外部專案或文件也能作為唯讀參考開啟。

Rewind 提供會話與已記錄檔案變更的還原預覽。可還原的內容以實際捕獲的紀錄為準，命令造成的所有外部副作用並不等同於檔案快照。

### 選擇你需要的模型

支援五種模型協議：

- OpenAI Responses
- OpenAI 相容的 Chat Completions
- Anthropic Messages
- Google Gemini
- AWS Bedrock Converse

可配置自訂端點、模型、上下文與輸出上限，並依需要切換會話模型。圖片能力、思考選項及其他模型功能取決於所選模型和端點的實際支援。

### 擴充工具與分派工作

接入 MCP 伺服器、使用 Skills、管理插件及執行工作流。子代理與 Team 可承接分工，並提供訊息、狀態與取消控制。工具仍依目前角色、操作範圍與核準設定執行。

### Windows 上的 Linux 執行環境

v0.1.3 包含 WSL2 Linux 後端，可在「執行與權限」選擇發行版、沙箱範圍、命令網路及工作區依賴。Bash、Code Mode 和子代理使用相同的 Linux 執行環境；IH 可管理固定版本的 Linux Node/npm。網頁存取另提供停用、快取、已索引和即時四種模式。設定方式與目前支援範圍見 [WSL2 使用指南](docs/wsl2.md)。

### 讓長任務維持可用

Code Mode 讓 Agent 用 JavaScript 組合工具，在腳本內過濾與統計結果，再把需要的內容交回模型。工具可按需探索，長輸出保留預覽與引用，成功保存的 JSON 狀態可在重啟或恢復同一會話時繼續使用。

自動與手動壓縮協助整理長會話；上下文預算會利用有效的模型用量回報校準。快取可依端點能力配置，實際收益取決於請求、模型與供應商。

### Context Mode 與 Code Context

從 v0.1.1 起提供兩個內建子系統，可從「設定 → 上下文與檢索」分別控制。兩項預設關閉；設定可作為全域預設，或只套用到目前工作區。

- **Context Mode**：將大型工具和 Code Mode 文字輸出保留在本機，以有界預覽和引用交給模型。需要細節時，可搜尋內容或分段讀取；保存的引用可隨會話恢復與分叉。
- **Code Context**：為工作區及明確加入的唯讀參考來源建立程式碼索引。詞彙搜尋使用本機索引；混合搜尋另行配置 embedding 服務，向量與索引仍存放在本機。

設定頁提供配額、保留期限、索引進度、更新、重建、取消及清理控制。停用會停止接收新工作並排空執行中的子系統工作，資料會保留；清理資料是另一項操作。外部參考來源不會因建立索引而增加寫入權限。

Context Mode 的設計參考 [context-mode](https://github.com/mksglu/context-mode)；Code Context 的設計參考 [claude-context](https://github.com/zilliztech/claude-context)。詳細功能與設定見 [內建上下文與檢索指南](docs/native-context.md)。

## 由你掌握操作

- **存取範圍**：唯讀、工作區寫入及完整存取模式。
- **核準方式**：危險操作詢問、逐項詢問、模型代審與完整存取權。
- **可見的執行**：工具請求、結果、錯誤和進度可在會話中查看。
- **停止與取消**：停止模型回合、工具工作或特定背景資源。
- **本機保存**：Desktop 的設定與會話保存在本機；模型與外部工具會按其配置接收完成任務所需的資料。

I-harness 的操作能力取決於你選擇的權限設定。完整存取模式允許更廣的操作；工作區寫入模式適合將修改限制在已授權的專案範圍內。

## 介面與整合

Desktop 提供繁體中文／英文、明暗主題、字體大小設定與通知選項。

如果你想把 Agent 接入自己的流程，專案也提供 **CLI、SDK 與 ACP**。CLI 可在沒有 Desktop 介面的環境執行任務、管理模型和查看會話。

## 從原始碼執行

開發環境需要 **Node.js ≥ 22.18、pnpm ≥ 10**；Desktop 發行包目前以 Windows x64 為目標。

```powershell
git clone https://github.com/ivankwanpn/I-harness.git
cd I-harness
pnpm install --frozen-lockfile

# 啟動 Desktop 開發環境
pnpm --filter @i-harness/desktop dev

# 查看 CLI 用法
node --import tsx apps/cli/src/index.ts help
```

建立發行包：

Windows 安裝包的建置另外需要 [NSIS 3](https://nsis.sourceforge.io/Download)；編譯器位置與參數見 [安裝版文件](packages/desktop/installer/README.md)。

```powershell
# 建立 Desktop portable 包
pnpm --filter @i-harness/desktop dist

# 從剛建立的 Desktop 包產生 Windows 安裝版
pnpm --filter @i-harness/desktop installer
```

產物集中在 `packages/desktop/release/`。開發及打包細節見 [Desktop 文件](packages/desktop/README.md)。

## 回報問題與參與

[提交問題或功能建議](https://github.com/ivankwanpn/I-harness/issues)。回報問題時，請附上版本、作業系統、模型協議、重現步驟與已遮蔽機密的錯誤資訊。

提交修改前可執行：

```powershell
pnpm verify:all
```

## 授權

I-harness 採用 [MIT License](LICENSE)。第三方程式碼的授權與聲明見 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) 及 [Desktop 第三方聲明](packages/desktop/licenses/)；發行包保留相關聲明。
