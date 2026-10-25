import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

export type TemporalSegment = { start: number; end: number; sequence: number; lines: string[]; url: string }
export type TemporalPlaylist = { duration: number; segments: TemporalSegment[]; target: number }
export type TemporalPart = { index: number; coreStart: number; coreEnd: number; actualStart: number; actualEnd: number; firstSequence: number; lastSequence: number; manifest: string }
export function temporalOptions(parts = 4, overlap = 30) {
  if (!Number.isInteger(parts) || parts < 1 || parts > 16) throw new Error('HLS 时间分区必须为 1–16')
  if (!Number.isFinite(overlap) || overlap < 0 || overlap > 600) throw new Error('HLS 重叠必须为 0–600 秒')
  return { parts, overlap }
}
const absolute = (uri: string, base: string) => {
  const u = new URL(uri, base)
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('不支持的 HLS URI')
  return u.href
}
// Conservative by design: only a single muxed media timeline is accepted.
export function parseTemporal(text: string, base: string): TemporalPlaylist {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('不是 HLS')
  if (!text.includes('#EXT-X-ENDLIST')) throw new Error('直播或未结束播放列表不能时间分区')
  if (/#EXT-X-(?:STREAM-INF|MEDIA:|DISCONTINUITY|GAP|PART:|SKIP:|I-FRAMES-ONLY|START:)/.test(text)) throw new Error('多轨、时间跳变或增量播放列表不支持时间分区')
  let sequence = 0, time = 0, duration = 0, target = 0
  let key = '', map = '', range = '', previousUrl = '', previousEnd = 0
  const segments: TemporalSegment[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(line.slice(22))
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('无效媒体序号')
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) target = Number(line.split(':')[1])
    else if (line.startsWith('#EXTINF:')) {
      duration = Number(line.slice(8).split(',')[0])
      if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('无效 EXTINF')
    } else if (line.startsWith('#EXT-X-KEY:')) {
      if (/METHOD=NONE(?:,|$)/.test(line)) key = line
      else {
        if (map) throw new Error('加密 MAP 不支持时间分区')
        if (!/METHOD=AES-128(?:,|$)/.test(line) || /KEYFORMAT=/.test(line) && !/KEYFORMAT="identity"/.test(line)) throw new Error('不支持的加密格式')
        if (!/URI="[^"]+"/.test(line)) throw new Error('缺少密钥 URI')
        key = line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${absolute(uri, base)}"`)
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      // MAP byte-range/encryption state has subtle IV semantics: explicitly fall back.
      if (/BYTERANGE=/.test(line) || key && !/METHOD=NONE/.test(key)) throw new Error('加密或字节范围 MAP 不支持时间分区')
      if (!/URI="[^"]+"/.test(line)) throw new Error('缺少 MAP URI')
      map = line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${absolute(uri, base)}"`)
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17)
    else if (!line.startsWith('#')) {
      if (!duration) throw new Error('缺少分片时长')
      const url = absolute(line, base)
      const lines: string[] = []
      if (key) lines.push(key)
      if (map) lines.push(map)
      lines.push(`#EXTINF:${duration},`)
      if (range) {
        const [length, offset] = range.split('@').map(Number)
        if (!Number.isSafeInteger(length) || length <= 0 || offset === undefined && previousUrl !== url) throw new Error('无效隐式字节范围')
        const start = offset ?? previousEnd
        if (!Number.isSafeInteger(start) || start < 0) throw new Error('无效字节偏移')
        lines.push(`#EXT-X-BYTERANGE:${length}@${start}`)
        previousEnd = start + length
      } else previousEnd = 0
      previousUrl = range ? url : ''
      segments.push({ start: time, end: time + duration, sequence: sequence++, lines, url })
      time += duration; duration = 0; range = ''
    }
  }
  if (!segments.length || !Number.isFinite(time) || !(target > 0)) throw new Error('空或无效时间轴')
  return { segments, duration: time, target }
}
export function partitionTemporal(p: TemporalPlaylist, count = 4, overlap = 30): TemporalPart[] {
  temporalOptions(count, overlap)
  count = Math.min(count, p.segments.length, Math.max(1, Math.floor(p.duration / Math.max(30, overlap))))
  return Array.from({ length: count }, (_, index) => {
    const coreStart = p.duration * index / count, coreEnd = p.duration * (index + 1) / count
    // Approved semantics: core start is rounded outward only to its fragment;
    // each non-final part extends its end by overlap, yielding >= overlap seconds
    // shared with the next part (plus fragment rounding), never overlap on both sides.
    const end = index === count - 1 ? p.duration : Math.min(p.duration, coreEnd + overlap)
    const selected = p.segments.filter(s => s.end > coreStart && s.start < end)
    const first = selected[0], last = selected[selected.length - 1]
    return { index, coreStart, coreEnd, actualStart: first.start, actualEnd: last.end, firstSequence: first.sequence, lastSequence: last.sequence,
      manifest: ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${p.target}`, `#EXT-X-MEDIA-SEQUENCE:${first.sequence}`, '#EXT-X-PLAYLIST-TYPE:VOD', ...selected.flatMap(s => [...s.lines, s.url]), '#EXT-X-ENDLIST', ''].join('\n') }
  })
}
// Exact random routes only. No filesystem, proxy, redirects or URL parameters.
export async function serveManifests(manifests: string[]) {
  const token = randomBytes(24).toString('hex')
  const routes = new Map(manifests.map((text, i) => [`/${token}/${i}.m3u8`, text]))
  const server = createServer((req, res) => {
    const text = routes.get(req.url || '')
    if (!text || req.method !== 'GET') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }); res.end(text)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  return { urls: [...routes.keys()].map(path => `http://127.0.0.1:${port}${path}`), close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) }
}
