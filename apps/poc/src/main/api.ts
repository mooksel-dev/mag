import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { ToolHandler } from './tools'

export interface LocalApi {
  url: string
  token: string
}

/** Localhost endpoint the task MCP server calls to run tools against app state. */
export function startApi(handle: ToolHandler): Promise<LocalApi> {
  const token = randomBytes(16).toString('hex')
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tool' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    const hangup = new AbortController()
    res.on('close', () => !res.writableFinished && hangup.abort())
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const { taskId, projectId, sessionId, name, args } = JSON.parse(body)
        const ctx = { taskId: taskId || undefined, projectId: projectId || undefined, sessionId: sessionId || undefined, signal: hangup.signal }
        const text = await handle(ctx, name, args ?? {})
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text }))
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String((e as Error).message ?? e) }))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, token })
    })
  })
}
