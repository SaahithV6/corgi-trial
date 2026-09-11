/**
 * What `/audit` needs in order to render, expressed without a database.
 *
 * The same shape the recon screens use, and for the same reason: the page
 * picks a source per URL state, so the four non-default states can be shown in
 * order in front of a panel without writing a row, and the default state can
 * still be a real query against the real book.
 */

import type { AuditFilter } from "./view-state";
import type { TimelineResult } from "@/lib/audit/types";

export type AuditDataSource = {
  readonly load: (filter: AuditFilter) => Promise<TimelineResult>;
};
