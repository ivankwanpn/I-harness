import { stat } from "node:fs/promises"
import { extname } from "node:path"
import { resolvePath } from "@i-harness/fs"
import { validateImage } from "@i-harness/image-validation"
import type { ImageInput } from "@i-harness/core-session"
import type { Tool } from "@i-harness/core-tools"
import { decodeVideo } from "./video-decoder.ts"
import { VIDEO_LIMITS, type VideoAudioAnalyzer, type VideoAudioAnalysis, type VideoDecoder } from "./types.ts"
export { VIDEO_LIMITS } from "./types.ts"
export type { DecodedVideo, VideoAudioAnalyzer, VideoAudioAnalysis, VideoAudioInput, VideoDecoder, VideoDecodeInput } from "./types.ts"

export interface ReadVideoInput { path: string; startSeconds?: number; durationSeconds?: number; frameCount?: number; question?: string }
export interface ReadVideoResult {
  status: "complete" | "partial" | "error"
  coverage?: { startSeconds: number; endSeconds: number; sourceDurationSeconds: number; truncated: boolean; frameTimestamps: "approximate"; note: string }
  frames?: { imageIndex: number; timestampSeconds: number }[]
  images?: ImageInput[]
  audio?: VideoAudioAnalysis | { status: "absent"; reason: string }
  error?: string
  code?: string
}
export function createReadVideoTool(deps: { workspace: string; analyzeAudio?: VideoAudioAnalyzer; decoder?: VideoDecoder }): Tool<ReadVideoInput, ReadVideoResult> {
  return {
    name: "read_video",
    description: "Read a local video as timestamped visual frames AND speech/non-speech audio analysis. Defaults to first 30 seconds and 6 frames; max 60 seconds/8 frames per call. Specify startSeconds for later segments. Check audio.status: partial means sound could not be analyzed. Frames require an image-capable main model.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, startSeconds: { type: "number", minimum: 0 }, durationSeconds: { type: "number", minimum: 0, maximum: 60 }, frameCount: { type: "integer", minimum: 1, maximum: 8 }, question: { type: "string" } }, required: ["path"], additionalProperties: false },
    isReadOnly: true, isConcurrencySafe: false, timeoutMs: VIDEO_LIMITS.toolTimeoutMs,
    async execute(args, exec) {
      const deadline = AbortSignal.timeout(VIDEO_LIMITS.toolTimeoutMs)
      const signal = exec.abortSignal ? AbortSignal.any([exec.abortSignal, deadline]) : deadline
      try {
        signal.throwIfAborted()
        const { path, startSeconds = 0, durationSeconds = 30, frameCount = 6, question } = args
        if (typeof path !== "string" || !path.trim() || !Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > VIDEO_LIMITS.durationSeconds || !Number.isInteger(frameCount) || frameCount < 1 || frameCount > VIDEO_LIMITS.frameCount || (question !== undefined && (typeof question !== "string" || question.length > 2000))) throw new Error("Invalid video input: path, finite range up to 60 seconds and 1–8 frames are required")
        const resolved = resolvePath(deps.workspace, path)
        if (![".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpeg", ".mpg", ".ogv"].includes(extname(resolved).toLowerCase())) throw new Error("Unsupported video container; use mp4, mov, webm, mkv, avi, mpeg or ogv")
        const info = await stat(resolved)
        if (!info.isFile() || info.size === 0 || info.size > VIDEO_LIMITS.sourceBytes) throw new Error("Video must be a nonempty regular file no larger than 256 MiB")
        const decoded = await (deps.decoder ?? decodeVideo)({ path: resolved, startSeconds, durationSeconds, frameCount, signal })
        signal.throwIfAborted()
        if (!decoded.frames.length || decoded.frames.length > VIDEO_LIMITS.frameCount) throw new Error("Video decoder returned an invalid frame count")
        for (const frame of decoded.frames) {
          const info = await validateImage(frame.image, { signal })
          frame.image = { ...frame.image, width: info.width, height: info.height }
        }
        let audio: NonNullable<ReadVideoResult["audio"]>
        if (decoded.audioError) audio = { status: "failed", reason: decoded.audioError }
        else if (!decoded.wav) audio = { status: "absent", reason: "The file has no audio stream" }
        else if (!deps.analyzeAudio) audio = { status: "unconfigured", reason: "Sound/speech was not analyzed. Configure Video audio analysis in Models settings (llm.videoAudio)." }
        else {
          try {
            audio = await deps.analyzeAudio({ wav: decoded.wav, question, startSeconds: decoded.startSeconds, durationSeconds: decoded.durationSeconds, signal })
            if (audio.status === "analyzed" && (!audio.analysis.trim() || audio.analysis.length > 32000)) audio = { status: "failed", reason: "Audio analyzer returned an empty or oversized description" }
          } catch { audio = { status: "failed", reason: "Sound/speech could not be analyzed by the configured provider" } }
        }
        signal.throwIfAborted()
        const endSeconds = decoded.startSeconds + decoded.durationSeconds
        return {
          status: audio.status === "analyzed" || audio.status === "absent" ? "complete" : "partial",
          coverage: { startSeconds: decoded.startSeconds, endSeconds, sourceDurationSeconds: decoded.sourceDurationSeconds, truncated: decoded.startSeconds > 0 || endSeconds < decoded.sourceDurationSeconds - 0.001, frameTimestamps: "approximate", note: "Frames are sparse samples, not continuous video. Sampling times are approximate, especially for variable frame rates; a frame boundary can precede the requested interval start." },
          frames: decoded.frames.map((frame, imageIndex) => ({ imageIndex, timestampSeconds: frame.timestampSeconds })),
          images: decoded.frames.map(frame => ({ ...frame.image, name: `Video frame near ${frame.timestampSeconds.toFixed(3)}s` })), audio,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Video could not be read"
        return { status: "error", code: signal.aborted ? "VIDEO_ABORTED" : message.startsWith("VIDEO_DECODER_UNAVAILABLE") ? "VIDEO_DECODER_UNAVAILABLE" : "VIDEO_READ_FAILED", error: signal.aborted ? "Video reading cancelled or timed out" : message.slice(0, 2048) }
      }
    },
  }
}
