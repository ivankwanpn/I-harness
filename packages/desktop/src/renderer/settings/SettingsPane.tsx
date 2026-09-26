import { useState } from "react"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { useLocale, useText } from "../design/i18n.ts"
import { usePreferences, type Appearance } from "../design/preferences.ts"
import { useUiStore } from "../shell/ui-store.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { NativeSettings } from "./NativeSettings.tsx"

export function SettingsPane({ workspace, onMemory, onClose, bridge }: { workspace?: WorkspaceEntry; onMemory?: () => void; onClose(): void; bridge?: DesktopBridge }) {
  const t = useText()
  const [tab, setTab] = useState<"general" | "workspace" | "about">("general")
  const locale = useLocale((state) => state.locale)
  const setLocale = useLocale((state) => state.setLocale)
  const preferences = usePreferences()
  const reviewOpen = useUiStore((state) => state.reviewOpen)
  const toggleReview = useUiStore((state) => state.toggleReview)
  return <section className="settings-pane" aria-label={t("設定")}>
    <nav className="settings-navigation" aria-label={t("設定分類")}>
      <button className="row-button" onClick={onClose}>{t("返回會話")}</button>
      {(["general", "workspace", "about"] as const).map((id) => <button key={id} className="row-button" aria-current={id === tab ? "page" : undefined} onClick={() => setTab(id)}>{t(id === "general" ? "一般" : id === "workspace" ? "工作區" : "關於")}</button>)}
    </nav>
    <div className="settings-content">
      <h1>{t(tab === "general" ? "一般" : tab === "workspace" ? "工作區" : "關於")}</h1>
      {tab === "general" ? <>
        <SettingsGroup>
          <SettingsRow label={t("語言")} control={<select aria-label={t("語言")} value={locale} onChange={(event) => setLocale(event.target.value === "en" ? "en" : "zh-TW")}><option value="zh-TW">繁體中文</option><option value="en">English</option></select>} />
          <SettingsRow label={t("外觀")} control={<select aria-label={t("外觀")} value={preferences.appearance} onChange={(event) => preferences.update({ appearance: event.target.value as Appearance })}><option value="dark">{t("深色")}</option><option value="light">{t("淺色")}</option><option value="system">{t("跟隨系統")}</option></select>} />
          <SettingsRow label={t("文字大小")} control={<select aria-label={t("文字大小")} value={preferences.fontSize} onChange={(event) => preferences.update({ fontSize: Number(event.target.value) })}>{[13, 14, 16, 18].map((size) => <option key={size} value={size}>{size}px</option>)}</select>} />
          <SettingsRow label={t("顯示側欄")} control={<input type="checkbox" aria-label={t("顯示側欄")} checked={!preferences.sidebarCollapsed} onChange={(event) => preferences.update({ sidebarCollapsed: !event.target.checked })} />} />
          <SettingsRow label={t("成果檢查")} control={<input type="checkbox" aria-label={t("成果檢查")} checked={reviewOpen} onChange={toggleReview} />} />
        </SettingsGroup>
        <p className="muted">{t("外觀偏好只儲存在此電腦。")}</p>
        <button className="primary-button" onClick={preferences.reset}>{t("重設外觀偏好")}</button>
        {bridge ? <NativeSettings bridge={bridge} /> : null}
      </> : tab === "workspace" ? <>
        {workspace ? <SettingsGroup><SettingsRow label={workspace.label} description={workspace.path} control={onMemory ? <button className="primary-button" onClick={onMemory}>{t("工作區記憶")}</button> : null} /></SettingsGroup> : <p className="muted">{t("尚未開啟工作區")}</p>}
      </> : <SettingsGroup><SettingsRow label="I-harness Desktop" description={t("本機 Agent 工作台；使用既有後端執行任務。") } control={<span>MIT</span>} /><SettingsRow label={t("第三方 UI 程式碼")} description={t("部分介面改編自 ZCode，依 Apache-2.0 保留授權與來源說明。") } control={<span>Apache-2.0</span>} /></SettingsGroup>}
    </div>
  </section>
}
