// People (who-is-who-people-from.1): a workspace's persons from its directories (Slack primary; Atlassian and GitHub
// joined by email or commit email), every handle resolved to a person in one order (the user's override, the identity,
// email, commit email), a close name only suggested. Nothing is ever written back to a directory.
import type { Workspace } from '@mag/core'
import type { Directories, DirUser } from '../../clients/directories/index.ts'
import { PEOPLE_SYSTEMS, type Identity, type IdentityOverride, type IdentitySource, type OverrideInput, type PeopleList, type PeopleSystem, type Person, type PersonView, type Resolution, type Suggestion, type SyncReport } from './types.ts'

export * from './types.ts'

/** The rows people keep; the caller stores them and is told of each change. */
export interface PeopleRows {
  persons: Person[]
  identities: Identity[]
  identityOverrides: IdentityOverride[]
}

export interface PeopleSources {
  workspace(id: string): Workspace | undefined
  /** The workspace's repositories, for commit emails and GitHub owners. */
  repos(workspaceId: string): string[]
  /** Jira keys of the workspace's labels, for its Atlassian users; empty: the whole site. */
  jiraKeys(workspaceId: string): string[]
}

export interface People {
  /** Pulls the workspace's directories and matches every handle; one sync per workspace at a time. */
  sync(workspaceId: string): Promise<SyncReport>
  /** What `handle` of `system` is, in the order override → identity → email → commit email; a close name only suggests. */
  resolve(workspaceId: string, system: PeopleSystem, handle: string): Resolution
  /** `handle` of any system (or of `system`), an email or a person id. */
  who(workspaceId: string, handle: string, system?: PeopleSystem): Resolution
  /** The user's correction, kept across syncs. */
  override(o: OverrideInput): void
  /** The user's "no" to suggesting `personId` for the handle. */
  reject(workspaceId: string, system: PeopleSystem, handle: string, personId: string): void
  /** A person who is a bot: each of its handles becomes not a person, and the person goes. */
  notPerson(workspaceId: string, personId: string): void
  /** Persons matching `q` (name, email, title or a handle; any case), best first. */
  find(workspaceId: string, q: string, limit?: number): PersonView[]
  /** The People section: every person, open suggestions, unmatched handles. */
  list(workspaceId: string): PeopleList
  /** When the workspace last synced (this run of mag, or its rows' newest syncedAt); 0: never. */
  lastSyncedAt(workspaceId: string): number
}

/** A name this close (0..1) to a person's suggests them. */
export const SUGGEST_SCORE = 0.8

export const identityId = (workspaceId: string, system: PeopleSystem, handle: string) => `${workspaceId}|${system}|${handle}`

/** A handle as stored: GitHub logins and names any case, ids as they are; no leading @. */
export function normalHandle(system: PeopleSystem, handle: string): string {
  const h = handle.trim().replace(/^@/, '')
  return system === 'github' || system === 'meeting' ? h.toLowerCase().replace(/\s+/g, ' ') : h
}

const plain = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
/** Words of a name or login, digits at a word's end dropped (bezpaluy89 → bezpaluy). */
const words = (s: string) => plain(s).split(/[^a-z0-9]+/).map((w) => w.replace(/\d+$/, '')).filter((w) => w.length > 1)

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}
const similar = (a: string, b: string) => (a && b ? 1 - distance(a, b) / Math.max(a.length, b.length) : 0)

/**
 * How close name or login `a` is to a person's name `b`, 0..1: each word of `a` against its closest word of `b`, or
 * all of `a` against `b`'s words run together in either order (ibezpaly, ievgenbezpaly).
 */
export function nameScore(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (!x.length || !y.length) return 0
  const perWord = x.reduce((sum, w) => sum + Math.max(...y.map((v) => similar(w, v))), 0) / x.length
  // One short word (al, li) says too little on its own.
  const word = x.length === 1 && x[0].length < 3 ? 0 : perWord
  const joined = x.join('')
  const whole = Math.max(similar(joined, y.join('')), similar(joined, [...y].reverse().join('')), similar(joined, y[0][0] + y.slice(1).join('')))
  return Math.max(word, whole)
}

/** A stable id from a name: lower-case words joined by dashes, made unique against `taken`. */
export function personSlug(name: string, taken: (id: string) => boolean): string {
  const base = plain(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'person'
  let id = base
  for (let n = 2; taken(id); n++) id = `${base}-${n}`
  return id
}

export function createPeople(rows: PeopleRows, sources: PeopleSources, directories: Directories, changed: () => void, now: () => number = Date.now): People {
  const running = new Map<string, Promise<SyncReport>>()
  const reports = new Map<string, SyncReport>()

  const personsOf = (ws: string) => rows.persons.filter((p) => p.workspaceId === ws)
  const person = (ws: string, id: string | null | undefined) => (id ? rows.persons.find((p) => p.id === id && p.workspaceId === ws) : undefined)
  const byEmail = (ws: string, address: string | undefined) => (address ? rows.persons.find((p) => p.workspaceId === ws && p.email === address.toLowerCase()) : undefined)
  const identity = (id: string) => rows.identities.find((i) => i.id === id)
  const overrideOf = (id: string) => rows.identityOverrides.find((o) => o.id === id)

  const view = (p: Person): PersonView => ({
    ...p,
    handles: rows.identities.filter((i) => i.personId === p.id && i.workspaceId === p.workspaceId).map((i) => ({ system: i.system, handle: i.handle, ...(i.name && { name: i.name }), source: i.source })),
  })

  /** The one person whose name is close to `names`, `rejected` aside; none when two are about as close. */
  const closest = (ws: string, names: string[], rejected: string[] = []): Person | undefined => {
    const scored = personsOf(ws)
      .filter((p) => !rejected.includes(p.id))
      .map((p) => ({ p, score: Math.max(...names.map((n) => nameScore(n, p.name))) }))
      .filter((s) => s.score >= SUGGEST_SCORE)
      .sort((a, b) => b.score - a.score)
    if (!scored.length || (scored[1] && scored[0].score - scored[1].score < 0.1)) return undefined
    return scored[0].p
  }

  const link = (row: Identity, p: Person, source: IdentitySource) => {
    if (row.personId === p.id && row.source === source) return
    row.personId = p.id
    row.source = source
    if (identity(row.id) === row) changed()
  }

  /** The flowchart of resolve, on an identity row (stored or not); a match by email or commit email is stored on it. */
  const resolveRow = (row: Identity): Resolution => {
    const o = overrideOf(row.id)
    if (o && o.personId === null) return { kind: 'notPerson' }
    const forced = o && person(row.workspaceId, o.personId)
    if (forced) {
      link(row, forced, 'override')
      return { kind: 'person', person: view(forced), source: 'override' }
    }
    const own = row.source && row.source !== 'override' ? person(row.workspaceId, row.personId) : undefined
    if (own) return { kind: 'person', person: view(own), source: row.source! }
    const mailed = byEmail(row.workspaceId, row.email)
    if (mailed) {
      link(row, mailed, 'email')
      return { kind: 'person', person: view(mailed), source: 'email' }
    }
    const committed = row.system === 'github' ? row.commitEmails?.map((e) => byEmail(row.workspaceId, e)).find(Boolean) : undefined
    if (committed) {
      link(row, committed, 'commit')
      return { kind: 'person', person: view(committed), source: 'commit' }
    }
    if (row.personId !== null) {
      // Its person is gone, or an override that pointed at one is.
      row.personId = null
      row.source = null
      if (identity(row.id) === row) changed()
    }
    const near = closest(row.workspaceId, [row.name, row.handle].filter((n): n is string => !!n), row.rejected)
    return near ? { kind: 'unknown', suggestion: view(near) } : { kind: 'unknown' }
  }

  const rowFor = (ws: string, system: PeopleSystem, raw: string): Identity => {
    const handle = normalHandle(system, raw)
    const id = identityId(ws, system, handle)
    return identity(id) ?? { id, workspaceId: ws, system, handle, personId: null, source: null, ...(system === 'meeting' && { name: raw.trim() }), syncedAt: 0 }
  }

  const newPerson = (ws: string, u: DirUser, at: number): Person => {
    const p: Person = { id: personSlug(u.name, (id) => rows.persons.some((x) => x.id === id)), workspaceId: ws, name: u.name, email: u.email ?? null, title: u.title ?? null, avatar: u.avatar ?? null, external: !!u.external, syncedAt: at }
    rows.persons.push(p)
    return p
  }

  /** A directory's details on the person: the primary directory's win, another's only fill what is missing. */
  const refresh = (p: Person, u: DirUser, primary: boolean, at: number) => {
    const set = <K extends 'name' | 'email' | 'title' | 'avatar'>(k: K, v: string | undefined) => {
      if (!v || p[k] === v || (!primary && p[k])) return
      // The workspace's emails stay unique.
      if (k === 'email' && byEmail(p.workspaceId, v)) return
      p[k] = v
    }
    set('name', u.name)
    set('email', u.email)
    set('title', u.title)
    set('avatar', u.avatar)
    if (primary) p.external = !!u.external
    p.syncedAt = at
  }

  /** Stores the directory's rows; returns the ones still without a person (overridden bots aside). */
  const take = (ws: string, users: DirUser[], primary: boolean, at: number, touched: Set<Identity>) => {
    const open: { row: Identity; user: DirUser }[] = []
    for (const raw of users) {
      if (raw.bot) continue
      const u = { ...raw, email: raw.email?.trim().toLowerCase() || undefined }
      const row = rowFor(ws, u.system, u.handle)
      if (!identity(row.id)) rows.identities.push(row)
      Object.assign(row, { name: u.name, syncedAt: at }, u.email ? { email: u.email } : {})
      touched.add(row)
      const r = resolveRow(row)
      if (r.kind === 'person') refresh(rows.persons.find((p) => p.id === r.person.id)!, u, primary, at)
      else if (r.kind === 'unknown') open.push({ row, user: u })
    }
    return open
  }

  const create = (ws: string, open: { row: Identity; user: DirUser }[], at: number) => {
    let made = 0
    for (const { row, user } of open) {
      // An earlier user of the same email made the person.
      const had = byEmail(ws, user.email)
      if (!had) made++
      link(row, had ?? newPerson(ws, user, at), had ? 'email' : 'directory')
    }
    return made
  }

  const syncNow = async (ws: string): Promise<SyncReport> => {
    const w = sources.workspace(ws)
    if (!w) throw new Error(`No workspace ${ws}`)
    const dirs = w.directories ?? {}
    const errors: string[] = []
    const pull = async (what: string, fn: () => Promise<DirUser[]>) => {
      try {
        return await fn()
      } catch (e) {
        errors.push(`${what}: ${(e as Error).message.split('\n')[0]}`)
        return null
      }
    }
    const repos = sources.repos(ws)
    const slack = dirs.slack ? await pull('Slack', () => directories.slackUsers()) : null
    const atlassian = dirs.atlassian ? await pull('Atlassian', () => directories.atlassianUsers(sources.jiraKeys(ws))) : null
    const orgs = dirs.githubOrgs ?? (await directories.githubOwners(repos).catch(() => []))
    const github: DirUser[] = []
    for (const org of orgs) github.push(...((await pull(`GitHub ${org}`, () => directories.githubMembers(org))) ?? []))

    const at = now()
    const touched = new Set<Identity>()
    // Without Slack, the other directories make the persons.
    const makes = !dirs.slack
    let made = 0
    if (slack) made += create(ws, take(ws, slack, true, at, touched), at)
    if (atlassian) {
      const open = take(ws, atlassian, makes, at, touched)
      if (makes) made += create(ws, open, at)
    }
    const openGithub = take(ws, github, false, at, touched)
    changed()
    if (openGithub.length) {
      let emails = new Map<string, string[]>()
      try {
        emails = await directories.commitEmails(repos, openGithub.map((o) => o.row.handle))
      } catch (e) {
        errors.push(`Commit emails: ${(e as Error).message.split('\n')[0]}`)
      }
      const still: typeof openGithub = []
      for (const o of openGithub) {
        const found = emails.get(o.row.handle)
        if (found?.length) o.row.commitEmails = found
        if (resolveRow(o.row).kind === 'unknown') still.push(o)
      }
      if (makes) made += create(ws, still, at)
      changed()
    }
    const report: SyncReport = {
      workspaceId: ws,
      at,
      // Each new person was made from one of the handles.
      matched: [...touched].filter((r) => r.personId).length - made,
      new: made,
      unmatched: [...touched].filter((r) => !r.personId && overrideOf(r.id)?.personId !== null).length,
      errors,
    }
    reports.set(ws, report)
    return report
  }

  const self: People = {
    sync(ws) {
      const had = running.get(ws)
      if (had) return had
      const p = syncNow(ws).finally(() => running.delete(ws))
      running.set(ws, p)
      return p
    },

    resolve: (ws, system, handle) => resolveRow(rowFor(ws, system, handle)),

    who(ws, handle, system) {
      if (system) return self.resolve(ws, system, handle)
      const h = handle.trim().replace(/^@/, '')
      const direct = person(ws, h) ?? byEmail(ws, h)
      if (direct) return { kind: 'person', person: view(direct), source: 'directory' }
      let unknown: Resolution = { kind: 'unknown' }
      for (const s of PEOPLE_SYSTEMS) {
        const id = identityId(ws, s, normalHandle(s, h))
        if (!identity(id) && !overrideOf(id)) continue
        const r = self.resolve(ws, s, h)
        if (r.kind === 'person') return r
        if (r.kind === 'notPerson' || (r.kind === 'unknown' && r.suggestion && unknown.kind === 'unknown' && !unknown.suggestion)) unknown = r
      }
      if (unknown.kind !== 'unknown' || unknown.suggestion) return unknown
      const near = closest(ws, [h])
      return near ? { kind: 'unknown', suggestion: view(near) } : unknown
    },

    override(o) {
      if (!PEOPLE_SYSTEMS.includes(o.system)) throw new Error(`A system is one of ${PEOPLE_SYSTEMS.join(', ')}`)
      if (!sources.workspace(o.workspaceId)) throw new Error(`No workspace ${o.workspaceId}`)
      const handle = normalHandle(o.system, o.handle)
      if (!handle) throw new Error('An override needs a handle')
      if (o.personId !== null && !person(o.workspaceId, o.personId)) throw new Error(`No person ${o.personId} in this workspace`)
      const id = identityId(o.workspaceId, o.system, handle)
      const row: IdentityOverride = { id, workspaceId: o.workspaceId, system: o.system, handle, personId: o.personId, at: now() }
      rows.identityOverrides = [...rows.identityOverrides.filter((x) => x.id !== id), row]
      const i = identity(id)
      if (i) Object.assign(i, o.personId ? { personId: o.personId, source: 'override' } : { personId: null, source: null })
      changed()
    },

    reject(ws, system, handle, personId) {
      const row = rowFor(ws, system, handle)
      if (!identity(row.id)) rows.identities.push(row)
      if (row.rejected?.includes(personId)) return
      row.rejected = [...(row.rejected ?? []), personId]
      changed()
    },

    notPerson(ws, personId) {
      const p = person(ws, personId)
      if (!p) throw new Error(`No person ${personId} in this workspace`)
      for (const i of rows.identities.filter((x) => x.personId === p.id)) self.override({ workspaceId: ws, system: i.system, handle: i.handle, personId: null })
      for (const o of rows.identityOverrides) if (o.personId === p.id) o.personId = null
      rows.persons = rows.persons.filter((x) => x !== p)
      changed()
    },

    find(ws, q, limit = 10) {
      const query = plain(q.trim())
      if (!query) return []
      const scored = personsOf(ws).map((p) => {
        const v = view(p)
        const text = plain([p.name, p.email ?? '', p.title ?? '', ...v.handles.flatMap((h) => [h.handle, h.name ?? ''])].join(' '))
        const score = text.includes(query) ? 1 + (plain(p.name).startsWith(query) ? 1 : 0) : nameScore(q, p.name)
        return { v, score }
      })
      return scored.filter((s) => s.score >= SUGGEST_SCORE).sort((a, b) => b.score - a.score || a.v.name.localeCompare(b.v.name)).slice(0, limit).map((s) => s.v)
    },

    list(ws) {
      const suggestions: Suggestion[] = []
      const unmatched: Identity[] = []
      for (const row of rows.identities.filter((i) => i.workspaceId === ws && !i.personId)) {
        const r = resolveRow(row)
        if (r.kind === 'unknown' && r.suggestion) suggestions.push({ system: row.system, handle: row.handle, name: row.name ?? row.handle, person: r.suggestion })
        else if (r.kind === 'unknown') unmatched.push(row)
      }
      const persons = personsOf(ws).map(view).sort((a, b) => a.name.localeCompare(b.name))
      return { persons, suggestions, unmatched, lastSync: reports.get(ws) ?? null, syncing: running.has(ws) }
    },

    lastSyncedAt(ws) {
      const r = reports.get(ws)
      if (r) return r.at
      return Math.max(0, ...rows.identities.filter((i) => i.workspaceId === ws).map((i) => i.syncedAt))
    },
  }
  return self
}
