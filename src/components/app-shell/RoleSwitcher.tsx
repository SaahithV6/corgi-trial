import { setRoleAction } from "@/app/(app)/actions";

import { ROLES, ROLE_LABEL, ROLE_SUMMARY, type Role } from "./role";
import { FOCUS_RING } from "../ui/primitives";

/**
 * Staff / approver, as a segmented control.
 *
 * A `<form>` with two submit buttons and a server action: no client
 * JavaScript, works on a reload, and the current role is announced with
 * `aria-pressed` rather than by colour alone.
 */
export function RoleSwitcher({ role }: { readonly role: Role }) {
  return (
    <form action={setRoleAction} className="flex items-center gap-2">
      <span
        id="role-switcher-label"
        className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted"
      >
        Acting as
      </span>
      <div
        role="group"
        aria-labelledby="role-switcher-label"
        className="flex rounded border border-border-strong bg-surface p-0.5"
      >
        {ROLES.map((candidate) => {
          const current = candidate === role;
          return (
            <button
              key={candidate}
              type="submit"
              name="role"
              value={candidate}
              aria-pressed={current}
              title={ROLE_SUMMARY[candidate]}
              className={`rounded-sm px-2.5 py-1 text-xs font-medium ${FOCUS_RING} ${
                current
                  ? "bg-surface-raised text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                  : "text-muted hover:text-text"
              }`}
            >
              {ROLE_LABEL[candidate]}
            </button>
          );
        })}
      </div>
    </form>
  );
}
