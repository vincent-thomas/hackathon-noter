import { expect, test } from "bun:test";
import { authOptions } from "./auth";

// A database with no users yet: sign-in options for any email start a registration.
const emptyDb = {
  prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }) }),
  batch: async () => [],
};
const env = { DB: emptyDb, PASSKEY_RP_ID: "localhost" } as any;

test("accepts any email address with an @, local ones included", async () => {
  for (const email of ["test@localhost", "a@b", "ÅSA@exempel.se", "first.last+notes@sub.example.co.uk"]) {
    expect((await authOptions(env, { email })).mode).toBe("register");
  }
});

test("rejects an email address without an @", async () => {
  await expect(authOptions(env, { email: "not-an-email" })).rejects.toThrow();
});
