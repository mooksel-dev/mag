import { mkdirSync, rmdir, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAG_MCP_ID, canApprove, canCancel, ideaContext, ideaPrompt, ideaTitle, canReopen, cleanTitle, currentStep, devRunOutcome, integrationRules, isLegacy, liveSession, localCheckText, localHolder, localOptions, openLocalChecks, projectRepo, repoDirNames, repoNames, repoWorkName, resolveChoice, stepBranch, stepDir, stepRepos, subtasksOf, titlePrompt, walkArch, nextReviewRound, contextBlocks, docDecisions, playbookOf, reviewDue, reviewOutcome, githubSlug, isReview, parsePrUrl, prRepoName, reviewOf, reviewToPost, PR_VERDICT_LABELS, FINDING_LEVEL_LABELS, type PrRef, type PrReview, type PrVerdict, type AgentEvent, type AgentInfo, type AgentReview, type AgentKind, type AgentRole, type AgentSession, type Attachment, type ChatItem, type LocalCheck, type LocalChoice, type ModelChoice, type Project, type RepoWork, type ReviewFinding, type ReviewVerdict, type Task, type TaskWork, type Playbook } from '@mag/core'
import { adapters, type LiveHandle, type RunHandle, type RunSpec } from '@mag/agents'
import { ARCH_RULES } from '@mag/arch'
import type { Store } from './store'
import type { LocalApi } from './api'
import { formatFiles } from '@mag/diff'
import { AGENT_MARK, changedRepos, checkoutLocal, currentBranch, dirtyFiles, fetchPr, postReview, prInfo, prState, prepareWorktree, removeWorktree, repoInfo, slug, stash, type PrFeedback } from './git.ts'
import { APPROVE_TOOL, MESSAGED_ROLES, type MessagedRole } from './tool-defs.ts'
import { ROUND_HUNKS_CHARS, changes, check, factReport, hunkListing } from './core/services/fact/index.ts'
import { factRecord, localGit, reviewFacts, reviewSource, reviewTarget, stepSet, stepTargets } from './fact.ts'
import { log } from './log.ts'

interface Paths {
  /** Built task-mcp.js next to the main bundle. */
  mcpScript: string
  runsDir: string
  worktreesDir: string
  /** Files the user attached to messages. */
  attachmentsDir: string
  /** mag's own logs and crash reports; the project chat may read them. */
  logsDir: string
}

/** The playbook's stance (ahent-vede-robotu-vlasna-pozytsiia.1): how every role leads and argues. */
const stanceLine = (playbook: Playbook) => `How you lead and argue, by the project's playbook:\n${playbook.stance}`

/** The groomer (T-55.2): mag's frame around the playbook's plan; the diagram grammar lives in show_diagram. */
const groomerPrompt = (playbook: Playbook) => `You are grooming a task in "mag", a task-centric workspace. Your output is the task document, not chat.
You own the work: you plan it, and a fork of you reviews its steps' PRs first.
${stanceLine(playbook)}
Plan it following the project's playbook:
${playbook.plan}
Diagrams of a change go through show_diagram (its description has the rules); link each in the doc as [title](canvas:<id>)
with the id it returns, and revise a diagram by its id. Every diagram gets its place: role option for an option's sketch,
role plan with step and repo for a step's change (place_diagram once the steps exist).
mag enforces: steps (create_subtask, reorder_subtasks) come only after the user has answered you in this chat; you never
approve the plan (the work goes to ready) or cancel it yourself, and you never edit code.
Keep chat replies short, with your position in them; the doc carries the detail.`

const workLines = (work: TaskWork) =>
  work.repos.map((r) => `- ${repoWorkName(work, r)}: ${r.worktree} (${r.local ? "local: the user's main checkout, not a worktree; " : ''}branch ${r.branch}${r.prUrl ? `, PR ${r.prUrl}` : ''})`)

/** Local repositories where the user's uncommitted files stayed (their Ignore, T-50). */
const foreignLines = (work: TaskWork) =>
  work.repos.flatMap((r) =>
    r.foreignFiles?.length
      ? [`\nIn ${repoWorkName(work, r)} these files had the user's uncommitted changes before the step: never stage, commit or revert them: ${r.foreignFiles.join(', ')}.`]
      : [],
  )

/** The developer's first message when the user chose Discuss on local checks (T-50). */
const discussText = (checks: LocalCheck[], base: string) =>
  `${checks.map((c) => `In ${c.repo}: ${localCheckText(c, base)}.`).join('\n')}\nBefore anything else, talk with the user about what to do; don't touch it on your own. The step's branch is not checked out there yet: once you agree, call add_repo for it.`

/** Developer of one step (T-28): mag's frame around the playbook's step section (T-55.2). */
const stepPrompt = (project: Project, task: Task, step: Task, work: TaskWork) => {
  const base = project.baseBranch
  const others = project.repos.filter((r) => !work.repos.some((w) => w.repo === r))
  const repos = work.repos.length
    ? `The step changes these repositories, each on its own branch ${work.repos.some((r) => r.local) ? 'in a git worktree there or (local) right in the main checkout' : 'in its own git worktree there'}:\n${workLines(work).join('\n')}${foreignLines(work).join('')}`
    : 'The plan gives this step no repository to change.'
  const rest = others.length
    ? `\nRead the other project repositories in their main checkout, never change them there: ${others.join(', ')}. To change one, call add_repo(repo) first; it gets a worktree (or the main checkout, if the task works there locally) in this step.`
    : ''
  return `You are a developer agent in "mag". You implement step ${step.key} of ${task.key}: "${step.title}". Restarts and PR feedback of this step come back to this session.
Your cwd and worktrees are for this step only; base is fresh ${base}. ${repos}${rest}
First read get_task (all steps, with status) and get_doc. The doc is the agreed plan. Do only this step. At most one PR per changed repo. Never mix steps.
The target picture is the task's diagrams (get_diagrams); your part is get_diagrams(step: "${step.key}") and what the doc links for your step.
Then work following the project's playbook:
${playbookOf(project).step}
After opening a PR, call set_pr with its URL and the repo. A repo without changes gets no PR. If the step has no code changes, close it with complete_step.
If the plan no longer fits reality, do not rewrite it on your own: call set_needs_input with a one-line reason,
explain it in this chat and stop. The same for a decision you cannot make. The work's owner, who planned it, gets the
question first and answers here or asks the user. When the answer has come here (the owner's or the user's),
update the doc (§Decisions, §Progress and the affected part of the plan) and continue; step titles and notes stay as they are.
Never merge and never push to ${base}: mag blocks both. Anything you post on GitHub starts with "${AGENT_MARK}".
Keep chat replies short.
${stanceLine(playbookOf(project))}`
}

/** Developer of a legacy task (started before T-28): the whole task in one session. */
const developerPrompt = (project: Project, task: Task, work: TaskWork, checklist: boolean) => {
  const repos = workLines(work)
  const base = project.baseBranch
  return `You are a developer agent in "mag". You own task ${task.key} from start to merge: restarts and PR feedback come back to this session.
Your cwd is the task directory. Every project repository has its own git worktree there, on its own branch, based on ${base}:
${repos.join('\n')}
First call get_task and get_doc. The doc is the agreed plan; follow it.${checklist ? '\nget_task lists the subtasks: the plan as a checklist. Call set_subtask_status(key, "in_progress") when you start a step\nand set_subtask_status(key, "done") as soon as it is finished; the user watches them live.' : ''}
Then work following the project's playbook:
${playbookOf(project).step}
After opening a PR, call set_pr with its URL and the repo. One PR per changed repo; a repo without changes gets no PR.
If you need a decision only the user can make, call set_needs_input with a one-line question, say it in chat, and stop.
Never merge and never push to ${base}: mag blocks both. Anything you post on GitHub starts with "${AGENT_MARK}".
Keep chat replies short.
${stanceLine(playbookOf(project))}`
}

const ARCHITECT_PROMPT = `You are the architect agent in "mag". Read the project's code (read-only) and record its
architecture with set_architecture. The project's preferred pattern, use it to classify everything:
- lib: project libraries and utils. - client: one per other runtime (3rd-party API, database, queue, storage,
  OS/process, another app over IPC), hiding the implementation. - service: business logic for one area,
  may combine clients. - app: what sits on top (React components/pages/hooks, HTTP handlers, workers, CLI, entrypoints).
Rules of the pattern: services don't use services; clients don't use clients or services; lib doesn't use clients
or services; nothing below app uses app; app should not use clients directly.
How to work:
1. Find the apps (packages, entrypoints) and the outside runtimes they talk to (databases, 3rd-party APIs, agent
   CLIs, files they keep state in). Skim structure first (Glob), then read the key files.
2. Record a tree of modules. Top level: the apps and the outside runtimes, each with level "system" and a kind
   ("Electron app", "database", "3rd-party API"…). Inside an app: modules with level "module" and a layer, at the
   granularity a human designs at, one per real responsibility, not per file; usually 5-20 per app. A big module gets
   inner modules (children), as deep as it helps. Classify by what the code does, not by folder names; the code may
   not follow the pattern.
3. paths: the code each module owns, folders, files or globs relative to the repository. A file belongs to the most
   specific match: an app gives its folder, its modules their parts of it. Every code file (tests too) must be in
   exactly one module, so cover the whole tree and never give one path to two modules. Outside runtimes have none.
4. For services and clients, write the public interface as short lines "method(args): Result - what it does", one
   method per line with its signature; never several in one line ("get / set", "a, b") and no prose.
5. uses = real dependencies, to any module of the tree (ids are unique in the whole tree), each with calls: the
   methods of the target it calls, one per item, e.g. "groom(taskId)". Point a use at the most specific module. If something
   breaks the rules or mixes layers, say so in concern.
6. get_architecture shows the previous version, if any: start from it. Keep the id of every module that still
   exists, even when it is renamed or moved; diagrams and diffs refer to modules by id. mag also gives a module its
   old id back when it owns the same code under a new one.
7. set_architecture lists the code files no module owns: add them to paths and call it again with the full tree
   until none is left.
Call get_architecture first, then set_architecture with the full picture. Be concise everywhere.`

const chatPrompt = (project: Project, logsDir: string) => `You are the user's partner for project "${project.name}" in "mag",
a workspace that organizes agents' work on problems; tickets live in the user's trackers, mag knows them as links. This
is a free conversation about the project: ideas, product and design decisions, architecture, priorities, reviewing what
agents did. You can read the code (read-only), the web and tickets.
How mag works: a work (a task; one problem, one work) is planned by its owner: the document with the problem, options
with diagrams and the decisions, then steps (subtasks; at least one) -> ready: the user approved the plan; priority lives in the
tracker, not in mag -> in progress: the user starts it with Start, and its steps run one after another.
Each step gets a new developer session from fresh base, its own branch and a worktree per repository it changes, and
at most one PR per changed repository. A developer's question goes to the work's owner first, who answers it or
asks the user with a recommendation. Before the user sees a step's PRs, the owner reviews them in a fork of itself:
changes go back to the developer, merge or look go to the user. A step is done when its PRs are merged (or, without
code, when its developer closes it), and the next one starts on its own unless it is marked start manually (then it
waits for the user's Start) -> done when every step is done. A done work that needs more is continued, never
duplicated: back to planning, its owner adds steps. Any number of works can be in progress in parallel. Any work not
done yet can be canceled. mag has no backlog: the project keeps a list of ideas instead, things worth doing that nobody
works on yet, without status or priority; what has a state is a work.
- You never change code. A change becomes a work, and you own the works you create: create_work (title, the brief,
  tickets: the links it is about, none is fine) and plan it right here with the user, following the playbook's plan
  below: the doc with update_doc, diagrams with show_diagram / place_diagram, steps with create_subtask and the
  other owner tools, each with work: its key. A fork of this topic reviews its PRs later. Check list_tasks first to
  avoid duplicates. start_grooming (a separate groomer, which then owns the work) is only for a work nobody discussed,
  e.g. one the user started from a ticket link.
- The user wants more of a done work ("X is still needed"): reopen_work(key, what) instead of create_work; it is
  back in planning, this topic owns it, and you plan the new steps here as above.
- Something worth doing that is not what you discuss now (an aside, a finding): add_idea, one line. list_tasks shows
  the ideas; when the user starts a work from one, plan it like any other.
- The user asks you to review a teammate's PR (a GitHub PR link, "поревюй <url>"): review_pr(url), then do the job it
  answers with, right here. You own that review: when the user asks for more, revise it and record it again with
  set_pr_review. Nothing you run writes to the PR.
- If the work is fully discussed already, create_work with the complete doc (following the project's doc template),
  plan: true and its steps (at least one): it goes to ready and starts nothing; the user starts it with Start.
- Record outcomes so they outlive this chat: what was decided about a work, once you have weighed it, goes under §Decisions in its doc
  (update_task_doc; it overrides the project's playbook for that work), project-wide conventions in update_notes,
  plan changes in update_task / update_task_doc; add_ticket adds a ticket to a work.
- One answer per turn: make the tool calls first, then reply once at the end. Don't answer before recording and
  again after it; say what you recorded in one line of that final reply.
- cancel_task only after the user has said yes to canceling that work.
- You do what the user's buttons do when the user asks you to: approve_plan, start_work (local_repos when they want
  it local), start_step, restart_review, stop_agent, and message_agent to write to a work's developer, reviewer or
  groomer (it resumes; that is also how you pass on an answer to its question). Only when the user asked for it in this
  conversation ("approve", "start it", "tell the developer…"), never on your own. Never tell the user to press a
  button or paste text into an agent's chat: do it, then say in one line what you did; when it fails, say why.
- For anything visual (UI mockups, flows, comparisons) use show_canvas with one self-contained HTML page; for a
  diagram of a change (component, sequence, state, flowchart, data) use show_diagram. Revise either by id instead of drawing
  a new one. Prefer showing over describing.
- Refer to works by key (a ticket key like ABC-12 or a slug; T-12 for older works) and steps by theirs (ABC-12.3).
- Be concise: short answers, markdown only where it helps. The user hates filler, not disagreement: short never
  means agreeing.
- Bash is for reading only: never change files.
- mag logs and crash reports are in ${logsDir} (main-<date>.log: JSON lines; crashes/<time>-<kind>.json: one per
  crash; crashes/native: minidumps). Read them when the user reports a crash or asks about the latest one.

${stanceLine(playbookOf(project))}

Planning a work you own, by the project's playbook (steps come after the user has picked an option here):
${playbookOf(project).plan}

Tickets, by the project's playbook:
${playbookOf(project).tracker}`

/**
 * The reviewer's message for one round (T-55.1). A fork keeps the system prompt of the session it forks (the owner's),
 * so the whole job is said here, every round.
 */
const reviewPrompt = (project: Project, task: Task, step: Task, work: TaskWork, heads: Record<string, string>, round: number, withContext: boolean, doc: string, fact: string) => {
  const prs = work.repos.filter((r) => heads[r.repo]).map((r) => `- ${repoWorkName(work, r)}: ${r.prUrl} at ${heads[r.repo].slice(0, 12)}, code in ${r.worktree}`)
  const prev = step.review
  const again =
    prev?.verdict === 'changes'
      ? `\nYour last review asked for changes and the developer has pushed since. Check that these were addressed:\n${findingLines(prev.findings)}`
      : ''
  return `Review step ${step.key} of ${task.key}: "${step.title}" (agent review, round ${round}). You are the first reviewer of its PR${prs.length > 1 ? 's' : ''}, before the user:
${prs.join('\n')}
${withContext ? 'You discussed and planned this work with the user earlier in this conversation: check the PRs against what you agreed there and against the doc.' : 'You did not take part in planning: the task doc is the agreed plan.'}${again}
First read get_task, get_doc and get_diagrams(step: "${step.key}") (this step's planned change; the rest of the task's with get_diagrams()) and what the doc links for it. get_pr_changes lists the files the PRs change, each with the module that owns it and its hunks; read the diff itself with gh pr diff or git diff in the worktrees.
${stanceLine(playbookOf(project))}
Then review following the project's playbook:
${playbookOf(project).review}
The fact is yours to write: the change inventory of the PRs with set_inventory, from the hunks below (at most about 40k characters of them: get_pr_changes lists them all, the ones cut here among them); mag generates the fact's Component and Data diagrams from it, and you add scenarios and method logic with show_diagram, without role, where the review needs them. Following the project's playbook:
${playbookOf(project).fact}
mag checks each save: the inventory against the hunks (blocks of changed code in no unit, units their hunks do not bear out), whether the set hangs together, and plan ↔ fact (levels by the playbook). For every critical or high difference, write a finding that says why it is right or what is wrong, or ask for changes; the others as you judge. set_review refuses merge while the threshold says so: then look at most.
${fact}
Call set_review once. verdict: changes = the developer must fix something before the user looks (the findings go to the developer, not to GitHub); merge = ready, nothing the user has to check; look = the user should decide or check something. findings: one per item, with where (file:line, module or PR) when it applies; none for a clean merge.
Read only: change no files, run nothing that writes, never push, comment on GitHub or merge, and leave the doc and the plan as they are. Then reply in one line.

${contextBlocks({ decisions: docDecisions(doc, step.key) })}`
}

const findingLines = (findings: ReviewFinding[]) =>
  findings.map((f) => `- ${f.level ? `[${FINDING_LEVEL_LABELS[f.level]}] ` : ''}${f.where ? `${f.where}: ` : ''}${f.text}`).join('\n')

/**
 * The job of the topic that owns a review of a teammate's PR (reviews-ahent-reviuit-pr-timeitiv.2): said in full every
 * time, a first look or a look again. `files`: the PR's changed files as mag read them; `since`: on a look again at new
 * commits, only what changed after the head reviewed last (reviews-ahent-reviuit-pr-timeitiv.3, Decision 8).
 */
const prReviewPrompt = (project: Project, work: Task, files: string, since: string | null) => {
  const r = work.prReview!
  const pr = r.pr
  const name = prRepoName(project, pr)
  const playbook = playbookOf(project)
  const newer = r.head && r.head !== pr.head
  const sinceDiff = pr.outside ? `gh api -H "Accept: application/vnd.github.diff" repos/${pr.repo}/compare/${r.head}...${pr.head}` : `git diff ${r.head} ${pr.head}`
  const before = r.verdict
    ? `\nYou reviewed it before, at ${r.head?.slice(0, 12)}: ${PR_VERDICT_LABELS[r.verdict]}.${r.findings.length ? ` Your findings then:\n${findingLines(r.findings)}` : ''}\n${
        newer
          ? `New commits since: review only what changed after ${r.head?.slice(0, 12)} (${sinceDiff}) and whether each finding still holds; keep the fact set and revise it where the new commits change it.${since ? `\nChanged since your review (mag):\n${since}` : ''}`
          : 'Look again: whether each finding still holds; keep the fact set and revise it.'
      }`
    : ''
  const where = pr.outside
    ? `Its repository ${pr.repo} is not one of the project's, so mag has no checkout of it: read the PR with gh pr diff ${pr.url}, gh pr view and gh api (read only). Its fact is drawn without the project's architecture: its modules are its folders, as get_pr_changes lists them; say so in the review.`
    : `Its code is in ${pr.repo}, the main checkout: read it there and never change it; mag fetched the PR, so git diff ${pr.base}...${pr.head} works there.`
  return `Review the PR ${pr.url} (${name}#${pr.number} by @${pr.author}, into ${pr.base}, head ${pr.head.slice(0, 12)}): you own its review ${work.key}. ${where}${before}
Pass work: "${work.key}" to show_diagram, place_diagram, get_diagrams, get_pr_changes and set_pr_review.
Review it following the project's playbook:
${playbook.prReview}
The fact: the PR's change inventory (set_inventory, from the hunks get_pr_changes lists), then scenarios and method logic with show_diagram without role where the review needs them, by the project's playbook:
${playbook.fact}
mag forbids writing to GitHub here (gh pr review, comment, merge, close or edit, gh api with a write method, git push): the user publishes what they pick. Run no tests: CI runs them.
Changed files (mag):
${files}
Call set_pr_review once you have the verdict (again whenever the user asks for more and it changes), then reply in a few lines: the verdict and the blockers.`
}

/** What the developer is told when the agent review asks for changes. */
const reviewFeedback = (review: AgentReview, many: boolean) =>
  `The agent review of your PR${many ? 's' : ''} (round ${review.round}) asks for changes:\n${findingLines(review.findings)}\nAddress them: change the code, run tests, push; the review runs again on the new commits. Nothing about them goes to GitHub. If a finding is wrong, say why here and call set_needs_input.`

/** Owners and developers of a work about tickets: the tickets are context; the playbook says what they may do there. */
const ticketLine = (project: Project, task: Task) =>
  task.tickets?.length
    ? `\n\nThe work is about ${task.tickets.length > 1 ? 'these tickets' : 'this ticket'}: ${task.tickets.map((t) => (t.key ? `${t.key} (${t.url})` : t.url)).join(', ')}. Tickets, by the project's playbook:\n${playbookOf(project).tracker}`
    : ''

/** A prompt block after what comes before it; nothing when empty. */
const blocks = (text: string) => (text ? `\n\n${text}` : '')

/** What mag never lets an agent run, whatever its prompt says (T-55.2): a merge, and a push to the base branch. */
const NEVER_MERGE = 'Bash(gh pr merge:*)'

/**
 * What an agent that reviews never runs (reviews-ahent-reviuit-pr-timeitiv.2, Decision 7): anything that writes to a
 * PR on GitHub. A teammate's PR gets only what the user publishes with their button.
 */
const NO_PR_WRITES = [
  NEVER_MERGE,
  'Bash(gh pr review:*)',
  'Bash(gh pr comment:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr ready:*)',
  'Bash(gh pr reopen:*)',
  ...['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'].flatMap((flag) => [`Bash(gh api ${flag} *)`, `Bash(gh api * ${flag} *)`]),
  'Bash(git push:*)',
]
const noPushTo = (base: string) => [`Bash(git push * ${base})`, `Bash(git push * ${base} *)`, `Bash(git push *:${base})`, `Bash(git push *:${base} *)`, `Bash(git push *refs/heads/${base}*)`]

/** An approval may wait for the user for days; the prompt tool call must not time out first. */
const APPROVAL_TOOL_TIMEOUT_MS = String(7 * 24 * 60 * 60 * 1000)

/** A live process with no turn and no background task closes after this; the next message resumes the session. */
const LIVE_IDLE_MS = 10 * 60_000

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.file_path ?? o.path ?? o.pattern ?? o.command ?? o.query ?? o.reason ?? o.title ?? o.url
  return v == null ? '' : String(v).slice(0, 120)
}

export class Orchestrator {
  /** One process per turn. */
  private runs = new Map<string, RunHandle>()
  /** Live processes (see liveSession), kept between turns. */
  private lives = new Map<string, { handle: LiveHandle; agent: AgentKind; model: string | null; closing: boolean }>()
  private idleTimers = new Map<string, NodeJS.Timeout>()
  /** Agent reviews going on, by step: what set_review records (null while the PR heads are fetched). */
  private reviewing = new Map<string, { round: number; heads: Record<string, string>; withContext: boolean; startedAt: number } | null>()
  /** The PR heads each step's review last started on: a failed review is not retried on its own (see review). */
  private reviewTried = new Map<string, string>()

  constructor(
    private store: Store,
    private api: LocalApi,
    private paths: Paths,
  ) {}

  /** A turn is going on. */
  isRunning(sessionId: string) {
    return this.runs.has(sessionId) || (this.lives.has(sessionId) && this.store.data.sessions.find((s) => s.id === sessionId)?.status === 'running')
  }

  /** Provider catalogue for the settings UI. */
  async agents(): Promise<AgentInfo[]> {
    return Promise.all(
      (Object.keys(adapters) as AgentKind[]).map(async (id) => {
        const a = adapters[id]
        const [bin, models] = await Promise.all([a.detect(), a.listModels()])
        return { id, displayName: a.displayName, detected: bin !== null, models }
      }),
    )
  }

  /** Read on every run, so a settings change applies to the next turn. */
  private choice(projectId: string, role: AgentRole): ModelChoice {
    return resolveChoice(this.store.project(projectId), role)
  }

  /** Background run that (re)describes the project's architecture. */
  architect(projectId: string) {
    const project = this.store.project(projectId)
    if (project.archRun?.status === 'running') return
    if (!project.repos[0]) throw new Error('Project has no repository')
    const mcpConfigPath = this.mcpConfig(`arch-${projectId}`, { MAG_PROJECT_ID: projectId })
    const run = { status: 'running' as const, startedAt: Date.now(), note: 'Reading the code…' }
    this.store.updateProject(projectId, { archRun: run })
    log.info('agent', 'architect run started', { project: project.name, agent: this.choice(projectId, 'architect').agent })
    const set = (patch: Partial<NonNullable<Project['archRun']>>) =>
      this.store.updateProject(projectId, { archRun: { ...this.store.project(projectId).archRun!, ...patch } })
    let failed = false
    const c = this.choice(projectId, 'architect')
    const handle = adapters[c.agent].start(
      this.withIntegrations(projectId, 'architect', c.agent, false, {
        cwd: project.repos[0],
        model: c.model ?? undefined,
        addDirs: project.repos.slice(1),
        prompt: 'Describe the architecture of this project. Start with get_architecture.',
        appendSystemPrompt: ARCHITECT_PROMPT + blocks(contextBlocks({ notes: project.notes })),
        mcpConfigPath,
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Skill', 'mcp__mag'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
      }),
      (e) => {
        if (e.type === 'session.started' && e.integrations) this.store.saveIntegrations(e.integrations)
        else if (e.type === 'tool.call') set({ note: `${e.name.replace(/^mcp__mag__/, '')} ${summarize(e.input)}`.trim() })
        else if (e.type === 'message') set({ note: e.text.slice(0, 160) })
        else if (e.type === 'turn.done') set({ costUsd: e.costUsd })
        else if (e.type === 'error') {
          failed = true
          log.warn('agent', `architect run error: ${e.message.slice(0, 300)}`, { project: project.name })
          set({ status: 'error', note: e.message.slice(0, 300) })
        }
      },
    )
    handle.done.then(() => {
      log.info('agent', `architect run ended: ${failed ? 'error' : 'done'}`, { project: project.name })
      if (failed) return
      set({ status: 'done', note: undefined })
      let concerns = 0
      walkArch(this.store.project(projectId).architecture?.modules ?? [], (n) => void (n.concern && concerns++))
      this.store.logEvent({ projectId, taskId: null, taskKey: null, kind: 'architecture', text: `Architecture refreshed · ${concerns} concerns` })
    })
  }

  /** Empty project chat; the first send starts the agent. */
  newChat(projectId: string) {
    this.store.project(projectId)
    return this.store.createSession({ projectId, taskId: null, role: 'chat', agent: this.choice(projectId, 'chat').agent, status: 'idle', title: 'New topic' }).id
  }

  /** The topic that discusses an idea: its own, created the first time and titled after it. */
  discussIdea(ideaId: string) {
    const idea = this.store.idea(ideaId)
    if (idea.topicId && this.store.data.sessions.some((s) => s.id === idea.topicId)) return idea.topicId
    const topic = this.store.session(this.newChat(idea.projectId))
    topic.title = ideaTitle(idea).slice(0, 60)
    topic.titleGenerated = true
    this.store.updateIdea(ideaId, { topicId: topic.id })
    return topic.id
  }

  /**
   * Starts a work from an idea; returns the topic that plans and owns it. A discussed idea starts in its own topic and
   * leaves the list once the work is created there (create_work); one without a discussion in a new topic, at once.
   */
  startIdea(ideaId: string) {
    const idea = this.store.idea(ideaId)
    const topic = idea.topicId ? this.store.data.sessions.find((s) => s.id === idea.topicId) : undefined
    if (topic && this.isRunning(topic.id)) throw new Error('The idea\'s topic is still working; start the work when it is done')
    const sid = topic?.id ?? this.newChat(idea.projectId)
    if (!topic) this.store.deleteIdea(ideaId)
    void this.send(sid, ideaPrompt(idea, !!topic)).catch((e) => log.warn('ideas', 'starting a work from an idea failed', e))
    return sid
  }

  private projectChat(sessionId: string) {
    const session = this.store.session(sessionId)
    if (session.role !== 'chat' || session.taskId) throw new Error(`Session ${sessionId} is not a project topic`)
    return session
  }

  /** The user's title for a topic; the generated title never replaces it. */
  renameChat(sessionId: string, title: string) {
    const session = this.projectChat(sessionId)
    const t = title.replace(/\s+/g, ' ').trim()
    if (!t) throw new Error('A topic needs a title')
    session.title = t
    session.titleGenerated = true
    this.store.changed()
  }

  /** Deletes a topic for good: its turn and live process end first (with their background tasks and approvals). */
  async deleteChat(sessionId: string) {
    const session = this.projectChat(sessionId)
    // The end of the run must not start a title run for a topic that is gone.
    session.titleGenerated = true
    const run = this.runs.get(sessionId)
    run?.kill()
    await Promise.all([run?.done, this.closeLive(sessionId)])
    this.store.deleteSession(sessionId)
    log.info('agent', 'topic deleted', { session: sessionId })
  }

  /** Start (or restart) grooming in a new background session; `message`, if given, is its first message (shown in its chat). */
  groom(taskId: string, message?: string) {
    const task = this.store.task(taskId)
    if (task.parentId) throw new Error(`${task.key} is a subtask; groom its parent task`)
    // A ready work goes back to planning while it is groomed again; started work is past planning.
    if ((task.status !== 'planning' && task.status !== 'ready') || task.work) throw new Error(`${task.key} is ${task.status}; only a work in planning or a ready one not started is groomed`)
    const session = this.newSession(taskId, 'groomer')
    // The groomer discusses the options and plans: it owns the work from now on (T-55.1).
    this.store.updateTask(taskId, { status: 'planning', needsInput: null, ownerSessionId: session.id })
    const intro = `Groom task ${task.key}. Start with get_task.`
    // Shown, not as the user's: the groomer's checkpoint still waits for the user's answer in its chat.
    if (message) session.items.push({ kind: 'notice', text: message, at: Date.now() })
    void this.run(session, message ? `${intro}\n\n${message}` : intro)
  }

  /**
   * Continue a done work (T-55.6): it goes back to planning, its done steps stay, and its owner plans the steps for
   * `what`. `by`: the topic asking (reopen_work); it plans in its own turn and owns the work from now on. Asked from the
   * app, the owner gets `what` in its chat; a work without an owner session gets a groomer.
   */
  reopen(taskId: string, what: string, by?: string): string {
    const task = this.store.task(taskId)
    if (!canReopen(task)) throw new Error(`${task.key} is ${task.status}${task.parentId ? ' (a step)' : isLegacy(task) ? ' (a legacy task)' : ''}; only a done work with steps is continued`)
    const need = what.replace(/\s+/g, ' ').trim()
    if (!need) throw new Error('Say what else is needed')
    this.store.updateTask(taskId, { status: 'planning', needsInput: null, ...(by && { ownerSessionId: by }) })
    log.info('agent', `${task.key} reopened`, { by: by ?? 'app' })
    if (by) return `${task.key} is back in planning and this topic owns it.`
    const owner = this.ownerSession(task)
    const ask = `${task.key} was done, but more is needed: ${need}\nIt is back in planning; its done steps stay as they are. Update the doc (problem, decisions, plan) for what is needed, add the new steps${owner?.role === 'chat' ? ` (pass work: "${task.key}")` : ''} and ask the user to review the plan.`
    if (owner && this.isRunning(owner.id)) {
      this.store.updateTask(taskId, { needsInput: `More needed: ${need}. Its owner is busy: tell it in its chat` })
      return `${task.key} is back in planning; its owner is busy.`
    }
    if (owner) {
      void this.send(owner.id, ask).catch((e) => this.store.updateTask(taskId, { needsInput: `Could not tell its owner: ${(e as Error).message}` }))
      return `${task.key} is back in planning; its owner plans the rest.`
    }
    this.groom(taskId, ask)
    return `${task.key} is back in planning; a groomer plans the rest.`
  }

  /** The user's Approve (the button, or a project chat the user asked): a plan in planning is ready to start. */
  approve(taskId: string) {
    const task = this.store.task(taskId)
    if (task.status !== 'planning') throw new Error(`${task.key} is ${task.status}; only a plan in planning is approved`)
    if (this.store.data.sessions.some((s) => s.taskId === taskId && this.isRunning(s.id))) throw new Error('An agent is still working on this task')
    const ready = canApprove(task, this.store.data.tasks.filter((t) => t.projectId === task.projectId))
    if (!ready.ok) throw new Error(`${task.key} cannot be approved: ${ready.reason}`)
    this.store.updateTask(taskId, { status: 'ready', needsInput: null })
  }

  /**
   * The agent a message to a work or a step goes to (a project chat's message_agent): its session of `role`, else the
   * one that worked last. A work's developer and reviewer are those of its current step (a legacy task's developer is
   * its own); a step's are its own. null when it has none.
   */
  agentOf(taskId: string, role?: MessagedRole): AgentSession | null {
    const task = this.store.task(taskId)
    const step = task.parentId ? task : currentStep(task.id, this.store.data.tasks)
    const workId = task.parentId ?? task.id
    const mine = this.store.data.sessions.filter(
      (s) => s.taskId === workId && MESSAGED_ROLES.includes(s.role as MessagedRole) && (!role || s.role === role) && (task.parentId ? s.stepId === task.id : !s.stepId || s.stepId === step?.id),
    )
    const lastAt = (s: AgentSession) => s.items.at(-1)?.at ?? 0
    // Sessions are in the order they were created: the later of two equally recent wins.
    return mine.reduce<AgentSession | null>((best, s) => (!best || lastAt(s) >= lastAt(best) ? s : best), null)
  }

  /** Stops every agent of a work (its steps' too) or of a step that is in a turn; returns those stopped. */
  async stopAgents(taskId: string): Promise<AgentSession[]> {
    const task = this.store.task(taskId)
    const running = this.store.data.sessions.filter((s) => (task.parentId ? s.stepId === task.id : s.taskId === task.id) && this.isRunning(s.id))
    await Promise.all(running.map((s) => this.stop(s.id)))
    return running
  }

  /** The owner of a work: the topic that created it, or its groomer. */
  private ownerSession(task: Task) {
    return this.store.data.sessions.find((s) => s.id === task.ownerSessionId && (s.taskId === null || s.taskId === task.id))
  }

  /**
   * A step developer's question (its set_needs_input) goes to the work's owner first (ahent-vede-robotu-vlasna-pozytsiia.2):
   * the owner holds the decisions and the context, and answers it with answer_developer or asks the user with its
   * recommendation. false when the owner is busy or gone: the user is asked, as before.
   */
  askOwner(stepId: string, question: string): boolean {
    const step = this.store.task(stepId)
    if (!step.parentId) return false
    const task = this.store.task(step.parentId)
    const owner = this.ownerSession(task)
    if (!owner || this.isRunning(owner.id)) return false
    this.store.updateTask(stepId, { ownerQuestion: question })
    log.info('agent', `${step.key}: the developer asks its owner`, { owner: owner.id })
    const work = owner.role === 'chat' ? `, work: "${task.key}"` : ''
    const decisions = contextBlocks({ decisions: docDecisions(this.store.data.docs[task.id] ?? '', step.key) })
    const ask =
      `The developer of ${step.key} ("${step.title}") asks: ${question}\n` +
      `You own ${task.key}: answer it yourself when the decisions, the doc or what you discussed with the user cover it: answer_developer(step: "${step.key}"${work}, text), with the answer and why. ` +
      `Only when the user has to decide: set_needs_input(${work ? `work: "${task.key}", ` : ''}reason) with the question and your recommendation, and once the user has decided, pass it on with answer_developer.` +
      blocks(decisions)
    void this.send(owner.id, ask).catch((e) => {
      this.store.updateTask(stepId, { ownerQuestion: null })
      this.store.updateTask(task.id, { needsInput: `${question} (could not ask its owner: ${(e as Error).message})` })
    })
    return true
  }

  /** The owner's answer to its step developer's question: the developer's session goes on with it. */
  async answerDeveloper(stepId: string, text: string) {
    const step = this.store.task(stepId)
    const session = this.lastStepSession(stepId)
    if (!step.ownerQuestion || !session) throw new Error(`No question of ${step.key}'s developer is waiting`)
    await this.send(session.id, `The owner of the work answers your question: ${text}`)
  }

  /**
   * An owner's turn ended with a developer's question neither answered nor put to the user: the user gets it, so a step
   * never waits silently.
   */
  private unanswered(owner: AgentSession) {
    for (const step of this.store.data.tasks) {
      if (!step.parentId || !step.ownerQuestion) continue
      const task = this.store.task(step.parentId)
      if (task.ownerSessionId !== owner.id || task.needsInput) continue
      this.store.updateTask(task.id, { needsInput: `${step.key} asks: ${step.ownerQuestion} (its owner did not answer)` })
    }
  }

  /**
   * Start a ready work (the user's Start) or restart one in progress, on its current step: a todo step gets a worktree +
   * branch from fresh base per repository it changes (see stepRepos) and a new developer session; a step in progress
   * resumes its session.
   * `message`, if given, is what the resumed session is told (shown in its chat). Legacy tasks run as one whole.
   * `localRepos` (the Start popup, T-50): repositories the task's steps work on in the main checkout; restarts and later
   * steps keep the task's. Before a step's first session its local repositories are checked (see prepareLocal).
   */
  async develop(taskId: string, message?: string, localRepos?: string[]) {
    const task = this.store.task(taskId)
    if (task.parentId) throw new Error(`${task.key} is a subtask; develop its task`)
    if (task.status !== 'ready' && task.status !== 'in_progress') throw new Error(`${task.key} is ${task.status}; only ready or in progress works are developed`)
    const project = this.store.project(task.projectId)
    if (!project.repos.length) {
      this.store.updateTask(taskId, { needsInput: 'Project has no repository' })
      return
    }
    if (isLegacy(task)) {
      const last = this.lastSession(taskId, 'developer')
      if (last && this.isRunning(last.id)) throw new Error('Developer is still working')
      const dir = task.work?.dir ?? join(this.paths.worktreesDir, project.id, task.key)
      this.store.updateTask(taskId, { status: 'in_progress', needsInput: null, work: this.workFor(task.work, project, dir, `mag/${task.key.toLowerCase()}-${slug(task.title)}`, project.repos) })
      const session = last ?? this.newSession(taskId, 'developer')
      if (!(await this.prepareWorktrees(session))) return
      return this.run(session, `Implement task ${task.key}. Start with get_task and get_doc.`)
    }
    const step = currentStep(taskId, this.store.data.tasks)
    if (!step) throw new Error(`${task.key} has no step to develop; groom it into steps first`)
    const last = this.lastStepSession(step.id)
    if (last && this.isRunning(last.id)) throw new Error('Developer is still working')
    const local = localRepos ? project.repos.filter((r) => localRepos.includes(r)) : (task.localRepos ?? [])
    this.store.updateTask(taskId, { status: 'in_progress', needsInput: null, ...(localRepos && { localRepos: local }) })
    // The user chose Wait: the step starts once the other step lets the repository go (see wakeWaiting).
    if (!last && step.waitingFor && localHolder(step.waitingFor.repo, this.others(step.id))) return
    const dir = step.work?.dir ?? stepDir(this.paths.worktreesDir, project.id, step.key)
    // A restart is told what to do: a question it asked the owner no longer holds the step.
    this.store.updateTask(step.id, { status: 'in_progress', waitingFor: null, ownerQuestion: null, work: this.workFor(step.work, project, dir, stepBranch(step.key), stepRepos(step, project), local) })
    // Once per step, before its first session: a restart leaves the main checkouts as they are.
    const ready = last ? { discuss: [] } : await this.prepareLocal(step.id)
    if (!ready) return
    const session = last ?? this.newSession(taskId, 'developer', step.id)
    if (!(await this.prepareWorktrees(session))) return
    const intro = `Implement step ${step.key} of ${task.key}. Start with get_task and get_doc.`
    const talk = ready.discuss.length ? [intro, discussText(ready.discuss, project.baseBranch)].join('\n\n') : undefined
    const text = [talk, message].filter(Boolean).join('\n\n')
    if (text) session.items.push({ kind: 'user', text, at: Date.now() })
    return this.run(session, text || intro)
  }

  /** Every task but the step: who else may hold a local repository. */
  private others(stepId: string) {
    return this.store.data.tasks.filter((t) => t.id !== stepId)
  }

  /**
   * What keeps the step from working in `repo`'s main checkout (T-50), null if nothing: another step holds it, or it
   * has uncommitted changes or is on a branch other than base, unless it is on the step's branch already.
   */
  async checkLocal(step: Task, repo: string): Promise<LocalCheck | null> {
    const holder = localHolder(repo, this.others(step.id))
    if (holder) return { repo, busyBy: holder.key, dirty: [], branch: null }
    const branch = await currentBranch(repo)
    if (branch === stepBranch(step.key)) return null
    const dirty = await dirtyFiles(repo)
    const other = branch === this.store.project(step.projectId).baseBranch ? null : branch || 'a detached HEAD'
    return dirty.length || other ? { repo, busyBy: null, dirty, branch: other } : null
  }

  /**
   * The local check before a step's first session: every local repository of the step is checked, then (all clear) put
   * on the step's branch. A problem becomes a question to the user (localChecks, see resolveLocal) and the step does not
   * start: null, like a failed checkout. Repositories the user chose to discuss are left as they are and returned.
   */
  private async prepareLocal(stepId: string): Promise<{ discuss: LocalCheck[] } | null> {
    const step = this.store.task(stepId)
    const project = this.store.project(step.projectId)
    const discuss = (step.localChecks ?? []).filter((c) => c.discuss)
    const local = (step.work?.repos ?? []).filter((r) => r.local && project.repos.includes(r.repo) && !discuss.some((c) => c.repo === r.repo))
    const checks: LocalCheck[] = []
    let r: RepoWork | undefined
    try {
      for (r of local) {
        const check = await this.checkLocal(step, r.repo)
        if (check) checks.push(check)
      }
      if (checks.length) {
        this.askLocal(stepId, [...discuss, ...checks])
        return null
      }
      for (r of local) await checkoutLocal(r.repo, project.baseBranch, r.branch)
    } catch (e) {
      log.error('agent', `local checkout for ${step.key} in ${r?.repo} failed`, e)
      this.store.updateTask(step.parentId!, { needsInput: `Could not check out ${r?.branch} in ${r?.repo}: ${(e as Error).message}` })
      return null
    }
    this.store.updateTask(stepId, { localChecks: [] })
    return { discuss }
  }

  /** Records the step's local checks; the task needs the user while any is open. */
  private askLocal(stepId: string, checks: LocalCheck[]) {
    const step = this.store.task(stepId)
    this.store.updateTask(stepId, { localChecks: checks })
    const open = openLocalChecks({ localChecks: checks })
    const names = open.map((c) => repoDirNames([c.repo])[0])
    this.store.updateTask(step.parentId!, { needsInput: open.length ? `${names.join(', ')}: ${open.length > 1 ? 'need' : 'needs'} your choice` : null })
  }

  /**
   * The user's answer to a local check of a step (T-50). worktree: the repository leaves the task's localRepos and gets
   * a worktree (also the way out of Wait); wait: the step starts once the step holding it is done or canceled; stash,
   * ignore (the files stay, off-limits to the agent) and switch: the main checkout goes on the step's branch now, and a
   * failure comes back on the card; discuss: the developer talks it through with the user first. With no question
   * left, the step starts.
   */
  async resolveLocal(stepId: string, repo: string, choice: LocalChoice): Promise<void> {
    const step = this.store.task(stepId)
    if (!step.parentId || step.status !== 'in_progress' || !step.work) throw new Error(`${step.key} is not a step in progress`)
    const task = this.store.task(step.parentId)
    const project = this.store.project(step.projectId)
    const check = openLocalChecks(step).find((c) => c.repo === repo)
    const waiting = step.waitingFor?.repo === repo
    if (!check && !(waiting && choice === 'worktree')) throw new Error(`${step.key} has no question about ${repo}`)
    if (check && !localOptions(check).includes(choice)) throw new Error(`${choice} is not an answer to ${localCheckText(check, project.baseBranch)}`)
    const r = step.work.repos.find((w) => w.repo === repo)
    if (!r) throw new Error(`${step.key} does not work in ${repo}`)
    const repoPatch = (patch: Partial<RepoWork>) => {
      const work = this.store.task(stepId).work!
      return { ...work, repos: work.repos.map((w) => (w.repo === repo ? { ...w, ...patch } : w)) }
    }
    let patch: Partial<Task> = {}
    if (choice === 'worktree') {
      const local = (task.localRepos ?? []).filter((x) => x !== repo)
      this.store.updateTask(task.id, { localRepos: local })
      const work = this.store.task(stepId).work!
      const rest = { ...work, repos: work.repos.filter((w) => w.repo !== repo) }
      patch = { work: this.workFor(rest, project, work.dir, r.branch, [repo], local), ...(waiting && { waitingFor: null }) }
    } else if (choice === 'wait') patch = { waitingFor: { key: check!.busyBy!, repo } }
    else if (choice !== 'discuss') {
      // Another step may have taken the checkout since the card came up.
      const holder = localHolder(repo, this.others(stepId))
      const failed = (c: LocalCheck) => this.askLocal(stepId, (this.store.task(stepId).localChecks ?? []).map((x) => (x.repo === repo ? c : x)))
      if (holder) return failed({ repo, busyBy: holder.key, dirty: [], branch: null })
      try {
        if (choice === 'stash') await stash(repo, `mag: before ${step.key}`)
        await checkoutLocal(repo, project.baseBranch, r.branch)
      } catch (e) {
        log.warn('agent', `${step.key}: ${choice} in ${repo} failed: ${(e as Error).message}`)
        return failed({ ...check!, error: (e as Error).message })
      }
      if (choice === 'ignore') patch = { work: repoPatch({ foreignFiles: check!.dirty }) }
    }
    log.info('agent', `${step.key}: ${choice} for ${repo}`)
    const checks = (this.store.task(stepId).localChecks ?? []).flatMap((c) =>
      c.repo !== repo ? [c] : choice === 'discuss' ? [{ ...c, discuss: true, error: undefined }] : [],
    )
    this.store.updateTask(stepId, patch)
    this.askLocal(stepId, checks)
    const now = this.store.task(stepId)
    if (openLocalChecks(now).length || now.waitingFor) return
    return this.develop(task.id)
  }

  /** Steps that waited for the given steps (done or canceled now) try to start again; a problem is a new question. */
  private wakeWaiting(keys: string[]) {
    for (const s of this.store.data.tasks.filter((t) => t.parentId && t.status !== 'done' && t.waitingFor && keys.includes(t.waitingFor.key))) {
      const task = this.store.task(s.parentId!)
      if (task.status !== 'in_progress') continue
      log.info('agent', `${s.key}: ${s.waitingFor!.key} let ${s.waitingFor!.repo} go`)
      this.develop(task.id).catch((e) => this.store.updateTask(task.id, { needsInput: `Could not start ${s.key}: ${(e as Error).message}` }))
    }
  }

  /** The user's Start on the task's next step (one that starts manually): it runs as develop does. */
  startStep(taskId: string) {
    const task = this.store.task(taskId)
    if (isLegacy(task) || task.status !== 'in_progress') throw new Error(`${task.key} is ${isLegacy(task) ? 'a legacy task' : task.status}; only steps of a task in progress are started`)
    const step = currentStep(taskId, this.store.data.tasks)
    if (step?.status !== 'todo') throw new Error(`${task.key} has no step waiting for Start${step ? `: ${step.key} is in progress` : ''}`)
    return this.develop(taskId)
  }

  /**
   * A step is done (its PRs merged, or closed by its developer without code). Its worktrees go once its developer is
   * not in a turn (else at the turn's end, see afterRun), after its process; the task is done when every step is, and
   * the architecture refreshes.
   */
  async completeStep(stepId: string) {
    const step = this.store.task(stepId)
    if (!step.parentId) throw new Error(`${step.key} is not a step`)
    this.store.updateTask(stepId, { status: 'done' })
    log.info('agent', `${step.key} done`)
    this.wakeWaiting([step.key])
    const sessions = this.store.data.sessions.filter((s) => s.stepId === stepId)
    if (!sessions.some((s) => this.isRunning(s.id))) {
      await Promise.all(sessions.map((s) => this.closeLive(s.id)))
      await this.removeWork(step.work)
    }
    const task = this.store.task(step.parentId)
    if (currentStep(task.id, this.store.data.tasks)) return
    this.store.updateTask(task.id, { status: 'done', needsInput: null })
    // Merged code changes the architecture; refresh it if the project keeps one.
    if (this.store.project(task.projectId).architecture) {
      try {
        this.architect(task.projectId)
      } catch {}
    }
  }

  /** Removes a task's or step's worktrees, then its dir once empty. A main checkout (local) stays as it is, on its branch. */
  private async removeWork(work: TaskWork | null) {
    if (!work) return
    for (const r of work.repos) if (!r.local) await removeWorktree(r.repo, r.worktree)
    rmdir(work.dir, () => {})
  }

  /**
   * A workspace in `dir`: the existing work, plus a worktree on `branch` for every repository of `repos` it does not
   * cover yet; one of `localRepos` works in its main checkout instead (T-50).
   */
  private workFor(prev: TaskWork | null, project: Project, dir: string, branch: string, repos: string[], localRepos: string[] = []): TaskWork {
    // Before T-22 the task dir was the task's only worktree; nothing else fits in there.
    if (prev?.repos.some((r) => r.worktree === prev.dir)) return prev
    const known = prev?.repos ?? []
    const fresh = repos.filter((r) => project.repos.includes(r) && !known.some((w) => w.repo === r))
    const names = repoDirNames([...known.map((w) => w.repo), ...fresh]).slice(known.length)
    const added = fresh.map((repo, i): RepoWork =>
      localRepos.includes(repo)
        ? { repo, branch, worktree: repo, local: true, prUrl: null, prState: null, checkError: null }
        : { repo, branch, worktree: join(dir, names[i]), prUrl: null, prState: null, checkError: null },
    )
    return { repos: [...known, ...added], dir, feedbackSeenAt: prev?.feedbackSeenAt ?? 0 }
  }

  /**
   * The developer's add_repo (T-50): a project repository (by name or path) the plan left out of the step gets a
   * worktree on the step's branch, mid-step, and joins the step's repos. A repository the step has already is prepared
   * again. Throws, recording nothing, if the worktree fails.
   * A repository the task works on locally (T-50) goes on the step's branch in its main checkout instead, unless
   * `worktree` (the user said so); a local check problem comes back as the error, for the developer to ask the user.
   */
  async addRepo(stepId: string, ref: string, worktree = false): Promise<RepoWork> {
    const step = this.store.task(stepId)
    if (!step.parentId || step.status !== 'in_progress' || !step.work) throw new Error(`${step.key} is not a step in progress`)
    const project = this.store.project(step.projectId)
    const repo = projectRepo(project, ref)
    if (!repo) throw new Error(`${ref} is not a repository of the project; one of ${repoNames(project).join(', ')}`)
    const local = worktree ? [] : (this.store.task(step.parentId).localRepos ?? [])
    // worktree: a repository the step had in its main checkout (not set up, e.g. after Discuss) moves to a worktree.
    const kept = (work: TaskWork) => (worktree ? { ...work, repos: work.repos.filter((w) => !(w.repo === repo && w.local)) } : work)
    const planned = (work: TaskWork) => this.workFor(kept(work), project, work.dir, stepBranch(step.key), [repo], local)
    const r = planned(step.work).repos.find((w) => w.repo === repo)
    if (!r) throw new Error(`${step.key} has no room for another worktree`)
    if (!r.local) await prepareWorktree(repo, project.baseBranch, r.branch, r.worktree)
    else {
      // Also a local repository the step has already: after Discuss, it goes on the step's branch once the user agrees.
      const check = await this.checkLocal(step, repo)
      if (check)
        throw new Error(
          `${localCheckText(check, project.baseBranch)}. The task works on it in the main checkout: ask the user what to do (e.g. they commit or stash, or you call add_repo with worktree: true) and don't touch it before they decide.`,
        )
      await checkoutLocal(repo, project.baseBranch, r.branch)
    }
    // The work may have changed during the git calls (a PR recorded); add to what it is now.
    const now = this.store.task(stepId)
    const repos = now.repos && !now.repos.includes(repo) ? [...now.repos, repo] : now.repos
    this.store.updateTask(stepId, { work: planned(now.work ?? step.work), ...(repos !== now.repos && { repos }) })
    log.info('agent', `${step.key}: ${r.local ? 'main checkout' : 'worktree'} added for ${repo}`)
    return r
  }

  /** What a developer session works on: its step, or a legacy session's task. */
  private ownerOf(session: AgentSession): Task {
    return this.store.task(session.stepId ?? session.taskId!)
  }

  /**
   * (Re)creates the dir and every worktree of the session's step (or legacy task) that is missing; false (and the
   * session in error) if one fails. A step without repositories still gets its dir: the developer's cwd.
   */
  private async prepareWorktrees(session: AgentSession): Promise<boolean> {
    const task = this.store.task(session.taskId!)
    const project = this.store.project(task.projectId)
    const work = this.ownerOf(session).work
    for (const r of work?.repos ?? []) {
      // A main checkout (local) is set up once, before the step's first session (see prepareLocal).
      if (r.local || !project.repos.includes(r.repo) || r.prState === 'merged') continue
      try {
        await prepareWorktree(r.repo, project.baseBranch, r.branch, r.worktree)
      } catch (e) {
        log.error('agent', `worktree for ${task.key} in ${r.repo} failed`, e)
        session.items.push({ kind: 'error', text: `Worktree for ${r.repo} failed: ${(e as Error).message}`, at: Date.now() })
        session.status = 'error'
        this.store.updateTask(task.id, { needsInput: 'Could not create the worktree' })
        return false
      }
    }
    // After the worktrees: a pre-T-22 task's dir is its worktree.
    if (work) mkdirSync(work.dir, { recursive: true })
    return true
  }

  /** New comments on any PR of a step (or a legacy task): resume the developer session of that step with them. */
  feedback(ownerId: string, items: (PrFeedback & { repo: string })[]) {
    const owner = this.store.task(ownerId)
    const taskId = owner.parentId ?? owner.id
    const many = new Set(items.map((f) => f.repo)).size > 1 || (owner.work?.repos.filter((r) => r.prUrl).length ?? 0) > 1
    const text =
      `New feedback on your PR${many ? 's' : ''}:\n` +
      items.map((f) => `- ${many ? `[${f.repo}] ` : ''}@${f.author}${f.where ? ` on ${f.where}` : ''}: ${f.body}`).join('\n') +
      `\nAddress it: change the code, run tests, push. Reply on GitHub (starting with ${AGENT_MARK}) only where a comment needs an answer. If something is unclear, set_needs_input.`
    return this.resumeDeveloper(owner, text)
  }

  /** Resumes the developer session of a step (or a legacy task) with `text`; false while it is in a turn or has none. */
  private resumeDeveloper(owner: Task, text: string) {
    const taskId = owner.parentId ?? owner.id
    const session = owner.parentId ? this.lastStepSession(owner.id) : this.lastSession(taskId, 'developer')
    // During a turn the comments wait for the next poll; a live process between turns gets them as a message.
    if (!session || this.isRunning(session.id)) return false
    session.items.push({ kind: 'user', text, at: Date.now() })
    this.store.updateTask(taskId, { status: 'in_progress' })
    void this.run(session, text)
    return true
  }

  /**
   * The agent review of a step's open PRs (T-55.1), before the user sees them: once per set of PR heads (`heads`, else
   * fetched), never while an agent of the step runs. The step's reviewer session goes on from round to round; its first
   * run forks the work's owner session (Claude Code), which discussed and planned the work, else it starts fresh and
   * reads the doc. The verdict comes back through set_review (see setReview); the end of the run routes it. A review
   * that started on the same heads before and gave no verdict runs again only on `retry` (the user's Restart).
   */
  async review(stepId: string, heads?: Record<string, string>, retry = false) {
    const step = this.store.task(stepId)
    if (!step.parentId || step.status !== 'in_progress' || !step.work || step.ownerQuestion) return
    const task = this.store.task(step.parentId)
    if (task.status !== 'in_progress' || task.needsInput) return
    if (this.reviewing.has(stepId) || this.store.data.sessions.some((s) => s.stepId === stepId && this.isRunning(s.id))) return
    // Taken before the first await: the scheduler and the developer's end may both ask.
    this.reviewing.set(stepId, null)
    let now: Record<string, string>
    try {
      now = heads ?? (await this.prHeads(stepId))
    } catch (e) {
      this.reviewing.delete(stepId)
      log.warn('agent', `${step.key}: PR heads for the review failed: ${(e as Error).message}`)
      return
    }
    const fresh = this.store.task(stepId)
    const key = JSON.stringify(now)
    if (!reviewDue(fresh, now) || (!retry && this.reviewTried.get(stepId) === key) || fresh.status !== 'in_progress' || this.store.data.sessions.some((s) => s.stepId === stepId && this.isRunning(s.id))) {
      this.reviewing.delete(stepId)
      return
    }
    let session = this.store.data.sessions.filter((s) => s.stepId === stepId && s.role === 'reviewer').at(-1)
    if (!session) {
      const owner = task.ownerSessionId ? this.store.data.sessions.find((s) => s.id === task.ownerSessionId) : undefined
      session = this.newSession(task.id, 'reviewer', stepId)
      // Only Claude Code forks a session; Codex's resume would write into the owner's own.
      session.forkOf = owner?.agent === 'claude-code' && owner.nativeSessionId ? owner.nativeSessionId : null
    }
    const withContext = !!session.forkOf
    const round = nextReviewRound(fresh.review)
    this.reviewing.set(stepId, { round, heads: now, withContext, startedAt: Date.now() })
    this.reviewTried.set(stepId, key)
    log.info('agent', `${step.key}: agent review round ${round}`, { withContext })
    const fact = await this.factOf(stepId, now).catch((e) => {
      log.warn('agent', `${step.key}: plan ↔ fact failed: ${(e as Error).message}`)
      // Nothing proves the PRs match their plan: merge waits for the user.
      const prev = this.store.task(stepId).fact
      const counts = { match: 0, differs: 0, missing: 0, unplanned: 0, unaccounted: 0, ungrounded: 0 }
      const blockers = [`mag could not compare the PRs with the plan (${(e as Error).message.split('\n')[0]})`]
      this.store.updateTask(stepId, { fact: { heads: now, counts, blockers, canvasId: prev?.canvasId ?? null, at: Date.now() } })
      return `(mag could not compare: ${(e as Error).message.split('\n')[0]}; read the diff and compare it with the plan yourself.)`
    })
    // Canceled while mag compared.
    if (this.store.task(stepId).status !== 'in_progress') {
      this.reviewing.delete(stepId)
      return
    }
    const text = reviewPrompt(this.store.project(task.projectId), task, this.store.task(stepId), fresh.work!, now, round, withContext, this.store.data.docs[task.id] ?? '', fact)
    session.items.push({ kind: 'user', text, at: Date.now() })
    return this.run(session, text)
  }

  /**
   * Plan ↔ fact of a step's PRs at `heads` (T-57.4, T-58), recorded on the step: their changes against the fact set the
   * reviewer writes (its inventory, diff-iak-inventar-zmin-ai.1) and the plan. Returns what the reviewer reads, the hunks
   * to cite among it.
   */
  async factOf(stepId: string, heads: Record<string, string>): Promise<string> {
    const step = this.store.task(stepId)
    const project = this.store.project(step.projectId)
    const canvases = Object.values(this.store.data.canvases)
    const plans = stepSet(canvases, stepId, 'plan')
    const changed = await changes(project, await stepTargets(project, step, heads), localGit, plans)
    const fact = check(project, changed, stepSet(canvases, stepId, 'fact'), plans)
    this.store.updateTask(stepId, { fact: factRecord(fact, heads) })
    // A large PR's hunks go through get_pr_changes: the message carries the first ones.
    return [factReport(fact), hunkListing(changed, ROUND_HUNKS_CHARS)].filter(Boolean).join('\n\n')
  }

  /** The user's Restart of a failed review: the current step's PRs are reviewed again, unless the last review covers them. */
  reviewTask(taskId: string) {
    const step = currentStep(taskId, this.store.data.tasks)
    if (step?.status !== 'in_progress' || !step.work?.repos.some((r) => r.prState === 'open')) throw new Error('No step of this task has an open PR to review')
    return this.review(step.id, undefined, true)
  }

  /** Heads of the step's open PRs from GitHub; recorded on its work too. */
  private async prHeads(stepId: string): Promise<Record<string, string>> {
    const work = this.store.task(stepId).work
    const heads: Record<string, string> = {}
    for (const r of work?.repos ?? []) {
      if (!r.prUrl || r.prState !== 'open') continue
      const pr = await prState(r.prUrl)
      if (pr.state === 'OPEN' && pr.head) heads[r.repo] = pr.head
    }
    const now = this.store.task(stepId).work
    if (now) this.store.updateTask(stepId, { work: { ...now, repos: now.repos.map((r) => (heads[r.repo] ? { ...r, prHead: heads[r.repo] } : r)) } })
    return heads
  }

  /** The reviewer's set_review: records the verdict of the review going on. Where it goes is decided when the run ends. */
  setReview(stepId: string, verdict: ReviewVerdict, findings: ReviewFinding[]): string {
    const pending = this.reviewing.get(stepId)
    const step = this.store.task(stepId)
    if (!pending) throw new Error(`No agent review of ${step.key} is going on`)
    // The threshold for "no need to look at the code" (T-58 Decision 5) is mag's, not the reviewer's; each revision of the fact set records it anew.
    const fact = step.fact
    if (verdict === 'merge' && fact?.blockers.length && JSON.stringify(fact.heads) === JSON.stringify(pending.heads))
      throw new Error(`Not recorded: merge is over the threshold, the user has to look at:\n${fact.blockers.map((b) => `- ${b}`).join('\n')}\nGive look (with these as findings) or changes.`)
    const review: AgentReview = { verdict, findings, round: pending.round, heads: pending.heads, withContext: pending.withContext, at: Date.now() }
    this.store.updateTask(stepId, { review })
    this.store.logEvent({ projectId: step.projectId, taskId: step.parentId, taskKey: step.key, kind: 'review', text: `Agent review: ${verdict}${findings.length ? ` · ${findings.length} finding${findings.length > 1 ? 's' : ''}` : ''}` })
    return reviewOutcome(review, playbookOf(this.store.project(step.projectId)).reviewRounds) === 'developer'
      ? 'Recorded: the findings go to the developer, and you review again once they push. Stop here.'
      : 'Recorded: the user gets your verdict. Stop here.'
  }

  /** The end of a review run: changes go to the developer while the rounds last; a run without a verdict failed. */
  private afterReview(session: AgentSession) {
    const stepId = session.stepId!
    const pending = this.reviewing.get(stepId)
    this.reviewing.delete(stepId)
    const step = this.store.task(stepId)
    // Canceled during the review: nothing to route.
    if (step.status !== 'in_progress') return
    const review = step.review
    if (!pending || !review || review.at < pending.startedAt) {
      if (session.status !== 'error') {
        session.status = 'error'
        session.items.push({ kind: 'error', text: 'Review ended without a verdict (set_review); check the chat', at: Date.now() })
        this.logSessionEvent(session, 'agent_failed', 'reviewer failed')
        this.store.changed()
      }
      return
    }
    if (reviewOutcome(review, playbookOf(this.store.project(step.projectId)).reviewRounds) !== 'developer') return
    const many = (step.work?.repos.filter((r) => r.prUrl).length ?? 0) > 1
    // A developer in a turn (the user talks to it) keeps it; the user sees the verdict instead.
    if (!this.resumeDeveloper(step, reviewFeedback(review, many))) log.info('agent', `${step.key}: review findings not sent, the developer is busy`)
  }

  /**
   * A review of a teammate's PR (reviews-ahent-reviuit-pr-timeitiv.2): the PR of a project repository, by its link. Its
   * work (type review, in progress at once, no steps) is the PR's open one if it has one, else a new one. `by`: the
   * project topic that asks (review_pr); it owns the review and gets the job back to do in its turn. Without it (the
   * Reviews tab) the review's topic does it, a new one titled after the PR when it has none.
   */
  async reviewPr(projectId: string, url: string, by?: string): Promise<{ taskId: string; sessionId: string; job: string }> {
    const project = this.store.project(projectId)
    const info = await prInfo(parsePrUrl(url).url)
    if (info.state !== 'OPEN') throw new Error(`${info.repo}#${info.number} is ${info.state.toLowerCase()}: only an open PR is reviewed`)
    // A repository the project has no checkout of is read from GitHub (reviews-ahent-reviuit-pr-timeitiv.3, Decision 10).
    const repo = await this.repoOfSlug(project, info.repo)
    const tasks = this.store.data.tasks.filter((t) => t.projectId === projectId)
    const pr: PrRef = { url: info.url, repo: repo ?? info.repo, ...(repo ? {} : { outside: true }), number: info.number, author: info.author, base: info.base, head: info.head }
    const name = prRepoName(project, pr)
    const prev = reviewOf(tasks, info.url)
    const owner = by ?? (prev && this.ownerSession(prev)?.id) ?? undefined
    if (owner && !by && this.isRunning(owner)) throw new Error(`The topic of ${prev!.key} is still working; ask it there`)
    const sessionId = owner ?? this.newChat(projectId)
    if (!owner) {
      const topic = this.store.session(sessionId)
      topic.title = `Review ${name}#${info.number}`
      topic.titleGenerated = true
    }
    const fresh: PrReview = { pr, problem: '', approach: '', verdict: null, findings: [], head: null, posted: null, at: null }
    const title = `${name}#${info.number}: ${info.title}`
    const work = prev
      ? (this.store.updateTask(prev.id, { title, status: 'in_progress', needsInput: null, ownerSessionId: sessionId, prReview: { ...(prev.prReview ?? fresh), pr } }), this.store.task(prev.id))
      : this.store.createTask({ projectId, title, type: 'review', description: info.url, status: 'in_progress', ownerSessionId: sessionId })
    if (!prev) this.store.updateTask(work.id, { prReview: fresh })
    log.info('agent', `${work.key}: review of ${info.url} at ${info.head.slice(0, 12)}`, { by: by ? 'topic' : 'app' })
    const { files, since } = await this.prFiles(project, this.store.task(work.id))
    const job = prReviewPrompt(project, this.store.task(work.id), files, since)
    if (!by) await this.send(sessionId, job)
    return { taskId: work.id, sessionId, job }
  }

  /** The user's Review again: the review's PR as it is now gets another look. */
  rereview(workId: string) {
    const work = this.store.task(workId)
    if (!isReview(work) || !work.prReview) throw new Error(`${work.key} is not a review of a PR`)
    return this.reviewPr(work.projectId, work.prReview.pr.url)
  }

  /** The user closes a review: done; Review again brings it back. */
  closeReview(workId: string) {
    const work = this.store.task(workId)
    if (!isReview(work)) throw new Error(`${work.key} is not a review of a PR`)
    this.store.updateTask(workId, { status: 'done', needsInput: null })
  }

  /** The project repository whose GitHub remote is `slug` (owner/repo). */
  private async repoOfSlug(project: Project, slug: string): Promise<string | undefined> {
    for (const r of project.repos) if (githubSlug((await repoInfo(r).catch(() => null))?.origin) === slug.toLowerCase()) return r
    return undefined
  }

  /**
   * The changed files of a review's PR as the topic reads them: fetched into its repository's checkout, or from GitHub
   * outside the project. `since`: with new commits after the head reviewed last, what they changed.
   */
  private async prFiles(project: Project, work: Task): Promise<{ files: string; since: string | null }> {
    const r = work.prReview!
    const pr = r.pr
    const source = reviewSource(work)
    const read = async (since?: string) => {
      const target = await reviewTarget(project, work, undefined, since)
      return formatFiles(target.name, target.base, target.head, (await changes(project, [target], source)).files)
    }
    let files: string
    try {
      if (!pr.outside) await fetchPr(pr.repo, pr.number, pr.base)
      files = await read()
    } catch (e) {
      log.warn('agent', `${work.key}: reading the PR failed: ${(e as Error).message}`)
      return { files: `(mag could not read the PR: ${(e as Error).message.split('\n')[0]}. Read it with gh pr diff; get_pr_changes needs it too.)`, since: null }
    }
    if (!r.head || r.head === pr.head) return { files, since: null }
    // A force push may have dropped the head reviewed last: then the whole PR is the change.
    const since = await read(r.head).catch((e) => (log.warn('agent', `${work.key}: changes since ${r.head!.slice(0, 12)}: ${(e as Error).message}`), null))
    return { files, since }
  }

  /**
   * The fact of a review's PR at its head (get_pr_changes), recorded on the review; no plan to compare
   * (reviews-prybraty-spysok-pr-i.1). Returns what the topic reads: the fact so far and the hunks its inventory cites.
   */
  async reviewFactOf(workId: string): Promise<string> {
    const work = this.store.task(workId)
    const pr = work.prReview?.pr
    if (!isReview(work) || !pr) throw new Error(`${work.key} is not a review of a PR`)
    const project = this.store.project(work.projectId)
    const changed = await changes(project, [await reviewTarget(project, work)], reviewSource(work))
    const fact = check(project, changed, reviewFacts(Object.values(this.store.data.canvases), workId), null)
    this.store.updateTask(workId, { fact: factRecord(fact, { [pr.repo]: pr.head }) })
    return [factReport(fact), hunkListing(changed)].filter(Boolean).join('\n\n')
  }

  /** The topic's set_pr_review: the review of the PR at the head mag gave it. Nothing goes to GitHub. */
  setPrReview(workId: string, r: Pick<PrReview, 'problem' | 'approach' | 'verdict' | 'findings'>): string {
    const work = this.store.task(workId)
    const prev = work.prReview
    if (!isReview(work) || !prev) throw new Error(`${work.key} is not a review of a PR`)
    this.store.updateTask(workId, { prReview: { ...prev, ...r, head: prev.pr.head, at: Date.now() }, needsInput: null })
    const n = r.findings.length
    this.store.logEvent({ projectId: work.projectId, taskId: workId, taskKey: work.key, kind: 'review', text: `PR review: ${PR_VERDICT_LABELS[r.verdict!]}${n ? ` · ${n} finding${n > 1 ? 's' : ''}` : ''}` })
    return 'Recorded: the user sees it in the Reviews tab. Nothing goes to GitHub until they publish the findings they pick.'
  }

  /**
   * The user's Publish (reviews-ahent-reviuit-pr-timeitiv.3, Decision 7): the review goes to the PR on GitHub as theirs,
   * with `verdict` and only the findings at `picks` (indexes into its findings). mag posts it, never an agent. A finding
   * on a line the PR does not change is refused by GitHub as a line comment: then every finding goes in the text.
   */
  async publishReview(workId: string, verdict: PrVerdict, picks: number[]): Promise<string> {
    const work = this.store.task(workId)
    const r = work.prReview
    if (!isReview(work) || !r) throw new Error(`${work.key} is not a review of a PR`)
    if (!r.head) throw new Error(`${work.key} has no review yet`)
    const findings = r.findings.map((f, i) => ({ ...f, post: picks.includes(i) }))
    this.store.updateTask(workId, { prReview: { ...r, findings } })
    let url: string
    try {
      url = await postReview(r.pr.url, r.head, reviewToPost(verdict, findings))
    } catch (e) {
      if (!/\b422\b|line could not be resolved|pull_request_review_thread/i.test((e as Error).message) || !reviewToPost(verdict, findings).comments.length) throw e
      log.info('agent', `${work.key}: line comments refused, publishing them in the text: ${(e as Error).message.split('\n')[0]}`)
      url = await postReview(r.pr.url, r.head, reviewToPost(verdict, findings, false))
    }
    this.store.updateTask(workId, { prReview: { ...this.store.task(workId).prReview!, posted: { at: Date.now(), url } } })
    const n = picks.length
    this.store.logEvent({ projectId: work.projectId, taskId: workId, taskKey: work.key, kind: 'review', text: `Published to GitHub: ${PR_VERDICT_LABELS[verdict]}${n ? ` · ${n} finding${n > 1 ? 's' : ''}` : ''}` })
    log.info('agent', `${work.key}: published ${PR_VERDICT_LABELS[verdict]} with ${n} finding(s) to ${r.pr.url}`)
    return url
  }

  /**
   * The user's Connect repo for a review of a PR outside the project (reviews-ahent-reviuit-pr-timeitiv.3, Decision 10):
   * `dir`, a checkout of its repository, joins the project, and the review looks again with the project's architecture.
   */
  async connectReviewRepo(workId: string, dir: string): Promise<{ sessionId: string }> {
    const work = this.store.task(workId)
    const pr = work.prReview?.pr
    if (!isReview(work) || !pr) throw new Error(`${work.key} is not a review of a PR`)
    if (!pr.outside) throw new Error(`${work.key} already reads its PR from the project's checkout`)
    const origin = githubSlug((await repoInfo(dir).catch(() => null))?.origin)
    if (origin !== pr.repo) throw new Error(`${dir} is not a checkout of ${pr.repo}${origin ? ` (its origin is ${origin})` : ''}`)
    const project = this.store.project(work.projectId)
    if (!project.repos.includes(dir)) this.store.updateProject(project.id, { repos: [...project.repos, dir] })
    log.info('agent', `${work.key}: ${pr.repo} joins ${project.name} at ${dir}`)
    return this.rereview(workId)
  }

  /** A live session takes a message during a turn too: the agent gets it in that turn. */
  async send(sessionId: string, text: string, attachments: Attachment[] = []) {
    const session = this.store.session(sessionId)
    if (this.runs.has(sessionId)) throw new Error('Agent is still working')
    session.items.push({ kind: 'user', text, attachments: attachments.length ? attachments : undefined, at: Date.now() })
    // A topic the user renamed keeps its title.
    if (session.role === 'chat' && !session.titleGenerated && !session.items.some((i, n) => i.kind === 'user' && n < session.items.length - 1))
      session.title = (text || attachments[0]?.name || 'Chat').replace(/\s+/g, ' ').slice(0, 60)
    // A Claude Code slash command goes to the CLI as is; the composer doesn't attach files to one.
    const command = session.agent === 'claude-code' && text.startsWith('/')
    const prompt = attachments.length && !command
      ? `${text}\n\nAttached files (open them with Read):\n${attachments.map((a) => `- ${a.path}`).join('\n')}`
      : text
    if (!session.taskId) {
      this.store.changed()
      return this.run(session, prompt)
    }
    this.store.updateTask(session.taskId, { needsInput: null })
    // Told anything (the owner's answer, or the user's), the developer no longer waits for its owner.
    if (session.role === 'developer' && session.stepId) this.store.updateTask(session.stepId, { ownerQuestion: null })
    // A worktree may have failed earlier or been removed: recreate it before resuming.
    if (session.role === 'developer' && this.ownerOf(session).work && !(await this.prepareWorktrees(session))) return
    return this.run(session, prompt)
  }

  /** Stops the current turn. A live process lives on with its background tasks. */
  async stop(sessionId: string) {
    const live = this.lives.get(sessionId)
    if (live && !live.closing) return live.handle.interrupt()
    this.runs.get(sessionId)?.kill()
  }

  /** Stops one background task of a live process; the agent is not woken. The list updates via a `background` event. */
  async stopBackground(sessionId: string, taskId: string) {
    const live = this.lives.get(sessionId)
    if (!live || live.closing) return
    await live.handle.stopTask(taskId)
    // Stopping a task does not wake the agent: a run that waited only for its background tasks is over now.
    const session = this.store.session(sessionId)
    if (session.status !== 'running' && !session.background?.length) void this.afterRun(session)
  }

  /** On quit: live processes would outlive mag and keep waking for their background tasks. */
  shutdown() {
    for (const id of this.lives.keys()) void this.closeLive(id, 0)
  }

  /**
   * Cancel a task not done yet: stop its agents, close their processes (background tasks too), then remove its
   * worktrees. Branches and open PRs stay as they are.
   */
  async cancel(taskId: string, reason: string | null) {
    const task = this.store.task(taskId)
    if (!canCancel(task)) throw new Error(`${task.key} is ${task.status}; it cannot be canceled`)
    const sessions = this.store.data.sessions.filter((s) => s.taskId === taskId)
    const runs = sessions.flatMap((s) => this.runs.get(s.id) ?? [])
    for (const r of runs) r.kill()
    this.store.updateTask(taskId, { status: 'canceled', cancelReason: reason, needsInput: null })
    log.info('agent', `${task.key} canceled`, { reason })
    await Promise.all([...runs.map((r) => r.done), ...sessions.map((s) => this.closeLive(s.id))])
    const steps = subtasksOf(taskId, this.store.data.tasks)
    this.wakeWaiting(steps.map((s) => s.key))
    for (const t of [task, ...steps]) await this.removeWork(t.work)
  }

  private newSession(taskId: string, role: AgentRole, stepId: string | null = null) {
    const projectId = this.store.task(taskId).projectId
    return this.store.createSession({ projectId, taskId, stepId, role, agent: this.choice(projectId, role).agent, status: 'running' })
  }

  private mcpConfig(name: string, env: Record<string, string>) {
    mkdirSync(this.paths.runsDir, { recursive: true })
    const path = join(this.paths.runsDir, `${name}.mcp.json`)
    const server = { command: process.execPath, args: [this.paths.mcpScript], env: { ELECTRON_RUN_AS_NODE: '1', MAG_API: this.api.url, MAG_TOKEN: this.api.token, ...env } }
    writeFileSync(path, JSON.stringify({ mcpServers: { mag: server } }))
    return path
  }

  /** The task's last session of the role outside steps: groomers, a legacy task's developer. */
  private lastSession(taskId: string, role: AgentRole) {
    return this.store.data.sessions.filter((s) => s.taskId === taskId && s.role === role && !s.stepId).at(-1)
  }

  private lastStepSession(stepId: string) {
    return this.store.data.sessions.filter((s) => s.stepId === stepId && s.role === 'developer').at(-1)
  }

  private spec(session: AgentSession): Omit<RunSpec, 'prompt'> {
    const project = this.store.project(session.projectId)
    const [first = homedir(), ...rest] = project.repos
    const arch = project.enforceArchitecture ? `\n\n${ARCH_RULES}` : ''
    if (session.role === 'chat' || !session.taskId) {
      // A topic opened from an idea discusses it (its text as of the topic's first run).
      const idea = this.store.data.ideas.find((i) => i.topicId === session.id)
      return {
        cwd: first,
        addDirs: [...rest, this.paths.attachmentsDir, this.paths.logsDir],
        appendSystemPrompt: chatPrompt(project, this.paths.logsDir) + arch + blocks(idea ? ideaContext(idea) : '') + blocks(contextBlocks({ notes: project.notes })),
        // Bash reads tickets through CLIs like acli or gh (T-37); read only by the prompt, and never a merge or a push.
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WebSearch', 'WebFetch', 'Skill', 'mcp__mag'],
        // A topic may own a review of a teammate's PR: nothing it runs writes to a PR.
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...NO_PR_WRITES],
      }
    }
    const task = this.store.task(session.taskId)
    const owner = this.ownerOf(session)
    const doc = this.store.data.docs[task.id] ?? ''
    // A snapshot as of the session's first run: a resumed session keeps its first system prompt; get_doc has the rest.
    const context = (stepKey?: string) => blocks(contextBlocks({ decisions: docDecisions(doc, stepKey), notes: project.notes }))
    if (session.role === 'reviewer') {
      const work = owner.work
      return {
        cwd: work?.dir ?? first,
        addDirs: work ? project.repos : rest,
        // A fork keeps the owner's system prompt; this one is for a fresh reviewer. The job and the decisions are in the message.
        appendSystemPrompt: `You are the first reviewer of a step's PRs in "mag", before the user. You never change code.` + arch + blocks(contextBlocks({ notes: project.notes })),
        // Bash for gh pr view / diff and git; read only by the prompt, and never a merge or a push.
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'Skill', 'mcp__mag'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...NO_PR_WRITES],
      }
    }
    if (session.role === 'developer' && owner.work) {
      const work = owner.work
      return {
        cwd: work.dir,
        // Repositories without a worktree (not in the step's repos, or a pre-T-22 task) stay readable from their main
        // checkout; the step works in its local ones there.
        addDirs: [...project.repos.filter((r) => !work.repos.some((w) => w.repo === r && w.worktree !== r)), this.paths.attachmentsDir],
        appendSystemPrompt:
          (owner.parentId ? stepPrompt(project, task, owner, work) : developerPrompt(project, task, work, subtasksOf(task.id, this.store.data.tasks).length > 0)) +
          ticketLine(project, task) +
          (project.enforceArchitecture
            ? `\n\n${ARCH_RULES}\nBefore opening the PR, call check_architecture and fix every violation; mention warnings in the PR body.`
            : '') +
          context(owner.parentId ? owner.key : undefined),
        allowedTools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob', 'LS', 'Bash', 'Skill', 'mcp__mag'],
        disallowedTools: [NEVER_MERGE, ...noPushTo(project.baseBranch)],
      }
    }
    return {
      cwd: first,
      addDirs: [...rest, this.paths.attachmentsDir],
      appendSystemPrompt:
        groomerPrompt(playbookOf(project)) +
        ticketLine(project, task) +
        (project.enforceArchitecture
          ? `\n\n${ARCH_RULES}\nCall get_architecture for the recorded design and check_architecture for rule checks on the code. In the doc, design changes per layer: infra first if it changes, then clients and services with their interfaces (signatures + semantics), then the app layer.`
          : '') +
        context(),
      // The owner reads tickets, docs and the web (T-55.5): Bash read only by the prompt, and never a merge or a push.
      allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WebSearch', 'WebFetch', 'Skill', 'mcp__mag'],
      disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', NEVER_MERGE, 'Bash(git push:*)'],
    }
  }

  /**
   * Claude Code runs: integrations the role has on auto are allowed, off ones disallowed, ask ones go through the
   * approve_tool prompt. Without a chat to ask in (`canAsk` false) ask counts as off. Codex has no integrations.
   */
  private withIntegrations<S extends Omit<RunSpec, 'prompt'>>(projectId: string, role: AgentRole, agent: AgentKind, canAsk: boolean, spec: S): S {
    if (agent !== 'claude-code') return spec
    const known = this.store.data.integrations.filter((i) => i.id !== MAG_MCP_ID)
    const rules = integrationRules(this.store.project(projectId), role, known)
    const ask = canAsk ? rules.ask : []
    return {
      ...spec,
      allowedTools: [...(spec.allowedTools ?? []), ...rules.allowed],
      disallowedTools: [...(spec.disallowedTools ?? []), ...rules.disallowed, ...(canAsk ? [] : rules.ask)],
      ...(ask.length && { permissionPromptTool: APPROVE_TOOL, env: { ...spec.env, MCP_TOOL_TIMEOUT: APPROVAL_TOOL_TIMEOUT_MS } }),
    }
  }

  /** A turn of the session: on its live process (see liveSession), or on a process of its own. */
  private async run(session: AgentSession, prompt: string) {
    // The agent the session runs on next decides; a live process of an agent without them goes first.
    if (liveSession({ role: session.role, agent: this.choice(session.projectId, session.role).agent })) return this.runLive(session, prompt)
    if (this.lives.has(session.id)) await this.closeLive(session.id)
    this.runOnce(session, prompt)
  }

  /** One process for this turn; the run ends when it exits. */
  private runOnce(session: AgentSession, prompt: string) {
    const env: Record<string, string> = { MAG_PROJECT_ID: session.projectId, MAG_SESSION_ID: session.id, MAG_ROLE: session.role }
    if (session.taskId) env.MAG_TASK_ID = session.taskId
    const mcpConfigPath = this.mcpConfig(session.id, env)

    const c = this.choice(session.projectId, session.role)
    if (c.agent !== session.agent) {
      // Native sessions can't move between providers; the next run starts fresh.
      session.agent = c.agent
      session.nativeSessionId = null
    }

    const startedAt = Date.now()
    session.status = 'running'
    session.runStartedAt = startedAt
    this.store.changed()
    this.logSessionEvent(session, 'agent_started', `${session.role} started`)
    const who = { session: session.id, role: session.role, task: session.taskId ? this.store.data.tasks.find((t) => t.id === session.taskId)?.key : undefined, agent: session.agent, model: c.model }
    log.info('agent', `${session.role} run started`, who)

    const onEvent = this.onEvent(session)

    const spec = this.withIntegrations(session.projectId, session.role, session.agent, true, this.spec(session))
    // A reviewer's first run forks the owner session; later runs resume the fork.
    const fork = !session.nativeSessionId && !!session.forkOf && session.agent === 'claude-code'
    const resumeId = session.nativeSessionId ?? (fork ? session.forkOf! : undefined)
    const handle = adapters[session.agent].start(
      { ...spec, prompt, model: c.model ?? undefined, resumeId, forkSession: fork, mcpConfigPath },
      onEvent,
    )
    this.runs.set(session.id, handle)
    handle.done.then(() => {
      this.runs.delete(session.id)
      if (session.status === 'running') session.status = 'idle'
      log.info('agent', `${session.role} run ended: ${session.status}`, { ...who, seconds: Math.round((Date.now() - startedAt) / 1000) })
      if (session.status === 'error') this.logSessionEvent(session, 'agent_failed', `${session.role} failed`)
      void this.afterRun(session)
      this.nameChat(session)
      this.store.changed()
    })
  }

  /** Session state and chat items from agent events, for both kinds of runs. */
  private onEvent(session: AgentSession) {
    const push = (item: ChatItem) => {
      session.items.push(item)
      this.store.changed()
    }
    return (e: AgentEvent) => {
      const at = Date.now()
      switch (e.type) {
        case 'session.started':
          session.nativeSessionId = e.nativeSessionId
          if (e.model) session.activeModel = e.model
          if (e.commands) session.commands = e.commands
          if (e.integrations) this.store.saveIntegrations(e.integrations)
          return this.store.changed()
        case 'message':
          return push({ kind: 'assistant', text: e.text, at })
        case 'tool.call':
          return push({ kind: 'tool', id: e.id, name: e.name.replace(/^mcp__mag__/, 'mag.'), summary: summarize(e.input), at })
        case 'tool.result': {
          const item = session.items.find((i) => i.kind === 'tool' && i.id === e.id)
          if (item && item.kind === 'tool') item.ok = e.ok
          return this.store.changed()
        }
        case 'context.compacted':
          return push({ kind: 'notice', text: `Context compacted${e.preTokens ? ` (was ≈${Math.round(e.preTokens / 1000)}k tokens)` : ''}`, at })
        case 'turn.done':
          if (e.nativeSessionId) session.nativeSessionId = e.nativeSessionId
          return push({ kind: 'result', ok: e.ok, costUsd: e.costUsd, at })
        case 'error':
          session.status = 'error'
          log.warn('agent', `${session.role} run error: ${e.message.slice(0, 300)}`, { session: session.id })
          return push({ kind: 'error', text: e.message, at })
        case 'stopped':
          return push({ kind: 'notice', text: 'Stopped', at })
      }
    }
  }

  /**
   * A live session's message (T-40): opens the process if there is none (resuming the agent's session) and writes the
   * message to it. During a turn the message joins that turn. The turn ends at its result, not at the process exit.
   */
  private async runLive(session: AgentSession, prompt: string) {
    this.clearIdle(session.id)
    const c = this.choice(session.projectId, session.role)
    let live = this.lives.get(session.id)
    // A new session is created running before its first turn: only a live process can be in a turn.
    const inTurn = !!live && !live.closing && session.status === 'running'
    // A new model or agent applies between turns. One process at a time per native session: a closing one goes first.
    if (live && !inTurn && (live.agent !== c.agent || live.model !== c.model)) void this.closeLive(session.id)
    if (live?.closing) {
      await live.handle.done
      live = this.lives.get(session.id)
    }
    if (!live) live = this.openLive(session, c)
    if (!inTurn) this.turnStarted(session, true)
    live.handle.send(prompt)
  }

  private openLive(session: AgentSession, c: ModelChoice) {
    const adapter = adapters[c.agent]
    if (!adapter.open) throw new Error(`${adapter.displayName} has no live sessions`)
    if (c.agent !== session.agent) {
      session.agent = c.agent
      session.nativeSessionId = null
    }
    const env: Record<string, string> = { MAG_PROJECT_ID: session.projectId, MAG_SESSION_ID: session.id, MAG_ROLE: session.role }
    if (session.taskId) env.MAG_TASK_ID = session.taskId
    const mcpConfigPath = this.mcpConfig(session.id, env)
    const spec = this.withIntegrations(session.projectId, session.role, session.agent, true, this.spec(session))
    const who = { session: session.id, role: session.role, agent: session.agent, model: c.model }
    const openedAt = Date.now()
    log.info('agent', `${session.role} live process opened`, { ...who, resume: !!session.nativeSessionId })

    const onEvent = this.onEvent(session)
    const handle = adapter.open({ ...spec, model: c.model ?? undefined, resumeId: session.nativeSessionId ?? undefined, mcpConfigPath }, (e) => {
      if (e.type === 'stopped' && session.status !== 'running') return // an idle close says nothing in the chat
      onEvent(e)
      if (e.type === 'turn.started') this.turnStarted(session)
      else if (e.type === 'background') {
        session.background = e.tasks
        if (e.tasks.length) this.clearIdle(session.id)
        else this.armIdle(session)
        this.store.changed()
      } else if (e.type === 'turn.done') this.turnEnded(session)
    })
    const live = { handle, agent: c.agent, model: c.model, closing: false }
    this.lives.set(session.id, live)
    session.live = true
    this.store.changed()
    handle.done.then(() => {
      if (this.lives.get(session.id) === live) this.lives.delete(session.id)
      this.clearIdle(session.id)
      session.live = false
      const waited = !!session.background?.length
      if (waited) session.items.push({ kind: 'notice', text: 'Background tasks ended with the process', at: Date.now() })
      session.background = undefined
      // Exited mid-turn (a crash, or our close): the turn is over too. A run that waited for background tasks is over
      // with the process. Whoever closed it (cancel, a done step, quit) has dealt with the task already.
      if (session.status === 'running') this.turnEnded(session, !live.closing)
      else if (waited && !live.closing) void this.afterRun(session)
      log.info('agent', `${session.role} live process closed: ${session.status}`, { ...who, seconds: Math.round((Date.now() - openedAt) / 1000) })
      this.store.changed()
    })
    return live
  }

  /** A turn of a live session began: our message (`ours`), or a background task woke the agent. */
  private turnStarted(session: AgentSession, ours = false) {
    this.clearIdle(session.id)
    if (session.status === 'running' && !ours) return
    session.status = 'running'
    session.runStartedAt = Date.now()
    this.store.changed()
    if (ours) this.logSessionEvent(session, 'agent_started', `${session.role} started`)
    log.info('agent', `${session.role} turn started`, { session: session.id, by: ours ? 'message' : 'wake-up' })
  }

  /** A turn of a live session ended at its result; the process stays for the next one. `check`: run afterRun. */
  private turnEnded(session: AgentSession, check = true) {
    if (session.status === 'running') session.status = 'idle'
    log.info('agent', `${session.role} turn ended: ${session.status}`, { session: session.id, seconds: Math.round((Date.now() - (session.runStartedAt ?? Date.now())) / 1000) })
    if (session.status === 'error') this.logSessionEvent(session, 'agent_failed', `${session.role} failed`)
    if (check) void this.afterRun(session)
    this.nameChat(session)
    this.armIdle(session)
    this.store.changed()
  }

  /** Close the live process after LIVE_IDLE_MS without a turn or a background task. */
  private armIdle(session: AgentSession) {
    this.clearIdle(session.id)
    if (!this.lives.has(session.id) || session.status === 'running' || session.background?.length) return
    const timer = setTimeout(() => {
      this.idleTimers.delete(session.id)
      void this.closeLive(session.id)
    }, LIVE_IDLE_MS)
    timer.unref()
    this.idleTimers.set(session.id, timer)
  }

  private clearIdle(sessionId: string) {
    clearTimeout(this.idleTimers.get(sessionId))
    this.idleTimers.delete(sessionId)
  }

  /** Closes the session's live process (if any); resolves once it has exited. */
  private closeLive(sessionId: string, graceMs?: number): Promise<void> {
    const live = this.lives.get(sessionId)
    if (!live) return Promise.resolve()
    if (!live.closing) {
      live.closing = true
      log.info('agent', 'live process closing', { session: sessionId })
      live.handle.close(graceMs)
    }
    return live.handle.done
  }

  /** After a chat's first turn: a short generated title in place of the first message. Once; a failure keeps the old title. */
  private nameChat(session: AgentSession) {
    if (session.role !== 'chat' || session.titleGenerated || session.status === 'error') return
    const first = session.items.find((i) => i.kind === 'user')
    const reply = session.items.flatMap((i) => (i.kind === 'assistant' ? [i.text] : [])).join('\n\n')
    if (first?.kind !== 'user' || !reply) return
    session.titleGenerated = true
    const adapter = adapters[session.agent]
    let text = ''
    let failed = false
    const handle = adapter.start(
      {
        cwd: this.paths.runsDir, // neutral: no repo instructions to load
        prompt: titlePrompt(first.text || first.attachments?.[0]?.name || '', reply),
        model: adapter.cheapModel,
        noTools: true,
      },
      (e) => {
        if (e.type === 'message') text += e.text
        else if (e.type === 'error' || (e.type === 'turn.done' && !e.ok)) failed = true
      },
    )
    handle.done.then(() => {
      const title = failed ? null : cleanTitle(text)
      if (title) session.title = title
      this.store.changed()
    })
  }

  /** Task sessions only: project chats stay out of the log. */
  private logSessionEvent(session: AgentSession, kind: 'agent_started' | 'agent_failed', text: string) {
    if (!session.taskId) return
    const task = this.store.data.tasks.find((t) => t.id === session.taskId)
    this.store.logEvent({ projectId: session.projectId, taskId: session.taskId, taskKey: task?.key ?? null, kind, text })
  }

  /** Make sure a finished run (or turn of a live session) never leaves a task silently stuck. */
  private async afterRun(session: AgentSession) {
    if ((session.role === 'chat' || session.role === 'groomer') && !session.background?.length) this.unanswered(session)
    if (!session.taskId) return
    const task = this.store.task(session.taskId)
    // A step closed or merged during the run: its worktrees could not go while the run was on. Its process goes first.
    if (session.stepId && this.ownerOf(session).status === 'done') {
      this.reviewing.delete(session.stepId)
      await this.closeLive(session.id)
      return this.removeWork(this.ownerOf(session).work)
    }
    if (session.role === 'reviewer') return this.afterReview(session)
    if (task.needsInput) return
    // A background task will wake the agent again: the run is not over yet.
    if (session.background?.length) return
    const failed = session.status === 'error'
    // A failed groomer shows in Needs you (agent_failed); the work stays in planning.
    if (session.role === 'groomer' && task.status === 'planning' && !failed) this.store.updateTask(task.id, { needsInput: 'Groomer stopped without finishing; check the chat' })
    if (session.role === 'developer' && task.status === 'in_progress') {
      const work = this.ownerOf(session).work
      const changed = work?.repos.some((r) => r.prUrl) ? await changedRepos(work, this.store.project(task.projectId).baseBranch) : []
      const now = this.store.task(task.id)
      // A step whose developer asked its owner waits for the answer.
      if (now.status !== 'in_progress' || now.needsInput || this.isRunning(session.id) || session.background?.length || this.ownerOf(session).status === 'done' || this.ownerOf(session).ownerQuestion) return
      const outcome = devRunOutcome(work, changed, failed, !!session.stepId)
      // Every PR merged, maybe while the run was on: the step is done. A legacy task finishes on the scheduler's poll.
      if (outcome.kind === 'complete') return session.stepId ? this.completeStep(session.stepId) : undefined
      // Every changed repo has a PR: the agent review comes first, then the user merges.
      if (outcome.kind === 'review') return session.stepId ? this.review(session.stepId) : undefined
      this.store.updateTask(task.id, { needsInput: outcome.reason })
    }
  }
}
