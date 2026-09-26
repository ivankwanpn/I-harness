import { create } from "zustand"

// UI state only. SDK state remains owned by the renderer data layer.
export const useUiStore = create<{
  reviewOpen: boolean
  toggleReview(): void
}>((set) => ({
  reviewOpen: false,
  toggleReview: () => set((state) => ({ reviewOpen: !state.reviewOpen })),
}))
