import { spawn } from 'node:child_process'
import { link, lstat, mkdtemp, readFile, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { bundledTool } from './binaries'

// Lossless, overlap-aware assembly of a temporal `.parts` folder using only the
// bundled ffmpeg. Each seam is located by compressed-packet identity, never by
// container duration, and the result is verified packet by packet.

type Packet = { dts: number; pts: number; duration: number; size: number; md5: string }
type Stream = { index: number; tb: [number, number]; packets: Packet[] }
type Manifest = {
  version: number
  duration: number
  parts: { index: number; file: string; bytes: number; coreStart: number; coreEnd: number; actualStart: number; actualEnd: number }[]
}

const MATCH = 32
const SEAM_WINDOW = 8

function ffmpegPath(): string {
  const path = bundledTool('ffmpeg')
  if (!path) throw new Error('未找到内置 ffmpeg，无法合并分段')
  return path
}

function exec(binary: string, args: string[], timeoutMs = 6 * 60 * 60 * 1000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk) => { err = (err + String(chunk)).slice(-4000) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(Buffer.concat(out).toString('utf8'))
      else reject(new Error(err.trim().split('\n').pop() || `ffmpeg 退出 ${code}`))
    })
  })
}

// framemd5 lists every packet in container order with timestamps in the
// stream time base; `-c copy` makes the hash cover the compressed bytes.
export function parseFramemd5(text: string): Map<number, Stream> {
  const streams = new Map<number, Stream>()
  for (const line of text.split('\n')) {
    const tb = /^#tb (\d+): (\d+)\/(\d+)/.exec(line)
    if (tb) {
      streams.set(Number(tb[1]), { index: Number(tb[1]), tb: [Number(tb[2]), Number(tb[3])], packets: [] })
      continue
    }
    if (!line || line.startsWith('#')) continue
    const cols = line.split(',').map((item) => item.trim())
    const stream = streams.get(Number(cols[0]))
    if (!stream || cols.length < 6) continue
    stream.packets.push({ dts: Number(cols[1]), pts: Number(cols[2]), duration: Number(cols[3]), size: Number(cols[4]), md5: cols[5] })
  }
  return streams
}

async function packets(file: string, window?: { start: number; length: number }): Promise<Map<number, Stream>> {
  const args = ['-v', 'error']
  if (window) args.push('-ss', String(Math.max(0, window.start)), '-t', String(window.length))
  args.push('-i', file, '-map', '0', '-c', 'copy', '-copyts', '-f', 'framemd5', '-')
  return parseFramemd5(await exec(ffmpegPath(), args))
}

async function regularFile(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null)
  if (!info) throw new Error(`缺少文件：${basename(path)}`)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`不是普通文件：${basename(path)}`)
}

export async function readTemporalManifest(folder: string): Promise<{ root: string; manifest: Manifest; files: string[] }> {
  const root = resolve(folder)
  if ((await realpath(root)) !== root) throw new Error('分段目录不能是符号链接')
  const manifestPath = join(root, 'segments.json')
  await regularFile(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  if (manifest?.version !== 1 || !Array.isArray(manifest.parts) || manifest.parts.length < 2 || manifest.parts.length > 16) {
    throw new Error('segments.json 版本或分段数量无效')
  }
  const files: string[] = []
  let previous = 0
  for (const [i, part] of manifest.parts.entries()) {
    if (part.index !== i || part.file !== `part-${String(i + 1).padStart(2, '0')}.mp4`) throw new Error('segments.json 分段编号或文件名无效')
    const values = [part.coreStart, part.coreEnd, part.actualStart, part.actualEnd]
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) throw new Error('segments.json 时间轴无效')
    if (Math.abs(part.coreStart - previous) > 0.001 || !(part.actualStart <= part.coreStart && part.coreStart < part.coreEnd && part.coreEnd <= part.actualEnd)) {
      throw new Error('segments.json 时间轴不连续')
    }
    if (i > 0 && manifest.parts[i - 1].actualEnd - part.actualStart < 2) throw new Error('相邻分段重叠不足，无法验证接缝')
    previous = part.coreEnd
    const file = join(root, part.file)
    await regularFile(file)
    if ((await stat(file)).size !== part.bytes) throw new Error(`${part.file} 大小与 segments.json 不符，文件可能不完整`)
    files.push(file)
  }
  if (typeof manifest.duration !== 'number' || Math.abs(previous - manifest.duration) > 0.001) throw new Error('segments.json 总时长无效')
  return { root, manifest, files }
}

type Seam = { cut: Map<number, number> }

// Find where part i+1 starts inside part i: its first packets of every stream
// must equal a unique run of MATCH consecutive packets with identical deltas.
async function findSeam(left: string, right: string, offsetInLeft: number): Promise<Seam> {
  const [l, r] = await Promise.all([
    packets(left, { start: offsetInLeft - 2, length: SEAM_WINDOW + 4 }),
    packets(right, { start: 0, length: SEAM_WINDOW })
  ])
  if (l.size !== 2 || r.size !== 2) throw new Error('只支持一路视频加一路音频的分段')
  const cut = new Map<number, number>()
  const shifts: number[] = []
  for (const [index, rs] of r) {
    const ls = l.get(index)
    if (!ls || rs.packets.length < MATCH) throw new Error('接缝附近数据不足，无法验证')
    const head = rs.packets.slice(0, MATCH)
    const hits: number[] = []
    for (let j = 0; j + MATCH <= ls.packets.length; j += 1) {
      if (ls.packets[j].md5 !== head[0].md5) continue
      const shift = ls.packets[j].dts - head[0].dts
      const same = head.every((p, k) => {
        const q = ls.packets[j + k]
        return q.md5 === p.md5 && q.dts - p.dts === shift && q.pts - p.pts === shift
      })
      if (same) hits.push(j)
    }
    if (hits.length !== 1) throw new Error('重叠区内找不到唯一一致的数据包，拒绝合并')
    const at = ls.packets[hits[0]]
    cut.set(index, at.dts)
    shifts.push((at.dts - head[0].dts) * ls.tb[0] / ls.tb[1])
  }
  if (Math.abs(shifts[0] - shifts[1]) > 0.002) throw new Error('音视频在接缝处的偏移不一致，拒绝合并')
  return { cut }
}

function streamKind(index: number): 'v' | 'a' {
  return index === 0 ? 'v' : 'a'
}

export async function mergeTemporalParts(folder: string, destination: string, onProgress?: (message: string) => void): Promise<{ output: string; duration: number }> {
  const ffmpeg = ffmpegPath()
  const dest = resolve(destination)
  const { manifest, files } = await readTemporalManifest(folder)
  if (await lstat(dest).catch(() => null)) throw new Error('目标文件已存在，不会覆盖')
  const total = (await Promise.all(files.map((file) => stat(file)))).reduce((n, info) => n + info.size, 0)
  const fs = await statfs(dirname(dest))
  if (fs.bavail * fs.bsize < total * 2.2) throw new Error('磁盘空间不足，合并需要约两倍分段大小的临时空间')

  const streamsOf = await packets(files[0], { start: 0, length: 2 })
  if (streamsOf.size !== 2 || !streamsOf.has(0) || !streamsOf.has(1)) throw new Error('只支持一路视频加一路音频的分段')

  const seams: Seam[] = []
  for (let i = 1; i < files.length; i += 1) {
    onProgress?.(`验证接缝 ${i}/${files.length - 1}`)
    seams.push(await findSeam(files[i - 1], files[i], manifest.parts[i].actualStart - manifest.parts[i - 1].actualStart))
  }

  const work = await mkdtemp(join(dirname(dest), '.temporal-merge-'))
  const tmp = join(work, 'merged.mp4')
  try {
    const expected = new Map<number, string[]>([[0, []], [1, []]])
    for (const index of [0, 1]) {
      const kind = streamKind(index)
      const list: string[] = []
      for (const [i, file] of files.entries()) {
        onProgress?.(`整理${kind === 'v' ? '视频' : '音频'}分段 ${i + 1}/${files.length}`)
        const piece = join(work, `${kind}${i}.mp4`)
        const args = ['-v', 'error', '-i', file, '-map', `0:${index}`, '-c', 'copy']
        const cut = seams[i]?.cut.get(index)
        if (cut !== undefined) args.push('-bsf', `noise=drop=gte(dts\\,${cut})`)
        await exec(ffmpeg, [...args, piece])
        const kept = (await packets(piece)).get(0)
        if (!kept?.packets.length) throw new Error(`分段 ${i + 1} 裁剪后为空`)
        if (cut !== undefined && kept.packets.some((p) => p.dts >= cut)) throw new Error(`分段 ${i + 1} 裁剪越界`)
        const want = expected.get(index)!
        for (const p of kept.packets) want.push(p.md5)
        list.push(`file '${piece.replace(/'/g, "'\\''")}'`)
      }
      const listFile = join(work, `${kind}.txt`)
      await writeFile(listFile, list.join('\n') + '\n')
      onProgress?.(`拼接${kind === 'v' ? '视频' : '音频'}`)
      await exec(ffmpeg, ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-map', '0', '-c', 'copy', join(work, `${kind}.mp4`)])
    }
    onProgress?.('封装音视频')
    await exec(ffmpeg, ['-v', 'error', '-i', join(work, 'v.mp4'), '-i', join(work, 'a.mp4'), '-map', '0:0', '-map', '1:0', '-c', 'copy', '-movflags', '+faststart', tmp])

    onProgress?.('逐包校验输出')
    const out = await packets(tmp)
    for (const index of [0, 1]) {
      const got = out.get(index)
      const want = expected.get(index)!
      if (!got || got.packets.length !== want.length || got.packets.some((p, k) => p.md5 !== want[k])) {
        throw new Error('输出数据包与分段不一致，拒绝发布')
      }
      for (let k = 1; k < got.packets.length; k += 1) {
        const prev = got.packets[k - 1], cur = got.packets[k]
        if (cur.dts <= prev.dts) throw new Error('输出时间戳不单调，拒绝发布')
        const gap = (cur.dts - prev.dts - prev.duration) * got.tb[0] / got.tb[1]
        if (Math.abs(gap) > 0.002) throw new Error(`输出在 ${(cur.dts * got.tb[0] / got.tb[1]).toFixed(2)} 秒处有间隙或重复，拒绝发布`)
      }
    }
    const probe = JSON.parse(await exec(bundledTool('ffprobe') || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', tmp]))
    const duration = Number(probe.format?.duration)
    if (!(Math.abs(duration - manifest.duration) <= 0.25)) throw new Error(`合并后时长 ${duration} 与预期 ${manifest.duration} 不符`)
    await link(tmp, dest)
    return { output: dest, duration }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
