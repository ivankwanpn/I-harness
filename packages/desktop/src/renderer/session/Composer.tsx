import { useEffect, useState, useSyncExternalStore } from "react"
import { ArrowUp, Square } from "lucide-react"
import { useText } from "../design/i18n.ts"

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
  workspaceId: string
  sessionId: string
  canSend: boolean
  sendReason?: string
  running: boolean
  onPrompt(text: string): Promise<void>
  onCancel(): void
}

export function Composer(props: ComposerProps) {
  return <SessionComposer key={draftKey(props.workspaceId, props.sessionId)} {...props} />
}

function SessionComposer({
  workspaceId,
  sessionId,
  canSend,
  sendReason,
  running,
  onPrompt,
  onCancel,
}: ComposerProps) {
  const t = useText()
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
    if (!canSend || text.trim() === "" || sends.get(key)?.sending) return
    publishSend(key, { sending: true })
    try {
      await onPrompt(text)
      // Only a confirmed send clears the draft.
      if (readDraft(workspaceId, sessionId) === text) {
        clearDraft(workspaceId, sessionId)
        setValue("")
      }
      publishSend(key, idleSend)
    } catch (reason) {
      // The draft stays; the failure is visible.
      publishSend(key, { sending: false, error: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <textarea
        aria-label={t("提示")}
        className="composer-input"
        rows={3}
        value={value}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          void send()
        }}
        onChange={(event) => {
          const next = boundedDraft(event.target.value)
          setValue(next)
          writeDraft(workspaceId, sessionId, next)
        }}
        placeholder={canSend ? t("輸入提示…") : (sendReason ?? t("目前無法送出"))}
      />
      <div className="composer-actions">
        <span className="composer-hint">{t("Enter 送出，Shift+Enter 換行")}</span>
        <button type="submit" className="composer-send" aria-label={t("送出")} title={t("送出")} disabled={!canSend || sending || value.trim() === ""}>
          <ArrowUp size={18} />
        </button>
        <button type="button" className="icon-button" aria-label={t("停止")} title={t("停止")} disabled={!running} onClick={onCancel}>
          <Square size={15} />
        </button>
        {canSend || sendReason === undefined ? null : <span className="muted">{sendReason}</span>}
        {error === undefined ? null : <span className="error-text">{error}</span>}
      </div>
    </form>
  )
}
