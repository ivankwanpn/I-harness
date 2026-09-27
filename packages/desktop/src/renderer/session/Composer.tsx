import { useEffect, useState, useSyncExternalStore, useRef, type ReactNode } from "react"
import { ArrowUp, Square, Paperclip, ImagePlus, X } from "lucide-react"
import { useText } from "../design/i18n.ts"
import { ComposerSurface } from "../vendor/zcode/ComposerSurface.tsx"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { SlashCommands } from "./SlashCommands.tsx"
import { readFileReferences, writeFileReferences, subscribeFileReferences } from "./file-reference-drafts.ts"
import { addImageFiles, readImageDrafts, subscribeImageDrafts, writeImageDrafts } from "./image-drafts.ts"
import type { ImageInput } from "@i-harness/sdk"
import { ContextUsage } from "./ContextUsage.tsx"

const DRAFT_LIMIT_BYTES = 32 * 1024
const memoryDrafts = new Map<string, string>()
type SendState = { sending: boolean; error?: string }
const idleSend: SendState = { sending: false }
const sends = new Map<string, SendState>()
const sendListeners = new Set<() => void>()
function publishSend(key: string, state: SendState) {
  if (state === idleSend) sends.delete(key)
  else sends.set(key, state)
  for (const listener of sendListeners) listener()
}

/** localStorage can be unavailable (opaque file:// origins); memory keeps the
 * promise of a bounded per-session draft either way. */
function rawRead(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined
  } catch {
    return memoryDrafts.get(key)
  }
}

function rawWrite(key: string, value: string): void {
  memoryDrafts.set(key, value)
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The memory copy above is the fallback.
  }
}

function rawRemove(key: string): void {
  memoryDrafts.delete(key)
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Nothing else to clean up.
  }
}

export function boundedDraft(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= DRAFT_LIMIT_BYTES) return text
  let end = DRAFT_LIMIT_BYTES
  // Never end on a UTF-8 continuation byte: back up to the code point start.
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return new TextDecoder().decode(bytes.subarray(0, end))
}

export function draftKey(workspaceId: string, sessionId: string): string {
  return `ih:draft:${workspaceId}:${sessionId}`
}

export function readDraft(workspaceId: string, sessionId: string): string {
  return rawRead(draftKey(workspaceId, sessionId)) ?? ""
}

export function writeDraft(workspaceId: string, sessionId: string, text: string): void {
  rawWrite(draftKey(workspaceId, sessionId), boundedDraft(text))
}

export function clearDraft(workspaceId: string, sessionId: string): void {
  rawRemove(draftKey(workspaceId, sessionId))
}

export interface ComposerProps {
  bridge?: DesktopBridge
  workspaceId: string
  sessionId: string
  canSend: boolean
  sendReason?: string
  running: boolean
  modelLabel?: string
  modelControl?: ReactNode
  fileReferencesEnabled?: boolean
  imageAttachmentsEnabled?: boolean
  contextUsageEnabled?: boolean
  canCompact?: boolean
  onCompact?(instructions?: string): Promise<void>
  onPrompt(text: string, context?: string, images?: ImageInput[], onAdmitted?: () => void): Promise<void>
  onCancel(): void
}

export function Composer(props: ComposerProps) {
  return <SessionComposer key={draftKey(props.workspaceId, props.sessionId)} {...props} />
}

function SessionComposer({
  bridge,
  workspaceId,
  sessionId,
  canSend,
  sendReason,
  running,
  modelLabel,
  modelControl,
  fileReferencesEnabled = false,
  imageAttachmentsEnabled = false,
  contextUsageEnabled = false,
  canCompact = false,
  onCompact,
  onPrompt,
  onCancel,
}: ComposerProps) {
  const t = useText()
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const references = useSyncExternalStore(subscribeFileReferences, () => readFileReferences(workspaceId, sessionId))
  const images = useSyncExternalStore(subscribeImageDrafts, () => readImageDrafts(workspaceId, sessionId))
  const [imageError, setImageError] = useState<string>()
  const [readingImages, setReadingImages] = useState(false)
  async function attachImages(files: File[]): Promise<void> {
    if (!files.length) return
    setReadingImages(true); setImageError(undefined)
    try { await addImageFiles(workspaceId, sessionId, files) }
    catch (reason) { setImageError(reason instanceof Error ? t(reason.message as Parameters<typeof t>[0]) : String(reason)) }
    finally { setReadingImages(false) }
  }
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState<string>()
  const pickLock = useRef(false)
  async function pickFiles() {
    if (!bridge || pickLock.current) return
    pickLock.current = true; setPicking(true); setPickError(undefined)
    try {
      const result = await bridge.request({ kind: "workspace/files/pick", workspaceId }) as { paths: string[] }
      if (result.paths.length === 0) return
      const next = [...new Set([...readFileReferences(workspaceId, sessionId), ...result.paths])]
      if (next.length > 8) throw new Error(t("最多引用 8 個工作區檔案。"))
      writeFileReferences(workspaceId, sessionId, next)
    } catch (reason) { setPickError(String(reason)) }
    finally { pickLock.current = false; setPicking(false) }
  }
  const key = draftKey(workspaceId, sessionId)
  const sendState = useSyncExternalStore(
    (listener) => { sendListeners.add(listener); return () => { sendListeners.delete(listener) } },
    () => sends.get(key) ?? idleSend,
  )
  const [value, setValue] = useState(() => readDraft(workspaceId, sessionId))
  const { sending, error } = sendState
  useEffect(() => {
    if (!sending) setValue(readDraft(workspaceId, sessionId))
  }, [sending, workspaceId, sessionId])

  async function send(): Promise<void> {
    const text = value
    if (!canSend || readingImages || (text.trim() === "" && references.length === 0 && images.length === 0) || sends.get(key)?.sending) return
    publishSend(key, { sending: true })
    try {
      const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim())
      if (compact) {
        if (!onCompact || !canCompact) throw new Error(t("目前無法壓縮上下文"))
        const instructions = compact[1]?.trim()
        if (instructions && new TextEncoder().encode(instructions).length > 4096) throw new Error(t("內容超過 4096 bytes，請縮短。"))
        await onCompact(instructions || undefined)
        if (readDraft(workspaceId, sessionId) === text) { clearDraft(workspaceId, sessionId); setValue("") }
        publishSend(key, idleSend)
        return
      }
      const prompt = text.trim() ? text : references.length ? t("請查看引用的工作區檔案。") : t("請查看附加的圖片。")
      const context = references.length ? `${t("引用的工作區檔案（請按需讀取）：")}\n${JSON.stringify(references, null, 2)}` : undefined
      let admitted = false
      const clearAccepted = () => {
        if (admitted) return
        admitted = true
        if (readDraft(workspaceId, sessionId) === text) { clearDraft(workspaceId, sessionId); setValue("") }
        if (JSON.stringify(readFileReferences(workspaceId, sessionId)) === JSON.stringify(references)) writeFileReferences(workspaceId, sessionId, [])
        const sentIds = images.map((image) => image.id).join(",")
        if (readImageDrafts(workspaceId, sessionId).map((image) => image.id).join(",") === sentIds) writeImageDrafts(workspaceId, sessionId, [])
      }
      await onPrompt(prompt, context, images.length ? images.map(({ id: _id, ...image }) => image) : undefined, clearAccepted)
      // A successful request is accepted even if its notification was missed.
      clearAccepted()
      publishSend(key, idleSend)
    } catch (reason) {
      // The draft stays; the failure is visible.
      publishSend(key, { sending: false, error: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  return (
    <ComposerSurface onSubmit={() => { void send() }} error={error ?? (!canSend ? sendReason : undefined)}
      editor={
      <>
      {references.length ? <div className="composer-file-references">{references.map((path) => <span key={path} className="composer-file-chip" title={path}><span>{path}</span><button type="button" aria-label={t("移除檔案引用 {path}", { path })} onClick={() => writeFileReferences(workspaceId, sessionId, references.filter((value) => value !== path))}><X size={12} /></button></span>)}</div> : null}
      {images.length ? <div className="composer-images">{images.map((image) => <span key={image.id} className="composer-image-chip"><img alt="" src={`data:${image.mediaType};base64,${image.dataBase64}`} /><span title={image.name}>{image.name}</span><button type="button" aria-label={t("移除圖片 {name}", { name: image.name ?? "" })} onClick={() => writeImageDrafts(workspaceId, sessionId, images.filter((value) => value.id !== image.id))}><X size={12} /></button></span>)}</div> : null}
      {pickError ? <p role="alert" className="error-text">{pickError}</p> : null}
      {imageError ? <p role="alert" className="error-text">{imageError}</p> : null}
      {bridge ? <SlashCommands bridge={bridge} workspaceId={workspaceId} text={value} showCompact={onCompact !== undefined} onSelect={(name) => { const next = `/${name} `; setValue(next); writeDraft(workspaceId, sessionId, next); editorRef.current?.focus() }} /> : null}
      <textarea
        ref={editorRef}
        aria-label={t("提示")}
        className="composer-input"
        rows={3}
        value={value}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          void send()
        }}
        onPaste={(event) => {
          if (!imageAttachmentsEnabled) return
          const pasted = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"))
          if (pasted.length) { event.preventDefault(); void attachImages(pasted) }
        }}
        onChange={(event) => {
          const next = boundedDraft(event.target.value)
          setValue(next)
          writeDraft(workspaceId, sessionId, next)
        }}
        placeholder={t("輸入提示…")}
      />
      </>
      }
      leadingActions={
        <>{bridge && fileReferencesEnabled ? <button type="button" className="icon-button" aria-label={t("引用工作區檔案")} title={t("引用工作區檔案")} disabled={picking} onClick={() => { void pickFiles() }}><Paperclip size={17} /></button> : null}{imageAttachmentsEnabled ? <><input ref={imageInputRef} className="visually-hidden" aria-label={t("選擇圖片")} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void attachImages(Array.from(event.target.files ?? [])); event.target.value = "" }} /><button type="button" className="icon-button" aria-label={t("附加圖片")} disabled={readingImages} onClick={() => imageInputRef.current?.click()}><ImagePlus size={17} /></button></> : null}<span className="composer-hint">{t("Enter 送出，Shift+Enter 換行")}</span></>
      }
      trailingActions={<>
        {bridge && contextUsageEnabled ? <ContextUsage bridge={bridge} workspaceId={workspaceId} sessionId={sessionId} /> : null}
        {modelControl ?? (modelLabel ? <span className="composer-model" title={modelLabel}>{modelLabel}</span> : null)}
        <button type="submit" className="composer-send" aria-label={t("送出")} title={t("送出")} disabled={!canSend || sending || readingImages || (value.trim() === "" && references.length === 0 && images.length === 0)}>
          <ArrowUp size={18} />
        </button>
        <button type="button" className="icon-button" aria-label={t("停止")} title={t("停止")} disabled={!running} onClick={onCancel}>
          <Square size={15} />
        </button>
      </>}
    />
  )
}
