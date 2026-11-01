// The draft of a fact diagram (T-57.4): a PR's changes as a Component diagram, for the reviewer to add what they mean.
import { findNode, looksGrouped, walkArch, type ArchNode, type ComponentDiagram, type DLine, type DNode } from '@mag/core'
import { UNOWNED, extId, isMemberOf } from './compare.ts'
import { LEVELS } from './significance.ts'
import { moduleResolver } from './vocabulary.ts'
import type { Change, ChangeSet, Level, Vocabulary } from './types.ts'

/** The lowest level a draft draws: what a reader of the architecture would miss. */
const DRAWN: Level = 'medium'
const drawn = (c: Change) => !c.test && (!c.level || LEVELS.indexOf(c.level) <= LEVELS.indexOf(DRAWN))

/** An interface line for an element: its signature from the method name on, else the name alone. */
function lineText(c: Change, sig: string | undefined): string {
  const contract = /\[([^\]]+)\]$/.exec(c.name!)
  const short = contract ? contract[1] : c.name!.split('.').at(-1)!
  const at = sig ? sig.indexOf(short) : -1
  const text = at >= 0 ? sig!.slice(at) : short
  return looksGrouped(text) ? short : text
}

/**
 * The fact of a step's PRs as a draft Component diagram: the modules with changes at `medium` or above, their
 * interface lines (a changed signature is a del line and an add line, a changed body a mod line; a new or removed
 * class or interface without its members) and the dependencies
 * that appear or go away. Outside packages are modules of their own; code no module owns is `unowned`. `vocabulary`
 * resolves where a moved element came from.
 */
export function factDiagram(facts: ChangeSet[], architecture: ArchNode[], vocabulary: Vocabulary): ComponentDiagram | null {
  const changes = facts.flatMap((cs) => cs.changes).filter(drawn)
  const modules = new Map<string, DNode>()
  const fromPath = moduleResolver(vocabulary)
  const node = (id: string): DNode => {
    let n = modules.get(id)
    if (!n) {
      const arch = findNode(architecture, id)
      const name = id === UNOWNED ? 'Code without a module' : id.startsWith('ext-') ? id.slice(4) : (arch?.name ?? id)
      n = { id, name, description: arch?.description ?? '', uses: [], interface: [], ...(id.startsWith('ext-') && { kind: 'package' }) }
      // A module the architecture does not have yet is new.
      if (!arch && id !== UNOWNED && !id.startsWith('ext-')) n.diff = 'add'
      modules.set(id, n)
    }
    return n
  }
  const lines = (id: string) => node(id).interface!

  const elements = changes.filter((c) => c.kind === 'element')
  // A new or removed class or interface is one line, not one per member.
  for (const c of elements.filter((c) => !elements.some((o) => isMemberOf(c, o)))) {
    const id = c.module ?? UNOWNED
    const out: DLine[] = lines(id)
    if (c.diff === 'add') out.push({ text: lineText(c, c.after), diff: 'add' })
    else if (c.diff === 'del') out.push({ text: lineText(c, c.before), diff: 'del' })
    else if (c.diff === 'mod' && c.part === 'signature') out.push({ text: lineText(c, c.before), diff: 'del' }, { text: lineText(c, c.after), diff: 'add' })
    else if (c.diff === 'mod') out.push({ text: lineText(c, c.after), diff: 'mod' })
    else {
      const from = c.from ? fromPath(c.from.replace(/^[^:]*:/, '').split('#')[0]) : null
      if (from && from !== id) {
        node(from)
        out.push({ text: lineText(c, c.after), diff: 'move', from })
      } else out.push({ text: lineText(c, c.after), diff: 'add' })
    }
  }
  for (const c of changes.filter((c) => c.kind === 'edge' && c.diff !== 'mod')) {
    const to = c.name!.startsWith('ext:') ? extId(c.name!) : c.name!
    const from = node(c.module ?? UNOWNED)
    node(to)
    if (!from.uses.some((u) => u.to === to)) from.uses.push({ to, calls: [], diff: c.diff as 'add' | 'del' })
  }
  if (!modules.size) return null
  // Architecture order, then new modules, then outside packages and unowned code.
  const order: string[] = []
  walkArch(architecture, (n) => order.push(n.id))
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : id === UNOWNED ? 1e6 + 1 : id.startsWith('ext-') ? 1e6 : order.length)
  const out = [...modules.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
  for (const n of out) if (!n.interface!.length) delete n.interface
  const count = changes.filter((c) => c.kind !== 'file').length
  return {
    type: 'component',
    summary: `Draft from the code of the PR: ${count} change(s) at ${DRAWN} or above in ${out.filter((n) => n.interface || n.uses.length).length} module(s). The reviewer says what they mean.`,
    modules: out,
  }
}
