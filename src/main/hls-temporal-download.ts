import { mkdir, writeFile, link, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { bundledTool } from './binaries'
import { downloadHlsImpersonated, type ImpersonatedHlsOptions } from './youtube'
import { parseTemporal, partitionTemporal, serveManifests } from './hls-temporal'
import type { HlsProgress } from '../shared/types'
import { mergeTemporalParts } from './hls-temporal-merge'

export async function mergeTemporal(folder: string, destination: string, onProgress?: (message: string) => void): Promise<void> {
  try {
    await mergeTemporalParts(folder, destination, onProgress)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无损合并失败：${reason}。所有分段已保留在 ${folder}，可直接重试合并，无需重新下载。`)
  }
}

export async function temporalPreflight(binary: string, options: ImpersonatedHlsOptions, count: number, overlap: number) {
  const raw = JSON.parse(await downloadHlsImpersonated(binary, { ...options, manifestOnly: true })) as { url: string; text: string }
  return partitionTemporal(parseTemporal(raw.text, raw.url), count, overlap)
}
async function inspect(path: string): Promise<{ duration: number; start: number }> {
  const binary = bundledTool('ffprobe') || '/opt/homebrew/bin/ffprobe'
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ['-v', 'error', '-show_entries', 'format=start_time,duration:stream=codec_type,start_time,duration', '-of', 'json', path])
    let text = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.stdout.on('data', b => { text += b })
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error('ffprobe 验证失败')) })
  })
  const info = JSON.parse(raw)
  const duration = Number(info.format?.duration), start = Number(info.format?.start_time)
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(start)) throw new Error('输出时间戳无效')
  return { duration, start }
}
export async function downloadTemporal(binary: string, options: ImpersonatedHlsOptions, parts: Awaited<ReturnType<typeof temporalPreflight>>, stage: string, destination: string) {
  const server = await serveManifests(parts.map(p => p.manifest))
  const progress: (HlsProgress | undefined)[] = new Array(parts.length)
  const probes: { duration: number; start: number }[] = new Array(parts.length)
  let cursor = 0
  let failure: unknown
  const duration = parts[parts.length - 1].coreEnd
  const emit = () => {
    const percent = parts.reduce((n, p, i) => {
      const state = progress[i]
      if (state?.phase === '已验证') return n + (p.coreEnd - p.coreStart) / duration * 100
      const durations = [...p.manifest.matchAll(/#EXTINF:([\d.]+)/g)].map(m => Number(m[1]))
      const completed = Math.min(durations.length, state?.fragmentIndex ?? 0)
      const reached = p.actualStart + durations.slice(0, completed).reduce((a, b) => a + b, 0)
      return n + Math.max(0, Math.min(p.coreEnd, reached) - p.coreStart) / duration * 100
    }, 0)
    options.onProgress?.({ downloadedBytes: progress.reduce((n, p) => n + (p?.downloadedBytes ?? 0), 0), totalBytes: null, totalBytesEstimate: null,
      speed: progress.reduce((n, p) => n + (p?.speed ?? 0), 0), eta: null, fragmentIndex: null, fragmentCount: null, percent: Math.min(99, percent), phase: '时间分区下载（Chrome，最多4连接）',
      parts: parts.map((p, i) => ({ index: i + 1, percent: progress[i]?.percent ?? 0, bytes: progress[i]?.downloadedBytes ?? 0, speed: progress[i]?.speed ?? 0, phase: progress[i]?.phase ?? '排队' })),
      overlapSeconds: parts.reduce((n, p) => n + p.actualEnd - p.actualStart, 0) - duration })
  }
  try {
    await Promise.all(Array.from({ length: Math.min(4, parts.length) }, async () => {
      while (!failure) {
        const i = cursor++; if (i >= parts.length) return
        try {
          const path = join(stage, `part-${String(i + 1).padStart(2, '0')}.mp4`)
          // yt-dlp retries individual fragments in place. A final 429 can retry
          // this part once, never completed siblings; this is not resume.
          let wastedBytes = 0
          for (let attempt = 0; ; attempt++) {
            const attemptDir = join(stage, `attempt-${i}-${attempt}`)
            await mkdir(attemptDir)
            const attemptPath = join(attemptDir, 'media.mp4')
            try {
              await downloadHlsImpersonated(binary, { ...options, url: server.urls[i], sourceUrl: options.url, dest: attemptPath, proxy: '', fragmentConcurrency: parts.length === 1 ? 4 : 1,
                onProgress: p => { progress[i] = { ...p, downloadedBytes: wastedBytes + p.downloadedBytes }; emit() } })
              await link(attemptPath, path)
              break
            } catch (error) {
              if (attempt >= 1 || !/429|Too Many Requests/i.test(String(error))) throw error
              wastedBytes = progress[i]?.downloadedBytes ?? 0
              if (progress[i]) progress[i] = { ...progress[i]!, speed: 0, phase: '429：8秒后仅重试此分区（非续传）' }
              emit(); await new Promise(resolve => setTimeout(resolve, 8000))
            } finally { await rm(attemptDir, { recursive: true, force: true }) }
          }
          probes[i] = await inspect(path)
          const expected = parts[i].actualEnd - parts[i].actualStart
          if (Math.abs(probes[i].duration - expected) > Math.max(2, expected * 0.02)) throw new Error(`分区 ${i + 1} 输出时长不匹配`)
          progress[i] = { ...progress[i]!, percent: 100, speed: 0, phase: '已验证' }; emit()
        } catch (error) { failure = error }
      }
    }))
    if (failure) throw failure
    const metadata = { version: 1, duration, overlapSeconds: parts.reduce((n, p) => n + p.actualEnd - p.actualStart, 0) - duration,
      overlapMode: 'forward-only: each non-final part extends its end by overlap seconds into the next core; core starts are rounded outward to fragment boundaries only',
      note: 'Core ranges use the source EXTINF timeline. MP4 timestamps may be rebased; trim relative to actualStart. Frame-exact deduplication requires decoding/re-encoding, not keyframe-only stream copy.',
      parts: await Promise.all(parts.map(async ({ manifest: _manifest, ...p }, i) => ({ ...p, file: `part-${String(i + 1).padStart(2, '0')}.mp4`, bytes: (await stat(join(stage, `part-${String(i + 1).padStart(2, '0')}.mp4`))).size, output: probes[i] }))) }
    await writeFile(join(stage, 'segments.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' })
    // Exclusive directory reservation; publish only generated allowlisted files.
    await mkdir(destination)
    try {
      for (const name of [...metadata.parts.map(p => p.file), 'segments.json']) await link(join(stage, name), join(destination, name))
    } catch (error) {
      // This directory was exclusively created above by this call.
      await rm(destination, { recursive: true, force: true })
      throw error
    }
    return metadata.parts.reduce((n, p) => n + p.bytes, 0)
  } finally { await server.close() }
}
