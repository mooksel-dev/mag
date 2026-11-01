import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppState, MagApi, PickerMode } from './api'

// Listen from the start: a window opened for a task or the picker gets the event before the page subscribes.
let pendingTask: [projectId: string, taskId: string] | null = null
let openTaskCb: ((projectId: string, taskId: string) => void) | null = null
ipcRenderer.on('open-task', (_, projectId: string, taskId: string) => {
  if (openTaskCb) openTaskCb(projectId, taskId)
  else pendingTask = [projectId, taskId]
})
let pendingPicker: PickerMode | null = null
let pickerCb: ((mode: PickerMode) => void) | null = null
ipcRenderer.on('picker:open', (_, mode: PickerMode) => {
  if (pickerCb) pickerCb(mode)
  else pendingPicker = mode
})

// Project windows load with `#project=<id>`; Welcome and pop-outs have no project. (The preload is typed for Node.)
const { hash } = (globalThis as unknown as { location: { hash: string } }).location
const windowProject = new URLSearchParams(hash.slice(1)).get('project')

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
  cancel: (taskId, reason) => ipcRenderer.invoke('task:cancel', taskId, reason),
  archive: (taskIds) => ipcRenderer.invoke('task:archive', taskIds),
  restore: (taskId) => ipcRenderer.invoke('task:restore', taskId),
  setSubtaskStatus: (subtaskId, status) => ipcRenderer.invoke('task:setSubtaskStatus', subtaskId, status),
  move: (taskId, dir) => ipcRenderer.invoke('task:move', taskId, dir),
  reorderSubtasks: (parentId, ids) => ipcRenderer.invoke('task:reorderSubtasks', parentId, ids),
  develop: (taskId, localRepos) => ipcRenderer.invoke('task:develop', taskId, localRepos),
  resolveLocal: (stepId, repo, choice) => ipcRenderer.invoke('task:resolveLocal', stepId, repo, choice),
  startStep: (taskId) => ipcRenderer.invoke('task:startStep', taskId),
  review: (taskId) => ipcRenderer.invoke('task:review', taskId),
  importTicket: (projectId, ref) => ipcRenderer.invoke('task:import', projectId, ref),
  retryImport: (taskId) => ipcRenderer.invoke('task:retryImport', taskId),
  linkTicket: (taskId, url) => ipcRenderer.invoke('task:linkTicket', taskId, url),
  unlinkTicket: (taskId) => ipcRenderer.invoke('task:unlinkTicket', taskId),
  moveToTodo: (taskId) => ipcRenderer.invoke('task:moveToTodo', taskId),
  checkPrs: () => ipcRenderer.invoke('pr:checkNow'),
  open: (target) => ipcRenderer.invoke('shell:open', target),
  runArchitect: (projectId) => ipcRenderer.invoke('arch:run', projectId),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  repoInfo: (path) => ipcRenderer.invoke('repo:info', path),
  send: (sessionId, text, attachments) => ipcRenderer.invoke('session:send', sessionId, text, attachments),
  newChat: (projectId) => ipcRenderer.invoke('chat:new', projectId),
  renameChat: (sessionId, title) => ipcRenderer.invoke('chat:rename', sessionId, title),
  deleteChat: (sessionId) => ipcRenderer.invoke('chat:delete', sessionId),
  getCanvas: (id) => ipcRenderer.invoke('canvas:get', id),
  saveAttachment: (f) => ipcRenderer.invoke('attach:save', f),
  pathForFile: (file) => webUtils.getPathForFile(file),
  stop: (sessionId) => ipcRenderer.invoke('session:stop', sessionId),
  stopBackground: (sessionId, taskId) => ipcRenderer.invoke('session:stopBackground', sessionId, taskId),
  decideApproval: (sessionId, approvalId, allow) => ipcRenderer.invoke('approval:decide', sessionId, approvalId, allow),
  openWindow: (target) => ipcRenderer.invoke('window:open', target),
  windowProjectId: () => windowProject,
  openProject: (projectId) => ipcRenderer.invoke('window:openProject', projectId),
  onOpenPicker: (cb) => {
    pickerCb = cb
    if (pendingPicker) cb(pendingPicker)
    pendingPicker = null
    return () => {
      if (pickerCb === cb) pickerCb = null
    }
  },
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
