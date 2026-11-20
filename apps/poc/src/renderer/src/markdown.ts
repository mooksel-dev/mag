/** A piece of markdown text: prose to parse, or a [title](canvas:<id>) link to render as a card; #<node> focuses a node. */
export type MdSegment = { kind: 'md'; text: string } | { kind: 'canvas'; id: string; title: string; node?: string }

const CODE = /(```[\s\S]*?```|`[^`\n]*`)/
const CANVAS_LINK = /\[([^\]\n]*)\]\(canvas:([\w-]+)(?:#([\w.:-]+))?\)/g
/** The href of a canvas link that stays inline: #canvas:<id> or #canvas:<id>/<node>. */
const CANVAS_HREF = /^#canvas:([\w-]+)(?:\/([\w.:-]+))?$/

/** The href an inline canvas link gets in the rendered markdown; `canvasHref` reads it back. */
export const canvasHref = (id: string, node?: string) => `#canvas:${id}${node ? `/${node}` : ''}`

/** The canvas (and node) an inline canvas link's href points at; null for any other href. */
export function parseCanvasHref(href: string): { id: string; node?: string } | null {
  const m = CANVAS_HREF.exec(href)
  if (!m) return null
  return m[2] ? { id: m[1], node: m[2] } : { id: m[1] }
}

/**
 * Splits `text` at canvas links outside fenced and inline code. `prose` rewrites the text outside code (e.g. task-key
 * links). A canvas link alone on its line (from its first column, nothing after it) becomes a card segment: the card is
 * block-level. A link inside a sentence, a list item or a quote stays in the text as a link to `canvasHref`, so the
 * paragraph or list it is in stays whole. A link to an id in `gone` (a deleted canvas) is its title as plain text, on
 * its own line too.
 */
export function mdSegments(text: string, prose: (s: string) => string = (s) => s, gone: ReadonlySet<string> = new Set()): MdSegment[] {
  const out: MdSegment[] = []
  let md = ''
  const flush = () => {
    if (md.trim()) out.push({ kind: 'md', text: md })
    md = ''
  }
  const parts = text.split(CODE)
  parts.forEach((part, i) => {
    if (i % 2) return void (md += part)
    let at = 0
    for (const m of part.matchAll(CANVAS_LINK)) {
      const [link, title, id, node] = m
      md += prose(part.slice(at, m.index))
      at = m.index + link.length
      if (gone.has(id)) {
        md += title || id
        continue
      }
      const rest = part.slice(at)
      const lineEnd = rest.indexOf('\n')
      // Nothing before it on its line, and only spaces after it up to the line's end (not code on the same line).
      const alone = !/[^\n]$/.test(md) && !(lineEnd < 0 ? rest : rest.slice(0, lineEnd)).trim() && (lineEnd >= 0 || i === parts.length - 1)
      if (alone) {
        flush()
        out.push(node ? { kind: 'canvas', id, title, node } : { kind: 'canvas', id, title })
      } else md += `[${title || id}](${canvasHref(id, node)})`
    }
    md += prose(part.slice(at))
  })
  flush()
  return out
}

/** A point of an outline: its own markdown and the points nested under it. */
export interface OutlinePoint {
  text: string
  points: OutlinePoint[]
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/

/**
 * Markdown as a tree of points, for reading it a level at a time: each list item is a point with its sub-items; a line
 * that is not an item goes on the item it is indented under, else it is a point of its own (a paragraph). Fenced code
 * stays with the point it is in.
 */
export function mdOutline(md: string): OutlinePoint[] {
  const root: OutlinePoint[] = []
  // Open list items, outermost first, with the column of their marker.
  const stack: { point: OutlinePoint; indent: number }[] = []
  let paragraph: OutlinePoint | null = null
  let fence = false
  // The column of the open fence: its lines are cut to it.
  let fenceAt = 0
  let blank = false
  const newParagraph = (text: string) => {
    stack.length = 0
    paragraph = { text, points: [] }
    root.push(paragraph)
  }
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\t/g, '    ')
    const indent = line.length - line.trimStart().length
    const top = stack[stack.length - 1]
    const current = paragraph ?? top?.point
    const isFence = /^\s*```/.test(line)
    if (fence || isFence) {
      if (isFence && !fence) fenceAt = indent
      if (isFence) fence = !fence
      if (current) current.text += `\n${line.slice(Math.min(indent, fenceAt))}`
      else newParagraph(line)
    } else if (!line.trim()) {
      blank = true
      continue
    } else {
      const item = LIST_ITEM.exec(line)
      if (item) {
        paragraph = null
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
        const point: OutlinePoint = { text: item[2], points: [] }
        ;(stack.length ? stack[stack.length - 1].point.points : root).push(point)
        stack.push({ point, indent })
      } else if (top && !paragraph && indent > top.indent) top.point.text += `\n${line.trim()}`
      else if (current && !blank) current.text += `\n${line.trim()}`
      else newParagraph(line.trim())
    }
    blank = false
  }
  return root
}

/**
 * The composer's markdown as the user meant it: the editor's serializer writes a line break as "\\" + newline and
 * escapes `, *, _ and the like in plain text (a path like a_b, three backticks typed as text). Outside code, a break is
 * a newline, a paragraph is a line, and those escapes go; code is left as it is.
 */
export function plainMarkdown(md: string): string {
  return md
    .split(/(^```[^\n]*\n[\s\S]*?^```$|(?<!\\)`[^`\n]+`)/m)
    // Paragraphs (⇧↵) are lines, as typed: one blank line between them goes; two (an empty line typed) leave one.
    .map((part, i) => (i % 2 ? part : part.replace(/\n\n/g, '\n').replace(/\\\n/g, '\n').replace(/\\([\\`*_{}[\]()#+\-.!>~|<])/g, '$1')))
    .join('')
}
