// Workflow packs (deliverables-library-claims-review-and.3): per deliverable kind, a prompt, a template, a rubric and the
// learned rules, as files in the workspace folder; a project overrides them file by file, and adds its own rules.
import { PACK_FILES, type PackFileName, type WorkspaceFiles } from '../../clients/workspace-files/index.ts'
import { DEFAULT_PACKS, RULES_HEADER } from './defaults.ts'

export { DEFAULT_PACKS } from './defaults.ts'

export type PackScopeName = 'workspace' | 'project'

/** One file of a resolved pack and where it came from. */
export interface PackPart {
  text: string
  path: string
  scope: PackScopeName
}

/** A kind's pack for a workspace and project: each file the project's when it has one, else the workspace's. */
export interface Pack {
  kind: string
  prompt: PackPart | null
  template: PackPart | null
  rubric: PackPart | null
  /** The workspace's rules, then the project's: a project adds rules, it never hides the workspace's. */
  rules: PackPart[]
}

export interface Packs {
  /** `ws`, `project`: their folder names; project null for a topic without one. Seeds the kind's defaults when its workspace pack has no file. */
  resolve(ws: string, project: string | null, kind: string): Pack
  /** Appends the rule to the rules.md of the project's pack (with `project`), else the workspace's; returns its path. */
  addRule(ws: string, project: string | null, kind: string, rule: string, why?: string): string
  /** Writes the default packs (report, assessment, proposal, reply) a workspace has no file of; returns the kinds seeded. */
  seedDefaults(ws: string): string[]
}

const RULE_LENGTH = 500

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Whether a rules.md holds any rule (a list line), not just its header. */
const hasRules = (text: string) => /^\s*[-*] \S/m.test(text)

export function createPacks(deps: { files: WorkspaceFiles; now?: () => number }): Packs {
  const { files } = deps
  const now = deps.now ?? Date.now
  const seedKind = (ws: string, kind: string) => {
    const defaults = DEFAULT_PACKS[kind]
    if (!defaults || Object.keys(files.readPack(ws, null, kind)).length) return false
    for (const f of PACK_FILES) files.seedPackFile(ws, kind, f, defaults[f])
    return true
  }
  return {
    resolve(ws, project, kind) {
      seedKind(ws, kind)
      const own = files.readPack(ws, null, kind)
      const over = project === null ? {} : files.readPack(ws, project, kind)
      const part = (f: PackFileName): PackPart | null => {
        const p = over[f] ?? own[f]
        return p ? { ...p, scope: over[f] ? 'project' : 'workspace' } : null
      }
      const rules: PackPart[] = []
      if (own.rules && hasRules(own.rules.text)) rules.push({ ...own.rules, scope: 'workspace' })
      if (over.rules && hasRules(over.rules.text)) rules.push({ ...over.rules, scope: 'project' })
      return { kind, prompt: part('prompt'), template: part('template'), rubric: part('rubric'), rules }
    },
    addRule(ws, project, kind, rule, why) {
      const text = oneLine(rule)
      if (!text) throw new Error('A rule needs its text')
      if (text.length > RULE_LENGTH) throw new Error(`A rule is one line of at most ${RULE_LENGTH} characters`)
      const reason = why ? oneLine(why) : ''
      const date = new Date(now()).toISOString().slice(0, 10)
      // A rules.md first would read as a pack the user made and keep the defaults out.
      seedKind(ws, kind)
      return files.appendRule(ws, project, kind, `- ${text}${reason ? ` (why: ${reason})` : ''} · ${date}`, RULES_HEADER)
    },
    seedDefaults(ws) {
      return Object.keys(DEFAULT_PACKS).filter((kind) => seedKind(ws, kind))
    },
  }
}

const section = (title: string, p: PackPart | null) => (p ? `### ${title}${p.scope === 'project' ? ' (the project\'s)' : ''}\n${p.text.trim()}\n` : '')

const judging = (pack: Pack) => {
  const rules = pack.rules.map((r) => `${r.scope === 'project' ? 'The project\'s:\n' : ''}${r.text.trim()}`).join('\n\n')
  return [section('Rubric', pack.rubric), rules ? `### Learned rules\n${rules}\n` : ''].filter(Boolean)
}

/** What a verifier judges a deliverable by: the pack's rubric and learned rules; '' when it has neither. */
export function rubricText(pack: Pack): string {
  const parts = judging(pack)
  return parts.length ? `## How the user judges this ${pack.kind} (its pack)\n${parts.join('\n')}` : ''
}

/** A pack as a block of an agent's prompt; '' when it has no file. */
export function packText(pack: Pack): string {
  const parts = [section('Prompt', pack.prompt), section('Template', pack.template), ...judging(pack)].filter(Boolean)
  if (!parts.length) return ''
  const paths = [pack.prompt, pack.template, pack.rubric, ...pack.rules].flatMap((p) => (p ? [p.path] : []))
  return `## The ${pack.kind} pack (mag)\nHow the user wants a ${pack.kind} done: follow it, its learned rules first. Its files: ${[...new Set(paths)].join(', ')}.\n\n${parts.join('\n')}`
}
