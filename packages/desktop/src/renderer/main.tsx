import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app.tsx"
import { WindowVisibilityProvider } from "./window-visibility.tsx"
import "./design/tokens.css"
import "./vendor/zcode/styles.css"
import "./design/controls.css"

const root = document.getElementById("root")
if (!root) throw new Error("Desktop root missing")
createRoot(root).render(
  <StrictMode>
    <WindowVisibilityProvider bridge={window.ihDesktop}>
      <App bridge={window.ihDesktop} />
    </WindowVisibilityProvider>
  </StrictMode>,
)
