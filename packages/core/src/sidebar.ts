// The sidebar in the user's order (redesign-start-screen-big-composer.2, decision 9): one flat list laid out only from
// the project's stored layout, with the user's own groups. A row never moves on its own: state is a badge, filters and
// search only hide, an item the layout does not list yet goes on top by when it was created.

import type { WorkCard } from './work-list.ts'

/** An item (`work:<taskId>` | `topic:<sessionId>`) or one of the user's groups with its items in order. */
export type SidebarNode =
  | { kind: 'item'; ref: string }
  | { kind: 'group'; id: string; name: string; collapsed: boolean; items: string[] }

export type SidebarGroupNode = Extract<SidebarNode, { kind: 'group' }>

/** A group as shown: its rows in the user's order (closed and hidden ones left out). */
export interface SidebarGroup {
  id: string
  name: string
  collapsed: boolean
  rows: WorkCard[]
}

export type SidebarEntry = { kind: 'row'; card: WorkCard } | { kind: 'group'; group: SidebarGroup }

export interface SidebarRows {
  /** The main list: rows and groups in the user's order. */
  entries: SidebarEntry[]
  /** Closed items (a closed topic, a canceled work, a closed review), for "Closed" at the bottom, in layout order. */
  closed: WorkCard[]
  /** The layout as shown, every item placed (new ones on top, owner slots taken): what a move starts from. */
  layout: SidebarNode[]
}

/** The ref of a card in the layout. */
export const cardRef = (c: Pick<WorkCard, 'kind' | 'id'>) => `${c.kind === 'topic' ? 'topic' : 'work'}:${c.id}`

/** The key a move names a group by (a row is named by its ref). */
export const groupKey = (id: string) => `group:${id}`

/**
 * The sidebar from the stored layout and the project's cards (rows; a chat's children move with it). Refs whose item is
 * gone drop; the ref of a chat's child work is its chat's; a work the layout does not list whose owner topic it does
 * (and that has no row of its own) takes the topic's slot;
 * items not listed yet go on top, newest created first; closed items go to `closed`. `filter` hides rows (a group with
 * rows, all hidden, too) and never reorders.
 */
export function sidebarRows(layout: SidebarNode[], cards: WorkCard[], filter: (c: WorkCard) => boolean = () => true): SidebarRows {
  // A chat's child work stands for its chat: a layout from before chats had children listed the work in the chat's slot.
  const byRef = new Map(cards.flatMap((c) => [...(c.children ?? []).map((k): [string, WorkCard] => [cardRef(k), c]), [cardRef(c), c]]))
  const listed = new Set(layout.flatMap((n) => (n.kind === 'item' ? [n.ref] : n.items)))
  // The topic slot each work not listed yet takes: the newest such work of that owner.
  const slots = new Map<string, WorkCard>()
  for (const c of [...cards].sort((a, b) => b.createdAt - a.createdAt)) {
    const owner = c.kind !== 'topic' ? c.task?.ownerSessionId : null
    if (!owner || listed.has(cardRef(c)) || byRef.has(`topic:${owner}`)) continue
    if (!slots.has(`topic:${owner}`)) slots.set(`topic:${owner}`, c)
  }
  const used = new Set<string>()
  const resolve = (ref: string): WorkCard | null => {
    const c = byRef.get(ref) ?? slots.get(ref) ?? null
    if (!c || used.has(cardRef(c))) return null
    used.add(cardRef(c))
    return c
  }
  const placed: { node: SidebarNode; cards: WorkCard[] }[] = []
  for (const n of layout) {
    if (n.kind === 'item') {
      const c = resolve(n.ref)
      if (c) placed.push({ node: { kind: 'item', ref: cardRef(c) }, cards: [c] })
    } else {
      const rows = n.items.map(resolve).filter((c): c is WorkCard => !!c)
      placed.push({ node: { ...n, items: rows.map(cardRef) }, cards: rows })
    }
  }
  const fresh = cards.filter((c) => !used.has(cardRef(c))).sort((a, b) => b.createdAt - a.createdAt)
  const all = [...fresh.map((c) => ({ node: { kind: 'item', ref: cardRef(c) } as SidebarNode, cards: [c] })), ...placed]

  const entries: SidebarEntry[] = []
  const closed: WorkCard[] = []
  for (const { node, cards: rows } of all) {
    for (const c of rows) if (c.closed && filter(c)) closed.push(c)
    const open = rows.filter((c) => !c.closed)
    if (node.kind === 'item') {
      if (open.length && filter(open[0])) entries.push({ kind: 'row', card: open[0] })
      continue
    }
    const shown = open.filter(filter)
    if (open.length && !shown.length) continue
    entries.push({ kind: 'group', group: { id: node.id, name: node.name, collapsed: node.collapsed, rows: shown } })
  }
  return { entries, closed, layout: all.map((x) => x.node) }
}

/** Takes a row (by ref) or a group (by groupKey) out of the layout; returns the rest and what was taken. */
function take(layout: SidebarNode[], key: string): [SidebarNode[], SidebarNode | null] {
  let taken: SidebarNode | null = null
  const rest: SidebarNode[] = []
  for (const n of layout) {
    if (n.kind === 'group') {
      if (groupKey(n.id) === key) { taken = n; continue }
      if (n.items.includes(key)) { taken = { kind: 'item', ref: key }; rest.push({ ...n, items: n.items.filter((r) => r !== key) }); continue }
    } else if (n.ref === key) { taken = n; continue }
    rest.push(n)
  }
  return [rest, taken]
}

/**
 * Moves a row (its ref) into a group or the top level (`groupId` null) at `index` of that list (clamped), or a group
 * (its groupKey) to `index` of the top level; groups do not nest. A ref the layout does not list yet is placed there.
 */
export function moveRef(layout: SidebarNode[], key: string, groupId: string | null, index: number): SidebarNode[] {
  const [rest, taken] = take(layout, key)
  const node: SidebarNode = taken ?? { kind: 'item', ref: key }
  if (node.kind === 'group' && groupId) throw new Error('A group cannot go into a group')
  if (groupId === null) {
    const at = Math.max(0, Math.min(index, rest.length))
    return [...rest.slice(0, at), node, ...rest.slice(at)]
  }
  if (!rest.some((n) => n.kind === 'group' && n.id === groupId)) throw new Error(`No group ${groupId}`)
  return rest.map((n) => {
    if (n.kind !== 'group' || n.id !== groupId) return n
    const at = Math.max(0, Math.min(index, n.items.length))
    return { ...n, items: [...n.items.slice(0, at), (node as { ref: string }).ref, ...n.items.slice(at)] }
  })
}

/**
 * Where a new item created from a group's + goes: first in that group (`groupId`), or, without a group, where any new
 * item goes (on top, by not being listed: the layout is returned as it is).
 */
export function placeNew(layout: SidebarNode[], ref: string, groupId: string | null): SidebarNode[] {
  if (!groupId || !layout.some((n) => n.kind === 'group' && n.id === groupId)) return layout
  return moveRef(layout, ref, groupId, 0)
}

/** A new empty group on top. `id` is the caller's (unique in the layout). */
export function addGroup(layout: SidebarNode[], name: string, id: string): SidebarNode[] {
  if (layout.some((n) => n.kind === 'group' && n.id === id)) throw new Error(`Group ${id} exists`)
  return [{ kind: 'group', id, name: name.trim() || 'New group', collapsed: false, items: [] }, ...layout]
}

const patchGroup = (layout: SidebarNode[], id: string, f: (g: SidebarGroupNode) => SidebarGroupNode) =>
  layout.map((n) => (n.kind === 'group' && n.id === id ? f(n) : n))

export function renameGroup(layout: SidebarNode[], id: string, name: string): SidebarNode[] {
  const t = name.replace(/\s+/g, ' ').trim()
  return t ? patchGroup(layout, id, (g) => ({ ...g, name: t })) : layout
}

export function toggleGroup(layout: SidebarNode[], id: string): SidebarNode[] {
  return patchGroup(layout, id, (g) => ({ ...g, collapsed: !g.collapsed }))
}

/** Deletes a group; its rows stay, in its place and order. */
export function removeGroup(layout: SidebarNode[], id: string): SidebarNode[] {
  return layout.flatMap((n) => (n.kind === 'group' && n.id === id ? n.items.map((ref): SidebarNode => ({ kind: 'item', ref })) : [n]))
}
