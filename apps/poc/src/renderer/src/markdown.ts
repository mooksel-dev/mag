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
