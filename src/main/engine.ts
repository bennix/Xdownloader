import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync, lstatSync, realpathSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, rmdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { AddPayload, ConnectionLane, Settings, Snapshot, Task, TaskDetail, TaskFile, TaskKind, YtQuality } from '../shared/types'
import { classifyUrl, isDownloadUrl, isHlsUrl, isMediaUrl, isXUrl, isYouTubeUrl, mediaPageId, normalizeDownloadUrl, unique } from '../shared/urls'
import { bundledTool, resourceBinDir } from './binaries'
import { HlsQueue, publishHls, type HlsQueueItem } from './hls-queue'
import { temporalOptions } from './hls-temporal'
import { temporalPreflight, downloadTemporal, mergeTemporal } from './hls-temporal-download'
import { AriaRpc, unwrapMulticall } from './rpc'
import { getImportedUserAgent, importBrowserSession } from './browser-session'
import { listBrowserOptions, resolveCookiesArg } from './browsers'
import {
  BrokenTracksError,
  downloadHlsImpersonated,
  findUnmergedPairs,
  findYtDlp,
  mergeMedia,
  probeYouTube,
  resolveYouTube,
  safeFilename,
  type ResolvedStream,
  type ResolvedVideo
} from './youtube'
import {
  assembleHls,
  attachSessionHeaders,
  cleanupFiles,
  downloadChunksViaSession,
  hydrateKeys,
  remuxLocalAv,
  remuxToMp4,
  resolveHls,
  type HlsChunk
} from './hls'

const STATUS_KEYS = [
  'gid',
  'status',
  'totalLength',
  'completedLength',
  'uploadLength',
  'downloadSpeed',
  'uploadSpeed',
  'infoHash',
  'numSeeders',
  'seeder',
  'pieceLength',
  'numPieces',
  'connections',
  'errorCode',
  'errorMessage',
  'followedBy',
  'dir',
  'files',
  'bittorrent',
  'bitfield',
  'verifiedLength',
  'verifyIntegrityPending'
]

const CANDIDATES = ['/opt/homebrew/bin/aria2c', '/usr/local/bin/aria2c', '/usr/bin/aria2c']

type VersionInfo = {
  version: string
  enabledFeatures: string[]
}

type RawFile = {
  index?: string
  path?: string
  length?: string
  completedLength?: string
  selected?: string
  uris?: { uri?: string; status?: string }[]
}

type RawStatus = {
  gid?: string
  status?: string
  totalLength?: string
  completedLength?: string
  uploadLength?: string
  downloadSpeed?: string
  uploadSpeed?: string
  infoHash?: string
  numSeeders?: string
  seeder?: string
  pieceLength?: string
  numPieces?: string
  connections?: string
  errorMessage?: string
  followedBy?: string[]
  dir?: string
  files?: RawFile[]
  bittorrent?: { info?: { name?: string } }
  bitfield?: string
  verifiedLength?: string
  verifyIntegrityPending?: string
}

type RawServers = {
  index?: string
  servers?: { uri?: string; currentUri?: string; downloadSpeed?: string }[]
}[]

export class AriaEngine {
  private child: ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable> | null = null
  private rpc: AriaRpc | null = null
  private socket: WebSocket | null = null
  private settings: Settings
  version = ''
  features: string[] = []
  error = ''
  ready = false
  readonly port = 16800
  readonly secret = crypto.randomUUID().replaceAll('-', '')
  onEvent: ((method: string, gid: string, message?: string) => void) | null = null
  private readonly youtubeGids = new Set<string>()
  private readonly youtubePages = new Map<string, string>()
  private readonly addingPages = new Set<string>()
  private readonly mergeJobs: MergeJob[] = []
  private readonly hlsJobs: HlsJob[] = []
  private readonly managedHls = new HlsQueue<{ video: ResolvedVideo; payload: AddPayload; quality: string; dir: string; proxy: string; binary: string; browser: string }>(item => this.runManagedHls(item))
  private managedHlsTasks(): Task[] {
    return this.managedHls.items.map(item => ({ ...mapTask({ gid: item.id, status: item.status }, []),
      kind: 'hls', name: item.input.video.title,
      dir: item.input.dir, path: item.path, total: item.progress?.totalBytes ?? item.progress?.totalBytesEstimate ?? 0,
      completed: item.progress?.downloadedBytes ?? 0,
      speed: item.status === 'active' ? item.progress?.speed ?? 0 : 0,
      hls: { downloadedBytes: 0, totalBytes: null, totalBytesEstimate: null, speed: 0, eta: null,
        fragmentIndex: null, fragmentCount: null, ...item.progress,
        percent: item.status === 'complete' ? 100 : item.progress?.percent === null || !item.progress ? null : item.percent,
        phase: item.phase, ...(item.status !== 'active' ? { speed: 0, eta: null } : {}) },
      error: item.error, pageUrl: item.input.video.pageUrl, urls: [item.input.video.hls!.url] }))
  }
  private resolvingTasks(): Task[] {
    return [...this.addingPages].map(url => ({ ...mapTask({ gid: `resolve-${url}`, status: 'active' }, []),
      resolving: true, name: '正在解析媒体', kind: mediaTaskKind(url), pageUrl: url, urls: [url] }))
  }
  private cachedTasks: Task[] = []
  private history: HistoryItem[] = []
  private dismissedPaths = new Set<string>()
  private readonly mergeFailAt = new Map<string, number>()
  // Merges whose downloaded tracks are damaged; re-running them only re-decodes the same bad data.
  private readonly brokenMerges = new Set<string>()

  constructor(private readonly userData: string) {
    this.settings = defaultSettings()
  }

  get currentSettings(): Settings {
    return this.settings
  }

  get sessionFile(): string {
    return join(this.userData, 'aria2.session')
  }

  get settingsFile(): string {
    return join(this.userData, 'settings.json')
  }

  get serverStatFile(): string {
    return join(this.userData, 'server-stat.json')
  }

  get historyFile(): string {
    return join(this.userData, 'history.json')
  }

  async start(): Promise<void> {
    await mkdir(this.userData, { recursive: true })
    this.settings = await this.loadSettings()
    await this.loadHistory()
    await this.loadYoutubePages()
    await this.recoverHistoryFromDisk()
    await this.pruneSessionFile()
    const binary = resolveBinary(this.settings.aria2Path)
    if (!binary) {
      this.error = '未找到 aria2c。打开设置后会自动用 Homebrew 安装。'
      this.ready = false
      return
    }

    const args = this.buildArgs()
    const logs: string[] = []
    this.child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${resourceBinDir()}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`
      }
    })
    const onLog = (chunk: Buffer) => {
      const text = String(chunk)
      logs.push(text)
      if (/error|failed/i.test(text)) this.error = text.slice(0, 240)
    }
    this.child.stdout.on('data', onLog)
    this.child.stderr.on('data', onLog)
    this.child.on('error', (err) => {
      this.error = `无法启动 aria2c：${err.message}`
      this.ready = false
    })
    this.child.on('exit', (code, signal) => {
      this.ready = false
      if (!this.error) this.error = `aria2c 已退出 (${signal || code || 0})`
    })

    this.rpc = new AriaRpc(this.port, this.secret)
    try {
      await this.rpc.waitReady()
      const info = await this.rpc.call<VersionInfo>('aria2.getVersion')
      this.version = info.version
      this.features = info.enabledFeatures
      this.ready = true
      this.error = ''
      this.connectEvents()
      await this.loadMergeJobs()
      await this.loadHlsJobs()
      for (const job of this.hlsJobs) {
        if (job.gids[0]) void this.maybeAssembleHls(job.gids[0])
      }
    } catch (error) {
      const tail = logs.join('').replace(/\s+/g, ' ').trim().slice(-240)
      this.error = `${this.error ? `${this.error} · ` : ''}${error instanceof Error ? error.message : String(error)}${tail ? ` · ${tail}` : ''}`
      this.ready = false
      this.child.kill('SIGTERM')
    }
  }

  async stop(): Promise<void> {
    this.socket?.close()
    this.socket = null
    if (this.rpc && this.ready) {
      try {
        await this.rpc.call('aria2.saveSession')
        await this.rpc.call('aria2.forceShutdown')
      } catch {
        /* process may already be gone */
      }
    }
    this.child?.kill('SIGTERM')
    this.child = null
    this.ready = false
  }

  snapshotFallback(error = this.error): Snapshot {
    const managed = [...this.managedHlsTasks(), ...this.resolvingTasks()]
    const tasks = [...managed, ...this.history.map(item => this.historyToTask(item)),
      ...this.cachedTasks.filter(item => !item.gid.startsWith('hls-') && !item.resolving).map(item => ({
        ...item, speed: 0, uploadSpeed: 0, connections: 0, lanes: [],
        status: ['active', 'waiting', 'paused'].includes(item.status) ? 'unknown' : item.status
      }))].filter((item, index, all) => all.findIndex(other => other.gid === item.gid || (item.path && other.path === item.path)) === index)
    this.cachedTasks = tasks
    return {
      ...emptySnapshot(this.settings, error, this.version, this.features), tasks,
      downloadSpeed: managed.reduce((sum, task) => sum + task.speed, 0),
      numActive: tasks.filter(item => item.status === 'active').length,
      numWaiting: tasks.filter(item => item.status === 'waiting').length,
      numStopped: tasks.filter(item => ['complete', 'error', 'removed'].includes(item.status)).length,
      ...this.cookieState()
    }
  }

  async snapshot(): Promise<Snapshot> {
    if (!this.rpc || !this.ready) return this.snapshotFallback()
    try {
      return await this.connectedSnapshot()
    } catch (error) {
      return this.snapshotFallback(error instanceof Error ? error.message : '本地 aria2 RPC 状态读取失败')
    }
  }

  private async connectedSnapshot(): Promise<Snapshot> {
    const [activeWrap, waitingWrap, stoppedWrap, statWrap] = await this.rpc!.multicall([
      { methodName: 'aria2.tellActive', params: [STATUS_KEYS] },
      { methodName: 'aria2.tellWaiting', params: [0, 1000, STATUS_KEYS] },
      { methodName: 'aria2.tellStopped', params: [0, 1000, STATUS_KEYS] },
      { methodName: 'aria2.getGlobalStat' }
    ])

    const active = unwrapMulticall<RawStatus[]>(activeWrap)
    const waiting = unwrapMulticall<RawStatus[]>(waitingWrap)
    const stopped = unwrapMulticall<RawStatus[]>(stoppedWrap)
    const stat = unwrapMulticall<Record<string, string>>(statWrap)
    const laneMap = await this.collectLanes(active.map((item) => item.gid ?? ''))
    const tasks = [...active, ...waiting, ...stopped].map((item) => {
      const task = mapTask(item, laneMap.get(item.gid ?? '') ?? [])
      task.pageUrl = this.youtubePages.get(task.gid) || ''
      if (this.youtubeGids.has(task.gid)) task.kind = mediaTaskKind(task.pageUrl, task.urls)
      return task
    })
    for (const task of tasks) {
      if (task.status === 'complete') this.rememberTask(task)
    }
    void this.archiveFinished(tasks)
    const extras = this.history
      .filter((item) => !tasks.some((task) => task.gid === item.gid || (item.path && task.path === item.path)))
      .map((item) => this.historyToTask(item))
    const managed = [...this.managedHlsTasks(), ...this.resolvingTasks()]
    const all = [...tasks, ...extras.filter(task => !managed.some(item => item.path && item.path === task.path)), ...managed]
    this.cachedTasks = all
    void this.sweepMerges(tasks)

    return {
      ready: true,
      error: '',
      version: this.version,
      features: this.features,
      downloadSpeed: num(stat.downloadSpeed) + managed.reduce((sum, task) => sum + task.speed, 0),
      uploadSpeed: num(stat.uploadSpeed),
      numActive: num(stat.numActive) + managed.filter(item => item.status === 'active').length,
      numWaiting: num(stat.numWaiting) + managed.filter(item => item.status === 'waiting').length,
      numStopped: all.filter(item => ['complete', 'error', 'removed'].includes(item.status)).length,
      tasks: all,
      settings: this.settings,
      ...this.cookieState()
    }
  }

  async probeYouTube(url: string, cookiesFromBrowser?: string) {
    const binary = findYtDlp(this.settings.ytDlpPath)
    if (!binary) throw new Error('未找到 yt-dlp。请先执行 brew install yt-dlp')
    const browser = resolveCookiesArg(cookiesFromBrowser || this.settings.ytCookiesFromBrowser) ?? ''
    if (isHlsUrl(url) && browser) {
      await importBrowserSession(browser, [url], binary)
    }
    return probeYouTube(url, binary, browser)
  }

  async addDownloads(payload: AddPayload): Promise<{ ok: boolean; added: number; existing?: number; error?: string }> {
    const uris = unique(payload.uris.map((item) => normalizeDownloadUrl(item.trim())).filter(isDownloadUrl))
    if (!uris.length) return { ok: false, added: 0, error: '没有可用的下载链接' }

    const media = uris.filter(isMediaUrl)
    const rest = uris.filter((uri) => {
      if (isMediaUrl(uri) || this.isFinishedUrl(uri)) return false
      if (media.some(isYouTubeUrl) && /googlevideo\.com/i.test(uri)) return false
      if (media.some(isXUrl) && /twimg\.com/i.test(uri)) return false
      return true
    })
    let added = 0
    let existing = 0
    try {
      if (media.length) {
        const yt = await this.addYouTube(media, payload)
        if (!yt.ok && !rest.length) return yt
        added += yt.added
        existing += yt.existing ?? 0
        if (!yt.ok) this.error = yt.error ?? this.error
      }
      if (!rest.length) {
        if (added || existing) return { ok: true, added, existing }
        const already = uris.some((uri) => this.isFinishedUrl(uri) || (isMediaUrl(uri) && this.alreadyHaveYouTube(uri)))
        return { ok: false, added: 0, error: already ? '已经下载完成，不会重复添加' : '没有可用的下载链接' }
      }

      if (!this.rpc) throw new Error(`本地 aria2 RPC 未就绪 (127.0.0.1:${this.port})`)
      const options = this.taskOptions(payload)
      if (payload.multiSource) {
        const magnets = rest.filter((uri) => classifyUrl(uri) === 'magnet')
        const others = rest.filter((uri) => classifyUrl(uri) !== 'magnet')
        if (others.length) {
          await this.rpc.call('aria2.addUri', [others, options])
          added += 1
        }
        for (const magnet of magnets) {
          await this.rpc.call('aria2.addUri', [[magnet], { ...options, 'force-save': 'true' }])
          added += 1
        }
        return { ok: true, added }
      }
      for (const uri of rest) {
        const extra = classifyUrl(uri) === 'magnet' ? { ...options, 'force-save': 'true' } : options
        await this.rpc.call('aria2.addUri', [[uri], extra])
        added += 1
      }
      return { ok: true, added }
    } catch (error) {
      return { ok: false, added: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async addTorrent(base64: string, webSeeds: string[] = []): Promise<{ ok: boolean; error?: string }> {
    if (!this.rpc) return { ok: false, error: '引擎未就绪' }
    try {
      await this.rpc.call('aria2.addTorrent', [base64, webSeeds, { dir: this.settings.downloadDir, 'force-save': 'true' }])
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async addMetalink(base64: string): Promise<{ ok: boolean; added: number; existing?: number; error?: string }> {
    if (!this.rpc) return { ok: false, added: 0, error: '引擎未就绪' }
    try {
      const gids = await this.rpc.call<string[]>('aria2.addMetalink', [base64, { dir: this.settings.downloadDir, 'force-save': 'true' }])
      return { ok: true, added: gids.length }
    } catch (error) {
      return { ok: false, added: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async pause(gid: string): Promise<void> {
    await this.rpc?.call('aria2.pause', [gid])
  }

  async resume(gid: string): Promise<void> {
    await this.rpc?.call('aria2.unpause', [gid])
  }

  async remove(gid: string, deleteFiles = true): Promise<void> {
    const managed = this.managedHls.items.find((item) => item.id === gid)
    if (managed) {
      if (managed.status === 'active' || managed.status === 'waiting') throw new Error('HLS 正在下载，暂不支持中途删除')
      this.managedHls.items.splice(this.managedHls.items.indexOf(managed), 1)
      const files = managed.path ? [managed.path] : []
      if (!deleteFiles) this.dismissPaths(files)
      this.forgetHistory(gid, files)
      if (deleteFiles) await this.unlinkOwned(files)
      return
    }
    if (!deleteFiles) this.dismissPaths(this.history.filter((item) => item.gid === gid).map((item) => item.path))
    const files = deleteFiles ? await this.filePathsOf(gid) : []
    const job = this.mergeJobs.find((item) => item.videoGid === gid || item.audioGid === gid)
    if (deleteFiles && job) files.push(job.outputPath)
    if (this.rpc && this.ready && !this.history.some((item) => item.gid === gid && !/^[0-9a-f]{16}$/i.test(gid))) {
      try {
        await this.rpc.call('aria2.remove', [gid])
      } catch {
        await this.rpc.call('aria2.forceRemove', [gid]).catch(() => undefined)
      }
      await this.rpc.call('aria2.removeDownloadResult', [gid]).catch(() => undefined)
    }
    this.youtubeGids.delete(gid)
    this.youtubePages.delete(gid)
    void this.saveYoutubePages()
    this.forgetHistory(gid, files)
    this.cachedTasks = this.cachedTasks.filter((task) => task.gid !== gid)
    if (job && (job.videoGid === gid || job.audioGid === gid)) {
      const other = job.videoGid === gid ? job.audioGid : job.videoGid
      if (!this.youtubeGids.has(other)) {
        const index = this.mergeJobs.indexOf(job)
        if (index >= 0) this.mergeJobs.splice(index, 1)
        await this.saveMergeJobs()
      }
    }
    if (deleteFiles) await this.unlinkOwned(files)
  }

  async pauseAll(): Promise<void> {
    await this.rpc?.call('aria2.pauseAll')
  }

  async resumeAll(): Promise<void> {
    await this.rpc?.call('aria2.unpauseAll')
  }

  async move(gid: string, how: 'POS_SET' | 'POS_CUR' | 'POS_END', pos: number): Promise<void> {
    if (!this.rpc) throw new Error('引擎未就绪')
    const ids = String(gid ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    let last = '无法调整队列位置'
    for (const id of ids) {
      try {
        await this.rpc.call('aria2.changePosition', [id, pos, how])
        return
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
    }
    throw new Error(/GID|not found|position|waiting/i.test(last) ? '只有排队等待或已暂停的任务能排到最前' : last)
  }

  async urlsOf(gid: string): Promise<string[]> {
    const ids = String(gid ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    for (const id of ids) {
      const page = this.youtubePages.get(id)
      if (page) return [page]
    }
    if (!this.rpc) return []
    const collected: string[] = []
    for (const id of ids) {
      const files = await this.rpc.call<RawFile[]>('aria2.getFiles', [id]).catch(() => [])
      collected.push(...files.flatMap((file) => (file.uris ?? []).map((item) => item.uri ?? '')).filter(Boolean))
    }
    return unique(collected)
  }

  async maybeMerge(gid: string): Promise<void> {
    const job = this.mergeJobs.find((item) => item.videoGid === gid || item.audioGid === gid)
    if (!job || !this.rpc) return
    if (job.videoGid === gid) job.videoDone = true
    if (job.audioGid === gid) job.audioDone = true
    if (!job.videoDone || !job.audioDone || job.merging) return
    job.merging = true
    this.onEvent?.('aria.onYoutubeMerge', job.outputPath)
    try {
      const video = await this.pathOf(job.videoGid)
      const audio = await this.pathOf(job.audioGid)
      if (!video.path || !audio.path) throw new Error('音画文件还没就绪')
      const dest = await mergeMedia(video.path, audio.path, job.outputPath, job.sourceDuration)
      const pageUrl = this.youtubePages.get(job.videoGid) || this.youtubePages.get(job.audioGid) || ''
      await this.remove(job.videoGid, false).catch(() => undefined)
      await this.remove(job.audioGid, false).catch(() => undefined)
      this.rememberMerged(dest, pageUrl, mediaTaskKind(pageUrl))
      await this.rpc.call('aria2.saveSession').catch(() => undefined)
      const index = this.mergeJobs.indexOf(job)
      if (index >= 0) this.mergeJobs.splice(index, 1)
      await this.saveMergeJobs()
      this.mergeFailAt.delete(job.outputPath)
      this.onEvent?.('aria.onYoutubeMerged', dest)
    } catch (error) {
      job.merging = false
      const message = error instanceof Error ? error.message : String(error)
      this.error = message
      if (error instanceof BrokenTracksError) this.brokenMerges.add(job.outputPath)
      this.emitMergeError(job.outputPath, message)
    }
  }

  async pathOf(gid: string): Promise<{ dir: string; path: string }> {
    const ids = String(gid ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (this.rpc) {
      for (const id of ids) {
        try {
          const status = await this.rpc.call<RawStatus>('aria2.tellStatus', [id, ['dir', 'files']])
          const dir = status.dir || this.settings.downloadDir
          const raw = status.files?.find((file) => file.path)?.path || ''
          return { dir, path: absPath(dir, raw) }
        } catch {
          /* try next gid or cache */
        }
      }
    }
    const cached = this.cachedTasks.find((task) => ids.includes(task.gid))
    if (cached) {
      const dir = cached.dir || this.settings.downloadDir
      return { dir, path: absPath(dir, cached.path) }
    }
    const hist = this.history.find((item) => ids.includes(item.gid))
    if (hist) return { dir: hist.dir || this.settings.downloadDir, path: hist.path }
    return { dir: this.settings.downloadDir, path: '' }
  }

  locateExisting(target: { dir: string; path: string }): { dir: string; path: string } {
    const dir = target.dir || this.settings.downloadDir
    if (target.path && existsSync(target.path)) return { dir: dirname(target.path), path: target.path }
    const merged = guessMergedOutput(target.path)
    if (merged && existsSync(merged)) return { dir: dirname(merged), path: merged }
    if (dir && existsSync(dir)) return { dir, path: '' }
    const fallback = this.settings.downloadDir
    return { dir: existsSync(fallback) ? fallback : '', path: '' }
  }

  private async filePathsOf(gid: string): Promise<string[]> {
    if (this.rpc) {
      try {
        const status = await this.rpc.call<RawStatus>('aria2.tellStatus', [gid, ['dir', 'files']])
        const paths = (status.files ?? [])
          .map((file) => file.path)
          .filter((path): path is string => Boolean(path))
          .flatMap((path) => [path, `${path}.aria2`])
        if (paths.length) return paths
      } catch {
        /* fall through to history */
      }
    }
    const hist = this.history.find((item) => item.gid === gid)
    return hist?.path ? [hist.path, `${hist.path}.aria2`] : []
  }

  private async unlinkOwned(paths: string[]): Promise<void> {
    const roots = [this.settings.downloadDir, join(homedir(), 'Downloads', 'XDownlder')]
    for (const file of unique(paths)) {
      const abs = resolve(file)
      const allowed = roots.some((root) => {
        const base = resolve(root)
        return abs === base || abs.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
      })
      if (!allowed || !existsSync(abs)) continue
      if (lstatSync(abs).isDirectory()) {
        if (!/\.parts$/.test(abs) || realpathSync(abs) !== abs) continue
        const names = await readdir(abs)
        if (!names.includes('segments.json') || names.some(n => !/^(segments\.json|part-\d{2}\.mp4)$/.test(n) || !lstatSync(join(abs, n)).isFile())) continue
        // Never recursively remove a directory containing unexpected user files.
        for (const name of names) await unlink(join(abs, name))
        await rmdir(abs).catch(() => undefined)
      } else await unlink(abs).catch(() => undefined)
    }
  }

  async detail(gid: string): Promise<TaskDetail | null> {
    const ids = String(gid ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const parts: TaskDetail[] = []
    for (const id of ids) {
      const one = await this.detailOne(id).catch(() => null)
      if (one) parts.push(one)
    }
    if (parts.length) return combineDetails(parts)
    return this.detailFromCache(ids)
  }

  private async detailOne(gid: string): Promise<TaskDetail | null> {
    if (!this.rpc) return null
    let status: RawStatus | null = null
    try {
      status = await this.rpc.call<RawStatus>('aria2.tellStatus', [gid, STATUS_KEYS])
    } catch {
      status = await this.rpc.call<RawStatus>('aria2.tellStatus', [gid]).catch(() => null)
    }
    if (!status?.gid) return null
    const files = await this.rpc.call<RawFile[]>('aria2.getFiles', [gid]).catch(() => status.files ?? [])
    const uris = await this.rpc
      .call<{ uri?: string; status?: string }[]>('aria2.getUris', [gid])
      .catch(() => (status.files ?? []).flatMap((file) => file.uris ?? []))
    const servers = await this.rpc.call<RawServers>('aria2.getServers', [gid]).catch(() => [])
    const options = await this.rpc.call<Record<string, string>>('aria2.getOption', [gid]).catch(() => ({}))
    let peers: unknown[] = []
    if (status.infoHash) {
      peers = await this.rpc.call<unknown[]>('aria2.getPeers', [gid]).catch((): unknown[] => [])
    }
    const mappedFiles = (files ?? []).map(mapFile)
    const lanes = flattenServers(servers)
    const task = mapTask(status, lanes)
    task.pageUrl = this.youtubePages.get(task.gid) || ''
    if (this.youtubeGids.has(task.gid)) task.kind = mediaTaskKind(task.pageUrl, task.urls)
    return finalizeDetail({
      task,
      files: mappedFiles,
      uris: (uris ?? []).map((item) => ({ uri: item.uri ?? '', status: item.status ?? '' })),
      servers: (servers ?? []).map((item) => ({
        index: num(item.index),
        servers: (item.servers ?? []).map(mapLane)
      })),
      peers: (peers as Record<string, string>[]).map((peer) => ({
        ip: peer.ip ?? '',
        port: peer.port ?? '',
        bitfield: peer.bitfield ?? '',
        amChoking: peer.amChoking === 'true',
        peerChoking: peer.peerChoking === 'true',
        downloadSpeed: num(peer.downloadSpeed),
        uploadSpeed: num(peer.uploadSpeed),
        seeder: peer.seeder === 'true'
      })),
      options: options ?? {}
    })
  }

  private detailFromCache(ids: string[]): TaskDetail | null {
    const task = this.cachedTasks.find((item) => ids.includes(item.gid))
    if (!task) return null
    return finalizeDetail({
      task,
      files: task.files,
      uris: unique([...task.urls, ...task.files.flatMap((file) => file.uris.map((item) => item.uri))]).map((uri) => ({
        uri,
        status: 'used'
      })),
      servers: [],
      peers: [],
      options: {}
    })
  }

  async changeUris(gid: string, add: string[], del: string[] = []): Promise<void> {
    await this.rpc?.call('aria2.changeUri', [gid, 1, del, add])
  }

  async selectFiles(gid: string, indexes: number[]): Promise<void> {
    await this.rpc?.call('aria2.changeOption', [gid, { 'select-file': indexes.join(',') }])
  }

  async changeTaskOption(gid: string, options: Record<string, string>): Promise<void> {
    await this.rpc?.call('aria2.changeOption', [gid, options])
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    temporalOptions(patch.hlsPartitions ?? this.settings.hlsPartitions, patch.hlsOverlapSeconds ?? this.settings.hlsOverlapSeconds)
    this.settings = { ...this.settings, ...patch }
    await mkdir(dirname(this.settingsFile), { recursive: true })
    await writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf8')
    if (this.rpc && this.ready) {
      await this.rpc
        .call('aria2.changeGlobalOption', [
          {
            dir: this.settings.downloadDir,
            'max-concurrent-downloads': String(this.settings.maxConcurrent),
            'max-connection-per-server': String(this.settings.maxConnectionPerServer),
            split: String(this.settings.split),
            'min-split-size': this.settings.minSplitSize,
            'uri-selector': this.settings.uriSelector,
            'stream-piece-selector': this.settings.pieceSelector,
            'max-overall-download-limit': kibLimit(this.settings.maxSpeedKib),
            'max-overall-upload-limit': kibLimit(this.settings.maxUploadKib),
            'optimize-concurrent-downloads': this.settings.optimizeConcurrent ? 'true' : 'false',
            'seed-ratio': String(this.settings.seedRatio),
            'bt-max-peers': String(this.settings.btMaxPeers),
            'all-proxy': this.settings.allProxy,
            'user-agent': this.settings.userAgent
          }
        ])
        .catch(() => undefined)
    }
    return this.settings
  }

  private async collectLanes(gids: string[]): Promise<Map<string, ConnectionLane[]>> {
    const map = new Map<string, ConnectionLane[]>()
    if (!this.rpc || !gids.length) return map
    const calls = gids.filter(Boolean).map((gid) => ({
      methodName: 'aria2.getServers',
      params: [gid]
    }))
    if (!calls.length) return map
    const results = await this.rpc.multicall(calls)
    results.forEach((item, index) => {
      const gid = gids[index]
      if (!gid) return
      try {
        const servers = unwrapMulticall<RawServers>(item)
        map.set(gid, flattenServers(servers))
      } catch {
        map.set(gid, [])
      }
    })
    return map
  }

  private connectEvents(): void {
    if (!this.rpc) return
    const socket = new WebSocket(this.rpc.wsUrl)
    this.socket = socket
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'ws-hello',
          method: 'aria2.getVersion',
          params: [`token:${this.secret}`]
        })
      )
    })
    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as {
          method?: string
          params?: { gid?: string }[]
        }
        if (data.method && data.params?.[0]?.gid) {
          this.onEvent?.(data.method, data.params[0].gid)
        }
      } catch {
        /* ignore malformed frames */
      }
    })
  }

  private taskOptions(payload: AddPayload): Record<string, string | string[]> {
    const options: Record<string, string | string[]> = {
      dir: this.settings.downloadDir,
      split: String(payload.split ?? this.settings.split),
      'max-connection-per-server': String(this.settings.maxConnectionPerServer),
      'min-split-size': this.settings.minSplitSize,
      'stream-piece-selector': payload.pieceSelector ?? this.settings.pieceSelector,
      'uri-selector': this.settings.uriSelector,
      continue: 'true'
    }
    if (payload.out) options.out = payload.out
    if (payload.referer) options.referer = payload.referer
    if (payload.userAgent) options['user-agent'] = payload.userAgent
    if (payload.checksum) options.checksum = payload.checksum
    if (payload.headers?.length) options.header = payload.headers
    if (payload.pause) options.pause = 'true'
    return options
  }

  private buildArgs(): string[] {
    const s = this.settings
    const args = [
      `--enable-rpc=true`,
      `--rpc-listen-all=false`,
      `--rpc-listen-port=${this.port}`,
      `--rpc-secret=${this.secret}`,
      `--dir=${s.downloadDir}`,
      `--continue=true`,
      `--always-resume=true`,
      `--auto-file-renaming=true`,
      `--file-allocation=none`,
      `--disk-cache=64M`,
      `--max-concurrent-downloads=${s.maxConcurrent}`,
      `--split=${s.split}`,
      `--max-connection-per-server=${s.maxConnectionPerServer}`,
      `--min-split-size=${s.minSplitSize}`,
      `--uri-selector=${s.uriSelector}`,
      `--stream-piece-selector=${s.pieceSelector}`,
      `--max-overall-download-limit=${kibLimit(s.maxSpeedKib)}`,
      `--max-overall-upload-limit=${kibLimit(s.maxUploadKib)}`,
      `--check-integrity=${s.checkIntegrity}`,
      `--realtime-chunk-checksum=true`,
      `--enable-http-pipelining=${s.httpPipelining}`,
      `--http-accept-gzip=true`,
      `--optimize-concurrent-downloads=${s.optimizeConcurrent}`,
      `--reuse-uri=true`,
      `--remote-time=true`,
      `--max-tries=0`,
      `--retry-wait=3`,
      `--connect-timeout=30`,
      `--timeout=60`,
      `--save-session=${this.sessionFile}`,
      `--save-session-interval=20`,
      `--force-save=false`,
      ...(existsSync(this.sessionFile) ? [`--input-file=${this.sessionFile}`] : []),
      `--keep-unfinished-download-result=true`,
      `--max-download-result=1000`,
      `--rpc-save-upload-metadata=true`,
      `--follow-torrent=true`,
      `--follow-metalink=true`,
      `--enable-dht=true`,
      `--enable-dht6=true`,
      `--enable-peer-exchange=true`,
      `--bt-enable-lpd=true`,
      `--bt-save-metadata=true`,
      `--bt-hash-check-seed=true`,
      `--bt-remove-unselected-file=true`,
      `--bt-max-peers=${s.btMaxPeers}`,
      `--seed-ratio=${s.seedRatio}`,
      `--listen-port=6881-6999`,
      `--dht-listen-port=6881-6999`,
      `--metalink-preferred-protocol=https`,
      `--server-stat-of=${this.serverStatFile}`,
      `--server-stat-if=${this.serverStatFile}`,
      `--user-agent=${s.userAgent}`
    ]
    if (s.allProxy) args.push(`--all-proxy=${s.allProxy}`)
    return args
  }

  private cookieArg(): string {
    return resolveCookiesArg(this.settings.ytCookiesFromBrowser) ?? ''
  }

  private get mergeJobsFile(): string {
    return join(this.userData, 'merge-jobs.json')
  }

  private async saveMergeJobs(): Promise<void> {
    await writeFile(this.mergeJobsFile, JSON.stringify(this.mergeJobs), 'utf8').catch(() => undefined)
  }

  private async loadMergeJobs(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.mergeJobsFile, 'utf8')) as MergeJob[]
      this.mergeJobs.splice(0, this.mergeJobs.length, ...raw.map((item) => ({ ...item, merging: false })))
    } catch {
      /* first run */
    }
  }

  private get hlsJobsFile(): string {
    return join(this.userData, 'hls-jobs.json')
  }

  private async saveHlsJobs(): Promise<void> {
    await writeFile(this.hlsJobsFile, JSON.stringify(this.hlsJobs), 'utf8').catch(() => undefined)
  }

  private async loadHlsJobs(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.hlsJobsFile, 'utf8')) as HlsJob[]
      this.hlsJobs.splice(0, this.hlsJobs.length, ...raw.map((item) => ({ ...item, assembling: false })))
    } catch {
      /* first run */
    }
  }

  private get youtubePagesFile(): string {
    return join(this.userData, 'youtube-pages.json')
  }

  private async saveYoutubePages(): Promise<void> {
    await writeFile(this.youtubePagesFile, JSON.stringify([...this.youtubePages.entries()]), 'utf8').catch(() => undefined)
  }

  private async loadYoutubePages(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.youtubePagesFile, 'utf8')) as [string, string][]
      this.youtubePages.clear()
      this.youtubeGids.clear()
      for (const [gid, page] of raw) {
        if (!gid || !page) continue
        this.youtubePages.set(gid, page)
        this.youtubeGids.add(gid)
      }
    } catch {
      /* first run */
    }
  }

  isFinishedUrl(url: string): boolean {
    return this.alreadyHaveYouTube(url) || this.history.some((item) => item.urls.includes(url) && existsSync(item.path))
  }

  private alreadyHaveYouTube(url: string): boolean {
    if (this.hasYoutubePage(url)) return true
    const id = mediaPageId(url)
    return this.history.some((item) => {
      if (!item.pageUrl) return false
      const same = id ? mediaPageId(item.pageUrl) === id : item.pageUrl === url
      return same && (!item.path || existsSync(item.path))
    })
  }

  private pendingMerge(gid: string): boolean {
    return this.mergeJobs.some((job) => job.videoGid === gid || job.audioGid === gid)
  }

  private async archiveFinished(tasks: Task[]): Promise<void> {
    if (!this.rpc) return
    for (const task of tasks) {
      if (task.status !== 'complete' || task.infoHash || this.pendingMerge(task.gid)) continue
      await this.rpc.call('aria2.removeDownloadResult', [task.gid]).catch(() => undefined)
    }
  }

  private async pruneSessionFile(): Promise<void> {
    if (!existsSync(this.sessionFile)) return
    const raw = await readFile(this.sessionFile, 'utf8').catch(() => '')
    if (!raw.trim()) return
    const kept: string[] = []
    for (const block of raw.split(/\n{2,}/)) {
      const text = block.trim()
      if (!text) continue
      if (keepSessionEntry(text, this.settings.downloadDir)) kept.push(text)
    }
    const next = kept.length ? `${kept.join('\n\n')}\n` : ''
    await writeFile(this.sessionFile, next, 'utf8')
  }

  private async loadHistory(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.historyFile, 'utf8')) as HistoryItem[]
      this.history = Array.isArray(raw) ? raw.filter((item) => item?.gid && item.path) : []
    } catch {
      this.history = []
    }
    try {
      const raw = JSON.parse(await readFile(this.dismissedFile, 'utf8')) as string[]
      this.dismissedPaths = new Set(Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [])
    } catch {
      this.dismissedPaths = new Set()
    }
  }

  private get dismissedFile(): string {
    return join(this.userData, 'dismissed-files.json')
  }

  // Records the user cleared while keeping the file; the disk scan must not resurrect them.
  private dismissPaths(paths: string[]): void {
    const before = this.dismissedPaths.size
    for (const path of paths) if (path) this.dismissedPaths.add(resolve(path))
    if (this.dismissedPaths.size === before) return
    void writeFile(this.dismissedFile, JSON.stringify([...this.dismissedPaths].slice(-2000)), 'utf8').catch(() => undefined)
  }

  private async saveHistory(): Promise<void> {
    await writeFile(this.historyFile, JSON.stringify(this.history, null, 2), 'utf8').catch(() => undefined)
  }

  private async recoverHistoryFromDisk(): Promise<void> {
    const dir = this.settings.downloadDir
    const names = await readdir(dir).catch(() => [] as string[])
    let added = false
    for (const name of names) {
      if (!/\.(mp4|mkv|webm|m4a|mp3|mov|aac)$/i.test(name)) continue
      if (/\.(video|audio)(\.\d+)?\./.test(name)) continue
      const path = join(dir, name)
      if (this.history.some((item) => item.path === path)) continue
      if (this.dismissedPaths.has(resolve(path))) continue
      try {
        const st = statSync(path)
        if (!st.isFile() || st.size < 1024) continue
        this.history.push({
          gid: `file-${name}-${st.size}`,
          kind: /m4a|mp3|aac/i.test(name) ? 'youtube' : 'http',
          name,
          dir,
          path,
          total: st.size,
          pageUrl: '',
          urls: [],
          at: st.mtimeMs
        })
        added = true
      } catch {
        /* skip unreadable files */
      }
    }
    if (added) await this.saveHistory()
  }

  private rememberTask(task: Task): void {
    if (task.status !== 'complete' || !task.path) return
    const same = this.history.find((item) => item.gid === task.gid || item.path === task.path)
    if (same && same.total === (task.total || task.completed) && same.name === task.name) return
    this.upsertHistory({
      gid: task.gid,
      kind: task.kind,
      name: task.name,
      dir: task.dir || this.settings.downloadDir,
      path: task.path,
      total: task.total || task.completed,
      pageUrl: task.pageUrl,
      urls: task.pageUrl ? [task.pageUrl] : task.urls.slice(0, 4),
      at: Date.now()
    })
  }

  private rememberMerged(outputPath: string, pageUrl: string, kind: TaskKind): void {
    if (!outputPath || !existsSync(outputPath)) return
    const total = statSync(outputPath).isDirectory() ? readdirSync(outputPath).filter(n => /^part-\d{2}\.mp4$/.test(n)).reduce((n, name) => n + statSync(join(outputPath, name)).size, 0) : statSync(outputPath).size
    this.upsertHistory({
      gid: `done-${basename(outputPath)}-${total}`,
      kind,
      name: basename(outputPath),
      dir: dirname(outputPath),
      path: outputPath,
      total,
      pageUrl,
      urls: pageUrl ? [pageUrl] : [],
      at: Date.now()
    })
  }

  private upsertHistory(item: HistoryItem): void {
    if (item.path && this.dismissedPaths.delete(resolve(item.path))) {
      void writeFile(this.dismissedFile, JSON.stringify([...this.dismissedPaths]), 'utf8').catch(() => undefined)
    }
    this.history = this.history.filter((row) => row.gid !== item.gid && row.path !== item.path)
    this.history.unshift(item)
    if (this.history.length > 500) this.history.length = 500
    void this.saveHistory()
  }

  private forgetHistory(gid: string, paths: string[] = []): void {
    const before = this.history.length
    this.history = this.history.filter((item) => item.gid !== gid && !paths.includes(item.path))
    if (this.history.length !== before) void this.saveHistory()
  }

  private historyToTask(item: HistoryItem): Task {
    return {
      gid: item.gid,
      status: 'complete',
      kind: item.kind,
      name: item.name,
      dir: item.dir,
      path: item.path,
      total: item.total,
      completed: item.total,
      uploadLength: 0,
      speed: 0,
      uploadSpeed: 0,
      connections: 0,
      pieceLength: 0,
      numPieces: 0,
      bitfield: '',
      infoHash: '',
      numSeeders: 0,
      seeder: false,
      verifiedLength: 0,
      verifyPending: false,
      error: '',
      urls: item.urls,
      files: item.path
        ? [{ index: 1, path: item.path, length: item.total, completed: item.total, selected: true, uris: [] }]
        : [],
      lanes: [],
      pageUrl: item.pageUrl
    }
  }

  private sweepBusy = false

  private async sweepMerges(tasks: Task[]): Promise<void> {
    if (this.sweepBusy) return
    this.sweepBusy = true
    try {
      for (const job of [...this.mergeJobs]) {
        const video = tasks.find((task) => task.gid === job.videoGid)
        const audio = tasks.find((task) => task.gid === job.audioGid)
        if (video?.status === 'complete') job.videoDone = true
        if (audio?.status === 'complete') job.audioDone = true
        if (job.videoDone && job.audioDone && !job.merging && this.canRetryMerge(job.outputPath)) {
          await this.maybeMerge(job.videoGid)
        }
      }

      const done = tasks.filter((task) => task.status === 'complete')
      const buckets = new Map<string, Task[]>()
      for (const task of done) {
        const key = task.pageUrl || task.name.replace(/\.(video|audio)(\.\d+)?\.[^.]+$/, '')
        const list = buckets.get(key)
        if (list) list.push(task)
        else buckets.set(key, [task])
      }
      for (const items of buckets.values()) {
        const video = items.find((task) => /\.video(\.\d+)?\./.test(task.name) || task.path.includes('.video.'))
        const audio = items.find((task) => /\.audio(\.\d+)?\./.test(task.name) || task.path.includes('.audio.'))
        if (!video || !audio) continue
        if (this.mergeJobs.some((job) => job.videoGid === video.gid && job.audioGid === audio.gid)) continue
        const base = video.name.replace(/\.video(\.\d+)?\.[^.]+$/, '')
        this.mergeJobs.push({
          videoGid: video.gid,
          audioGid: audio.gid,
          outputPath: join(video.dir || this.settings.downloadDir, `${base}.mp4`),
          videoDone: true,
          audioDone: true,
          merging: false
        })
        await this.maybeMerge(video.gid)
      }

      for (const pair of await findUnmergedPairs(this.settings.downloadDir)) {
        if (!this.canRetryMerge(pair.outputPath)) continue
        this.onEvent?.('aria.onYoutubeMerge', pair.outputPath)
        try {
          const dest = await mergeMedia(pair.videoPath, pair.audioPath, pair.outputPath)
          this.mergeFailAt.delete(pair.outputPath)
          this.rememberMerged(dest, '', 'youtube')
          this.onEvent?.('aria.onYoutubeMerged', dest)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.error = message
          if (error instanceof BrokenTracksError) this.brokenMerges.add(pair.outputPath)
          this.emitMergeError(pair.outputPath, message)
        }
      }
    } finally {
      this.sweepBusy = false
    }
  }

  private canRetryMerge(key: string): boolean {
    if (this.brokenMerges.has(key)) return false
    const at = this.mergeFailAt.get(key) ?? 0
    return Date.now() - at > 20_000
  }

  private emitMergeError(key: string, message: string): void {
    const first = !this.mergeFailAt.has(key)
    this.mergeFailAt.set(key, Date.now())
    if (first) this.onEvent?.('aria.onYoutubeMergeError', key, message)
  }

  async maybeAssembleHls(gid: string): Promise<void> {
    const job = this.hlsJobs.find((item) => item.gids.includes(gid))
    if (!job || job.assembling) return
    const ready = job.files.every((path) => existsSync(path) && !existsSync(`${path}.aria2`))
    if (!ready) return
    job.assembling = true
    this.onEvent?.('aria.onYoutubeMerge', job.outputPath)
    try {
      const packed = `${job.outputPath}.hlsbin`
      await assembleHls(job.files, job.chunks, packed)
      const dest = await remuxToMp4(packed, job.outputPath, job.container)
      await unlink(packed).catch(() => undefined)
      await cleanupFiles(job.files)
      for (const id of job.gids) {
        await this.remove(id, false).catch(() => undefined)
      }
      this.rememberMerged(dest, job.pageUrl, mediaTaskKind(job.pageUrl))
      const index = this.hlsJobs.indexOf(job)
      if (index >= 0) this.hlsJobs.splice(index, 1)
      await this.saveHlsJobs()
      this.onEvent?.('aria.onYoutubeMerged', dest)
    } catch (error) {
      job.assembling = false
      const message = error instanceof Error ? error.message : String(error)
      this.error = message
      this.emitMergeError(job.outputPath, message)
    }
  }

  private hasYoutubePage(url: string): boolean {
    const id = mediaPageId(url)
    return [...this.youtubePages.values()].some((item) => (id ? mediaPageId(item) === id : item === url))
  }

  private cookieState() {
    try {
      const browsers = listBrowserOptions()
      const id = this.cookieArg()
      const match = browsers.find((item) => item.id === id)
      return {
        browsers,
        cookieBrowser: id,
        cookieLabel: match?.label || (id ? id : '未使用浏览器 Cookies')
      }
    } catch {
      return { browsers: [], cookieBrowser: '', cookieLabel: '' }
    }
  }

  private async addYouTube(
    urls: string[],
    payload: AddPayload
  ): Promise<{ ok: boolean; added: number; existing?: number; error?: string }> {
    const binary = findYtDlp(this.settings.ytDlpPath)
    if (!binary) return { ok: false, added: 0, error: '未找到 yt-dlp。请先执行 brew install yt-dlp' }
    const quality = payload.youtubeQuality || this.settings.youtubeQuality
    let added = 0
    let existing = 0
    let lastError = ''
    for (const url of unique(urls)) {
      if (this.addingPages.has(url) || this.alreadyHaveYouTube(url)) {
        existing += 1
        continue
      }
      this.addingPages.add(url)
      this.onEvent?.('aria.onYoutubeResolve', url)
      try {
        const videos = await resolveYouTube(
          url,
          quality,
          binary,
          resolveCookiesArg(payload.ytCookiesFromBrowser || this.settings.ytCookiesFromBrowser) ?? ''
        )
        const seen = new Set<string>()
        for (const video of videos) {
          const key = video.pageUrl || video.title
          if (seen.has(key)) continue
          seen.add(key)
          const count = await this.enqueueYouTube(video, payload, quality)
          if (count === -1) existing += 1
          else added += count
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      } finally {
        this.addingPages.delete(url)
      }
    }
    if (!added && !existing) return { ok: false, added: 0, error: lastError || '没有解析到可下载的视频' }
    return { ok: true, added, existing, error: lastError || undefined }
  }

  private async enqueueYouTube(video: ResolvedVideo, payload: AddPayload, quality: YtQuality): Promise<number> {
    const tag = quality === 'best' ? 'best' : quality === 'audio' ? 'audio' : `${quality}p`
    const base = payload.out || `${safeFilename(video.title)}.${tag}`
    if (quality === 'audio' && video.audio) {
      await this.addYtStream(video.audio, video.pageUrl, `${base}.${video.audio.ext}`, payload)
      return 1
    }
    if (video.progressive) {
      await this.addYtStream(video.progressive, video.pageUrl, `${base}.${video.progressive.ext}`, payload)
      return 1
    }
    if (video.video && video.audio) {
      const videoGid = await this.addYtStream(video.video, video.pageUrl, `${base}.video.${video.video.ext}`, payload)
      const audioGid = await this.addYtStream(video.audio, video.pageUrl, `${base}.audio.${video.audio.ext}`, payload)
      this.mergeJobs.push({
        videoGid,
        audioGid,
        outputPath: join(this.settings.downloadDir, `${base}.mp4`),
        sourceDuration: video.duration,
        videoDone: false,
        audioDone: false,
        merging: false
      })
      await this.saveMergeJobs()
      return 2
    }
    if (video.hls) {
      return this.enqueueHls(video, payload, quality)
    }
    if (video.audio) {
      await this.addYtStream(video.audio, video.pageUrl, `${base}.${video.audio.ext}`, payload)
      return 1
    }
    return 0
  }

  private async enqueueHls(video: ResolvedVideo, payload: AddPayload, quality: YtQuality): Promise<number> {
    if (!video.hls) return 0
    if (payload.pause) throw new Error('HLS 暂不支持暂停添加，请取消“暂停添加”')
    const binary = findYtDlp(this.settings.ytDlpPath)
    if (!binary) throw new Error('未找到 yt-dlp')
    const overlap = payload.hlsOverlapSeconds ?? this.settings.hlsOverlapSeconds
    const requested = payload.hlsPartitions ?? this.settings.hlsPartitions
    const parts = payload.hlsMode === 'single' ? 1
      : payload.hlsMode === 'temporal' ? (requested > 1 ? requested : 4)
        : requested
    const accepted = this.managedHls.add(`${video.hls.url.split('#')[0]}|${video.hlsAudio?.url || ''}|${quality}|${parts}|${overlap}`, {
      video, payload: { ...payload, hlsPartitions: temporalOptions(parts, overlap).parts, hlsOverlapSeconds: overlap }, quality, binary, dir: this.settings.downloadDir, proxy: this.settings.allProxy,
      browser: resolveCookiesArg(payload.ytCookiesFromBrowser || this.settings.ytCookiesFromBrowser) ?? ''
    })
    if (!accepted) return -1 // Existing task accepted; no new download was created.
    return 1
  }

  private async runManagedHls(item: HlsQueueItem<{ video: ResolvedVideo; payload: AddPayload; quality: string; dir: string; proxy: string; binary: string; browser: string }>): Promise<void> {
    const { video, payload, quality, dir, proxy, binary, browser } = item.input
    const base = safeFilename(payload.out || `${video.title}.${quality}`)
    await mkdir(dir, { recursive: true })
    const staging = await mkdtemp(join(dir, '.hls-stage-'))
    const destination = join(dir, `${base}-${randomUUID().slice(0, 12)}.mp4`)
    const referer = payload.referer || (isHlsUrl(video.pageUrl) ? '' : video.pageUrl)
    let fallback = ''
    let priorBytes = 0
    const separateTracks = Boolean(video.hlsAudio && quality !== 'audio')
    const download = async (stream: ResolvedStream, name: string, selected: string, offset: number, weight: number) => {
      if (item.progress) { item.progress.speed = 0; item.progress.eta = null }
      item.phase = '验证播放列表（Chrome）'
      // Each stream keeps its own captured context; no video/audio header union.
      const headers = [...(payload.headers || []), ...stream.headers]
      if (referer) headers.push(`Referer: ${referer}`)
      const result = await downloadHlsImpersonated(binary, { url: stream.url, dest: join(staging, name), headers,
        quality: selected, cookiesFromBrowser: browser, proxy,
        onProgress: progress => {
          item.percent = offset + (progress.percent ?? 0) * weight
          item.phase = progress.phase
          item.progress = { ...progress, fallback, downloadedBytes: priorBytes + progress.downloadedBytes,
            // A first-track estimate is not the total size of both tracks.
            totalBytes: separateTracks ? null : progress.totalBytes,
            totalBytesEstimate: separateTracks ? null : progress.totalBytesEstimate }
        }
      })
      priorBytes = item.progress?.downloadedBytes ?? priorBytes
      if (item.progress) { item.progress.speed = 0; item.progress.eta = null }
      return result
    }
    try {
      item.phase = '验证播放列表（Chrome）'
      if ((payload.hlsPartitions ?? 4) > 1) {
        if (separateTracks || quality === 'audio') fallback = '单路回退：独立音视频时间对齐未经保证'
        else if (proxy) fallback = '单路回退：代理模式暂不支持本地播放列表分区'
        else {
          const stream = video.hls!
          const headers = [...(payload.headers || []), ...stream.headers]
          if (referer) headers.push(`Referer: ${referer}`)
          const options = { url: stream.url, dest: join(staging, 'probe.mp4'), headers, quality, cookiesFromBrowser: browser, proxy,
            onProgress: (progress: import('../shared/types').HlsProgress) => { item.progress = progress; item.percent = progress.percent ?? 0; item.phase = progress.phase } }
          let parts: Awaited<ReturnType<typeof temporalPreflight>> | undefined
          try { parts = await temporalPreflight(binary, options, payload.hlsPartitions ?? 4, payload.hlsOverlapSeconds ?? 30) }
          catch (error) { fallback = `单路回退：${error instanceof Error ? error.message : '播放列表不支持'}` }
          if (parts && parts.length > 1) {
            const folder = destination.replace(/\.mp4$/, '.parts')
            await downloadTemporal(binary, options, parts, staging, folder)
            item.path = folder // Expose retained files even if merging fails.
            item.phase = '验证重叠并无损合并（保留全部分区）'
            if (item.progress) item.progress = { ...item.progress, percent: 99, speed: 0, phase: item.phase }
            await mergeTemporal(folder, destination)
            item.path = destination
            item.phase = `合并完成；分区保留于 ${folder}`
            if (item.progress) item.progress = { ...item.progress, totalBytes: null, percent: 100, speed: 0, phase: item.phase }
            this.rememberMerged(destination, video.pageUrl, 'hls')
            this.onEvent?.('aria.onYoutubeMerged', destination)
            return
          }
          if (parts) fallback = '单路回退：短视频无需时间分区'
        }
      }
      const output = join(staging, 'output.mp4')
      if (video.hlsAudio && quality !== 'audio') {
        const v = await download(video.hls!, 'video.mp4', quality, 0, 0.48)
        const a = await download(video.hlsAudio, 'audio.mp4', 'audio', 48, 0.48)
        item.phase = '合并音视频'
        await remuxLocalAv(v, a, output)
      } else {
        await download(quality === 'audio' && video.hlsAudio ? video.hlsAudio : video.hls!, 'output.mp4', quality, 0, 0.96)
      }
      item.phase = '发布文件'
      await publishHls(output, destination)
      item.path = destination
      if (item.progress) {
        const bytes = statSync(destination).size
        item.progress = { ...item.progress, downloadedBytes: bytes, totalBytes: bytes, totalBytesEstimate: null,
          speed: 0, eta: null, percent: 100 }
      }
      this.rememberMerged(destination, video.pageUrl, 'hls')
      this.onEvent?.('aria.onYoutubeMerged', destination)
    } finally {
      // Only our private staging directory is ever removed.
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async addYtStream(
    stream: ResolvedStream,
    pageUrl: string,
    filename: string,
    payload: AddPayload,
    extra: Record<string, string> = {}
  ): Promise<string> {
    if (!this.rpc) throw new Error('引擎未就绪')
    const options = {
      ...this.taskOptions(payload),
      out: filename,
      referer: pageUrl,
      header: stream.headers,
      split: '4',
      'max-connection-per-server': '4',
      'min-split-size': '8M',
      'enable-http-pipelining': 'false',
      'stream-piece-selector': 'inorder',
      'check-integrity': 'false',
      ...extra
    }
    const gid = await this.rpc.call<string>('aria2.addUri', [[stream.url], options])
    this.youtubeGids.add(gid)
    this.youtubePages.set(gid, pageUrl)
    void this.saveYoutubePages()
    return gid
  }

  private async loadSettings(): Promise<Settings> {
    const fallback = defaultSettings()
    try {
      const raw = JSON.parse(await readFile(this.settingsFile, 'utf8')) as Partial<Settings>
      return { ...fallback, ...raw, downloadDir: raw.downloadDir || fallback.downloadDir }
    } catch {
      return fallback
    }
  }
}

export function defaultSettings(): Settings {
  return {
    downloadDir: join(homedir(), 'Downloads', 'XDownlder'),
    aria2Path: '',
    maxConcurrent: 5,
    hlsPartitions: 4,
    hlsOverlapSeconds: 30,
    split: 16,
    maxConnectionPerServer: 16,
    minSplitSize: '1M',
    uriSelector: 'feedback',
    pieceSelector: 'default',
    maxSpeedKib: 0,
    maxUploadKib: 0,
    checkIntegrity: true,
    httpPipelining: true,
    optimizeConcurrent: true,
    seedRatio: 1,
    btMaxPeers: 55,
    allProxy: '',
    userAgent: 'XDownlder/1.0 aria2',
    theme: 'dark',
    ytDlpPath: '',
    youtubeQuality: 'best',
    ytCookiesFromBrowser: 'auto'
  }
}

type HistoryItem = {
  gid: string
  kind: TaskKind
  name: string
  dir: string
  path: string
  total: number
  pageUrl: string
  urls: string[]
  at: number
}

type MergeJob = {
  videoGid: string
  audioGid: string
  outputPath: string
  sourceDuration?: number
  videoDone: boolean
  audioDone: boolean
  merging: boolean
}

type HlsJob = {
  gids: string[]
  files: string[]
  chunks: HlsChunk[]
  outputPath: string
  pageUrl: string
  container: 'fmp4' | 'ts'
  assembling: boolean
}

function keepSessionEntry(block: string, downloadDir: string): boolean {
  const lines = block.split('\n')
  const uris: string[] = []
  const options: Record<string, string> = {}
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      const trimmed = line.trim()
      const eq = trimmed.indexOf('=')
      if (eq > 0) options[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    } else if (line.trim()) {
      uris.push(line.trim())
    }
  }
  const uri = uris[0] || ''
  if (/^magnet:/i.test(uri) || /\.torrent($|\?)/i.test(uri) || options.infoHash) return true
  const dir = options.dir || downloadDir
  const out = options.out || decodeURIComponent((uri.split('/').pop() || '').split('?')[0])
  const path = out ? join(dir, out) : ''
  if (path && existsSync(`${path}.aria2`)) return true
  if (path && existsSync(path)) return false
  if (path) {
    const merged = guessMergedOutput(path)
    if (merged) return false
  }
  if (/(?:googlevideo|twimg)\.com/i.test(uri) && path && /\.(video|audio)(\.\d+)?\.[^.]+$/.test(path)) {
    const stem = path.replace(/\.(video|audio)(\.\d+)?\.[^.]+$/, '')
    if (['.mp4', '.mkv', '.webm', '.m4a'].some((ext) => existsSync(`${stem}${ext}`))) return false
  }
  return true
}

function resolveBinary(custom: string): string | null {
  const list = [custom, process.env.ARIA2C_PATH, bundledTool('aria2'), ...CANDIDATES].filter(Boolean) as string[]
  for (const item of list) {
    if (item.includes('/') && existsSync(item)) return item
  }
  return null
}

function mapTask(raw: RawStatus, lanes: ConnectionLane[]): Task {
  const files = (raw.files ?? []).map(mapFile)
  const urls = unique(files.flatMap((file) => file.uris.map((item) => item.uri)))
  return {
    gid: raw.gid ?? '',
    status: raw.status ?? 'waiting',
    kind: detectKind(raw, urls),
    name: taskName(raw, files),
    dir: raw.dir ?? '',
    path: files.find((file) => file.selected)?.path || files[0]?.path || '',
    total: num(raw.totalLength),
    completed: num(raw.completedLength),
    uploadLength: num(raw.uploadLength),
    speed: num(raw.downloadSpeed),
    uploadSpeed: num(raw.uploadSpeed),
    connections: Math.max(num(raw.connections), lanes.length),
    pieceLength: num(raw.pieceLength),
    numPieces: num(raw.numPieces),
    bitfield: raw.bitfield ?? '',
    infoHash: raw.infoHash ?? '',
    numSeeders: num(raw.numSeeders),
    seeder: raw.seeder === 'true',
    verifiedLength: num(raw.verifiedLength),
    verifyPending: raw.verifyIntegrityPending === 'true',
    error: raw.errorMessage ?? '',
    urls,
    files,
    lanes,
    pageUrl: ''
  }
}

function mapFile(file: RawFile): TaskFile {
  return {
    index: num(file.index) || 1,
    path: file.path ?? '',
    length: num(file.length),
    completed: num(file.completedLength),
    selected: file.selected !== 'false',
    uris: (file.uris ?? []).map((item) => ({ uri: item.uri ?? '', status: item.status ?? '' }))
  }
}

function mapLane(server: { uri?: string; currentUri?: string; downloadSpeed?: string }): ConnectionLane {
  return {
    uri: server.uri ?? '',
    currentUri: server.currentUri ?? server.uri ?? '',
    downloadSpeed: num(server.downloadSpeed)
  }
}

function flattenServers(servers: RawServers | undefined): ConnectionLane[] {
  return (servers ?? []).flatMap((item) => (item.servers ?? []).map(mapLane))
}

function detectKind(raw: RawStatus, urls: string[]): TaskKind {
  if (raw.infoHash || raw.bittorrent) return urls.some((url) => url.startsWith('magnet:')) ? 'magnet' : 'bt'
  if (raw.followedBy?.length) return 'metalink'
  if (urls.some((url) => classifyUrl(url) === 'youtube' || /googlevideo\.com/i.test(url))) return 'youtube'
  if (urls.some((url) => classifyUrl(url) === 'x' || /twimg\.com/i.test(url))) return 'x'
  if (urls.some((url) => classifyUrl(url) === 'hls' || /\.m3u8/i.test(url))) return 'hls'
  if (urls.some((url) => classifyUrl(url) === 'ftp')) return 'ftp'
  return 'http'
}

function streamKey(...urls: (string | undefined)[]): string {
  const stable = urls
    .filter(Boolean)
    .map((value) => {
      try {
        const url = new URL(value as string)
        return `${url.host}${url.pathname}`
      } catch {
        return value as string
      }
    })
    .join('|')
  return createHash('sha1').update(stable).digest('hex').slice(0, 10)
}

function mediaTaskKind(pageUrl: string, urls: string[] = []): TaskKind {
  if (isXUrl(pageUrl) || urls.some((url) => classifyUrl(url) === 'x' || /twimg\.com/i.test(url))) return 'x'
  if (isHlsUrl(pageUrl) || urls.some((url) => classifyUrl(url) === 'hls' || /\.m3u8/i.test(url))) return 'hls'
  return 'youtube'
}

function taskName(raw: RawStatus, files: TaskFile[]): string {
  if (raw.bittorrent?.info?.name) return raw.bittorrent.info.name
  const path = files.find((file) => file.selected)?.path || files[0]?.path || ''
  if (path) return path.split('/').pop() || path
  const uri = files[0]?.uris[0]?.uri ?? ''
  if (!uri) return raw.gid ?? '未命名'
  try {
    const name = decodeURIComponent(new URL(uri).pathname.split('/').pop() || '')
    return name || uri
  } catch {
    return uri
  }
}

function emptySnapshot(settings: Settings, error: string, version: string, features: string[]): Snapshot {
  return {
    ready: false,
    error,
    version,
    features,
    downloadSpeed: 0,
    uploadSpeed: 0,
    numActive: 0,
    numWaiting: 0,
    numStopped: 0,
    tasks: [],
    settings,
    browsers: [],
    cookieBrowser: '',
    cookieLabel: ''
  }
}

function collapseUris(uris: { uri: string; status: string }[]): { uri: string; status: string }[] {
  const map = new Map<string, Map<string, number>>()
  for (const item of uris) {
    if (!item.uri) continue
    const bucket = map.get(item.uri) ?? new Map<string, number>()
    const status = item.status || 'used'
    bucket.set(status, (bucket.get(status) ?? 0) + 1)
    map.set(item.uri, bucket)
  }
  return [...map.entries()].map(([uri, counts]) => {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
    const parts = [...counts.entries()].map(([status, n]) => (n > 1 ? `${status} ×${n}` : status))
    return { uri, status: total > 1 ? `${parts.join(' · ')} · 同一地址` : parts.join(' · ') }
  })
}

function finalizeDetail(detail: TaskDetail): TaskDetail {
  const page = detail.task.pageUrl
  let uris = collapseUris(detail.uris)
  if (page && !uris.some((item) => item.uri === page)) {
    uris = [{ uri: page, status: '页面' }, ...uris]
  }
  return { ...detail, uris }
}

function combineDetails(parts: TaskDetail[]): TaskDetail {
  if (parts.length === 1) return finalizeDetail(parts[0])
  const main = [...parts].sort((a, b) => b.task.total - a.task.total)[0]
  const pageUrl = parts.find((item) => item.task.pageUrl)?.task.pageUrl || ''
  return finalizeDetail({
    task: {
      ...main.task,
      gid: parts.map((item) => item.task.gid).join(','),
      name: main.task.name.replace(/\.(video|audio)(\.\d+)?(?=\.[^.]+$)/, ''),
      pageUrl,
      connections: parts.reduce((sum, item) => sum + item.task.connections, 0),
      completed: parts.reduce((sum, item) => sum + item.task.completed, 0),
      total: parts.reduce((sum, item) => sum + item.task.total, 0),
      speed: parts.reduce((sum, item) => sum + item.task.speed, 0),
      lanes: parts.flatMap((item) => item.task.lanes)
    },
    files: parts.flatMap((item, index) =>
      item.files.map((file, fileIndex) => ({ ...file, index: index * 100 + (file.index || fileIndex + 1) }))
    ),
    uris: parts.flatMap((item) => item.uris),
    servers: parts.flatMap((item) => item.servers),
    peers: parts.flatMap((item) => item.peers),
    options: main.options
  })
}

function num(value: string | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function kibLimit(value: number): string {
  return value > 0 ? `${value}K` : '0'
}

function absPath(dir: string, file: string): string {
  if (!file) return ''
  return isAbsolute(file) ? file : join(dir, file)
}

function guessMergedOutput(file: string): string {
  if (!file) return ''
  const stem = file.replace(/\.(video|audio)(\.\d+)?\.[^.]+$/, '')
  if (stem === file) return ''
  for (const ext of ['.mp4', '.mkv', '.webm', '.m4a']) {
    const candidate = `${stem}${ext}`
    if (existsSync(candidate)) return candidate
  }
  return ''
}
