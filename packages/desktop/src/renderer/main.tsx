import React from "react"
import { createRoot } from "react-dom/client"

const root = document.getElementById("root")
if (!root) throw new Error("Desktop root missing")
createRoot(root).render(
  <React.StrictMode>
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32 }}>
      <h1>I-harness Desktop</h1>
      <p>正在連接工作區…</p>
    </main>
  </React.StrictMode>,
)
