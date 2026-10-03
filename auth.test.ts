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
  const result = await auth.registrationOptions({ email: "vincent@example.com" });

  expect(result.options.rp.id).toBe("localhost");
  expect(result.options.user.name).toBe("vincent@example.com");
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

  expect(auth.user(request)).toEqual({ id: userId, name: "Vincent", email: null });
  expect(auth.logout(request)).toContain("HttpOnly");
  expect(auth.logout(request)).toContain("Max-Age=0");
  expect(auth.user(request)).toBeNull();
});

test("rejects an email address without an @ before creating a challenge", async () => {
  const auth = await setup();
  await expect(auth.registrationOptions({ email: "not-an-email" })).rejects.toThrow();
  expect(auth.db.query("SELECT COUNT(*) AS count FROM challenges").get()).toEqual({ count: 0 });
});

test("uses one email entry point to choose signup or login", async () => {
  const auth = await setup();
  const email = "vincent@example.com";

  const signup = await auth.options({ email });
  expect(signup.mode).toBe("register");

  const userId = crypto.randomUUID();
  auth.db.query("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, "vincent", email, Date.now());
  auth.db.query(`INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("credential-id", userId, new Uint8Array([1]), 0, "[]", Date.now());

  const login = await auth.options({ email: "  VINCENT@example.com " });
  expect(login.mode).toBe("login");
  expect(login.options.allowCredentials).toEqual([{ id: "credential-id", transports: [], type: "public-key" }]);
});

test("stores morning briefing preference and timezone", async () => {
  const auth = await setup();
  const userId = crypto.randomUUID();
  auth.db.query("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, "vincent", "vincent@example.com", Date.now());

  expect(auth.briefingSettings(userId)).toMatchObject({ enabled: false, timezone: "UTC", hour: 8 });
  expect(auth.updateBriefingSettings(userId, { enabled: true, timezone: "Europe/Stockholm" })).toMatchObject({
    enabled: true,
    timezone: "Europe/Stockholm",
    hour: 8,
  });
  expect(() => auth.updateBriefingSettings(userId, { enabled: true, timezone: "not/a-zone" })).toThrow("invalid timezone");
});

test("requires a one-time code to link a Telegram chat to an account", async () => {
  const auth = await setup();
  const userId = crypto.randomUUID();
  auth.db.query("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, "vincent", "vincent@example.com", Date.now());

  expect(auth.telegramUser(42)).toBeNull();
  const { code } = auth.createTelegramLinkCode(userId);
  expect(auth.linkTelegram(42, code)).toMatchObject({ id: userId, email: "vincent@example.com" });
  expect(auth.telegramUser(42)).toMatchObject({ id: userId });
  expect(() => auth.linkTelegram(43, code)).toThrow("invalid or expired link code");
});

test("accepts any email address with an @", async () => {
  const auth = await setup();
  for (const email of ["a@b", "ÅSA@exempel.se", "first.last+notes@sub.example.co.uk"]) {
    await expect(auth.registrationOptions({ email })).resolves.toBeDefined();
  }
});
