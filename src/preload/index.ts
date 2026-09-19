import { contextBridge, ipcRenderer } from 'electron'
import type { AddPayload, AriaApi, BrewProgress, EngineEvent, Settings, Snapshot, TaskDetail } from '../shared/types'

const api: AriaApi = {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  addDownloads: (payload: AddPayload) => ipcRenderer.invoke('add-downloads', payload),
  addTorrent: (base64, webSeeds) => ipcRenderer.invoke('add-torrent', base64, webSeeds),
  addMetalink: (base64) => ipcRenderer.invoke('add-metalink', base64),
  pause: (gid) => ipcRenderer.invoke('pause', gid),
  resume: (gid) => ipcRenderer.invoke('resume', gid),
  remove: (gid) => ipcRenderer.invoke('remove', gid),
  pauseAll: () => ipcRenderer.invoke('pause-all'),
  resumeAll: () => ipcRenderer.invoke('resume-all'),
  move: (gid, how, pos) => ipcRenderer.invoke('move', gid, how, pos),
  copyUrls: (gid) => ipcRenderer.invoke('copy-urls', gid),
  openFolder: (gid) => ipcRenderer.invoke('open-folder', gid),
  detail: (gid) => ipcRenderer.invoke('detail', gid) as Promise<TaskDetail | null>,
  changeUris: (gid, add, del) => ipcRenderer.invoke('change-uris', gid, add, del),
  selectFiles: (gid, indexes) => ipcRenderer.invoke('select-files', gid, indexes),
  changeTaskOption: (gid, options) => ipcRenderer.invoke('change-task-option', gid, options),
  readClipboardUrls: () => ipcRenderer.invoke('clipboard-urls'),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
  pickDownloadDir: () => ipcRenderer.invoke('pick-dir'),
  pickTorrent: () => ipcRenderer.invoke('pick-torrent'),
  pickMetalink: () => ipcRenderer.invoke('pick-metalink'),
  probeYouTube: (url, cookiesFromBrowser) => ipcRenderer.invoke('probe-youtube', url, cookiesFromBrowser),
  listBrowsers: () => ipcRenderer.invoke('list-browsers'),
  saveSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('save-settings', patch),
  brewStatus: () => ipcRenderer.invoke('brew-status'),
  brewInstall: (auto) => ipcRenderer.invoke('brew-install', auto),
  onBrewProgress: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: BrewProgress) => cb(progress)
    ipcRenderer.on('brew-progress', listener)
    return () => ipcRenderer.removeListener('brew-progress', listener)
  },
  onSnapshot: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, snap: Snapshot) => cb(snap)
    ipcRenderer.on('snapshot', listener)
    return () => ipcRenderer.removeListener('snapshot', listener)
  },
  onClipboardUrls: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, urls: string[]) => cb(urls)
    ipcRenderer.on('clipboard-urls', listener)
    return () => ipcRenderer.removeListener('clipboard-urls', listener)
  },
  onPasteUrls: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('paste-urls', listener)
    return () => ipcRenderer.removeListener('paste-urls', listener)
  },
  onAddClipboard: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('add-clipboard', listener)
    return () => ipcRenderer.removeListener('add-clipboard', listener)
  },
  onCopyInputUrls: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('copy-input-urls', listener)
    return () => ipcRenderer.removeListener('copy-input-urls', listener)
  },
  onOpenSettings: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('open-settings', listener)
    return () => ipcRenderer.removeListener('open-settings', listener)
  },
  onEvent: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: EngineEvent) => cb(payload)
    ipcRenderer.on('engine-event', listener)
    return () => ipcRenderer.removeListener('engine-event', listener)
  }
}

contextBridge.exposeInMainWorld('aria', api)
