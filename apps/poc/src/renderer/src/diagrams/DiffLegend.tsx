/** The diff colours, for the legend of a diagram; `move`: also the colour of what moved (Data). */
export function DiffLegend({ move }: { move?: boolean }) {
  return (
    <>
      <span><i className="sw d-add" /> added</span>
      <span><i className="sw d-mod" /> changed</span>
      <span><i className="sw d-del" /> removed</span>
      {move && <span><i className="sw d-move" /> moved</span>}
      <span><i className="sw d-none" /> unchanged</span>
    </>
  )
}
