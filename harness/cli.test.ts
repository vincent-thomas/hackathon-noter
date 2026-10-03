import { expect, test } from "bun:test";
import { parseCliArgs } from "./cli";

test("parses programmatic capture and query commands", () => {
  expect(parseCliArgs(["capture", "Ask Erik", "about deployment"])).toEqual({
    command: "capture",
    text: "Ask Erik about deployment",
  });
  expect(parseCliArgs(["query", "What should I do?"])).toEqual({
    command: "query",
    text: "What should I do?",
  });
});

test("accepts the previous --json flag for compatibility", () => {
  expect(parseCliArgs(["--json", "query", "What matters?"])).toEqual({
    command: "query",
    text: "What matters?",
  });
});

test("rejects interactive and incomplete invocations", () => {
  expect(() => parseCliArgs([])).toThrow("Usage:");
  expect(() => parseCliArgs(["shell"])).toThrow("Usage:");
  expect(() => parseCliArgs(["query"])).toThrow("Usage:");
});

