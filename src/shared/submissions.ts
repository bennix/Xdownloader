import type { AddPayload, SniffHit, Task } from './types'

export function filterTasks(tasks: Task[], filter: string): Task[] {
  if (filter === 'active') return tasks.filter(task => task.status === 'active')
  if (filter === 'waiting') return tasks.filter(task => task.status === 'waiting' || task.status === 'paused')
  if (filter === 'done') return tasks.filter(task => ['complete', 'error', 'removed'].includes(task.status))
  return tasks
}

export function pendingSubmissionCount(items: Submission[]): number {
  return items.filter(item => item.state === 'queued' || item.state === 'running').length
}

export type Submission = {
  id: number
  payload: AddPayload
  state: 'queued' | 'running' | 'done' | 'error'
  message: string
}

// Never carry input-box credentials or another page's headers into a sniff hit.
export function sniffPayload(hit: SniffHit, defaults: AddPayload): AddPayload {
  const headers = [...(hit.headers ?? [])]
  const value = (name: string) => headers.find(line => line.toLowerCase().startsWith(`${name}:`))?.split(':').slice(1).join(':').trim()
  return { ...defaults, uris: [hit.url], multiSource: false, out: undefined,
    checksum: undefined, headers, referer: value('referer') || hit.pageUrl || undefined,
    userAgent: value('user-agent') }
}

export class SubmissionQueue {
  readonly items: Submission[] = []
  private draining = false
  private nextId = 0
  constructor(
    private readonly submit: (payload: AddPayload) => Promise<{ ok: boolean; added: number; existing?: number; error?: string }>,
    private readonly changed: () => void
  ) {}

  enqueue(payload: AddPayload): void {
    this.items.push({ id: ++this.nextId, payload: structuredClone(payload), state: 'queued', message: '' })
    this.changed()
    void this.drain()
  }

  remove(id: number): void {
    const index = this.items.findIndex(item => item.id === id && item.state !== 'running')
    if (index < 0) return
    this.items.splice(index, 1)
    this.changed()
  }

  // Running submissions are already in flight to the main process, so they stay.
  clearSettled(): number {
    const before = this.items.length
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].state === 'done' || this.items[i].state === 'error') this.items.splice(i, 1)
    }
    if (this.items.length !== before) this.changed()
    return before - this.items.length
  }

  stateOf(url: string): Submission['state'] | '' {
    const key = url.split('#')[0]
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].payload.uris.some(uri => uri.split('#')[0] === key)) return this.items[i].state
    }
    return ''
  }

  retry(id: number): void {
    const item = this.items.find(item => item.id === id)
    if (!item || item.state !== 'error') return
    item.state = 'queued'
    item.message = ''
    this.changed()
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      let item: Submission | undefined
      while ((item = this.items.find(item => item.state === 'queued'))) {
        item.state = 'running'
        this.changed()
        try {
          const result = await this.submit(item.payload)
          item.state = result.ok && !result.error ? 'done' : 'error'
          item.message = result.error || (result.ok ? `已添加 ${result.added} 个任务${result.existing ? ` · ${result.existing} 个已在队列或已完成` : ''}` : '添加失败')
        } catch (error) {
          item.state = 'error'
          item.message = error instanceof Error ? error.message : String(error)
        }
        this.changed()
      }
    } finally {
      this.draining = false
    }
  }
}
