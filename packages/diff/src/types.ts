// Models of the architecture diff (T-57, reworked in T-58). Types only.
import type { ArchLayer } from '@mag/core'

/** A repository: where git runs, and the name refs start with. */
export interface Repo {
  path: string
  name: string
}

/** Modules of the project's architecture with the files they own (T-56 F2). */
export interface Vocabulary {
  modules: { id: string; paths: string[] }[]
}

export interface Hunk {
  /** H1…, in diff order across the repositories of a fact (numberHunks, diff-iak-inventar-zmin-ai.1). */
  id?: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** What git names after the hunk's `@@ … @@`: the line its default heuristic takes for the enclosing declaration. */
  header?: string
  /** Its lines with their context (` …`, `-…`, `+…`), for the inventory check; never sent to the renderer. */
  lines?: string[]
}

export interface FileDiff {
  /** Path at head; for a deleted file, at base. */
  path: string
  /** Path at base when renamed. */
  oldPath?: string
  status: 'add' | 'mod' | 'del' | 'rename'
  hunks: Hunk[]
}

export interface HunkRef extends Hunk {
  path: string
}

/**
 * What a changed file is, by its path alone, whatever the language. Only code has to be in a fact's inventory; the
 * rest need not be cited: tests, styles, lock files, generated code, documentation.
 */
export type FileKind = 'code' | 'test' | 'style' | 'lock' | 'generated' | 'docs'

/** A file a PR changes (T-58): its hunks and the module of the vocabulary that owns it. */
export interface FileChange extends FileDiff {
  /** The repository's name. */
  repo: string
  /** Vocabulary module id; null when no module owns the file. */
  module: string | null
  kind: FileKind
}

export type DiffMark = 'add' | 'mod' | 'del' | 'move'

export type Level = 'critical' | 'high' | 'medium' | 'low' | 'noise'

/** One change a Component diagram draws (a plan's or a fact's), over the ids of the vocabulary. */
export interface Change {
  /**
   * module: its id; element (an interface line): `<module>#<name>`; edge (a dependency): `<from> -> <to>`; call:
   * `<from> -> <to>#<name>`; entity (stored data, of a Data diagram): `<module>/<entity>`; field: `<module>/<entity>.<field>`.
   */
  key: string
  kind: 'module' | 'element' | 'edge' | 'call' | 'entity' | 'field'
  diff: DiffMark
  /** The module it is in; for an edge or call, `from`. */
  module: string
  /** element / call: the method, field or type the line names; edge: `to`; module, entity: its name; field: its name. */
  name: string
  /** field: the id of its entity, and the entity's name. */
  entity?: string
  entityName?: string
  /** The line as drawn; a changed signature is the del line (before) and the add line (after). */
  before?: string
  after?: string
  /** mod of an element: a changed signature (a del and an add line), else the line is marked mod. */
  part?: 'signature' | 'body'
  /** move: the module it moved from. */
  from?: string
  /** A new module: the code it will own. */
  path?: string
  /** The PR's files the line rests on (fact diagrams, T-58 Decision 9). */
  files?: string[]
  /** Set by significance. */
  level?: Level
}

/**
 * A plan change against the fact (T-57.4): match: done as planned; differs: done otherwise (another mark or line);
 * missing: planned, not on the fact; unplanned: on the fact, not on the plan (at plan level: a module, entity or
 * dependency, or a critical change).
 */
export type CompareStatus = 'match' | 'differs' | 'missing' | 'unplanned'

export interface CompareItem {
  status: CompareStatus
  /** The plan's change; none for unplanned. */
  plan?: Change
  /** The fact's change; none for missing. */
  fact?: Change
  /** The higher level of the two. */
  level: Level
  /** differs: by the mark (add, del, mod, move) or by the call signature of the line. */
  how?: 'mark' | 'signature'
  /** differs: how, in the plan's and the fact's words. */
  note?: string
  /** unplanned module, entity or dependency: the fact's lines, fields and calls in it, folded under it. */
  folded?: Change[]
}

/** What the fact changes inside the plan's scope that no plan line names: never a deviation, folded per module. */
export interface Addition {
  /** The module id; for fields, the entity's key `<module>/<entity>`. */
  module: string
  changes: Change[]
}

/**
 * Plan ↔ fact at plan level (plan-fact-porivniannia-na-rivni.1): items are the plan's changes (match, differs, missing)
 * and the fact's deviations outside the plan (unplanned: a new, removed or moved module, entity or dependency, its
 * lines folded under it, or a critical change); additions are what the fact adds inside the planned modules and
 * entities, outside what it changes inside existing modules and entities the plan does not touch.
 */
export interface Comparison {
  items: CompareItem[]
  additions: Addition[]
  /** What the fact changes inside existing modules and entities outside the plan's scope: also no deviation. */
  outside: Addition[]
}

/** How a plan change came out, as the plan diagram paints it. */
export type OverlayStatus = 'match' | 'differs' | 'missing'

/**
 * The comparison over the step's plan Component diagram: the status of its modules and dependencies (from the plan
 * changes on them), and the fact's unplanned modules and dependencies, drawn dashed.
 */
export interface PlanOverlay {
  /** Module id → status of the plan changes on it (the module and its lines). */
  modules: Record<string, OverlayStatus>
  /** `<from> -> <to>` → status of the plan changes on it (the dependency and its calls). */
  edges: Record<string, OverlayStatus>
  unplanned: {
    /** within: the module's ancestors in the architecture, outermost first: where to draw it. */
    modules: { id: string; name: string; layer?: ArchLayer; within: string[] }[]
    edges: { from: string; to: string }[]
  }
}

/**
 * Where a plan diagram disagrees with the vocabulary (T-58 Decision 8): unknown-module: an id the architecture does
 * not have and the diagram does not add; no-path: an added module without the code it will own; exists: an add of a
 * module the architecture has already.
 */
export type PlanWarningCode = 'unknown-module' | 'no-path' | 'exists'

export interface PlanWarning {
  code: PlanWarningCode
  /** The diagram module it is about. */
  module: string
  message: string
}

/** A block of consecutive changed lines of a hunk (diff-iak-inventar-zmin-ai.1): what an inventory unit cites. */
export interface HunkBlock {
  /** `<hunk id>.<k>`, e.g. H3.2. */
  id: string
  hunk: string
  repo: string
  path: string
  module: string | null
  kind: FileKind
  lines: string[]
}

/** A change inventory against the hunks (checkInventory): what blocks merge, then the warnings to answer. */
export interface InventoryCheck {
  blocks: number
  codeBlocks: number
  units: number
  /** Blocks of code files in no unit and not in noise. */
  unaccounted: HunkBlock[]
  /** Ids a unit (its id) or noise (`noise[<i>]`) cites that are no block or hunk. */
  unknown: { id: string; by: string }[]
  /** Units whose name their hunks do not bear out. */
  ungrounded: { unit: string; name: string; why: string }[]
  /** Units on a module that owns none of their blocks. */
  otherModule: { unit: string; name: string; module: string; hunkModules: string[] }[]
  /** Warning: code blocks only noise claims, though they change more than comments and blank lines. */
  noiseClaims: { block: string; reason: string; lines: number }[]
  /** Warning: declarations in changed lines that no unit of their module names. */
  undeclared: { block: string; name: string; line: string }[]
}

/** The git operation the diff needs; the app's git client implements it. */
export interface GitSource {
  /** Changed files between two commits with zero-context hunks, renames detected. */
  diffHunks(repo: string, base: string, head: string): Promise<FileDiff[]>
}
