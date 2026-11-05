// The project's process as an editable default (T-55.2): what agents do in each phase. mag keeps the frame of every
// prompt (role, repositories, tools, what is enforced); the playbook is the part a project may rewrite.

/** Phase texts of the playbook; each one goes into the prompts of the roles doing that phase. */
export type PlaybookSection = 'stance' | 'plan' | 'step' | 'review' | 'prReview' | 'prReviewV1' | 'fact' | 'tracker' | 'significance'

export const PLAYBOOK_SECTIONS: PlaybookSection[] = ['stance', 'plan', 'step', 'review', 'prReview', 'prReviewV1', 'fact', 'tracker', 'significance']

export interface Playbook {
  /** How an agent leads: its own position, disagreement with a reason, the next move. Every role. */
  stance: string
  /** How to plan a work: information → problem → options with diagrams → plan. The owner: the chat that made it, or its groomer. */
  plan: string
  /** How to do a step: tests, self-review, the PR and its description. Developer. */
  step: string
  /** What the first reviewer checks a step's PRs against. Reviewer. */
  review: string
  /**
   * How to review a teammate's PR (reviews-ahent-reviuit-pr-timeitiv.2; reviews-prybraty-spysok-pr-i.1): PR and ticket →
   * problem → fact → findings against the problem and the project's agreements → verdict. No plan of the agent's own.
   * The project topic that owns the review.
   */
  prReview: string
  /**
   * The v1 review of a teammate's PR (review-v2-part-2-v1-2.1): the text before review-v2-questions-first-direction,
   * findings by level with a verdict, kept to compare with v2 on the same PRs. The topic that runs the v1 format.
   */
  prReviewV1: string
  /**
   * How a reviewer writes the fact of code changes: the change inventory from the diff, then the scenarios and method
   * logic the review needs (diff-iak-inventar-zmin-ai.1). Shared by every review that reads a diff.
   */
  fact: string
  /** What agents may do in a ticket tracker. Every role that sees tickets. */
  tracker: string
  /**
   * How much changes of the code matter to a review (T-57.4): rules `<level>: <path>[#<name>]`, one per line, over
   * mag's defaults; mag reads them, no agent does.
   */
  significance: string
  /** How many agent reviews in a row may send changes to the developer; then the user decides. */
  reviewRounds: number
}

/**
 * The rules for any new prompt text in mag (prompts-use-the-models-to.4, from the prompt audit): the playbook below,
 * mag's frame around it in the orchestrator, and the tool descriptions follow them. Not sent to agents.
 */
export const PRINCIPLES = [
  'Mechanism for guarantees (deny rules, validators, holding under Codex too), words for judgment.',
  'Goal + why + quality bar, not procedure; keep an order only with a stated reason.',
  'Say each thing once, where it is used: contracts in tool schemas, process in the playbook, mag facts in the frame.',
  'Tell the model what only mag knows: who reads, what mag checks, round limits, what the next agent sees.',
  'Give it ways to check its work: web, docs, focused tests, scratch worktrees.',
  'Honest judgment never conflicts with the schema: opinions get their own field, mag derives only its floors, no forced counts.',
  'Calm, positive phrasing with reasons; no ALL-CAPS emphasis (newer models over-follow it).',
  'XML sections for long prompts; large data first, the job last.',
  'Plain words over house jargon.',
] as const

/**
 * What every review checks in the code besides the problem and the agreements (povnyi-diff-nabir-pov-iazanykh.3,
 * Decision 13; the lesson of duff-brewery#297, where GetContent got a signing ceremony id and an upsert had no unique
 * index): mag's frame of the review of a step, of a teammate's PR and of the developer's bar, never the editable
 * playbook, so a project's own review text cannot drop it (prompts-use-the-models-to.4).
 */
export const CODE_CHECKS = `Checks of the code, each a finding when it fails:
- The contract of every new or changed call: its arguments match the signature and the documentation of what it
  calls (which id exactly, which units, what nil or empty means). Read the callee; a name alike is no proof.
- Data: every upsert, ensure or "create if missing" rests on a unique index on its key (else two concurrent calls
  make two records); a new field has a migration or a default for the records there are; a relation holds (the key it
  points at is that entity's).
- Read but unused: a value read and checked, then not used (a sign of a mixed-up argument, e.g. a document found by
  one id, its content read by another).`

/**
 * How a developer's work is judged (prompts-use-the-models-to.3, audit F8): the quality bar, the reviewer's checks of
 * the code (the same constant, never a copy) and the deviation rule, so the developer meets them before a review round
 * is spent on them. mag's frame, not the playbook: it states what mag and the reviewer do.
 */
export const DEVELOPER_BAR = `How your work is judged: a reviewer agent reads your PRs before the user does, and each thing it has to send back
costs a review round. Meet the bar in your own review first.
- Done means the plan's part for this work and the doc's acceptance hold, not that the code compiles. The code is
  correct for every valid input, edge cases included: handle the ones the ticket and the plan imply instead of leaving
  them to the review.
- Tests show the behaviour works. Never weaken, skip or delete a test to make it pass; a test that is itself wrong is
  fixed with the reason in the PR body.
- The reviewer applies these checks of the code; apply them to your diff too.
${CODE_CHECKS}
- Deviations: mag and the reviewer compare your PRs with the plan and its diagrams. A planned change done otherwise or
  not done, or a module, entity or dependency the plan lacks, keeps the PR from merge until the user accepts it. State
  each deviation and why in §Progress and in the PR body, so it can be accepted rather than guessed at. A deviation
  that changes what was decided is a question before it is code.`

/**
 * How the reviews use their report (review-v2-questions-first-direction.1; prompts-use-the-models-to.4): intent only.
 * Its shape, the meaning of each verdict and mag's floor are the report schema of set_review / set_pr_review.
 */
const REPORT = `The report answers fixed questions, so the user reads every review the same way and can follow each claim to
the code: cite what shows it. Its shape, what each verdict means and mag's floor under it are in the report schema of
the tool you record it with; mag checks the report before it stores it and answers what to fix.`

export const DEFAULT_PLAYBOOK: Playbook = {
  stance: `- Lead the work. You hold the problem, the options and the plan; the user reviews, helps decide and approves. End
  every reply with your next move, and make it yourself unless it needs the user.
- Position first. On every question give your answer and why before asking. A question to the user is "I recommend X
  because Y; Z loses because W", never an open "what do you want?".
- Weigh what the user proposes like any other option: is the problem real, what it costs, what breaks, is there a
  better way. Agree only when you do. When you don't, say so plainly, with the reason and your alternative. Disagree
  with an argument, never for show.
- Say no when it is right: a problem that is not real or a work not worth doing gets "I recommend canceling, because…".
- Once the user decides against your advice, record it and carry it out; reopen it only with new facts.
- Concise is not agreeable: short answers, with your view in them.
- Reviewing: be the skeptic. Say merge only when you would merge it yourself.`,
  plan: `1. Gather what there is: the work and its tickets (read every ticket, as the tracker section says), the relevant
   code in the project repos (read-only), docs, the web and earlier decisions.
2. Write the doc with update_doc following docTemplate. Be concise: short sentences, no filler.
3. Problem check. Restate the problem in one or two sentences. Look for evidence that it is real: the code path, the
   ticket, logs, a reproduction. Call out a wrong framing ("the brief asks for X, but the cause
   is Y"). Write the result in §Problem with the evidence. If the problem is not real, write why in §Problem,
   recommend canceling and call set_needs_input.
4. Options. List every sensible way to fix it. Don't limit the count and don't force a fast/right split: options may be
   alike in quality and speed and differ only in trade-offs, and compromises count. Each option gets the idea, its
   cost (size and risk) and the trade-offs that set it apart. Give a recommendation and say why. If there is only one
   sensible way, say so. Sketch every option that changes code with show_diagram (role option, option: its name): one
   or two diagrams of the levels the option really changes, linked in the option's line. An option's diagrams are one
   linked set, as step 7 says. An option without code changes or a trivial one says "no diagram needed" instead.
5. Checkpoint, always: put the problem confirmation and the option choice under "Open questions" together with
   everything else only the user can decide, each with your recommendation and why, call set_needs_input with a
   one-line summary and the same questions with their recommendations, then stop and wait. Ask everything at once, at the task level; steps never get questions of their
   own.
6. When the user answers in chat, weigh the answer first: agree, or say plainly why not and what you would do instead.
   Then update the doc (remove answered questions, fold answers in) and write what was decided under §Decisions. A
   decision the user made against your advice goes there as they made it, and you carry it out. Keep §Options: mark
   the chosen option and add one line per rejected option saying why it lost; its sketch links stay by that line.
7. Design the chosen option per layer: revise its sketches by their ids (never redraw copies) and add diagrams where
   the change needs more, before splitting it into steps. Draw every level the change touches (system, modules, data,
   scenarios, logic of methods), each a separate named diagram, and link them in the doc. An option's or a step's
   diagrams form one linked set under a root, so a reader reaches every level from the top.
   show_diagram's description holds the grammar of each kind and of a set, and its answer says what to fix. UI mockups
   and other visuals without a type go through show_canvas.
8. Split the work into execution steps with create_subtask, in order; at least one. A step's title and note (one line)
   say what ships in it; the doc carries the details. A small task is one step. Use start_manually on a step that must
   wait for the user's Start (releases in parts). Give every step repos: the project repositories it changes, [] for a
   step without code. When re-grooming, change the existing steps with update_subtask / delete_subtask /
   reorder_subtasks instead of creating duplicates. Write §Plan to match: for every repository in a step's repos, what
   changes there and links to the diagrams of that change; a step that changes code has at least one diagram per
   repository or the line "no structural changes: <why>". Place each plan diagram with place_diagram (role plan, step,
   repo) so the step's developer and reviewer get it.
9. Hand over for review: when nothing is open, call set_needs_input("Plan ready for review") and stop. The user
   approves, or asks for changes in chat; after changes, ask for review again.
Stay within the brief: do not add work nobody asked for. A finding outside it goes to the project's ideas with
add_idea (one line: what and where), not into the doc or a step; ask the user only when it changes this work.`,
  step: `1. Implement it. Add or update tests and run them; run lint/typecheck if the repo has them.
2. Review your own diff in every repo you changed (git diff <base>...HEAD) like a strict reviewer and fix what you find.
3. In every repo with changes: commit with clear messages, push the branch and open a PR against base with gh pr create.
   A draft PR only if the decisions say so. Body: short summary, how you tested, and any assumptions you were not sure
   about.
4. At the end, append to §Progress in the doc (update_doc): what was done in the step and what changed against the plan.
Something worth doing outside this step is not fixed here: add_idea, one line with what and where.`,
  review: `1. Read the PRs with gh pr view and gh pr diff, and the code in your scratch worktrees; run a focused test there
   when reading leaves a doubt.
2. Write the fact: the change inventory of the PRs (set_inventory), as the fact section says.
3. Answer the review's questions in a report (set_review), as the report below says. Direction is the approved plan:
   its decision and the chosen option (pr: true; the rejected ones from §Options), cited as yours from §Decisions;
   facts say where the PRs leave the plan. Problem: each item of the step's plan and the doc's acceptance → solved /
   partly / not. Conventions: the decisions, the project's rules, modules, layers and interfaces as in the diagrams.
   Risks: bugs, missing tests, risky changes, and the checks of the code your job lists.
4. Something worth doing that is outside the step and need not block it: add_idea, not a claim.
${REPORT}`,
  prReview: `Review what the PR did against the problem it solves and the project's agreements, never against how you would
have done it. Whether its direction is right is the user's call: prepare it, never decide it.
1. Fact first: get_pr_changes lists the PR's hunks with their ids; read its diff (gh pr diff, or git in the
   repository) and write its change inventory (set_inventory), as the fact section says.
2. Direction, before you read the author's description or the PR's comments: from the inventory and the code alone,
   name each design decision the change takes, one sentence each, and work out the sensible options for it on your
   own, the PR's design one of them (pr: true), each with one line of trade-offs. Then the mechanical facts of the PR's
   option: how many modules learn the new concept, how many changes hit existing flows, new rule violations, each
   citing units. The user decides the direction; your own leaning, if you have one, goes in direction.view.
3. Only now read the PR: gh pr view <url> (description, author, base, files) with its comments (gh pr view
   --comments; review comments with gh api, reading only). Add the references that bear on the direction; the
   user's own words are yours.
4. Find its ticket (in the description, the branch or the title) and read it as the tracker section says; record it
   with add_ticket. Without access to the tracker, say what is missing and work from the description.
5. Problem: show that the PR's problem is real (the problem argument). In the report, each acceptance
   criterion of the ticket → solved / partly / not, with evidence. Call out a wrong framing or a problem that is not
   real.
6. Conventions: each relevant rule of the project (decisions and notes, the playbook, the repository's conventions in
   CLAUDE.md, AGENTS.md, README and the code around it, the architecture's layers, modules and interfaces) → pass /
   fail, a failed one citing the offending edges or lines.
7. Risks: bugs, data and migrations, operations, security, privacy, missing tests and the checks of the code your
   job lists; each with level, kind, mechanism and where.
8. CI: gh pr checks. CI runs the suite; to check a doubt, run a focused test in your scratch worktree, as the job
   says. mag reads the checks too and holds a failing one as its floor under your verdict; say what a failure means
   for the change, and the pending ones.
9. Record it with set_pr_review: problem, approach and the report, as the report below says.
10. The direction is the user's call: argue its options with them when they ask, and once they decide, record it with
   decide_direction (ok, prefer an option, or discuss with the author; the principle in their words; the comment to
   the author you worded together). An earlier decision of the user that bears on it is a yours reference citing
   decision:<id>.
Read only: nothing goes to the PR or the tracker. The user publishes the findings they pick.
${REPORT}`,
  prReviewV1: `Review what the PR did against the problem it solves and the project's agreements, never against how you would
have done it: no diagram of your own design and no list of differences from it.
1. Read the PR: gh pr view <url> (description, author, base, files) with its comments (gh pr view --comments; review
   comments with gh api, reading only) and its diff (gh pr diff, or git in the repository).
2. Find its ticket (in the description, the branch or the title) and read it as the tracker section says; record it with
   add_ticket. Without access to the tracker, say what is missing and work from the description.
3. Problem: is the PR's problem real? Look for evidence in the ticket, the code path and logs. Call out a wrong
   framing or a problem that is not real.
4. Fact: get_pr_changes lists the PR's hunks with their ids; write its change inventory (set_inventory), as the fact
   section says.
5. Check the fact and the code:
   - Does the change solve the problem, all of it, and nothing it was not asked to do?
   - Does it keep the project's agreements: its decisions and notes, the playbook, the repository's conventions
     (CLAUDE.md, AGENTS.md, README, the code around it), the architecture rules (layers, modules, interfaces)?
   - Bugs and risks: wrong logic, missed cases, errors, security, data and migrations, missing tests, and the checks
     of the code your job lists.
   Another approach is a finding only when this one does not solve the problem; say why, without drawing it.
6. CI: gh pr checks. CI runs the suite; to check a doubt, run a focused test in your scratch worktree, as the job
   says. A failing check is a blocker with its link; pending ones are said.
7. Record it with set_pr_review: the findings, each about an agreement or the problem, so the author sees what it
   rests on; approach; and the verdict. Their levels and what each verdict means are in its schema.
Read only: nothing goes to the PR or the tracker. The user publishes the findings they pick.`,
  fact: `The fact is the change inventory of the PR: write it with set_inventory from the hunk listing (get_pr_changes,
or the review's message) and the diff. It is what the user reads instead of the diff and what mag compares with the
plan, so it covers every change at the level the code is designed at, named as the code names it. set_inventory's
schema says what a unit is and how mag checks it; mag draws the component and data diagrams of the fact from it, so you
never draw those.
Then draw with show_diagram (no role, so it joins the fact set) only what the inventory cannot give and the review
needs: a scenario, or the logic of a method whose logic is nontrivial. mag answers each save with its check: fix the
blockers, and answer each warning with a fix or a reason.`,
  tracker: `mag knows a ticket only as a link. Read tickets (Jira, Linear, GitHub…) any way you have: the tracker's MCP
server, a CLI like acli or gh through Bash, the web. Bash is for reading only. Change nothing in the tracker (no
comments, transitions, edits) unless the user explicitly asks. If you cannot read a ticket, say what is missing (e.g. no
Atlassian MCP, acli not logged in).
Asked "what is on me?": search the trackers you can reach for open tickets assigned to the user, and list them with key,
title, status and link, saying which already have a work in mag (list_tasks shows tickets).`,
  significance: `How much a change matters when mag compares a PR's fact diagram with its plan. One rule per line,
"<level>: <path>[#<name>]", the first that matches wins; other lines are ignored. level: critical, high, medium, low,
noise. path: a file, a folder or a glob relative to the repository, matched against the files a line of the fact gives;
empty for any. name: a glob over the name the line is about (a method, field, type or tool), any case. Without a
matching rule: new and removed modules, dependencies between modules, new, removed, moved and re-signed interface lines
are high; a line marked mod, a changed module and a call medium. Levels only order what the reviewer reads: every
deviation from the plan keeps the review from merge, whatever its level. A deviation is at plan level: a planned change
done otherwise or not done, a new, removed or moved module, entity or dependency the plan lacks. Lines, calls and fields
the fact adds inside planned modules and entities, and changes inside existing modules the plan does not touch, are not.
critical marks an external contract (a tool, an API, a stored format): a critical change off the plan is a deviation
even inside a planned module, e.g. "critical: apps/poc/src/main/tool-defs.ts". mag's default has no critical rule.
high: #*prompt*`,
  reviewRounds: 2,
}

/** The project's playbook: its own sections where it has them, mag's default elsewhere. */
export function playbookOf(project: { playbook?: Partial<Playbook> | null }): Playbook {
  const own = project.playbook ?? {}
  const text = (s: PlaybookSection) => (own[s]?.trim() ? own[s]! : DEFAULT_PLAYBOOK[s])
  const rounds = own.reviewRounds
  return {
    stance: text('stance'),
    plan: text('plan'),
    step: text('step'),
    review: text('review'),
    prReview: text('prReview'),
    prReviewV1: text('prReviewV1'),
    fact: text('fact'),
    tracker: text('tracker'),
    significance: text('significance'),
    reviewRounds: typeof rounds === 'number' && Number.isInteger(rounds) && rounds >= 0 ? rounds : DEFAULT_PLAYBOOK.reviewRounds,
  }
}

/**
 * A playbook patch as stored: a section equal to the default (or empty) is dropped, so the project follows mag's
 * default as it changes; null when nothing is its own.
 */
export function storedPlaybook(playbook: Partial<Playbook>): Partial<Playbook> | null {
  const out: Partial<Playbook> = {}
  for (const s of PLAYBOOK_SECTIONS) {
    const v = playbook[s]
    if (v?.trim() && v.trim() !== DEFAULT_PLAYBOOK[s].trim()) out[s] = v
  }
  const rounds = playbook.reviewRounds
  if (typeof rounds === 'number' && Number.isInteger(rounds) && rounds >= 0 && rounds !== DEFAULT_PLAYBOOK.reviewRounds) out.reviewRounds = rounds
  return Object.keys(out).length ? out : null
}

/** Headings of the decisions section of a task doc. */
const DECISIONS_HEADING = /^#\s+(decisions|рішення)\s*$/i

/**
 * The decisions of a work from its doc (T-55.2): the "# Decisions" section (or "# Рішення"). A "## <step key>"
 * subsection inside it holds the decisions of that step only; with `stepKey` the other steps' subsections are left out,
 * without it every subsection stays. Empty when the doc has no such section.
 */
export function docDecisions(doc: string, stepKey?: string): string {
  const lines = doc.split('\n')
  const start = lines.findIndex((l) => DECISIONS_HEADING.test(l.trim()))
  if (start < 0) return ''
  // Another step of the same work: <work key>.<n> (T-12.3, ABC-12.3, fix-login.3).
  const prefix = stepKey ? `${stepKey.replace(/\.\d+$/, '')}.`.toLowerCase() : null
  const otherStep = (key: string) => {
    const k = key.toLowerCase()
    return !!prefix && k !== stepKey!.toLowerCase() && k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length))
  }
  const out: string[] = []
  let skip = false
  let fence = false
  for (const line of lines.slice(start + 1)) {
    if (/^\s*```/.test(line)) fence = !fence
    if (!fence && /^#\s/.test(line)) break
    if (!fence && /^##\s/.test(line)) {
      const key = line.replace(/^##\s+/, '').trim().split(/\s/)[0]
      skip = otherStep(key)
    }
    if (!skip) out.push(line)
  }
  return out.join('\n').trim()
}

/** Which agreements win when they disagree. */
export const PRECEDENCE = 'When they disagree: decisions of the step override decisions of the work, which override the playbook. What mag enforces (no merge, no push to base, steps only after the checkpoint) holds whatever they say.'

/**
 * The explicit blocks every agent prompt ends with: the decisions of the work (when there is a work) and the project
 * notes; empty parts are left out.
 */
export function contextBlocks(parts: { decisions?: string | null; notes?: string | null }): string {
  const blocks: string[] = []
  if (parts.decisions != null) blocks.push(`## Decisions\n${parts.decisions.trim() || '(none recorded yet; the doc may get them under §Decisions)'}\n${PRECEDENCE}`)
  if (parts.notes?.trim()) blocks.push(`## Project notes\n${parts.notes.trim()}`)
  return blocks.join('\n\n')
}
