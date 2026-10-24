// Report types only: safe to import from browser code.
export type Layer = 'app' | 'service' | 'client' | 'lib'

export interface ExportedApi {
  name: string
  kind: 'interface' | 'class' | 'function' | 'type' | 'const' | 'enum'
  /** Member or signature lines, as written in the code. */
  members: string[]
}

export interface ArchModule {
  /** `${app}:${path}` */
  id: string
  app: string
  layer: Layer
  /** true when the layer was guessed from the dependency graph, not from a folder name. */
  inferred: boolean
  /** 'package' = another workspace package this app imports. */
  kind: 'module' | 'package'
  name: string
  /** Path relative to the repo root. */
  path: string
  files: string[]
  exports: ExportedApi[]
  /** Ids of modules this one imports. */
  uses: string[]
  /** External npm packages it imports (first segment / scope). */
  externals: string[]
}

export interface Violation {
  severity: 'error' | 'warning'
  rule: string
  from: string
  to: string
  file: string
  line: number
}

export interface ArchReport {
  root: string
  apps: string[]
  modules: ArchModule[]
  violations: Violation[]
}
