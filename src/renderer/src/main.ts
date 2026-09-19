import type { AddPayload, BrewProgress, BrowserOption, PieceSelector, Settings, Snapshot, Task, TaskDetail } from '../../shared/types'
import { extractUrls, extractUrlsFromHtml, isYouTubeUrl, unique } from '../../shared/urls'
import { formatBytes, formatEta, formatSpeed, kindLabel, percent, statusLabel } from '../../shared/format'
import './styles.css'

type Filter = 'all' | 'active' | 'waiting' | 'done'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const input = $<HTMLTextAreaElement>('url-input')
const list = $<HTMLElement>('list')
const speeds = $<HTMLElement>('speeds')
const engineTag = $<HTMLElement>('engine-tag')
const banner = $<HTMLElement>('clip-banner')
const toast = $<HTMLElement>('toast')
const inspector = $<HTMLElement>('inspector')
const settingsEl = $<HTMLElement>('settings')
const dropzone = $<HTMLElement>('dropzone')

let snap: Snapshot | null = null
let browserList: BrowserOption[] = []
let filter: Filter = 'all'
let selected: string | null = null
let detail: TaskDetail | null = null
let pendingClipboard: string[] = []
let brew: BrewProgress | null = null
let localTheme: 'dark' | 'light' = (localStorage.getItem('xdownlder-theme') as 'dark' | 'light') || 'dark'

function closePickers(except?: HTMLElement): void {
  document.querySelectorAll('.picker.open').forEach((node) => {
    if (except && node === except) return
    node.classList.remove('open')
    const menu = node.querySelector('.picker-menu') as HTMLElement | null
    if (menu) menu.hidden = true
  })
}

function syncPicker(select: HTMLSelectElement): void {
  const wrap = select.closest('.picker')
  const btn = wrap?.querySelector('.picker-btn') as HTMLButtonElement | null
  const menu = wrap?.querySelector('.picker-menu') as HTMLElement | null
  if (!btn || !menu) return
  const sig = [...select.options].map((item) => `${item.value}\0${item.text}`).join('\n')
  if (menu.dataset.sig !== sig) {
    menu.dataset.sig = sig
    menu.innerHTML = [...select.options]
      .map(
        (item) =>
          `<button type="button" class="picker-item${item.value === select.value ? ' on' : ''}" data-value="${escapeHtml(item.value)}">${escapeHtml(item.text)}</button>`
      )
      .join('')
  } else {
    menu.querySelectorAll<HTMLElement>('.picker-item').forEach((item) => {
      item.classList.toggle('on', item.dataset.value === select.value)
    })
  }
  btn.textContent = select.selectedOptions[0]?.text || '请选择'
}

function enhanceSelect(select: HTMLSelectElement): void {
  if (select.dataset.picker === '1') {
    syncPicker(select)
    return
  }
  select.dataset.picker = '1'
  select.classList.add('picker-native')
  select.tabIndex = -1
  const wrap = document.createElement('div')
  wrap.className = select.classList.contains('mini') ? 'picker mini' : 'picker'
  select.after(wrap)
  wrap.append(select)
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'picker-btn'
  const menu = document.createElement('div')
  menu.className = 'picker-menu'
  menu.hidden = true
  wrap.append(btn, menu)
  btn.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const willOpen = menu.hidden
    closePickers(wrap)
    if (!willOpen) return
    syncPicker(select)
    menu.hidden = false
    wrap.classList.add('open')
    const rect = btn.getBoundingClientRect()
    menu.style.position = 'fixed'
    menu.style.left = `${rect.left}px`
    menu.style.width = `${Math.max(rect.width, 260)}px`
    menu.style.right = 'auto'
    menu.style.top = `${rect.bottom + 4}px`
    const box = menu.getBoundingClientRect()
    if (box.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, rect.top - box.height - 4)}px`
    }
  })
  menu.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest('.picker-item') as HTMLElement | null
    if (!item) return
    select.value = item.dataset.value || ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
    syncPicker(select)
    closePickers()
  })
  syncPicker(select)
}

function enhanceSelects(root: ParentNode = document): void {
  root.querySelectorAll('select').forEach((node) => enhanceSelect(node as HTMLSelectElement))
}

function fillBrowserFields(browserId?: string): void {
  const select = document.getElementById('opt-browser') as HTMLSelectElement | null
  const ua = document.getElementById('opt-ua') as HTMLInputElement | null
  const referer = document.getElementById('opt-referer') as HTMLInputElement | null
  const header = document.getElementById('opt-header') as HTMLInputElement | null
  if (!select) return
  const browsers = (browserList.length ? browserList : snap?.browsers ?? []).filter((item) => item.installed)
  const current = select.value
  const html = browsers.length
    ? browsers.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('')
    : '<option value="">未检测到已安装浏览器</option>'
  if (select.dataset.options !== html) {
    select.dataset.options = html
    select.innerHTML = html
  }
  const saved = localStorage.getItem('xdownlder-browser') || ''
  const chosen =
    browsers.find((item) => item.id === (browserId || current || saved || snap?.cookieBrowser)) || browsers[0]
  if (chosen && select.value !== chosen.id) select.value = chosen.id
  enhanceSelect(select)
  syncPicker(select)
  if (chosen && ua && ua.dataset.auto !== '0' && ua.value !== chosen.userAgent) {
    ua.value = chosen.userAgent
    ua.dataset.auto = '1'
  }
  const firstUrl = extractUrls(input.value)[0]
  const nextReferer = firstUrl && isYouTubeUrl(firstUrl) ? 'https://www.youtube.com/' : firstUrl ? new URL(firstUrl).origin + '/' : ''
  if (referer && referer.dataset.auto !== '0' && referer.value !== nextReferer) {
    referer.value = nextReferer
    referer.dataset.auto = '1'
  }
  if (header && !header.value) {
    header.value = `Accept-Language: ${navigator.language || 'zh-CN'},zh;q=0.9,en;q=0.8`
    header.dataset.auto = '1'
  }
}

function applyTheme(theme: 'dark' | 'light'): void {
  localTheme = theme
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.body.style.colorScheme = theme
  localStorage.setItem('xdownlder-theme', theme)
  const button = document.getElementById('btn-theme')
  if (button) button.textContent = theme === 'dark' ? '亮色' : '暗色'
}

applyTheme(localTheme)
enhanceSelects()
document.addEventListener('click', () => closePickers())
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePickers()
})
window.addEventListener(
  'scroll',
  (event) => {
    if (event.target instanceof Element && event.target.closest('.picker-menu')) return
    closePickers()
  },
  true
)

function api() {
  return window.aria
}

function showToast(text: string): void {
  toast.hidden = false
  toast.textContent = text
  window.setTimeout(() => {
    toast.hidden = true
  }, 2400)
}

function currentPayload(): AddPayload {
  const splitRaw = $<HTMLInputElement>('opt-split').value
  const piece = $<HTMLSelectElement>('opt-piece').value as PieceSelector | ''
  const header = $<HTMLInputElement>('opt-header').value.trim()
  return {
    uris: extractUrls(input.value),
    multiSource: $<HTMLInputElement>('multi-source').checked,
    out: $<HTMLInputElement>('out-name').value.trim() || undefined,
    referer: $<HTMLInputElement>('opt-referer').value.trim() || undefined,
    userAgent: $<HTMLInputElement>('opt-ua').value.trim() || undefined,
    checksum: $<HTMLInputElement>('opt-checksum').value.trim() || undefined,
    headers: header ? [header] : undefined,
    split: splitRaw ? Number(splitRaw) : undefined,
    pieceSelector: piece || undefined,
    pause: $<HTMLInputElement>('add-paused').checked,
    youtubeQuality: $<HTMLSelectElement>('yt-quality').value || 'best',
    ytCookiesFromBrowser: $<HTMLSelectElement>('opt-browser').value || undefined
  }
}

let adding = false

async function addFromText(text: string): Promise<void> {
  if (adding) return
  input.value = text
  const payload = currentPayload()
  payload.uris = extractUrls(text)
  if (!payload.uris.length) {
    showToast('没有识别到链接')
    return
  }
  adding = true
  try {
    const result = await window.aria.addDownloads(payload)
    if (!result.ok) showToast(result.error || '添加失败')
    else {
      const yt = payload.uris.some(isYouTubeUrl)
      const quality = $<HTMLSelectElement>('yt-quality').selectedOptions[0]?.text || payload.youtubeQuality
      showToast(yt ? `已按 ${quality} 添加 YouTube 任务` : payload.multiSource ? `已按 ${payload.uris.length} 源并行添加` : `已添加 ${result.added} 个任务`)
      input.value = ''
    }
  } finally {
    adding = false
  }
}

async function addClipboard(): Promise<void> {
  const urls = pendingClipboard.length ? pendingClipboard : await window.aria.readClipboardUrls()
  pendingClipboard = []
  banner.hidden = true
  if (!urls.length) {
    showToast('剪贴板里没有链接')
    return
  }
  await addFromText(urls.join('\n'))
}

function applyUrlsToInput(urls: string[], replace = false): void {
  const merged = replace || !input.value.trim() ? urls : [...extractUrls(input.value), ...urls]
  input.value = unique(merged).join('\n')
  input.focus()
  fillBrowserFields()
  void probeQuality()
}

async function pasteRecognizedUrls(): Promise<void> {
  const urls = await window.aria.readClipboardUrls()
  if (!urls.length) {
    showToast('剪贴板里没有可识别的链接')
    return
  }
  applyUrlsToInput(urls)
  showToast(`已粘贴 ${urls.length} 条链接`)
}

async function copyInputUrls(): Promise<void> {
  const urls = extractUrls(input.value)
  if (!urls.length) {
    showToast('输入框里没有可复制的链接')
    return
  }
  await window.aria.writeClipboard(urls.join('\n'))
  showToast(`已复制 ${urls.length} 条链接`)
}

function bitPieces(bitfield: string, numPieces: number): boolean[] {
  const bits: boolean[] = []
  const hex = bitfield.replace(/[^0-9a-f]/gi, '')
  for (const ch of hex) {
    const n = Number.parseInt(ch, 16)
    for (let i = 3; i >= 0; i -= 1) bits.push(((n >> i) & 1) === 1)
  }
  return bits.slice(0, numPieces || bits.length)
}

function chunkCells(task: Task): string {
  const raw = bitPieces(task.bitfield, task.numPieces)
  const max = 64
  if (!raw.length) {
    const ratio = percent(task.completed, task.total) / 100
    return Array.from({ length: max }, (_, i) => `<i class="piece ${i / max < ratio ? 'on' : ''}"></i>`).join('')
  }
  if (raw.length <= max) return raw.map((on) => `<i class="piece ${on ? 'on' : ''}"></i>`).join('')
  const bucket = Math.ceil(raw.length / max)
  const cells = []
  for (let i = 0; i < raw.length; i += bucket) {
    const slice = raw.slice(i, i + bucket)
    const ratio = slice.filter(Boolean).length / slice.length
    cells.push(`<i class="piece ${ratio === 1 ? 'on' : ratio > 0 ? 'mid' : ''}"></i>`)
  }
  return cells.join('')
}

function renderPieces(task: Task): string {
  return `<div class="chunkbar" title="${task.numPieces ? `${task.numPieces} 个分片` : '下载进度'}">${chunkCells(task)}</div>`
}

type TaskGroup = {
  id: string
  tasks: Task[]
  name: string
  kind: Task['kind']
  pageUrl: string
}

function groupKey(task: Task): string {
  if (task.pageUrl) return task.pageUrl
  return task.name.replace(/\.(video|audio)(?=(\.\d+)?\.[^.]+$)/, '').replace(/\.\d+(?=\.[^.]+$)/, '')
}

function groupTasks(tasks: Task[]): TaskGroup[] {
  const map = new Map<string, Task[]>()
  for (const task of tasks) {
    const key = groupKey(task)
    const list = map.get(key)
    if (list) list.push(task)
    else map.set(key, [task])
  }
  return [...map.entries()].map(([id, items]) => {
    const main = [...items].sort((a, b) => b.total - a.total)[0]
    return {
      id,
      tasks: items,
      name: main.name.replace(/\.(video|audio)(\.\d+)?(?=\.[^.]+$)/, '').replace(/\.\d+(?=\.[^.]+$)/, ''),
      kind: main.kind,
      pageUrl: items.find((item) => item.pageUrl)?.pageUrl || ''
    }
  })
}

function groupProgress(group: TaskGroup) {
  const completed = group.tasks.reduce((sum, task) => sum + task.completed, 0)
  const total = group.tasks.reduce((sum, task) => sum + task.total, 0)
  const speed = group.tasks.reduce((sum, task) => sum + task.speed, 0)
  const connections = group.tasks.reduce((sum, task) => sum + task.connections, 0)
  const status =
    group.tasks.some((task) => task.status === 'active')
      ? 'active'
      : group.tasks.some((task) => task.status === 'paused')
        ? 'paused'
        : group.tasks.every((task) => task.status === 'complete')
          ? 'complete'
          : group.tasks.some((task) => task.status === 'error')
            ? 'error'
            : group.tasks[0]?.status || 'waiting'
  const main = [...group.tasks].sort((a, b) => b.total - a.total)[0]
  return { completed, total, speed, connections, status, main, p: percent(completed, total) }
}

function renderGroup(group: TaskGroup): string {
  const { completed, total, speed, connections, status, main, p } = groupProgress(group)
  const eta = formatEta(total, completed, speed)
  const gids = group.tasks.map((task) => task.gid).join(',')
  return `<article class="task" data-group="${escapeHtml(group.id)}" data-status="${escapeHtml(status)}" data-gid="${escapeHtml(group.tasks[0].gid)}" data-gids="${escapeHtml(gids)}" data-page="${escapeHtml(group.pageUrl)}" style="--progress:${p}%">
    <div class="task-top">
      <span class="kind">${kindLabel(group.kind)}</span>
      <div class="name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</div>
      <div class="meta">${groupMeta(group)}</div>
    </div>
    <div class="chunkbar" title="${main.numPieces ? `${main.numPieces} 个分片逐步完成` : `${p.toFixed(1)}%`}">${chunkCells(main)}</div>
    <div class="row-actions">${taskActions(status)}</div>
  </article>`
}

function taskActions(status: string): string {
  const resume = status === 'paused' || status === 'waiting' ? `<button type="button" data-act="resume">继续</button>` : ''
  const pause = status === 'active' ? `<button type="button" data-act="pause">暂停</button>` : ''
  const done = status === 'complete' || status === 'error' || status === 'removed'
  const up = done ? '' : `<button type="button" data-act="up" title="排到等待队列最前面">提前</button>`
  return `${resume}${pause}<button type="button" data-act="copy">复制链接</button>
      <button type="button" data-act="folder">打开目录</button>
      <button type="button" data-act="inspect">连接详情</button>
      ${up}
      <button type="button" data-act="remove">删除</button>`
}

function groupMeta(group: TaskGroup): string {
  const { completed, total, speed, connections, status } = groupProgress(group)
  const eta = formatEta(total, completed, speed)
  const main = group.tasks[0]
  return `${statusLabel(status, main.seeder, main.verifyPending)}
      · ${connections} 路
      · ${formatBytes(completed)} / ${total ? formatBytes(total) : '未知'}
      · ${formatSpeed(speed)}
      ${eta ? ` · 剩余 ${eta}` : ''}`
}

function renderLanes(task: Task): string {
  const lanes = task.lanes
  if (task.status !== 'active' && !lanes.length) return ''
  const source = lanes.length
    ? lanes
    : Array.from({ length: Math.max(task.connections, 1) }, () => ({
        uri: '',
        currentUri: '',
        downloadSpeed: task.connections ? task.speed / task.connections : 0
      }))
  const top = Math.max(...source.map((lane) => lane.downloadSpeed), 1)
  return `<div class="lanes" title="aria2 多连接分段下载">${source
    .map((lane, index) => {
      const share = Math.max(4, (lane.downloadSpeed / top) * 100)
      const hot = lane.downloadSpeed > top * 0.66
      const host = hostOf(lane.currentUri || lane.uri)
      return `<div class="lane ${hot ? 'hot' : lane.downloadSpeed ? '' : 'idle'}">
        <span>连接 ${String(index + 1).padStart(2, '0')}</span>
        <div class="lane-track"><div class="lane-fill" style="--w:${share}%"></div></div>
        <span>${formatSpeed(lane.downloadSpeed)}${host ? ` · ${escapeHtml(host)}` : ''}</span>
      </div>`
    })
    .join('')}</div>`
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host
  } catch {
    return ''
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

function visibleTasks(): Task[] {
  const tasks = snap?.tasks ?? []
  if (filter === 'active') return tasks.filter((task) => task.status === 'active')
  if (filter === 'waiting') return tasks.filter((task) => task.status === 'waiting' || task.status === 'paused')
  if (filter === 'done') return tasks.filter((task) => ['complete', 'error', 'removed'].includes(task.status))
  return tasks
}

function renderList(): void {
  const tasks = visibleTasks()
  if (!snap?.ready && snap?.error) {
    list.dataset.sig = ''
    list.innerHTML = `<div class="empty">${escapeHtml(snap.error)}</div>`
    return
  }
  if (!tasks.length) {
    list.dataset.sig = ''
    list.innerHTML = `<div class="empty">还没有任务。粘贴链接后，aria2 会按多连接分段同时拉取。</div>`
    return
  }
  const groups = groupTasks(tasks)
  const sig = groups.map((group) => group.id).join('|')
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig
    list.innerHTML = groups.map(renderGroup).join('')
    return
  }
  for (const group of groups) {
    const el = list.querySelector<HTMLElement>(`[data-group="${CSS.escape(group.id)}"]`)
    if (!el) continue
    const { p, status } = groupProgress(group)
    el.style.setProperty('--progress', `${p}%`)
    el.dataset.gids = group.tasks.map((task) => task.gid).join(',')
    el.dataset.gid = group.tasks[0].gid
    const meta = el.querySelector('.meta')
    if (meta) meta.innerHTML = groupMeta(group)
    const bar = el.querySelector('.chunkbar')
    const main = [...group.tasks].sort((a, b) => b.total - a.total)[0]
    if (bar) bar.innerHTML = chunkCells(main)
    const actions = el.querySelector('.row-actions')
    if (actions) {
      const wantUp = status !== 'complete' && status !== 'error' && status !== 'removed'
      const hasUp = Boolean(actions.querySelector('[data-act="up"]'))
      if (el.dataset.status !== status || hasUp !== wantUp) {
        el.dataset.status = status
        actions.innerHTML = taskActions(status)
      }
    }
  }
}

function renderHeader(): void {
  if (!window.aria) {
    engineTag.textContent = '预加载失败，请重启应用'
    return
  }
  if (!snap) {
    engineTag.textContent = '正在连接引擎…'
    return
  }
  const up = snap.uploadSpeed ? `  ↑ ${formatSpeed(snap.uploadSpeed)}` : ''
  speeds.textContent = `↓ ${formatSpeed(snap.downloadSpeed)}${up}   ${snap.numActive} 个在下`
  const browser = selectedBrowserLabel()
  engineTag.textContent = snap.ready && snap.version
    ? `aria2 ${snap.version} · ${snap.settings.split} 连接${browser ? ` · Cookies ${browser}` : ''}`
    : snap.error || '正在连接 aria2…'
}

function selectedBrowserLabel(): string {
  const select = document.getElementById('opt-browser') as HTMLSelectElement | null
  const id = select?.value || localStorage.getItem('xdownlder-browser') || snap?.cookieBrowser || ''
  const browsers = browserList.length ? browserList : snap?.browsers ?? []
  return browsers.find((item) => item.id === id)?.label || select?.selectedOptions[0]?.text || ''
}

function renderInspector(): void {
  if (!selected || !detail) {
    inspector.hidden = true
    return
  }
  const task = detail.task
  inspector.hidden = false
  inspector.innerHTML = `
    <h2>${escapeHtml(task.name)}</h2>
    <p class="kv">
      <b>${task.connections} 条并行连接</b><br />
      分片 ${task.numPieces || '—'} · 片长 ${task.pieceLength ? formatBytes(task.pieceLength, 0) : '—'}<br />
      GID ${task.gid}${task.infoHash ? `<br />InfoHash ${task.infoHash}` : ''}
    </p>
    ${renderLanes(task)}
    ${renderPieces(task)}
    <h3>文件</h3>
    ${detail.files
      .map(
        (file) => `<div class="file-row">
          <label><input type="checkbox" data-file="${file.index}" ${file.selected ? 'checked' : ''} /> ${escapeHtml(file.path.split('/').pop() || file.path)}</label>
          <span>${formatBytes(file.completed)} / ${formatBytes(file.length)}</span>
        </div>`
      )
      .join('')}
    <h3>源</h3>
    ${detail.uris.map((uri) => `<div class="uri-row"><span>${escapeHtml(uri.uri)}</span><span>${uri.status}</span></div>`).join('') || '<div class="kv">暂无</div>'}
    <div class="row-actions" style="margin-top:10px">
      <button data-insp="mirror">添加镜像</button>
      <button data-insp="copy">复制全部链接</button>
      <button data-insp="close">关闭</button>
    </div>
    ${
      detail.peers.length
        ? `<h3>节点</h3>${detail.peers
            .map(
              (peer) => `<div class="peer-row"><span>${peer.ip}:${peer.port}${peer.seeder ? ' · seed' : ''}</span><span>${formatSpeed(peer.downloadSpeed)}</span></div>`
            )
            .join('')}`
        : ''
    }
  `
}

function renderTools(): void {
  const box = document.getElementById('tools-box')
  if (!box || !brew) return
  const missing = brew.missing
  box.innerHTML = `
    <h2>本机工具</h2>
    <p class="kv">${brew.auto && brew.running ? '已自动开始 Homebrew 安装' : missing.length ? `缺少 ${missing.join('、')}` : 'aria2 / yt-dlp / ffmpeg 已就绪'}</p>
    ${brew.tools
      .map(
        (tool) => `<div class="tool-row">
          <span>${escapeHtml(tool.name)}</span>
          <span class="${tool.installed ? 'ok' : 'bad'}">${tool.installed ? escapeHtml(tool.version || '已安装') : '未安装'}</span>
        </div>`
      )
      .join('')}
    <div class="brew-bar" ${brew.running || brew.log ? '' : 'hidden'}>
      <div class="brew-fill" style="width:${brew.percent}%"></div>
    </div>
    <p class="kv" id="brew-line">${escapeHtml(brew.line || (brew.running ? '正在安装…' : ''))}</p>
    <pre id="brew-log" class="brew-log" ${brew.log ? '' : 'hidden'}>${escapeHtml(brew.log)}</pre>
    <div class="row-actions">
      <button data-set="brew" ${brew.running || !missing.length ? 'disabled' : ''}>${brew.running ? `安装中 ${Math.round(brew.percent)}%` : missing.length ? '用 Homebrew 安装缺失项' : '已全部安装'}</button>
    </div>
  `
  const log = document.getElementById('brew-log')
  if (log) log.scrollTop = log.scrollHeight
}

function renderSettings(): void {
  settingsEl.hidden = false
  const body = document.getElementById('settings-body')
  if (!body) return
  const s = snap?.settings
  if (!s) {
    body.innerHTML = `
      <div id="tools-box"></div>
      <h2>设置</h2>
      <p class="kv">${snap?.error || '引擎还在启动，设置已可关闭。启动完成后会自动刷新这里。'}</p>
    `
    renderTools()
    return
  }
  body.innerHTML = `
    <div id="tools-box"></div>
    <h2>引擎</h2>
    <p class="kv">${snap.ready ? snap.features.join(' / ') || 'aria2 已就绪' : snap.error || '等待 aria2'}</p>
    <div class="setting-grid">
      <label>保存目录<input id="set-dir" value="${escapeHtml(s.downloadDir)}" /></label>
      <label>同时任务<input id="set-concurrent" type="number" min="1" value="${s.maxConcurrent}" /></label>
      <label>每任务连接数 split<input id="set-split" type="number" min="1" max="16" value="${s.split}" /></label>
      <label>每服务器连接<input id="set-cps" type="number" min="1" max="16" value="${s.maxConnectionPerServer}" /></label>
      <label>最小分片<input id="set-minsplit" value="${escapeHtml(s.minSplitSize)}" /></label>
      <label>URI 选择
        <select id="set-uri">
          ${['feedback', 'adaptive', 'inorder'].map((v) => `<option ${s.uriSelector === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
      <label>分片策略
        <select id="set-piece">
          ${['default', 'inorder', 'random', 'geom'].map((v) => `<option ${s.pieceSelector === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
      <label>全局限速 KiB/s<input id="set-speed" type="number" min="0" value="${s.maxSpeedKib}" /></label>
      <label>做种比<input id="set-seed" type="number" min="0" step="0.1" value="${s.seedRatio}" /></label>
      <label>代理<input id="set-proxy" value="${escapeHtml(s.allProxy)}" placeholder="http://127.0.0.1:7890" /></label>
      <label>YouTube 默认清晰度
        <select id="set-ytq">
          ${['best', '2160', '1440', '1080', '720', '480', '360', 'audio'].map((v) => `<option value="${v}" ${s.youtubeQuality === v ? 'selected' : ''}>${v === 'best' ? '最佳画质' : v === 'audio' ? '仅音频' : v + 'p'}</option>`).join('')}
        </select>
      </label>
      <label>YouTube 登录 Cookies
        <select id="set-cookies">
          <option value="auto" ${s.ytCookiesFromBrowser === 'auto' ? 'selected' : ''}>自动使用已登录浏览器</option>
          ${snap.browsers.map((item) => `<option value="${item.id}" ${s.ytCookiesFromBrowser === item.id ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
          <option value="none" ${s.ytCookiesFromBrowser === 'none' ? 'selected' : ''}>不使用</option>
        </select>
      </label>
    </div>
    <div class="row-actions" style="margin-top:16px">
      <button data-set="dir">选择目录</button>
      <button data-set="save" class="primary">保存</button>
      <button data-set="close">关闭</button>
    </div>
  `
  renderTools()
  enhanceSelects(settingsEl)
}

function paint(): void {
  renderHeader()
  renderList()
  renderInspector()
  if (!settingsEl.hidden) {
    if (snap?.settings && !document.getElementById('set-dir')) renderSettings()
    else renderTools()
  }
}

async function refreshDetail(): Promise<void> {
  if (!selected) {
    detail = null
    return
  }
  try {
    detail = await window.aria.detail(selected)
  } catch {
    detail = null
  }
  if (detail) return
  const ids = selected.split(',').filter(Boolean)
  const task = snap?.tasks.find((item) => ids.includes(item.gid))
  if (!task) return
  detail = {
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

function openSettings(): void {
  settingsEl.hidden = false
  keepSettingsClosed = false
  renderSettings()
}

$('btn-theme').addEventListener('click', () => {
  const next = localTheme === 'light' ? 'dark' : 'light'
  localStorage.setItem('xdownlder-theme-user', '1')
  applyTheme(next)
  void api()?.saveSettings({ theme: next })
})
let keepSettingsClosed = false

function closeSettings(): void {
  settingsEl.hidden = true
  keepSettingsClosed = true
}

$('btn-settings').addEventListener('click', () => {
  if (settingsEl.hidden) openSettings()
  else closeSettings()
})
$('btn-settings-close').addEventListener('click', () => closeSettings())
$('btn-add').addEventListener('click', () => void addFromText(input.value))
$('btn-copy-urls').addEventListener('click', () => void copyInputUrls())
$('btn-clipboard').addEventListener('click', () => void addClipboard())

if (window.aria) {
  window.aria.onSnapshot((next) => {
    snap = next
    if (next.browsers?.length) browserList = next.browsers
    if (next.settings.theme && next.settings.theme !== localTheme && localStorage.getItem('xdownlder-theme-user') !== '1') {
      applyTheme(next.settings.theme)
    }
    const quality = $<HTMLSelectElement>('yt-quality')
    if (!quality.dataset.ready && next.settings.youtubeQuality) {
      quality.value = next.settings.youtubeQuality
      quality.dataset.ready = '1'
    }
    paint()
    fillBrowserFields()
    if (selected) void refreshDetail().then(renderInspector)
  })
  window.aria.onClipboardUrls((urls) => {
    pendingClipboard = urls
    applyUrlsToInput(urls, !input.value.trim())
    banner.hidden = false
    banner.innerHTML = `剪贴板里有 ${urls.length} 条链接 <button id="clip-yes">添加并按多源下载</button> <button id="clip-copy">复制这些链接</button> <button id="clip-no">忽略</button>`
  })
  window.aria.onPasteUrls(() => void pasteRecognizedUrls())
  window.aria.onAddClipboard(() => void addClipboard())
  window.aria.onCopyInputUrls(() => void copyInputUrls())
  window.aria.onEvent((event) => {
    if (event.method === 'aria2.onDownloadComplete') showToast('分片已下完，若是 YouTube 会自动合成音画')
    if (event.method === 'aria2.onDownloadError') showToast('有任务出错')
    if (event.method === 'aria.onYoutubeMerge') showToast('正在把音轨合成进视频…')
    if (event.method === 'aria.onYoutubeMerged') showToast('已合成有声 MP4')
    if (event.method === 'aria.onYoutubeMergeError') showToast(event.message || '音画合成失败')
  })
  window.aria.onOpenSettings(() => openSettings())
  window.aria.onBrewProgress((progress) => {
    brew = progress
    if (progress.running && settingsEl.hidden && !keepSettingsClosed) openSettings()
    else renderTools()
  })
  void window.aria.listBrowsers().then((browsers) => {
    browserList = browsers
    fillBrowserFields()
  }).catch(() => {
    fillBrowserFields()
  })
  void window.aria.brewStatus().then((progress) => {
    brew = progress
    renderTools()
  })
  void window.aria.snapshot().then((next) => {
    snap = next
    if (next.browsers?.length) browserList = next.browsers
    paint()
    fillBrowserFields()
  }).catch((error) => {
    engineTag.textContent = error instanceof Error ? error.message : String(error)
  })
  renderHeader()
} else {
  engineTag.textContent = '预加载失败，请重启应用'
  const select = document.getElementById('opt-browser') as HTMLSelectElement | null
  if (select) select.innerHTML = '<option value="">预加载失败</option>'
}

document.getElementById('opt-browser')?.addEventListener('change', (event) => {
  const id = (event.target as HTMLSelectElement).value
  const ua = document.getElementById('opt-ua') as HTMLInputElement | null
  if (ua) ua.dataset.auto = '1'
  localStorage.setItem('xdownlder-browser', id)
  void api()?.saveSettings({ ytCookiesFromBrowser: id })
  fillBrowserFields(id)
  renderHeader()
})
document.getElementById('opt-ua')?.addEventListener('input', () => {
  const ua = document.getElementById('opt-ua') as HTMLInputElement
  ua.dataset.auto = '0'
})
document.getElementById('opt-referer')?.addEventListener('input', () => {
  const referer = document.getElementById('opt-referer') as HTMLInputElement
  referer.dataset.auto = '0'
})
$('btn-torrent').addEventListener('click', async () => {
  const data = await window.aria.pickTorrent()
  if (data) {
    const result = await window.aria.addTorrent(data)
    showToast(result.ok ? '已添加种子' : result.error || '添加失败')
  }
})
$('btn-metalink').addEventListener('click', async () => {
  const data = await window.aria.pickMetalink()
  if (data) {
    const result = await window.aria.addMetalink(data)
    showToast(result.ok ? `Metalink 已展开 ${result.added} 个任务` : result.error || '添加失败')
  }
})

input.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void addFromText(input.value)
})

let probeTimer = 0
input.addEventListener('input', () => {
  window.clearTimeout(probeTimer)
  probeTimer = window.setTimeout(() => {
    fillBrowserFields()
    void probeQuality()
  }, 500)
})
input.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text') ?? ''
  const html = event.clipboardData?.getData('text/html') ?? ''
  const urls = unique([...extractUrls(text), ...extractUrlsFromHtml(html)])
  if (urls.length) {
    event.preventDefault()
    applyUrlsToInput(urls)
  }
  window.setTimeout(() => void probeQuality(), 50)
})

async function probeQuality(): Promise<void> {
  const url = extractUrls(input.value).find(isYouTubeUrl)
  const select = $<HTMLSelectElement>('yt-quality')
  if (!url) return
  const previous = select.value
  try {
    showToast('正在读取该视频的可用清晰度…')
    const probe = await window.aria.probeYouTube(url, $<HTMLSelectElement>('opt-browser').value || undefined)
    const extras = probe.qualities.map((item) => `<option value="${item.id}">${escapeHtml(item.label)}</option>`).join('')
    select.innerHTML = `
      <option value="best">最佳画质</option>
      ${extras}
      <option value="audio">仅音频</option>
    `
    select.value = [...select.options].some((item) => item.value === previous) ? previous : 'best'
    syncPicker(select)
    showToast(probe.title ? `${probe.title} · ${probe.qualities.map((item) => `${item.height}p`).join(' / ')}` : '未读到清晰度')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '清晰度解析失败')
  }
}

document.addEventListener('paste', (event) => {
  if (document.activeElement === input) return
  const text = event.clipboardData?.getData('text') ?? ''
  const html = event.clipboardData?.getData('text/html') ?? ''
  const urls = unique([...extractUrls(text), ...extractUrlsFromHtml(html)])
  if (urls.length) {
    event.preventDefault()
    applyUrlsToInput(urls)
    showToast(`已粘贴 ${urls.length} 条链接`)
  }
})

banner.addEventListener('click', (event) => {
  const id = (event.target as HTMLElement).id
  if (id === 'clip-yes') void addClipboard()
  if (id === 'clip-copy') {
    if (pendingClipboard.length) {
      applyUrlsToInput(pendingClipboard)
      void copyInputUrls()
    }
  }
  if (id === 'clip-no') {
    banner.hidden = true
    pendingClipboard = []
  }
})

async function runTaskAction(act: string, taskEl: HTMLElement): Promise<void> {
  const gids = (taskEl.dataset.gids || taskEl.dataset.gid || '').split(',').filter(Boolean)
  const gid = gids[0]
  if (!gid) {
    showToast('找不到这个任务')
    return
  }
  if (act === 'pause') {
    await Promise.all(gids.map((item) => window.aria.pause(item)))
    showToast('已暂停')
    return
  }
  if (act === 'resume') {
    await Promise.all(gids.map((item) => window.aria.resume(item)))
    showToast('已继续')
    return
  }
  if (act === 'remove') {
    await Promise.all(gids.map((item) => window.aria.remove(item)))
    showToast('已删除任务和文件')
    return
  }
  if (act === 'copy') {
    const page = taskEl.dataset.page
    if (page) {
      await window.aria.writeClipboard(page)
      showToast('已复制视频链接')
      return
    }
    const urls = unique((await Promise.all(gids.map((item) => window.aria.copyUrls(item)))).flat())
    showToast(urls.length ? `已复制 ${urls.length} 条链接` : '没有可复制的链接')
    return
  }
  if (act === 'folder') {
    await window.aria.openFolder(gid)
    return
  }
  if (act === 'up') {
    await window.aria.move(gid, 'POS_SET', 0)
    showToast('已提到最前')
    return
  }
  if (act === 'inspect') {
    selected = gids.join(',')
    await refreshDetail()
    renderInspector()
    if (!detail) showToast('暂时读不到连接详情')
  }
}

list.addEventListener('click', (event) => {
  const target = event.target
  const el = target instanceof Element ? target : (target as Node).parentElement
  const button = el?.closest('button')
  const taskEl = el?.closest<HTMLElement>('.task')
  if (!button || !taskEl || !list.contains(button)) return
  event.preventDefault()
  event.stopPropagation()
  const act = button.dataset.act
  if (!act) return
  void runTaskAction(act, taskEl).catch((error) => {
    showToast(error instanceof Error ? error.message : '操作失败')
  })
})

inspector.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest('button')
  if (!button || !selected) return
  const gid = selected.split(',')[0]
  const act = button.dataset.insp
  if (act === 'close') {
    selected = null
    detail = null
    inspector.hidden = true
  }
  if (act === 'copy') {
    const urls = await window.aria.copyUrls(gid)
    showToast(`已复制 ${urls.length} 条`)
  }
  if (act === 'mirror') {
    const uri = window.prompt('添加镜像 URL（同一文件的另一个源）')
    if (uri) await window.aria.changeUris(gid, [uri])
  }
})

inspector.addEventListener('change', async (event) => {
  const box = event.target as HTMLInputElement
  if (!selected || box.type !== 'checkbox' || !box.dataset.file || !detail) return
  const gid = selected.split(',')[0]
  const selectedIndexes = detail.files
    .filter((file) => {
      if (String(file.index) === box.dataset.file) return box.checked
      return file.selected
    })
    .map((file) => file.index)
  await window.aria.selectFiles(gid, selectedIndexes)
})

settingsEl.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest('button')
  if (!button) return
  const act = button.dataset.set
  if (act === 'close') {
    closeSettings()
    return
  }
  if (!snap) return
  if (act === 'brew') {
    showToast('开始用 Homebrew 安装缺失工具')
    void window.aria.brewInstall(false)
  }
  if (act === 'dir') {
    const dir = await window.aria.pickDownloadDir()
    if (dir) {
      const inputDir = document.getElementById('set-dir') as HTMLInputElement | null
      if (inputDir) inputDir.value = dir
    }
  }
  if (act === 'save') {
    const next: Partial<Settings> = {
      downloadDir: (document.getElementById('set-dir') as HTMLInputElement).value,
      maxConcurrent: Number((document.getElementById('set-concurrent') as HTMLInputElement).value),
      split: Number((document.getElementById('set-split') as HTMLInputElement).value),
      maxConnectionPerServer: Number((document.getElementById('set-cps') as HTMLInputElement).value),
      minSplitSize: (document.getElementById('set-minsplit') as HTMLInputElement).value,
      uriSelector: (document.getElementById('set-uri') as HTMLSelectElement).value as Settings['uriSelector'],
      pieceSelector: (document.getElementById('set-piece') as HTMLSelectElement).value as Settings['pieceSelector'],
      maxSpeedKib: Number((document.getElementById('set-speed') as HTMLInputElement).value),
      seedRatio: Number((document.getElementById('set-seed') as HTMLInputElement).value),
      allProxy: (document.getElementById('set-proxy') as HTMLInputElement).value,
      youtubeQuality: (document.getElementById('set-ytq') as HTMLSelectElement).value,
      ytCookiesFromBrowser: (document.getElementById('set-cookies') as HTMLSelectElement).value
    }
    await window.aria.saveSettings(next)
    showToast('已写入 aria2 运行参数')
    settingsEl.hidden = true
  }
})

document.getElementById('filters')?.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button')
  if (!button?.dataset.filter) return
  filter = button.dataset.filter as Filter
  for (const item of document.querySelectorAll('#filters button')) item.classList.toggle('on', item === button)
  renderList()
})

;['dragenter', 'dragover'].forEach((name) => {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault()
    dropzone.classList.add('over')
  })
})
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'))
dropzone.addEventListener('drop', async (event) => {
  event.preventDefault()
  dropzone.classList.remove('over')
  const files = [...(event.dataTransfer?.files ?? [])]
  const text = event.dataTransfer?.getData('text') ?? ''
  const html = event.dataTransfer?.getData('text/html') ?? ''
  for (const file of files) {
    const buf = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (const byte of buf) binary += String.fromCharCode(byte)
    const base64 = btoa(binary)
    if (/\.torrent$/i.test(file.name)) await window.aria.addTorrent(base64)
    if (/\.(meta4|metalink)$/i.test(file.name)) await window.aria.addMetalink(base64)
  }
  const urls = unique([...extractUrls(text), ...extractUrlsFromHtml(html)])
  if (urls.length) {
    applyUrlsToInput(urls)
    showToast(`已放入 ${urls.length} 条链接`)
  }
})

