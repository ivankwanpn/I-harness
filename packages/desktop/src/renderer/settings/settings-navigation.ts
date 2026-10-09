import { Bell, BookOpen, Brain, Info, Puzzle, Server, Settings, Shield, type LucideIcon } from "lucide-react"
import type { ResourceKind } from "@i-harness/desktop-gateway/src/resources.ts"
import type { Message } from "../design/i18n.ts"

export type SettingsSection = "general" | "notifications" | "models" | "execution" | "subagents" | "hooks" | "mcp" | "resources" | "memory" | "plugins" | "about"
export interface SettingsLocation { section: SettingsSection; resourceKind: ResourceKind }
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
  { id: "general", label: "一般", group: "基本設定", icon: Settings, scope: "local", description: "設定此電腦的語言、外觀、視窗與整合終端。", keywords: ["general", "appearance", "外觀", "theme", "主題", "深色", "淺色", "文字大小", "font size", "界面語言", "language", "locale", "視窗位置與大小", "window", "整合終端 Shell", "terminal shell", "終端字體", "terminal font", "自動產生會話標題", "Automatic conversation titles", "auto title", "後續訊息處理方式", "queue", "steer"] },
  { id: "notifications", label: "通知", group: "基本設定", icon: Bell, scope: "desktop", description: "管理桌面通知偏好與需要處理的會話。", keywords: ["notifications", "通知歷史", "history", "背景待處理通知", "未讀", "unread", "已讀", "read", "開啟會話", "Open conversation", "background alerts"] },
  { id: "models", label: "模型與提供商", group: "Agent 設定", icon: Server, scope: "desktop", description: "設定模型、提供商連線與憑證。", keywords: ["models", "providers", "API key", "apikey", "API 金鑰", "金鑰", "credential", "憑證", "端點", "endpoint", "base URL", "protocol", "協定", "OpenAI", "Anthropic", "Gemini", "Bedrock", "connection", "連線"] },
  { id: "execution", label: "執行與權限", group: "Agent 設定", icon: Shield, scope: "workspace", capabilities: ["desktop-agent-settings", "desktop-agent-shell", "desktop-code-mode-settings", "desktop-environment-diagnostics", "desktop-context-subsystems"], description: "設定 Agent 的執行環境、Shell、沙箱與核準規則。", keywords: ["execution", "permissions", "執行與上下文", "權限與核準", "WSL", "Linux", "發行版", "sandbox", "沙箱", "approval", "核准", "核準", "審批", "read only", "唯讀", "workspace write", "完整存取", "danger full access", "Agent Shell", "bash", "pwsh", "PowerShell", "web access", "網頁存取", "network", "網路", "Code Mode", "自動壓縮", "compaction", "environment diagnostics", "環境診斷", "上下文與檢索", "context", "retrieval", "Context Mode", "context-mode", "Code Context", "claude-context", "embedding", "嵌入", "index", "索引"] },
  { id: "subagents", label: "子代理", group: "Agent 設定", icon: Brain, scope: "workspace", capabilities: ["desktop-subagents"], description: "設定子代理的角色、模型與工具權限。", keywords: ["subagents", "agent team", "角色", "role", "子代理模型", "subagent model", "工具權限", "tool permissions", "allowed tools"] },
  { id: "hooks", label: "Hooks 信任", group: "Agent 設定", icon: Shield, scope: "workspace", capabilities: ["desktop-hooks"], description: "檢視 Hooks 腳本、設定與信任授權。", keywords: ["hooks", "信任", "trust", "腳本", "script", "digest", "摘要", "handler", "設定 JSON", "grant"] },
  { id: "mcp", label: "MCP 伺服器", group: "Agent 設定", icon: Server, scope: "workspace", capabilities: ["desktop-mcp"], description: "設定 MCP 伺服器連線與可用工具。", keywords: ["MCP", "servers", "server", "伺服器連線", "stdio", "HTTP", "transport", "tools", "工具", "重新連線", "reconnect"] },
  { id: "resources", label: "資源", group: "Agent 設定", icon: BookOpen, scope: "workspace", capabilities: ["desktop-resources"], description: "以技能與命令分頁管理工作區、插件與全域資源。", keywords: ["resources", "技能", "skills", "SKILL.md", "命令", "commands", "slash", "斜線命令", "frontmatter", "Markdown", "匯入", "import", "建立資源", "resource editor", "authoring", "draft", "草稿", "來源", "source"] },
  { id: "memory", label: "記憶", group: "Agent 設定", icon: Brain, scope: "workspace", capabilities: ["desktop-memory"], description: "管理工作區記憶、筆記與保存內容。", keywords: ["memory", "工作區記憶", "notes", "筆記", "forget", "忘記", "記憶內容"] },
  { id: "plugins", label: "插件", group: "Agent 設定", icon: Puzzle, scope: "workspace", capabilities: ["desktop-plugins"], description: "管理插件安裝、啟用狀態與來源。", keywords: ["plugins", "marketplace", "packages", "套件", "安裝", "install", "卸載", "uninstall", "啟用", "enable", "來源", "source"] },
  { id: "about", label: "關於", group: "本機資料", icon: Info, scope: "desktop", description: "檢視版本、診斷資訊與授權來源。", keywords: ["about", "version", "版本", "diagnostics", "診斷資訊", "複製診斷", "copy diagnostics", "license", "授權", "third party", "第三方", "support"] },
]

const searchableFields: Partial<Record<SettingsSection, readonly Message[]>> = {
  general: ["界面語言", "外觀", "文字大小", "視窗位置與大小", "整合終端 Shell", "終端字體", "後續訊息處理方式"],
  notifications: ["背景待處理通知"],
  models: ["模型與提供商"],
  execution: ["Windows 執行後端", "WSL 發行版", "命令網路存取", "Agent Shell", "沙箱", "核準模式", "網頁存取", "自動壓縮上下文", "啟用 Context Mode", "啟用 Code Context"],
  subagents: ["角色模型", "角色名稱", "允許角色使用獨立模型"],
  hooks: ["來源與診斷", "已保存的腳本授權"],
  mcp: ["MCP 伺服器設定", "連線方式", "環境變數", "HTTP Headers"],
  resources: ["技能", "命令", "搜尋名稱或描述", "管理來源插件"],
}

export function resolveSettingsLocation(section: string | null, resourceKind: string | null = null): SettingsLocation {
  const kind = section === "skills" || section === "commands" ? section : resourceKind === "commands" ? "commands" : "skills"
  if (section === "context-subsystems" || section === "context-mode" || section === "claude-context") return { section: "execution", resourceKind: kind }
  return { section: settingsDestinations.some(destination => destination.id === section) ? section as SettingsSection : section === "skills" || section === "commands" ? "resources" : "general", resourceKind: kind }
}

export function readSettingsLocation(): SettingsLocation {
  try { return resolveSettingsLocation(localStorage.getItem("ih:settings-section"), localStorage.getItem("ih:settings-resource-kind")) }
  catch { return resolveSettingsLocation(null) }
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

export function resourceKindForSearch(query: string): ResourceKind | undefined {
  const value = normalizeQuery(query)
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
