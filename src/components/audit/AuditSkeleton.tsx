import { Panel, TH_CLASS, TableScroll } from "@/components/ui/primitives";

/**
 * The loading state.
 *
 * Shaped like the table it replaces — six columns, ten rows — so the layout
 * does not jump when the rows arrive. `aria-busy` and the visually hidden
 * sentence are the part that matters for anyone not looking at the shimmer.
 */
export function AuditSkeleton() {
  return (
    <Panel title="Business timeline" description="Reading every action store on the book…">
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading the actor trail.</span>
        <TableScroll>
          <table className="w-full border-collapse">
            <caption className="sr-only">Loading</caption>
            <thead>
              <tr className="border-b border-border">
                {["Occurred", "Recorded", "Actor", "Action", "Amount", "Source"].map((h) => (
                  <th key={h} scope="col" className={TH_CLASS}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 10 }, (_, i) => (
                <tr key={i} className="border-b border-border/60">
                  {Array.from({ length: 6 }, (_, j) => (
                    <td key={j} className="px-5 py-3">
                      <span
                        className="block h-3 animate-pulse rounded bg-border"
                        style={{ width: `${[70, 55, 60, 90, 40, 65][j]}%` }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </div>
    </Panel>
  );
}
