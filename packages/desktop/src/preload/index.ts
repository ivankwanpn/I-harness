import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import {
  DESKTOP_EVENT_CHANNEL,
  DESKTOP_REQUEST_CHANNEL,
  type DesktopBridge,
  type DesktopEvent,
  type DesktopRequest,
} from "../shared/bridge.ts"

const bridge: DesktopBridge = {
  request: (request: DesktopRequest): Promise<unknown> =>
    ipcRenderer.invoke(DESKTOP_REQUEST_CHANNEL, request) as Promise<unknown>,
  onEvent: (listener: (event: DesktopEvent) => void): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, desktopEvent: DesktopEvent): void => { listener(desktopEvent) }
    ipcRenderer.on(DESKTOP_EVENT_CHANNEL, wrapped)
    return () => { ipcRenderer.removeListener(DESKTOP_EVENT_CHANNEL, wrapped) }
  },
}

contextBridge.exposeInMainWorld("ihDesktop", Object.freeze(bridge))
