import { request } from 'node:http'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

type RpcResponse<T> = {
  jsonrpc: '2.0'
  id: string
  result?: T
  error?: { code: number; message: string }
}

export class AriaRpc {
  private id = 0

  constructor(
    private readonly port: number,
    private readonly secret: string,
    private readonly timeoutMs = 3000
  ) {}

  get httpUrl(): string {
    return `http://127.0.0.1:${this.port}/jsonrpc`
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/jsonrpc`
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.callRaw<T>(method, [`token:${this.secret}`, ...params])
  }

  async callRaw<T = unknown>(method: string, params: unknown[] = [], timeoutMs = this.timeoutMs): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: String(++this.id), method, params })
    // Local control traffic must never inherit fetch dispatchers or media proxies.
    const data = await new Promise<RpcResponse<T>>((resolve, reject) => {
      const req = request(this.httpUrl, {
        method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      })
      const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), Math.max(1, timeoutMs))
      const fail = (error: unknown) => {
        clearTimeout(timer)
        // Only expose a bounded system code, never request bodies, tokens or URLs from a cause.
        const code = (error as NodeJS.ErrnoException)?.code
        const cause = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'CONNECTION_FAILED'
        reject(new Error(`本地 aria2 RPC 连接失败 (127.0.0.1:${this.port}，${cause})；这不是外部媒体下载错误`))
      }
      req.on('error', fail)
      req.on('response', res => {
        const chunks: Buffer[] = []
        res.on('error', fail)
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          clearTimeout(timer)
          if (res.statusCode !== 200) {
            reject(new Error(`本地 aria2 RPC HTTP ${res.statusCode}`))
            return
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcResponse<T>) }
          catch { reject(new Error('本地 aria2 RPC 返回无效 JSON')) }
        })
      })
      req.end(body)
    })
    if (data.error) throw new Error(`本地 aria2 RPC 错误 (${data.error.code})`)
    return data.result as T
  }

  async multicall(calls: { methodName: string; params?: unknown[] }[]): Promise<unknown[]> {
    const encoded = calls.map((item) => ({
      methodName: item.methodName,
      params: [`token:${this.secret}`, ...(item.params ?? [])]
    }))
    return this.callRaw<unknown[]>('system.multicall', [encoded])
  }

  async waitReady(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError = '本地 aria2 RPC 未就绪'
    while (Date.now() < deadline) {
      try {
        await this.callRaw('aria2.getVersion', [`token:${this.secret}`], Math.min(this.timeoutMs, deadline - Date.now()))
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await sleep(Math.min(150, Math.max(0, deadline - Date.now())))
      }
    }
    throw new Error(lastError)
  }
}

export function unwrapMulticall<T>(item: unknown): T {
  if (Array.isArray(item)) return item[0] as T
  if (item && typeof item === 'object' && 'faultString' in item) {
    throw new Error('本地 aria2 RPC multicall 子请求失败')
  }
  return item as T
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type { Json }
