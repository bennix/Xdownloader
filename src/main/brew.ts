import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bundledTool } from './binaries'

export type ToolId = 'brew' | 'aria2' | 'yt-dlp' | 'ffmpeg'

export type ToolStatus = {
  id: ToolId
  name: string
  formula: string
  installed: boolean
  path: string
  version: string
}

export type BrewProgress = {
  running: boolean
  auto: boolean
  percent: number
  line: string
  log: string
  missing: string[]
  tools: ToolStatus[]
  error: string
}

const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']
const EXTRA_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'

const TOOLS: { id: Exclude<ToolId, 'brew'>; name: string; formula: string; binaries: string[] }[] = [
  { id: 'aria2', name: 'aria2', formula: 'aria2', binaries: ['/opt/homebrew/bin/aria2c', '/usr/local/bin/aria2c', 'aria2c'] },
  { id: 'yt-dlp', name: 'yt-dlp', formula: 'yt-dlp', binaries: ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', 'yt-dlp'] },
  { id: 'ffmpeg', name: 'ffmpeg', formula: 'ffmpeg', binaries: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'] }
]

const state: BrewProgress = {
  running: false,
  auto: false,
  percent: 0,
  line: '',
  log: '',
  missing: [],
  tools: [],
  error: ''
}

type Listener = (progress: BrewProgress) => void
const listeners = new Set<Listener>()

export function onBrewProgress(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function brewSnapshot(): BrewProgress {
  state.tools = inspectTools()
  state.missing = state.tools.filter((item) => item.id !== 'brew' && !item.installed).map((item) => item.formula)
  return { ...state, tools: state.tools, missing: state.missing }
}

export function inspectTools(): ToolStatus[] {
  const brew = findExisting(BREW_CANDIDATES)
  const tools: ToolStatus[] = [
    {
      id: 'brew',
      name: 'Homebrew',
      formula: 'brew',
      installed: Boolean(brew),
      path: brew ?? '',
      version: brew ? '已安装' : ''
    }
  ]
  for (const item of TOOLS) {
    const bundled = bundledTool(item.id === 'yt-dlp' ? 'ytdlp' : item.id === 'aria2' ? 'aria2' : 'ffmpeg')
    const path = bundled || findExisting(item.binaries)
    tools.push({
      id: item.id,
      name: item.name,
      formula: item.formula,
      installed: Boolean(path),
      path: path ?? '',
      version: bundled ? '应用内置' : path ? '已安装' : ''
    })
  }
  return tools
}

export async function installMissing(auto = false): Promise<BrewProgress> {
  if (state.running) return brewSnapshot()
  const current = brewSnapshot()
  const brew = current.tools.find((item) => item.id === 'brew')
  if (!brew?.installed) {
    state.error = '未找到 Homebrew。请先安装：https://brew.sh'
    state.line = state.error
    emit()
    return brewSnapshot()
  }
  if (!current.missing.length) {
    state.line = '本机工具都已就绪'
    state.percent = 100
    emit()
    return brewSnapshot()
  }

  state.running = true
  state.auto = auto
  state.percent = 4
  state.error = ''
  state.line = auto ? `缺少 ${current.missing.join('、')}，正在自动安装…` : `开始安装 ${current.missing.join('、')}…`
  append(state.line)
  emit()

  try {
    await runBrew(brew.path, ['install', ...current.missing])
    state.percent = 100
    state.line = '安装完成'
    append('安装完成')
    const after = inspectTools()
    const stillMissing = after.filter((item) => item.id !== 'brew' && !item.installed)
    if (stillMissing.length) {
      state.error = `仍未就绪：${stillMissing.map((item) => item.name).join('、')}`
      state.line = state.error
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    state.line = state.error
    append(state.error)
  } finally {
    state.running = false
    emit()
  }
  return brewSnapshot()
}

function runBrew(brew: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(brew, args, {
      env: {
        ...process.env,
        PATH: `${EXTRA_PATH}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME || homedir(),
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_ENV_HINTS: '1',
        HOMEBREW_COLOR: '0'
      }
    })
    const onChunk = (chunk: Buffer) => consume(String(chunk))
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`brew 退出码 ${code ?? 'null'}`))
    })
  })
}

function consume(chunk: string): void {
  const lines = chunk.replace(/\r/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    append(line)
    state.line = line.slice(0, 180)
    const match = line.match(/(\d+(?:\.\d+)?)%/)
    if (match) state.percent = Math.max(state.percent, Math.min(99, Number(match[1])))
    else if (/Fetching|Downloading/i.test(line)) state.percent = Math.max(state.percent, 25)
    else if (/Pouring|Installing/i.test(line)) state.percent = Math.max(state.percent, 70)
    else if (/Summary|Pouring .*?\.tar/i.test(line)) state.percent = Math.max(state.percent, 90)
    emit()
  }
}

function append(line: string): void {
  state.log = `${state.log}${line}\n`.slice(-8000)
}

function emit(): void {
  const snap = brewSnapshot()
  for (const listener of listeners) listener(snap)
}

function findExisting(list: string[]): string | null {
  for (const item of list) {
    if (item.includes('/') && existsSync(item)) return item
    if (!item.includes('/')) {
      for (const prefix of EXTRA_PATH.split(':')) {
        const full = join(prefix, item)
        if (existsSync(full)) return full
      }
    }
  }
  return null
}

