import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { session } from 'electron'
import { unique } from '../shared/urls'
import type { BrowserSessionImport } from '../shared/types'
import { listBrowserOptions } from './browsers'
import { resourceBinDir } from './binaries'
import { SNIFF_PARTITION } from './hls'
import { findYtDlp, toCookiesBrowser } from './youtube'

type CookieRow = {
  domain: string
  path: string
  secure: boolean
  expires: number
  name: string
  value: string
  httpOnly: boolean
}

const SCRIPT_APP: Record<string, string> = {
  chrome: 'Google Chrome',
  brave: 'Brave Browser',
  edge: 'Microsoft Edge',
  safari: 'Safari',
  firefox: 'Firefox',
  arc: 'Arc',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  chromium: 'Chromium'
}

let lastUserAgent = ''
let lastBrowserId = 'brave'

const BUNDLE_IDS: Record<string, string> = {
  chrome: 'com.google.Chrome',
  brave: 'com.brave.Browser',
  edge: 'com.microsoft.edgemac',
  safari: 'com.apple.Safari',
  arc: 'company.thebrowser.Browser',
  vivaldi: 'com.vivaldi.Vivaldi',
  opera: 'com.operasoftware.Opera',
  chromium: 'org.chromium.Chromium'
}

export function getImportedUserAgent(): string {
  return lastUserAgent
}

export function getPreferredBrowser(): string {
  return lastBrowserId
}

export type ExternalFetch = {
  ok: boolean
  status: number
  buf: Buffer
  text: string
  error?: string
}

export async function fetchViaExternalBrowser(
  url: string,
  range?: { start: number; end: number },
  browserId = lastBrowserId,
  pageUrl = ''
): Promise<ExternalFetch | null> {
  const key = (browserId || lastBrowserId || 'brave').split(':')[0]
  const app = SCRIPT_APP[key]
  if (!app) return null
  await enableAppleEventsJs(key)
  const jsFile = join(tmpdir(), `xdown-fetch-${process.pid}.js`)
  const rangeHeader =
    range && range.start != null && range.end != null ? `bytes=${range.start}-${range.end}` : ''
  await writeFile(jsFile, fetchScript(url, rangeHeader), 'utf8')
  try {
    const raw = await run('/usr/bin/osascript', ['-e', fetchAppleScript(app, key, jsFile, tabHints(url, pageUrl))], 90000)
    const parsed = parseExternalResult(raw)
    if (!parsed) {
      const error = raw.trim().replace(/^XDOWN-ERROR:/, '') || '浏览器没有返回数据'
      return { ok: false, status: 0, buf: Buffer.alloc(0), text: '', error: appleJsError(error, app) }
    }
    if (!parsed.ok && parsed.error) parsed.error = appleJsError(parsed.error, app)
    else if (!parsed.ok && parsed.status === 0) parsed.error = `${app} 页面无法跨域读取该资源（CORS）`
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: 0,
      buf: Buffer.alloc(0),
      text: '',
      error: appleJsError(message, app)
    }
  } finally {
    await unlink(jsFile).catch(() => undefined)
  }
}

export async function importBrowserSession(
  browserId: string,
  urls: string[] = [],
  ytDlp = ''
): Promise<BrowserSessionImport> {
  const browsers = listBrowserOptions()
  const chosen = browsers.find((item) => item.id === browserId) || browsers[0]
  const id = chosen?.id || browserId
  const label = chosen?.label || id || '浏览器'
  const userAgent = chosen?.userAgent || ''
  if (userAgent) lastUserAgent = userAgent
  if (id) lastBrowserId = id
  const result: BrowserSessionImport = {
    browser: id,
    label,
    userAgent,
    urls: [],
    cookies: 0,
    clearance: 0
  }
  if (!id) {
    result.error = '先选择本机浏览器'
    return result
  }
  result.urls = await currentTabUrls(id)
  const hosts = hostsOf([...urls, ...result.urls])
  try {
    const rows = await dumpBrowserCookies(id, ytDlp || findYtDlp() || '', result.urls[0] || urls[0] || 'https://example.com')
    const picked = rows.filter((row) => isClearance(row.name) || hosts.some((host) => hostMatches(row.domain, host)))
    const imported = await applyCookies(picked.length ? picked : rows.filter((row) => isClearance(row.name)))
    result.cookies = imported
    result.clearance = picked.filter((row) => isClearance(row.name)).length
    if (!result.cookies) result.error = result.error || '没有读到可用 Cookie。可先在该浏览器打开并播放页面后再导入。'
  } catch (error) {
    result.error = cookieError(error)
  }
  return result
}

export async function currentTabUrls(browserId: string): Promise<string[]> {
  const key = browserId.split(':')[0]
  const app = SCRIPT_APP[key]
  if (!app) return []
  try {
    const raw = await run('/usr/bin/osascript', ['-e', tabScript(app, key)], 8000)
    return unique(
      raw
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter((item) => /^https?:\/\//i.test(item))
    )
  } catch {
    return []
  }
}

function tabScript(app: string, _family: string): string {
  return `tell application "${app}"
  set out to {}
  if (count of windows) is 0 then return ""
  repeat with w in windows
    try
      repeat with t in tabs of w
        set end of out to URL of t
      end repeat
    end try
  end repeat
  set AppleScript's text item delimiters to linefeed
  return out as text
end tell`
}

async function dumpBrowserCookies(browserId: string, binary: string, probeUrl: string): Promise<CookieRow[]> {
  if (!binary || !existsSync(binary)) throw new Error('未找到 yt-dlp，无法读取浏览器 Cookies')
  const file = join(tmpdir(), `xdown-cookies-${process.pid}.txt`)
  await writeFile(file, '', 'utf8')
  try {
    await run(
      binary,
      [
        '--skip-download',
        '--ignore-no-formats-error',
        '--no-warnings',
        '--no-update',
        '--ignore-config',
        '--no-check-certificates',
        '--no-playlist',
        '--cookies-from-browser',
        toCookiesBrowser(browserId),
        '--cookies',
        file,
        probeUrl
      ],
      45000
    ).catch(async (error) => {
      if (existsSync(file) && (await readFile(file, 'utf8')).includes('\t')) return
      throw error
    })
    return parseNetscape(await readFile(file, 'utf8'))
  } finally {
    await unlink(file).catch(() => undefined)
  }
}

async function applyCookies(rows: CookieRow[]): Promise<number> {
  const ses = session.fromPartition(SNIFF_PARTITION)
  let count = 0
  for (const row of rows) {
    const host = row.domain.replace(/^\./, '')
    if (!host || !row.name) continue
    try {
      await ses.cookies.set({
        url: `${row.secure ? 'https' : 'http'}://${host}/`,
        name: row.name,
        value: row.value,
        domain: row.domain.startsWith('.') ? row.domain : host,
        path: row.path || '/',
        secure: row.secure,
        httpOnly: row.httpOnly,
        expirationDate: row.expires > 0 ? row.expires : undefined
      })
      count += 1
    } catch {
      /* expired or malformed */
    }
  }
  return count
}

function parseNetscape(text: string): CookieRow[] {
  const rows: CookieRow[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (!line) continue
    let httpOnly = false
    if (/^#HttpOnly_/i.test(line)) {
      httpOnly = true
      line = line.replace(/^#HttpOnly_/i, '')
    }
    if (line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    rows.push({
      domain: parts[0],
      path: parts[2] || '/',
      secure: /^true$/i.test(parts[3]),
      expires: Number(parts[4]) || 0,
      name: parts[5],
      value: parts[6],
      httpOnly
    })
  }
  return rows
}

function isClearance(name: string): boolean {
  return /^(cf_clearance|__cf_bm|__cf_clearance|cf_chl_)/i.test(name)
}

function hostMatches(domain: string, host: string): boolean {
  const cookie = domain.replace(/^\./, '').toLowerCase()
  const target = host.toLowerCase()
  return target === cookie || target.endsWith(`.${cookie}`)
}

function hostsOf(urls: string[]): string[] {
  const hosts: string[] = []
  for (const value of urls) {
    try {
      hosts.push(new URL(value).hostname)
    } catch {
      /* skip */
    }
  }
  return unique(hosts)
}

function fetchScript(url: string, rangeHeader: string): string {
  return `(() => {
  function once(withCredentials) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', ${JSON.stringify(url)}, false);
    xhr.withCredentials = withCredentials;
    ${rangeHeader ? `xhr.setRequestHeader('Range', ${JSON.stringify(rangeHeader)});` : ''}
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    try { xhr.send(null); } catch (error) { return { status: 0, text: '', error: String(error) }; }
    return { status: xhr.status, text: xhr.responseText || '' };
  }
  try {
    var got = once(false);
    if (got.status === 0 || got.status === 401 || got.status === 403) {
      var retry = once(true);
      if (retry.status !== 0 || got.status === 0) got = retry;
    }
    var text = got.text;
    var raw = '';
    for (var i = 0; i < text.length; i += 32768) {
      var slice = text.slice(i, i + 32768);
      var chunk = '';
      for (var j = 0; j < slice.length; j++) chunk += String.fromCharCode(slice.charCodeAt(j) & 255);
      raw += chunk;
    }
    return JSON.stringify({ ok: got.status >= 200 && got.status < 400, status: got.status, b64: btoa(raw), error: got.error });
  } catch (error) {
    return JSON.stringify({ ok: false, status: 0, error: String(error) });
  }
})()`
}

function tabHints(url: string, pageUrl: string): string[] {
  const hints: string[] = []
  if (pageUrl && /^https?:/i.test(pageUrl)) {
    hints.push(pageUrl.split('#')[0])
    try {
      hints.push(new URL(pageUrl).hostname)
    } catch {
      /* skip */
    }
  }
  try {
    hints.push(new URL(url).hostname)
  } catch {
    /* skip */
  }
  return unique(hints.map((item) => item.replace(/["\\]/g, '')).filter(Boolean))
}

function fetchAppleScript(app: string, family: string, jsFile: string, hints: string[]): string {
  const lists = hints.map((item) => `"${item}"`).join(', ')
  const first = family === 'safari' ? 'current tab of front window' : 'active tab of front window'
  const pickTab = `set chosen to ${first}
  set found to false
  repeat with h in {${lists}}
    if not found then
      repeat with w in windows
        repeat with t in tabs of w
          try
            if not found and URL of t contains (h as text) then
              set chosen to t
              set found to true
            end if
          end try
        end repeat
      end repeat
    end if
  end repeat`
  const runJs = family === 'safari' ? `do JavaScript js in chosen` : `execute chosen javascript js`
  return `set js to read POSIX file "${jsFile}" as «class utf8»
tell application "${app}"
  if (count of windows) is 0 then return "{\\"ok\\":false,\\"error\\":\\"浏览器没有打开的窗口\\"}"
  ${pickTab}
  try
    return ${runJs}
  on error errMsg
    return "XDOWN-ERROR:" & errMsg
  end try
end tell`
}

function parseExternalResult(raw: string): ExternalFetch | null {
  const text = raw.trim()
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { ok?: boolean; status?: number; b64?: string; error?: string }
    const buf = Buffer.from(parsed.b64 || '', 'base64')
    return {
      ok: Boolean(parsed.ok),
      status: Number(parsed.status) || 0,
      buf,
      text: buf.subarray(0, 800).toString('utf8'),
      error: parsed.error
    }
  } catch {
    return null
  }
}

function appleJsError(message: string, app = '浏览器'): string {
  if (/not authorized|-1743/i.test(message)) {
    return '系统未允许控制该浏览器。请在「系统设置 → 隐私与安全性 → 自动化」里勾选 Xdownloader。'
  }
  if (/turned off|Apple.?Event|JavaScript through AppleScript|执行 JavaScript/i.test(message)) {
    return `${app} 需要允许脚本读页面。请打开 ${app}「查看 → 开发者 → 允许来自 Apple 事件的 JavaScript」，保持播放页打开后再下载。`
  }
  if (/not allowed/i.test(message)) {
    return '系统未允许控制该浏览器。请在「系统设置 → 隐私与安全性 → 自动化」里勾选 Xdownloader。'
  }
  return message
}

async function enableAppleEventsJs(family: string): Promise<void> {
  const id = BUNDLE_IDS[family]
  if (!id) return
  await run('/usr/bin/defaults', ['write', id, 'AppleEventsAllowJavaScript', '-bool', 'true'], 5000).catch(() => undefined)
}

function cookieError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/not authorized|-1743|不允许|not allowed/i.test(text)) {
    return '系统未允许控制该浏览器。请在「系统设置 → 隐私与安全性 → 自动化」里勾选 Xdownloader。'
  }
  if (/cookies? database|Could not copy|Unable to find|locked|busy/i.test(text)) {
    return '浏览器 Cookies 被占用。可先关掉该浏览器再导入，或等几秒后重试。'
  }
  return text || '读不到浏览器 Cookies'
}

function run(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${resourceBinDir()}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`
      }
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('操作超时'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(out)
        return
      }
      reject(new Error(err.trim().split('\n').filter(Boolean).pop() || `${binary} 退出 ${code ?? 'null'}`))
    })
  })
}
