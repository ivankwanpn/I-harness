interface ExecFrameRecord { channel: 'stdout' | 'stderr'; frame: number; offset: number; end: boolean; data: string }
export interface ExecFrameCursor { recordOffset: number; sliceOffset: number }
export function encodeExecFrameRecord(record: ExecFrameRecord): string {
  return JSON.stringify({ channel: record.channel, frame: record.frame, offset: record.offset, end: record.end, data: record.data }) + '\n'
}
/** Closed canonical record decoder, with one at-most32KiB raw decode. */
export function decodeExecFrameRecord(line: string): { record: ExecFrameRecord; bytes: Uint8Array } {
  if (new TextEncoder().encode(line).length > 45056 || !line.endsWith('\n')) throw new Error('Artifact frame record corrupt')
  const record = JSON.parse(line) as ExecFrameRecord
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).join(',') !== 'channel,frame,offset,end,data'
    || !['stdout', 'stderr'].includes(record.channel) || ![record.frame, record.offset].every(value => Number.isSafeInteger(value) && value >= 0)
    || typeof record.end !== 'boolean' || typeof record.data !== 'string' || record.data.length > 43692 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.data)
    || encodeExecFrameRecord(record) !== line) throw new Error('Artifact frame record corrupt')
  const decoded = atob(record.data)
  if (decoded.length > 32768 || btoa(decoded) !== record.data || !Number.isSafeInteger(record.offset + decoded.length)
    || !decoded.length && (!record.end || record.offset !== 0)) throw new Error('Artifact frame record corrupt')
  return { record, bytes: Uint8Array.from(decoded, character => character.charCodeAt(0)) }
}
