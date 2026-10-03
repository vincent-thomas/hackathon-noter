import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PasskeyAuth } from "./auth";

let directory: string | undefined;

async function setup() {
  directory = await mkdtemp(join(tmpdir(), "noter-auth-"));
  return new PasskeyAuth({
    databasePath: join(directory, "accounts.sqlite"),
    rpID: "localhost",
    origin: "http://localhost:3000",
  });
}

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("creates discoverable, user-verified passkey registration options", async () => {
  const auth = await setup();
  const result = await auth.registrationOptions({ name: "Vincent" });

  expect(result.options.rp.id).toBe("localhost");
  expect(result.options.user.name).toBe("Vincent");
  expect(result.options.authenticatorSelection).toMatchObject({
    residentKey: "required",
    userVerification: "required",
  });
  expect(result.ceremonyId).toBeString();
  expect(auth.db.query("SELECT type FROM challenges WHERE id = ?").get(result.ceremonyId)).toEqual({
    type: "registration",
  });
});

test("creates username-less authentication options", async () => {
  const auth = await setup();
  const result = await auth.authenticationOptions();

  expect(result.options.rpId).toBe("localhost");
  expect(result.options.userVerification).toBe("required");
  expect(result.options.allowCredentials).toEqual([]);
});

test("resolves and revokes an opaque HttpOnly session", async () => {
  const auth = await setup();
  const userId = crypto.randomUUID();
  const token = "secret-session-token";
  const tokenHash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
  auth.db.query("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").run(userId, "Vincent", Date.now());
  auth.db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(tokenHash, userId, Date.now() + 60_000);
  const request = new Request("http://localhost", { headers: { cookie: `noter_session=${token}` } });

  expect(auth.user(request)).toEqual({ id: userId, name: "Vincent" });
  expect(auth.logout(request)).toContain("HttpOnly");
  expect(auth.logout(request)).toContain("Max-Age=0");
  expect(auth.user(request)).toBeNull();
});

test("rejects invalid account names before creating a challenge", async () => {
  const auth = await setup();
  await expect(auth.registrationOptions({ name: "" })).rejects.toThrow();
  expect(auth.db.query("SELECT COUNT(*) AS count FROM challenges").get()).toEqual({ count: 0 });
});
