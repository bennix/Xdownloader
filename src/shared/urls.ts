const URL_RE = /(?:https?|ftp|sftp):\/\/[^\s<>"'`]+|magnet:\?[^\s<>"'`]+/gi
const BARE_YT_RE =
  /(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s<>"'`]*v=|live\/|shorts\/|embed\/)|youtu\.be\/)[^\s<>"'`]+/gi
const BARE_X_RE =
  /(?:www\.|mobile\.)?(?:x\.com|twitter\.com|vxtwitter\.com|fxtwitter\.com)\/[^\s<>"'`]+/gi

export function extractUrls(text: string): string[] {
  if (!text) return []
  const found = text.match(URL_RE) ?? []
  const bareYt = (text.match(BARE_YT_RE) ?? []).map((item) => (item.startsWith('http') ? item : `https://${item}`))
  const bareX = (text.match(BARE_X_RE) ?? []).map((item) => (item.startsWith('http') ? item : `https://${item}`))
  return unique([...found, ...bareYt, ...bareX].map((u) => u.replace(/[),.;]+$/g, '')))
}

export function extractUrlsFromHtml(html: string): string[] {
  if (!html) return []
  const hrefs = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)].map((m) => m[1])
  const m3u8 = [...html.matchAll(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi)].map((m) => m[1])
  return extractUrls(`${hrefs.join('\n')}\n${m3u8.join('\n')}\n${html}`)
}

export function isDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'ftp:', 'sftp:', 'magnet:'].includes(url.protocol)
  } catch {
    return false
  }
}

export function youtubeVideoId(value: string): string {
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || ''
    if (host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
      return url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).at(-1) || ''
    }
  } catch {
    return ''
  }
  return ''
}

export function xStatusId(value: string): string {
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    if (!['x.com', 'twitter.com', 'mobile.twitter.com', 'vxtwitter.com', 'fxtwitter.com'].includes(host)) return ''
    const parts = url.pathname.split('/').filter(Boolean)
    const at = parts.findIndex((part) => part === 'status')
    return at >= 0 ? parts[at + 1]?.replace(/\D.*$/, '') || '' : ''
  } catch {
    return ''
  }
}

export function xVideoIndex(value: string): string {
  try {
    const parts = new URL(value).pathname.split('/').filter(Boolean)
    const at = parts.findIndex((part) => part === 'video' || part === 'photo')
    return at >= 0 ? parts[at + 1]?.replace(/\D.*$/, '') || '' : ''
  } catch {
    return ''
  }
}

export function mediaPageId(value: string): string {
  const yt = youtubeVideoId(value)
  if (yt) return `yt:${yt}`
  const x = xStatusId(value)
  if (x) {
    const index = xVideoIndex(value)
    return index ? `x:${x}:${index}` : `x:${x}`
  }
  return ''
}

export function normalizeDownloadUrl(value: string): string {
  const yt = youtubeVideoId(value)
  if (yt) return `https://www.youtube.com/watch?v=${yt}`
  const x = xStatusId(value)
  if (x) {
    const index = xVideoIndex(value)
    return index ? `https://x.com/i/status/${x}/video/${index}` : `https://x.com/i/status/${x}`
  }
  return value
}

export function isYouTubeUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '').toLowerCase()
    return (
      host === 'youtube.com' ||
      host === 'youtu.be' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com'
    )
  } catch {
    return false
  }
}

export function isXUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '').toLowerCase()
    return (
      host === 'x.com' ||
      host === 'twitter.com' ||
      host === 'mobile.twitter.com' ||
      host === 'vxtwitter.com' ||
      host === 'fxtwitter.com'
    )
  } catch {
    return false
  }
}

export function isHlsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const path = `${url.pathname}${url.search}`
    return /\.m3u8(\?|#|$)/i.test(path) || /[?&](?:playlist|format)=m3u8\b/i.test(url.search)
  } catch {
    return /\.m3u8/i.test(value)
  }
}

export function isMediaUrl(value: string): boolean {
  return isYouTubeUrl(value) || isXUrl(value) || isHlsUrl(value)
}

export function isSniffSegmentUrl(value: string): boolean {
  if (isHlsUrl(value)) return false
  try {
    const path = new URL(value).pathname
    if (/\.(m4s|ts)(\?|#|$)/i.test(path)) return true
    if (/\/(?:b-hls-\d+|hls|dash|chunk|fragments?|segments?)(\/|$)/i.test(path)) return true
    if (/_\d+p_h\d+_\d+_/i.test(path)) return true
    if (/(?:^|\/)(?:init|seg(?:ment)?[-_]?\d+)\.(?:mp4|m4s|ts)$/i.test(path)) return true
    return false
  } catch {
    return /\.(m4s|ts)(\?|#|$)/i.test(value)
  }
}

export function sniffFamilyKey(value: string): string {
  const bare = value.split('#')[0]
  try {
    const url = new URL(bare)
    if (isHlsUrl(bare) || isYouTubeUrl(bare) || isXUrl(bare)) return bare
    const path = url.pathname
    if (!isSniffSegmentUrl(bare)) return `${url.origin}${path}`
    const parts = path.split('/')
    const file = parts.pop() || ''
    const stem = file.replace(/_\d+(?=_|\.)/g, '_*').replace(/\d{8,}/g, '*')
    return `${url.origin}${parts.join('/')}/${stem}`
  } catch {
    return bare
  }
}

export function sniffMediaKind(value: string, mime = ''): 'hls' | 'youtube' | 'x' | 'http' | '' {
  const lower = value.toLowerCase()
  const type = mime.toLowerCase()
  if (/\.(js|css|woff2?|ttf|png|jpe?g|gif|svg|ico|map)(\?|#|$)/i.test(lower)) return ''
  if (/(google-analytics|doubleclick|facebook\.com\/tr|hotjar|sentry)/i.test(lower)) return ''
  if (/googlevideo\.com/i.test(lower)) return ''
  if (isSniffSegmentUrl(value)) return ''
  if (isHlsUrl(value) || /mpegurl|x-mpegurl/i.test(type)) return 'hls'
  if (isYouTubeUrl(value)) return 'youtube'
  if (isXUrl(value)) return 'x'
  if (/video\.twimg\.com/i.test(lower) && (/\.m3u8(\?|#|$)/i.test(lower) || /\.mp4(\?|#|$)/i.test(lower))) return 'x'
  if (/^video\//i.test(type) || /\.(mp4|m4s|m4a|webm|mov)(\?|#|$)/i.test(lower)) return 'http'
  return ''
}

export function classifyUrl(value: string): 'magnet' | 'torrent' | 'metalink' | 'ftp' | 'youtube' | 'x' | 'hls' | 'http' {
  const lower = value.toLowerCase()
  if (lower.startsWith('magnet:')) return 'magnet'
  if (/\.torrent(\?|#|$)/i.test(lower)) return 'torrent'
  if (/\.(metalink|meta4)(\?|#|$)/i.test(lower)) return 'metalink'
  if (lower.startsWith('ftp:') || lower.startsWith('sftp:')) return 'ftp'
  if (isYouTubeUrl(value) || /googlevideo\.com/i.test(lower)) return 'youtube'
  if (isXUrl(value) || /twimg\.com/i.test(lower)) return 'x'
  if (isHlsUrl(value)) return 'hls'
  return 'http'
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}
