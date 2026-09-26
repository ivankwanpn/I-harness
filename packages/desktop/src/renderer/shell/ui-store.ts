import { create } from "zustand"

// UI state only. SDK state remains owned by the renderer data layer.
export const useUiStore = create<{
  reviewOpen: boolean
  reviewWidth: number
  setReviewWidth(width: number): void
  toggleReview(): void
}>((set) => ({
  reviewOpen: false,
  reviewWidth: 360,
  setReviewWidth: (width) => set({ reviewWidth: Math.min(640, Math.max(280, Math.round(width))) }),
  toggleReview: () => set((state) => ({ reviewOpen: !state.reviewOpen })),
}))
