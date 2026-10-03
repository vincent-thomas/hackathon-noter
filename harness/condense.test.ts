import { expect, mock, test } from "bun:test";
import { condenseText } from "./condense";

test("compresses prompt context through Condense's direct API", async () => {
  const fetch = mock(async () => Response.json({
    model: "helene-1",
    messages: [{ role: "user", content: "Erik: deployment tomorrow." }],
  }));

  const result = await condenseText("A very long memory context", {
    apiKey: "ak_test",
    compressionRate: 0.6,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });

  expect(result).toBe("Erik: deployment tomorrow.");
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("https://api.condense.chat/v1/compress");
  expect((init as RequestInit).headers).toEqual(expect.objectContaining({ "x-condense-auth-token": "ak_test" }));
  expect(JSON.parse(String((init as RequestInit).body))).toEqual({
    model: "helene-1",
    compression_rate: 0.6,
    messages: [{ role: "user", content: "A very long memory context" }],
  });
});

test("surfaces Condense errors without exposing the API key", async () => {
  const fetch = mock(async () => new Response("not enabled", { status: 403 }));
  await expect(condenseText("context", {
    apiKey: "ak_secret",
    fetch: fetch as unknown as typeof globalThis.fetch,
  })).rejects.toThrow("Condense 403: not enabled");
});
