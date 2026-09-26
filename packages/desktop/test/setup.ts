// Keep UI-copy fixtures deterministic; locale-selection behavior is tested separately.
if (typeof window !== "undefined") {
  Object.defineProperty(window.navigator, "languages", { configurable: true, value: ["zh-TW"] })
  Object.defineProperty(window.navigator, "language", { configurable: true, value: "zh-TW" })
}
