/**
 * THE FIXTURE STATES' WRITE BUTTONS WERE PRESSABLE.
 *
 * ============================================================================
 * `ControlsFormProps.live` is documented on its own line as "False on the
 * fixture states, which must not be able to write." Every FIELD honoured it —
 * `disabled={!props.live}` on the limits, the category box, the note, the
 * freeze toggle, the quick-block buttons. The submit button did not: `Submit`
 * took no `live` at all and set `disabled={status.pending}`.
 *
 * So on `/accounts?controls=empty` and `?controls=edge`, "Append control
 * version" and "Replay through the decision function" were fully pressable,
 * and pressing one dispatched a real server action against the fixture card id
 * `00000000-0000-4000-8000-00000000c0de`. The action answered `NOTE_REQUIRED`
 * or `AMOUNT_INVALID` — a form-validation complaint, in the panel, under a
 * badge reading "refused", where the truthful answer is that this row is a
 * drawing and there is nothing to append to.
 *
 * Three sibling files already got this right and are the model:
 * `ConsoleForms.tsx`'s own `Submit` takes `disabled`, and so do
 * `DecisionForm.tsx` and `PaymentForm.tsx`.
 * ============================================================================
 *
 * This needs no missing database: both states are a query string away on a
 * fully configured deployment. Nothing here opens a connection or submits a
 * form — the forms are rendered, never dispatched.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { ReactNode } from "react";

import type { ErrorShape } from "@/lib/result";
import { IDLE_CONTROL_RESULT } from "@/lib/cards/view-state";
import { hasRetryControl } from "@/test/no-database-render";

import { CardControlsForm, ReplayAuthorizationForm } from "./CardControlsForms";
import { ConsoleErrorPanel } from "./ConsoleChrome";

async function render(node: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(node, {
    onError(thrown: unknown) {
      throw thrown;
    },
  });
  await stream.allReady;
  return await new Response(stream).text();
}

/** The one `<button>` whose text is this label, with its attributes. */
function buttonFor(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  return match === null ? "" : match[0];
}

const FIXTURE_CARD_ID = "00000000-0000-4000-8000-00000000c0de";

describe("the card control forms on a fixture row", () => {
  it("cannot submit an appended control version", async () => {
    const html = await render(
      createElement(CardControlsForm, {
        cardId: FIXTURE_CARD_ID,
        cardLabel: "Contractor card",
        perTxn: "10.00",
        daily: "250.00",
        monthly: "",
        blockedMccs: ["5542"],
        frozen: false,
        live: false,
        action: null,
      }),
    );
    const button = buttonFor(html, "Append control version");
    expect(button).not.toBe("");
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-disabled="true"');
  }, 15_000);

  it("cannot submit a replay", async () => {
    const html = await render(
      createElement(ReplayAuthorizationForm, {
        cardId: FIXTURE_CARD_ID,
        cardToken: "fixture-card-token",
        live: false,
        action: null,
      }),
    );
    const button = buttonFor(html, "Replay through the decision function");
    expect(button).not.toBe("");
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-disabled="true"');
  }, 15_000);

  it("says why, rather than leaving a dead control to be discovered", async () => {
    const html = await render(
      createElement(ReplayAuthorizationForm, {
        cardId: FIXTURE_CARD_ID,
        cardToken: "fixture-card-token",
        live: false,
        action: null,
      }),
    );
    expect(html).toContain("This card is a fixture");
  }, 15_000);

  it("still submits on the live row", async () => {
    const html = await render(
      createElement(ReplayAuthorizationForm, {
        cardId: FIXTURE_CARD_ID,
        cardToken: "fixture-card-token",
        live: true,
        action: () => Promise.resolve(IDLE_CONTROL_RESULT),
      }),
    );
    const button = buttonFor(html, "Replay through the decision function");
    expect(button).not.toBe("");
    expect(button).not.toContain('disabled=""');
    expect(button).toContain('aria-disabled="false"');
  }, 15_000);
});

/** A failure that says it is not retryable. A refresh cannot clear it. */
const NO_DATABASE: ErrorShape = {
  code: "ACCOUNTS_NO_DATABASE",
  message: "No database is configured for this deployment.",
  details: { retryable: false, source: "accounts.console", operation: "the console" },
};

describe("ConsoleErrorPanel honours the failure's own retryable flag", () => {
  it("prints the flag and drops the retry when a retry cannot help", async () => {
    const html = await render(createElement(ConsoleErrorPanel, { error: NO_DATABASE }));
    expect(html).toContain("Retryable");
    expect(html).toContain(">no<");
    expect(hasRetryControl(html)).toBe(false);
  }, 15_000);
});
