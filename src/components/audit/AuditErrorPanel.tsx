import { Note, Panel } from "@/components/ui/primitives";
import { RetryButton } from "@/components/ui/RetryButton";

/**
 * The error state.
 *
 * It says the one thing a reader of an audit screen needs to hear first:
 * NOTHING MOVED. This screen only reads, so a failed read cannot have changed
 * the book — and unlike a half-written audit log, a projection that fails
 * leaves no partial row behind to be reconciled later. That is a genuine
 * property of the read-only design and it is worth stating on the failure
 * path, where it is load-bearing.
 */
export function AuditErrorPanel({ message }: { readonly message: string }) {
  return (
    <Panel
      title="The trail could not be read"
      description="A read failed. The book is unchanged."
      actions={<RetryButton label="Retry the read" />}
    >
      <div className="space-y-3 px-5 py-4">
        <Note emphasis title="Nothing moved">
          This screen issues SELECTs and nothing else — it owns no rows and writes none — so a
          failure here cannot have left a partial record behind. Retrying re-issues exactly the
          same queries.
        </Note>
        <p className="font-mono text-[11px] break-all text-muted">{message}</p>
      </div>
    </Panel>
  );
}
