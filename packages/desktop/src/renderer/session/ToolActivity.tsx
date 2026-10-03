import { useMemo, useState } from "react"
import { ToolSummaryRow } from "../vendor/zcode/ToolSummaryRow.tsx"
import { useText } from "../design/i18n.ts"
import { toolFilePath, toolProjectFileRef, type FileNavigation } from "./file-navigation.ts"

type ToolImage = { mediaType: string; dataBase64: string; name?: string; width?: number; height?: number }

function resultImages(output: unknown): ToolImage[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return []
  const images = (output as { images?: unknown }).images
  if (!Array.isArray(images)) return []
  return images.filter((item): item is ToolImage =>
    item !== null && typeof item === "object" && typeof item.mediaType === "string" && item.mediaType.startsWith("image/") && typeof item.dataBase64 === "string")
}

function resultFailed(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false
  const row = output as Record<string, unknown>
  return (row.error !== undefined && row.error !== null && row.error !== "") || row.ok === false
    || (typeof row.exitCode === "number" && row.exitCode !== 0)
}

function displayOutput(output: unknown, images: ToolImage[]): string {
  if (typeof output === "string") return output
  try {
    if (images.length === 0) return JSON.stringify(output, null, 2)
    const { images: _images, ...rest } = output as Record<string, unknown>
    return JSON.stringify({ ...rest, images: images.map(({ dataBase64, ...image }) => ({
      ...image,
      bytes: Math.floor(dataBase64.length * 3 / 4) - (dataBase64.match(/=+$/)?.[0].length ?? 0),
    })) }, null, 2)
  } catch { return String(output) }
}

export function ToolActivity({ name, args, output, resultReceived, isError, expanded: controlled, onToggle, navigation }: { name: string; args?: unknown; output?: unknown; resultReceived?: true; isError?: true; expanded?: boolean; onToggle?(): void; navigation?: FileNavigation }) {
  const t = useText()
  const [localExpanded, setExpanded] = useState(false)
  const expanded = controlled ?? localExpanded
  const projectFile = navigation?.workspaceId && navigation.projectRoots && navigation.onOpenProjectFile ? toolProjectFileRef(name, args, navigation.workspaceId, navigation.projectRoots) : undefined
  const path = projectFile?.path ?? (navigation ? toolFilePath(name, args, navigation.workspacePath) : undefined)
  const images = useMemo(() => expanded ? resultImages(output) : [], [expanded, output])
  const input = useMemo(() => {
    if (!expanded || args === undefined) return undefined
    if (typeof args === "string") return args
    try { return JSON.stringify(args, null, 2) } catch { return String(args) }
  }, [expanded, args])
  const text = useMemo(() => {
    if (!expanded || output === undefined) return undefined
    return displayOutput(output, images)
  }, [expanded, output, images])
  return <div className="tool-activity">
    <div className="tool-activity-heading"><ToolSummaryRow name={name} status={t(isError || resultFailed(output) ? "執行失敗" : resultReceived || output !== undefined ? "已收到結果" : "尚未回報結果")}
      label={`${t("工具詳情")} ${name}`} expanded={expanded} onToggle={onToggle ?? (() => setExpanded((value) => !value))} />
      {path && navigation ? <button type="button" className="tool-file-link link-button" title={projectFile ? `${projectFile.workspaceId} · ${path}` : path} aria-label={t("在成果面板開啟 {path}", { path })} onClick={() => projectFile && navigation.onOpenProjectFile ? navigation.onOpenProjectFile({ ...projectFile }) : navigation.onOpenFile(path)}>{path}</button> : null}</div>
    {expanded ? <div className="tool-expanded-content">{input !== undefined ? <><div className="tool-detail-label">{t("呼叫參數")}</div><pre className="tool-output">{input}</pre></> : null}<div className="tool-detail-label">{t("執行輸出")}</div><pre className="tool-output">{text ?? t(isError ? "執行失敗" : resultReceived ? "已收到結果" : "尚未回報結果")}</pre>{images.length > 0 ? <div className="tool-result-images">{images.map((image, index) => <img key={index} src={`data:${image.mediaType};base64,${image.dataBase64}`} alt={image.name || `${t("圖片")} ${index + 1}`} loading="lazy" decoding="async" />)}</div> : null}</div> : null}
  </div>
}
