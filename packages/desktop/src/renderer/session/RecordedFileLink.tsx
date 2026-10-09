import { useId, useRef } from "react"
import { ExternalLink } from "lucide-react"
import { useText } from "../design/i18n.ts"
import { useProjectFilesText } from "../review/project-files-text.ts"
import { toolExternalFileTarget, toolFilePath, toolProjectFileRef, type FileNavigation, type ProjectFileNavigation } from "./file-navigation.ts"

export function RecordedFileLink({ name = "read", args, navigation, location, compact = false }: { name?: string; args: unknown; navigation?: FileNavigation; location?: Omit<ProjectFileNavigation, "nonce">; compact?: boolean }) {
  const t = useText(), pf = useProjectFilesText()
  const id = useId(), count = useRef(0)
  const projectNavigation = !!navigation?.projectRoots && !!navigation.onOpenProjectFile
  const projectFile = navigation?.workspaceId && navigation.projectRoots && navigation.onOpenProjectFile ? toolProjectFileRef(name, args, navigation.workspaceId, navigation.projectRoots) : undefined
  const path = projectFile?.path ?? (navigation && !projectNavigation ? toolFilePath(name, args, navigation.workspacePath) : undefined)
  const external = !path && navigation?.onOpenExternalFile ? toolExternalFileTarget(name, args) : undefined
  const shown = path ? `${path}${location ? `:${location.line}` : ""}` : external ? `${external.reference.path}${location ? `:${location.line}` : ""}` : undefined
  if (!shown || !navigation) return null
  const located = () => location ? { ...location, nonce: `${id}:${++count.current}` } : undefined
  return path ? <button type="button" className="tool-file-link link-button" title={projectFile ? `${projectFile.workspaceId} · ${shown}` : shown} aria-label={t("在成果面板開啟 {path}", { path: shown })} onClick={() => {
    if (projectFile && navigation.onOpenProjectFile) { const position = located(); navigation.onOpenProjectFile({ ...projectFile, ...(position ? { navigation: position } : {}) }) }
    else navigation.onOpenFile(path)
  }}>{compact ? <ExternalLink size={14} aria-hidden="true" /> : shown}</button> : <button type="button" className="tool-file-link link-button" title={shown} aria-label={pf("唯讀開啟 {path}", { path: shown })} onClick={() => {
    const position = located(); navigation.onOpenExternalFile?.({ reference: { ...external!.reference }, ...(position ? { navigation: position } : {}) })
  }}>{compact ? <ExternalLink size={14} aria-hidden="true" /> : <>{shown} · {pf("唯讀")}</>}</button>
}
