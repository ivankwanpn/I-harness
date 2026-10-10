// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { ProviderCard } from "../src/renderer/settings/ProviderCard.tsx"
afterEach(cleanup)
it("marks the saved selected model instead of the route's fallback model", () => {
  render(<ProviderCard row={{ id: "route", displayName: "Route", auth: { configured: true }, models: [{ id: "catalog-fallback" }, { id: "saved-choice" }], defaultModel: "catalog-fallback", selectedDefaultModel: "saved-choice" }} onSave={async () => {}} />)
  const stars = screen.getAllByRole("button", { name: "設為預設模型" })
  expect(stars.map(star => star.getAttribute("aria-pressed"))).toEqual(["false", "true"])
})
