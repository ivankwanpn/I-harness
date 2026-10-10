import { createRequire } from "node:module"
import { access } from "node:fs/promises"
import { runMediaProcess } from "./process.ts"
import { VIDEO_LIMITS, type VideoDecoder } from "./types.ts"

const require = createRequire(import.meta.url)
export async function resolveMediaBinaries(): Promise<{ ffmpeg: string; ffprobe: string }> {
  try {
    const ffmpeg: unknown = require("ffmpeg-static")
    const probe: unknown = require("@ffprobe-installer/ffprobe")
    const ffprobe = (probe as { path?: unknown })?.path
    if (typeof ffmpeg !== "string" || typeof ffprobe !== "string") throw new Error("unsupported platform")
    await Promise.all([access(ffmpeg), access(ffprobe)])
    return { ffmpeg, ffprobe }
  } catch {
    throw new Error("VIDEO_DECODER_UNAVAILABLE: bundled FFmpeg/FFprobe is unavailable on this platform; reinstall the application or its media dependencies")
  }
}

interface Probe { format?: { duration?: string }; streams?: { index: number; codec_type?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string; disposition?: { attached_pic?: number } }[] }
const limits = VIDEO_LIMITS
// Reject disguised playlists/concat inputs as well as network protocols.
const formats = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,ogg"
const common = ["-hide_banner", "-loglevel", "error", "-nostdin", "-max_alloc", "33554432", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", formats]
function finalizeWav(bytes: Uint8Array): Buffer {
  const wav = Buffer.from(bytes)
  if (wav.length <= 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Audio decoder returned empty or invalid WAV")
  // A non-seekable FFmpeg pipe writes 0xffffffff placeholder lengths. Replace
  // those with the bounded buffer's actual sizes before sending to audio APIs.
  for (let offset = 12; offset + 8 <= wav.length;) {
    if (wav.toString("ascii", offset, offset + 4) === "data") {
      if (wav.length <= offset + 8) throw new Error("Audio stream has no samples in the selected interval")
      wav.writeUInt32LE(wav.length - 8, 4)
      wav.writeUInt32LE(wav.length - offset - 8, offset + 4)
      return wav
    }
    const size = wav.readUInt32LE(offset + 4)
    offset += 8 + size + (size % 2)
  }
  throw new Error("Audio decoder returned WAV without a PCM data chunk")
}
export const decodeVideo: VideoDecoder = async input => {
  input.signal?.throwIfAborted()
  const binaries = await resolveMediaBinaries()
  const run = (executable: string, args: string[], maxBytes: number) => runMediaProcess(executable, args, { maxBytes, timeoutMs: limits.processTimeoutMs, signal: input.signal })
  const probe = JSON.parse((await run(binaries.ffprobe, ["-v", "error", "-max_alloc", "33554432", "-protocol_whitelist", "file,pipe", "-format_whitelist", formats, "-show_entries", "format=duration:stream=index,codec_type,width,height,duration,avg_frame_rate:stream_disposition=attached_pic", "-of", "json", input.path], 64 * 1024)).toString("utf8")) as Probe
  const video = probe.streams?.find(stream => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1)
  const audio = probe.streams?.find(stream => stream.codec_type === "audio")
  if (!video) throw new Error("No video stream found in this file")
  const sourceDurationSeconds = Number(probe.format?.duration ?? video.duration)
  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) throw new Error("Video duration is unavailable or invalid")
  if (!video.width || !video.height || video.width * video.height > 64 * 1024 * 1024) throw new Error("Video dimensions are unsupported or too large")
  if (input.startSeconds >= sourceDurationSeconds) throw new Error("startSeconds is past the end of the video")
  const durationSeconds = Math.min(input.durationSeconds, sourceDurationSeconds - input.startSeconds)
  const frames = []
  let totalBytes = 0
  const ratio = Math.min(1, limits.maxDimension / Math.max(video.width, video.height))
  const width = Math.max(1, Math.floor(video.width * ratio)), height = Math.max(1, Math.floor(video.height * ratio))
  const [numerator, denominator] = (video.avg_frame_rate ?? "0/0").split("/").map(Number)
  const frameRate = numerator / denominator
  const reliableRate = Number.isFinite(frameRate) && frameRate > 0 && frameRate <= 1000
  const seen = new Set<number>()
  for (let index = 0; index < input.frameCount; index++) {
    input.signal?.throwIfAborted()
    // Center samples avoid seeking exactly to EOF and distribute coverage evenly.
    const target = input.startSeconds + durationSeconds * (index + 0.5) / input.frameCount
    // A seek between the final frame PTS and EOF produces no frame. Quantize
    // the requested sample to its frame boundary, deduplicating short clips.
    const timestampSeconds = reliableRate ? Math.floor(target * frameRate) / frameRate : target
    if (seen.has(timestampSeconds)) continue
    seen.add(timestampSeconds)
    const bytes = await run(binaries.ffmpeg, [...common, "-ss", timestampSeconds.toFixed(6), "-i", input.path, "-map", `0:${video.index}`, "-frames:v", "1", "-an", "-vf", `scale=${width}:${height}`, "-threads", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1"], limits.frameBytes)
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("Decoder did not return a valid JPEG frame")
    totalBytes += bytes.length
    if (totalBytes > limits.totalFrameBytes) throw new Error("Video frames exceed aggregate byte limit")
    frames.push({ timestampSeconds, image: { mediaType: "image/jpeg" as const, dataBase64: bytes.toString("base64"), width, height } })
  }
  let wav: Uint8Array | undefined, audioError: string | undefined
  if (audio) {
    input.signal?.throwIfAborted()
    try {
      wav = await run(binaries.ffmpeg, [...common, "-ss", input.startSeconds.toFixed(6), "-i", input.path, "-t", durationSeconds.toFixed(6), "-map", `0:${audio.index}`, "-vn", "-ac", "1", "-ar", "24000", "-af", "aresample=async=1:first_pts=0", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"], limits.audioBytes)
      wav = finalizeWav(wav)
    } catch (error) {
      input.signal?.throwIfAborted()
      wav = undefined; audioError = error instanceof Error ? error.message : "Audio decoding failed"
    }
  }
  return { sourceDurationSeconds, startSeconds: input.startSeconds, durationSeconds, frames, ...(wav ? { wav } : {}), ...(audioError ? { audioError } : {}) }
}
