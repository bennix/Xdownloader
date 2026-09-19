const URL_RE = /(?:https?|ftp|sftp):\/\/[^\s<>"'`]+|magnet:\?[^\s<>"'`]+/gi
const BARE_YT_RE =
  /(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s<>"'`]*v=|live\/|shorts\/|embed\/)|youtu\.be\/)[^\s<>"'`]+/gi

export function extractUrls(text: string): string[] {
  if (!text) return []
  const found = text.match(URL_RE) ?? []
  const bare = (text.match(BARE_YT_RE) ?? []).map((item) => (item.startsWith('http') ? item : `https://${item}`))
  return unique([...found, ...bare].map((u) => u.replace(/[),.;]+$/g, '')))
}

export function extractUrlsFromHtml(html: string): string[] {
  if (!html) return []
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1])
  return extractUrls(`${hrefs.join('\n')}\n${html}`)
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

export function normalizeDownloadUrl(value: string): string {
  const id = youtubeVideoId(value)
  return id ? `https://www.youtube.com/watch?v=${id}` : value
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

export function classifyUrl(value: string): 'magnet' | 'torrent' | 'metalink' | 'ftp' | 'youtube' | 'http' {
  const lower = value.toLowerCase()
  if (lower.startsWith('magnet:')) return 'magnet'
  if (/\.torrent(\?|#|$)/i.test(lower)) return 'torrent'
  if (/\.(metalink|meta4)(\?|#|$)/i.test(lower)) return 'metalink'
  if (lower.startsWith('ftp:') || lower.startsWith('sftp:')) return 'ftp'
  if (isYouTubeUrl(value) || /googlevideo\.com/i.test(lower)) return 'youtube'
  return 'http'
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}
