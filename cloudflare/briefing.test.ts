import { expect, test } from "bun:test";
import { localBriefingTime } from "./briefing";

test("morning briefing eligibility follows the user's timezone", () => {
  const instant = new Date("2026-10-03T06:00:00.000Z");
  expect(localBriefingTime(instant, "Europe/Stockholm")).toEqual({ date: "2026-10-03", hour: 8 });
  expect(localBriefingTime(instant, "America/New_York")).toEqual({ date: "2026-10-03", hour: 2 });
  expect(() => localBriefingTime(instant, "not/a-zone")).toThrow("invalid timezone");
});
