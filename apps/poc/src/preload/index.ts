import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppState, MagApi } from './api'

// Listen from the start: a main window opened for a task gets the event before the page subscribes.
let pendingTask: [projectId: string, taskId: string] | null = null
let openTaskCb: ((projectId: string, taskId: string) => void) | null = null
ipcRenderer.on('open-task', (_, projectId: string, taskId: string) => {
  if (openTaskCb) openTaskCb(projectId, taskId)
  else pendingTask = [projectId, taskId]
})

const api: MagApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => {
    const fn = (_: unknown, s: AppState) => cb(s)
    ipcRenderer.on('state', fn)
    return () => ipcRenderer.removeListener('state', fn)
  },
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  createProject: (name) => ipcRenderer.invoke('project:create', name),
  updateProject: (id, patch) => ipcRenderer.invoke('project:update', id, patch),
  createTask: (t) => ipcRenderer.invoke('task:create', t),
  updateTask: (id, patch) => ipcRenderer.invoke('task:update', id, patch),
  groom: (taskId) => ipcRenderer.invoke('task:groom', taskId),
  addToPlan: (taskId) => ipcRenderer.invoke('task:addToPlan', taskId),
  move: (taskId, dir) => ipcRenderer.invoke('task:move', taskId, dir),
  reorderSubtasks: (parentId, ids) => ipcRenderer.invoke('task:reorderSubtasks', parentId, ids),
  develop: (taskId) => ipcRenderer.invoke('task:develop', taskId),
  checkPrs: () => ipcRenderer.invoke('pr:checkNow'),
  open: (target) => ipcRenderer.invoke('shell:open', target),
  runArchitect: (projectId) => ipcRenderer.invoke('arch:run', projectId),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  repoInfo: (path) => ipcRenderer.invoke('repo:info', path),
  send: (sessionId, text, attachments) => ipcRenderer.invoke('session:send', sessionId, text, attachments),
  newChat: (projectId) => ipcRenderer.invoke('chat:new', projectId),
  getCanvas: (id) => ipcRenderer.invoke('canvas:get', id),
  saveAttachment: (f) => ipcRenderer.invoke('attach:save', f),
  pathForFile: (file) => webUtils.getPathForFile(file),
  stop: (sessionId) => ipcRenderer.invoke('session:stop', sessionId),
  decideApproval: (sessionId, approvalId, allow) => ipcRenderer.invoke('approval:decide', sessionId, approvalId, allow),
  openWindow: (target) => ipcRenderer.invoke('window:open', target),
  openTask: (taskId) => ipcRenderer.invoke('window:openTask', taskId),
  onOpenTask: (cb) => {
    openTaskCb = cb
    if (pendingTask) cb(...pendingTask)
    pendingTask = null
    return () => {
      if (openTaskCb === cb) openTaskCb = null
    }
  },
  reportCrash: (crash) => ipcRenderer.invoke('log:crash', crash),
  lastCrash: () => ipcRenderer.invoke('crash:last'),
  dismissCrash: () => ipcRenderer.invoke('crash:dismiss'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
}

contextBridge.exposeInMainWorld('mag', api)
