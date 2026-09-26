// Development-only visual fixture. Not an Electron entry or backend connection.
import { createRoot } from "react-dom/client"
import { ApprovalCard } from "./interaction/ApprovalCard.tsx"
import { Composer } from "./session/Composer.tsx"
import "./design/tokens.css"
import "./vendor/zcode/styles.css"

createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 24, maxWidth: 850, margin: "0 auto", height: "100%", overflow: "auto" }}>
    <p className="muted">UI 元件驗收 · 模擬請求 · 不連接後端</p>
    <h1 style={{ fontSize: 22 }}>ZCode 審批卡移植</h1>
    <p className="muted">選項只改變選中狀態；確認按鈕在此預覽中不執行操作。</p>
    <ApprovalCard requestId="preview-ready" description="write_file · playground/desktop-ui-probe.md" busy={false} onConfirm={() => {}} />
    <h2 style={{ fontSize: 16, marginTop: 28 }}>提交中</h2>
    <ApprovalCard requestId="preview-busy" description="write_file · playground/desktop-ui-probe.md" busy onConfirm={() => {}} />
    <h2 style={{ fontSize: 16, marginTop: 28 }}>輸入區 · 模擬送出會保留草稿</h2>
    <Composer workspaceId="visual-fixture" sessionId="composer" modelLabel="示例模型（非後端資料）" canSend running={false} onCancel={() => {}} onPrompt={async () => { throw new Error("純 UI 預覽，不送到後端") }} />
  </main>,
)
