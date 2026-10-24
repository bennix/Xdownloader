import { spawn } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { bundledTool, resourceBinDir } from './binaries'

export type HlsQuality = {
  id: string
  label: string
  height: number
  url: string
  bandwidth?: number
}

export type HlsChunk = {
  url: string
  sequence: number
  init: boolean
  start?: number
  end?: number
  keyHex?: string
  ivHex?: string
}

export type HlsPlan = {
  url: string
  live: boolean
  independentSegments: boolean
  hasMap: boolean
  container: 'fmp4' | 'ts'
  qualities: HlsQuality[]
  chunks: HlsChunk[]
  native: boolean
}

const NATIVE_CHUNK_LIMIT = 4000
const FFMPEG_BINARIES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']

function findFfmpeg(): string | null {
  const bundled = bundledTool('ffmpeg')
  if (bundled) return bundled
  return FFMPEG_BINARIES.find((item) => existsSync(item)) || null
}

export function isHlsText(text: string): boolean {
  return /^\s*#EXTM3U/m.test(text)
}

export const SNIFF_PARTITION = 'persist:xdown-sniffer'

export async function attachSessionHeaders(url: string, extra: string[] = []): Promise<string[]> {
  const rec = headerRecord(extra)
  try {
    const { session } = await import('electron')
    const ses = session.fromPartition(SNIFF_PARTITION)
    if (!extra.some((line) => /^user-agent:/i.test(line))) rec['User-Agent'] = ses.getUserAgent()
    const cookies = await ses.cookies.get({ url })
    if (cookies.length && !rec.Cookie && !rec.cookie) {
      rec.Cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ')
    }
  } catch {
    /* tests or session missing */
  }
  return Object.entries(rec).map(([key, value]) => `${key}: ${value}`)
}

function cloudflareBlocked(status: number, text = ''): boolean {
  return (
    (status === 403 || status === 503 || status === 429) &&
    /cloudflare|attention required|just a moment|cf-chl|challenge-platform|cf_chl_opt/i.test(text)
  )
}

function connectionClosed(message = ''): boolean {
  return /fetch failed|ECONNRESET|handshake|SSL|net_error|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|socket hang up/i.test(message)
}

export class HlsFetchError extends Error {
  readonly blocked: boolean
  constructor(message: string, blocked: boolean) {
    super(message)
    this.blocked = blocked
  }
}

function failure(url: string, got: BrowserFetch, what: string): HlsFetchError {
  const body = got.text || got.buf.subarray(0, 800).toString('utf8')
  if (cloudflareBlocked(got.status, body)) {
    return new HlsFetchError(
      `${what}被 Cloudflare 质询拦截（HTTP ${got.status}）。请先在浏览器里打开并播放该页面，再点下载。${tail(got.error)}`,
      true
    )
  }
  if (got.status === 403 || got.status === 401) {
    return new HlsFetchError(`${what}被拒绝（HTTP ${got.status}），链接可能已过期或需要登录。${tail(got.error)}`, true)
  }
  if (connectionClosed(got.error)) {
    return new HlsFetchError(
      `${what}时连接被关闭，可能是站点拦截或系统代理断开。${tail(got.error)}`,
      true
    )
  }
  return new HlsFetchError(`${what}失败${got.status ? ` HTTP ${got.status}` : ''}：${shortUrl(url)}${tail(got.error)}`, false)
}

function tail(detail?: string): string {
  return detail ? `（${detail}）` : ''
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname.slice(0, 60)}`
  } catch {
    return url.slice(0, 80)
  }
}

export async function fetchBuffer(
  url: string,
  headers: string[] = [],
  range?: { start: number; end: number }
): Promise<Buffer> {
  const got = await fetchViaBrowser(url, headers, range)
  if (got.ok) return got.buf
  throw failure(url, got, '下载分片')
}

export async function downloadChunksViaSession(
  plan: HlsPlan,
  dir: string,
  headers: string[] = []
): Promise<string[]> {
  await mkdir(dir, { recursive: true })
  const files = plan.chunks.map((chunk, index) => join(dir, chunkFileName(index, chunk.init)))
  for (let index = 0; index < plan.chunks.length; index += 1) {
    const chunk = plan.chunks[index]
    const dest = files[index]
    if (existsSync(dest)) {
      const info = await stat(dest).catch(() => ({ size: 0 }))
      if (info.size > 0) continue
    }
    const range = chunk.start != null && chunk.end != null ? { start: chunk.start, end: chunk.end } : undefined
    await writeFile(dest, await fetchBuffer(chunk.url, headers, range))
  }
  return files
}

export async function fetchText(url: string, headers: string[] = []): Promise<string> {
  const got = await fetchViaBrowser(url, headers)
  const text = got.buf.toString('utf8')
  if (got.ok && isHlsText(text)) return text
  if (got.ok) {
    if (cloudflareBlocked(403, text)) throw failure(url, { ...got, status: 403 }, '读取播放列表')
    throw new HlsFetchError('不是 HLS 播放列表', false)
  }
  throw failure(url, got, '读取播放列表')
}

type BrowserFetch = { url?: string; ok: boolean; status: number; buf: Buffer; text: string; error?: string }

async function fetchViaBrowser(
  url: string,
  headers: string[] = [],
  range?: { start: number; end: number }
): Promise<BrowserFetch> {
  // Explicitly use the sniff session; never read an unrelated browser tab.
  return fetchViaNet(url, headers, range)
}

async function fetchViaNet(
  url: string,
  headers: string[],
  range?: { start: number; end: number }
): Promise<BrowserFetch> {
  const { session } = await import('electron')
  const rec = headerRecord(await attachSessionHeaders(url, headers))
  delete rec.Cookie
  delete rec.cookie
  delete rec.Origin
  delete rec.origin
  if (range && range.start != null && range.end != null) rec.Range = `bytes=${range.start}-${range.end}`
  const res = await session.fromPartition(SNIFF_PARTITION).fetch(url, { headers: rec, redirect: 'follow', signal: AbortSignal.timeout(30000) })
  const buf = Buffer.from(await res.arrayBuffer())
  const text = buf.subarray(0, 800).toString('utf8')
  return { ok: res.ok, status: res.status, buf, text, url: res.url }
}

export async function probeHls(url: string, headers: string[] = []): Promise<{ title: string; qualities: HlsQuality[] }> {
  const plan = await resolveHls(url, headers, 'best')
  return {
    title: 'HLS',
    qualities: plan.qualities.length
      ? plan.qualities
      : plan.chunks.length
        ? [{ id: 'best', label: plan.container === 'fmp4' ? 'fMP4 分片' : 'HLS', height: 0, url }]
        : []
  }
}

export async function resolveHls(url: string, headers: string[] = [], quality = 'best', depth = 0): Promise<HlsPlan> {
  if (depth > 8) throw new Error('HLS 播放列表嵌套过深')
  const got = await fetchViaBrowser(url, headers)
  if (!got.ok) throw failure(url, got, '读取播放列表')
  const text = got.buf.toString('utf8')
  if (!isHlsText(text)) throw new Error('不是 HLS 播放列表')
  const parsed = parsePlaylist(text, got.url || url)
  if (parsed.qualities.length) {
    const chosen = pickQuality(parsed.qualities, quality)
    const child = await resolveHls(chosen.url, headers, quality, depth + 1)
    return {
      ...child,
      url: child.url,
      qualities: parsed.qualities,
      native: canNativelyDownload(child)
    }
  }
  return { ...parsed, native: canNativelyDownload(parsed) }
}

export function canNativelyDownload(plan: Pick<HlsPlan, 'live' | 'chunks' | 'hasMap'>): boolean {
  if (plan.live) return false
  if (!plan.chunks.length) return false
  if (plan.chunks.length > NATIVE_CHUNK_LIMIT) return false
  if (plan.hasMap && !plan.chunks.some((item) => item.init)) return false
  return plan.chunks.every((item) => item.url && (!item.keyHex || item.keyHex.length === 32))
}

export function parsePlaylist(text: string, baseUrl: string): HlsPlan {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const qualities: HlsQuality[] = []
  const chunks: HlsChunk[] = []
  let live = !/#EXT-X-ENDLIST/i.test(text)
  const independentSegments = /#EXT-X-INDEPENDENT-SEGMENTS/i.test(text)
  let hasMap = false
  let sequence = 0
  let pendingRange: { start: number; end: number } | undefined
  let keyHex = ''
  let keyIv = ''
  let expectSegment = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line || line.startsWith('#EXTM3U')) continue
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(line.slice(22)) || 0
      continue
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttrs(line.slice(11))
      const method = (attrs.METHOD || 'NONE').toUpperCase()
      if (method === 'NONE') {
        keyHex = ''
        keyIv = ''
      } else if (method === 'AES-128' && attrs.URI) {
        keyHex = `pending:${resolveUrl(attrs.URI, baseUrl)}`
        keyIv = attrs.IV ? attrs.IV.replace(/^0x/i, '').padStart(32, '0') : ''
      } else {
        keyHex = `unsupported:${method}`
      }
      continue
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      hasMap = true
      const attrs = parseAttrs(line.slice(11))
      if (!attrs.URI) continue
      const range = parseByteRange(attrs.BYTERANGE)
      chunks.push({
        url: resolveUrl(attrs.URI, baseUrl),
        sequence,
        init: true,
        start: range?.start,
        end: range?.end,
        keyHex: keyHex.startsWith('pending:') ? keyHex : keyHex || undefined,
        ivHex: keyIv || ivFromSequence(sequence)
      })
      continue
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(17))
      expectSegment = true
      continue
    }
    if (line.startsWith('#EXTINF:')) {
      expectSegment = true
      continue
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttrs(line.slice(18))
      const next = lines[i + 1]
      if (!next || next.startsWith('#')) continue
      i += 1
      const height = Number((attrs.RESOLUTION || '').split('x')[1]) || 0
      const bandwidth = Number(attrs.BANDWIDTH) || 0
      qualities.push({
        id: height ? String(height) : String(bandwidth || qualities.length + 1),
        label: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}kbps` : 'HLS',
        height,
        bandwidth,
        url: resolveUrl(next, baseUrl)
      })
      continue
    }
    if (line.startsWith('#')) continue
    if (expectSegment || pendingRange) {
      const range = pendingRange
      pendingRange = undefined
      expectSegment = false
      chunks.push({
        url: resolveUrl(line, baseUrl),
        sequence,
        init: false,
        start: range?.start,
        end: range?.end,
        keyHex: keyHex.startsWith('pending:') || keyHex.startsWith('unsupported:') ? keyHex : keyHex || undefined,
        ivHex: keyIv || ivFromSequence(sequence)
      })
      sequence += 1
    }
  }

  if (/unsupported:/i.test(chunks.map((item) => item.keyHex || '').join(' '))) live = live || false

  return {
    url: baseUrl,
    live,
    independentSegments,
    hasMap,
    container: hasMap || chunks.some((item) => /\.(m4s|mp4)(\?|$)/i.test(item.url)) ? 'fmp4' : 'ts',
    qualities: qualities.sort((a, b) => b.height - a.height || (b.bandwidth ?? 0) - (a.bandwidth ?? 0)),
    chunks,
    native: false
  }
}

export async function hydrateKeys(plan: HlsPlan, headers: string[] = []): Promise<HlsPlan> {
  const cache = new Map<string, string>()
  const chunks: HlsChunk[] = []
  const merged = await attachSessionHeaders(plan.url, headers)
  for (const chunk of plan.chunks) {
    const raw = chunk.keyHex || ''
    if (raw.startsWith('unsupported:')) {
      return { ...plan, native: false, chunks: plan.chunks }
    }
    if (raw.startsWith('pending:')) {
      const uri = raw.slice(8)
      let hex = cache.get(uri)
      if (!hex) {
        const buf = await fetchBuffer(uri, merged)
        hex = buf.subarray(0, 16).toString('hex')
        cache.set(uri, hex)
      }
      chunks.push({ ...chunk, keyHex: hex })
      continue
    }
    chunks.push(chunk)
  }
  const next = { ...plan, chunks }
  next.native = canNativelyDownload(next)
  return next
}

export async function assembleHls(files: string[], chunks: HlsChunk[], dest: string): Promise<string> {
  if (files.length !== chunks.length) throw new Error('HLS 分片数量不完整')
  const parts: Buffer[] = []
  for (let i = 0; i < files.length; i += 1) {
    const raw = await readFile(files[i])
    parts.push(decryptChunk(raw, chunks[i]))
  }
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, Buffer.concat(parts))
  return dest
}

export async function remuxLocalAv(video: string, audio: string, dest: string): Promise<string> {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw new Error('未找到 ffmpeg，无法封装 HLS')
  await mkdir(dirname(dest), { recursive: true })
  try {
    await run(
      ffmpeg,
      ['-hide_banner', '-y', '-i', video, '-i', audio, '-map', '0:v:0?', '-map', '1:a:0?', '-c', 'copy', '-movflags', '+faststart', dest],
      300000
    )
  } catch {
    await run(
      ffmpeg,
      ['-hide_banner', '-y', '-i', video, '-i', audio, '-map', '0:v:0?', '-map', '1:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', dest],
      300000
    )
  }
  return dest
}

export async function remuxToMp4(input: string, dest: string, container: 'fmp4' | 'ts'): Promise<string> {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw new Error('未找到 ffmpeg，无法封装 HLS')
  const copy = ['-hide_banner', '-y', '-i', input, '-c', 'copy', '-movflags', '+faststart']
  if (container === 'ts') copy.splice(7, 0, '-bsf:a', 'aac_adtstoasc')
  try {
    await run(ffmpeg, [...copy, dest], 300000)
  } catch {
    await run(
      ffmpeg,
      ['-hide_banner', '-y', '-i', input, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', dest],
      300000
    )
  }
  return dest
}

export async function ffmpegDownloadHls(url: string, headers: string[], dest: string, audioUrl?: string): Promise<string> {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw new Error('未找到 ffmpeg，无法下载 HLS')
  const header = ffmpegHeader(headers)
  const args = ['-hide_banner', '-y']
  if (header) args.push('-headers', header)
  args.push('-i', url)
  if (audioUrl) {
    if (header) args.push('-headers', header)
    args.push('-i', audioUrl, '-map', '0:v:0?', '-map', '1:a:0?')
  }
  args.push('-c', 'copy', '-movflags', '+faststart', dest)
  try {
    await run(ffmpeg, args, 900000)
  } catch {
    const retry = ['-hide_banner', '-y']
    if (header) retry.push('-headers', header)
    retry.push('-i', url)
    if (audioUrl) {
      if (header) retry.push('-headers', header)
      retry.push('-i', audioUrl, '-map', '0:v:0?', '-map', '1:a:0?')
    }
    retry.push('-c:v', 'copy', '-c:a', 'aac', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', dest)
    await run(ffmpeg, retry, 900000)
  }
  return dest
}

export async function cleanupFiles(paths: string[]): Promise<void> {
  for (const path of paths) {
    await unlink(path).catch(() => undefined)
    await unlink(`${path}.aria2`).catch(() => undefined)
  }
}

function pickQuality(qualities: HlsQuality[], quality: string): HlsQuality {
  if (!qualities.length) throw new Error('播放列表没有可用清晰度')
  if (quality === 'best' || quality === 'audio') return qualities[0]
  const cap = Number(quality) || Infinity
  return qualities.find((item) => item.height === cap) || qualities.find((item) => item.height <= cap) || qualities[0]
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi
  for (const match of raw.matchAll(re)) {
    out[match[1].toUpperCase()] = (match[3] ?? match[2] ?? '').replace(/^"|"$/g, '')
  }
  return out
}

function parseByteRange(raw?: string): { start: number; end: number } | undefined {
  if (!raw) return undefined
  const [length, offset] = raw.split('@').map((item) => Number(item))
  if (!Number.isFinite(length) || length <= 0) return undefined
  const start = Number.isFinite(offset) ? offset : 0
  return { start, end: start + length - 1 }
}

function resolveUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).href
  } catch {
    return value
  }
}

function ivFromSequence(sequence: number): string {
  const buf = Buffer.alloc(16)
  buf.writeUInt32BE(sequence >>> 0, 12)
  return buf.toString('hex')
}

function decryptChunk(data: Buffer, chunk: HlsChunk): Buffer {
  if (!chunk.keyHex || chunk.keyHex.length !== 32) return data
  const iv = Buffer.from((chunk.ivHex || ivFromSequence(chunk.sequence)).padStart(32, '0'), 'hex')
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(chunk.keyHex, 'hex'), iv)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

export function headerRecord(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of headers) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

function ffmpegHeader(headers: string[]): string {
  const rec = headerRecord(headers)
  return Object.entries(rec)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n')
    .concat('\r\n')
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
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('操作超时'))
    }, timeoutMs)
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
        resolve('')
        return
      }
      const last = err.trim().split('\n').filter(Boolean).pop()
      reject(new Error(last || `${binary} 退出 ${code ?? 'null'}`))
    })
  })
}

export function chunkFileName(index: number, init: boolean): string {
  return `${String(index).padStart(5, '0')}${init ? '.init' : ''}.part`
}
