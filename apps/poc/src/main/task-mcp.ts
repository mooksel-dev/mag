// Minimal stdio MCP server (newline-delimited JSON-RPC). Spawned by the agent CLI,
// forwards tool calls to the app's local API for one task or project.
import { createInterface } from 'node:readline'
import { TOOL_DEFS } from './tool-defs'

const API = process.env.MAG_API
const TOKEN = process.env.MAG_TOKEN
const TASK_ID = process.env.MAG_TASK_ID
const PROJECT_ID = process.env.MAG_PROJECT_ID
const SESSION_ID = process.env.MAG_SESSION_ID
const TOOLS = TOOL_DEFS.filter((t) => t.scope === 'any' || t.scope === (TASK_ID ? 'task' : 'project')).map(({ scope: _, ...t }) => t)

const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

async function callTool(name: string, args: unknown) {
  const res = await fetch(`${API}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ taskId: TASK_ID, projectId: PROJECT_ID, sessionId: SESSION_ID, name, args }),
  })
  const data = (await res.json()) as { text?: string; error?: string }
  return data.error
    ? { content: [{ type: 'text', text: data.error }], isError: true }
    : { content: [{ type: 'text', text: data.text ?? '' }] }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let msg: { id?: number | string; method?: string; params?: any }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg
  if (id === undefined) return // notification

  try {
    switch (method) {
      case 'initialize':
        return send({
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'mag', version: '0.0.0' },
          },
        })
      case 'ping':
        return send({ id, result: {} })
      case 'tools/list':
        return send({ id, result: { tools: TOOLS } })
      case 'tools/call':
        return send({ id, result: await callTool(params.name, params.arguments ?? {}) })
      default:
        return send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  } catch (e) {
    send({ id, result: { content: [{ type: 'text', text: String((e as Error).message ?? e) }], isError: true } })
  }
})
