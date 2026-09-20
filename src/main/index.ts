import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell
} from 'electron'
import type { AddPayload, Settings } from '../shared/types'
import { extractUrls } from '../shared/urls'
import { readClipboardUrls } from './clipboard'
import { brewSnapshot, installMissing, onBrewProgress } from './brew'
import { listBrowserOptions } from './browsers'
import { AriaEngine } from './engine'

let win: BrowserWindow | null = null
let quitting = false
const engine = new AriaEngine(join(app.getPath('userData'), 'aria'))
const ownedClipboard = new Set<string>()
let lastClipboardKey = ''

function applyChromeTheme(theme: 'dark' | 'light'): void {
  nativeTheme.themeSource = theme
  win?.setBackgroundColor(theme === 'light' ? '#f4efe6' : '#1a1814')
}

function preloadScript(): string {
  const dir = join(__dirname, '../preload')
  const candidates = ['index.cjs', 'index.js', 'index.mjs'].map((name) => join(dir, name))
  return candidates.find((file) => existsSync(file)) ?? candidates[0]
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 880,
    minHeight: 560,
    title: 'Xdownloader',
    backgroundColor: engine.currentSettings.theme === 'light' ? '#f4efe6' : '#1a1814',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    show: false,
    webPreferences: {
      preload: preloadScript(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.on('preload-error', (_event, path, error) => {
    engine.error = `预加载失败：${error.message}`
    console.error('[preload]', path, error)
  })
  win.webContents.on('context-menu', (_event, params) => {
    Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: '粘贴识别链接', click: () => win?.webContents.send('paste-urls') },
      { label: '复制识别链接', click: () => win?.webContents.send('copy-input-urls') }
    ]).popup({ window: win! })
  })
  win.once('ready-to-show', () => win?.show())
  win.on('close', (event) => {
    if (process.platform === 'darwin' && !quitting) {
      event.preventDefault()
      win?.hide()
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function emptySnap(error: string) {
  return {
    ready: false,
    error,
    version: engine.version || '',
    features: engine.features,
    downloadSpeed: 0,
    uploadSpeed: 0,
    numActive: 0,
    numWaiting: 0,
    numStopped: 0,
    tasks: [],
    settings: engine.currentSettings,
    browsers: (() => {
      try {
        return listBrowserOptions()
      } catch {
        return []
      }
    })(),
    cookieBrowser: '',
    cookieLabel: ''
  }
}

function bindIpc(): void {
  ipcMain.handle('list-browsers', () => {
    try {
      return listBrowserOptions()
    } catch {
      return []
    }
  })
  ipcMain.handle('snapshot', async () => {
    try {
      return await engine.snapshot()
    } catch (error) {
      return emptySnap(error instanceof Error ? error.message : String(error))
    }
  })
  ipcMain.handle('add-downloads', (_event, payload: AddPayload) => engine.addDownloads(payload))
  ipcMain.handle('add-torrent', (_event, base64: string, webSeeds: string[] = []) => engine.addTorrent(base64, webSeeds))
  ipcMain.handle('add-metalink', (_event, base64: string) => engine.addMetalink(base64))
  ipcMain.handle('pause', (_event, gid: string) => engine.pause(gid))
  ipcMain.handle('resume', (_event, gid: string) => engine.resume(gid))
  ipcMain.handle('remove', (_event, gid: string) => engine.remove(gid))
  ipcMain.handle('pause-all', () => engine.pauseAll())
  ipcMain.handle('resume-all', () => engine.resumeAll())
  ipcMain.handle('move', (_event, gid: string, how: 'POS_SET' | 'POS_CUR' | 'POS_END', pos: number) =>
    engine.move(gid, how, pos)
  )
  ipcMain.handle('detail', async (_event, gid: string) => {
    try {
      return await engine.detail(gid)
    } catch {
      return null
    }
  })
  ipcMain.handle('change-uris', (_event, gid: string, add: string[], del: string[] = []) => engine.changeUris(gid, add, del))
  ipcMain.handle('select-files', (_event, gid: string, indexes: number[]) => engine.selectFiles(gid, indexes))
  ipcMain.handle('change-task-option', (_event, gid: string, options: Record<string, string>) =>
    engine.changeTaskOption(gid, options)
  )
  ipcMain.handle('copy-urls', async (_event, gid: string) => {
    const urls = await engine.urlsOf(gid)
    if (urls.length) {
      clipboard.writeText(urls.join('\n'))
      urls.forEach((url) => ownedClipboard.add(url))
    }
    return urls
  })
  ipcMain.handle('open-folder', async (_event, gid: string) => {
    try {
      const located = engine.locateExisting(await engine.pathOf(gid))
      if (located.path) {
        await revealInFolder(located.path)
        return { ok: true, kind: 'file' as const, path: located.path }
      }
      if (located.dir) {
        const error = await shell.openPath(located.dir)
        if (error) throw new Error(error)
        return { ok: true, kind: 'dir' as const, path: located.dir }
      }
      throw new Error('找不到下载目录')
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '打不开这个目录')
    }
  })
  ipcMain.handle('clipboard-urls', () => readClipboardUrls())
  ipcMain.handle('write-clipboard', (_event, text: string) => {
    clipboard.writeText(text)
    text.split(/\s+/).forEach((url) => ownedClipboard.add(url))
  })
  ipcMain.handle('pick-dir', async () => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('pick-torrent', () => pickEncoded(['torrent']))
  ipcMain.handle('pick-metalink', () => pickEncoded(['meta4', 'metalink']))
  ipcMain.handle('probe-youtube', (_event, url: string, cookiesFromBrowser?: string) =>
    engine.probeYouTube(url, cookiesFromBrowser)
  )
  ipcMain.handle('brew-status', () => brewSnapshot())
  ipcMain.handle('brew-install', async (_event, auto = false) => {
    const result = await installMissing(auto)
    if (!engine.ready && result.tools.some((item) => item.id === 'aria2' && item.installed)) {
      try {
        await engine.start()
      } catch (error) {
        engine.error = error instanceof Error ? error.message : String(error)
      }
    }
    return result
  })
  ipcMain.handle('save-settings', async (_event, patch: Partial<Settings>) => {
    if (patch.downloadDir) await mkdir(patch.downloadDir, { recursive: true })
    const settings = await engine.saveSettings(patch)
    applyChromeTheme(settings.theme)
    return settings
  })
}

async function pickEncoded(extensions: string[]): Promise<string | null> {
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'aria2', extensions }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  return (await readFile(result.filePaths[0])).toString('base64')
}

function startPolling(): void {
  const tick = async () => {
    if (!win || win.isDestroyed()) return
    try {
      const snap = await engine.snapshot()
      win.webContents.send('snapshot', snap)
      if (process.platform === 'darwin') {
        app.dock.setBadge(snap.numActive ? String(snap.numActive) : '')
      }
    } catch (error) {
      win.webContents.send('snapshot', emptySnap(error instanceof Error ? error.message : String(error)))
    }
    watchClipboard()
  }
  void tick()
  setInterval(() => void tick(), 800)
}

function watchClipboard(): void {
  if (!win || win.isDestroyed() || !win.isFocused()) return
  const urls = readClipboardUrls().filter((url) => !ownedClipboard.has(url) && !engine.isFinishedUrl(url))
  const key = urls.join('\n')
  if (!urls.length || key === lastClipboardKey) return
  lastClipboardKey = key
  win.webContents.send('clipboard-urls', urls)
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body, icon: nativeImage.createEmpty() }).show()
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.send('open-settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'quit' }
      ]
    },
    {
      label: '任务',
      submenu: [
        { label: '粘贴链接', accelerator: 'CmdOrCtrl+V', click: () => win?.webContents.send('paste-urls') },
        { label: '从剪贴板添加', accelerator: 'CmdOrCtrl+Shift+V', click: () => win?.webContents.send('add-clipboard') },
        { label: '添加种子…', click: () => win?.webContents.send('add-torrent') },
        { type: 'separator' },
        { label: '全部暂停', click: () => void engine.pauseAll() },
        { label: '全部继续', click: () => void engine.resumeAll() }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  app.setName('XDownlder')
  applyChromeTheme(engine.currentSettings.theme)
  await mkdir(engine.currentSettings.downloadDir, { recursive: true }).catch(() => undefined)
  bindIpc()
  buildMenu()
  createWindow()
  startPolling()
  engine.onEvent = (method, gid, message) => {
    win?.webContents.send('engine-event', { method, gid, message })
    if (method === 'aria2.onDownloadComplete') {
      notify('下载完成', gid)
      void engine.maybeMerge(gid)
    }
    if (method === 'aria2.onBtDownloadComplete') notify('BT 下载完成，开始做种', gid)
    if (method === 'aria2.onDownloadError') notify('下载出错', gid)
    if (method === 'aria.onYoutubeResolve') notify('正在解析视频', gid)
    if (method === 'aria.onYoutubeMerge') notify('正在合成音画', gid)
    if (method === 'aria.onYoutubeMerged') notify('视频已合成', gid)
    if (method === 'aria.onYoutubeMergeError') notify('音画合成失败', message || gid)
  }
  try {
    await engine.start()
    await mkdir(engine.currentSettings.downloadDir, { recursive: true })
  } catch (error) {
    engine.error = error instanceof Error ? error.message : String(error)
  }
  onBrewProgress((progress) => win?.webContents.send('brew-progress', progress))
  const tools = brewSnapshot()
  if (!app.isPackaged && tools.missing.length && tools.tools.some((item) => item.id === 'brew' && item.installed)) {
    win?.webContents.send('open-settings')
    void installMissing(true).then(async (result) => {
      if (!engine.ready && result.tools.some((item) => item.id === 'aria2' && item.installed)) {
        try {
          await engine.start()
        } catch (error) {
          engine.error = error instanceof Error ? error.message : String(error)
        }
      }
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win?.show()
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', (event) => {
  if (!engine.ready) return
  event.preventDefault()
  void engine.stop().finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function revealInFolder(path: string): Promise<void> {
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('open', ['-R', path], (error) => {
        if (error) shell.showItemInFolder(path)
        resolve()
      })
    })
  }
  shell.showItemInFolder(path)
  return Promise.resolve()
}

export function extractDroppedText(text: string): string[] {
  return extractUrls(text)
}
