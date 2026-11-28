import { BarChart3, Bell, Folder, Folders, Brain, Info, Puzzle, Server, Settings, Shield, Sparkles, ScrollText, type LucideIcon } from "lucide-react"
import type { Message } from "../design/i18n.ts"
import type { ExtensionTab } from "./ExtensionsSettings.tsx"

export type SettingsSection = "general" | "notifications" | "models" | "coding-plans" | "usage" | "execution" | "subagents" | "hooks" | "extensions" | "projects" | "workspaces" | "servers" | "memory" | "about" | "log"
export interface SettingsLocation { section: SettingsSection; extensionTab: ExtensionTab }
export interface SettingsDestination {
  id: SettingsSection
  label: Message
  group: "基本設定" | "Agent 設定" | "本機資料"
  icon: LucideIcon
  description: Message
  keywords: readonly string[]
  scope: "local" | "desktop" | "workspace"
  capabilities?: readonly string[]
}

export const settingsDestinations: readonly SettingsDestination[] = [
  { id: "log", label: "診斷記錄", group: "本機資料", icon: ScrollText, scope: "desktop", description: "檢視安全的模型重試、錯誤與連線記錄。", keywords: ["log", "diagnostics", "error", "retry", "reconnect", "記錄", "日誌", "診斷", "重試", "錯誤", "重新連線"] },
  { id: "usage", label: "用量統計", group: "本機資料", icon: BarChart3, scope: "desktop", description: "檢視模型請求、Token、快取與預估 API 費用。", keywords: ["usage", "statistics", "analytics", "tokens", "cost", "cache", "用量", "統計", "費用", "快取", "請求"] },
  { id: "coding-plans", label: "Coding Plans", group: "Agent 設定", icon: Sparkles, scope: "desktop", description: "連接訂閱帳號，管理授權與可用模型。", keywords: ["coding plans", "subscription", "Codex", "ChatGPT", "OpenAI", "OAuth", "訂閱", "帳號", "登入", "用量", "額度", "重置卡", "reset cards", "usage", "sign in", "plan"] },
  { id: "general", label: "一般", group: "基本設定", icon: Settings, scope: "local", description: "設定此電腦的語言、外觀、視窗與輸入。", keywords: ["general", "appearance", "外觀", "theme", "主題", "深色", "淺色", "文字大小", "font size", "界面語言", "language", "locale", "視窗位置與大小", "window", "自動產生會話標題", "Automatic conversation titles", "auto title", "後續訊息處理方式", "queue", "steer"] },
  { id: "projects", label: "專案", group: "基本設定", icon: Folders, scope: "desktop", description: "管理專案、成員資料夾與專案擴充功能。", keywords: ["projects", "專案管理", "成員", "folders", "primary", "主要資料夾"] },
  { id: "workspaces", label: "工作區", group: "基本設定", icon: Folder, scope: "desktop", description: "查看這部電腦上的資料夾、工作樹與所屬專案。", keywords: ["workspace", "worktree", "folders", "工作樹", "資料夾"] },
  { id: "servers", label: "伺服器", group: "本機資料", icon: Server, scope: "desktop", description: "查看本機執行主機與工作區連線，設定整合終端。", keywords: ["server", "gateway", "host", "runtime", "connection", "shell", "終端", "待命", "程序"] },
  { id: "extensions", label: "擴充功能", group: "Agent 設定", icon: Puzzle, scope: "desktop", description: "管理共用擴充功能，或查看目前資料夾可用的項目。", keywords: ["extensions", "MCP", "stdio", "HTTP", "tools", "工具", "plugins", "marketplace", "packages", "套件", "插件", "install", "resources", "技能", "skills", "SKILL.md", "命令", "commands", "slash", "frontmatter", "Markdown", "匯入", "建立資源", "authoring", "草稿", "來源"] },
  { id: "notifications", label: "通知", group: "基本設定", icon: Bell, scope: "desktop", description: "管理桌面通知偏好與需要處理的會話。", keywords: ["notifications", "通知歷史", "history", "背景待處理通知", "未讀", "unread", "已讀", "read", "開啟會話", "Open conversation", "background alerts", "system sound", "notifications", "提示音", "背景通知", "工作完成", "需要處理", "需要核准", "等待回答", "執行錯誤", "權限", "permission", "error"] },
  { id: "models", label: "模型與提供商", group: "Agent 設定", icon: Server, scope: "desktop", description: "設定模型、提供商連線與憑證。", keywords: ["models", "providers", "API key", "apikey", "API 金鑰", "金鑰", "credential", "憑證", "端點", "endpoint", "base URL", "protocol", "協定", "OpenAI", "Anthropic", "Gemini", "Bedrock", "connection", "連線"] },
  { id: "execution", label: "執行與權限", group: "Agent 設定", icon: Shield, scope: "workspace", capabilities: ["desktop-agent-settings", "desktop-agent-shell", "desktop-code-mode-settings", "desktop-environment-diagnostics", "desktop-context-subsystems", "desktop-instructions"], description: "設定 Agent 的執行環境、Shell、沙箱與核準規則。", keywords: ["execution", "permissions", "執行與上下文", "權限與核準", "WSL", "Linux", "發行版", "sandbox", "沙箱", "approval", "核准", "核準", "審批", "read only", "唯讀", "workspace write", "完整存取", "danger full access", "Agent Shell", "bash", "pwsh", "PowerShell", "web access", "網頁存取", "network", "網路", "Code Mode", "自動壓縮", "compaction", "environment diagnostics", "環境診斷", "上下文與檢索", "context", "retrieval", "instructions", "指令來源", "AGENTS.md", "Context Mode", "context-mode", "Code Context", "claude-context", "embedding", "嵌入", "index", "索引"] },
  { id: "subagents", label: "子代理", group: "Agent 設定", icon: Brain, scope: "workspace", capabilities: ["desktop-subagents"], description: "設定子代理的角色、模型與工具權限。", keywords: ["subagents", "角色", "role", "子代理模型", "subagent model", "工具權限", "tool permissions", "allowed tools"] },
  { id: "hooks", label: "Hooks 信任", group: "Agent 設定", icon: Shield, scope: "workspace", capabilities: ["desktop-hooks"], description: "檢視 Hooks 腳本、設定與信任授權。", keywords: ["hooks", "信任", "trust", "腳本", "script", "digest", "摘要", "handler", "設定 JSON", "grant"] },
  { id: "memory", label: "記憶", group: "Agent 設定", icon: Brain, scope: "workspace", capabilities: ["desktop-memory"], description: "管理工作區記憶、筆記與保存內容。", keywords: ["memory", "工作區記憶", "notes", "筆記", "forget", "忘記", "記憶內容"] },
  { id: "about", label: "關於", group: "本機資料", icon: Info, scope: "desktop", description: "檢視版本、診斷資訊與授權來源。", keywords: ["about", "version", "版本", "diagnostics", "診斷資訊", "複製診斷", "copy diagnostics", "license", "授權", "third party", "第三方", "support"] },
]

const searchableFields: Partial<Record<SettingsSection, readonly Message[]>> = {
  general: ["界面語言", "外觀", "文字大小", "視窗位置與大小", "後續訊息處理方式", "模型自動重試", "模型重試次數"],
  extensions: ["MCP 伺服器設定", "連線方式", "環境變數", "HTTP Headers", "技能", "命令", "搜尋名稱或描述", "管理來源插件"],
  servers: ["整合終端 Shell", "終端字體"],
  notifications: ["背景待處理通知"],
  models: ["模型與提供商"],
  execution: ["Windows 執行後端", "WSL 發行版", "命令網路存取", "Agent Shell", "沙箱", "核準模式", "網頁存取", "自動壓縮上下文", "啟用 Context Mode", "啟用 Code Context"],
  subagents: ["角色模型", "角色名稱", "允許角色使用獨立模型"],
  hooks: ["來源與診斷", "已保存的腳本授權"],
}

export function resolveSettingsLocation(section: string | null, savedTab: string | null = null): SettingsLocation {
  const tabs = ["mcp", "plugins", "skills", "commands"] as const
  const legacyTab = tabs.find(tab => tab === section)
  const extensionTab = legacyTab ?? tabs.find(tab => tab === savedTab) ?? (section === "resources" ? "skills" : "mcp")
  if (legacyTab || section === "resources") return { section: "extensions", extensionTab }
  if (section && ["context-subsystems", "context-mode", "claude-context"].includes(section)) return { section: "execution", extensionTab }
  return { section: settingsDestinations.find(destination => destination.id === section)?.id ?? "general", extensionTab }
}

export function readSettingsLocation(): SettingsLocation {
  try {
    const section = localStorage.getItem("ih:settings-section")
    return resolveSettingsLocation(section, localStorage.getItem(section === "resources" ? "ih:settings-resource-kind" : "ih:settings-extension-tab"))
  } catch { return resolveSettingsLocation(null) }
}

const normalizeQuery = (value: string) => value.toLocaleLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim()
export function findSettingsDestinations(query: string, translate: (text: Message) => string): SettingsDestination[] {
  const terms = normalizeQuery(query).split(" ").filter(Boolean)
  return settingsDestinations.filter(destination => {
    const fields = searchableFields[destination.id] ?? []
    const source = [destination.id, destination.label, destination.group, ...destination.keywords, translate(destination.label), translate(destination.group), ...fields.flatMap(field => [field, translate(field)])]
    const text = normalizeQuery(source.join(" "))
    return terms.every(term => text.includes(term))
  })
}

export function extensionTabForSearch(query: string): ExtensionTab | undefined {
  const value = normalizeQuery(query)
  if (/mcp|stdio|http/.test(value)) return "mcp"
  if (/plugin|marketplace|插件|外掛/.test(value)) return "plugins"
  if (/\bcommands?\b|\bslash\b|命令/.test(value)) return "commands"
  if (/\bskills?\b|skill\.md|技能/.test(value)) return "skills"
  return undefined
}

export function settingsAvailability(destination: SettingsDestination, context: { workspaceId?: string; connected: boolean; capabilities: Record<string, string[]>; capabilitiesReady: boolean }): "available" | "workspace" | "connection" | "pending" | "unsupported" {
  if (destination.scope === "local") return "available"
  if (destination.scope === "workspace" && !context.workspaceId) return "workspace"
  if (!context.connected) return "connection"
  if (destination.scope !== "workspace") return "available"
  if (!context.capabilitiesReady) return "pending"
  return destination.capabilities?.some(capability => context.capabilities[capability]?.includes("1")) ? "available" : "unsupported"
}
