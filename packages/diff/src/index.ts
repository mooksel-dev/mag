// Architecture diff (T-57, reworked in T-58): the files a PR changes with the module that owns each, the changes a
// plan or fact diagram draws, plan ↔ fact, which changed files a fact shows and whether its lines rest on the PR.
// No code is parsed: the fact diagram is drawn by the reviewer from the diff.
export { createDiff, fileKind, isCode, isTest, type DiffEngine } from './files.ts'
export { compare, coverage, describe, formatComparison, grounding, mergeBlockers } from './compare.ts'
export { LEVELS, SIGNIFICANT, isSignificant, parseSignificance, significance, withLevels, type SignificanceRule } from './significance.ts'
export { carryIds, sharedPaths, unowned } from './ownership.ts'
export { diagramChanges, formatPlanWarnings, lineName, planWarnings } from './plan.ts'
export { formatFiles } from './format.ts'
export { folderVocabulary, moduleResolver, planVocabulary, vocabularyOf } from './vocabulary.ts'
export type * from './types.ts'
