// The fact of code changes (T-57.4, T-58; one service since reviews-ahent-reviuit-pr-timeitiv.1): the files some
// commits change with their numbered hunks, the change inventory a reviewer writes of them (diff-iak-inventar-zmin-ai.1),
// mag's check of it against the hunks, the Component and Data diagrams mag generates from it and, when there is one, the
// plan (compare). It knows no step: a step's PRs (against its plan) and a teammate's PR (no plan:
// reviews-prybraty-spysok-pr-i.1) are two callers of the same diff.
import {
  diagramWarnings, inventoryDiagrams, logicUnit, parseFlowRef, playbookOf, setRoot, validateLinks,
  type ArchNode, type Canvas, type ChangeInventory, type ComponentDiagram, type DataDiagram, type Diagram, type Project, type SequenceDiagram,
} from '@mag/core'
import {
  checkInventory, compare, createDiff, diagramChanges, folderVocabulary, formatComparison, formatFiles, formatHunks, formatInventoryCheck, inventoryBlockers, mergeBlockers, numberHunks, parseSignificance, planVocabulary, withLevels,
  type Comparison, type FileChange, type FileDiff, type HunkRef, type InventoryCheck, type Vocabulary,
} from '@mag/diff'

/** Where the changes are read from: a local git checkout, later a PR's diff on GitHub. `at` is where it reads a repository. */
export interface ChangeSource {
  /** The files changed between two commits, renames detected, each with its hunks and their lines (with context). */
  diffHunks(at: string, base: string, head: string): Promise<FileDiff[]>
  /** The lines of one hunk of a file between two commits. */
  hunkLines(at: string, base: string, head: string, hunk: HunkRef): Promise<string[]>
}

/** One repository's changes: from `base` to `head`, read by the source at `at`. */
export interface ChangeTarget {
  /** The repository's path in the project. */
  repo: string
  name: string
  at: string
  base: string
  head: string
  /**
   * A repository the project has no architecture of (a teammate's PR outside the project, reviews-ahent-reviuit-pr-timeitiv.3):
   * its modules are its folders.
   */
  outside?: boolean
}

export interface FactRepo {
  /** The repository's path. */
  repo: string
  name: string
  baseSha: string
  headSha: string
}

export interface Changes {
  /** One per target, in their order. */
  repos: FactRepo[]
  /** The files changed, of every repository, with their hunks numbered H1… in this order, their lines among them. */
  files: FileChange[]
  /** Read without the project's architecture: modules by folder (a target outside the project). */
  outside: boolean
}

export interface Fact extends Changes {
  /** The plan set the fact is compared with; null when there is no plan to compare (a teammate's PR). */
  plan: Canvas[] | null
  /** The fact set: its diagrams in the order they were drawn; [] before the review writes its inventory. */
  set: Canvas[]
  /** The root of the fact set, the generated Component diagram with the inventory; null before there is one. */
  canvas: Canvas | null
  inventory: ChangeInventory | null
  /** The inventory against the hunks; null without an inventory. */
  inventoryCheck: InventoryCheck | null
  /** Plan ↔ fact; empty without a plan. */
  comparison: Comparison
  /**
   * Where the fact set does not hang together (root, links, orphans: validateLinks), where a drawn diagram breaks a
   * rule of the diff (diagramWarnings), and flowcharts of no method with nontrivial logic.
   */
  warnings: string[]
  blockers: string[]
}

/** A repository outside the project in the plan's modules first, then by its folders. */
function outsideVocabulary(plan: Diagram[], diffs: FileDiff[]): Vocabulary {
  const own = planVocabulary([], plan).modules
  const folders = folderVocabulary(diffs.map((d) => d.path)).modules.filter((m) => !own.some((o) => o.id === m.id))
  return { modules: [...own, ...folders] }
}

/**
 * The files the targets change, each from its base to its head, in the vocabulary of the project's architecture plus
 * the modules the plan adds, their hunks numbered across the targets. A target outside the project: the plan's
 * modules, then its folders.
 */
export async function changes(project: Project, targets: ChangeTarget[], source: ChangeSource, plan: Canvas[] = []): Promise<Changes> {
  const diagrams = plan.map((c) => c.diagram!)
  const vocabulary = planVocabulary(project.architecture?.modules ?? [], diagrams)
  const repos: FactRepo[] = []
  const files: FileChange[] = []
  for (const t of targets) {
    repos.push({ repo: t.repo, name: t.name, baseSha: t.base, headSha: t.head })
    const diffs = await source.diffHunks(t.at, t.base, t.head)
    const words = t.outside ? outsideVocabulary(diagrams, diffs) : vocabulary
    files.push(...(await createDiff({ diffHunks: async () => diffs }).changedFiles({ path: t.at, name: t.name }, t.base, t.head, words)))
  }
  return { repos, files: numberHunks(files), outside: targets.some((t) => t.outside) }
}

/** The files without the lines of their hunks: what leaves the main process. */
export const withoutLines = (files: FileChange[]): FileChange[] => files.map((f) => ({ ...f, hunks: f.hunks.map(({ lines: _, ...h }) => h) }))

/** The root of a fact set: the diagram with the inventory, else (a set drawn before) its marked root. */
export const factRoot = (set: Canvas[]) => set.find((c) => c.inventory) ?? setRoot(set) ?? null

/** The set's diagrams mag generates from the inventory (its Component and Data); the rest the reviewer draws. */
export const generated = (c: Canvas) => c.diagram!.type === 'component' || c.diagram!.type === 'data'

/** The files of the blocks or hunks with these ids. */
export function filesOfHunks(files: FileChange[]): (ids: string[]) => string[] {
  const repos = new Set(files.map((f) => f.repo))
  const byHunk = new Map(files.flatMap((f) => f.hunks.map((h) => [h.id, repos.size > 1 ? `${f.repo}:${f.path}` : f.path] as const)))
  return (ids) => [...new Set(ids.map((id) => byHunk.get(id.split('.')[0])).filter((p): p is string => !!p))]
}

/** The scenarios of a set, which the generated Component diagram links from the modules that take part in them. */
export const scenariosOf = (set: Canvas[]) => set.flatMap((c) => (c.diagram!.type === 'sequence' ? [{ id: c.id, diagram: c.diagram as SequenceDiagram }] : []))

/** The fact's Component and Data diagrams from an inventory over the changes: what set_inventory saves. */
export function factDiagrams(inventory: ChangeInventory, changed: Changes, project: Project, set: Canvas[], dataId?: string): { component: ComponentDiagram; data: DataDiagram | null } {
  const architecture: ArchNode[] = changed.outside ? [] : (project.architecture?.modules ?? [])
  return inventoryDiagrams(inventory, architecture, { filesOf: filesOfHunks(changed.files), dataId, scenarios: scenariosOf(set) })
}

/** Why a flowchart cannot be of a fact set: its of names no method unit with nontrivial logic. null when it can. */
export function flowchartRefusal(inventory: ChangeInventory | null, diagram: Diagram): string | null {
  if (diagram.type !== 'flowchart') return null
  if (!inventory) return 'Write the inventory first (set_inventory): a flowchart of the fact shows the logic of one of its methods.'
  const ref = diagram.of ? parseFlowRef(diagram.of) : null
  if (!ref) return 'A flowchart of the fact needs of "<module>#<method>": a method unit of the inventory with logic nontrivial.'
  if (!logicUnit(inventory, ref.module, ref.method)) return `${diagram.of} is no method unit of the inventory with logic nontrivial: give of a nontrivial method (module and last segment of its name), or fix its unit.`
  return null
}

/**
 * The fact set against the changed hunks (the inventory's check) and the plan set (compare), levelled by the
 * playbook's rules, and what keeps the review from merge. `plan` null: nothing to compare with (a teammate's PR), so
 * only the code counts; [] is a step without a plan, where everything on the fact is unplanned. A set drawn before the
 * inventory has none: it blocks until the review is restarted.
 */
export function check(project: Project, changed: Changes, set: Canvas[], plan: Canvas[] | null): Fact {
  // The project's architecture says nothing of a repository outside it.
  const architecture = changed.outside ? [] : (project.architecture?.modules ?? [])
  const { repos, files } = changed
  const canvas = factRoot(set)
  const inventory = canvas?.inventory ?? null
  const rules = parseSignificance(playbookOf(project).significance)
  // The inventory has no calls: a planned call cannot be on the fact, so only modules, lines and uses compare.
  const planned = withLevels((plan ?? []).flatMap((c) => diagramChanges(c.diagram!)).filter((c) => !inventory || c.kind !== 'call'), rules)
  const fact = withLevels((inventory ? [canvas!] : set).flatMap((c) => diagramChanges(c.diagram!)), rules)
  const comparison = plan ? compare(planned, fact, architecture) : { items: [] }
  const inventoryCheck = inventory ? checkInventory(inventory, files) : null
  // Without code to show, no inventory is needed.
  const code = files.some((f) => f.kind === 'code')
  const own = inventoryCheck
    ? inventoryBlockers(inventoryCheck)
    : !code
      ? []
      : set.length
        ? ['the fact set has no inventory (drawn before mag checked inventories): restart the review']
        : ['there is no inventory of the PRs yet: the review writes it with set_inventory']
  const drawn = set.filter((c) => !inventory || !generated(c))
  const flows = inventory ? drawn.flatMap((c) => (flowchartRefusal(inventory, c.diagram!) ? [`"${c.title}" (${c.id}): its of ${(c.diagram as { of?: string }).of ?? '(none)'} is no method of the inventory with logic nontrivial.`] : [])) : []
  return {
    repos, files, outside: changed.outside, plan, set, canvas, inventory, inventoryCheck, comparison,
    warnings: set.length ? [...validateLinks(set), ...drawn.flatMap((c) => diagramWarnings(c.diagram!).map((w) => `"${c.title}" (${c.id}): ${w}`)), ...flows] : [],
    blockers: mergeBlockers(comparison, own),
  }
}

const link = (c: Canvas) => `[${c.title}](canvas:${c.id})`

/**
 * What the reviewer reads of a fact: the changed files, the inventory's check against the hunks, where the set does
 * not hang together, and plan ↔ fact when there is a plan to compare with. The hunks themselves are formatHunks'.
 */
export function factReport(fact: Fact): string {
  const plan = fact.plan
  const c = fact.canvas
  const others = fact.set.filter((x) => x !== c)
  const rest = others.length ? ` Other diagrams of the set: ${others.map((x) => `${link(x)} (${x.diagram!.type}, v${x.version})`).join(', ')}.` : ''
  const code = fact.files.some((f) => f.kind === 'code')
  const diagram = fact.inventory
    ? `Fact set: root ${link(c!)} (v${c!.version}), generated from the inventory (${fact.inventory.units.length} units).${rest}`
    : !code
      ? 'Fact: none needed, the PRs change no code.'
      : fact.set.length
        ? `Fact set: drawn before inventories, without one: write the inventory with set_inventory; mag replaces its Component and Data diagrams.${rest}`
        : 'Fact: no inventory yet: write it with set_inventory from the hunks below.'
  const outside = fact.outside ? ['Without the project architecture: the repository is outside the project, its modules are its folders (packages).'] : []
  const plans = plan && (plan.length ? plan.map(link).join(', ') : 'none: the step has no plan diagram, so nothing it changes is planned')
  const head = plan ? ['## Plan ↔ fact (mag)', `Plan diagrams: ${plans}.`] : ['## Fact (mag)']
  const out = [...head, diagram, ...outside, '', '### Changed files', ...fact.repos.map((r) => formatFiles(r.name, r.baseSha, r.headSha, fact.files.filter((f) => f.repo === r.name)))]
  if (fact.inventoryCheck) out.push('', '### Inventory against the hunks', formatInventoryCheck(fact.inventoryCheck))
  if (fact.warnings.length) out.push('', `### Where the fact set does not hang together or breaks a rule of the diff (${fact.warnings.length})`, ...fact.warnings.map((w) => `- ${w}`))
  if (plan) out.push('', '### Plan ↔ fact', ...(fact.inventory ? ['(Calls are not in the inventory: planned calls are not compared.)'] : []), formatComparison(fact.comparison, fact.blockers))
  else out.push('', fact.blockers.length ? `### The fact is not complete yet\n${fact.blockers.map((b) => `  - ${b}`).join('\n')}` : '### The fact is complete: the inventory accounts for every block of changed code and rests on its hunks.')
  return out.join('\n')
}

/** How much of the hunks a reviewer's round message carries; get_pr_changes gives the rest. */
export const ROUND_HUNKS_CHARS = 40_000

/** The hunks of the changes as an inventory cites them, under a heading, at most about `maxChars`; '' without code hunks. */
export function hunkListing(changed: Pick<Changes, 'files'>, maxChars = Infinity): string {
  const text = formatHunks(changed.files, maxChars)
  return text ? `### Hunks (cite their blocks in the inventory)\n${text}` : ''
}

const SHA = /^[0-9a-f]{7,64}$/

/** The lines of one hunk between two commits of a repository the source reads at `at`. */
export async function hunk(source: ChangeSource, at: string, base: string, head: string, ref: HunkRef): Promise<string[]> {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error('base and head must be commit shas')
  return source.hunkLines(at, base, head, ref)
}
