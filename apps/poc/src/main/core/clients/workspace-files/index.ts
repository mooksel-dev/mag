// The workspace's folder on disk (~/Documents/mag/<ws>/): deliverables as deliverables/<slug>/v<N>.md, readable with
// plain tools. The folder is the record of a deliverable's text; deleting it deletes the deliverable. Workflow packs as
// packs/<kind>/<file>.md, a project's overrides as projects/<project>/packs/<kind>/<file>.md.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PACK_FILES = ['prompt', 'template', 'rubric', 'rules'] as const
export type PackFileName = (typeof PACK_FILES)[number]

/** The pack files there are in one scope, each with its path. */
export type PackFiles = Partial<Record<PackFileName, { text: string; path: string }>>

export interface WorkspaceFiles {
  /** Makes <ws>/deliverables/<slug>/, else <slug>-2, -3… when taken; returns the slug it made. */
  createDeliverable(ws: string, slug: string): string
  /** Writes v<N>.md; throws when that version exists. Returns its path. */
  writeVersion(ws: string, slug: string, n: number, md: string): string
  /** Throws when the version is not there. */
  readVersion(ws: string, slug: string, n: number): string
  /** The version numbers on disk, ascending; [] when the folder is gone. */
  versions(ws: string, slug: string): number[]
  /** Whether the deliverable's folder is there. */
  exists(ws: string, slug: string): boolean
  /** The folder of a deliverable, whether it exists or not. */
  dirOf(ws: string, slug: string): string
  versionPath(ws: string, slug: string, n: number): string
  /** Shows the path in Finder. */
  reveal(path: string): void
  /** The folder of a kind's pack: <ws>/packs/<kind>/, or with `project` <ws>/projects/<project>/packs/<kind>/. */
  packDir(ws: string, project: string | null, kind: string): string
  /** The pack files of that folder; {} when it is gone. */
  readPack(ws: string, project: string | null, kind: string): PackFiles
  /** Writes a pack file unless it is there; whether it wrote it. */
  seedPackFile(ws: string, kind: string, file: PackFileName, text: string): boolean
  /** Appends `line` to the scope's rules.md, made with `header` when missing; returns its path. */
  appendRule(ws: string, project: string | null, kind: string, line: string, header: string): string
}

/** A folder name: letters, digits and dashes; anything else (a path) is refused. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u
const VERSION = /^v([1-9]\d*)\.md$/

const named = (what: string, v: string) => {
  if (!NAME.test(v)) throw new Error(`Not a ${what} folder name: ${v}`)
  return v
}

const positive = (n: number) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Not a version: ${n}`)
  return n
}

/** `root`: ~/Documents/mag, read on every call. */
export function createWorkspaceFiles(root: () => string, open: (args: string[]) => void = (args) => void execFile('open', args)): WorkspaceFiles {
  const deliverables = (ws: string) => join(root(), named('workspace', ws), 'deliverables')
  const dirOf = (ws: string, slug: string) => join(deliverables(ws), named('deliverable', slug))
  const versionPath = (ws: string, slug: string, n: number) => join(dirOf(ws, slug), `v${positive(n)}.md`)
  const packDir = (ws: string, project: string | null, kind: string) =>
    join(root(), named('workspace', ws), ...(project === null ? [] : ['projects', named('project', project)]), 'packs', named('pack', kind))
  return {
    dirOf,
    versionPath,
    packDir,
    readPack(ws, project, kind) {
      const dir = packDir(ws, project, kind)
      const out: PackFiles = {}
      for (const f of PACK_FILES) {
        const path = join(dir, `${f}.md`)
        try {
          out[f] = { text: readFileSync(path, 'utf8'), path }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      }
      return out
    },
    seedPackFile(ws, kind, file, text) {
      const dir = packDir(ws, null, kind)
      mkdirSync(dir, { recursive: true })
      try {
        writeFileSync(join(dir, `${file}.md`), text.endsWith('\n') ? text : `${text}\n`, { flag: 'wx' })
        return true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw e
      }
    },
    appendRule(ws, project, kind, line, header) {
      const dir = packDir(ws, project, kind)
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'rules.md')
      let had = ''
      try {
        had = readFileSync(path, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        writeFileSync(path, header.endsWith('\n') ? header : `${header}\n`, { flag: 'wx' })
      }
      appendFileSync(path, `${had && !had.endsWith('\n') ? '\n' : ''}${line}\n`)
      return path
    },
    createDeliverable(ws, slug) {
      const parent = deliverables(ws)
      named('deliverable', slug)
      mkdirSync(parent, { recursive: true })
      for (let n = 1; ; n++) {
        const taken = n === 1 ? slug : `${slug}-${n}`
        try {
          mkdirSync(join(parent, taken))
          return taken
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        }
      }
    },
    writeVersion(ws, slug, n, md) {
      const dir = dirOf(ws, slug)
      const path = versionPath(ws, slug, n)
      if (!existsSync(dir)) throw new Error(`No deliverable folder ${dir}`)
      if (existsSync(path)) throw new Error(`Version ${n} of ${slug} exists`)
      const tmp = join(dir, `.v${n}.md.tmp`)
      writeFileSync(tmp, md.endsWith('\n') ? md : `${md}\n`)
      renameSync(tmp, path)
      return path
    },
    readVersion(ws, slug, n) {
      const path = versionPath(ws, slug, n)
      if (!existsSync(path)) throw new Error(`No version ${n} of ${slug}: ${path} is not there`)
      return readFileSync(path, 'utf8')
    },
    versions(ws, slug) {
      try {
        return readdirSync(dirOf(ws, slug)).flatMap((f) => {
          const m = VERSION.exec(f)
          return m ? [Number(m[1])] : []
        }).sort((a, b) => a - b)
      } catch {
        return []
      }
    },
    exists: (ws, slug) => existsSync(dirOf(ws, slug)),
    reveal: (path) => open(['-R', path]),
  }
}
