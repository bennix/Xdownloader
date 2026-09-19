import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { AddPayload, ConnectionLane, Settings, Snapshot, Task, TaskDetail, TaskFile, TaskKind, YtQuality } from '../shared/types'
import { classifyUrl, isDownloadUrl, isYouTubeUrl, normalizeDownloadUrl, unique, youtubeVideoId } from '../shared/urls'
import { bundledTool, resourceBinDir } from './binaries'
import { AriaRpc, unwrapMulticall } from './rpc'
import { listBrowserOptions, resolveCookiesArg } from './browsers'
import {
  findUnmergedPairs,
  findYtDlp,
  mergeMedia,
  probeYouTube,
  resolveYouTube,
  safeFilename,
  type ResolvedStream,
  type ResolvedVideo
} from './youtube'

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
  private child: ChildProcessWithoutNullStreams | null = null
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
  private cachedTasks: Task[] = []
  private history: HistoryItem[] = []
  private readonly mergeFailAt = new Map<string, number>()

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
    await this.recoverHistoryFromDisk()
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
    this.child.on('exit', (code) => {
      this.ready = false
      if (!this.error) this.error = code ? `aria2c 已退出 (${code})` : 'aria2c 已退出'
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
    } catch (error) {
      const tail = logs.join('').replace(/\s+/g, ' ').trim().slice(-240)
      this.error = `${error instanceof Error ? error.message : String(error)}${tail ? ` · ${tail}` : ''}`
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

  async snapshot(): Promise<Snapshot> {
    if (!this.rpc || !this.ready) {
      const archived = this.history.map((item) => this.historyToTask(item))
      this.cachedTasks = archived
      return {
        ...emptySnapshot(this.settings, this.error, this.version, this.features),
        tasks: archived,
        numStopped: archived.length,
        ...this.cookieState()
      }
    }

    const [activeWrap, waitingWrap, stoppedWrap, statWrap] = await this.rpc.multicall([
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
      if (this.youtubeGids.has(task.gid)) task.kind = 'youtube'
      task.pageUrl = this.youtubePages.get(task.gid) || ''
      return task
    })
    for (const task of tasks) {
      if (task.status === 'complete') this.rememberTask(task)
    }
    const extras = this.history
      .filter((item) => !tasks.some((task) => task.gid === item.gid || (item.path && task.path === item.path)))
      .map((item) => this.historyToTask(item))
    const all = [...tasks, ...extras]
    this.cachedTasks = all
    void this.sweepMerges(tasks)

    return {
      ready: true,
      error: '',
      version: this.version,
      features: this.features,
      downloadSpeed: num(stat.downloadSpeed),
      uploadSpeed: num(stat.uploadSpeed),
      numActive: num(stat.numActive),
      numWaiting: num(stat.numWaiting),
      numStopped: Math.max(num(stat.numStopped), extras.length),
      tasks: all,
      settings: this.settings,
      ...this.cookieState()
    }
  }

  async probeYouTube(url: string, cookiesFromBrowser?: string) {
    const binary = findYtDlp(this.settings.ytDlpPath)
    if (!binary) throw new Error('未找到 yt-dlp。请先执行 brew install yt-dlp')
    return probeYouTube(
      url,
      binary,
      resolveCookiesArg(cookiesFromBrowser || this.settings.ytCookiesFromBrowser) ?? ''
    )
  }

  async addDownloads(payload: AddPayload): Promise<{ ok: boolean; added: number; error?: string }> {
    if (!this.rpc) return { ok: false, added: 0, error: '引擎未就绪' }
    const uris = unique(payload.uris.map((item) => normalizeDownloadUrl(item.trim())).filter(isDownloadUrl))
    if (!uris.length) return { ok: false, added: 0, error: '没有可用的下载链接' }

    const youtube = uris.filter(isYouTubeUrl)
    const rest = uris.filter((uri) => !isYouTubeUrl(uri))
    let added = 0
    try {
      if (youtube.length) {
        const yt = await this.addYouTube(youtube, payload)
        if (!yt.ok && !rest.length) return yt
        added += yt.added
        if (!yt.ok) this.error = yt.error ?? this.error
      }
      if (!rest.length) return { ok: added > 0, added, error: added ? undefined : '没有可用的下载链接' }

      const options = this.taskOptions(payload)
      if (payload.multiSource) {
        const magnets = rest.filter((uri) => classifyUrl(uri) === 'magnet')
        const others = rest.filter((uri) => classifyUrl(uri) !== 'magnet')
        if (others.length) {
          await this.rpc.call('aria2.addUri', [others, options])
          added += 1
        }
        for (const magnet of magnets) {
          await this.rpc.call('aria2.addUri', [[magnet], options])
          added += 1
        }
        return { ok: true, added }
      }
      for (const uri of rest) {
        await this.rpc.call('aria2.addUri', [[uri], options])
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
      await this.rpc.call('aria2.addTorrent', [base64, webSeeds, { dir: this.settings.downloadDir }])
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async addMetalink(base64: string): Promise<{ ok: boolean; added: number; error?: string }> {
    if (!this.rpc) return { ok: false, added: 0, error: '引擎未就绪' }
    try {
      const gids = await this.rpc.call<string[]>('aria2.addMetalink', [base64, { dir: this.settings.downloadDir }])
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
    if (!this.rpc) return
    const files = deleteFiles ? await this.filePathsOf(gid) : []
    const job = this.mergeJobs.find((item) => item.videoGid === gid || item.audioGid === gid)
    if (deleteFiles && job) files.push(job.outputPath)
    try {
      await this.rpc.call('aria2.remove', [gid])
    } catch {
      await this.rpc.call('aria2.forceRemove', [gid]).catch(() => undefined)
    }
    await this.rpc.call('aria2.removeDownloadResult', [gid]).catch(() => undefined)
    this.youtubeGids.delete(gid)
    this.youtubePages.delete(gid)
    this.forgetHistory(gid, files)
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
    const page = this.youtubePages.get(gid)
    if (page) return [page]
    if (!this.rpc) return []
    const files = await this.rpc.call<RawFile[]>('aria2.getFiles', [gid])
    return unique(files.flatMap((file) => (file.uris ?? []).map((item) => item.uri ?? '')).filter(Boolean))
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
      await mergeMedia(video.path, audio.path, job.outputPath)
      const pageUrl = this.youtubePages.get(job.videoGid) || this.youtubePages.get(job.audioGid) || ''
      await this.remove(job.videoGid, false).catch(() => undefined)
      await this.remove(job.audioGid, false).catch(() => undefined)
      this.rememberMerged(job.outputPath, pageUrl, 'youtube')
      const index = this.mergeJobs.indexOf(job)
      if (index >= 0) this.mergeJobs.splice(index, 1)
      await this.saveMergeJobs()
      this.mergeFailAt.delete(job.outputPath)
      this.onEvent?.('aria.onYoutubeMerged', job.outputPath)
    } catch (error) {
      job.merging = false
      const message = error instanceof Error ? error.message : String(error)
      this.error = message
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
      await unlink(abs).catch(() => undefined)
    }
  }

  async detail(gid: string): Promise<TaskDetail | null> {
    const ids = String(gid ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    for (const id of ids) {
      const one = await this.detailOne(id).catch(() => null)
      if (one) return one
    }
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
    if (this.youtubeGids.has(task.gid)) task.kind = 'youtube'
    task.pageUrl = this.youtubePages.get(task.gid) || ''
    return {
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
    }
  }

  private detailFromCache(ids: string[]): TaskDetail | null {
    const task = this.cachedTasks.find((item) => ids.includes(item.gid))
    if (!task) return null
    return {
      task,
      files: task.files,
      uris: unique([...task.urls, ...task.files.flatMap((file) => file.uris.map((item) => item.uri))]).map((uri) => ({
        uri,
        status: 'used'
      })),
      servers: [],
      peers: [],
      options: {}
    }
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
      `--force-save=true`,
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
    if (existsSync(this.sessionFile)) args.push(`--input-file=${this.sessionFile}`)
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

  private async loadHistory(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.historyFile, 'utf8')) as HistoryItem[]
      this.history = Array.isArray(raw) ? raw.filter((item) => item?.gid && item.path) : []
    } catch {
      this.history = []
    }
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
    const total = statSync(outputPath).size
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
        const vExt = video.path.split('.').pop() || 'mp4'
        const aExt = audio.path.split('.').pop() || 'm4a'
        const ext = vExt === 'mp4' && /m4a|mp4|aac/.test(aExt) ? 'mp4' : 'mkv'
        this.mergeJobs.push({
          videoGid: video.gid,
          audioGid: audio.gid,
          outputPath: join(video.dir || this.settings.downloadDir, `${base}.${ext}`),
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
          await mergeMedia(pair.videoPath, pair.audioPath, pair.outputPath)
          this.mergeFailAt.delete(pair.outputPath)
          this.rememberMerged(pair.outputPath, '', 'youtube')
          this.onEvent?.('aria.onYoutubeMerged', pair.outputPath)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.error = message
          this.emitMergeError(pair.outputPath, message)
        }
      }
    } finally {
      this.sweepBusy = false
    }
  }

  private canRetryMerge(key: string): boolean {
    const at = this.mergeFailAt.get(key) ?? 0
    return Date.now() - at > 20_000
  }

  private emitMergeError(key: string, message: string): void {
    const first = !this.mergeFailAt.has(key)
    this.mergeFailAt.set(key, Date.now())
    if (first) this.onEvent?.('aria.onYoutubeMergeError', key, message)
  }

  private hasYoutubePage(url: string): boolean {
    const id = youtubeVideoId(url)
    return [...this.youtubePages.values()].some((item) => (id ? youtubeVideoId(item) === id : item === url))
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
  ): Promise<{ ok: boolean; added: number; error?: string }> {
    const binary = findYtDlp(this.settings.ytDlpPath)
    if (!binary) return { ok: false, added: 0, error: '未找到 yt-dlp。请先执行 brew install yt-dlp' }
    const quality = payload.youtubeQuality || this.settings.youtubeQuality
    let added = 0
    let lastError = ''
    for (const url of unique(urls)) {
      if (this.addingPages.has(url) || this.hasYoutubePage(url)) {
        lastError = lastError || '该视频已在任务里'
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
          added += await this.enqueueYouTube(video, payload, quality)
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      } finally {
        this.addingPages.delete(url)
      }
    }
    if (!added) return { ok: false, added: 0, error: lastError || '没有解析到可下载的 YouTube 视频' }
    return { ok: true, added, error: lastError || undefined }
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
      const ext = video.video.ext === 'mp4' && /m4a|mp4/.test(video.audio.ext) ? 'mp4' : 'mkv'
      this.mergeJobs.push({
        videoGid,
        audioGid,
        outputPath: join(this.settings.downloadDir, `${base}.${ext}`),
        videoDone: false,
        audioDone: false,
        merging: false
      })
      await this.saveMergeJobs()
      return 2
    }
    if (video.audio) {
      await this.addYtStream(video.audio, video.pageUrl, `${base}.${video.audio.ext}`, payload)
      return 1
    }
    return 0
  }

  private async addYtStream(stream: ResolvedStream, pageUrl: string, filename: string, payload: AddPayload): Promise<string> {
    if (!this.rpc) throw new Error('引擎未就绪')
    const options = {
      ...this.taskOptions(payload),
      out: filename,
      referer: pageUrl,
      header: stream.headers
    }
    const gid = await this.rpc.call<string>('aria2.addUri', [[stream.url], options])
    this.youtubeGids.add(gid)
    this.youtubePages.set(gid, pageUrl)
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
  videoDone: boolean
  audioDone: boolean
  merging: boolean
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
  if (urls.some((url) => classifyUrl(url) === 'ftp')) return 'ftp'
  return 'http'
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
