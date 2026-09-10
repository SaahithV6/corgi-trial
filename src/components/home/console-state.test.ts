/**
 * The five URL states.
 *
 * One rule with teeth: a malformed query string must show the real console,
 * never an error page and never a fixture. The front door is the first URL
 * anybody types by hand, and `?state=defualt` becoming a 500 — or worse,
 * silently becoming a fixture that looks live — would be a worse failure than
 * anything the states exist to demonstrate.
 */
import { describe, expect, it } from "vitest";

import {
  CONSOLE_STATES,
  CONSOLE_STATE_HINTS,
  CONSOLE_STATE_LABELS,
  consoleQuery,
  isLiveState,
  parseConsoleState,
} from "./console-state";

describe("CONSOLE_STATES", () => {
  it("is the same five every other screen in this console has", () => {
    expect([...CONSOLE_STATES]).toEqual([
      "default",
      "loading",
      "empty",
      "error",
      "edge",
    ]);
  });

  it("labels and explains every one of them", () => {
    for (const state of CONSOLE_STATES) {
      expect(CONSOLE_STATE_LABELS[state].length).toBeGreaterThan(0);
      expect(CONSOLE_STATE_HINTS[state].length).toBeGreaterThan(20);
    }
  });
});

describe("parseConsoleState", () => {
  it("reads each state out of the query string", () => {
    for (const state of CONSOLE_STATES) {
      expect(parseConsoleState({ state })).toBe(state);
    }
  });

  it("falls back to the live console for anything it does not recognise", () => {
    expect(parseConsoleState({})).toBe("default");
    expect(parseConsoleState({ state: "defualt" })).toBe("default");
    expect(parseConsoleState({ state: "" })).toBe("default");
    expect(parseConsoleState({ state: undefined })).toBe("default");
    expect(parseConsoleState({ state: "__proto__" })).toBe("default");
  });

  it("takes the first value when a parameter is repeated", () => {
    expect(parseConsoleState({ state: ["edge", "error"] })).toBe("edge");
    expect(parseConsoleState({ state: [] })).toBe("default");
  });
});

describe("consoleQuery", () => {
  it("gives every state a URL that reproduces it", () => {
    expect(consoleQuery("default")).toBe("");
    expect(consoleQuery("edge")).toBe("?state=edge");
  });

  it("round-trips through the parser", () => {
    for (const state of CONSOLE_STATES) {
      const query = consoleQuery(state);
      const parsed = query === "" ? {} : { state: query.slice("?state=".length) };
      expect(parseConsoleState(parsed)).toBe(state);
    }
  });
});

describe("isLiveState", () => {
  it("is true for exactly one state", () => {
    expect(CONSOLE_STATES.filter(isLiveState)).toEqual(["default"]);
  });
});
