/** A piece of markdown text: prose to parse, or a [title](canvas:<id>) link to render as a card; #<node> focuses a node. */
export type MdSegment = { kind: 'md'; text: string } | { kind: 'canvas'; id: string; title: string; node?: string }

const CODE = /(```[\s\S]*?```|`[^`\n]*`)/
const CANVAS_LINK = /\[([^\]\n]*)\]\(canvas:([\w-]+)(?:#([\w.:-]+))?\)/g

/**
 * Splits `text` at canvas links outside fenced and inline code. `prose` rewrites the text outside code (e.g. task-key
 * links). A canvas link inside a paragraph ends that paragraph: the card is block-level.
 */
export function mdSegments(text: string, prose: (s: string) => string = (s) => s): MdSegment[] {
  const out: MdSegment[] = []
  let md = ''
  const flush = () => {
    if (md.trim()) out.push({ kind: 'md', text: md })
    md = ''
  }
  text.split(CODE).forEach((part, i) => {
    if (i % 2) return void (md += part)
    let at = 0
    for (const m of part.matchAll(CANVAS_LINK)) {
      md += prose(part.slice(at, m.index))
      flush()
      out.push(m[3] ? { kind: 'canvas', id: m[2], title: m[1], node: m[3] } : { kind: 'canvas', id: m[2], title: m[1] })
      at = m.index + m[0].length
    }
    md += prose(part.slice(at))
  })
  flush()
  return out
}
