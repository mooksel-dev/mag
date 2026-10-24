// Architecture analyzer for any TypeScript/JavaScript repository.
//
// Apps:    every package.json (each workspace package separately; the root only if it holds code).
// Modules: children of layer folders (services/, clients/, lib/, utils/, components/, hooks/, handlers/...)
//          found at any depth, otherwise top-level folders of the app's source root.
// Layers:  from the folder name when it says so; otherwise inferred from the dependency graph
//          (nobody imports it -> app, imports nothing internal -> lib, talks to DB/API SDKs -> client,
//          the rest -> service). Inferred layers are marked and never produce rule violations.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import type { ArchModule, ArchReport, Layer, Violation } from './types.ts'
import { collectExports, importsOf } from './parse.ts'
import { layerRule } from '@mag/core'

export type { ArchModule, ArchReport, ExportedApi, Layer, Violation } from './types.ts'

export const ARCH_RULES = `Architecture (enforced in this project):
- Each app has core/lib, core/clients, core/services; everything else in the app is the app layer
  (React hooks/components/pages, HTTP handlers, workers...).
- core/lib/<name>: project libraries. Any layer may use them; lib may use other lib, never clients or services.
- core/clients/<name>: one per other runtime (3rd-party API, database, queue, storage...). Hides the
  implementation and exposes an interface in our domain terms. Clients never use other clients or services.
- core/services/<name>: business logic for one whole area of responsibility; may combine several clients.
  Services never use other services. A service exports a clear interface; design that interface first.
- The app layer uses services (and lib). Using a client directly from the app layer is a smell.
- core never imports from the app layer.
If the repo has no core yet and you add app logic, create it with this structure.`

/** Folder names that state a layer. Their children are modules of that layer. */
export const LAYER_FOLDERS: Record<string, Layer> = {
  lib: 'lib', libs: 'lib', utils: 'lib', util: 'lib', helpers: 'lib', shared: 'lib', common: 'lib',
  clients: 'client', client: 'client', adapters: 'client', integrations: 'client', gateways: 'client',
  repositories: 'client', providers: 'client',
  services: 'service', service: 'service', domain: 'service', usecases: 'service', 'use-cases': 'service',
  components: 'app', pages: 'app', hooks: 'app', routes: 'app', handlers: 'app', controllers: 'app',
  workers: 'app', screens: 'app', views: 'app', ui: 'app', commands: 'app', jobs: 'app',
}

/** Imports that mean "this module talks to another runtime". */
const CLIENT_SDKS = [
  /^(pg|mysql2?|mongodb|mongoose|redis|ioredis|kafkajs|amqplib|bullmq|nats|sqlite3|better-sqlite3|knex|drizzle-orm|typeorm|sequelize)$/,
  /^@prisma\//, /^@aws-sdk\//, /^@google-cloud\//, /^firebase(-admin)?$/, /^@supabase\//,
  /^(axios|got|node-fetch|ky|undici|graphql-request)$/, /^(stripe|openai|@anthropic-ai\/sdk|twilio|@sendgrid\/mail|nodemailer)$/,
]

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', '.turbo', '.cache'])
const isSource = (f: string) => SOURCE_EXT.includes(extname(f)) && !f.endsWith('.d.ts')
const isTest = (f: string) => /\.(test|spec|stories)\.[^.]+$/.test(f) || f.split(sep).includes('__tests__')

function ls(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => !SKIP_DIRS.has(e) && !e.startsWith('.'))
  } catch {
    return []
  }
}
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function walkFiles(dir: string, out: string[], stopAt: Set<string>) {
  for (const e of ls(dir)) {
    const p = join(dir, e)
    if (isDir(p)) {
      if (!stopAt.has(p)) walkFiles(p, out, stopAt)
    } else if (isSource(e) && !isTest(p)) out.push(p)
  }
}

interface App {
  name: string
  dir: string
  src: string
  pkgName: string | null
}

function findApps(root: string): App[] {
  const pkgDirs: string[] = []
  const scan = (dir: string, depth: number) => {
    if (depth > 4) return
    if (existsSync(join(dir, 'package.json'))) pkgDirs.push(dir)
    for (const e of ls(dir)) {
      const p = join(dir, e)
      if (isDir(p)) scan(p, depth + 1)
    }
  }
  scan(root, 0)
  if (!pkgDirs.length) pkgDirs.push(root)
  const apps = pkgDirs.map((dir): App => {
    let pkgName: string | null = null
    try {
      pkgName = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name ?? null
    } catch {}
    const src = isDir(join(dir, 'src')) ? join(dir, 'src') : dir
    const rel = relative(root, dir)
    return { name: rel || basename(root), dir, src, pkgName }
  })
  // A root package that only hosts workspaces has no code of its own.
  return apps.filter((a) => {
    if (a.dir !== root || apps.length === 1) return true
    const own: string[] = []
    walkFiles(a.src, own, new Set(apps.filter((b) => b !== a).map((b) => b.dir)))
    return own.length > 0
  })
}

interface Draft {
  name: string
  path: string
  layer: Layer | null
  files: string[]
  entries: string[]
}

/** Split an app's source tree into modules. */
function modulesOf(app: App, otherApps: Set<string>): Draft[] {
  const drafts: Draft[] = []
  const filesUnder = (p: string) => {
    if (!isDir(p)) return isSource(p) && !isTest(p) ? [p] : []
    const out: string[] = []
    walkFiles(p, out, otherApps)
    return out
  }
  const entriesOf = (p: string) =>
    isDir(p) ? ls(p).map((e) => join(p, e)).filter((f) => /^index\.[cm]?[jt]sx?$/.test(basename(f))) : [p]
  const add = (p: string, layer: Layer | null, name = basename(p).replace(/\.[^.]+$/, '')) => {
    const files = filesUnder(p)
    if (files.length) drafts.push({ name, path: p, layer, files, entries: entriesOf(p) })
  }
  const hasLayerFolder = (p: string, depth = 0): boolean =>
    depth < 3 && ls(p).some((e) => isDir(join(p, e)) && (e in LAYER_FOLDERS || hasLayerFolder(join(p, e), depth + 1)))

  const visit = (dir: string, top: boolean) => {
    const loose: string[] = []
    for (const e of ls(dir)) {
      const p = join(dir, e)
      if (otherApps.has(p)) continue
      if (!isDir(p)) {
        if (isSource(e) && !isTest(p)) loose.push(p)
        continue
      }
      const layer = LAYER_FOLDERS[e.toLowerCase()]
      if (layer) for (const child of ls(p)) add(join(p, child), layer)
      else if (hasLayerFolder(p)) visit(p, false)
      else add(p, null)
    }
    if (loose.length) {
      const name = top ? 'entry' : basename(dir)
      drafts.push({ name, path: dir, layer: null, files: loose, entries: loose })
    }
  }
  visit(app.src, true)
  return drafts
}

function resolveFile(base: string): string | null {
  const noJs = base.replace(/\.(m?js|jsx)$/, '')
  for (const p of [base, ...SOURCE_EXT.map((e) => noJs + e), ...SOURCE_EXT.map((e) => join(base, 'index' + e))]) {
    if (existsSync(p) && !isDir(p)) return p
  }
  return null
}


const pkgOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
const order: Layer[] = ['app', 'service', 'client', 'lib']

export function analyze(root: string): ArchReport {
  root = resolve(root)
  const apps = findApps(root)
  const appDirs = new Set(apps.map((a) => a.dir))
  const byPkg = new Map(apps.filter((a) => a.pkgName).map((a) => [a.pkgName!, a]))
  const modules: ArchModule[] = []
  const violations: Violation[] = []

  for (const app of apps) {
    const others = new Set([...appDirs].filter((d) => d !== app.dir))
    const drafts = modulesOf(app, others)
    if (!drafts.length) continue
    const fileToId = new Map<string, string>()
    const mods = drafts.map((d): ArchModule => {
      const id = `${app.name}:${relative(root, d.path) || '.'}${d.name === 'entry' ? ':entry' : ''}`
      for (const f of d.files) fileToId.set(f, id)
      return {
        id, app: app.name, layer: d.layer ?? 'service', inferred: d.layer === null, kind: 'module',
        name: d.name, path: relative(root, d.path) || '.', files: d.files.map((f) => relative(root, f)),
        exports: [], uses: [], externals: [],
      }
    })
    const byId = new Map(mods.map((m) => [m.id, m]))
    const pkgModules = new Map<string, ArchModule>()
    const edges: { from: ArchModule; to: ArchModule; file: string; line: number }[] = []

    for (const d of drafts) {
      const mod = byId.get(fileToId.get(d.files[0])!)!
      for (const file of d.files) {
        let sf: ts.SourceFile
        try {
          sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
        } catch {
          continue
        }
        if (d.entries.includes(file)) mod.exports.push(...collectExports(sf))
        for (const imp of importsOf(sf)) {
          let target: ArchModule | undefined
          if (imp.spec.startsWith('.') || /^[@~]\//.test(imp.spec)) {
            const base = imp.spec.startsWith('.') ? resolve(dirname(file), imp.spec) : join(app.src, imp.spec.slice(2))
            const f = resolveFile(base)
            target = f ? byId.get(fileToId.get(f) ?? '') : undefined
          } else if (!imp.spec.startsWith('node:')) {
            const pkg = pkgOf(imp.spec)
            const other = byPkg.get(pkg)
            if (other && other !== app) {
              let pm = pkgModules.get(pkg)
              if (!pm) {
                pm = { id: `${app.name}:pkg:${pkg}`, app: app.name, layer: 'lib', inferred: true, kind: 'package', name: pkg,
                  path: relative(root, other.dir), files: [], exports: [], uses: [], externals: [] }
                pkgModules.set(pkg, pm)
              }
              target = pm
            } else if (!mod.externals.includes(pkg)) mod.externals.push(pkg)
          }
          if (!target || target === mod) continue
          if (!mod.uses.includes(target.id)) mod.uses.push(target.id)
          edges.push({ from: mod, to: target, file: relative(root, file), line: imp.line })
        }
      }
    }

    // Guess layers that folder names don't state.
    const all = [...mods, ...pkgModules.values()]
    const allById = new Map(all.map((m) => [m.id, m]))
    const depth = new Map<string, number>()
    const depthOf = (m: ArchModule, seen = new Set<string>()): number => {
      if (depth.has(m.id)) return depth.get(m.id)!
      if (seen.has(m.id)) return 0
      seen.add(m.id)
      const d = m.uses.length ? 1 + Math.max(...m.uses.map((u) => depthOf(allById.get(u)!, seen))) : 0
      depth.set(m.id, d)
      return d
    }
    const usedBy = (m: ArchModule) => all.some((x) => x.uses.includes(m.id))
    for (const m of mods) {
      if (!m.inferred) continue
      const internal = m.uses.filter((u) => !allById.get(u)!.inferred || allById.get(u)!.kind === 'package')
      if (!usedBy(m) && (m.uses.length || m.name === 'entry')) m.layer = 'app'
      else if (m.externals.some((e) => CLIENT_SDKS.some((r) => r.test(e)))) m.layer = 'client'
      else if (depthOf(m) === 0 || (!internal.length && m.uses.every((u) => allById.get(u)!.layer === 'lib'))) m.layer = 'lib'
      else m.layer = 'service'
    }

    for (const e of edges) {
      if (e.from.inferred || e.to.inferred || e.to.kind === 'package') continue
      const r = layerRule(e.from.layer, e.to.layer)
      if (r) violations.push({ ...r, from: e.from.id, to: e.to.id, file: e.file, line: e.line })
    }
    modules.push(...all)
  }

  const kindOrder = { interface: 0, class: 1, function: 2, type: 3, enum: 4, const: 5 }
  for (const m of modules) m.exports.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind])
  modules.sort((a, b) => a.app.localeCompare(b.app) || order.indexOf(a.layer) - order.indexOf(b.layer) || a.name.localeCompare(b.name))
  return { root, apps: [...new Set(modules.map((m) => m.app))].sort(), modules, violations }
}

const label = (r: ArchReport, id: string) => {
  const m = r.modules.find((x) => x.id === id)
  return m ? `${m.layer}/${m.name}` : id
}

/** Compact text form for agents. */
export function formatReport(r: ArchReport): string {
  if (!r.modules.length) return 'No TypeScript/JavaScript sources found.'
  const lines: string[] = ['(layers marked ~ are guessed from dependencies, not folder names)']
  for (const app of r.apps) {
    lines.push(`App ${app}:`)
    for (const layer of order) {
      const mods = r.modules.filter((m) => m.app === app && m.layer === layer)
      if (!mods.length) continue
      lines.push(
        `  ${layer}: ` +
          mods.map((m) => `${m.inferred ? '~' : ''}${m.name}${m.uses.length ? ` -> ${m.uses.map((u) => label(r, u)).join(', ')}` : ''}`).join('; '),
      )
    }
  }
  const errors = r.violations.filter((v) => v.severity === 'error')
  const warnings = r.violations.filter((v) => v.severity === 'warning')
  lines.push(errors.length ? `\n${errors.length} violation(s):` : '\nNo violations.')
  for (const v of errors) lines.push(`  ✗ ${v.rule}: ${label(r, v.from)} -> ${label(r, v.to)} (${v.file}:${v.line})`)
  if (warnings.length) lines.push(`${warnings.length} warning(s):`)
  for (const v of warnings) lines.push(`  ! ${v.rule}: ${label(r, v.from)} -> ${label(r, v.to)} (${v.file}:${v.line})`)
  return lines.join('\n')
}
