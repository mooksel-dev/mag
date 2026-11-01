// The project's process as an editable default (T-55.2): what agents do in each phase. mag keeps the frame of every
// prompt (role, repositories, tools, what is enforced); the playbook is the part a project may rewrite.

/** Phase texts of the playbook; each one goes into the prompts of the roles doing that phase. */
export type PlaybookSection = 'plan' | 'step' | 'review' | 'tracker' | 'significance'

export const PLAYBOOK_SECTIONS: PlaybookSection[] = ['plan', 'step', 'review', 'tracker', 'significance']

export interface Playbook {
  /** How to plan a work: information → problem → options with diagrams → plan. The owner: the chat that made it, or its groomer. */
  plan: string
  /** How to do a step: tests, self-review, the PR and its description. Developer. */
  step: string
  /** What the first reviewer checks a step's PRs against. Reviewer. */
  review: string
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

export const DEFAULT_PLAYBOOK: Playbook = {
  plan: `1. Gather what there is: the work and its tickets (read every ticket, as the tracker section says), the relevant
   code in the project repos (read-only), docs and earlier decisions.
2. Write the doc with update_doc following docTemplate. Be concise: short sentences, no filler.
3. Problem check. Restate the problem in one or two sentences. Look for evidence that it is real: the code path, the
   ticket, logs, a reproduction from reading the code. Call out a wrong framing ("the brief asks for X, but the cause
   is Y"). Write the result in §Problem with the evidence. If the problem is not real, write why in §Problem,
   recommend canceling and call set_needs_input.
4. Options. List every sensible way to fix it. Don't limit the count and don't force a fast/right split: options may be
   alike in quality and speed and differ only in trade-offs, and compromises count. Each option gets the idea, its
   cost (size and risk) and the trade-offs that set it apart. Give a recommendation and say why. If there is only one
   sensible way, say so. Sketch every option that changes code with show_diagram (role option, option: its name): one
   or two diagrams of the levels the option really changes, linked in the option's line. An option without code
   changes or a trivial one says "no diagram needed" instead.
5. Checkpoint, always: put the problem confirmation and the option choice under "Open questions" together with
   everything else only the user can decide, call set_needs_input with a one-line summary, then stop and wait. Ask
   everything at once, at the task level; steps never get questions of their own.
6. When the user answers in chat, update the doc (remove answered questions, fold answers in). Write what the user
   decided under §Decisions. Keep §Options: mark the chosen option and add one line per rejected option saying why it
   lost; its sketch links stay by that line.
7. Design the chosen option per layer: revise its sketches by their ids (never redraw copies) and add diagrams where
   the change needs more, before splitting it into steps. Draw as many as the change needs, each a separate named
   diagram, and link them in the doc. UI mockups and other visuals without a type go through show_canvas.
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
  review: `1. Read the PRs with gh pr view and gh pr diff, and the code in the worktrees.
2. Check them against the decisions and this step's plan: does it do what was agreed, and nothing outside the step?
   Modules, layers and interfaces as in the diagrams? Bugs, missing tests, risky changes?
3. Something worth doing that is outside the step and need not block it: add_idea, not a finding.`,
  tracker: `mag knows a ticket only as a link. Read tickets (Jira, Linear, GitHub…) any way you have: the tracker's MCP
server, a CLI like acli or gh through Bash, the web. Bash is for reading only. Change nothing in the tracker (no
comments, transitions, edits) unless the user explicitly asks. If you cannot read a ticket, say what is missing (e.g. no
Atlassian MCP, acli not logged in).
Asked "what is on me?": search the trackers you can reach for open tickets assigned to the user, and list them with key,
title, status and link, saying which already have a work in mag (list_tasks shows tickets).`,
  significance: `How much a change of the code matters when mag compares a PR with its plan. One rule per line,
"<level>: <path>[#<name>]", the first that matches wins; other lines are ignored. level: critical, high, medium, low,
noise. path: a file, a folder or a glob relative to the repository; empty for any. name: a glob over the symbol, e.g.
Class.method or TOOL_DEFS[tool], any case. Without a matching rule: data models and infrastructure are critical;
contracts (tool definitions), dependencies between modules, exported signatures and code no adapter reads are high;
exported bodies and outside packages medium; internal code low; docs, lockfiles and tests noise. Critical and high
changes the plan does not show keep the review from saying merge.
high: #*prompt*`,
  reviewRounds: 2,
}

/** The project's playbook: its own sections where it has them, mag's default elsewhere. */
export function playbookOf(project: { playbook?: Partial<Playbook> | null }): Playbook {
  const own = project.playbook ?? {}
  const text = (s: PlaybookSection) => (own[s]?.trim() ? own[s]! : DEFAULT_PLAYBOOK[s])
  const rounds = own.reviewRounds
  return {
    plan: text('plan'),
    step: text('step'),
    review: text('review'),
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
