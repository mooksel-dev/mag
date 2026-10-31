/** The diff colours, for the legend of a diagram. */
export function DiffLegend() {
  return (
    <>
      <span><i className="sw d-add" /> added</span>
      <span><i className="sw d-mod" /> changed</span>
      <span><i className="sw d-del" /> removed</span>
      <span><i className="sw d-none" /> unchanged</span>
    </>
  )
}
