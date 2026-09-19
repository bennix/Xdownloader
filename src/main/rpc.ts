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
    private readonly secret: string
  ) {}

  get httpUrl(): string {
    return `http://127.0.0.1:${this.port}/jsonrpc`
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/jsonrpc`
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      id: String(++this.id),
      method,
      params: [`token:${this.secret}`, ...params]
    }
    const res = await fetch(this.httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
    const data = (await res.json()) as RpcResponse<T>
    if (data.error) throw new Error(data.error.message)
    return data.result as T
  }

  async callRaw<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      id: String(++this.id),
      method,
      params
    }
    const res = await fetch(this.httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
    const data = (await res.json()) as RpcResponse<T>
    if (data.error) throw new Error(data.error.message)
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
    const start = Date.now()
    let lastError = 'RPC 未就绪'
    while (Date.now() - start < timeoutMs) {
      try {
        await this.call('aria2.getVersion')
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await sleep(150)
      }
    }
    throw new Error(lastError)
  }
}

export function unwrapMulticall<T>(item: unknown): T {
  if (Array.isArray(item)) return item[0] as T
  if (item && typeof item === 'object' && 'faultString' in item) {
    throw new Error(String((item as { faultString: string }).faultString))
  }
  return item as T
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type { Json }
