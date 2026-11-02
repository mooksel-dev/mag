// The fact of code changes against their intent (T-57.4, T-58; one service since reviews-ahent-reviuit-pr-timeitiv.1):
// the files some commits change, the fact diagram a reviewer draws of them as a revision of the intent, and mag's check
// of it against the files (coverage, grounding) and the intent (compare). It knows no step: a step's PRs (intent: its
// plan) and a teammate's PR (intent: what its ticket asks) are two callers of the same diff.
import { findNode, playbookOf, walkArch, type Canvas, type ComponentDiagram, type DNode, type Diagram, type Project } from '@mag/core'
import { compare, coverage, createDiff, describe, diagramChanges, folderVocabulary, formatComparison, formatFiles, grounding, mergeBlockers, parseSignificance, planVocabulary, withLevels, type Comparison, type Coverage, type FileChange, type FileDiff, type Grounding, type HunkRef, type Vocabulary } from '@mag/diff'

/** Where the changes are read from: a local git checkout, later a PR's diff on GitHub. `at` is where it reads a repository. */
export interface ChangeSource {
  /** The files changed between two commits, renames detected, each with its hunks. */
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
  /** The files changed, of every repository. */
  files: FileChange[]
  /** Read without the project's architecture: modules by folder (a target outside the project). */
  outside: boolean
}

/** What the intent of the changes is called: a step's plan, or the intent of a teammate's PR. */
export type IntentName = 'plan' | 'intent'

export interface Fact extends Changes {
  /** The intent diagrams: a step's plan, or what a reviewed PR is meant to do. */
  intent: Canvas[]
  /** The fact diagram; null before the review starts one. */
  canvas: Canvas | null
  comparison: Comparison
  /** null without a fact diagram. */
  coverage: Coverage | null
  grounding: Grounding | null
  blockers: string[]
}

/** A repository outside the project in the intent's modules first, then by its folders. */
function outsideVocabulary(intent: Diagram[], diffs: FileDiff[]): Vocabulary {
  const own = planVocabulary([], intent).modules
  const folders = folderVocabulary(diffs.map((d) => d.path)).modules.filter((m) => !own.some((o) => o.id === m.id))
  return { modules: [...own, ...folders] }
}

/**
 * The files the targets change, each from its base to its head, in the vocabulary of the project's architecture plus
 * the modules the intent adds. A target outside the project: the intent's modules, then its folders.
 */
export async function changes(project: Project, targets: ChangeTarget[], source: ChangeSource, intent: Canvas[] = []): Promise<Changes> {
  const diagrams = intent.map((c) => c.diagram!)
  const vocabulary = planVocabulary(project.architecture?.modules ?? [], diagrams)
  const repos: FactRepo[] = []
  const files: FileChange[] = []
  for (const t of targets) {
    repos.push({ repo: t.repo, name: t.name, baseSha: t.base, headSha: t.head })
    const diffs = await source.diffHunks(t.at, t.base, t.head)
    const words = t.outside ? outsideVocabulary(diagrams, diffs) : vocabulary
    files.push(...(await createDiff({ diffHunks: async () => diffs }).changedFiles({ path: t.at, name: t.name }, t.base, t.head, words)))
  }
  return { repos, files, outside: targets.some((t) => t.outside) }
}

/**
 * Where the reviewer starts the fact diagram: a copy of the intent diagrams (several: their modules together, each id
 * once). Without intent: the modules that own the changed code, unmarked, to draw the fact from scratch. `of` names
 * what the fact is of (a step's key, a PR). null when there is nothing to draw.
 */
export function seed(of: string, intent: Canvas[], files: FileChange[], architecture: Project['architecture'], name: IntentName = 'plan'): ComponentDiagram | null {
  const modules: DNode[] = []
  const ids = new Set<string>()
  const take = (n: DNode) => {
    const inner: string[] = []
    walkArch([n], (m) => inner.push(m.id))
    if (inner.some((id) => ids.has(id))) return
    inner.forEach((id) => ids.add(id))
    modules.push(structuredClone(n))
  }
  for (const c of intent) for (const n of (c.diagram as ComponentDiagram).modules) take(n)
  if (intent.length) {
    const titles = intent.map((c) => `"${c.title}"`).join(', ')
    return { type: 'component', summary: `Fact of ${of}, started as a copy of its ${name} ${titles}: the reviewer revises it under the diff.`, modules }
  }
  for (const id of new Set(files.filter((f) => f.kind === 'code' && f.module).map((f) => f.module!))) {
    const arch = findNode(architecture?.modules ?? [], id)
    take({ id, name: arch?.name ?? id, description: arch?.description ?? '', uses: [] })
  }
  if (!modules.length) return null
  return { type: 'component', summary: `Fact of ${of}: no ${name} diagram, the reviewer draws the fact from the diff over these modules.`, modules }
}

/**
 * The fact diagram against the changed files (coverage, grounding) and the intent diagrams (compare), levelled by the
 * playbook's rules, and what keeps the review from merge.
 */
export function check(project: Project, changed: Changes, canvas: Canvas | null, intent: Canvas[]): Fact {
  // The project's architecture says nothing of a repository outside it.
  const architecture = changed.outside ? [] : (project.architecture?.modules ?? [])
  const { repos, files } = changed
  const rules = parseSignificance(playbookOf(project).significance)
  const planned = withLevels(intent.flatMap((c) => diagramChanges(c.diagram!)), rules)
  const fact = canvas ? withLevels(diagramChanges(canvas.diagram!), rules) : []
  const comparison = compare(planned, fact, architecture)
  // Without code to show, no fact diagram is needed.
  const nothing = !files.some((f) => f.kind === 'code')
  const cover = canvas ? coverage(files, canvas.diagram!) : nothing ? { shown: [], unshown: [] } : null
  const ground = canvas ? grounding(canvas.diagram!, files, architecture) : nothing ? { grounded: [], unverified: [] } : null
  return { repos, files, outside: changed.outside, intent, canvas, comparison, coverage: cover, grounding: ground, blockers: mergeBlockers(comparison, cover, ground) }
}

const link = (c: Canvas) => `[${c.title}](canvas:${c.id})`

/**
 * What the reviewer reads of a fact: the changed files, what the fact diagram does not show or ground, intent ↔ fact.
 * `name`: what the intent is called (a step's plan, a reviewed PR's intent).
 */
export function factReport(fact: Fact, started: number | null, name: IntentName = 'plan'): string {
  const Name = name === 'plan' ? 'Plan' : 'Intent'
  const none = name === 'plan' ? 'none: the step has no plan diagram, so nothing it changes is planned' : 'none yet: draw the intent (role intent) first, then call get_pr_changes again'
  const plans = fact.intent.length ? fact.intent.map(link).join(', ') : none
  const c = fact.canvas
  const diagram = !c
    ? 'Fact diagram: none, the PRs change no code.'
    : c.version === started
      ? `Fact diagram: ${link(c)} (v${c.version}), mag's copy of the ${name}: nothing on it rests on the PR yet.`
      : `Fact diagram: ${link(c)} (v${c.version}), revised.`
  const outside = fact.outside ? ['Without the project architecture: the repository is outside the project, its modules are its folders (packages).'] : []
  const out = [`## ${Name} ↔ fact (mag)`, `${Name} diagrams: ${plans}.`, diagram, ...outside, '', '### Changed files', ...fact.repos.map((r) => formatFiles(r.name, r.baseSha, r.headSha, fact.files.filter((f) => f.repo === r.name)))]
  const unshown = fact.coverage?.unshown ?? []
  if (unshown.length) out.push('', `### Changed code the fact diagram does not show (${unshown.length})`, ...unshown.map((f) => `- ${f.repo}:${f.path} (${f.module ?? 'no module'})`))
  const unverified = fact.grounding?.unverified ?? []
  if (unverified.length) out.push('', `### Lines of the fact that do not rest on the PR (${unverified.length})`, ...unverified.map((u) => `- ${describe(u.change)}: ${u.reason}${u.files.length ? ` (${u.files.join(', ')})` : ''}`))
  out.push('', `### ${Name} ↔ fact`, formatComparison(fact.comparison, fact.blockers))
  return out.join('\n')
}

const SHA = /^[0-9a-f]{7,64}$/

/** The lines of one hunk between two commits of a repository the source reads at `at`. */
export async function hunk(source: ChangeSource, at: string, base: string, head: string, ref: HunkRef): Promise<string[]> {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error('base and head must be commit shas')
  return source.hunkLines(at, base, head, ref)
}
