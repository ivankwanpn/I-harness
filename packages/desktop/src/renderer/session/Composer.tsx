import { useEffect, useState, useSyncExternalStore, useRef, type ReactNode } from "react"
import { ArrowUp, Square, Plus, FileText, X, ChevronDown, LoaderCircle } from "lucide-react"
import { useText } from "../design/i18n.ts"
import { ComposerSurface } from "../vendor/zcode/ComposerSurface.tsx"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { SlashCommands } from "./SlashCommands.tsx"
import { readFileReferences, writeFileReferences, subscribeFileReferences } from "./file-reference-drafts.ts"
import { addImageFiles, readImageDrafts, subscribeImageDrafts, writeImageDrafts } from "./image-drafts.ts"
import type { ImageInput } from "@i-harness/sdk"
import { ContextUsage } from "./ContextUsage.tsx"
import "./Composer.css"
import { useUiStore } from "../shell/ui-store.ts"
import type { FollowupDelivery } from "../../main/local-preferences.ts"
import { prepareTextAttachmentDrafts, readTextAttachmentDrafts, subscribeTextAttachmentDrafts, textAttachmentContext, writeTextAttachmentDrafts } from "./text-attachment-drafts.ts"

const DRAFT_LIMIT_BYTES = 32 * 1024
const memoryDrafts = new Map<string, string>()
let nextNativeImageId = -1
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
  executionError?: string
  running: boolean
  modelLabel?: string
  modelControl?: ReactNode
  fileReferencesEnabled?: boolean
  imageAttachmentsEnabled?: boolean
  contextUsageEnabled?: boolean
  canCompact?: boolean
  onCompact?(instructions?: string): Promise<void>
  onPrompt(text: string, context?: string, images?: ImageInput[], onAdmitted?: () => void): Promise<void>
  steeringEnabled?: boolean
  onSteer?(text: string, context?: string, images?: ImageInput[], onAdmitted?: () => void): Promise<void>
  onCancel(): void
}

export function Composer(props: ComposerProps) {
  return <div className="session-composer"><SessionComposer key={draftKey(props.workspaceId, props.sessionId)} {...props} /></div>
}

function SessionComposer({
  bridge,
  workspaceId,
  sessionId,
  canSend,
  sendReason,
  executionError,
  running,
  modelLabel,
  modelControl,
  steeringEnabled = false,
  onSteer,
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
  const references = useSyncExternalStore(subscribeFileReferences, () => readFileReferences(workspaceId, sessionId))
  const images = useSyncExternalStore(subscribeImageDrafts, () => readImageDrafts(workspaceId, sessionId))
  const texts = useSyncExternalStore(subscribeTextAttachmentDrafts, () => readTextAttachmentDrafts(workspaceId, sessionId))
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
  async function pickAttachments() {
    if (!bridge || pickLock.current) return
    pickLock.current = true; setPicking(true); setPickError(undefined)
    try {
      const result = await bridge.request({ kind: "workspace/attachments/pick", workspaceId, allowImages: imageAttachmentsEnabled }) as { paths: string[]; images: ImageInput[]; texts: { name: string; text: string }[] }
      if (!result || !Array.isArray(result.paths) || !Array.isArray(result.images) || !Array.isArray(result.texts)) throw new Error("Invalid attachment selection")
      if (!result.paths.length && !result.images.length && !result.texts.length) return
      if (!fileReferencesEnabled && (result.paths.length || result.texts.length)) throw new Error("File attachments are unavailable for this conversation")
      if (!imageAttachmentsEnabled && result.images.length) throw new Error("Image attachments are unavailable for this conversation")
      const next = [...new Set([...readFileReferences(workspaceId, sessionId), ...result.paths])]
      if (next.length > 8) throw new Error(t("最多引用 8 個工作區檔案。"))
      const currentImages = readImageDrafts(workspaceId, sessionId)
      if (currentImages.length + result.images.length > 10) throw new Error(t("最多附加 10 張圖片。"))
      const imageBytes = (image: ImageInput) => Math.floor(image.dataBase64.length * 3 / 4) - (image.dataBase64.endsWith("==") ? 2 : image.dataBase64.endsWith("=") ? 1 : 0)
      if (result.images.some((image) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mediaType) || !image.dataBase64 || imageBytes(image) > 10 * 1024 * 1024)) throw new Error(t("圖片須為 PNG、JPEG、WebP 或 GIF，且每張不超過 10 MB。"))
      if ([...currentImages, ...result.images].reduce((total, image) => total + imageBytes(image), 0) > 20 * 1024 * 1024) throw new Error(t("附加圖片合計不能超過 20 MB。"))
      const nextTexts = prepareTextAttachmentDrafts(workspaceId, sessionId, result.texts)
      if (next.length + nextTexts.length > 8) throw new Error(t("檔案附件合計不能超過 8 個。"))
      // Preflight all groups before committing. A rejected native selection
      // preserves the current session's attachments and prompt draft.
      writeFileReferences(workspaceId, sessionId, next)
      writeImageDrafts(workspaceId, sessionId, [...currentImages, ...result.images.map((image) => ({ ...image, id: nextNativeImageId-- }))])
      writeTextAttachmentDrafts(workspaceId, sessionId, nextTexts)
    } catch (reason) { setPickError(reason instanceof Error ? t(reason.message as Parameters<typeof t>[0]) : String(reason)) }
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

  const defaultDelivery = useUiStore((state) => state.followupDelivery)
  const [deliveryOverride, setDeliveryOverride] = useState<FollowupDelivery | null>(null)
  const canSteer = running && steeringEnabled && onSteer !== undefined
  const delivery = canSteer ? deliveryOverride ?? defaultDelivery : "queue"
  const deliveryLabel = t(delivery === "steer" ? "引導目前執行" : "加入佇列")
  useEffect(() => { if (!running) setDeliveryOverride(null) }, [running])
  const hasPayload = value.trim() !== "" || references.length > 0 || images.length > 0 || texts.length > 0
  const primaryBusy = sending || readingImages
  const primaryStops = running && !hasPayload && !primaryBusy
  const primaryState = primaryBusy ? "sending" : running ? "running" : "idle"
  async function send(invertDelivery = false): Promise<void> {
    const text = value
    if (!canSend || readingImages || !hasPayload || sends.get(key)?.sending) return
    publishSend(key, { sending: true })
    const selectedDelivery = canSteer && invertDelivery ? delivery === "queue" ? "steer" : "queue" : delivery
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
      const prompt = text.trim() ? text : references.length ? t("請查看引用的工作區檔案。") : texts.length ? t("請查看附加的檔案。") : t("請查看附加的圖片。")
      const contextParts = [references.length ? `${t("引用的工作區檔案（請按需讀取）：")}\n${JSON.stringify(references, null, 2)}` : "", textAttachmentContext(texts)].filter(Boolean)
      const context = contextParts.length ? contextParts.join("\n\n") : undefined
      let admitted = false
      const clearAccepted = () => {
        if (admitted) return
        admitted = true
        setDeliveryOverride(null)
        if (readDraft(workspaceId, sessionId) === text) { clearDraft(workspaceId, sessionId); setValue("") }
        if (JSON.stringify(readFileReferences(workspaceId, sessionId)) === JSON.stringify(references)) writeFileReferences(workspaceId, sessionId, [])
        const sentIds = images.map((image) => image.id).join(",")
        if (readImageDrafts(workspaceId, sessionId).map((image) => image.id).join(",") === sentIds) writeImageDrafts(workspaceId, sessionId, [])
        const sentTextIds = new Set(texts.map((attachment) => attachment.id))
        if (sentTextIds.size) writeTextAttachmentDrafts(workspaceId, sessionId, readTextAttachmentDrafts(workspaceId, sessionId).filter((attachment) => !sentTextIds.has(attachment.id)))
      }
      const dispatch = selectedDelivery === "steer" && onSteer ? onSteer : onPrompt
      await dispatch(prompt, context, images.length ? images.map(({ id: _id, ...image }) => image) : undefined, clearAccepted)
      // A successful request is accepted even if its notification was missed.
      clearAccepted()
      publishSend(key, idleSend)
    } catch (reason) {
      // The draft stays; the failure is visible.
      publishSend(key, { sending: false, error: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  return (
    <ComposerSurface onSubmit={() => { void send() }} error={error ?? executionError ?? (!canSend ? sendReason : undefined)}
      editor={
      <>
      {references.length ? <div className="composer-file-references">{references.map((path) => <span key={path} className="composer-file-chip" title={path}><span>{path}</span><button type="button" aria-label={t("移除檔案引用 {path}", { path })} onClick={() => writeFileReferences(workspaceId, sessionId, references.filter((value) => value !== path))}><X size={12} /></button></span>)}</div> : null}
      {images.length ? <div className="composer-images">{images.map((image) => <span key={image.id} className="composer-image-chip"><img alt="" src={`data:${image.mediaType};base64,${image.dataBase64}`} /><span title={image.name}>{image.name}</span><button type="button" aria-label={t("移除圖片 {name}", { name: image.name ?? "" })} onClick={() => writeImageDrafts(workspaceId, sessionId, images.filter((value) => value.id !== image.id))}><X size={12} /></button></span>)}</div> : null}
      {texts.length ? <div className="composer-file-references">{texts.map((attachment) => <span key={attachment.id} className="composer-file-chip"><FileText size={14} aria-hidden="true" /><span title={attachment.name}>{attachment.name}</span><button type="button" aria-label={t("移除附件 {name}", { name: attachment.name })} onClick={() => writeTextAttachmentDrafts(workspaceId, sessionId, texts.filter((value) => value.id !== attachment.id))}><X size={12} aria-hidden="true" /></button></span>)}</div> : null}
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
          void send(event.ctrlKey && canSteer)
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
        bridge && (fileReferencesEnabled || imageAttachmentsEnabled) ? <button type="button" className="icon-button composer-add" aria-label={t("新增附件")} title={t("新增附件")} disabled={picking || readingImages} onClick={() => { void pickAttachments() }}><Plus size={19} aria-hidden="true" /></button> : null
      }
      trailingActions={<>
        {canSteer ? <span className="composer-delivery-control">
          <select className="composer-delivery" aria-label={t("輸入處理方式")} title={t("輸入處理方式")} value={delivery} disabled={primaryBusy} onChange={(event) => setDeliveryOverride(event.target.value as FollowupDelivery)}><option value="queue">{t("加入佇列")}</option><option value="steer">{t("引導目前執行")}</option></select>
          <ChevronDown size={12} aria-hidden="true" />
        </span> : null}
        {bridge && contextUsageEnabled ? <ContextUsage bridge={bridge} workspaceId={workspaceId} sessionId={sessionId} /> : null}
        {modelControl ?? (modelLabel ? <span className="composer-model" title={modelLabel}>{modelLabel}</span> : null)}
        <button type={primaryStops ? "button" : "submit"} className="composer-send" data-state={primaryState} aria-busy={primaryBusy || undefined}
          aria-label={t(primaryStops ? "停止" : "送出")}
          title={primaryBusy ? t("操作進行中") : primaryStops ? t("停止") : running ? deliveryLabel : t("送出")}
          disabled={primaryBusy || (!primaryStops && (!canSend || !hasPayload))} onClick={primaryStops ? onCancel : undefined}>
          {primaryBusy ? <LoaderCircle size={18} className="composer-spinner" aria-hidden="true" /> : primaryStops ? <Square size={14} fill="currentColor" aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}
        </button>
      </>}
    />
  )
}
