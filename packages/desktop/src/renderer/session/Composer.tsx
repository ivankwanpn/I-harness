import { useEffect, useState } from "react"

const DRAFT_LIMIT_BYTES = 32 * 1024
const memoryDrafts = new Map<string, string>()

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

export function Composer({
  workspaceId,
  sessionId,
  canSend,
  sendReason,
  running,
  onPrompt,
  onCancel,
}: ComposerProps) {
  const [value, setValue] = useState(() => readDraft(workspaceId, sessionId))
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)

  useEffect(() => {
    setValue(readDraft(workspaceId, sessionId))
    setError(undefined)
  }, [workspaceId, sessionId])

  async function send(): Promise<void> {
    const text = value
    if (!canSend || text.trim() === "" || sending) return
    setSending(true)
    setError(undefined)
    try {
      await onPrompt(text)
      // Only a confirmed send clears the draft.
      clearDraft(workspaceId, sessionId)
      setValue("")
    } catch (reason) {
      // The draft stays; the failure is visible.
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSending(false)
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
        aria-label="提示"
        className="composer-input"
        rows={3}
        value={value}
        onChange={(event) => {
          const next = boundedDraft(event.target.value)
          setValue(next)
          writeDraft(workspaceId, sessionId, next)
        }}
        placeholder={canSend ? "輸入提示…" : (sendReason ?? "目前無法送出")}
      />
      <div className="composer-actions">
        <button type="submit" className="primary-button" disabled={!canSend || sending || value.trim() === ""}>
          送出
        </button>
        <button type="button" className="primary-button" disabled={!running} onClick={onCancel}>
          停止
        </button>
        {canSend || sendReason === undefined ? null : <span className="muted">{sendReason}</span>}
        {error === undefined ? null : <span className="error-text">{error}</span>}
      </div>
    </form>
  )
}
