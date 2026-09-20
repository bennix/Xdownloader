export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : digits)} ${units[exp]}`
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatEta(total: number, completed: number, speed: number): string {
  if (speed <= 0 || total <= completed) return ''
  const seconds = Math.round((total - completed) / speed)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}h ${minutes}m`
}

export function percent(completed: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, (completed / total) * 100)
}

export function statusLabel(status: string, seeder: boolean, verifyPending: boolean): string {
  if (verifyPending) return '校验中'
  if (status === 'active' && seeder) return '做种'
  switch (status) {
    case 'active':
      return '下载中'
    case 'waiting':
      return '排队'
    case 'paused':
      return '已暂停'
    case 'complete':
      return '已完成'
    case 'error':
      return '出错'
    case 'removed':
      return '已移除'
    default:
      return status
  }
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case 'bt':
      return 'BT'
    case 'magnet':
      return '磁力'
    case 'metalink':
      return 'Metalink'
    case 'ftp':
      return 'FTP'
    case 'youtube':
      return 'YouTube'
    case 'x':
      return 'X'
    default:
      return 'HTTP'
  }
}
