import type { ImageInput } from "@i-harness/core-session"

export interface VideoAudioInput {
  wav: Uint8Array
  question?: string
  startSeconds: number
  durationSeconds: number
  signal?: AbortSignal
}
export type VideoAudioAnalysis =
  | { status: "analyzed"; analysis: string; provider?: string; model?: string }
  | { status: "unconfigured" | "unsupported" | "failed"; reason: string }
export type VideoAudioAnalyzer = (input: VideoAudioInput) => Promise<VideoAudioAnalysis>
export interface DecodedVideo {
  sourceDurationSeconds: number
  startSeconds: number
  durationSeconds: number
  frames: { timestampSeconds: number; image: ImageInput }[]
  wav?: Uint8Array
  audioError?: string
}
export interface VideoDecodeInput {
  path: string
  startSeconds: number
  durationSeconds: number
  frameCount: number
  signal?: AbortSignal
}
export type VideoDecoder = (input: VideoDecodeInput) => Promise<DecodedVideo>

export const VIDEO_LIMITS = {
  sourceBytes: 256 * 1024 * 1024,
  frameBytes: 2 * 1024 * 1024,
  totalFrameBytes: 12 * 1024 * 1024,
  audioBytes: 3 * 1024 * 1024,
  durationSeconds: 60,
  frameCount: 8,
  maxDimension: 1280,
  processTimeoutMs: 25_000,
  toolTimeoutMs: 120_000,
} as const
