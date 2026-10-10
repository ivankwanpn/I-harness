// Electron acceptance harness: real packaged main/preload/renderer and gateway,
// with an isolated profile and hidden window. Run with the candidate executable.
const {app, BrowserWindow} = require("electron")
const {mkdirSync, mkdtempSync, writeFileSync} = require("node:fs")
const {join, resolve} = require("node:path")
const {pathToFileURL} = require("node:url")
const candidate = resolve(process.argv[2])
const root = mkdtempSync(resolve(".tmp/wsl-product-desktop-ui-"))
const profile = join(root, "profile"), config = join(root, "config"), workspace = join(root, "workspace")
for (const path of [profile, config, workspace]) mkdirSync(path)
app.setPath("userData", profile)
process.env.IH_CONFIG_DIR = config
// An explicit harness entry makes Electron classify itself as unpackaged;
// exercise the bundled gateway launcher used by the candidate's normal entry.
Object.defineProperty(app, "isPackaged", {get: () => true})
Object.defineProperty(process, "resourcesPath", {value: join(candidate, "resources")})
app.on("browser-window-created", (_event, window) => {window.show = () => {}})
writeFileSync(join(profile, "workspaces.json"), JSON.stringify([{id: "wsl-ui", path: workspace, label: "WSL 設定驗收"}]))
writeFileSync(join(profile, "desktop-preferences.json"), JSON.stringify({locale: "zh", sidebarCollapsed: false}))
writeFileSync(join(config, "settings.json"), JSON.stringify({windowsSandboxBackend: "wsl", wslExecution: {distribution: "Ubuntu", networkAccess: false, workspaceDependencies: false}, webSearchMode: "cached", sandboxMode: "workspace-write"}))
const pause = ms => new Promise(done => setTimeout(done, ms))
async function until(check, description) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {const result = await check(); if (result) return result; await pause(100)}
  throw new Error(`UI did not reach ${description}`)
}
;(async () => {
  await import(pathToFileURL(join(candidate, "resources/app/out/main/index.js")).href)
  const window = await until(async () => BrowserWindow.getAllWindows()[0], "main window")
  window.setSize(1500, 1100)
  await until(() => window.webContents.executeJavaScript(`document.readyState === 'complete' && !!document.querySelector('button')`), "renderer")
  await until(() => window.webContents.executeJavaScript(`(() => {const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='設定'||x.getAttribute('aria-label')==='設定');if(b){b.click();return true}return false})()`), "settings entry")
  await until(() => window.webContents.executeJavaScript(`(() => {const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='執行與上下文');if(b){b.click();return true}return false})()`), "execution settings")
  await until(() => window.webContents.executeJavaScript(`document.body.innerText.includes('WSL2 Linux') && document.body.innerText.includes('工作區依賴')`), "real settings")
  const state = await window.webContents.executeJavaScript(`window.ihDesktop.request({kind:'desktop/wsl/diagnose',workspaceId:'wsl-ui'})`)
  await window.webContents.executeJavaScript(`(() => {const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='診斷執行環境');if(b)b.click()})()`)
  await pause(1500)
  const text = await window.webContents.executeJavaScript("document.body.innerText")
  const png = await window.webContents.capturePage()
  writeFileSync(join(root, "settings.png"), png.toPNG())
  writeFileSync(join(root, "evidence.json"), JSON.stringify({candidate, profile, state, text, packaged: app.isPackaged, visible: window.isVisible()}, null, 2))
  console.log(`Desktop settings screenshot: ${join(root, "settings.png")}`)
  app.quit()
})().catch(error => {console.error(error); app.exit(1)})
