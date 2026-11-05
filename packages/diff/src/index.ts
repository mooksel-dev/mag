// Architecture diff (T-57, reworked in T-58 and diff-iak-inventar-zmin-ai.1): the files a PR changes with the module that
// owns each and their numbered hunks, the change inventory checked against them, the changes a plan or fact diagram
// draws, and plan ↔ fact. No code is parsed: the inventory is written by the reviewer from the diff.
export { createDiff, fileKind, isCode, isTest, type DiffEngine } from './files.ts'
export { additionCount, additionLine, callSignature, compare, describe, entityWord, outsideLine, sameCall, formatComparison, isDeviation, mergeBlockers, phrase, planOverlay } from './compare.ts'
export { LEVELS, parseSignificance, significance, withLevels, type SignificanceRule } from './significance.ts'
export { carryIds, sharedPaths, unowned } from './ownership.ts'
export { NO_MODULE, diagramChanges, formatPlanWarnings, lineName, planWarnings } from './plan.ts'
export { formatFiles, formatHunks } from './format.ts'
export { checkInventory, formatInventoryCheck, hunkBlocks, inventoryBlockers, numberHunks, type InventoryCheckOptions } from './inventory.ts'
export { folderVocabulary, moduleResolver, planVocabulary, vocabularyOf } from './vocabulary.ts'
export type * from './types.ts'
