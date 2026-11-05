import { mkdirSync, rmSync, rmdir, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentAllowed, assertNotImported, DEVELOPER_BAR, choiceLine, COMPARE_VERSION, decisionNote, decisionsBlock, directionCardText, directionDraft, DIRECTION_CHOICES, reportDecision, type DirectionChoice, type DirectionDecision, reportLine, type ReviewReport, AUTO_CONTINUES, AUTO_FIX_TRIES, autoFixOf, type PrProblem, MAG_MCP_ID, canApprove, canCancel, TURN_INTO_WORK_PROMPT, ideaContext, ideaPrompt, ideaTitle, canReopen, cleanTitle, currentStep, devRunOutcome, integrationRules, offIntegrationsBlock, isLegacy, liveSession, localCheckText, localHolder, localOptions, openLocalChecks, projectRepo, repoDirNames, repoNames, repoWorkName, resolveChoice, stepBranch, stepDir, stepRepos, subtasksOf, titlePrompt, needsSummary, parseSummary, summaryCovers, summaryPrompt, summarySource, walkArch, nextReviewRound, contextBlocks, docDecisions, playbookOf, reviewDue, reviewOutcome, githubSlug, isReview, parsePrUrl, prRepoName, reviewOf, reviewToPost, reviewTopic, emptyResult, formatOfTopic, projectReviewFormat, shownResult, REVIEW_FORMATS, type ReviewFormat, type ReviewResult, PR_VERDICT_LABELS, FINDING_LEVEL_LABELS, type PrRef, type PrReview, type PrVerdict, type AgentEvent, type AgentInfo, type AgentReview, type AgentKind, type AgentRole, type AgentSession, type Attachment, type ChatItem, type LocalCheck, type LocalChoice, type ModelChoice, type Project, type RepoWork, type ReviewFinding, type ReviewVerdict, type Task, type TaskWork, type Playbook } from '@mag/core'
import { adapters, type LiveHandle, type RunHandle, type RunSpec } from '@mag/agents'
import { ARCH_RULES } from '@mag/arch'
import type { Store } from './store'
import type { LocalApi } from './api'
import { formatFiles } from '@mag/diff'
import { AGENT_MARK, changedRepos, checkoutLocal, currentBranch, dirtyFiles, fetchPr, postReview, prInfo, prState, prepareWorktree, removeWorktree, repoInfo, scratchWorktree, slug, stash, type PrFeedback } from './git.ts'
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
${DEVELOPER_BAR}
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
${DEVELOPER_BAR}
After opening a PR, call set_pr with its URL and the repo. One PR per changed repo; a repo without changes gets no PR.
If you need a decision only the user can make, call set_needs_input with a one-line question, say it in chat, and stop.
Never merge and never push to ${base}: mag blocks both. Anything you post on GitHub starts with "${AGENT_MARK}".
Keep chat replies short.
${stanceLine(playbookOf(project))}`
}

const ARCHITECT_PROMPT = `You are the architect agent in "mag". Read the project's code (read-only) and record its
architecture with set_architecture. Bash and the web are there to check what you read (git log, ls, a package's docs);
Bash is for reading only, because this checkout is the user's and the tree you record feeds the diagrams, plan ↔ fact
and check_architecture of every work. The project's preferred pattern, use it to classify everything:
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
- The user asks to branch this topic (go on with a separate question in a new topic, "відгалузь", "branch"):
  branch_topic, with text when they said what the new topic is about. The new topic starts with all of this one.
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
const reviewPrompt = (project: Project, task: Task, step: Task, work: TaskWork, heads: Record<string, string>, round: number, withContext: boolean, doc: string, fact: string, scratch: Scratch[]) => {
  const prs = work.repos.filter((r) => heads[r.repo]).map((r) => {
    const own = scratch.find((s) => s.repo === r.repo)
    return `- ${repoWorkName(work, r)}: ${r.prUrl} at ${heads[r.repo].slice(0, 12)}, the developer's worktree ${r.worktree}${own ? `, your scratch worktree ${own.dir}` : ''}`
  })
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
mag checks each save: the inventory against the hunks (blocks of changed code in no unit, units their hunks do not bear out), whether the set hangs together, and plan ↔ fact (levels by the playbook). For every critical or high difference, write a claim that says why it is right or what is wrong (a fact of the direction, a failed convention or a risk), or ask for changes; the others as you judge.
${fact}
Call set_review once with the report. mag checks it against your inventory. The checks verdict is yours, with a one-line why: request_changes = changes, the developer must fix something before the user looks (the findings from the report go to the developer, not to GitHub); approve = merge, ready, nothing the user has to check; look = the user should decide or check something. mag keeps its own floor: a plan deviation or an incomplete fact (the threshold above) makes it look at least, a failed CI check or architecture rule request_changes; it attaches those blockers itself, so you need not restate them as risks.
${scratch.length ? scratchLine('your scratch worktree') : 'Run no tests: CI runs them, and you have no scratch worktree this time.'}
Change no files of the PRs, never push, comment on GitHub or merge, and leave the doc and the plan as they are: the developer fixes what you find. Then reply in one line.

${contextBlocks({ decisions: docDecisions(doc, step.key) })}`
}

/** A review run's own worktree of one repository at the PR head (prompts-use-the-models-to.2): `key` is the repo or the review. */
interface Scratch {
  repo: string
  dir: string
  key: string
}

/** What a review run may do in its scratch worktree, and why there only. */
const scratchLine = (where: string) =>
  `To check a doubt, run a focused test or a script in ${where}: a detached worktree at the PR's head that mag made for this run and removes after it, so nothing you run touches the user's checkout or the developer's worktree. Install what the test needs there; CI runs the full suite.`

const findingLines = (findings: ReviewFinding[]) =>
  findings.map((f) => `- ${f.level ? `[${FINDING_LEVEL_LABELS[f.level]}] ` : ''}${f.where ? `${f.where}: ` : ''}${f.text}`).join('\n')

/**
 * The job of the topic that runs one format of a review of a teammate's PR (reviews-ahent-reviuit-pr-timeitiv.2;
 * review-v2-part-2-v1-2.1): said in full every time, a first look or a look again, in the playbook's text of that
 * format. `files`: the PR's changed files as mag read them; `since`: on a look again at new commits, only what changed
 * after the head this format reviewed last (reviews-ahent-reviuit-pr-timeitiv.3, Decision 8). `shared`: the review's
 * inventory at this head is there already (one per head, by either format's run): this run reads it, never writes it anew.
 */
const prReviewPrompt = (project: Project, work: Task, files: string, since: string | null, format: ReviewFormat, shared: boolean, scratch: string | null) => {
  const review = work.prReview!
  const r = review.results[format] ?? emptyResult(format, '')
  const pr = review.pr
  const name = prRepoName(project, pr)
  const playbook = playbookOf(project)
  const v1 = format === 'v1'
  const newer = r.head && r.head !== pr.head
  const sinceDiff = pr.outside ? `gh api -H "Accept: application/vnd.github.diff" repos/${pr.repo}/compare/${r.head}...${pr.head}` : `git diff ${r.head} ${pr.head}`
  const before = r.verdict
    ? `\nYou reviewed it before, at ${r.head?.slice(0, 12)}: ${r.report ? reportLine(r.report) : PR_VERDICT_LABELS[r.verdict]}.${r.findings.length ? ` Your findings then:\n${findingLines(r.findings)}` : ''}\n${
        newer
          ? `New commits since: review only what changed after ${r.head?.slice(0, 12)} (${sinceDiff}) and whether each finding still holds; keep the fact set and revise it where the new commits change it.${since ? `\nChanged since your review (mag):\n${since}` : ''}`
          : `Look again: whether each finding still holds${shared ? '' : '; keep the fact set and revise it'}.`
      }`
    : ''
  const where = pr.outside
    ? `Its repository ${pr.repo} is not one of the project's, so mag has no checkout of it: read the PR with gh pr diff ${pr.url}, gh pr view and gh api (read only). Its fact is drawn without the project's architecture: its modules are its folders, as get_pr_changes lists them; say so in the review.`
    : `Its repository is ${pr.repo}, the user's main checkout: never change it there; mag fetched the PR, so git diff ${pr.base}...${pr.head} works there.${scratch ? ` The code at the PR's head is in ${scratch}.` : ''}`
  const fact = shared
    ? `The fact: the PR's change inventory at this head is already written (one per head, for both formats of the review): read it with get_pr_changes and get_diagrams(work: "${work.key}") and build on it; call set_inventory only to fix a unit that is wrong, never to write it anew. Scenarios and method logic with show_diagram without role where the review needs them, by the project's playbook:`
    : "The fact: the PR's change inventory (set_inventory, from the hunks get_pr_changes lists), then scenarios and method logic with show_diagram without role where the review needs them, by the project's playbook:"
  const order = v1
    ? 'Review it following the project\'s playbook (the v1 format: findings by level and a verdict, no report):'
    : "Review it following the project's playbook, in its order: the inventory first, then the direction and its options from the inventory and the code alone, and only then the PR's description and comments (gh pr view): options you work out after reading the author lean to the author's. The direction is the user's call: no verdict on it; your own leaning, if you have one, goes in direction.view."
  const close = v1
    ? 'Call set_pr_review with the verdict and the findings once you have them (again whenever the user asks for more and they change), then reply in a few lines: the verdict and the blockers.'
    : `Call set_pr_review with the report once you have it (again whenever the user asks for more and it changes), then reply in a few lines: the checks verdict, its blockers, and the direction's decision with its options for the user to decide. When the user decides it, record it with decide_direction.${blocks(decisionsBlock(project.directionDecisions))}`
  return `Review the PR ${pr.url} (${name}#${pr.number} by @${pr.author}, into ${pr.base}, head ${pr.head.slice(0, 12)}): you own the ${format} review of ${work.key}. ${where}${before}
Pass work: "${work.key}" to show_diagram, place_diagram, get_diagrams, get_pr_changes and set_pr_review.
${order}
${v1 ? playbook.prReviewV1 : playbook.prReview}
${fact}
${playbook.fact}
mag forbids writing to GitHub here (gh pr review, comment, merge, close or edit, gh api with a write method, git push): the user publishes what they pick. ${scratch ? scratchLine(scratch) : 'Run no tests: there is no checkout of it here, and CI runs them.'}
Changed files (mag):
${files}
${close}`
}

/** The review topic's job when the user wants to discuss the direction (review-v2-questions-first-direction.2). */
const discussPrompt = (work: Task, report: ReviewReport, decisions: DirectionDecision[] | undefined) => {
  const others = report.direction.options.filter((o) => !o.pr).map((o) => o.name)
  return `The user wants to discuss the direction of ${work.prReview!.pr.url} (review ${work.key}, its v2 result) before deciding it. The direction card:

${directionCardText(report, decisions)}

Argue the options with them: what each costs and breaks here, which facts and references weigh, and your view when they ask for it; the call is theirs. Help them word their feedback and the principle behind it. Once they pick, call decide_direction with work: "${work.key}": choice ok (the direction is fine), prefer with option (one of: ${others.join(', ') || 'none'}), or discuss (ask the author first); principle in their words when they gave one; draft, the comment to the author from this discussion (with prefer or discuss). Nothing goes to GitHub.`
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
  /** Topics whose title is being generated. */
  private naming = new Set<string>()
  /** `topic:<id>` | `task:<id>` with a summary run going on. */
  private summarizing = new Set<string>()
  /** Review runs' scratch worktrees by session, while its run (or live process) lasts (see ensureScratch). */
  private scratches = new Map<string, Scratch[]>()
  /** Making and removing a session's scratch worktrees, one after another: a closing process's removal goes first. */
  private scratchOps = new Map<string, Promise<unknown>>()

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
        // Bash read only by the prompt (Claude Code has no read-only Bash), and nothing that writes to a PR.
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WebSearch', 'WebFetch', 'Skill', 'mcp__mag'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...NO_PR_WRITES],
        readOnly: true,
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

  /**
   * A new topic branched from a project topic: its agent session forks the parent's, so it starts with all of that
   * context, and the parent stays as it is. `text`, if given, is its first message. Returns the new topic's id.
   */
  branchChat(sessionId: string, text?: string) {
    const parent = this.projectChat(sessionId)
    // Only Claude Code forks a session; Codex's resume would write into the parent's own.
    if (parent.agent !== 'claude-code' || !parent.nativeSessionId) throw new Error('This topic has no agent session to branch yet: send it a message first (Claude Code only)')
    if (this.choice(parent.projectId, 'chat').agent !== 'claude-code') throw new Error('Branching needs Claude Code as the agent of project chats')
    const topic = this.store.createSession({
      projectId: parent.projectId,
      taskId: null,
      role: 'chat',
      agent: 'claude-code',
      status: 'idle',
      title: `Branch of ${parent.title ?? 'a topic'}`.slice(0, 60),
      titleGenerated: true,
      forkOf: parent.nativeSessionId,
      branchOf: parent.id,
    })
    log.info('agent', 'topic branched', { session: topic.id, from: parent.id })
    if (text?.trim()) void this.send(topic.id, text.trim()).catch((e) => log.warn('agent', 'the first message of a branched topic failed', e))
    return topic.id
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
    void this.send(sid, ideaPrompt(idea, !!topic), [], 'Start a work from an idea').catch((e) => log.warn('ideas', 'starting a work from an idea failed', e))
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

  /**
   * The user closes a topic: its turn and live process end, it goes to Done with its history; writing to it reopens it.
   * A topic that owns an open work is closed with that work (Close of a work cancels it), not on its own.
   */
  async closeChat(sessionId: string) {
    const session = this.projectChat(sessionId)
    const owned = this.store.data.tasks.find((t) => !t.parentId && t.ownerSessionId === sessionId && canCancel(t))
    if (owned) throw new Error(`This topic owns ${owned.key}: close the work instead`)
    const run = this.runs.get(sessionId)
    run?.kill()
    await Promise.all([run?.done, this.closeLive(sessionId)])
    this.store.closeSession(session.id)
    log.info('agent', 'topic closed', { session: sessionId })
    void this.summarize('topic', session.id)
  }

  /**
   * The user closes a done work: it stays done, with its doc, sessions and history, and goes to Closed. An open work is
   * closed by cancel, a review by closeReview.
   */
  closeWork(taskId: string) {
    const work = this.store.task(taskId)
    if (work.parentId) throw new Error(`${work.key} is a step; close its work`)
    if (isReview(work)) return this.closeReview(taskId)
    if (work.status !== 'done') throw new Error(`${work.key} is ${work.status}; only a done work is closed this way (cancel the others)`)
    this.store.closeTask(taskId)
    void this.summarize('task', taskId)
  }

  /** Restore of a closed work or review (not a canceled one: cancel is final) or topic: back where it was in the list. */
  restore(kind: 'work' | 'topic', id: string) {
    if (kind === 'topic') return this.store.reopenSession(this.projectChat(id).id)
    const work = this.store.task(id)
    if (work.status === 'canceled') throw new Error(`${work.key} is canceled; a canceled work cannot be restored`)
    this.store.reopenTask(id)
  }

  /**
   * The user's Turn into a work: the topic's agent gets a fixed request to create a work from what was discussed (it
   * becomes the work's owner, as with create_work from any topic).
   */
  turnIntoWork(sessionId: string) {
    this.projectChat(sessionId)
    if (this.isRunning(sessionId)) throw new Error('The topic is still working; turn it into a work when it is done')
    return this.send(sessionId, TURN_INTO_WORK_PROMPT, [], 'Turn into a work')
  }

  /**
   * The user deletes a work for good: a review as deleteReview; otherwise, while no agent of the work runs, its steps
   * and the work with their sessions, docs and diagrams, their worktrees, and the owner topic unless it owns another
   * work. Branches and PRs stay as they are.
   */
  async deleteWork(taskId: string) {
    const work = this.store.task(taskId)
    if (work.parentId) throw new Error(`${work.key} is a step; delete its work`)
    if (isReview(work)) return this.deleteReview(taskId)
    const sessions = this.store.data.sessions
    const owner = sessions.find((s) => s.id === work.ownerSessionId && s.role === 'chat' && !s.taskId)
    const ownsOther = !!owner && this.store.data.tasks.some((t) => t.id !== taskId && t.ownerSessionId === owner.id)
    const gone = [...sessions.filter((s) => s.taskId === taskId), ...(owner && !ownsOther ? [owner] : [])]
    if (gone.some((s) => this.isRunning(s.id))) throw new Error(`An agent of ${work.key} is still working; stop it first, then delete the work`)
    const steps = subtasksOf(taskId, this.store.data.tasks)
    await Promise.all(gone.map((s) => this.closeLive(s.id)))
    for (const t of [work, ...steps]) await this.removeWork(t.work)
    for (const s of steps) this.store.deleteTask(s.id)
    this.store.deleteTask(taskId)
    if (owner && !ownsOther) await this.deleteChat(owner.id)
    this.wakeWaiting(steps.map((s) => s.key))
    log.info('agent', `${work.key}: work deleted`, { steps: steps.length, topic: !!owner && !ownsOther })
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
    this.store.updateTask(taskId, { status: 'planning', needsInput: null, closedAt: null, ...(by && { ownerSessionId: by }) })
    log.info('agent', `${task.key} reopened`, { by: by ?? 'app' })
    if (by) return `${task.key} is back in planning and this topic owns it.`
    const owner = this.ownerSession(task)
    const ask = `${task.key} was done, but more is needed: ${need}\nIt is back in planning; its done steps stay as they are. Update the doc (problem, decisions, plan) for what is needed, add the new steps${owner?.role === 'chat' ? ` (pass work: "${task.key}")` : ''} and ask the user to review the plan.`
    if (owner && this.isRunning(owner.id)) {
      this.store.updateTask(taskId, { needsInput: `More needed: ${need}. Its owner is busy: tell it in its chat` })
      return `${task.key} is back in planning; its owner is busy.`
    }
    if (owner) {
      void this.send(owner.id, ask, [], `More needed: ${task.key}`).catch((e) => this.store.updateTask(taskId, { needsInput: `Could not tell its owner: ${(e as Error).message}` }))
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

  /** The user's Approve & Start (the button, or start_work on a work in planning): approve, then Start. */
  async approveAndStart(taskId: string, localRepos?: string[]) {
    this.approve(taskId)
    return this.develop(taskId, undefined, localRepos)
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
   * recommendation. An owner in a turn gets it once that turn ends (see deliverQueued). false when the work has no
   * owner: the user is asked.
   */
  askOwner(stepId: string, question: string): boolean {
    return this.toOwner(stepId, question, 'asks')
  }

  /**
   * A step's matter for the owner's decision: the developer's question, or what mag could not settle on its own
   * (`from` mag). Queued while the owner is in a turn; false without an owner.
   */
  private toOwner(stepId: string, question: string, from: 'asks' | 'mag'): boolean {
    const step = this.store.task(stepId)
    if (!step.parentId) return false
    const owner = this.ownerSession(this.store.task(step.parentId))
    if (!owner) return false
    this.store.updateTask(stepId, { ownerQuestion: question, ownerQuestionFrom: from, ownerQuestionQueued: false })
    if (this.isRunning(owner.id)) {
      this.store.updateTask(stepId, { ownerQuestionQueued: true })
      this.ownerEvent(step.id, `${step.key} ${from === 'asks' ? 'asks' : 'needs your decision'}: ${question} (queued until this turn ends)`)
      log.info('agent', `${step.key}: queued for its owner`, { owner: owner.id })
      return true
    }
    this.sendAsk(stepId)
    return true
  }

  /** Sends a step's waiting question to the work's owner, with the decisions of the step. */
  private sendAsk(stepId: string) {
    const step = this.store.task(stepId)
    const task = this.store.task(step.parentId!)
    const owner = this.ownerSession(task)!
    const question = step.ownerQuestion!
    log.info('agent', `${step.key}: asks its owner`, { owner: owner.id })
    const work = owner.role === 'chat' ? `, work: "${task.key}"` : ''
    const decisions = contextBlocks({ decisions: docDecisions(this.store.data.docs[task.id] ?? '', step.key) })
    const head =
      step.ownerQuestionFrom === 'mag'
        ? `mag could not settle this on its own for ${step.key} ("${step.title}"): ${question}\n`
        : `The developer of ${step.key} ("${step.title}") asks: ${question}\n`
    const ask =
      head +
      `You own ${task.key}: answer it yourself when the decisions, the doc or what you discussed with the user cover it: answer_developer(step: "${step.key}"${work}, text), with the answer and why. ` +
      `Only when the user has to decide: set_needs_input(${work ? `work: "${task.key}", ` : ''}reason) with the question and your recommendation, and once the user has decided, pass it on with answer_developer.` +
      blocks(decisions)
    void this.send(owner.id, ask, [], `${step.key} ${step.ownerQuestionFrom === 'mag' ? 'needs a decision' : 'asks'}`).catch((e) => {
      this.store.updateTask(stepId, { ownerQuestion: null })
      this.store.updateTask(task.id, { needsInput: `${question} (could not ask its owner: ${(e as Error).message})` })
    })
  }

  /**
   * The owner's turn ended: the first question that waited for it goes to it now; the others follow at the ends of
   * the next turns. true if one was sent.
   */
  private deliverQueued(owner: AgentSession): boolean {
    const step = this.store.data.tasks.find((t) => t.parentId && t.ownerQuestionQueued && t.ownerQuestion && this.store.task(t.parentId).ownerSessionId === owner.id)
    if (!step) return false
    this.store.updateTask(step.id, { ownerQuestionQueued: false })
    this.sendAsk(step.id)
    return true
  }

  /**
   * A notice line about the work in its owner's conversation (ux-odna-rozmova-na-robotu.1): what happened, without a
   * turn of the agent. `taskId`: the work or one of its steps. Nothing without an owner.
   */
  ownerEvent(taskId: string, text: string) {
    const t = this.store.task(taskId)
    const owner = this.ownerSession(t.parentId ? this.store.task(t.parentId) : t)
    if (owner) this.store.pushItem(owner.id, { kind: 'notice', text, at: Date.now() })
  }

  /** The owner's answer to its step developer's question: the developer's session goes on with it. */
  async answerDeveloper(stepId: string, text: string) {
    const step = this.store.task(stepId)
    const session = this.lastStepSession(stepId)
    if (!step.ownerQuestion || !session) throw new Error(`No question of ${step.key}'s developer is waiting`)
    // The owner decided on a PR problem mag gave up on: mag tries it again after that.
    if (step.ownerQuestionFrom === 'mag') {
      const tries = autoFixOf(step)
      this.store.updateTask(stepId, { autoFix: { ...tries, ci: tries.ci > AUTO_FIX_TRIES ? 0 : tries.ci, conflict: tries.conflict > AUTO_FIX_TRIES ? 0 : tries.conflict } })
    }
    const lead = step.ownerQuestionFrom === 'mag' ? `The owner of the work decides on what mag could not fix on its own (${step.ownerQuestion.split('\n')[0]}): ` : 'The owner of the work answers your question: '
    await this.send(session.id, lead + text, [], "Owner's answer")
  }

  /**
   * An owner's turn ended with a developer's question neither answered nor put to the user: the user gets it, so a step
   * never waits silently.
   */
  private unanswered(owner: AgentSession) {
    // Its next turn (a queued question) still may answer.
    if (this.isRunning(owner.id)) return
    for (const step of this.store.data.tasks) {
      if (!step.parentId || !step.ownerQuestion || step.ownerQuestionQueued) continue
      const task = this.store.task(step.parentId)
      if (task.ownerSessionId !== owner.id || task.needsInput) continue
      this.store.updateTask(task.id, { needsInput: `${step.key}${step.ownerQuestionFrom === 'mag' ? ':' : ' asks:'} ${step.ownerQuestion} (its owner did not answer)` })
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
    // The Start popup's choice is its default next time.
    if (localRepos) this.store.updateProject(project.id, { lastLocalRepos: local })
    // The user chose Wait: the step starts once the other step lets the repository go (see wakeWaiting).
    if (!last && step.waitingFor && localHolder(step.waitingFor.repo, this.others(step.id))) return
    const dir = step.work?.dir ?? stepDir(this.paths.worktreesDir, project.id, step.key)
    // A restart is told what to do: a question it asked the owner no longer holds the step, and mag's tries start over.
    this.store.updateTask(step.id, {
      status: 'in_progress',
      waitingFor: null,
      ownerQuestion: null,
      ownerQuestionQueued: false,
      autoFix: { ci: 0, conflict: 0, continue: 0 },
      work: this.workFor(step.work, project, dir, stepBranch(step.key), stepRepos(step, project), local),
    })
    // Once per step, before its first session: a restart leaves the main checkouts as they are.
    const ready = last ? { discuss: [] } : await this.prepareLocal(step.id)
    if (!ready) return
    const session = last ?? this.newSession(taskId, 'developer', step.id)
    if (!(await this.prepareWorktrees(session))) return
    this.ownerEvent(step.id, `${step.key} ${last ? 'restarted' : 'started'}: "${step.title}"`)
    const intro = `Implement step ${step.key} of ${task.key}. Start with get_task and get_doc.`
    const talk = ready.discuss.length ? [intro, discussText(ready.discuss, project.baseBranch)].join('\n\n') : undefined
    // mag's job is a card; a message of the user's (Restart with a message) stays theirs.
    if (talk) session.items.push({ kind: 'job', title: `Implement ${step.key}`, text: talk, at: Date.now() })
    if (message) session.items.push({ kind: 'user', text: message, at: Date.now() })
    return this.run(session, [talk, message].filter(Boolean).join('\n\n') || intro)
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
    this.ownerEvent(stepId, `${step.key} done${step.work?.repos.some((r) => r.prState === 'merged') ? ': its PRs are merged' : ''}`)
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
    return this.resumeDeveloper(owner, text, 'PR feedback')
  }

  /**
   * A problem of a step's open PRs (ux-odna-rozmova-na-robotu.1): CI failed, or a conflict with base. The step's
   * developer gets it back to fix, at most AUTO_FIX_TRIES times per problem (the count starts over once it clears, see
   * the scheduler); then the owner decides (see toOwner), the user if there is none. `detail`: the failing checks or
   * the conflicting repositories. false when nothing was done: an agent of the step is in a turn, the step waits for a
   * decision, or the owner has it already.
   */
  fixPr(stepId: string, problem: PrProblem, detail: string): boolean {
    const step = this.store.task(stepId)
    if (!step.parentId || step.status !== 'in_progress' || step.ownerQuestion) return false
    const task = this.store.task(step.parentId)
    if (task.status !== 'in_progress' || task.needsInput) return false
    if (this.reviewing.has(stepId) || this.store.data.sessions.some((s) => s.stepId === stepId && this.isRunning(s.id))) return false
    const tries = autoFixOf(step)
    const n = tries[problem]
    // Past the tries: the owner (or the user) has it.
    if (n > AUTO_FIX_TRIES) return false
    const what = problem === 'ci' ? 'CI fails' : 'conflicts with the base'
    if (n === AUTO_FIX_TRIES) {
      this.store.updateTask(stepId, { autoFix: { ...tries, [problem]: n + 1 } })
      this.ownerEvent(stepId, `${step.key}: ${what}, not fixed after ${AUTO_FIX_TRIES} tries`)
      const question = `its PR ${what} after ${AUTO_FIX_TRIES} automatic fixes by its developer:\n${detail}\nTell the developer how to go on, or ask the user with your recommendation.`
      if (!this.toOwner(stepId, question, 'mag')) this.store.updateTask(task.id, { needsInput: `${step.key}: PR ${what}, not fixed after ${AUTO_FIX_TRIES} tries` })
      return true
    }
    const base = this.store.project(step.projectId).baseBranch
    const text =
      problem === 'ci'
        ? `CI fails on your PR:\n${detail}\nRead the failing logs (gh pr checks, gh run view --log-failed), fix the cause, run the tests, push. If it is not caused by your change, say why here and call set_needs_input.`
        : `Your PR has conflicts with ${base}:\n${detail}\nRebase the branch on fresh origin/${base} (git fetch origin ${base}, git rebase origin/${base}), resolve the conflicts keeping both sides' intent, run the tests, push with --force-with-lease. If a conflict needs a decision, call set_needs_input.`
    if (!this.resumeDeveloper(step, text, problem === 'ci' ? `CI failed · try ${n + 1}/${AUTO_FIX_TRIES}` : `Conflict · try ${n + 1}/${AUTO_FIX_TRIES}`)) return false
    this.store.updateTask(stepId, { autoFix: { ...tries, [problem]: n + 1 } })
    this.ownerEvent(stepId, `${step.key}: ${what}, the developer fixes it (try ${n + 1}/${AUTO_FIX_TRIES})`)
    log.info('agent', `${step.key}: ${problem} back to the developer, try ${n + 1}`)
    return true
  }

  /** The step's PR problems that cleared: their tries start over. */
  clearedPr(stepId: string, cleared: PrProblem[]) {
    const tries = autoFixOf(this.store.task(stepId))
    if (!cleared.some((p) => tries[p])) return
    this.store.updateTask(stepId, { autoFix: { ...tries, ...Object.fromEntries(cleared.map((p) => [p, 0])) } })
  }

  /**
   * Resumes the developer session of a step (or a legacy task) with `text`, a job titled `job`; false while it is in a
   * turn or has none.
   */
  private resumeDeveloper(owner: Task, text: string, job: string) {
    const taskId = owner.parentId ?? owner.id
    const session = owner.parentId ? this.lastStepSession(owner.id) : this.lastSession(taskId, 'developer')
    // During a turn the comments wait for the next poll; a live process between turns gets them as a message.
    if (!session || this.isRunning(session.id)) return false
    session.items.push({ kind: 'job', title: job, text, at: Date.now() })
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
    this.ownerEvent(stepId, `${step.key}: PR ready, agent review round ${round}`)
    const fact = await this.factOf(stepId, now).catch((e) => {
      log.warn('agent', `${step.key}: plan ↔ fact failed: ${(e as Error).message}`)
      // Nothing proves the PRs match their plan: merge waits for the user.
      const prev = this.store.task(stepId).fact
      const counts = { match: 0, differs: 0, missing: 0, unplanned: 0, additions: 0, outside: 0, unaccounted: 0, ungrounded: 0 }
      const blockers = [`mag could not compare the PRs with the plan (${(e as Error).message.split('\n')[0]})`]
      this.store.updateTask(stepId, { fact: { heads: now, counts, compareVersion: COMPARE_VERSION, blockers, canvasId: prev?.canvasId ?? null, at: Date.now() } })
      return `(mag could not compare: ${(e as Error).message.split('\n')[0]}; read the diff and compare it with the plan yourself.)`
    })
    // Canceled while mag compared.
    if (this.store.task(stepId).status !== 'in_progress') {
      this.reviewing.delete(stepId)
      return
    }
    const scratch = await this.ensureScratch(session)
    const text = reviewPrompt(this.store.project(task.projectId), task, this.store.task(stepId), fresh.work!, now, round, withContext, this.store.data.docs[task.id] ?? '', fact, scratch)
    // A Codex developer's PRs are reviewed on Claude Code (resolveChoice): say so where the review runs.
    const refused = agentAllowed('reviewer', this.choice(task.projectId, 'developer').agent)
    if (!refused.ok) session.items.push({ kind: 'notice', text: `${refused.why} This review runs on Claude Code.`, at: Date.now() })
    session.items.push({ kind: 'job', title: `Agent review · round ${round}`, text, at: Date.now() })
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
  setReview(stepId: string, verdict: ReviewVerdict, findings: ReviewFinding[], report?: ReviewReport): string {
    const pending = this.reviewing.get(stepId)
    const step = this.store.task(stepId)
    if (!pending) throw new Error(`No agent review of ${step.key} is going on`)
    // The threshold for "no need to look at the code" (T-58 Decision 5) is mag's, not the reviewer's; each revision of the fact set records it anew.
    // A report has it applied already (its floor, with mag's blockers attached); the older form without one is refused.
    const fact = step.fact
    if (verdict === 'merge' && fact?.blockers.length && JSON.stringify(fact.heads) === JSON.stringify(pending.heads))
      throw new Error(`Not recorded: merge is over the threshold, the user has to look at:\n${fact.blockers.map((b) => `- ${b}`).join('\n')}\nGive look (with these as findings) or changes.`)
    const review: AgentReview = { verdict, findings, ...(report ? { report } : {}), round: pending.round, heads: pending.heads, withContext: pending.withContext, at: Date.now() }
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
        this.ownerEvent(stepId, `${step.key}: the agent review failed without a verdict`)
        this.store.changed()
      }
      return
    }
    const toDeveloper = reviewOutcome(review, playbookOf(this.store.project(step.projectId)).reviewRounds) === 'developer'
    const n = review.findings.length
    this.ownerEvent(
      stepId,
      `${step.key}: agent review round ${review.round}: ${review.verdict}${n ? ` · ${n} finding${n > 1 ? 's' : ''}` : ''}${toDeveloper ? ', back to the developer' : review.verdict === 'merge' ? ', ready to merge' : ', the user looks'}`,
    )
    if (!toDeveloper) return
    const many = (step.work?.repos.filter((r) => r.prUrl).length ?? 0) > 1
    // A developer in a turn (the user talks to it) keeps it; the user sees the verdict instead.
    if (!this.resumeDeveloper(step, reviewFeedback(review, many), `Review findings · round ${review.round}`)) log.info('agent', `${step.key}: review findings not sent, the developer is busy`)
  }

  /**
   * A review of a teammate's PR (reviews-ahent-reviuit-pr-timeitiv.2): the PR of a project repository, by its link. Its
   * work (type review, in progress at once, no steps) is the PR's open one if it has one, else a new one. `format`
   * (review-v2-part-2-v1-2.1): the result this run records, the project's default without one; the review keeps one
   * result per format and shows this one. `by`: the project topic that asks (review_pr); it runs the review and gets
   * the job back to do in its turn. Without it (the work list, Run v1 / Run v2) the topic that ran this format before
   * does it, else a new one of mag's for the format, so v2 never sees what a v1 run read first.
   */
  async reviewPr(projectId: string, url: string, by?: string, format?: ReviewFormat): Promise<{ taskId: string; sessionId: string; job: string }> {
    const project = this.store.project(projectId)
    // The review runs on the chat's agent; Codex can't be held to "nothing goes to the PR".
    const allowed = agentAllowed('pr-review', this.choice(projectId, 'chat').agent)
    if (!allowed.ok) throw new Error(`${allowed.why} Pick Claude Code for Project chat in the project's settings to review PRs.`)
    const info = await prInfo(parsePrUrl(url).url)
    if (info.state !== 'OPEN') throw new Error(`${info.repo}#${info.number} is ${info.state.toLowerCase()}: only an open PR is reviewed`)
    // A repository the project has no checkout of is read from GitHub (reviews-ahent-reviuit-pr-timeitiv.3, Decision 10).
    const repo = await this.repoOfSlug(project, info.repo)
    const tasks = this.store.data.tasks.filter((t) => t.projectId === projectId)
    const pr: PrRef = { url: info.url, repo: repo ?? info.repo, ...(repo ? {} : { outside: true }), number: info.number, author: info.author, base: info.base, head: info.head }
    const name = prRepoName(project, pr)
    // An imported review is read only: a review of its PR here is a new one.
    const prev = reviewOf(tasks.filter((t) => !t.imported), info.url)
    const f = format ?? projectReviewFormat(project)
    const before = prev?.prReview?.results[f]
    // The topic that ran this format before, while it is there; never the other format's.
    const own = before && this.store.data.sessions.find((s) => s.id === before.sessionId)
    const owner = by ?? own?.id
    if (owner && !by && this.isRunning(owner)) throw new Error(`The ${f} review of ${prev!.key} is still working; ask it there`)
    const sessionId = owner ?? this.newChat(projectId)
    const title = `${name}#${info.number}: ${info.title}`
    const base: PrReview = prev?.prReview ?? { pr, results: {}, shown: f, posted: null }
    const prReview: PrReview = { ...base, pr, shown: f, results: { ...base.results, [f]: { ...(before ?? emptyResult(f, sessionId)), sessionId } } }
    const work = prev
      ? (this.store.updateTask(prev.id, { title, status: 'in_progress', needsInput: null, closedAt: null, ownerSessionId: sessionId, prReview }), this.store.task(prev.id))
      : this.store.createTask({ projectId, title, type: 'review', description: info.url, status: 'in_progress', ownerSessionId: sessionId })
    if (!prev) this.store.updateTask(work.id, { prReview })
    // mag's own topic for the review's format: Delete review takes it along; the work list shows it as the review.
    if (!owner) {
      const topic = this.store.session(sessionId)
      topic.title = `Review ${name}#${info.number} · ${f}`
      topic.titleGenerated = true
      topic.reviewOf = work.id
      topic.reviewFormat = f
    }
    log.info('agent', `${work.key}: ${f} review of ${info.url} at ${info.head.slice(0, 12)}`, { by: by ? 'topic' : 'app' })
    const now = this.store.task(work.id)
    const { files, since } = await this.prFiles(project, now, f)
    // One inventory per head, whichever format wrote it: a later run at that head reuses it, never writes it anew.
    const scratch = (await this.ensureScratch(this.store.session(sessionId))).find((s) => s.key === now.id)
    const job = prReviewPrompt(project, now, files, since, f, this.inventoryAt(now), scratch?.dir ?? null)
    if (!by) await this.send(sessionId, job, [], `Review ${name}#${info.number} · ${f}`)
    return { taskId: work.id, sessionId, job }
  }

  /** Whether a review has its inventory at its PR's head: a run of the other format reuses it. */
  private inventoryAt(work: Task): boolean {
    const pr = work.prReview?.pr
    return !!pr && work.fact?.heads[pr.repo] === pr.head && reviewFacts(Object.values(this.store.data.canvases), work.id).some((c) => !!c.inventory)
  }

  /** The user's Review again: the review's PR as it is now gets another look, in the format it shows. */
  rereview(workId: string) {
    const work = this.store.task(workId)
    if (!isReview(work) || !work.prReview) throw new Error(`${work.key} is not a review of a PR`)
    assertNotImported(work, 'be reviewed again')
    return this.reviewPr(work.projectId, work.prReview.pr.url, undefined, work.prReview.shown)
  }

  /**
   * The user's Run v1 / Run v2 (review-v2-part-2-v1-2.1): a run of that format in its own topic, at the PR's head; its
   * result joins the other one, which stays. At the head the other format has read, it reuses its inventory.
   */
  runReviewFormat(workId: string, format: ReviewFormat) {
    const work = this.store.task(workId)
    if (!isReview(work) || !work.prReview) throw new Error(`${work.key} is not a review of a PR`)
    assertNotImported(work, 'run a review')
    if (!REVIEW_FORMATS.includes(format)) throw new Error(`format must be one of ${REVIEW_FORMATS.join(', ')}`)
    return this.reviewPr(work.projectId, work.prReview.pr.url, undefined, format)
  }

  /** The user's v1 | v2 switch: the page and the lists show that result, and the conversation beside it is its topic. */
  showReviewResult(workId: string, format: ReviewFormat) {
    const work = this.store.task(workId)
    const r = work.prReview
    if (!isReview(work) || !r) throw new Error(`${work.key} is not a review of a PR`)
    const result = r.results[format]
    if (!result) throw new Error(`${work.key} has no ${format} result: run it first`)
    const topic = this.store.data.sessions.some((s) => s.id === result.sessionId) ? { ownerSessionId: result.sessionId } : {}
    this.store.updateTask(workId, { prReview: { ...r, shown: format }, ...topic })
  }

  /** The user closes a review: done and in Closed; Restore or Review again brings it back. */
  closeReview(workId: string) {
    const work = this.store.task(workId)
    if (!isReview(work)) throw new Error(`${work.key} is not a review of a PR`)
    this.store.updateTask(workId, { status: 'done', needsInput: null, closedAt: Date.now() })
    void this.summarize('task', workId)
  }

  /**
   * The user deletes a review for good (reviews-normalnyi-ux-stan-reviu.1): the review, its doc and diagrams, and the
   * topic mag created for it (its run ends first). A topic that asked for the review (review_pr) stays; while it is in a
   * turn the review is not deleted. Nothing changes on GitHub.
   */
  async deleteReview(workId: string) {
    const work = this.store.task(workId)
    if (!isReview(work)) throw new Error(`${work.key} is not a review of a PR`)
    const sessions = this.store.data.sessions
    const own = [...new Set([reviewTopic(work, sessions), ...sessions.filter((s) => s.reviewOf === workId)].filter((s): s is AgentSession => !!s))]
    const owner = work.ownerSessionId
    if (owner && !own.some((s) => s.id === owner) && this.isRunning(owner)) throw new Error(`The topic of ${work.key} is still working; stop it or wait, then delete the review`)
    for (const s of own) await this.deleteChat(s.id)
    if (work.imported) rmSync(work.imported.diffPath, { force: true })
    this.store.deleteTask(workId)
    log.info('agent', `${work.key}: review deleted`, { topics: own.length })
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
  private async prFiles(project: Project, work: Task, format: ReviewFormat): Promise<{ files: string; since: string | null }> {
    const pr = work.prReview!.pr
    const r = work.prReview!.results[format] ?? emptyResult(format, '')
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
    assertNotImported(work, 'read its PR again')
    const project = this.store.project(work.projectId)
    const changed = await changes(project, [await reviewTarget(project, work)], reviewSource(work))
    const fact = check(project, changed, reviewFacts(Object.values(this.store.data.canvases), workId), null)
    this.store.updateTask(workId, { fact: factRecord(fact, { [pr.repo]: pr.head }) })
    return [factReport(fact), hunkListing(changed)].filter(Boolean).join('\n\n')
  }

  /**
   * A topic's set_pr_review: its format's result of the review, at the head mag gave it (review-v2-part-2-v1-2.1: the
   * other format's result stays). Nothing goes to GitHub.
   */
  setPrReview(workId: string, sessionId: string, r: Pick<ReviewResult, 'problem' | 'approach' | 'verdict' | 'findings' | 'report'>): string {
    const work = this.store.task(workId)
    const review = work.prReview
    if (!isReview(work) || !review) throw new Error(`${work.key} is not a review of a PR`)
    assertNotImported(work, 'record a review')
    const format = formatOfTopic(review, this.store.data.sessions.find((s) => s.id === sessionId)) ?? review.shown
    const prev = review.results[format]
    // A new report of the same PR keeps the user's call on its direction and its draft
    // (review-v2-questions-first-direction.2): deciding again replaces it.
    const kept = prev?.report?.decided ? { decided: prev.report.decided, ...(prev.report.draft ? { draft: prev.report.draft } : {}) } : {}
    const report = r.report && { ...r.report, ...kept }
    const result: ReviewResult = { ...(prev ?? emptyResult(format, sessionId)), ...r, report, head: review.pr.head, at: Date.now() }
    if (!report) delete result.report
    this.store.updateTask(workId, { prReview: { ...review, results: { ...review.results, [format]: result } }, needsInput: null })
    const n = r.findings.length
    this.store.logEvent({ projectId: work.projectId, taskId: workId, taskKey: work.key, kind: 'review', text: `PR review ${format}: ${r.report ? reportLine(r.report) : PR_VERDICT_LABELS[r.verdict!]}${n ? ` · ${n} finding${n > 1 ? 's' : ''}` : ''}` })
    return `Recorded as the review's ${format} result: the user sees it on the review's pane beside your conversation. Nothing goes to GitHub until they publish the findings they pick.`
  }

  /**
   * The user's call on the direction of a review's PR (review-v2-questions-first-direction.2), by a button of its
   * direction card or the topic's decide_direction: recorded on the report (with the comment to the author it drafts:
   * the agent's, else mag's), in the project's direction decisions and as one line of its notes. A call made again
   * replaces the earlier one in all three. It is the v2 result's: v1 has no direction (review-v2-part-2-v1-2.1). Nothing
   * goes to GitHub.
   */
  decideDirection(workId: string, input: { choice: DirectionChoice; option?: string; principle?: string; draft?: string }): string {
    const work = this.store.task(workId)
    const review = work.prReview
    if (!isReview(work) || !review) throw new Error(`${work.key} is not a review of a PR`)
    assertNotImported(work, 'take a direction call')
    const r = review.results.v2
    const report = r?.report
    if (!r || !report) throw new Error(`${work.key} has no v2 report to decide on: run its v2 review`)
    if (!DIRECTION_CHOICES.includes(input.choice)) throw new Error(`choice must be one of ${DIRECTION_CHOICES.join(', ')}`)
    const option = input.option?.trim()
    if (input.choice === 'prefer') {
      const others = report.direction.options.filter((o) => !o.pr).map((o) => o.name)
      if (!option || !others.includes(option)) throw new Error(`prefer needs option: one of the options other than the PR's: ${others.join(', ') || '(none)'}`)
    }
    const principle = input.principle?.trim()
    const decided: DirectionDecision = {
      id: randomUUID().slice(0, 8),
      reviewId: work.id,
      pr: review.pr.url,
      decision: reportDecision(report),
      choice: input.choice,
      ...(input.choice === 'prefer' ? { option } : {}),
      ...(principle ? { principle } : {}),
      at: Date.now(),
    }
    const draft = input.choice === 'ok' ? '' : input.draft?.trim() || directionDraft(report, decided)
    const project = this.store.project(work.projectId)
    const prev = report.decided
    const notes = prev ? project.notes.split('\n').filter((l) => l !== decisionNote(prev)).join('\n') : project.notes
    this.store.updateProject(project.id, {
      directionDecisions: [...(project.directionDecisions ?? []).filter((d) => d.id !== prev?.id), decided],
      notes: [notes.trimEnd(), decisionNote(decided)].filter(Boolean).join('\n'),
    })
    const { draft: _, ...rest } = report
    this.store.updateTask(workId, { prReview: { ...review, results: { ...review.results, v2: { ...r, report: { ...rest, decided, ...(draft ? { draft } : {}) } } } } })
    this.store.logEvent({ projectId: work.projectId, taskId: workId, taskKey: work.key, kind: 'review', text: `Direction: ${choiceLine(decided)}` })
    log.info('agent', `${work.key}: direction ${decided.choice}${option ? ` (${option})` : ''}`)
    return `Recorded: ${choiceLine(decided)}, on the review and in the project's decisions and notes.${draft ? ' The draft to the author shows on the direction card; nothing goes to GitHub until the user posts it.' : ''}`
  }

  /**
   * The user's Discuss with agent (review-v2-questions-first-direction.2): the review's topic gets the direction card
   * and argues the options with the user beside the page, until they decide with decide_direction.
   */
  async discussDirection(workId: string): Promise<{ sessionId: string }> {
    const work = this.store.task(workId)
    const result = work.prReview?.results.v2
    const report = result?.report
    if (!isReview(work) || !report) throw new Error(`${work.key} has no v2 report to discuss`)
    assertNotImported(work, 'discuss its direction')
    // The topic that ran the v2 review: decide_direction is its.
    const topic = this.store.data.sessions.find((s) => s.id === result.sessionId) ?? this.ownerSession(work)
    if (!topic) throw new Error(`${work.key} has no topic: review it again`)
    if (this.isRunning(topic.id)) throw new Error(`The topic of ${work.key} is still working; wait for it, then discuss`)
    const project = this.store.project(work.projectId)
    await this.send(topic.id, discussPrompt(work, report, project.directionDecisions), [], 'Discuss the direction')
    return { sessionId: topic.id }
  }

  /**
   * The user's Publish (reviews-ahent-reviuit-pr-timeitiv.3, Decision 7): the review goes to the PR on GitHub as theirs,
   * with `verdict` and only the findings at `picks` (indexes into its findings). mag posts it, never an agent. A finding
   * on a line the PR does not change is refused by GitHub as a line comment: then every finding goes in the text.
   */
  async publishReview(workId: string, verdict: PrVerdict, picks: number[]): Promise<string> {
    const work = this.store.task(workId)
    const review = work.prReview
    if (!isReview(work) || !review) throw new Error(`${work.key} is not a review of a PR`)
    assertNotImported(work, 'be published')
    // The result the user sees: its findings are the ones they picked.
    const r = shownResult(review)
    if (!r?.head) throw new Error(`${work.key} has no ${review.shown} review yet`)
    const findings = r.findings.map((f, i) => ({ ...f, post: picks.includes(i) }))
    this.store.updateTask(workId, { prReview: { ...review, results: { ...review.results, [review.shown]: { ...r, findings } } } })
    let url: string
    try {
      url = await postReview(review.pr.url, r.head, reviewToPost(verdict, findings))
    } catch (e) {
      if (!/\b422\b|line could not be resolved|pull_request_review_thread/i.test((e as Error).message) || !reviewToPost(verdict, findings).comments.length) throw e
      log.info('agent', `${work.key}: line comments refused, publishing them in the text: ${(e as Error).message.split('\n')[0]}`)
      url = await postReview(review.pr.url, r.head, reviewToPost(verdict, findings, false))
    }
    this.store.updateTask(workId, { prReview: { ...this.store.task(workId).prReview!, posted: { at: Date.now(), url } } })
    const n = picks.length
    this.store.logEvent({ projectId: work.projectId, taskId: workId, taskKey: work.key, kind: 'review', text: `Published to GitHub: ${PR_VERDICT_LABELS[verdict]}${n ? ` · ${n} finding${n > 1 ? 's' : ''}` : ''}` })
    log.info('agent', `${work.key}: published ${PR_VERDICT_LABELS[verdict]} with ${n} finding(s) to ${review.pr.url}`)
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
    assertNotImported(work, 'connect a repository')
    if (!pr.outside) throw new Error(`${work.key} already reads its PR from the project's checkout`)
    const origin = githubSlug((await repoInfo(dir).catch(() => null))?.origin)
    if (origin !== pr.repo) throw new Error(`${dir} is not a checkout of ${pr.repo}${origin ? ` (its origin is ${origin})` : ''}`)
    const project = this.store.project(work.projectId)
    if (!project.repos.includes(dir)) this.store.updateProject(project.id, { repos: [...project.repos, dir] })
    log.info('agent', `${work.key}: ${pr.repo} joins ${project.name} at ${dir}`)
    return this.rereview(workId)
  }

  /**
   * A live session takes a message during a turn too: the agent gets it in that turn. `job`: the message is mag's, not
   * the user's (a review's job, the owner's ask…): the chat shows it as a card with this title.
   */
  async send(sessionId: string, text: string, attachments: Attachment[] = [], job?: string) {
    const session = this.store.session(sessionId)
    if (this.runs.has(sessionId)) throw new Error('Agent is still working')
    // Writing to a closed topic opens it again.
    this.store.reopenSession(sessionId)
    session.items.push(job ? { kind: 'job', title: job, text, at: Date.now() } : { kind: 'user', text, attachments: attachments.length ? attachments : undefined, at: Date.now() })
    // A topic the user renamed keeps its title.
    if (session.role === 'chat' && !session.titleGenerated && !session.items.some((i, n) => (i.kind === 'user' || i.kind === 'job') && n < session.items.length - 1))
      session.title = (job || text || attachments[0]?.name || 'Chat').replace(/\s+/g, ' ').slice(0, 60)
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
    if (session.role === 'developer' && session.stepId) this.store.updateTask(session.stepId, { ownerQuestion: null, ownerQuestionQueued: false })
    // A worktree may have failed earlier or been removed: recreate it before resuming.
    if (session.role === 'developer' && this.ownerOf(session).work && !(await this.prepareWorktrees(session))) return
    return this.run(session, prompt)
  }

  /**
   * The integration card's Enable: Ask / Auto (decision 8): the project's mode of the integration for the card's role,
   * the card enabled, and the same session told to repeat its last step. Its run and live process end first: their
   * permission rules are the old ones. The architect has no chat to ask in, so only auto there.
   */
  async enableIntegration(sessionId: string, itemId: string, mode: 'ask' | 'auto') {
    const session = this.store.session(sessionId)
    const item = session.items.find((i): i is Extract<ChatItem, { kind: 'integration' }> => i.kind === 'integration' && i.id === itemId)
    if (!item) throw new Error('No such integration card')
    if (mode !== 'ask' && mode !== 'auto') throw new Error('mode must be ask or auto')
    if (mode === 'ask' && item.role === 'architect') throw new Error('Only Auto works for the architect: it has no chat to ask in')
    const project = this.store.project(session.projectId)
    const integrations = project.integrations ?? {}
    this.store.updateProject(project.id, { integrations: { ...integrations, [item.role]: { ...integrations[item.role], [item.integrationId]: mode } } })
    // Every card of this integration and role in the session is answered by it.
    for (const i of session.items) if (i.kind === 'integration' && i.integrationId === item.integrationId && i.role === item.role) i.status = mode
    this.store.changed()
    log.info('agent', `${item.server} on (${mode}) for ${item.role}`, { session: sessionId })
    const run = this.runs.get(sessionId)
    run?.kill()
    await Promise.all([run?.done, this.closeLive(sessionId)])
    // The end of the killed run may have started another turn on its own; that one has the new rules already.
    if (this.runs.has(sessionId)) return
    await this.send(sessionId, `${item.server} is now on (${mode}) for you in mag; repeat your last step.`, [], `${item.server} is on`)
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
    void this.summarize('task', taskId)
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
      // A topic that reviews a teammate's PR works in its scratch worktrees, never in the user's checkout.
      const scratch = this.scratches.get(session.id)
      return {
        cwd: scratch ? this.scratchRoot(session) : first,
        addDirs: [...(scratch ? project.repos : rest), this.paths.attachmentsDir, this.paths.logsDir],
        appendSystemPrompt: chatPrompt(project, this.paths.logsDir) + arch + blocks(idea ? ideaContext(idea) : '') + blocks(contextBlocks({ notes: project.notes })),
        // Bash reads tickets through CLIs like acli or gh (T-37); read only by the prompt, and never a merge or a push.
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WebSearch', 'WebFetch', 'Skill', 'mcp__mag'],
        // A topic may own a review of a teammate's PR: nothing it runs writes to a PR.
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...NO_PR_WRITES],
        readOnly: true,
      }
    }
    const task = this.store.task(session.taskId)
    const owner = this.ownerOf(session)
    const doc = this.store.data.docs[task.id] ?? ''
    // A snapshot as of the session's first run: a resumed session keeps its first system prompt; get_doc has the rest.
    const context = (stepKey?: string) => blocks(contextBlocks({ decisions: docDecisions(doc, stepKey), notes: project.notes }))
    if (session.role === 'reviewer') {
      const work = owner.work
      // Its scratch worktrees at the PR heads: tests run there, never in the developer's worktrees or the user's checkout.
      const scratch = this.scratches.get(session.id)
      return {
        cwd: scratch ? this.scratchRoot(session) : (work?.dir ?? first),
        addDirs: work ? [...project.repos, ...(scratch ? [work.dir] : [])] : rest,
        // A fork keeps the owner's system prompt; this one is for a fresh reviewer. The job and the decisions are in the message.
        appendSystemPrompt: `You are the first reviewer of a step's PRs in "mag", before the user. You never change code.` + arch + blocks(contextBlocks({ notes: project.notes })),
        // Bash for gh, git and focused tests in its scratch worktrees; nothing that edits the PR or writes to GitHub.
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WebSearch', 'WebFetch', 'Skill', 'mcp__mag'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...NO_PR_WRITES],
        readOnly: true,
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
        allowedTools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob', 'LS', 'Bash', 'WebSearch', 'WebFetch', 'Skill', 'mcp__mag'],
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
      readOnly: true,
    }
  }

  /** Where a session's scratch worktrees live: one dir per session, so two runs never share one. */
  private scratchRoot(session: AgentSession) {
    return join(this.paths.worktreesDir, session.projectId, 'scratch', session.id)
  }

  /**
   * What a session reviews at which head: a step reviewer, each PR of its step (at the heads of its review); a topic,
   * each review of a teammate's PR in progress it runs, of a repository the project has a checkout of.
   */
  private scratchTargets(session: AgentSession): (Scratch & { ref: string })[] {
    const root = this.scratchRoot(session)
    if (session.role === 'reviewer' && session.stepId) {
      const step = this.store.task(session.stepId)
      const heads = this.reviewing.get(step.id)?.heads ?? step.review?.heads ?? {}
      const work = step.work
      if (!work) return []
      return work.repos.filter((r) => r.prUrl).map((r) => ({ repo: r.repo, key: r.repo, ref: heads[r.repo] ?? r.branch, dir: join(root, repoWorkName(work, r)) }))
    }
    if (session.role !== 'chat') return []
    return this.store.data.tasks
      .filter((t) => isReview(t) && !t.imported && t.status === 'in_progress' && t.projectId === session.projectId)
      .filter((t) => t.prReview && !t.prReview.pr.outside && Object.values(t.prReview.results).some((r) => r?.sessionId === session.id))
      .map((t) => ({ repo: t.prReview!.pr.repo, key: t.id, ref: t.prReview!.pr.head, dir: join(root, t.key) }))
  }

  /** Whether the session has scratch worktrees to make, move or remove; most sessions never do. */
  private hasScratch(session: AgentSession) {
    return this.scratches.has(session.id) || this.scratchTargets(session).length > 0
  }

  /**
   * The session's scratch worktrees, made or moved to the heads it reviews now (prompts-use-the-models-to.2): a review
   * runs focused tests there, so its cwd is never the user's checkout. One that fails is left out (the run reads code
   * and CI instead); ones it no longer reviews go.
   */
  private ensureScratch(session: AgentSession): Promise<Scratch[]> {
    return this.scratchOp(session, () => this.makeScratch(session))
  }

  private scratchOp<T>(session: AgentSession, f: () => Promise<T>): Promise<T> {
    const next = (this.scratchOps.get(session.id) ?? Promise.resolve()).then(f)
    const tail = next.catch(() => {})
    this.scratchOps.set(session.id, tail)
    void tail.then(() => this.scratchOps.get(session.id) === tail && this.scratchOps.delete(session.id))
    return next
  }

  private async makeScratch(session: AgentSession): Promise<Scratch[]> {
    const targets = this.scratchTargets(session)
    const made: Scratch[] = []
    for (const { ref, ...t } of targets) {
      try {
        await scratchWorktree(t.repo, ref, t.dir)
        made.push(t)
      } catch (e) {
        log.warn('agent', `scratch worktree at ${ref.slice(0, 12)} failed: ${(e as Error).message.split('\n')[0]}`, { session: session.id })
      }
    }
    for (const old of this.scratches.get(session.id) ?? []) if (!made.some((m) => m.dir === old.dir)) await removeWorktree(old.repo, old.dir)
    if (made.length) this.scratches.set(session.id, made)
    else this.scratches.delete(session.id)
    return made
  }

  /** The run (or live process) ended: its scratch worktrees go with it. */
  private removeScratch(session: AgentSession) {
    return this.scratchOp(session, async () => {
      const scratch = this.scratches.get(session.id)
      if (!scratch) return
      this.scratches.delete(session.id)
      for (const s of scratch) await removeWorktree(s.repo, s.dir)
      rmSync(this.scratchRoot(session), { recursive: true, force: true })
    })
  }

  /**
   * Claude Code runs: integrations the role has on auto are allowed, off ones disallowed, ask ones go through the
   * approve_tool prompt. Without a chat to ask in (`canAsk` false) ask counts as off. The prompt names the ones off, so
   * the agent says so and asks for them (offIntegrationsBlock). Codex has no integrations.
   */
  private withIntegrations<S extends Omit<RunSpec, 'prompt'>>(projectId: string, role: AgentRole, agent: AgentKind, canAsk: boolean, spec: S): S {
    if (agent !== 'claude-code') return spec
    const known = this.store.data.integrations.filter((i) => i.id !== MAG_MCP_ID)
    const project = this.store.project(projectId)
    const rules = integrationRules(project, role, known)
    const ask = canAsk ? rules.ask : []
    const off = offIntegrationsBlock(project, role, known, canAsk)
    return {
      ...spec,
      ...(off && { appendSystemPrompt: `${spec.appendSystemPrompt ?? ''}${blocks(off)}` }),
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
    if (this.hasScratch(session)) await this.ensureScratch(session)
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
    // A forking session's first run (a reviewer's, a branched topic's) forks; later runs resume the fork.
    const fork = !session.nativeSessionId && !!session.forkOf && session.agent === 'claude-code'
    const resumeId = session.nativeSessionId ?? (fork ? session.forkOf! : undefined)
    const handle = adapters[session.agent].start(
      { ...spec, prompt, model: c.model ?? undefined, resumeId, forkSession: fork, mcpConfigPath },
      onEvent,
    )
    this.runs.set(session.id, handle)
    handle.done.then(() => {
      this.runs.delete(session.id)
      void this.removeScratch(session)
      if (session.status === 'running') session.status = 'idle'
      log.info('agent', `${session.role} run ended: ${session.status}`, { ...who, seconds: Math.round((Date.now() - startedAt) / 1000) })
      if (session.status === 'error') this.logSessionEvent(session, 'agent_failed', `${session.role} failed`)
      void this.afterRun(session)
      void this.nameChat(session)
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
    // After a closing process has taken its scratch along: a new one starts in its own.
    if (this.hasScratch(session)) {
      await this.ensureScratch(session)
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
    // A branched topic's first process forks its parent's session; later ones resume the fork.
    const fork = !session.nativeSessionId && !!session.forkOf && session.agent === 'claude-code'
    const resumeId = session.nativeSessionId ?? (fork ? session.forkOf! : undefined)
    log.info('agent', `${session.role} live process opened`, { ...who, resume: !!session.nativeSessionId, fork })

    const onEvent = this.onEvent(session)
    const handle = adapter.open({ ...spec, model: c.model ?? undefined, resumeId, forkSession: fork, mcpConfigPath }, (e) => {
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
      if (!this.lives.has(session.id)) void this.removeScratch(session)
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
    void this.nameChat(session)
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

  /**
   * After a chat's turn: a short generated title in place of the first message, once it lands; a failed naming runs
   * again after the next turn. A title the user gave (or mag set) meanwhile stays. Resolves when the naming run ends.
   */
  private nameChat(session: AgentSession): Promise<void> | undefined {
    if (session.role !== 'chat' || session.titleGenerated || session.status === 'error' || this.naming.has(session.id)) return
    // A topic mag started with a job (a work from an idea) is named from the job.
    const first = session.items.find((i) => i.kind === 'user' || i.kind === 'job')
    const reply = session.items.flatMap((i) => (i.kind === 'assistant' ? [i.text] : [])).join('\n\n')
    if ((first?.kind !== 'user' && first?.kind !== 'job') || !reply) return
    this.naming.add(session.id)
    const adapter = adapters[session.agent]
    let text = ''
    let failed = false
    const handle = adapter.start(
      {
        cwd: this.paths.runsDir, // neutral: no repo instructions to load
        prompt: titlePrompt(first.text || (first.kind === 'user' ? first.attachments?.[0]?.name : '') || '', reply),
        model: adapter.cheapModel,
        noTools: true,
      },
      (e) => {
        if (e.type === 'message') text += e.text
        else if (e.type === 'error' || (e.type === 'turn.done' && !e.ok)) failed = true
      },
    )
    return handle.done.then(() => {
      this.naming.delete(session.id)
      const title = failed ? null : cleanTitle(text)
      if (!title || session.titleGenerated) return
      session.title = title
      session.titleGenerated = true
      this.store.changed()
    })
  }

  /**
   * At start: topics with replies that never got a generated title (older ones, or their naming failed) are named once,
   * one after another, so a backlog does not start a process each at once.
   */
  async nameUntitled() {
    for (const s of this.store.data.sessions) if (s.role === 'chat' && !s.taskId && s.status !== 'running') await this.nameChat(s)
  }

  /**
   * An archived topic, work or review gets a summary (cheap model, no tools, like nameChat) unless the one it has covers
   * its last item. A failed run or a reply that is not a summary keeps the old one and is logged; the next Close or
   * start retries. Resolves when the run ends; never rejects.
   */
  async summarize(kind: 'topic' | 'task', id: string): Promise<void> {
    const key = `${kind}:${id}`
    if (this.summarizing.has(key)) return
    const { sessions } = this.store.data
    const item = kind === 'topic' ? sessions.find((s) => s.id === id) : this.store.data.tasks.find((t) => t.id === id)
    if (!item || !needsSummary(item, sessions)) return
    const at = summaryCovers(item, sessions)
    const prompt = summaryPrompt(summarySource(item, sessions, kind === 'task' ? this.store.data.docs[id] : ''))
    const agent = 'items' in item ? item.agent : (sessions.find((s) => s.id === item.ownerSessionId)?.agent ?? this.choice(item.projectId, 'chat').agent)
    const adapter = adapters[agent]
    this.summarizing.add(key)
    let text = ''
    let failed = false
    try {
      const handle = adapter.start({ cwd: this.paths.runsDir, prompt, model: adapter.cheapModel, noTools: true }, (e) => {
        if (e.type === 'message') text += e.text
        else if (e.type === 'error' || (e.type === 'turn.done' && !e.ok)) failed = true
      })
      await handle.done
      const summary = failed ? null : parseSummary(text)
      if (summary) this.store.setSummary(kind, id, summary, at)
      else log.warn('agent', 'summary failed; the old one stays', { [kind]: id, reply: failed ? '(run failed)' : text.slice(0, 200) })
    } catch (e) {
      log.warn('agent', 'summary failed; the old one stays', { [kind]: id, error: String(e) })
    } finally {
      this.summarizing.delete(key)
    }
  }

  /** At start: archived topics, works and reviews without a summary covering them get one, one after another. */
  async summarizeArchived() {
    for (const s of this.store.data.sessions) if (needsSummary(s, this.store.data.sessions)) await this.summarize('topic', s.id)
    for (const t of this.store.data.tasks) if (needsSummary(t, this.store.data.sessions)) await this.summarize('task', t.id)
  }

  /** Task sessions only: project chats stay out of the log. */
  private logSessionEvent(session: AgentSession, kind: 'agent_started' | 'agent_failed', text: string) {
    if (!session.taskId) return
    const task = this.store.data.tasks.find((t) => t.id === session.taskId)
    this.store.logEvent({ projectId: session.projectId, taskId: session.taskId, taskKey: task?.key ?? null, kind, text })
  }

  /** Make sure a finished run (or turn of a live session) never leaves a task silently stuck. */
  private async afterRun(session: AgentSession) {
    // An owner's turn is over: a question queued for it goes first; one sent then may still be answered in that turn.
    if ((session.role === 'chat' || session.role === 'groomer') && !session.background?.length && !this.deliverQueued(session)) this.unanswered(session)
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
      const step = session.stepId ? this.store.task(session.stepId) : null
      // Stopped without a PR or a question: told to go on once, before the user is asked (ux-odna-rozmova-na-robotu.1).
      if (step && !failed && autoFixOf(step).continue < AUTO_CONTINUES) {
        const tries = autoFixOf(step)
        const text = `You stopped without ${outcome.reason.replace(/^Developer stopped without /, '')}. Continue: finish the step and open the PR (set_pr), or complete_step if it has no code. If you cannot go on, call set_needs_input with what you need.`
        if (this.resumeDeveloper(step, text, 'Continue')) {
          this.store.updateTask(step.id, { autoFix: { ...tries, continue: tries.continue + 1 } })
          this.ownerEvent(step.id, `${step.key}: the developer stopped (${outcome.reason}); mag told it to continue`)
          return
        }
      }
      this.store.updateTask(task.id, { needsInput: outcome.reason })
      if (step) this.ownerEvent(step.id, `${step.key}: ${outcome.reason}; the user is asked`)
    }
  }
}
