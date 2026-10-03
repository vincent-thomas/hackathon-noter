import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import type { Env, User } from "./types";

// Deliberately loose: an address only needs an @. Strict format checks reject real addresses,
// and local ones like test@localhost.
const EmailInput = z.object({ email: z.string().trim().toLowerCase().includes("@").max(254) }).strict();
const VerifyInput = z.object({ ceremonyId: z.string().uuid(), response: z.record(z.string(), z.unknown()) }).strict();
const COOKIE = "noter_session";

type Challenge = { id: string; type: "registration" | "authentication"; challenge: string; user_id: string | null; email: string; expires_at: number };
type Credential = { id: string; user_id: string; public_key: ArrayBuffer; counter: number; transports: string };

export async function authOptions(env: Env, input: unknown) {
  const { email } = EmailInput.parse(input);
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (!user) {
    const userId = crypto.randomUUID();
    const options = await generateRegistrationOptions({
      rpName: "Noter",
      rpID: env.PASSKEY_RP_ID,
      userID: new TextEncoder().encode(userId),
      userName: email,
      userDisplayName: email.split("@")[0],
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const ceremonyId = await challenge(env, "registration", options.challenge, email, userId);
    return { mode: "register" as const, ceremonyId, options };
  }

  const credentials = (await env.DB.prepare("SELECT id, transports FROM credentials WHERE user_id = ?").bind(user.id).all<{ id: string; transports: string }>()).results;
  const options = await generateAuthenticationOptions({
    rpID: env.PASSKEY_RP_ID,
    userVerification: "required",
    allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: JSON.parse(credential.transports) })),
  });
  const ceremonyId = await challenge(env, "authentication", options.challenge, email, user.id);
  return { mode: "login" as const, ceremonyId, options };
}

export async function verifyRegistration(env: Env, input: unknown) {
  const parsed = VerifyInput.parse(input);
  const row = await takeChallenge(env, parsed.ceremonyId, "registration");
  if (!row.user_id) throw new Error("invalid registration challenge");
  const verification = await verifyRegistrationResponse({
    response: parsed.response as unknown as RegistrationResponseJSON,
    expectedChallenge: row.challenge,
    expectedOrigin: env.PASSKEY_ORIGIN,
    expectedRPID: env.PASSKEY_RP_ID,
    requireUserVerification: true,
  });
  if (!verification.verified) throw new Error("passkey registration failed");
  const credential = verification.registrationInfo.credential;
  const name = row.email.split("@")[0];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)").bind(row.user_id, name, row.email, Date.now()),
    env.DB.prepare(`INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(credential.id, row.user_id, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), Date.now()),
  ]);
  return session(env, { id: row.user_id, name, email: row.email });
}

export async function verifyAuthentication(env: Env, input: unknown) {
  const parsed = VerifyInput.parse(input);
  const challengeRow = await takeChallenge(env, parsed.ceremonyId, "authentication");
  const response = parsed.response as unknown as AuthenticationResponseJSON;
  const credential = await env.DB.prepare("SELECT * FROM credentials WHERE id = ? AND user_id = ?")
    .bind(response.id, challengeRow.user_id).first<Credential>();
  if (!credential) throw new Error("passkey is not registered for this account");
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: env.PASSKEY_ORIGIN,
    expectedRPID: env.PASSKEY_RP_ID,
    requireUserVerification: true,
    credential: {
      id: credential.id,
      publicKey: new Uint8Array(credential.public_key),
      counter: credential.counter,
      transports: JSON.parse(credential.transports),
    },
  });
  if (!verification.verified) throw new Error("passkey authentication failed");
  await env.DB.prepare("UPDATE credentials SET counter = ? WHERE id = ?")
    .bind(verification.authenticationInfo.newCounter, credential.id).run();
  const user = await env.DB.prepare("SELECT id, name, email FROM users WHERE id = ?").bind(credential.user_id).first<User>();
  if (!user) throw new Error("account not found");
  return session(env, user);
}

export async function currentUser(env: Env, request: Request): Promise<User | null> {
  const token = cookies(request.headers.get("cookie"))[COOKIE];
  if (!token) return null;
  return await env.DB.prepare(`SELECT users.id, users.name, users.email FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).bind(await hash(token), Date.now()).first<User>();
}

export async function logout(env: Env, request: Request): Promise<string> {
  const token = cookies(request.headers.get("cookie"))[COOKIE];
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hash(token)).run();
  return cookie("", 0);
}

async function challenge(env: Env, type: Challenge["type"], value: string, email: string, userId?: string) {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires_at <= ?").bind(Date.now()),
    env.DB.prepare("INSERT INTO challenges (id, type, challenge, user_id, email, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, type, value, userId ?? null, email, Date.now() + 300_000),
  ]);
  return id;
}

async function takeChallenge(env: Env, id: string, type: Challenge["type"]): Promise<Challenge> {
  const row = await env.DB.prepare("SELECT * FROM challenges WHERE id = ? AND type = ?").bind(id, type).first<Challenge>();
  await env.DB.prepare("DELETE FROM challenges WHERE id = ?").bind(id).run();
  if (!row || row.expires_at <= Date.now()) throw new Error("passkey challenge expired");
  return row;
}

async function session(env: Env, user: User) {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(Date.now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await hash(token), user.id, Date.now() + 30 * 86400_000),
  ]);
  return { user, cookie: cookie(token, 30 * 86400) };
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookie(value: string, maxAge: number) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function cookies(header: string | null): Record<string, string> {
  return Object.fromEntries((header ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
  }));
}
