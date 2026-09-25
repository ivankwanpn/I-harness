import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app.tsx"
import "./design/tokens.css"

const root = document.getElementById("root")
if (!root) throw new Error("Desktop root missing")
createRoot(root).render(
  <StrictMode>
    <App bridge={window.ihDesktop} />
  </StrictMode>,
)
