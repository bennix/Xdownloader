import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAMES = {
  aria2: 'aria2c',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  ytdlp: 'yt-dlp'
} as const

export type BundledName = keyof typeof NAMES

export function resourceBinDir(): string {
  if (process.resourcesPath) {
    const packaged = join(process.resourcesPath, 'bin')
    if (existsSync(join(packaged, NAMES.aria2)) || existsSync(join(packaged, NAMES.ffmpeg))) return packaged
  }
  const fromCwd = join(process.cwd(), 'resources', 'bin')
  if (existsSync(fromCwd)) return fromCwd
  return join(dirname(fileURLToPath(import.meta.url)), '../../resources/bin')
}

export function bundledTool(name: BundledName | string): string | null {
  const file = NAMES[name as BundledName] ?? name
  const path = join(resourceBinDir(), file)
  return existsSync(path) ? path : null
}

export function bundledTools(): Record<'aria2' | 'ffmpeg' | 'ffprobe' | 'ytdlp', string | null> {
  return {
    aria2: bundledTool('aria2'),
    ffmpeg: bundledTool('ffmpeg'),
    ffprobe: bundledTool('ffprobe'),
    ytdlp: bundledTool('ytdlp')
  }
}
