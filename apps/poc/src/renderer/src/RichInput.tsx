import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from 'tiptap-markdown'

export interface RichInputHandle {
  focus: () => void
  /** Replaces the content with `markdown` and puts the cursor at its end. */
  setMarkdown: (markdown: string) => void
  clear: () => void
  /** Deletes the character before the cursor when it is `char` (the "@" that opened the palette). */
  dropCharBefore: (char: string) => void
}

/** What the composer decides on a key: true = handled (the editor does nothing more). */
export type KeyHandler = (e: KeyboardEvent, state: { inCode: boolean; inList: boolean; emptyItem: boolean }) => boolean

const markdownOf = (editor: Editor) => (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown()

/** ```lang + Enter on a line of its own: a code block, as in Slack and the Claude app. */
const FenceOnEnter = Extension.create({
  name: 'fenceOnEnter',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection
        if (!empty || $from.parent.type.name !== 'paragraph') return false
        const m = /^```([\w+#-]*)$/.exec($from.parent.textContent)
        if (!m) return false
        return editor.chain().deleteRange({ from: $from.start(), to: $from.end() }).setCodeBlock(m[1] ? { language: m[1] } : undefined).run()
      },
    }
  },
})

/**
 * The composer's text field with formatting as it is typed (markdown shortcuts: ``` + Enter a code block, **bold**,
 * `code`, - a list, > a quote), its content kept and sent as markdown. Keys go to `onKey` first: Enter sends unless the
 * composer says otherwise; images pasted go to `onFiles`; "@" typed after a space or at the start calls `onAt`.
 */
export const RichInput = forwardRef<RichInputHandle, {
  placeholder: string
  autoFocus?: boolean
  onChange: (markdown: string, text: string) => void
  onKey: KeyHandler
  onFiles: (files: File[]) => void
  onAt?: () => void
}>(function RichInput({ placeholder, autoFocus, onChange, onKey, onFiles, onAt }, ref) {
  // Handlers change every render; the editor is made once.
  const live = useRef({ onChange, onKey, onFiles, onAt })
  live.current = { onChange, onKey, onFiles, onAt }
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      Markdown.configure({ html: false, breaks: true, transformPastedText: true, linkify: true }),
      FenceOnEnter,
    ],
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'richinput md', 'aria-label': 'Message', role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (view, e) => {
        const { $from, empty } = view.state.selection
        const inCode = $from.parent.type.name === 'codeBlock'
        const item = Array.from({ length: $from.depth + 1 }, (_, d) => $from.node(d)).some((n) => n.type.name === 'listItem')
        return live.current.onKey(e, { inCode, inList: item, emptyItem: item && empty && $from.parent.textContent === '' })
      },
      handlePaste: (_, e) => {
        const files = Array.from(e.clipboardData?.files ?? [])
        if (!files.length) return false
        live.current.onFiles(files)
        return true
      },
      handleTextInput: (view, from, _to, text) => {
        if (text !== '@' || !live.current.onAt) return false
        const before = view.state.doc.textBetween(Math.max(0, from - 1), from, '\n', '\n')
        if (!before || /\s/.test(before)) queueMicrotask(() => live.current.onAt?.())
        return false
      },
    },
    onUpdate: ({ editor }) => live.current.onChange(markdownOf(editor).trim(), editor.getText()),
  })
  // A new placeholder shows at once.
  useEffect(() => { editor?.view.dispatch(editor.state.tr) }, [placeholder, editor])
  useImperativeHandle(ref, () => ({
    focus: () => editor?.commands.focus('end'),
    setMarkdown: (md) => { editor?.chain().setContent(md).focus('end').run(); if (editor) live.current.onChange(markdownOf(editor).trim(), editor.getText()) },
    clear: () => { editor?.commands.clearContent(true) },
    dropCharBefore: (char) => {
      if (!editor) return
      const { from } = editor.state.selection
      if (from > 1 && editor.state.doc.textBetween(from - 1, from) === char) editor.chain().deleteRange({ from: from - 1, to: from }).run()
    },
  }), [editor])
  return <EditorContent editor={editor} className="richinputbox" />
})
