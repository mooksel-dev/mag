import { Extension, type Editor } from '@tiptap/core'
import { Plugin, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'

/**
 * The code block a fence line makes: the line the cursor ends (the paragraph, or its last line after a ⇧↵ break) is
 * ```lang and matches `line`. A whole paragraph becomes the block; a last line goes, with its break, and the block
 * follows the paragraph, the cursor in it. Null when the cursor is not at the end of such a line.
 */
export function fenceTr(state: EditorState, line: RegExp): Transaction | null {
  const { $from, empty } = state.selection
  const code = state.schema.nodes.codeBlock
  if (!empty || !code || $from.parent.type.name !== 'paragraph' || $from.pos !== $from.end()) return null
  let lineStart = $from.start()
  $from.parent.forEach((node, offset) => { if (node.type.name === 'hardBreak') lineStart = $from.start() + offset + node.nodeSize })
  const m = line.exec(state.doc.textBetween(lineStart, $from.pos))
  if (!m) return null
  const attrs = m[1] ? { language: m[1] } : {}
  if (lineStart === $from.start()) return state.tr.delete(lineStart, $from.pos).setBlockType(lineStart, lineStart, code, attrs)
  const tr = state.tr.delete(lineStart - 1, $from.pos)
  // The paragraph now closes at lineStart - 1; the block goes right after it.
  const at = lineStart
  tr.insert(at, code.create(attrs))
  return tr.setSelection(TextSelection.create(tr.doc, at + 1))
}

/** ```lang, then ↵ or ⇧↵: a code block, as in Slack and the Claude app. */
const fenceKey = ({ editor }: { editor: Editor }) => {
  const tr = fenceTr(editor.state, /^```([\w+#-]*)$/)
  if (!tr) return false
  editor.view.dispatch(tr)
  return true
}

export const FenceOnEnter = Extension.create({
  name: 'fenceOnEnter',
  priority: 1000,
  addKeyboardShortcuts() {
    return { Enter: fenceKey, 'Shift-Enter': fenceKey }
  },
  /** ```lang + space, however the text came in (a typed key, an IME, the DOM read back): the same code block. */
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction: (trs, _old, state) => (trs.some((t) => t.docChanged) ? fenceTr(state, /^```([\w+#-]*)[ \u00a0]$/) : null),
    })]
  },
})
