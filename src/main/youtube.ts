import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { bundledTool, resourceBinDir } from './binaries'

export type YtQuality = string

export type YtQualityOption = {
  id: string
  label: string
  height: number
  fps?: number
}

export type YtProbe = {
  url: string
  title: string
  qualities: YtQualityOption[]
}

export type ResolvedStream = {
  url: string
  ext: string
  headers: string[]
  height?: number
}

export type ResolvedVideo = {
  title: string
  pageUrl: string
  progressive?: ResolvedStream
  video?: ResolvedStream
  audio?: ResolvedStream
}

type YtFormat = {
  format_id?: string
  url?: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  fps?: number
  tbr?: number
  abr?: number
  protocol?: string
  http_headers?: Record<string, string>
}

type YtInfo = {
  _type?: string
  id?: string
  title?: string
  webpage_url?: string
  original_url?: string
  url?: string
  ext?: string
  formats?: YtFormat[]
  requested_formats?: YtFormat[]
  http_headers?: Record<string, string>
  entries?: (YtInfo | null)[]
}

const YT_HOSTS = new Set([
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com'
])

const YT_BINARIES = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp']
const FFMPEG_BINARIES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']

export function isYouTubeUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '').toLowerCase()
    return YT_HOSTS.has(host)
  } catch {
    return false
  }
}

export function findYtDlp(custom = ''): string | null {
  return firstExisting([custom, process.env.YT_DLP_PATH, bundledTool('ytdlp'), ...YT_BINARIES])
}

export function findFfmpeg(): string | null {
  return firstExisting([process.env.FFMPEG_PATH, bundledTool('ffmpeg'), ...FFMPEG_BINARIES])
}

const infoCache = new Map<string, { at: number; info: YtInfo; cookies: string }>()
const YT_PLAYER_CLIENTS = 'youtube:player_client=web_safari,web_embedded,web,ios,-tv,-tv_downgraded'

export async function resolveYouTube(
  pageUrl: string,
  quality: YtQuality,
  binary: string,
  cookiesFromBrowser = ''
): Promise<ResolvedVideo[]> {
  const info = await loadYouTubeInfo(pageUrl, binary, cookiesFromBrowser)
  return flattenInfo(info)
    .map((item) => pickStreams(item, quality, pageUrl))
    .filter((item): item is ResolvedVideo => Boolean(item?.progressive || item?.video || item?.audio))
}

export async function probeYouTube(
  pageUrl: string,
  binary: string,
  cookiesFromBrowser = ''
): Promise<YtProbe> {
  const info = await loadYouTubeInfo(pageUrl, binary, cookiesFromBrowser, true)
  const first = flattenInfo(info)[0]
  return {
    url: pageUrl,
    title: first?.title || first?.id || 'YouTube',
    qualities: listQualities(first)
  }
}

export function toCookiesBrowser(id: string): string {
  if (!id || id === 'none' || id === 'auto') return id
  if (id === 'arc') return 'chrome'
  return id
}

async function loadYouTubeInfo(
  pageUrl: string,
  binary: string,
  cookiesFromBrowser: string,
  single = false
): Promise<YtInfo> {
  const cookies = toCookiesBrowser(cookiesFromBrowser)
  const cached = infoCache.get(pageUrl)
  if (cached && cached.cookies === cookies && Date.now() - cached.at < 90_000) return cached.info

  let lastError = 'YouTube 解析失败'
  const attempts = cookies ? [cookies, ''] : ['']
  for (const attempt of attempts) {
    try {
      const info = await fetchYouTubeInfo(pageUrl, binary, attempt, single)
      if (!hasPlayableInfo(info)) throw new Error('没有解析到可下载格式')
      infoCache.set(pageUrl, { at: Date.now(), info, cookies: attempt })
      return info
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      infoCache.delete(pageUrl)
      if (!attempt || !shouldRetryAnonymous(lastError)) break
    }
  }
  throw new Error(friendlyYtError(lastError))
}

async function fetchYouTubeInfo(
  pageUrl: string,
  binary: string,
  cookiesFromBrowser: string,
  single: boolean
): Promise<YtInfo> {
  const args = [
    '-J',
    '--no-warnings',
    '--no-update',
    '--ignore-config',
    '--no-check-certificates',
    '--extractor-args',
    YT_PLAYER_CLIENTS
  ]
  if (single || !isPlaylistUrl(pageUrl)) args.push('--no-playlist')
  else args.push('--yes-playlist')
  if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser)
  args.push(pageUrl)
  const raw = await run(binary, args, isPlaylistUrl(pageUrl) && !single ? 180000 : 90000)
  return JSON.parse(raw) as YtInfo
}

function hasPlayableInfo(info: YtInfo): boolean {
  return flattenInfo(info).some((item) => Boolean(item.formats?.length || item.url || item.requested_formats?.length))
}

function shouldRetryAnonymous(message: string): boolean {
  return /reload|not a bot|Sign in|cookies? database|Could not copy|Unable to find|locked|UNPLAYABLE/i.test(message)
}

function friendlyYtError(raw: string): string {
  const text = raw.replace(/^ERROR:\s*/i, '').trim()
  if (/page needs to be reloaded/i.test(text)) {
    return 'YouTube 拒绝了浏览器 Cookies。请在 Brave 里打开一次该视频后再试，或换已登录的浏览器。'
  }
  if (/Sign in|not a bot/i.test(text)) {
    return 'YouTube 要求登录验证。请选择已登录 YouTube 的本机浏览器。'
  }
  if (/unavailable/i.test(text)) {
    return '视频不可用。请核对链接（0 和 o 不同），或确认该视频未删除/未设为私密。'
  }
  if (/cookies? database|Could not copy|Unable to find|locked/i.test(text)) {
    return '读不到浏览器 Cookies。请完全退出该浏览器后再试。'
  }
  return text
}

export function listQualities(info?: YtInfo): YtQualityOption[] {
  if (!info) return []
  const byHeight = new Map<number, YtFormat>()
  for (const format of (info.formats ?? []).filter(usable).filter(hasVideo)) {
    const height = format.height ?? 0
    if (height < 144) continue
    const current = byHeight.get(height)
    if (!current || byVideo(format, current) < 0) byHeight.set(height, format)
  }
  return [...byHeight.values()]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .map((format) => {
      const height = format.height ?? 0
      const fps = format.fps && format.fps >= 48 ? Math.round(format.fps) : undefined
      return {
        id: String(height),
        height,
        fps,
        label: `${height}p${fps ? fps : ''}${hasAudio(format) ? ' 一步到位' : ' + 音频'}`
      }
    })
}

export type UnmergedPair = {
  videoPath: string
  audioPath: string
  outputPath: string
}

export async function mergeMedia(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw new Error('未找到 ffmpeg，无法合成 YouTube 音画')
  await waitFile(videoPath)
  await waitFile(audioPath)
  const videoClock = await probeClock(ffmpeg, videoPath).catch(() => ({ start: 0, duration: 0 }))
  const audioClock = await probeClock(ffmpeg, audioPath).catch(() => ({ start: 0, duration: 0 }))
  const inputs = alignedInputs(videoPath, audioPath, videoClock.start, audioClock.start)
  const mux = ['-map', '0:v:0', '-map', '1:a:0', '-avoid_negative_ts', 'make_zero', '-max_interleave_delta', '0', '-movflags', '+faststart', '-shortest']
  try {
    await run(ffmpeg, [...inputs, ...mux, '-c', 'copy', outputPath], 300000)
    if (await outputLooksCut(ffmpeg, outputPath, videoClock.duration, audioClock.duration)) {
      throw new Error('copy 合成时长异常')
    }
  } catch (copyError) {
    try {
      const args = [
        ...inputs,
        ...mux,
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-af',
        'aresample=async=1:first_pts=0'
      ]
      await run(ffmpeg, [...args, outputPath], 300000)
    } catch (encodeError) {
      const copyMsg = copyError instanceof Error ? copyError.message : String(copyError)
      const encodeMsg = encodeError instanceof Error ? encodeError.message : String(encodeError)
      throw new Error(encodeMsg || copyMsg || 'ffmpeg 合成失败')
    }
  }
  await unlink(videoPath).catch(() => undefined)
  await unlink(audioPath).catch(() => undefined)
  await unlink(`${videoPath}.aria2`).catch(() => undefined)
  await unlink(`${audioPath}.aria2`).catch(() => undefined)
}

export async function findUnmergedPairs(dir: string): Promise<UnmergedPair[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const files = names.filter((name) => !name.startsWith('.') && !name.endsWith('.aria2'))
  const videos = files.filter((name) => /\.video(\.\d+)?\.[^.]+$/.test(name))
  const audios = files.filter((name) => /\.audio(\.\d+)?\.[^.]+$/.test(name))
  const pairs: UnmergedPair[] = []
  for (const video of videos) {
    const stem = video.replace(/\.video(\.\d+)?\.[^.]+$/, '')
    const audio = audios.find((name) => name.replace(/\.audio(\.\d+)?\.[^.]+$/, '') === stem)
    if (!audio) continue
    const vExt = video.split('.').pop() || 'mp4'
    const aExt = audio.split('.').pop() || 'm4a'
    const ext = vExt === 'mp4' && /m4a|mp4|aac/.test(aExt) ? 'mp4' : 'mkv'
    const outputPath = join(dir, `${stem || 'youtube'}.${ext}`)
    const videoPath = join(dir, video)
    const audioPath = join(dir, audio)
    if (existsSync(outputPath) && statSync(outputPath).size > 1024) {
      await unlink(videoPath).catch(() => undefined)
      await unlink(audioPath).catch(() => undefined)
      await unlink(`${videoPath}.aria2`).catch(() => undefined)
      await unlink(`${audioPath}.aria2`).catch(() => undefined)
      continue
    }
    pairs.push({ videoPath, audioPath, outputPath })
  }
  return pairs
}

function waitFile(path: string, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let lastSize = -1
    let stable = 0
    const tick = () => {
      if (existsSync(path)) {
        const size = statSync(path).size
        if (size > 0 && size === lastSize) {
          stable += 1
          if (stable >= 3) {
            resolve()
            return
          }
        } else {
          stable = 0
          lastSize = size
        }
      }
      if (Date.now() - started > timeoutMs) {
        if (existsSync(path) && statSync(path).size > 0) {
          resolve()
          return
        }
        reject(new Error(`文件未就绪：${path}`))
        return
      }
      setTimeout(tick, 200)
    }
    tick()
  })
}

type MediaClock = { start: number; duration: number }

function alignedInputs(videoPath: string, audioPath: string, videoStart: number, audioStart: number): string[] {
  const args = ['-hide_banner', '-y', '-fflags', '+genpts']
  const delay = videoStart - audioStart
  if (delay >= 0.02) {
    args.push('-i', videoPath, '-itsoffset', delay.toFixed(3), '-i', audioPath)
  } else if (delay <= -0.02) {
    args.push('-itsoffset', (-delay).toFixed(3), '-i', videoPath, '-i', audioPath)
  } else {
    args.push('-i', videoPath, '-i', audioPath)
  }
  return args
}

async function probeClock(ffmpeg: string, file: string): Promise<MediaClock> {
  const probe = ffmpeg.replace(/ffmpeg$/, 'ffprobe')
  const binary =
    (existsSync(probe) ? probe : null) ||
    bundledTool('ffprobe') ||
    firstExisting(['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'])
  if (!binary) return { start: 0, duration: 0 }
  const raw = await run(
    binary,
    ['-v', 'error', '-show_entries', 'stream=start_time,duration:format=duration', '-of', 'json', file],
    15000
  )
  const data = JSON.parse(raw) as {
    streams?: { start_time?: string; duration?: string }[]
    format?: { duration?: string }
  }
  const stream = data.streams?.[0]
  const start = Number(stream?.start_time ?? 0)
  const duration = Number(stream?.duration || data.format?.duration || 0)
  return {
    start: Number.isFinite(start) ? start : 0,
    duration: Number.isFinite(duration) ? duration : 0
  }
}

async function outputLooksCut(ffmpeg: string, file: string, videoDuration: number, audioDuration: number): Promise<boolean> {
  const expect = Math.min(videoDuration || Infinity, audioDuration || Infinity)
  if (!Number.isFinite(expect) || expect <= 0) return false
  const out = await probeClock(ffmpeg, file).catch(() => ({ start: 0, duration: 0 }))
  return out.duration <= 0 || out.duration + 1.2 < expect
}

export function safeFilename(title: string): string {
  return (title || 'youtube-video').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function pickStreams(info: YtInfo, quality: YtQuality, fallbackUrl: string): ResolvedVideo | null {
  const formats = (info.formats ?? []).filter(usable)
  if (!formats.length && info.url) {
    return {
      title: info.title || info.id || 'YouTube',
      pageUrl: info.webpage_url || fallbackUrl,
      progressive: toStream(info as YtFormat, info)
    }
  }
  const cap = quality === 'best' || quality === 'audio' ? Infinity : Number(quality) || Infinity
  const progressive = bestAtOrBelow(formats.filter((item) => hasVideo(item) && hasAudio(item)), cap)
  const video = bestAtOrBelow(formats.filter((item) => hasVideo(item) && !hasAudio(item)), cap)
  const audio = formats.filter((item) => hasAudio(item) && !hasVideo(item)).sort(byAudio)[0]

  if (quality === 'audio') {
    const only = audio || progressive
    if (!only) return null
    return {
      title: info.title || info.id || 'YouTube 音频',
      pageUrl: info.webpage_url || fallbackUrl,
      audio: toStream(only, info)
    }
  }

  if (progressive && (progressive.height ?? 0) >= (video?.height ?? 0)) {
    return {
      title: info.title || info.id || 'YouTube',
      pageUrl: info.webpage_url || fallbackUrl,
      progressive: toStream(progressive, info)
    }
  }

  if (video && audio) {
    return {
      title: info.title || info.id || 'YouTube',
      pageUrl: info.webpage_url || fallbackUrl,
      video: toStream(video, info),
      audio: toStream(audio, info)
    }
  }

  if (progressive) {
    return {
      title: info.title || info.id || 'YouTube',
      pageUrl: info.webpage_url || fallbackUrl,
      progressive: toStream(progressive, info)
    }
  }
  return null
}

function toStream(format: YtFormat, info: YtInfo): ResolvedStream {
  const headers = { ...(info.http_headers ?? {}), ...(format.http_headers ?? {}) }
  if (!headers.Referer && !headers.referer) headers.Referer = info.webpage_url || info.original_url || ''
  return {
    url: format.url ?? '',
    ext: format.ext || 'mp4',
    height: format.height,
    headers: Object.entries(headers)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${value}`)
  }
}

function usable(format: YtFormat): boolean {
  if (!format.url) return false
  const protocol = format.protocol ?? ''
  return !/m3u8|ism|mhtml|websocket|rtmp/i.test(protocol)
}

function hasVideo(format: YtFormat): boolean {
  return Boolean(format.vcodec && format.vcodec !== 'none')
}

function hasAudio(format: YtFormat): boolean {
  return Boolean(format.acodec && format.acodec !== 'none')
}

function bestAtOrBelow(formats: YtFormat[], cap: number): YtFormat | undefined {
  const exact = formats.filter((item) => item.height === cap).sort(byVideo)[0]
  if (exact) return exact
  return formats.filter((item) => (item.height ?? 0) <= cap).sort(byVideo)[0]
}

function byVideo(a: YtFormat, b: YtFormat): number {
  return (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0) || (b.fps ?? 0) - (a.fps ?? 0)
}

function byAudio(a: YtFormat, b: YtFormat): number {
  return (b.abr ?? 0) - (a.abr ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0)
}

function flattenInfo(info: YtInfo): YtInfo[] {
  if (info._type === 'playlist') {
    return (info.entries ?? []).filter((item): item is YtInfo => Boolean(item)).flatMap(flattenInfo)
  }
  return [info]
}

function isPlaylistUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.pathname.includes('/playlist') || (url.searchParams.has('list') && !url.searchParams.has('v'))
  } catch {
    return false
  }
}

function firstExisting(list: (string | undefined)[]): string | null {
  const prefixes = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  for (const item of list) {
    if (!item) continue
    if (item.includes('/') && existsSync(item)) return item
    if (!item.includes('/')) {
      for (const prefix of prefixes) {
        const full = join(prefix, item)
        if (existsSync(full)) return full
      }
    }
  }
  return null
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
      const last = err.trim().split('\n').filter(Boolean).pop()
      reject(new Error(last || `${binary} 退出 ${code ?? 'null'}`))
    })
  })
}
