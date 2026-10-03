import { expect, test } from "bun:test";
import { passkeyContext } from "./worker";

test("passkeys use the browser origin behind Wrangler's remote dev proxy", () => {
  const request = new Request("https://noter.example.workers.dev/api/auth/options", {
    method: "POST",
    headers: { origin: "http://localhost:8787" },
  });
  expect(passkeyContext(request)).toEqual({ rpID: "localhost", origin: "http://localhost:8787" });
});

test("passkeys reject unrelated forwarded origins", () => {
  const request = new Request("https://noter.example.workers.dev/api/auth/options", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });
  expect(passkeyContext(request)).toEqual({
    rpID: "noter.example.workers.dev",
    origin: "https://noter.example.workers.dev",
  });
});
