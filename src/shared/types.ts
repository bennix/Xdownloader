export type UriSelector = 'inorder' | 'feedback' | 'adaptive'
export type PieceSelector = 'default' | 'inorder' | 'random' | 'geom'
export type TaskKind = 'http' | 'ftp' | 'bt' | 'magnet' | 'metalink' | 'youtube' | 'x' | 'hls'
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

export type BrowserSessionImport = {
  browser: string
  label: string
  userAgent: string
  urls: string[]
  cookies: number
  clearance: number
  error?: string
}

export type SniffHit = {
  url: string
  kind: 'hls' | 'youtube' | 'x' | 'http'
  mime: string
  source: 'network' | 'page'
  pageUrl?: string
  headers?: string[]
  selected?: boolean
}

export type Settings = {
  downloadDir: string
  aria2Path: string
  maxConcurrent: number
  hlsPartitions: number
  hlsOverlapSeconds: number
  split: number
  maxConnectionPerServer: number
  minSplitSize: string
  uriSelector: UriSelector
  pieceSelector: PieceSelector
  maxSpeedKib: number
  maxUploadKib: number
  checkIntegrity: boolean
  httpPipelining: boolean
  optimizeConcurrent: boolean
  seedRatio: number
  btMaxPeers: number
  allProxy: string
  userAgent: string
  ytDlpPath: string
  youtubeQuality: YtQuality
  ytCookiesFromBrowser: string
  theme: 'dark' | 'light'
}

export type BrowserOption = {
  id: string
  label: string
  installed: boolean
  lastUsed: number
  version: string
  userAgent: string
  family: string
  appPath: string
}

export type TaskUri = {
  uri: string
  status: string
}

export type TaskFile = {
  index: number
  path: string
  length: number
  completed: number
  selected: boolean
  uris: TaskUri[]
}

export type ConnectionLane = {
  uri: string
  currentUri: string
  downloadSpeed: number
}

export type FileServers = {
  index: number
  servers: ConnectionLane[]
}

export type Peer = {
  ip: string
  port: string
  bitfield: string
  amChoking: boolean
  peerChoking: boolean
  downloadSpeed: number
  uploadSpeed: number
  seeder: boolean
}

export type HlsProgress = {
  parts?: { index: number; percent: number; bytes: number; speed: number; phase: string }[]
  overlapSeconds?: number
  fallback?: string
  mergedPath?: string
  partsDir?: string
  downloadedBytes: number
  totalBytes: number | null
  totalBytesEstimate: number | null
  speed: number
  eta: number | null
  fragmentIndex: number | null
  fragmentCount: number | null
  percent: number | null
  phase: string
}

export type Task = {
  hls?: HlsProgress
  resolving?: boolean
  gid: string
  status: string
  kind: TaskKind
  name: string
  dir: string
  path: string
  total: number
  completed: number
  uploadLength: number
  speed: number
  uploadSpeed: number
  connections: number
  pieceLength: number
  numPieces: number
  bitfield: string
  infoHash: string
  numSeeders: number
  seeder: boolean
  verifiedLength: number
  verifyPending: boolean
  error: string
  urls: string[]
  files: TaskFile[]
  lanes: ConnectionLane[]
  pageUrl: string
}

export type TaskDetail = {
  task: Task
  files: TaskFile[]
  uris: TaskUri[]
  servers: FileServers[]
  peers: Peer[]
  options: Record<string, string>
}

export type AddPayload = {
  uris: string[]
  multiSource: boolean
  out?: string
  referer?: string
  userAgent?: string
  checksum?: string
  headers?: string[]
  hlsMode?: 'settings' | 'single' | 'temporal'
  hlsPartitions?: number
  hlsOverlapSeconds?: number
  split?: number
  pieceSelector?: PieceSelector
  pause?: boolean
  youtubeQuality?: YtQuality
  ytCookiesFromBrowser?: string
}

export type Snapshot = {
  ready: boolean
  error: string
  version: string
  features: string[]
  downloadSpeed: number
  uploadSpeed: number
  numActive: number
  numWaiting: number
  numStopped: number
  tasks: Task[]
  settings: Settings
  browsers: BrowserOption[]
  cookieBrowser: string
  cookieLabel: string
}

export type EngineEvent = {
  method: string
  gid: string
  message?: string
}

export type ToolStatus = {
  id: 'brew' | 'aria2' | 'yt-dlp' | 'ffmpeg'
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

export type AriaApi = {
  snapshot: () => Promise<Snapshot>
  addDownloads: (payload: AddPayload) => Promise<{ ok: boolean; added: number; existing?: number; error?: string }>
  addTorrent: (base64: string, webSeeds?: string[]) => Promise<{ ok: boolean; error?: string }>
  addMetalink: (base64: string) => Promise<{ ok: boolean; added: number; error?: string }>
  pause: (gid: string) => Promise<void>
  resume: (gid: string) => Promise<void>
  remove: (gid: string, deleteFiles?: boolean) => Promise<void>
  pauseAll: () => Promise<void>
  resumeAll: () => Promise<void>
  move: (gid: string, how: 'POS_SET' | 'POS_CUR' | 'POS_END', pos: number) => Promise<void>
  copyUrls: (gid: string) => Promise<string[]>
  openFolder: (gid: string) => Promise<void>
  detail: (gid: string) => Promise<TaskDetail | null>
  changeUris: (gid: string, add: string[], del?: string[]) => Promise<void>
  selectFiles: (gid: string, indexes: number[]) => Promise<void>
  changeTaskOption: (gid: string, options: Record<string, string>) => Promise<void>
  readClipboardUrls: () => Promise<string[]>
  writeClipboard: (text: string) => Promise<void>
  pickDownloadDir: () => Promise<string | null>
  pickTorrent: () => Promise<string | null>
  pickMetalink: () => Promise<string | null>
  probeYouTube: (url: string, cookiesFromBrowser?: string) => Promise<YtProbe>
  sniffOpen: (url: string) => Promise<void>
  sniffClose: () => Promise<void>
  sniffList: () => Promise<SniffHit[]>
  sniffRemove: (urls: string[]) => Promise<number>
  sniffClear: () => Promise<number>
  sniffResume: () => Promise<void>
  importBrowserSession: (browserId: string, urls?: string[]) => Promise<BrowserSessionImport>
  onSniffHits: (cb: (hits: SniffHit[], pageUrl: string) => void) => () => void
  onSniffOpen: (cb: () => void) => () => void
  saveSettings: (patch: Partial<Settings>) => Promise<Settings>
  listBrowsers: () => Promise<BrowserOption[]>
  brewStatus: () => Promise<BrewProgress>
  brewInstall: (auto?: boolean) => Promise<BrewProgress>
  onBrewProgress: (cb: (progress: BrewProgress) => void) => () => void
  onOpenSettings: (cb: () => void) => () => void
  onSnapshot: (cb: (snap: Snapshot) => void) => () => void
  onClipboardUrls: (cb: (urls: string[]) => void) => () => void
  onPasteUrls: (cb: () => void) => () => void
  onAddClipboard: (cb: () => void) => () => void
  onCopyInputUrls: (cb: () => void) => () => void
  onEvent: (cb: (event: EngineEvent) => void) => () => void
}
