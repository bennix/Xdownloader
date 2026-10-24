import { randomUUID } from 'node:crypto'
import type { HlsProgress } from '../shared/types'
import { link, stat } from 'node:fs/promises'

export type HlsQueueItem<T> = { progress?: HlsProgress; id: string; key: string; input: T; status: 'waiting' | 'active' | 'complete' | 'error'; percent: number; phase: string; path: string; error: string }

// A main-process queue: renderer lifetimes and IPC calls do not own downloads.
export class HlsQueue<T> {
  readonly items: HlsQueueItem<T>[] = []
  private running = false
  constructor(private readonly run: (item: HlsQueueItem<T>) => Promise<void>) {}
  add(key: string, input: T): boolean {
    if (this.items.some(item => item.key === key && item.status !== 'error')) return false
    this.items.push({ id: `hls-${randomUUID()}`, key, input: structuredClone(input), status: 'waiting', percent: 0, phase: '排队', path: '', error: '' })
    void this.drain()
    return true
  }
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const item of this.items) {
        if (item.status !== 'waiting') continue
        item.status = 'active'
        try { await this.run(item); item.status = 'complete'; item.percent = 100; item.phase = '完成' }
        catch (error) { item.status = 'error'; item.error = error instanceof Error ? error.message : String(error); item.phase = '失败' }
        finally { if (item.progress) { item.progress.speed = 0; item.progress.eta = null } }
      }
    } finally { this.running = false }
  }
}

// Hard-link publication is atomic and fails if the destination already exists.
// Staging is on the same filesystem. Never remove or overwrite a user's output.
export async function publishHls(staged: string, destination: string): Promise<void> {
  if (!(await stat(staged)).size) throw new Error('HLS 输出为空')
  await link(staged, destination)
}
