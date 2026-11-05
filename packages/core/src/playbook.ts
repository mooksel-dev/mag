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
 * What every review checks in the code besides the problem and the agreements (povnyi-diff-nabir-pov-iazanykh.3,
 * Decision 13; the lesson of duff-brewery#297, where GetContent got a signing ceremony id and an upsert had no unique
 * index): shared by the review of a step and of a teammate's PR.
 */
const CODE_CHECKS = `Checks of the code, each a finding when it fails:
- The contract of every new or changed call: its arguments match the signature and the documentation of what it
  calls (which id exactly, which units, what nil or empty means). Read the callee; a name alike is no proof.
- Data: every upsert, ensure or "create if missing" rests on a unique index on its key (else two concurrent calls
  make two records); a new field has a migration or a default for the records there are; a relation holds (the key it
  points at is that entity's).
- Read but unused: a value read and checked, then not used (a sign of a mixed-up argument, e.g. a document found by
  one id, its content read by another).`

/**
 * The report every review records (review-v2-questions-first-direction.1): fixed questions, claims with sources,
 * changes, the reviewer's checks verdict over mag's floors (prompts-use-the-models-to.1). Shared by the review of a
 * step and of a PR.
 */
const REPORT = `The report answers fixed questions; every item is a claim: text, source and cites (inventory unit ids or
file:line; a PR comment, decision:<id> or a note for the user's words), view (canvas:<id>#<node> of the review's set)
when a diagram shows it.
- source: agent (your reading, with code refs), yours (the user's own words: PR comments, notes, decisions), question,
  rule (a project rule fails). mag gives checked itself to a mechanical fact of the direction whose cites are all
  units it verified; never give it.
- direction: decisions, options (name, tradeoffs, pr: true on the change's own; as many as there really are, and a
  single one says why in only), facts, references. The call is the user's; your own leaning may go in view
  { leaning, why, confidence }: it never counts, and the user reads it after the options.
- problem: { criterion, status: solved | partly | not, text, source, cites }.
- conventions: { rule, status: pass | fail, text, source, cites }.
- risks: { level: high | medium | low, kind: bug | data | ops | security | privacy, text, mechanism, source, cites }.
- questions: to the author, { text, cites }.
- changes: the inventory grouped into changes by importance, each { title, why it matters, units }; routine ones
  (wiring, renames, imports) in one row with routine: true, last. Every unit in exactly one change.
- checks: { verdict, why }: your judgment on problem, conventions and risks, with one line of why. approve when you
  would merge it yourself; look when the user should decide or check something; request_changes when something must
  be fixed first, with the criterion, rule, risk or question behind it. Risk levels inform, they do not decide it, and
  direction never counts. mag keeps its own floor (a plan deviation or incomplete fact: look at least; failed CI or a
  failed architecture rule: request_changes) and attaches those blockers itself.
mag checks the report before it stores it and answers what to fix.`

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
   scenarios, logic of methods), each a separate named diagram, and link them in the doc. The diagrams of one place
   (an option, a step's plan) are one set: one is its root (root: true, the system level or the top component
   diagram), and every other is reached from it through links (links on a module, interface line, use or entity: kind
   detail, data, scenario or logic; a flowchart's of counts as logic). Every changed module with changed data, a
   scenario or the logic of a method links to that diagram; the flowchart of a private method is linked from the step
   of the flowchart that calls it. A data diagram shows stored data only (collections, tables, their fields, indexes
   and unique keys), each entity with module, its owner, and a relation for each reference field (user_id, *_id, a
   composite key) to the entity it points at, unchanged ones too; between modules or systems cross: true. Arguments
   of calls, interfaces and clients go in the signature of an interface line, never on a data diagram. Mocks and
   test-only types are on no diagram; a rename is one line, move with from. UI mockups and other visuals without a
   type go through show_canvas.
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
Something worth doing outside this step (a bug, a smell, a missed case) is not fixed here: add_idea, one line with
what and where.`,
  review: `1. Read the PRs with gh pr view and gh pr diff, and the code in your scratch worktrees; run a focused test there
   when reading leaves a doubt.
2. Write the fact: the change inventory of the PRs (set_inventory), as the fact section says.
3. Answer the review's questions in a report (set_review), as the report below says. Direction is the approved plan:
   its decision and the chosen option (pr: true; the rejected ones from §Options), cited as yours from §Decisions;
   facts say where the PRs leave the plan. Problem: each item of the step's plan and the doc's acceptance → solved /
   partly / not. Conventions: the decisions, the project's rules, modules, layers and interfaces as in the diagrams.
   Risks: bugs, missing tests, risky changes, and the checks of the code below.
4. Something worth doing that is outside the step and need not block it: add_idea, not a claim.
${REPORT}
${CODE_CHECKS}`,
  prReview: `Review what the PR did against the problem it solves and the project's agreements, never against how you would
have done it. Whether its direction is right is the user's call: prepare it, never decide it.
1. Fact first: get_pr_changes lists the PR's hunks with their ids; read its diff (gh pr diff, or git in the
   repository) and write its change inventory (set_inventory), as the fact section says.
2. Direction, before you read the author's description or the PR's comments: from the inventory and the code alone,
   name the design decision(s) the change makes, one sentence each, and work out the sensible options for it on your
   own, the PR's design one of them (pr: true), each with one line of trade-offs. Then the mechanical facts of the PR's
   option: how many modules learn the new concept, how many changes hit existing flows, new rule violations, each
   citing units. The user decides the direction; your own leaning, if you have one, goes in direction.view.
3. Only now read the PR: gh pr view <url> (description, author, base, files) with its comments (gh pr view
   --comments; review comments with gh api, reading only). Add references: the project's notes and decisions, ADRs,
   CLAUDE.md / AGENTS.md rules, earlier decisions of the user, PR threads; the user's own words are yours.
4. Find its ticket (in the description, the branch or the title) and read it as the tracker section says; record it
   with add_ticket. Without access to the tracker, say what is missing and work from the description.
5. Problem: what the PR fixes and why it is real, with evidence (problem argument). In the report, each acceptance
   criterion of the ticket → solved / partly / not, with evidence. Call out a wrong framing or a problem that is not
   real.
6. Conventions: each relevant rule of the project (decisions and notes, the playbook, the repository's conventions in
   CLAUDE.md, AGENTS.md, README and the code around it, the architecture's layers, modules and interfaces) → pass /
   fail, a failed one citing the offending edges or lines.
7. Risks: bugs, data and migrations, operations, security, privacy, missing tests and the checks of the code below;
   each with level, kind, mechanism and where.
8. CI: gh pr checks. CI runs the suite; to check a doubt, run a focused test in your scratch worktree, as the job
   says. mag reads the checks too: a failing one makes the verdict request_changes with its blocker attached; say what
   a failure means for the change, and the pending ones.
9. Record it with set_pr_review: problem, approach (how the PR solves the problem and whether it does, in a few lines)
   and the report, as the report below says.
10. The direction is the user's call: argue its options with them when they ask, and once they decide, record it with
   decide_direction (ok, prefer an option, or discuss with the author; the principle in their words; the comment to
   the author you worded together). An earlier decision of the user that bears on it is a yours reference citing
   decision:<id>.
Read only: nothing goes to the PR or the tracker. The user publishes the findings they pick.
${REPORT}
${CODE_CHECKS}`,
  prReviewV1: `Review what the PR did against the problem it solves and the project's agreements, never against how you would
have done it: no diagram of your own design and no list of differences from it.
1. Read the PR: gh pr view <url> (description, author, base, files) with its comments (gh pr view --comments; review
   comments with gh api, reading only) and its diff (gh pr diff, or git in the repository).
2. Find its ticket (in the description, the branch or the title) and read it as the tracker section says; record it with
   add_ticket. Without access to the tracker, say what is missing and work from the description.
3. Problem: what the PR fixes and why it is real, with evidence (the ticket, the code path, logs). Call out a wrong
   framing or a problem that is not real.
4. Fact: get_pr_changes lists the PR's hunks with their ids; write its change inventory (set_inventory), as the fact
   section says.
5. Check the fact and the code:
   - Does the change solve the problem, all of it, and nothing it was not asked to do?
   - Does it keep the project's agreements: its decisions and notes, the playbook, the repository's conventions
     (CLAUDE.md, AGENTS.md, README, the code around it), the architecture rules (layers, modules, interfaces)?
   - Bugs and risks: wrong logic, missed cases, errors, security, data and migrations, missing tests, and the checks
     of the code below.
   Another approach is a finding only when this one does not solve the problem; say why, without drawing it.
6. CI: gh pr checks. CI runs the suite; to check a doubt, run a focused test in your scratch worktree, as the job
   says. A failing check is a blocker with its link; pending ones are said.
7. Findings with set_pr_review, each with level (blocker: must not merge; should_fix: fix before merge unless argued;
   question: you need the author's answer; nit: optional), where (file:line) and node (canvas:<id>#<node> of the fact
   diagram) when it applies, and the agreement or the problem it is about. approach: how the PR solves the problem and
   whether it does. Verdict: request_changes with any blocker, approve when you would merge it yourself, comment
   otherwise.
Read only: nothing goes to the PR or the tracker. The user publishes the findings they pick.
${CODE_CHECKS}`,
  fact: `The fact is the change inventory of the PR: write it with set_inventory from the hunk listing (get_pr_changes,
or the review's message) and the diff. mag checks it against the hunks and generates the fact's Component and Data
diagrams from it; you never draw those.
- Every block of changed lines of a code hunk (marked [H3.1] in the listing) is in the hunks of a unit or in noise
  with why. Cite the blocks that change a unit, not the other blocks of its hunk; H3 stands for every block of H3.
  Tests, docs, styles and lock files need not be cited.
- One unit per change, by kind. method: every function or method added, removed or changed, public and private;
  before / after its signature (both for a changed one, also when only its body changes), note what it does now or
  what changes in it (required for a changed one); logic nontrivial when branches, loops, error handling, external calls or data access
  change, trivial for wiring, renames and one-liners, none when only the signature changes. model / field: a type of
  data and its fields (name "<model>.<field>"); stored: true only for persisted data (a table, collection, document,
  cache entry), never arguments, options or DTOs. index: an index or unique key added, removed or changed, owner its
  model. dependency: a module starts or stops using another module or system (name: its module id or package), not
  imports inside a module. call: a call from one module to another added, removed or with changed arguments (mod),
  one per target method: module the module that calls, name "<target module id>#<method>" ("<package>#<func>" with
  external: true outside the project), before / after the call as the code makes it. config / template: a prompt, template or config entry whose change alters behaviour, one
  per constant.
- module as the listing names the hunk's module; owner the type or file a method belongs to; names copied from the
  diff, one name per unit (never "a, b" or "a / b"). A rename is one unit, change rename with from, never a del and an
  add. Mocks, fakes and test helpers are never units.
- summary: 3–6 bullets on what the change does, by meaning.
Then draw with show_diagram (without role: it joins the fact set) only what the inventory cannot give and the review
needs: a scenario (sequence, its participants with module ids) and the logic of a method whose logic is nontrivial
(flowchart with of "<module>#<method>"). mag answers each save with its check: fix the blockers (blocks in no unit,
cited ids that do not exist, units their hunks do not bear out, units on another module, calls to no module,
several names in a unit, changed methods without before, after and note) and answer the warnings
(code blocks called noise, declarations no unit names).`,
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
