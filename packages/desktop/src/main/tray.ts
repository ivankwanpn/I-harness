import { Menu, Tray, nativeImage } from "electron"

/** A tiny neutral I-harness mark in Windows BGRA bitmap order. The tray icon
 * is generated locally, so the portable build needs no external icon asset. */
function trayIcon() {
  const size = 16
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4
      const mark = (y === 3 || y === 12) && x >= 4 && x <= 11 || x >= 7 && x <= 8 && y >= 4 && y <= 11
      const tone = mark ? 238 : 32
      pixels[offset] = tone
      pixels[offset + 1] = tone
      pixels[offset + 2] = tone
      pixels[offset + 3] = 255
    }
  }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 })
  if (image.isEmpty()) throw new Error("Could not create Desktop tray icon")
  return image
}

export function createDesktopTray(options: {
  show(): void
  quit(): void
  locale(): "zh-TW" | "en"
}): Tray {
  const tray = new Tray(trayIcon())
  const rebuild = () => {
    const english = options.locale() === "en"
    tray.setToolTip("I-harness Desktop")
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: english ? "Show workbench" : "顯示工作台", click: options.show },
      { type: "separator" },
      { label: english ? "Exit" : "退出", click: options.quit },
    ]))
  }
  tray.on("click", options.show)
  tray.on("double-click", options.show)
  tray.on("right-click", rebuild)
  rebuild()
  return tray
}
