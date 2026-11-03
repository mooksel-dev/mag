// Domain model shared by every mag app (PoC, desktop, web, backend).
// Keep it free of runtime dependencies.

import type { ArchDiagram } from './arch.ts'
import type { CanvasRole } from './canvases.ts'
import type { ChangeInventory } from './inventory.ts'
import type { Diagram } from './diagram.ts'
import { DEFAULT_PLAYBOOK, type Playbook } from './playbook.ts'
import { isReview, reviewReadyText, reviewState, type FindingLevel, type PrReview } from './pr-review.ts'

export * from './arch.ts'
export * from './canvases.ts'
export * from './diagram.ts'
export * from './diagram-rules.ts'
export * from './inventory.ts'
export * from './sets.ts'
export * from './playbook.ts'
export * from './pr-review.ts'

/** review: a review of a teammate's PR (see PrReview); no steps, only in the Reviews tab. */
export type TaskType = 'dev' | 'design' | 'spike' | 'research' | 'review'

/**
 * The state of a work (T-55.7): its agents' progress, not a status for a team. planning (the owner gathers, states the
 * problem, plans) → ready (plan approved) → in_progress (steps, PRs, reviews) → done; canceled before done. A done work
 * goes back to planning when more is needed (see canReopen). No backlog, priority or archive: what nobody works on yet
 * is an idea, priority lives in the tracker. An open PR is a badge on an in_progress work, not a state. Steps use
 * SubtaskStatus.
 */
export type WorkState = 'planning' | 'ready' | 'in_progress' | 'done' | 'canceled'

/**
 * A step of a task: its own developer session, branch and PR (T-28). Steps run in order, one at a time; the status
 * follows the step's lifecycle. Legacy tasks (see isLegacy) keep their subtasks as a checklist.
 */
export type SubtaskStatus = 'todo' | 'in_progress' | 'done'

export const SUBTASK_STATUSES: SubtaskStatus[] = ['todo', 'in_progress', 'done']

export interface Project {
  id: string
  name: string
  /** Absolute paths of repositories attached to the project. */
  repos: string[]
  /** Free-form notes / links the agents should know about. */
  notes: string
  /** Markdown template per task type that agents follow when writing the task doc. */
  templates: Partial<Record<TaskType, string>>
  /** The project's own playbook sections (T-55.2); missing or null = mag's default (see playbookOf). */
  playbook?: Partial<Playbook> | null
  /** Branch that worktrees start from and PRs target. */
  baseBranch: string
  /** Enforce the core/{lib,clients,services} layering in grooming, development and checks. */
  enforceArchitecture: boolean
  /** Architecture as an agent described it; rendered in the Architecture tab. */
  architecture: ArchDiagram | null
  /** State of the last architect run. */
  archRun: ArchRun | null
  /** Provider and model per agent role; missing roles use DEFAULT_CHOICE (see resolveChoice). */
  agents: Partial<Record<AgentRole, ModelChoice>>
  /** Mode per role and integration id; missing = off (see integrationMode). */
  integrations: Partial<Record<AgentRole, Record<string, IntegrationMode>>>
  /** Hex color from PROJECT_COLORS; missing or null = picked from the id (see projectColor). */
  color?: string | null
  /** The repositories the last Start worked on locally (the Start popup's last choice): its default next time. */
  lastLocalRepos?: string[]
  createdAt: number
}

/**
 * A ticket a work is about (T-55.5): only a link. mag knows no tracker: reading, searching and commenting are the
 * agent's, through whatever the user's environment has (MCP, CLI); what it may write there is the playbook's.
 */
export interface TicketRef {
  /** The ticket's web link. */
  url: string
  /** Its key as the tracker shows it (e.g. ABC-12), when known. */
  key?: string
  /** When an agent last commented in the ticket, if it ever did. */
  commentedAt?: number | null
}

/** A key like ABC-12 (Jira, Linear and the like) in the last segments of a ticket URL. */
const URL_KEY = /(?:^|[/=])([A-Za-z][A-Za-z0-9_]*-\d+)(?=$|[/?#&])/

/**
 * The ticket a link names: any https URL; `key` if given, else one like ABC-12 the URL shows, else none.
 * Throws when the text is not an https link.
 */
export function ticketRef(url: string, key?: string | null): TicketRef {
  const u = url.trim()
  if (!/^https:\/\/[^/?#\s]+\S*$/i.test(u)) throw new Error(`Not a ticket link: ${url || '(empty)'}; pass its https URL`)
  const k = key?.trim() || URL_KEY.exec(u.replace(/^https:\/\/[^/]+/i, ''))?.[1]?.toUpperCase()
  return k ? { url: u, key: k } : { url: u }
}

/** What a ticket shows as: its key, else its link without https://. */
export function ticketLabel(t: TicketRef): string {
  return t.key ?? t.url.replace(/^https:\/\//i, '').replace(/\/+$/, '')
}

/** The work's tickets with `t` added; the same URL (or key) once, the newer one wins. */
export function withTicket(tickets: TicketRef[] | undefined, t: TicketRef): TicketRef[] {
  const same = (x: TicketRef) => x.url === t.url || (!!x.key && x.key === t.key)
  const old = (tickets ?? []).find(same)
  return [...(tickets ?? []).filter((x) => !same(x)), old?.commentedAt ? { ...t, commentedAt: old.commentedAt } : t]
}

/** Project colors, readable on light and dark backgrounds. */
export const PROJECT_COLORS: string[] = ['#e5484d', '#f76b15', '#d6a000', '#30a46c', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#7d7d86']

/** The project's color: its own, or a stable one from PROJECT_COLORS by a hash of its id. */
export function projectColor(p: Pick<Project, 'id' | 'color'>): string {
  if (p.color) return p.color
  let h = 0
  for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PROJECT_COLORS[h % PROJECT_COLORS.length]
}

export interface ArchRun {
  status: 'running' | 'done' | 'error'
  startedAt: number
  /** Last thing the architect said or did, for the progress line. */
  note?: string
  costUsd?: number
}

export type PrState = 'open' | 'merged' | 'closed'

/** One project repository in a task's workspace: its worktree, branch and PR. */
export interface RepoWork {
  /** The project repository (main checkout). */
  repo: string
  branch: string
  worktree: string
  prUrl: string | null
  /** null until the PR has been recorded or checked. */
  prState: PrState | null
  /** An open PR that is a draft; it still counts as open everywhere else. */
  prDraft?: boolean
  /** Last PR check problem, shown on the task; null when the last check worked. */
  checkError?: string | null
  /** Head commit of the open PR at the last check: a new one asks for another agent review (T-55.1). */
  prHead?: string | null
  /** Local mode (T-50): the step works in the repository's main checkout (worktree === repo), on its branch. */
  local?: boolean
  /** Local mode: the user's uncommitted files the step works on top of (their Ignore); never the agent's to commit. */
  foreignFiles?: string[]
  /** CI of the open PR at the last check (see ciState); missing until checked. */
  ci?: CiState
  /** Whether the open PR merges into base at the last check; missing until checked. */
  mergeable?: Mergeable
}

/** CI of a PR: a check failed, one is still running, all passed, or it has none. */
export type CiState = 'pass' | 'fail' | 'pending' | 'none'
export type Mergeable = 'clean' | 'conflict' | 'unknown'

/** A PR's CI from its checks (gh pr checks buckets: pass, fail, pending, skipping, cancel). */
export function ciState(checks: { bucket: string }[]): CiState {
  if (checks.some((c) => c.bucket === 'fail')) return 'fail'
  if (checks.some((c) => c.bucket === 'pending')) return 'pending'
  return checks.length ? 'pass' : 'none'
}

/** A PR problem mag hands back to the step's developer on its own (ux-odna-rozmova-na-robotu.1). */
export type PrProblem = 'ci' | 'conflict'

/** Tries mag made on a step on its own: per PR problem, and continues of a developer that stopped. */
export interface AutoFix {
  ci: number
  conflict: number
  continue: number
}

/** Tries per PR problem before the owner decides (Decision: 2 per problem per step). */
export const AUTO_FIX_TRIES = 2
/** Continues of a developer that stopped without a PR or a question, before the user is asked. */
export const AUTO_CONTINUES = 1

/** A step's tries so far; none before its first. */
export function autoFixOf(step: Pick<Task, 'autoFix'>): AutoFix {
  return step.autoFix ?? { ci: 0, conflict: 0, continue: 0 }
}

/**
 * What mag does about a step's open PRs: the problem to hand to the developer (a failed check first, then a conflict)
 * and the problems that cleared (their tries start over). A pending CI, one without checks or an unknown mergeability
 * neither.
 */
export function prProblems(work: TaskWork): { problem: PrProblem | null; cleared: PrProblem[] } {
  const open = work.repos.filter((r) => r.prUrl && r.prState === 'open')
  const fail = open.some((r) => r.ci === 'fail')
  const conflict = open.some((r) => r.mergeable === 'conflict')
  const cleared: PrProblem[] = []
  // Right after a push a PR may show no checks yet: only a pass proves the CI fixed.
  if (open.every((r) => r.ci === 'pass' || r.ci === 'none') && open.some((r) => r.ci === 'pass')) cleared.push('ci')
  if (open.every((r) => r.mergeable === 'clean')) cleared.push('conflict')
  return { problem: fail ? 'ci' : conflict ? 'conflict' : null, cleared }
}

/** Execution state of a task once a developer agent picks it up. */
export interface TaskWork {
  /** One worktree per project repository, side by side in `dir`. */
  repos: RepoWork[]
  /** Task directory: the developer's cwd. */
  dir: string
  /** PR feedback newer than this triggers a follow-up run. */
  feedbackSeenAt: number
}

/** Last path segment. */
const baseName = (path: string) => path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path

/** Worktree folder name per repository: its base name, made unique within the task ("app", "app-2"). */
export function repoDirNames(repos: string[]): string[] {
  const used = new Set<string>()
  return repos.map((r) => {
    const base = baseName(r)
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`
    used.add(name)
    return name
  })
}

/** Short name of a repo in a task: its worktree folder, or the repository's own name for a pre-T-22 single worktree. */
export function repoWorkName(work: TaskWork, r: RepoWork): string {
  return baseName(r.worktree === work.dir ? r.repo : r.worktree)
}

/** Short names of the project's repositories, in order: their base names, made unique as for worktree folders. */
export function repoNames(project: Pick<Project, 'repos'>): string[] {
  return repoDirNames(project.repos)
}

/** The project repository `ref` names: its short name (see repoNames) or its path. undefined if it is none of them. */
export function projectRepo(project: Pick<Project, 'repos'>, ref: string): string | undefined {
  const r = ref.trim().replace(/[/\\]+$/, '')
  const names = repoNames(project)
  return project.repos.find((p, i) => p.replace(/[/\\]+$/, '') === r || names[i] === r)
}

/**
 * Repositories a step works in (T-50): the ones the groomer gave it, else (older steps) every project repository.
 * Repositories removed from the project since are left out.
 */
export function stepRepos(step: Pick<Task, 'repos'>, project: Pick<Project, 'repos'>): string[] {
  return step.repos ? project.repos.filter((r) => step.repos!.includes(r)) : project.repos
}

/** Short names (see repoNames) of the repositories a step was planned with; undefined for an older step (every repository). */
export function stepRepoNames(step: Pick<Task, 'repos'>, project: Pick<Project, 'repos'>): string[] | undefined {
  if (!step.repos) return undefined
  const names = repoNames(project)
  return project.repos.flatMap((r, i) => (step.repos!.includes(r) ? [names[i]] : []))
}

/** Repositories the Start popup offers (T-50): those of the task's steps that are not done, in project order. */
export function taskRepos(taskId: string, tasks: Task[], project: Pick<Project, 'repos'>): string[] {
  const used = new Set(subtasksOf(taskId, tasks).filter((s) => s.status !== 'done').flatMap((s) => stepRepos(s, project)))
  return project.repos.filter((r) => used.has(r))
}

/**
 * What keeps a step from working in a repository's main checkout (local mode, T-50). busyBy: key of another step
 * working there locally; dirty: uncommitted files; branch: the current branch when it is neither base nor the step's.
 */
export interface LocalCheck {
  repo: string
  busyBy: string | null
  dirty: string[]
  branch: string | null
  /** The user chose Discuss: the developer talks it through with them first; no longer waits for a choice. */
  discuss?: boolean
  /** The last choice failed (e.g. the checkout conflicted with the uncommitted files); the card shows it. */
  error?: string
}

/** The user's answer to a local check. */
export type LocalChoice = 'worktree' | 'wait' | 'stash' | 'ignore' | 'switch' | 'discuss'

/** Answers a local check offers, in the order of its card's buttons. */
export function localOptions(check: LocalCheck): LocalChoice[] {
  if (check.busyBy) return ['worktree', 'wait']
  if (check.dirty.length) return ['stash', 'ignore', 'worktree', 'discuss']
  if (check.branch) return ['switch', 'worktree', 'discuss']
  return []
}

/** One line on what is wrong, for the card, the developer's add_repo error and its Discuss message. */
export function localCheckText(check: LocalCheck, base: string): string {
  const name = baseName(check.repo)
  if (check.busyBy) return `${name} is used locally by ${check.busyBy}`
  const files = check.dirty.length > 5 ? `${check.dirty.slice(0, 5).join(', ')} and ${check.dirty.length - 5} more` : check.dirty.join(', ')
  const branch = check.branch ? `${name} is on branch ${check.branch}, not ${base}` : ''
  if (check.dirty.length) return `${name} has uncommitted changes: ${files}${branch ? `; it is on branch ${check.branch}` : ''}`
  return branch
}

/** Checks of a step still waiting for the user's choice (Discuss settled the others). */
export function openLocalChecks(step: Pick<Task, 'localChecks'>): LocalCheck[] {
  return step.localChecks?.filter((c) => !c.discuss) ?? []
}

/**
 * The step that works in `repo`'s main checkout, if any: not done, of a task not canceled, with the repo local in its
 * work. A step that still waits (for the user's choice on this repo, or for another step) holds nothing yet.
 */
export function localHolder(repo: string, tasks: Task[]): Task | null {
  const parents = new Map(tasks.filter((t) => !t.parentId).map((t) => [t.id, t]))
  return (
    tasks.find(
      (t) =>
        t.parentId &&
        t.status !== 'done' &&
        parents.get(t.parentId)?.status !== 'canceled' &&
        !t.waitingFor &&
        !openLocalChecks(t).some((c) => c.repo === repo) &&
        !!t.work?.repos.some((r) => r.local && r.repo === repo),
    ) ?? null
  )
}

/** The repo work a developer means by `ref`: its short name (see repoWorkName), the repository path or the worktree path. */
export function findRepoWork(work: TaskWork, ref: string): RepoWork | undefined {
  const r = ref.trim().replace(/[/\\]+$/, '')
  return work.repos.find((w) => w.repo === r || w.worktree === r || repoWorkName(work, w) === r)
}

/** Repos of a task that have a PR recorded: its own (legacy) and, with `tasks`, those of its steps in order. */
export function taskPrs(task: Pick<Task, 'id' | 'work'>, tasks: Task[] = []): RepoWork[] {
  return [task, ...subtasksOf(task.id, tasks)].flatMap((t) => t.work?.repos.filter((r) => r.prUrl) ?? [])
}

/** The first PR check problem of a task, if any. */
export function workCheckError(work: TaskWork | null): string | null {
  return work?.repos.find((r) => r.checkError)?.checkError ?? null
}

/**
 * What a task's PRs say about it, or null when they don't decide it. `changed` = repos (by RepoWork.repo) with commits
 * of their own. Every PR merged → done; a PR closed without merge → closed; every changed repo with a live PR →
 * review (the user merges).
 */
export function prRollup(work: TaskWork, changed: string[]): 'done' | 'review' | 'closed' | null {
  const prs = work.repos.filter((r) => r.prUrl)
  if (!prs.length) return null
  if (prs.some((r) => r.prState === 'closed')) return 'closed'
  if (prs.every((r) => r.prState === 'merged')) return 'done'
  const live = new Set(prs.map((r) => r.repo))
  return changed.every((c) => live.has(c)) ? 'review' : null
}

/**
 * Whether a step's (or legacy task's) PRs finish it: there is a PR, every PR is merged and every changed repo has a
 * merged one (the developer may have opened the first PR before finishing the others). `changed` as for prRollup.
 */
export function prsMerged(work: TaskWork, changed: string[]): boolean {
  if (prRollup(work, []) !== 'done') return false
  return changed.every((c) => work.repos.some((r) => r.repo === c && r.prState === 'merged'))
}

export type DevRunOutcome = { kind: 'complete' } | { kind: 'review' } | { kind: 'needsInput'; reason: string }

/**
 * What a finished developer run leaves its step (`step`) or legacy task in: merged PRs (even if merged during the run)
 * complete it, a PR on every changed repo waits for the user to merge, anything else needs the user.
 */
export function devRunOutcome(work: TaskWork | null, changed: string[], failed: boolean, step: boolean): DevRunOutcome {
  if (work && prsMerged(work, changed)) return { kind: 'complete' }
  if (failed) return { kind: 'needsInput', reason: 'Developer agent failed; check the chat' }
  if (!work?.repos.some((r) => r.prUrl))
    return { kind: 'needsInput', reason: step ? 'Developer stopped without opening a PR or completing the step' : 'Developer stopped without opening a PR' }
  if (prRollup(work, changed) === 'review') return { kind: 'review' }
  const missing = work.repos.filter((r) => changed.includes(r.repo) && (!r.prUrl || r.prState === 'closed'))
  return {
    kind: 'needsInput',
    reason: missing.length ? `Developer stopped without a PR for ${missing.map((r) => repoWorkName(work, r)).join(', ')}` : 'Developer stopped without opening a PR',
  }
}

/** PRs of a task that are open: the "PR open" badge. With `tasks`, its steps' PRs count too. */
export function openPrs(task: Pick<Task, 'id' | 'work'>, tasks: Task[] = []): RepoWork[] {
  return taskPrs(task, tasks).filter((r) => r.prState === 'open')
}

/** A task started before T-28: it has work of its own and finishes the old way, its subtasks a checklist. */
export function isLegacy(task: Pick<Task, 'parentId' | 'work'>): boolean {
  return !task.parentId && !!task.work
}

/** The step a task is on: its first step that is not done. null when every step is done or it has none. */
export function currentStep(taskId: string, tasks: Task[]): Task | null {
  return subtasksOf(taskId, tasks).find((s) => s.status !== 'done') ?? null
}

/** Whether a work's plan can be approved (planning → ready): it needs a step, and one not done yet (a reopened work, see canReopen). */
export function canApprove(task: Task, tasks: Task[]): { ok: boolean; reason?: string } {
  if (task.parentId) return { ok: false, reason: 'A step has no status of its own' }
  const steps = subtasksOf(task.id, tasks)
  if (!steps.length) return { ok: false, reason: 'Add at least one step' }
  return steps.some((s) => s.status !== 'done') ? { ok: true } : { ok: false, reason: 'Every step is done: add a step for what is left' }
}

/**
 * Whether a finished work can be continued (T-55.6): a done top-level work goes back to planning, where its owner adds
 * steps; its done steps stay. A legacy task (no steps) and a canceled one cannot.
 */
export function canReopen(task: Task): boolean {
  return !task.parentId && task.status === 'done' && !isLegacy(task)
}

/**
 * Something worth doing that nobody works on yet (T-55.6): the user's note or an agent's finding outside its scope. No
 * status, priority or key: what has a state is a work. Starting a work from it takes it off the list.
 */
export interface Idea {
  id: string
  projectId: string
  text: string
  createdAt: number
  /** Where it came from: the key of the work or step whose agent found it; missing for the user's own and a chat's. */
  source?: string | null
  /** The project topic that discusses it, created when the user first writes there: a link to a talk, not a state. */
  topicId?: string | null
}

/** The project's ideas, newest first; `ideas` are in the order they were added, which breaks ties. */
export function projectIdeas(ideas: Idea[], projectId: string): Idea[] {
  return ideas.filter((i) => i.projectId === projectId).reverse().sort((a, b) => b.createdAt - a.createdAt)
}

/** An idea's text as stored: trimmed; throws when empty. */
export function ideaText(text: string): string {
  const t = text.trim()
  if (!t) throw new Error('An idea needs a text')
  return t
}

const IDEA_TITLE_MAX = 100

/** An idea's line in the list: its first non-empty line, cut at IDEA_TITLE_MAX characters. */
export function ideaTitle(idea: Pick<Idea, 'text'>): string {
  const line = idea.text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > IDEA_TITLE_MAX ? `${line.slice(0, IDEA_TITLE_MAX - 1).trimEnd()}…` : line
}

/**
 * The message that starts a work from an idea: the topic gets it and owns the work from the problem on. `discussed`:
 * the idea's own topic, where it was talked over; else a new topic and the idea is its first message.
 */
export function ideaPrompt(idea: Pick<Idea, 'text' | 'source'>, discussed = false): string {
  const found = idea.source ? ` (found in ${idea.source})` : ''
  return `Let's start a work from ${discussed ? 'the idea we discussed here' : 'this idea'}${found}:\n\n${idea.text}\n\nCheck list_tasks for a work about the same problem first (a done one is continued with reopen_work), then plan it with me as the playbook says.`
}

/** What the agent of an idea's topic knows about it: the idea as it was when the topic started. */
export function ideaContext(idea: Pick<Idea, 'text' | 'source'>): string {
  return `## The idea this topic discusses\nThe user opened this topic from an idea on the project's list${idea.source ? ` (found in ${idea.source})` : ''}. Discuss it; a work starts from it only when the user asks (create_work here; the idea then leaves the list).\n\n${idea.text}`
}

/** Branch of a step: T-41.3 → mag/t-41-3. */
export function stepBranch(stepKey: string): string {
  return `mag/${stepKey.toLowerCase().replace(/\./g, '-')}`
}

/** Directory of a step's worktrees: <worktrees>/<project>/T-41.3. */
export function stepDir(worktreesDir: string, projectId: string, stepKey: string): string {
  return [worktreesDir.replace(/[/\\]+$/, ''), projectId, stepKey].join('/')
}

/** prRollup of a step's work; null while it has none. */
export function stepRollup(step: Pick<Task, 'work'>, changed: string[]): ReturnType<typeof prRollup> {
  return step.work ? prRollup(step.work, changed) : null
}

/** changes: back to the developer, without the user; merge: ready to merge; look: the user should check something. */
export type ReviewVerdict = 'changes' | 'merge' | 'look'

export const REVIEW_VERDICTS: ReviewVerdict[] = ['changes', 'merge', 'look']

/** A finding of an agent review: of a step's PRs (AgentReview) or of a teammate's PR (PrReview). */
export interface ReviewFinding {
  text: string
  /** file:line, a module or a PR, when it applies. */
  where?: string
  /** How much it matters; missing on findings recorded before levels. */
  level?: FindingLevel
  /** The node of a diagram it is about: canvas:<id>#<node>. */
  node?: string
  /** A teammate's PR: the user picked it for publishing. */
  post?: boolean
}

/** The first review of a step's PRs, by an agent (T-55.1): a fork of the work's owner session, else a fresh reviewer. */
export interface AgentReview {
  verdict: ReviewVerdict
  findings: ReviewFinding[]
  /** Reviews in a row that asked for changes, this one included; 1 after a merge or look. */
  round: number
  /** The PR heads it covered: repository path → head commit. */
  heads: Record<string, string>
  /** By a fork of the owner session, which planned the work; false: a fresh reviewer that only read the doc. */
  withContext: boolean
  at: number
}

/**
 * Plan ↔ fact of a step's PRs at `heads` (T-57.4, T-58): the fact generated from the reviewer's inventory against the
 * plan diagrams (how many plan changes were done as planned, otherwise or not at all, what the fact has outside the
 * plan) and the inventory against the PRs' hunks (diff-iak-inventar-zmin-ai.1); and why the review may not say merge.
 */
export interface StepFact {
  heads: Record<string, string>
  /** Plan ↔ fact by status; unaccounted: code blocks in no unit and not noise; ungrounded: units the hunks do not bear out. */
  counts: { match: number; differs: number; missing: number; unplanned: number; unaccounted: number; ungrounded: number }
  blockers: string[]
  /** The root of the fact set, the diagram with the inventory. */
  canvasId: string | null
  at: number
}

/** Heads of a step's open PRs: repository path → head commit. Open PRs whose head is not known yet are left out. */
export function prHeads(work: TaskWork | null): Record<string, string> {
  return Object.fromEntries((work?.repos ?? []).flatMap((r) => (r.prUrl && r.prState === 'open' && r.prHead ? [[r.repo, r.prHead]] : [])))
}

function sameHeads(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/** Whether the step's PRs at `heads` need an agent review: there are some and the last review did not cover them. */
export function reviewDue(step: Pick<Task, 'review'>, heads: Record<string, string>): boolean {
  return Object.keys(heads).length > 0 && !(step.review && sameHeads(step.review.heads, heads))
}

/** Whether the step's review covers its open PRs as they are now (see prHeads). */
export function reviewCurrent(step: Pick<Task, 'review' | 'work'>): boolean {
  return !!step.review && !reviewDue(step, prHeads(step.work))
}

/** The round of the next review: one more after changes, else a new run of rounds. */
export function nextReviewRound(prev: AgentReview | null | undefined): number {
  return prev?.verdict === 'changes' ? prev.round + 1 : 1
}

/**
 * Where a review goes: changes go to the developer while the rounds last (`maxRounds`, the playbook's reviewRounds);
 * everything else goes to the user.
 */
export function reviewOutcome(review: Pick<AgentReview, 'verdict' | 'round'>, maxRounds = DEFAULT_PLAYBOOK.reviewRounds): 'developer' | 'human' {
  return review.verdict === 'changes' && review.round <= maxRounds ? 'developer' : 'human'
}

/** One line for the user about a review that came to them. */
export function reviewText(review: AgentReview): string {
  const who = review.withContext ? 'Owner' : 'Reviewer'
  const first = review.findings[0]
  const finding = first ? `: ${first.where ? `${first.where} — ` : ''}${first.text}${review.findings.length > 1 ? ` (+${review.findings.length - 1})` : ''}` : ''
  if (review.verdict === 'merge') return `${who} review: can merge${finding}`
  if (review.verdict === 'look') return `${who} review: look${finding}`
  return `${who} review asks for changes${finding}`
}

export interface Task {
  id: string
  projectId: string
  /**
   * Human key, assigned at creation, never changes: a work's is its first ticket's key or a slug of its title (see
   * workKey; T-12 for works before T-55.7), a step's is its work's with its number (ABC-12.3).
   */
  key: string
  parentId: string | null
  title: string
  type: TaskType
  /** Works: their WorkState; steps: their SubtaskStatus. */
  status: WorkState | SubtaskStatus
  /** What the user wrote. The agent-owned document lives separately. Subtasks: the optional one-line note. */
  description: string
  /** Steps: position within their work. Works have no order of their own (priority lives in the tracker). */
  rank: number
  /** Set by an agent when it needs the user; one line shown in "Needs you". */
  needsInput: string | null
  /** Steps: their worktrees, branch and PRs. Top-level tasks: legacy only (started before T-28); new ones keep null. */
  work: TaskWork | null
  /** Steps: the step waits for the user's Start instead of starting when the previous one is done (releases in parts). */
  startManually?: boolean
  /**
   * Steps: the project repositories (paths) the step changes, set by the groomer (T-50); only they get a worktree.
   * Missing = every project repository (steps planned before T-50); [] = a step without code.
   */
  repos?: string[]
  /** Top-level tasks: repositories (paths) its steps work on in the main checkout instead of a worktree (T-50, Start). */
  localRepos?: string[]
  /** Steps: local checks waiting for the user (see LocalCheck); the task needs input while any is open. */
  localChecks?: LocalCheck[]
  /** Steps: the user chose Wait; the step starts once `key` (the step holding `repo` locally) is done or canceled. */
  waitingFor?: { key: string; repo: string } | null
  /** Number of the next subtask key (T-12.<n>). Only grows, so a deleted subtask's number is never reused. */
  nextSubNo: number
  /** Why the user canceled the task, if they said. */
  cancelReason?: string | null
  /** Top-level tasks: the tickets the work is about, as links (T-55.5); [] or missing = none. */
  tickets?: TicketRef[]
  /**
   * Top-level tasks: the session where the work was discussed and planned (the chat topic that created it, or its
   * groomer). Its fork reviews the steps' PRs first (T-55.1). Missing or gone: a fresh reviewer reads the doc.
   */
  ownerSessionId?: string | null
  /**
   * Steps: its developer's question (set_needs_input) waiting for the work's owner, who answers it or asks the user
   * (ahent-vede-robotu-vlasna-pozytsiia.2). Cleared when the developer is told anything.
   */
  ownerQuestion?: string | null
  /** Steps: the owner was in a turn when the question came; it gets it once that turn ends (ux-odna-rozmova-na-robotu.1). */
  ownerQuestionQueued?: boolean
  /** Steps: who raised ownerQuestion: its developer (asks, the default) or mag, with what it could not fix on its own. */
  ownerQuestionFrom?: 'asks' | 'mag'
  /** Steps: tries mag made on its own (CI, conflict, continue); a PR problem's count starts over once it clears. */
  autoFix?: AutoFix
  /** Steps: the latest verdict of the agent review of its PRs (T-55.1). */
  review?: AgentReview | null
  /** Steps: plan ↔ fact of its PRs, computed by mag when they are reviewed (T-57.4). A review: the fact of the PR, without a plan. */
  fact?: StepFact | null
  /** Works of type review: the teammate's PR and what its review found. */
  prReview?: PrReview | null
  createdAt: number
  updatedAt: number
}

/** chat = project-level conversation, not tied to a task. */
export type AgentRole = 'groomer' | 'developer' | 'reviewer' | 'chat' | 'architect'
export type AgentKind = 'claude-code' | 'codex'

/** Which provider runs a role and on which model. */
export interface ModelChoice {
  agent: AgentKind
  /** null = the provider's default model (no flag passed). */
  model: string | null
}

export interface AgentModel {
  id: string
  label: string
}

/** Catalogue entry for one provider. */
export interface AgentInfo {
  id: AgentKind
  displayName: string
  /** The provider's CLI was found on this machine. */
  detected: boolean
  models: AgentModel[]
}

/** Roles the user can configure; reviewer follows developer. */
export const SETTABLE_ROLES: AgentRole[] = ['chat', 'groomer', 'developer', 'architect']

export const DEFAULT_CHOICE: ModelChoice = { agent: 'claude-code', model: null }

export function resolveChoice(project: Pick<Project, 'agents'>, role: AgentRole): ModelChoice {
  const agents = project.agents ?? {}
  return agents[role] ?? (role === 'reviewer' ? agents.developer : undefined) ?? DEFAULT_CHOICE
}

/** off = hidden from the agent, ask = each call waits for the user, auto = allowed. */
export type IntegrationMode = 'off' | 'ask' | 'auto'

/** An MCP server the agent CLI brings along (e.g. a claude.ai connector). */
export interface Integration {
  /** Tool prefix as the CLI sees it: tools are mcp__<id>__<tool>. */
  id: string
  /** Server name the CLI reported, e.g. "claude.ai Cloudflare Developer Platform". */
  name: string
}

/** mag's own MCP server; always allowed, never an integration. */
export const MAG_MCP_ID = 'mag'

export function integrationMode(project: Pick<Project, 'integrations'>, role: AgentRole, id: string): IntegrationMode {
  const all = project.integrations ?? {}
  return (all[role] ?? (role === 'reviewer' ? all.developer : undefined))?.[id] ?? 'off'
}

/** CLI permission rules for the known integrations: server-level `mcp__<id>` per mode. */
export function integrationRules(
  project: Pick<Project, 'integrations'>,
  role: AgentRole,
  known: Integration[],
): { allowed: string[]; disallowed: string[]; ask: string[] } {
  const rules = { allowed: [] as string[], disallowed: [] as string[], ask: [] as string[] }
  for (const i of known) {
    if (i.id === MAG_MCP_ID) continue
    const mode = integrationMode(project, role, i.id)
    rules[mode === 'auto' ? 'allowed' : mode === 'ask' ? 'ask' : 'disallowed'].push(`mcp__${i.id}`)
  }
  return rules
}

/** The integration a tool name (mcp__<id>__<tool>) belongs to, with the bare tool name. */
export function integrationOf(toolName: string, known: Integration[]): { integration: Integration; tool: string } | null {
  // Longest id first, so "a_b" wins over "a" for mcp__a_b__x.
  const sorted = [...known].sort((a, b) => b.id.length - a.id.length)
  const integration = sorted.find((i) => toolName.startsWith(`mcp__${i.id}__`))
  return integration ? { integration, tool: toolName.slice(`mcp__${integration.id}__`.length) } : null
}

export interface Attachment {
  name: string
  /** Absolute path of the app's copy. */
  path: string
  mime: string
}

/** Self-contained HTML an agent drew: mockup, diagram, comparison. Content is stored separately. */
export interface CanvasRef {
  id: string
  title: string
  version: number
}

export type ChatItem =
  | { kind: 'user'; text: string; attachments?: Attachment[]; at: number }
  /**
   * mag's instructions to an agent (a review's job, a review round, a developer's job): the agent gets `text` as its
   * prompt; the chat shows `title` as a card that expands to the text.
   */
  | { kind: 'job'; title: string; text: string; at: number }
  | { kind: 'canvas'; canvas: CanvasRef; at: number }
  | { kind: 'assistant'; text: string; at: number }
  | { kind: 'tool'; id: string; name: string; summary: string; ok?: boolean; at: number }
  | { kind: 'result'; ok: boolean; costUsd?: number; at: number }
  | { kind: 'error'; text: string; at: number }
  /** Service line from mag itself, e.g. "context compacted". */
  | { kind: 'notice'; text: string; at: number }
  /** An integration call in ask mode waiting for (or answered by) the user. id = the CLI's tool_use_id. */
  | { kind: 'approval'; id: string; tool: string; server: string; input: unknown; status: ApprovalStatus; at: number }

/** expired = the run ended before the user answered. */
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired'

export interface AgentSession {
  id: string
  projectId: string
  /** null for project chats. */
  taskId: string | null
  /** Project chats: the first message until a title is generated after the first turn. */
  title?: string
  /** A title generation has run for this chat (whatever its outcome); it runs once. */
  titleGenerated?: boolean
  role: AgentRole
  /** Developer sessions: the step they implement; null for groomers, chats and legacy developers. */
  stepId?: string | null
  agent: AgentKind
  /** The agent's own session id, used to resume. */
  nativeSessionId: string | null
  /**
   * The native session its first run forks; later runs resume the fork. Reviewer: the owner's (T-55.1); a branched
   * topic: its parent topic's.
   */
  forkOf?: string | null
  /** A project topic branched from another one (Branch): that topic's id. */
  branchOf?: string | null
  /** A project topic mag created for a review of a PR: that review's id. A topic that asked for it (review_pr) has none. */
  reviewOf?: string
  /** Model the agent reported when its session started. */
  activeModel?: string
  /** Slash commands and skills the agent reported when its session last started, without the "/". */
  commands?: string[]
  /** running = a turn is going on; a live process (see live) may stay between turns. */
  status: 'running' | 'idle' | 'error'
  /** A long-lived agent process is open for this session (see liveSession). */
  live?: boolean
  /** Background tasks (Monitor, background Bash…) active in the live process. */
  background?: BackgroundTask[]
  items: ChatItem[]
  createdAt: number
  /** When the current (or last) run started. */
  runStartedAt?: number
}

export type EventKind = 'status' | 'needs_input' | 'check_failed' | 'agent_started' | 'agent_failed' | 'architecture' | 'approval' | 'review' | 'chat'

/** One line of the project's activity log. */
export interface ProjectEvent {
  id: string
  projectId: string
  taskId: string | null
  /** Copied in so the line still renders after the task is deleted. */
  taskKey: string | null
  kind: EventKind
  text: string
  at: number
}

export type NewEvent = Omit<ProjectEvent, 'id' | 'at'>

/** A background task in a live agent process. name = the tool that started it, e.g. Monitor. */
export interface BackgroundTask {
  id: string
  name: string
}

/**
 * Sessions that run on a long-lived process (T-40): project chats, groomers and developers on Claude Code. Others
 * (Codex, reviewers) run a process per turn.
 */
export function liveSession(s: Pick<AgentSession, 'role' | 'agent'>): boolean {
  return s.agent === 'claude-code' && (s.role === 'chat' || s.role === 'groomer' || s.role === 'developer')
}

/** "1 background task · Monitor", "3 background tasks · Monitor ×2, Bash". */
export function backgroundLabel(tasks: BackgroundTask[]): string {
  const counts = new Map<string, number>()
  for (const t of tasks) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
  const names = [...counts].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name)).join(', ')
  return `${tasks.length} background ${tasks.length === 1 ? 'task' : 'tasks'} · ${names}`
}

/** Normalized events every agent adapter emits. */
export type AgentEvent =
  | { type: 'session.started'; nativeSessionId: string; model?: string; commands?: string[]; integrations?: Integration[] }
  | { type: 'message'; text: string }
  | { type: 'tool.call'; id: string; name: string; input: unknown }
  | { type: 'tool.result'; id: string; ok: boolean }
  | { type: 'turn.done'; ok: boolean; costUsd?: number; nativeSessionId?: string }
  /** Live process: a turn began without our message (a background task woke the agent). */
  | { type: 'turn.started' }
  /** Live process: the set of active background tasks changed; the full list. */
  | { type: 'background'; tasks: BackgroundTask[] }
  /** We stopped it (interrupt, close, kill): not an error. */
  | { type: 'stopped' }
  | { type: 'context.compacted'; preTokens?: number }
  | { type: 'error'; message: string }
  | { type: 'raw'; payload: unknown }

/**
 * Slash commands offered in a chat's composer. A session that has not run yet borrows the list from the latest
 * session of the same project and agent; with none, only /compact. Codex gets none: its text goes as is.
 */
export function chatCommands(session: Pick<AgentSession, 'projectId' | 'agent' | 'commands'>, sessions: AgentSession[]): string[] {
  if (session.agent === 'codex') return []
  if (session.commands?.length) return session.commands
  const prev = sessions
    .filter((s) => s.projectId === session.projectId && s.agent === session.agent && s.commands?.length)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  return prev?.commands ?? ['compact']
}

/** Prompt for a one-off, tool-less run that names a chat from its first exchange. */
export function titlePrompt(firstMessage: string, reply: string): string {
  const excerpt = `User: ${firstMessage}\n\nAssistant: ${reply}`.slice(0, 2000)
  return `Name this conversation in 3-6 words, in the user's language. Reply with the title only: no quotes, no trailing period.\n\n<conversation>\n${excerpt}\n</conversation>`
}

/** The title from a title run's reply, or null if it doesn't look like one. */
export function cleanTitle(raw: string): string | null {
  const line = raw.trim().split('\n')[0] ?? ''
  const title = line
    .replace(/^(title|назва)\s*:\s*/i, '')
    .replace(/^[\s"'«»“”*#`]+|[\s"'«»“”*`.]+$/g, '')
    .replace(/\s+/g, ' ')
  return title && title.length <= 80 ? title : null
}

/** "opus · $0.48 · 38s" under a turn's last reply; missing parts are left out. */
export function turnMeta(items: ChatItem[], resultIndex: number, model?: string): string {
  const result = items[resultIndex]
  if (result?.kind !== 'result') return ''
  let start: number | undefined
  for (let n = resultIndex - 1; n >= 0 && start === undefined; n--) {
    const i = items[n]
    if (i.kind === 'result') break
    if (i.kind === 'user' || i.kind === 'job') start = i.at
  }
  const secs = start === undefined ? undefined : Math.max(0, Math.round((result.at - start) / 1000))
  const time = secs === undefined ? null : secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
  return [model, result.costUsd != null ? `$${result.costUsd.toFixed(2)}` : null, time].filter(Boolean).join(' · ')
}

/**
 * Indices of assistant replies followed by another assistant reply in the same turn (before the next user or job
 * item, or result). A turn still running counts too: a new reply makes the one before it interim.
 */
export function interimReplies(items: ChatItem[]): Set<number> {
  const interim = new Set<number>()
  let lastReply = -1
  items.forEach((i, n) => {
    if (i.kind === 'assistant') {
      if (lastReply >= 0) interim.add(lastReply)
      lastReply = n
    } else if (i.kind === 'user' || i.kind === 'job' || i.kind === 'result') lastReply = -1
  })
  return interim
}

/** States of a work that is over. */
export const FINISHED_STATES: WorkState[] = ['done', 'canceled']

/** A key of the old numbering (before T-55.7): T-12, or T-12.3 for a subtask. No boundaries; wrap it for the context. */
export const TASK_KEY_RE = /T-\d+(?:\.\d+)?/

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ё: 'io', ы: 'y', э: 'e', ъ: '',
}

/** Most words of a work key from a title. */
const SLUG_WORDS = 5
const SLUG_MAX = 40

/** A title as a key: ASCII words (Cyrillic transliterated) joined by "-", at most SLUG_WORDS words and SLUG_MAX chars. */
export function titleSlug(title: string): string {
  const ascii = [...title.toLowerCase()].map((c) => CYRILLIC[c] ?? c).join('')
  const words = ascii.split(/[^a-z0-9]+/).filter(Boolean).slice(0, SLUG_WORDS)
  let slug = ''
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w
    if (next.length > SLUG_MAX) break
    slug = next
  }
  return slug || words[0]?.slice(0, SLUG_MAX) || 'work'
}

/**
 * The key of a new work (T-55.7; no T-N of mag's own): its first ticket's key, else a slug of its title. Taken keys
 * (any case) get -2, -3… Only letters, digits, - and _ stay, so a step key (<key>.<n>), its branch and dir stay clean.
 */
export function workKey(title: string, tickets: TicketRef[] | undefined, taken: string[]): string {
  const ticket = tickets?.find((t) => t.key)?.key?.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')
  const want = ticket || titleSlug(title)
  const used = new Set(taken.map((k) => k.toLowerCase()))
  let key = want
  for (let i = 2; used.has(key.toLowerCase()); i++) key = `${want}-${i}`
  return key
}

/** The work or step with this key; keys match in any case. */
export function taskByKey<T extends Pick<Task, 'key'>>(tasks: T[], key: string): T | undefined {
  const k = key.trim().toLowerCase()
  return tasks.find((t) => t.key.toLowerCase() === k)
}

export function subtaskKey(parentKey: string, n: number): string {
  return `${parentKey}.${n}`
}

/** Whole key mentions: not inside T-21, T-2.1, xT-2 or a path (worktrees/T-2); a trailing period ("see T-2.") is not part of the key. */
const KEY_MENTION = new RegExp(`(?<![\\w./-])${TASK_KEY_RE.source}(?![\\w-]|\\.\\d)`, 'g')

/** Replaces key mentions found in `map` (old key -> new key) in one pass. */
export function rewriteKeys(text: string, map: Record<string, string>): string {
  if (!Object.keys(map).length) return text
  return text.replace(KEY_MENTION, (k) => (Object.hasOwn(map, k) ? map[k] : k))
}

/** Subtasks of a task, in order. */
export function subtasksOf(id: string, tasks: Task[]): Task[] {
  return tasks.filter((t) => t.parentId === id).sort((a, b) => a.rank - b.rank)
}

/** Done and total subtasks of a task: the progress of its plan. */
export function subtaskProgress(id: string, tasks: Task[]): { done: number; total: number } {
  const subs = subtasksOf(id, tasks)
  return { done: subs.filter((s) => s.status === 'done').length, total: subs.length }
}

/**
 * Status changes that set `sub` to `status`: only one step of a task is in progress at a time, so starting one sends
 * the task's other in-progress step back to todo.
 */
export function subtaskStatusChanges(sub: Task, status: SubtaskStatus, tasks: Task[]): { id: string; status: SubtaskStatus }[] {
  const others = sub.parentId && status === 'in_progress'
    ? subtasksOf(sub.parentId, tasks).filter((s) => s.id !== sub.id && s.status === 'in_progress')
    : []
  return [...others.map((s) => ({ id: s.id, status: 'todo' as const })), { id: sub.id, status }]
}

/**
 * Whether a subtask can swap places with its neighbour. A legacy checklist is a plan: any step can move. Steps that
 * started (in progress or done) keep their place; only todo steps swap, with each other.
 */
export function canMoveSubtask(sub: Task, tasks: Task[], dir: 'up' | 'down'): boolean {
  if (!sub.parentId) return false
  const subs = subtasksOf(sub.parentId, tasks)
  const i = subs.findIndex((t) => t.id === sub.id)
  const other = i < 0 ? undefined : subs[dir === 'up' ? i - 1 : i + 1]
  if (!other) return false
  const parent = tasks.find((t) => t.id === sub.parentId)
  return (parent && isLegacy(parent)) || (sub.status === 'todo' && other.status === 'todo')
}

/** A work that is not done or canceled yet can be canceled. */
export function canCancel(task: Task): boolean {
  return !task.parentId && !FINISHED_STATES.includes(task.status as WorkState)
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The Tasks tab: works by state, each in display order. Reviews are not in it: they have the Reviews tab. */
export interface WorkSections {
  /** Oldest first. */
  inProgress: Task[]
  /** Plan approved, waiting for the user's Start; oldest first. */
  ready: Task[]
  /** Oldest first. */
  planning: Task[]
  /** Done and canceled, newest first. */
  finished: Task[]
}

export function workSections(tasks: Task[]): WorkSections {
  const works = tasks.filter((t) => !t.parentId && !isReview(t))
  const by = (state: WorkState) => works.filter((t) => t.status === state).sort((a, b) => a.createdAt - b.createdAt)
  return {
    inProgress: by('in_progress'),
    ready: by('ready'),
    planning: by('planning'),
    finished: works.filter((t) => FINISHED_STATES.includes(t.status as WorkState)).sort((a, b) => b.updatedAt - a.updatedAt),
  }
}

/** Works not finished yet: the Tasks tab count. Reviews count in their own tab. */
export function openWorkCount(tasks: Task[]): number {
  return tasks.filter((t) => !t.parentId && !isReview(t) && !FINISHED_STATES.includes(t.status as WorkState)).length
}

export const STATUS_LABELS: Record<WorkState | SubtaskStatus, string> = {
  planning: 'Planning',
  ready: 'Ready',
  todo: 'Todo',
  in_progress: 'In progress',
  done: 'Done',
  canceled: 'Canceled',
}

/** Events a task update produces: status, PR opened, input request and PR check failure. */
export function taskChangeEvents(prev: Task, next: Task): NewEvent[] {
  const base = { projectId: next.projectId, taskId: next.id, taskKey: next.key }
  const events: NewEvent[] = []
  // A step's status is plan progress, not activity; only a step merged is.
  if (prev.status !== next.status && next.parentId && next.status === 'done' && taskPrs(next).length) events.push({ ...base, kind: 'status', text: 'merged' })
  if (prev.status !== next.status && !next.parentId) {
    const text =
      prev.status === 'done' ? 'Reopened'
      : next.status === 'done' && taskPrs(next).length ? 'merged'
      : next.status === 'canceled' && next.cancelReason ? `Canceled: ${next.cancelReason}`
      : STATUS_LABELS[next.status]
    events.push({ ...base, kind: 'status', text })
  }
  const before = new Set(taskPrs(prev).map((r) => r.prUrl))
  for (const r of openPrs(next)) if (!before.has(r.prUrl)) events.push({ ...base, kind: 'status', text: 'PR opened' })
  if (next.needsInput && next.needsInput !== prev.needsInput) events.push({ ...base, kind: 'needs_input', text: next.needsInput })
  const checkError = workCheckError(next.work)
  if (checkError && checkError !== workCheckError(prev.work)) events.push({ ...base, kind: 'check_failed', text: checkError })
  return events
}

/** The agent indicator of a task: green while an agent runs, yellow while something waits on the user. */
export type AgentState =
  | { kind: 'working'; role: AgentRole; since: number }
  | { kind: 'waiting'; reason: string }
  | null

/** What the current step of a task in progress waits on the user for: its Start, or the merge of its PRs. */
function stepWait(task: Task, tasks: Task[]): { kind: 'start' | 'merge'; step: Task; prs: RepoWork[] } | null {
  if (task.parentId || task.status !== 'in_progress' || isLegacy(task)) return null
  const step = currentStep(task.id, tasks)
  if (!step) return null
  if (step.status === 'todo' && step.startManually) return { kind: 'start', step, prs: [] }
  const prs = openPrs(step)
  return step.status === 'in_progress' && prs.length ? { kind: 'merge', step, prs } : null
}

/**
 * What the task's agent is doing. Waiting wins over working: a pending approval or a question blocks the agent. A
 * task in progress with no agent running waits for the user to merge its open PRs (the current step's, or a legacy
 * task's own) or to Start a step that starts manually.
 */
export function agentState(task: Task, sessions: AgentSession[], tasks: Task[]): AgentState {
  const mine = sessions.filter((s) => s.taskId === task.id)
  const approval = mine.flatMap((s) => s.items).find((i) => i.kind === 'approval' && i.status === 'pending')
  if (approval?.kind === 'approval') return { kind: 'waiting', reason: `Approval: ${approval.server} · ${approval.tool}` }
  if (task.needsInput) return { kind: 'waiting', reason: task.needsInput }
  const running = mine.filter((s) => s.status === 'running').at(-1)
  if (running) return { kind: 'working', role: running.role, since: running.runStartedAt ?? running.createdAt }
  const wait = stepWait(task, tasks)
  const step = task.parentId || isLegacy(task) ? null : currentStep(task.id, tasks)
  if (step?.waitingFor) return { kind: 'waiting', reason: `Waiting for ${step.waitingFor.key} (${baseName(step.waitingFor.repo)})` }
  if (wait?.kind === 'start') return { kind: 'waiting', reason: `${wait.step.key} waits for Start` }
  if (wait && reviewCurrent(wait.step)) return { kind: 'waiting', reason: `${wait.step.key}: ${reviewText(wait.step.review!)}` }
  if (wait) return { kind: 'waiting', reason: `${wait.step.key}: ${wait.prs.length > 1 ? `${wait.prs.length} PRs wait` : 'PR waits'} for merge` }
  // A legacy task's own PRs; new tasks have none.
  const prs = openPrs(task)
  if (task.status === 'in_progress' && prs.length) return { kind: 'waiting', reason: prs.length > 1 ? `${prs.length} PRs wait for merge` : 'PR waits for merge' }
  return null
}

/**
 * review_look: the agent review of the step's PRs wants the user to look (its verdict look, or changes past the rounds).
 * review_ready: the agent's review of a teammate's PR is ready.
 */
export type InboxKind = 'approval' | 'agent_failed' | 'check_failed' | 'question' | 'review_look' | 'ready_to_merge' | 'review_ready' | 'ready_to_start'

export interface InboxItem {
  /** null for an approval in a project chat. */
  task: Task | null
  kind: InboxKind
  text: string
  /** Session the item comes from: the approval's session, or the task's groomer/developer/reviewer that ran last. */
  session?: AgentSession
  /** review_look and ready_to_merge: the agent review of the current step, when it covers its PRs as they are. */
  review?: AgentReview
  /** Approval chat item id in `session`. */
  approvalId?: string
}

const INBOX_ORDER: InboxKind[] = ['approval', 'agent_failed', 'check_failed', 'question', 'review_look', 'ready_to_merge', 'review_ready', 'ready_to_start']

const TASK_AGENTS: AgentRole[] = ['groomer', 'developer', 'reviewer']
const FAILED: Partial<Record<AgentRole, string>> = { groomer: 'Groomer failed', developer: 'Developer failed', reviewer: 'Review failed' }

/** The task's agent session that ran last (a step's reviewer runs again after its developer). */
export function lastTaskSession(taskId: string, sessions: AgentSession[]): AgentSession | undefined {
  const at = (s: AgentSession) => s.runStartedAt ?? s.createdAt
  return sessions.filter((s) => s.taskId === taskId && TASK_AGENTS.includes(s.role)).reduce<AgentSession | undefined>((a, s) => (!a || at(s) >= at(a) ? s : a), undefined)
}

/** One item for a top-level task; its steps' PRs and Start count for it. A finished work waits on nobody. */
function inboxItem(task: Task, tasks: Task[], sessions: AgentSession[]): InboxItem | null {
  if (task.parentId || task.status === 'done' || task.status === 'canceled') return null
  if (isReview(task)) return reviewItem(task, sessions)
  const last = lastTaskSession(task.id, sessions)
  const base = { task, session: last }
  if (last?.status === 'error') return { ...base, kind: 'agent_failed', text: FAILED[last.role] ?? 'Agent failed' }
  const step = isLegacy(task) ? null : currentStep(task.id, tasks)
  const checkError = workCheckError(task.work) ?? workCheckError(step?.work ?? null)
  if (checkError) return { ...base, kind: 'check_failed', text: checkError }
  if (task.needsInput) return { ...base, kind: 'question', text: task.needsInput }
  if (last?.status === 'running') return null
  const wait = stepWait(task, tasks)
  if (wait?.kind === 'start') return { ...base, kind: 'ready_to_start', text: `${wait.step.key} waits for Start` }
  if (wait && reviewCurrent(wait.step)) {
    const review = wait.step.review!
    const text = `${wait.step.key}: ${reviewText(review)}`
    return { ...base, kind: review.verdict === 'merge' ? 'ready_to_merge' : 'review_look', text, review }
  }
  const prs = wait ? wait.prs : openPrs(task)
  const ready = prs.length > 1 ? `${prs.length} PRs are ready to merge` : 'PR is ready to merge'
  if (task.status === 'in_progress' && prs.length) return { ...base, kind: 'ready_to_merge', text: wait ? `${wait.step.key}: ${ready}` : ready }
  return null
}

/** A review of a teammate's PR in progress, by its state: its question, its verdict once ready, or its topic failed. */
function reviewItem(task: Task, sessions: AgentSession[]): InboxItem | null {
  const state = reviewState(task, sessions)
  if (state === 'question') return { task, kind: 'question', text: task.needsInput! }
  if (state === 'ready') return { task, kind: 'review_ready', text: reviewReadyText(task.prReview!) }
  if (state === 'failed') return { task, kind: 'agent_failed', text: 'Review failed', session: sessions.find((s) => s.id === task.ownerSessionId) }
  return null
}

/** One item per pending approval in the project's sessions, task sessions and chats alike. */
function approvalItems(projectId: string, tasks: Task[], sessions: AgentSession[]): InboxItem[] {
  return sessions
    .filter((s) => s.projectId === projectId)
    .flatMap((s) =>
      s.items.flatMap((i): InboxItem[] =>
        i.kind === 'approval' && i.status === 'pending'
          ? [{ task: tasks.find((t) => t.id === s.taskId) ?? null, kind: 'approval', text: `wants ${i.server} · ${i.tool}`, session: s, approvalId: i.id }]
          : [],
      ),
    )
}

/**
 * What waits on the user in a project, most urgent kind first: every pending approval, plus at most one item per
 * task. `tasks` are the project's; sessions may span projects and are in creation order.
 */
export function inbox(projectId: string, tasks: Task[], sessions: AgentSession[]): InboxItem[] {
  return [
    ...approvalItems(projectId, tasks, sessions),
    ...tasks.map((t) => inboxItem(t, tasks, sessions)).filter((i): i is InboxItem => !!i),
  ].sort((a, b) => INBOX_ORDER.indexOf(a.kind) - INBOX_ORDER.indexOf(b.kind))
}

export type ProjectState = 'waiting' | 'in_review' | 'idle'

/** Waiting if something in the project's inbox waits on the user, else in review if a task has an open PR, else idle. */
export function projectState(projectId: string, tasks: Task[], sessions: AgentSession[]): ProjectState {
  const mine = tasks.filter((t) => t.projectId === projectId)
  if (inbox(projectId, mine, sessions).length) return 'waiting'
  if (mine.some((t) => !t.parentId && t.status === 'in_progress' && openPrs(t, mine).length)) return 'in_review'
  return 'idle'
}

/** Inbox items across all projects: the dock badge. */
export function waitingTotal(projects: Pick<Project, 'id'>[], tasks: Task[], sessions: AgentSession[]): number {
  return projects.reduce((n, p) => n + inbox(p.id, tasks.filter((t) => t.projectId === p.id), sessions).length, 0)
}

export type PipelineStage = 'planning' | 'ready' | 'in_progress' | 'done7d'

const WEEK_MS = 7 * DAY_MS

/** Work counts per state; done only counts works finished in the last 7 days; canceled and reviews are not counted. */
export function pipelineCounts(tasks: Task[], now: number): Record<PipelineStage, number> {
  const counts: Record<PipelineStage, number> = { planning: 0, ready: 0, in_progress: 0, done7d: 0 }
  for (const t of tasks) {
    if (t.parentId || isReview(t) || t.status === 'canceled') continue
    if (t.status !== 'done') counts[t.status as Exclude<WorkState, 'done' | 'canceled'>]++
    else if (t.updatedAt >= now - WEEK_MS) counts.done7d++
  }
  return counts
}

/** Agent sessions running now, any role, any project: no limit on how many. */
export function runningAgents(sessions: AgentSession[]): AgentSession[] {
  return sessions.filter((s) => s.status === 'running')
}

export const DEFAULT_TEMPLATES: Record<TaskType, string> = {
  dev: `# Problem
One or two sentences, plus the evidence that it is real.

# Decisions
What the user decided for this work, one per line; they override the project's playbook. A "## <step key>" subsection holds decisions of that step only.

# Open questions
Only if any. Each: the question, your recommendation and why.

# Options
Every sensible way to fix it: idea, cost, the trade-offs that set it apart. An option that changes code links its sketch diagrams: [title](canvas:<id>). Recommendation, then the choice and why the others lost. Omit when there is only one sensible way.

# Changes
## Infra
Only if runtimes, databases, queues or external services change.
## Models
## Clients
New or changed clients and their interfaces (in our terms).
## Services
New or changed service interfaces: method signatures and semantics. This is the core of the design.
## App layer
Hooks, components, pages, handlers, workers that change.

# Architecture
Diff diagrams are recorded with show_diagram; link them here: [title](canvas:<id>).

# Plan
Numbered steps. Each step that changes code says, per repository it changes: what changes there and the diagrams of that change, e.g. "1. <step title> — in <repo>: <what> ([title](canvas:<id>), …)". A step without structural changes in a repo says so in one line.

# Assumptions
`,
  design: `# Problem

# Open questions
Each: the question, your recommendation and why.

# Scope
Screens and states.

# Approach
`,
  spike: `# Question to answer

# Open questions
Each: the question, your recommendation and why.

# Approach

# Findings
`,
  research: `# Question to answer

# Open questions
Each: the question, your recommendation and why.

# Sources

# Findings
`,
  review: `# Problem
What the PR fixes and why it is real, with evidence.

# Open questions
Each: the question, your recommendation and why.

# Approach
Is it the right way to fix it; better alternatives with their trade-offs.

# Findings
`,
}

/** html: a self-contained page (show_canvas); diagram: typed data mag renders itself (show_diagram). */
export type CanvasKind = 'html' | 'diagram'

export interface Canvas {
  id: string
  projectId: string
  taskId: string | null
  sessionId: string | null
  title: string
  kind: CanvasKind
  /** kind 'html'. */
  html?: string
  /** kind 'diagram'. */
  diagram?: Diagram
  /** Where the diagram stands in its work (T-55.3); none for a diagram not placed yet. */
  role?: CanvasRole | null
  /** role 'option': the option it sketches, e.g. "A". */
  option?: string | null
  /** role 'plan' / 'fact': the step it belongs to; none for the fact of a review (it is its work's). */
  stepId?: string | null
  /** role 'plan' / 'fact': the project repository (path) it changes; none when it spans the step. */
  repo?: string | null
  /** role 'fact': the plan diagram it is the fact of (T-55.4). */
  planOf?: string | null
  /** The entry of its set: the level "System" or the top Component diagram (povnyi-diff-nabir-pov-iazanykh.1). */
  root?: boolean
  /** The root of a fact set: the change inventory its Component and Data diagrams are generated from (diff-iak-inventar-zmin-ai.1). */
  inventory?: ChangeInventory
  version: number
  updatedAt: number
}
