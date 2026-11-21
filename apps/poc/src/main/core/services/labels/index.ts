// Labels (workspaces-and-labels-project-as.2): label groups, labels and the labels of items; settings resolved along an
// item's labels; labels set from match rules on an item's own signals. Each workspace has a system group Project
// (exclusive) whose labels are its projects: an item's Project label is its projectId, the rest are item label rows.
import { randomUUID } from 'node:crypto'
import { DEFAULT_PLAYBOOK, MATCH_RULE_KINDS, PROJECT_COLORS, docDecisions, projectColor, projectGroupId, projectLabel as labelOfProject, type ItemLabel, type ItemRef, type Label, type LabelGroup, type LabelGroupInput, type LabelInput, type MatchRule, type Project, type Workspace } from '@mag/core'

/** The rows labels keep; the caller stores them and is told of each change. */
export interface LabelRows {
  labelGroups: LabelGroup[]
  labels: Label[]
  itemLabels: ItemLabel[]
}

/** Where an item is: its workspace, its Project label (null: none) and, for a work or a step, its doc. */
export interface ItemPlace {
  workspaceId: string
  projectId: string | null
  /** A work's or step's doc (a step: its work's) and the step's key; none for a topic. */
  doc?: { text: string; stepKey?: string }
}

/** What labels reads and changes outside its own rows. */
export interface LabelSources {
  workspaces(): Workspace[]
  projects(): Project[]
  /** null: no such item. */
  item(ref: ItemRef): ItemPlace | null
  /** Moves the item to project `projectId` (null: none); throws when it can't move. */
  setProject(ref: ItemRef, projectId: string | null): void
  /** A Project label's name or color is its project's. */
  updateProject(id: string, patch: { name?: string; color?: string | null }): void
}

/** An item's own signals that rules match. */
export interface Signals {
  repos?: string[]
  ticketKeys?: string[]
  channels?: string[]
  /** The project the item was opened from. */
  openedFrom?: string | null
}

/** The settings a workspace, a project and a work's §Decisions layer; see resolve. */
export interface Settings {
  notes: string
  repos: string[]
  playbook: Partial<typeof DEFAULT_PLAYBOOK>
  agents: Project['agents']
  integrations: Project['integrations']
}

export const SETTINGS_DEFAULT: Settings = { notes: '', repos: [], playbook: DEFAULT_PLAYBOOK, agents: {}, integrations: {} }


export interface Labels {
  /** The workspace's groups, Project first. */
  groups(workspaceId: string): LabelGroup[]
  /** The group's labels; the Project group's are its workspace's projects. */
  labels(groupId: string): Label[]
  /** Creates the workspace's Project group when it has none; idempotent. */
  ensureSystem(workspaceId: string): LabelGroup
  /** Creates (no id) or changes a user group; names are unique per workspace. A system group can't change. */
  upsertGroup(group: LabelGroupInput): LabelGroup
  /** Removes a user group with its labels and their item labels. */
  deleteGroup(groupId: string): void
  /** Creates (no id) or changes a label; names are unique per group. A Project label is an existing project's. */
  upsertLabel(label: LabelInput): Label
  /** Removes a user label and its item labels. */
  deleteLabel(labelId: string): void
  /** The item's labels: its Project label first. */
  labelsOf(ref: ItemRef): Label[]
  /** Puts a label on an item; in an exclusive group it replaces the item's other label. A rule never replaces a user's. */
  setLabel(ref: ItemRef, labelId: string, by: ItemLabel['by']): void
  /** Takes a label off an item; the Project label: the item goes to no project. */
  removeLabel(ref: ItemRef, labelId: string): void
  /** Drops the labels of an item that is gone. */
  forget(ref: ItemRef): void
  /** The value of setting `key` (a dotted path, e.g. notes, playbook.review, agents.chat) for the item: see resolve. */
  resolve(ref: ItemRef, key: string): unknown
  /** Every setting of the item, each resolved as resolve does. */
  settings(ref: ItemRef): Settings
  /** Labels set from the rules matching `signals`, in groups the item has no label in; returns those set. */
  autoLabel(ref: ItemRef, signals: Signals): Label[]
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const systemId = projectGroupId
const rowId = (ref: ItemRef, labelId: string) => `${ref}|${labelId}`

/** A value counts as set unless it is missing, null, blank, or an empty list or object. */
export function isSet(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return !!v.trim()
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v).length > 0
  return true
}

function at(obj: unknown, path: string[]): unknown {
  let v = obj
  for (const k of path) {
    if (v === null || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[k]
  }
  return v
}

/**
 * The settings a work's §Decisions set: lines "- `key`: value" (a dotted key, value as JSON, else text), e.g.
 * "- `playbook.reviewRounds`: 3"; a step's own subsection applies to it only.
 */
export function decisionSettings(doc: string, stepKey?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of docDecisions(doc, stepKey).split('\n')) {
    const m = /^\s*[-*]\s+`([A-Za-z][\w.]*)`\s*:\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    let value: unknown = m[2]
    try {
      value = JSON.parse(m[2])
    } catch {
      // Text, as written.
    }
    const path = m[1].split('.')
    let node = out
    for (const k of path.slice(0, -1)) node = (node[k] && typeof node[k] === 'object' ? node[k] : (node[k] = {})) as Record<string, unknown>
    node[path.at(-1)!] = value
  }
  return out
}

/** How deep each setting merges across layers: a ModelChoice or a playbook section is one value, integrations go by role and id. */
const MERGE_DEPTH: Record<keyof Settings, number> = { notes: 0, repos: 0, playbook: 1, agents: 1, integrations: 2 }

/** `values` (most specific first) merged `depth` levels down; below that, the first set value wins. */
function mergeLayers(values: unknown[], depth: number): unknown {
  if (depth === 0) return values.find(isSet) ?? values.find((v) => v !== undefined)
  const objects = values.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
  const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))]
  return Object.fromEntries(keys.map((k) => [k, mergeLayers(objects.map((o) => o[k]), depth - 1)]).filter(([, v]) => v !== undefined))
}

function settingsOf(x: Pick<Project, 'notes' | 'repos' | 'playbook' | 'agents' | 'integrations'>): Partial<Settings> {
  return { notes: x.notes, repos: x.repos, playbook: x.playbook ?? undefined, agents: x.agents, integrations: x.integrations }
}

function cleanRules(rules: MatchRule[] | undefined): MatchRule[] {
  return (rules ?? []).map((r) => {
    if (!MATCH_RULE_KINDS.includes(r?.kind)) throw new Error(`A rule's kind is one of ${MATCH_RULE_KINDS.join(', ')}`)
    const value = String(r.value ?? '').trim()
    if (!value) throw new Error(`A ${r.kind} rule needs a value`)
    return { kind: r.kind, value }
  })
}

const folder = (path: string) => path.replace(/\/+$/, '').split('/').at(-1) ?? path
const channel = (c: string) => c.trim().replace(/^#/, '').toLowerCase()
const keyPrefix = (k: string) => k.trim().toUpperCase().replace(/-\d*$/, '')

function matches(rule: MatchRule, s: Signals, projects: Project[]): boolean {
  switch (rule.kind) {
    case 'repo':
      return (s.repos ?? []).some((r) => same(r, rule.value) || same(folder(r), folder(rule.value)))
    case 'jiraKey':
      return (s.ticketKeys ?? []).some((k) => keyPrefix(k) === keyPrefix(rule.value))
    case 'channel':
      return (s.channels ?? []).some((c) => channel(c) === channel(rule.value))
    case 'openedFrom': {
      const p = s.openedFrom ? projects.find((x) => x.id === s.openedFrom) : undefined
      return !!p && (p.id === rule.value || same(p.name, rule.value))
    }
  }
}

export function createLabels(rows: LabelRows, sources: LabelSources, changed: () => void): Labels {
  const group = (id: string) => {
    const g = rows.labelGroups.find((x) => x.id === id)
    if (!g) throw new Error(`No label group ${id}`)
    return g
  }
  const place = (ref: ItemRef) => {
    const p = sources.item(ref)
    if (!p) throw new Error(`No item ${ref}`)
    return p
  }
  const projectLabel = (p: Project): Label => labelOfProject(p, rows.labels)
  const groupLabels = (g: LabelGroup): Label[] =>
    g.system === 'project' ? sources.projects().filter((p) => p.workspaceId === g.workspaceId).map(projectLabel) : rows.labels.filter((l) => l.groupId === g.id)
  const label = (id: string): { label: Label; group: LabelGroup } => {
    const own = rows.labels.find((l) => l.id === id && !group(l.groupId).system)
    if (own) return { label: own, group: group(own.groupId) }
    const p = sources.projects().find((x) => x.id === id)
    if (p) return { label: projectLabel(p), group: self.ensureSystem(p.workspaceId) }
    throw new Error(`No label ${id}`)
  }
  const dropRows = (keep: (r: ItemLabel) => boolean) => {
    const before = rows.itemLabels.length
    rows.itemLabels = rows.itemLabels.filter(keep)
    return before !== rows.itemLabels.length
  }
  const inGroup = (ref: ItemRef, g: LabelGroup) => rows.itemLabels.filter((r) => r.itemRef === ref && rows.labels.some((l) => l.id === r.labelId && l.groupId === g.id))

  const self: Labels = {
    groups(workspaceId) {
      const mine = rows.labelGroups.filter((g) => g.workspaceId === workspaceId)
      return [...mine.filter((g) => g.system), ...mine.filter((g) => !g.system)]
    },

    labels: (groupId) => groupLabels(group(groupId)),

    ensureSystem(workspaceId) {
      const id = systemId(workspaceId)
      const had = rows.labelGroups.find((g) => g.id === id)
      if (had) return had
      const name = rows.labelGroups.some((g) => g.workspaceId === workspaceId && same(g.name, 'Project')) ? 'Project (system)' : 'Project'
      // As old as its workspace: the same on every store that makes it.
      const g: LabelGroup = { id, workspaceId, name, exclusive: true, system: 'project', createdAt: sources.workspaces().find((w) => w.id === workspaceId)?.createdAt ?? 0 }
      rows.labelGroups.push(g)
      changed()
      return g
    },

    upsertGroup(input) {
      const name = input.name?.trim()
      if (!name) throw new Error('A label group needs a name')
      if (!sources.workspaces().some((w) => w.id === input.workspaceId)) throw new Error(`No workspace ${input.workspaceId}`)
      if (rows.labelGroups.some((g) => g.workspaceId === input.workspaceId && g.id !== input.id && same(g.name, name))) throw new Error(`A label group named ${name} exists`)
      if (!input.id) {
        const g: LabelGroup = { id: randomUUID(), workspaceId: input.workspaceId, name, exclusive: !!input.exclusive, system: null, createdAt: Date.now() }
        rows.labelGroups.push(g)
        changed()
        return g
      }
      const g = group(input.id)
      if (g.system) throw new Error(`${g.name} is a system group`)
      if (g.workspaceId !== input.workspaceId) throw new Error('A label group stays in its workspace')
      if (input.exclusive && !g.exclusive) {
        const refs = rows.itemLabels.filter((r) => rows.labels.some((l) => l.id === r.labelId && l.groupId === g.id)).map((r) => r.itemRef)
        const doubled = refs.find((r, i) => refs.indexOf(r) !== i)
        if (doubled) throw new Error(`${doubled} has several labels of ${g.name}: leave one before making it exclusive`)
      }
      Object.assign(g, { name, exclusive: !!input.exclusive })
      changed()
      return g
    },

    deleteGroup(groupId) {
      const g = group(groupId)
      if (g.system) throw new Error(`${g.name} is a system group`)
      const gone = new Set(rows.labels.filter((l) => l.groupId === g.id).map((l) => l.id))
      rows.labels = rows.labels.filter((l) => l.groupId !== g.id)
      rows.labelGroups = rows.labelGroups.filter((x) => x.id !== g.id)
      dropRows((r) => !gone.has(r.labelId))
      changed()
    },

    upsertLabel(input) {
      const g = group(input.groupId)
      const name = input.name?.trim()
      if (!name) throw new Error('A label needs a name')
      const color = input.color?.trim() || undefined
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Not a color: ${color}; pass #rrggbb`)
      const rules = input.rules && cleanRules(input.rules)
      const siblings = groupLabels(g)
      if (siblings.some((l) => l.id !== input.id && same(l.name, name))) throw new Error(`${g.name} has a label named ${name}`)
      if (g.system === 'project') {
        const p = sources.projects().find((x) => x.id === input.id && x.workspaceId === g.workspaceId)
        if (!p) throw new Error('A Project label is a project of the workspace: create the project')
        if (name !== p.name || (color && color !== projectColor(p))) sources.updateProject(p.id, { name, ...(color && { color }) })
        if (rules) {
          rows.labels = rows.labels.filter((l) => !(l.id === p.id && l.groupId === g.id))
          if (rules.length) rows.labels.push({ id: p.id, groupId: g.id, name, color: color ?? projectColor(p), rules })
          changed()
        }
        return projectLabel(sources.projects().find((x) => x.id === p.id)!)
      }
      if (!input.id) {
        const l: Label = { id: randomUUID(), groupId: g.id, name, color: color ?? PROJECT_COLORS[siblings.length % PROJECT_COLORS.length], rules: rules ?? [] }
        rows.labels.push(l)
        changed()
        return l
      }
      const l = rows.labels.find((x) => x.id === input.id && x.groupId === g.id)
      if (!l) throw new Error(`No label ${input.id} in ${g.name}`)
      Object.assign(l, { name, ...(color && { color }), ...(rules && { rules }) })
      changed()
      return l
    },

    deleteLabel(labelId) {
      const { label: l, group: g } = label(labelId)
      if (g.system) throw new Error(`${l.name} is a project: it goes with the project`)
      rows.labels = rows.labels.filter((x) => x.id !== labelId)
      dropRows((r) => r.labelId !== labelId)
      changed()
    },

    labelsOf(ref) {
      const p = place(ref)
      const project = p.projectId ? sources.projects().find((x) => x.id === p.projectId) : undefined
      const own = rows.itemLabels.filter((r) => r.itemRef === ref).flatMap((r) => rows.labels.filter((l) => l.id === r.labelId))
      return [...(project ? [projectLabel(project)] : []), ...own]
    },

    setLabel(ref, labelId, by) {
      const p = place(ref)
      const { group: g } = label(labelId)
      if (g.workspaceId !== p.workspaceId) throw new Error(`Label ${labelId} is of another workspace`)
      if (g.system === 'project') {
        if (p.projectId !== labelId && !(by === 'rule' && p.projectId)) sources.setProject(ref, labelId)
        return
      }
      const here = inGroup(ref, g)
      const had = here.find((r) => r.labelId === labelId)
      if (by === 'rule' && here.some((r) => r.by === 'user')) return
      if (had && had.by === by) return
      if (had) had.by = by
      else rows.itemLabels.push({ id: rowId(ref, labelId), itemRef: ref, labelId, by })
      if (g.exclusive) dropRows((r) => !(r.itemRef === ref && r.labelId !== labelId && here.includes(r)))
      changed()
    },

    removeLabel(ref, labelId) {
      const p = place(ref)
      if (p.projectId === labelId) return sources.setProject(ref, null)
      if (dropRows((r) => !(r.itemRef === ref && r.labelId === labelId))) changed()
    },

    forget(ref) {
      if (dropRows((r) => r.itemRef !== ref)) changed()
    },

    resolve(ref, key) {
      const path = key.split('.').filter(Boolean)
      for (const layer of layersOf(ref)) {
        const v = at(layer, path)
        if (isSet(v)) return v
      }
      return at(SETTINGS_DEFAULT, path)
    },

    settings(ref) {
      const layers = [...layersOf(ref), SETTINGS_DEFAULT] as (Record<string, unknown> | undefined)[]
      return Object.fromEntries((Object.keys(MERGE_DEPTH) as (keyof Settings)[]).map((k) => [k, mergeLayers(layers.map((l) => l?.[k]), MERGE_DEPTH[k])])) as unknown as Settings
    },

    autoLabel(ref, signals) {
      const p = place(ref)
      const projects = sources.projects()
      const set: Label[] = []
      for (const g of [self.ensureSystem(p.workspaceId), ...self.groups(p.workspaceId).filter((x) => !x.system)]) {
        const filled = g.system === 'project' ? !!p.projectId : inGroup(ref, g).length > 0
        if (filled) continue
        const hits = groupLabels(g).filter((l) => l.rules.some((r) => matches(r, signals, projects)))
        if (!hits.length) continue
        let take = hits
        if (g.exclusive && hits.length > 1) {
          const from = hits.filter((l) => (g.system === 'project' && l.id === signals.openedFrom) || l.rules.some((r) => r.kind === 'openedFrom' && matches(r, signals, projects)))
          take = from.length === 1 ? from : []
        }
        for (const l of take) {
          self.setLabel(ref, l.id, 'rule')
          set.push(l)
        }
      }
      return set
    },
  }

  /** The item's settings layers, most specific first: its work's §Decisions, its project, its workspace. */
  function layersOf(ref: ItemRef): unknown[] {
    const p = place(ref)
    const project = p.projectId ? sources.projects().find((x) => x.id === p.projectId) : undefined
    const workspace = sources.workspaces().find((w) => w.id === p.workspaceId)
    return [p.doc ? decisionSettings(p.doc.text, p.doc.stepKey) : undefined, project && settingsOf(project), workspace && settingsOf(workspace)]
  }

  return self
}
