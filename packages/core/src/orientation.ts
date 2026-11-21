// What every agent is told about mag itself (prompts-use-the-models-to.5, audit F6, F9, F10 and its missing guidance):
// how mag works as goal + why + what mag does with it, who reads the agent's output, and the words mag uses. mag's
// frame, never the editable playbook: these are facts only mag knows (Principle 4), so a project's text cannot drop them.

import type { Project, Workspace } from './index.ts'

/**
 * How mag works, said once for every role: the lifecycle, who reads what, steps and PRs, the doc as the only handoff,
 * the diagram kinds, plan ↔ fact and what mag checks. `rounds`: the playbook's reviewRounds.
 */
export function howMagWorks(rounds: number): string {
  const limit = rounds
    ? `up to ${rounds} review round${rounds > 1 ? 's' : ''} in a row; after that the user decides`
    : 'never on its own: this project sends every review to the user'
  return `## How mag works
The user wants to steer problems, plans and decisions rather than agent sessions, and to review a change at the level
of its design first (modules and how they interact, layers, interfaces, stored data), reading code only when there is
time. Everything below serves that.
- A work is planned by its owner in the doc: the problem with the evidence that it is real, the options with their
  diagrams, the user's decisions, then the steps. mag creates steps only after the user has answered the owner, so the
  user picks the direction before anything is planned in detail. The user approves the plan (the work is ready) and
  starts it.
- Each step gets a fresh developer session from fresh base, its own branch and a worktree per repository it changes,
  and at most one PR per repository, so every PR can be reviewed and merged on its own. The developer knows only the
  doc, the decisions, the step's plan diagrams and the code: the doc is the only handoff between agents, so it has to
  stand on its own. A developer's question goes to the owner first, who answers it or asks the user with a
  recommendation.
- When a step's PRs are open, the owner reviews them first, in a fork of itself, so the user gets a verdict with
  reasons rather than a raw diff. A review that asks for changes goes back to the developer, ${limit}; merge and look go
  to the user. Only the user merges: mag blocks merges and pushes to the base branch for every agent.
- A step is done when its PRs are merged (a step without code is closed by its developer); the next one starts on its
  own unless it waits for the user's Start. A done work that needs more is reopened, never duplicated.
- Diagrams are how the user reads a change: component (modules, interfaces, calls; at the system level also the
  boundaries they run in, such as cloud accounts and VPCs, and numbered flows; click a module to go inside), sequence
  (a scenario), state, flowchart (an algorithm or the logic of one method) and data (stored data). The plan's diagrams say what will change;
  the fact is drawn from the PR's diff. mag compares the two (plan ↔ fact), so a deviation is seen, not guessed.
- What mag checks itself, so you spend your judgment on what it cannot: diagrams and the change inventory when they are
  saved, plan ↔ fact, CI of open PRs, and the architecture rules where the project enforces them. A review's verdict
  never goes below what these show.`
}

/**
 * Who reads an agent's output and how (audit, missing guidance): the reason to be short and to lead with the answer. No
 * role: the user's comes from their workspace profile (workspaces-and-labels-project-as.3).
 */
export const THE_USER = `## Who reads you
The user leads several works at once through mag and reads you between other things, in a narrow chat pane, the doc
and the diagrams. Their role and how they work come from their profile below, when there is one; assume no role beyond
it. Lead with the answer and your view, keep chat short, and put detail where it lasts: the doc, a diagram or a canvas.`

/** mag's house words in plain terms (audit F9), so the model reads them as the user does. */
export const GLOSSARY = `## Words mag uses
- work: one problem the user wants solved, from plan to done: merged PRs, or a doc or a decision (stored as a task);
  its key is a ticket key or a slug, e.g. ABC-12. step: one part of a work that ships on its own, e.g. ABC-12.3.
- owner: the agent that planned a work (a chat topic or a groomer); it answers the developers and reviews first.
- the doc: the work's document: problem, options, decisions, plan, progress.
- fact: the change as made, written by a reviewer from the PR's diff as the change inventory (its units: modules,
  methods, entities, dependencies) and drawn by mag.
- look: a verdict that hands the call to the user without asking for changes.
- idea: one line on the project's list, worth doing, that nobody works on yet; it has no status.
- canvas: an HTML page mag shows the user; diagrams are drawn by mag from typed data.
- user (as a source of a claim): the user's own words, in PR comments, notes or decisions, as opposed to your reading.`

/** The user's workspace profile, in their words; empty without one. */
export function profileBlock(profile: string): string {
  const text = profile.trim()
  return text ? `## The user\nIn their own words, from the workspace profile:\n${text}` : ''
}

/** What the workspace card may take of a prompt, in tokens. */
export const CARD_TOKENS = 200

/** A rough count of tokens: about four characters each, as for English text. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4)

const NAME_CHARS = 40
const clip = (name: string) => (name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1)}…` : name)

/** The prefix of a workspace's refs: its name in lower case, spaces and colons as dashes (aura:topic:…). */
export const workspacePrefix = (w: Pick<Workspace, 'name'>) => w.name.trim().toLowerCase().replace(/[\s:]+/g, '-')

/**
 * Where an agent is (workspaces-and-labels-project-as.3), in at most CARD_TOKENS: its workspace, project and labels, how
 * refs look, the other workspaces and the tools that reach them. Lists that do not fit end with "+N more".
 */
export function workspaceCard(ws: Pick<Workspace, 'name'>, project: Pick<Project, 'name'> | null, labels: { group: string; name: string }[], others: Pick<Workspace, 'name'>[] = []): string {
  const render = (ls: string[], lsMore: number, os: string[], osMore: number) => {
    const more = (n: number) => (n ? ` +${n} more` : '')
    const lines = [
      `## Where you are`,
      `Workspace ${clip(ws.name)}, ${project ? `project ${clip(project.name)}` : 'no project'}${ls.length || lsMore ? `; labels: ${ls.join(', ')}${more(lsMore)}` : ''}.`,
      `Refs here: topic:<id>, work:<key>.${os.length || osMore ? ` Other workspaces: ${os.join(', ')}${more(osMore)}; their refs start with the workspace, e.g. ${workspacePrefix(others[0])}:work:<key>.` : ''}`,
      `On the user's ask, list_chats (scope project, workspace or all), read_chat and read_task read any project or workspace; list_workspaces lists them.`,
    ]
    return lines.join('\n')
  }
  const ls = labels.map((l) => clip(`${l.group}: ${l.name}`))
  const os = others.map((o) => clip(o.name))
  let [nl, no] = [ls.length, os.length]
  let card = render(ls, 0, os, 0)
  while (approxTokens(card) > CARD_TOKENS && (nl || no)) {
    if (nl >= no) nl--
    else no--
    card = render(ls.slice(0, nl), ls.length - nl, os.slice(0, no), os.length - no)
  }
  return card
}

/**
 * The blocks every system prompt of a role in a work, or of a topic, carries: how mag works, who reads, the user's
 * profile and where the agent is (both left out when empty), and the glossary.
 */
export function orientation(rounds: number, profile = '', card = ''): string {
  return [howMagWorks(rounds), THE_USER, profileBlock(profile), card.trim(), GLOSSARY].filter(Boolean).join('\n\n')
}
