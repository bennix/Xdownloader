import { BrowserWindow, session, webContents } from 'electron'
import { extractUrls, extractUrlsFromHtml, sniffMediaKind, unique } from '../shared/urls'
import type { SniffHit } from '../shared/types'

type Listener = (hits: SniffHit[], pageUrl: string) => void

let onHits: Listener | null = null
const sniffWins = new Set<BrowserWindow>()
const seen = new Set<string>()
const collected: SniffHit[] = []
const dismissed = new Set<string>()

export function setSniffListener(listener: Listener | null): void {
  onHits = listener
}

export function sniffHits(): SniffHit[] {
  return collected.slice()
}

export function removeSniffHits(urls: string[]): number {
  const keys = new Set(urls.map((url) => url.split('#')[0]))
  for (const key of keys) dismissed.add(key)
  const before = collected.length
  for (let i = collected.length - 1; i >= 0; i -= 1) {
    if (keys.has(collected[i].url.split('#')[0])) collected.splice(i, 1)
  }
  return before - collected.length
}

export function isSnifferOpen(): boolean {
  pruneWindows()
  return sniffWins.size > 0
}

export function sniffWebContents(): Electron.WebContents[] {
  pruneWindows()
  return [...sniffWins].filter((win) => !win.isDestroyed()).map((win) => win.webContents)
}

export function pickSniffContents(url: string): Electron.WebContents | null {
  const all = sniffWebContents()
  if (!all.length) return null
  let origin = ''
  try {
    origin = new URL(url).origin
  } catch {
    return all[0]
  }
  return (
    all.find((contents) => {
      try {
        return new URL(contents.getURL()).origin === origin
      } catch {
        return false
      }
    }) || null
  )
}

export async function openSniffer(url: string, parent?: BrowserWindow | null): Promise<void> {
  const target = normalizePageUrl(url)
  if (!target) throw new Error('先在输入框里放一个 http(s) 页面地址')
  pruneWindows()
  if (!sniffWins.size) {
    seen.clear()
    collected.length = 0
    dismissed.clear()
  }
  const existing = [...sniffWins].find((win) => samePage(win.webContents.getURL(), target))
  if (existing) {
    existing.show()
    existing.focus()
    return
  }
  const ses = session.fromPartition('persist:xdown-sniffer')
  hookSession(ses)
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: '页面嗅探',
    parent: parent ?? undefined,
    backgroundColor: '#1a1814',
    webPreferences: {
      partition: 'persist:xdown-sniffer',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  sniffWins.add(win)
  win.on('closed', () => {
    sniffWins.delete(win)
  })
  const contents = win.webContents
  contents.setWindowOpenHandler(({ url: next, disposition }) => {
    if (/^https?:/i.test(next) && disposition === 'foreground-tab' && sameSite(next, contents.getURL())) {
      void openSniffer(next, parent).catch(() => undefined)
    }
    return { action: 'deny' }
  })
  contents.on('did-navigate', (_event, next) => {
    emitHits([], next)
  })
  contents.on('page-title-updated', (_event, title) => {
    win.setTitle(title ? `${title} · 嗅探` : '页面嗅探')
  })
  contents.on('did-stop-loading', () => {
    void scrapePage(contents)
  })
  await win.loadURL(target).catch((error: Error) => {
    if (!/ERR_ABORTED/.test(error.message)) throw error
  })
  win.show()
  win.focus()
}

export function closeSniffer(): void {
  for (const win of [...sniffWins]) {
    if (!win.isDestroyed()) win.close()
  }
  sniffWins.clear()
}

function hookSession(ses: Electron.Session): void {
  if ((ses as Electron.Session & { __xdownSniff?: boolean }).__xdownSniff) return
  ;(ses as Electron.Session & { __xdownSniff?: boolean }).__xdownSniff = true
  const captured = new Map<number, string[]>()
  ses.webRequest.onErrorOccurred(details => { captured.delete(details.id) })
  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    captured.set(details.id, requestHeaders(details.requestHeaders))
    consider(details.url, '', requestHeaders(details.requestHeaders), pageOf(details.webContentsId))
    callback({ requestHeaders: details.requestHeaders })
  })
  ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    const headers = captured.get(details.id) || []
    captured.delete(details.id)
    if (details.statusCode >= 400) return
    consider(
      details.url,
      details.responseHeaders?.['Content-Type']?.[0] || details.responseHeaders?.['content-type']?.[0] || '',
      headers,
      pageOf(details.webContentsId)
    )
  })
}

function pageOf(id?: number): string {
  if (!id) return ''
  try {
    return webContents.fromId(id)?.getURL() || ''
  } catch {
    return ''
  }
}

function requestHeaders(raw?: Record<string, string>): string[] {
  if (!raw) return []
  const keep = ['user-agent', 'referer', 'origin', 'cookie', 'accept', 'accept-language']
  return Object.entries(raw)
    .filter(([key]) => keep.includes(key.toLowerCase()))
    .map(([key, value]) => `${key}: ${value}`)
}

function consider(url: string, mime = '', headers: string[] = [], fromPage = ''): void {
  const kind = sniffMediaKind(url, mime.split(';')[0])
  if (!kind) return
  addHits([{ url, kind, mime: mime.split(';')[0], source: 'network', headers, pageUrl: fromPage || undefined }])
}

async function scrapePage(contents: Electron.WebContents): Promise<void> {
  try {
    const data = (await contents.executeJavaScript(`({
      href: location.href,
      html: document.documentElement.outerHTML,
      media: [...document.querySelectorAll('video,audio,source')].map((el) => el.currentSrc || el.src).filter(Boolean)
    })`)) as { href?: string; html?: string; media?: string[] }
    const fromPage = data.href || contents.getURL()
    const found = unique([...(data.media ?? []), ...extractUrlsFromHtml(data.html || ''), ...extractUrls(data.html || '')])
    addHits(
      found
        .map((url): SniffHit | null => {
          const kind = sniffMediaKind(url)
          return kind
            ? {
                url,
                kind,
                mime: '',
                source: 'page' as const,
                headers: fromPage ? [`Referer: ${fromPage}`] : [],
                pageUrl: fromPage
              }
            : null
        })
        .filter((item): item is SniffHit => Boolean(item))
    )
  } catch {
    /* page may have navigated away */
  }
}

function addHits(items: SniffHit[]): void {
  const fresh: SniffHit[] = []
  for (const item of items) {
    if (dismissed.has(item.url.split('#')[0])) continue
    const key = `${item.pageUrl || ''}|${item.url.split('#')[0]}`
    if (seen.has(key)) {
      const existing = collected.find((hit) => `${hit.pageUrl || ''}|${hit.url.split('#')[0]}` === key)
      if (existing && item.source === 'network' && item.headers?.length) {
        existing.headers = [...item.headers]
        fresh.push(existing)
      }
      continue
    }
    seen.add(key)
    collected.push(item)
    fresh.push(item)
  }
  if (fresh.length) emitHits(fresh, fresh[0]?.pageUrl || '')
}

function emitHits(fresh: SniffHit[], pageUrl: string): void {
  onHits?.(fresh, pageUrl)
}

function pruneWindows(): void {
  for (const win of [...sniffWins]) {
    if (win.isDestroyed()) sniffWins.delete(win)
  }
}

function sameSite(left: string, right: string): boolean {
  try {
    const a = new URL(left).hostname.split('.').slice(-2).join('.')
    const b = new URL(right).hostname.split('.').slice(-2).join('.')
    return a === b
  } catch {
    return false
  }
}

function samePage(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href
  } catch {
    return left === right
  }
}

function normalizePageUrl(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}
