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
  setSubtaskStatus: (subtaskId, status) => ipcRenderer.invoke('task:setSubtaskStatus', subtaskId, status),
  reorderSubtasks: (parentId, ids) => ipcRenderer.invoke('task:reorderSubtasks', parentId, ids),
  develop: (taskId, localRepos) => ipcRenderer.invoke('task:develop', taskId, localRepos),
  resolveLocal: (stepId, repo, choice) => ipcRenderer.invoke('task:resolveLocal', stepId, repo, choice),
  startStep: (taskId) => ipcRenderer.invoke('task:startStep', taskId),
  review: (taskId) => ipcRenderer.invoke('task:review', taskId),
  workFromTicket: (projectId, url) => ipcRenderer.invoke('task:fromTicket', projectId, url),
  addTicket: (taskId, url) => ipcRenderer.invoke('task:addTicket', taskId, url),
  removeTicket: (taskId, url) => ipcRenderer.invoke('task:removeTicket', taskId, url),
  approve: (taskId) => ipcRenderer.invoke('task:approve', taskId),
  approveAndStart: (taskId, localRepos) => ipcRenderer.invoke('task:approveAndStart', taskId, localRepos),
  reopen: (taskId, what) => ipcRenderer.invoke('task:reopen', taskId, what),
  addIdea: (projectId, text) => ipcRenderer.invoke('idea:add', projectId, text),
  checkPrs: () => ipcRenderer.invoke('pr:checkNow'),
  open: (target) => ipcRenderer.invoke('shell:open', target),
  runCommand: (runId, sessionId, command, onOutput) => {
    const listener = (_: unknown, id: string, chunk: string) => { if (id === runId) onOutput(chunk) }
    ipcRenderer.on('command:output', listener)
    return ipcRenderer.invoke('command:run', runId, sessionId, command).finally(() => ipcRenderer.removeListener('command:output', listener))
  },
  stopCommand: (runId) => ipcRenderer.invoke('command:stop', runId),
  runArchitect: (projectId) => ipcRenderer.invoke('arch:run', projectId),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  setSessionChoice: (sessionId, choice) => ipcRenderer.invoke('session:setChoice', sessionId, choice),
  repoInfo: (path) => ipcRenderer.invoke('repo:info', path),
  send: (sessionId, text, attachments, refs) => ipcRenderer.invoke('session:send', sessionId, text, attachments, refs),
  newChat: (projectId) => ipcRenderer.invoke('chat:new', projectId),
  startChild: (parentId, brief, role, fork) => ipcRenderer.invoke('session:start-child', parentId, brief, role, fork),
  rewind: (sessionId, n, mode, scope) => ipcRenderer.invoke('session:rewind', sessionId, n, mode, scope),
  undoRewind: (sessionId) => ipcRenderer.invoke('session:undo-rewind', sessionId),
  branchFrom: (sessionId, n) => ipcRenderer.invoke('session:branch-from', sessionId, n),
  renameChat: (sessionId, title) => ipcRenderer.invoke('chat:rename', sessionId, title),
  deleteChat: (sessionId) => ipcRenderer.invoke('chat:delete', sessionId),
  closeChat: (sessionId) => ipcRenderer.invoke('chat:close', sessionId),
  deleteWork: (taskId) => ipcRenderer.invoke('task:delete', taskId),
  closeWork: (taskId) => ipcRenderer.invoke('task:close', taskId),
  restore: (kind, id) => ipcRenderer.invoke('sidebar:restore', kind, id),
  getCanvas: (id) => ipcRenderer.invoke('canvas:get', id),
  deleteCanvas: (id) => ipcRenderer.invoke('canvas:delete', id),
  stepFact: (stepId) => ipcRenderer.invoke('step:fact', stepId),
  stepHunk: (stepId, repo, base, head, hunk) => ipcRenderer.invoke('step:hunk', stepId, repo, base, head, hunk),
  saveAttachment: (f) => ipcRenderer.invoke('attach:save', f),
  pathForFile: (file) => webUtils.getPathForFile(file),
  stop: (sessionId) => ipcRenderer.invoke('session:stop', sessionId),
  stopBackground: (sessionId, taskId) => ipcRenderer.invoke('session:stopBackground', sessionId, taskId),
  decideApproval: (sessionId, approvalId, allow) => ipcRenderer.invoke('approval:decide', sessionId, approvalId, allow),
  enableIntegration: (sessionId, itemId, mode) => ipcRenderer.invoke('integration:enable', sessionId, itemId, mode),
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
  startReview: (projectId, url, format) => ipcRenderer.invoke('review:start', projectId, url, format),
  runReviewFormat: (taskId, format) => ipcRenderer.invoke('review:run', taskId, format),
  showReviewResult: (taskId, format) => ipcRenderer.invoke('review:show', taskId, format),
  reviewAgain: (taskId) => ipcRenderer.invoke('review:again', taskId),
  closeReview: (taskId) => ipcRenderer.invoke('review:close', taskId),
  decideDirection: (taskId, decision) => ipcRenderer.invoke('review:decide', taskId, decision),
  discussDirection: (taskId) => ipcRenderer.invoke('review:discuss', taskId),
  deleteReview: (taskId) => ipcRenderer.invoke('review:delete', taskId),
  prChecks: (taskId) => ipcRenderer.invoke('review:checks', taskId),
  publishReview: (taskId, verdict, picks) => ipcRenderer.invoke('review:publish', taskId, verdict, picks),
  connectReviewRepo: (taskId) => ipcRenderer.invoke('review:connect', taskId),
  exportReview: (taskId) => ipcRenderer.invoke('review:export', taskId),
  importReview: (projectId, zipPath) => ipcRenderer.invoke('review:import', projectId, zipPath),
  onRenderReviewExport: (fn) => {
    const listener = (_: unknown, n: number, taskId: string) => {
      fn(taskId).then(
        (page) => ipcRenderer.invoke('review:rendered', n, page),
        (e) => ipcRenderer.invoke('review:rendered', n, { error: String((e as Error)?.message ?? e) }),
      )
    }
    ipcRenderer.on('review:render', listener)
    return () => void ipcRenderer.removeListener('review:render', listener)
  },
  reportCrash: (crash) => ipcRenderer.invoke('log:crash', crash),
  lastCrash: () => ipcRenderer.invoke('crash:last'),
  dismissCrash: () => ipcRenderer.invoke('crash:dismiss'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
}

contextBridge.exposeInMainWorld('mag', api)
