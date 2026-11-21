import { useId } from 'react'
import { noEvidenceNote, type ClaimStatus, type Evidence } from './publish'

export type { ClaimStatus, Evidence }

interface ClaimProps {
  text: string
  evidence: Evidence[]
  status: ClaimStatus
  /** The footnote number after the text. */
  n?: number
}

/** A statement in a document, highlighted inline; hover or focus shows its evidence. Red when unverified. */
export function Claim({ text, evidence, status, n }: ClaimProps) {
  const id = useId()
  return (
    <span className={status === 'unverified' ? 'claimhl bad' : 'claimhl'} tabIndex={0} aria-describedby={id}>
      {text}
      {n !== undefined && <sup>{n}</sup>}
      <span className="claimpop" role="tooltip" id={id}>
        {status === 'unverified' && evidence.length > 0 && <span className="ev st">Unverified: these sources don't back it.</span>}
        {evidence.length
          ? evidence.map((e, i) => (
              <span key={i} className="ev">
                <b>{e.source}</b>
                {e.query && <code>{e.query}</code>}
              </span>
            ))
          : <span className={status === 'unverified' ? 'ev st' : 'ev'}>{noEvidenceNote(status)}</span>}
      </span>
    </span>
  )
}
