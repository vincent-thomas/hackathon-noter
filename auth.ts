import { Database } from "bun:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const SESSION_COOKIE = "noter_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_SECONDS = 5 * 60;

// Deliberately loose: an address only needs an @. Strict format checks reject real addresses.
const EmailInput = z.object({ email: z.string().trim().toLowerCase().includes("@").max(254) }).strict();
const CeremonyInput = z.object({ ceremonyId: z.string().uuid(), response: z.record(z.string(), z.unknown()) }).strict();

type ChallengeRow = {
  id: string;
  type: "registration" | "authentication";
  challenge: string;
  user_id: string | null;
  name: string | null;
  expires_at: number;
};

type CredentialRow = {
  id: string;
  user_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
};

export type AuthUser = { id: string; name: string };

export class PasskeyAuth {
  readonly db: Database;
  readonly rpID: string;
  readonly origin: string;

  constructor(options: { databasePath: string; rpID: string; origin: string }) {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.db = new Database(options.databasePath, { create: true });
    this.rpID = options.rpID;
    this.origin = options.origin;
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        challenge TEXT NOT NULL,
        user_id TEXT,
        name TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
    `);
    const columns = this.db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "email")) this.db.run("ALTER TABLE users ADD COLUMN email TEXT");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL");
  }

  async registrationOptions(input: unknown) {
    const { email } = EmailInput.parse(input);
    if (this.db.query("SELECT 1 FROM users WHERE email = ?").get(email)) throw new Error("account already exists");
    const userId = crypto.randomUUID();
    const name = email.split("@")[0];
    const options = await generateRegistrationOptions({
      rpName: "Noter",
      rpID: this.rpID,
      userID: new TextEncoder().encode(userId),
      userName: email,
      userDisplayName: name,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const ceremonyId = this.#challenge("registration", options.challenge, userId, email);
    return { ceremonyId, options };
  }

  async options(input: unknown) {
    const { email } = EmailInput.parse(input);
    const user = this.db.query("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | null;
    if (!user) return { mode: "register" as const, ...await this.registrationOptions({ email }) };
    return { mode: "login" as const, ...await this.authenticationOptions({ email }) };
  }

  async verifyRegistration(input: unknown): Promise<{ user: AuthUser; cookie: string }> {
    const parsed = CeremonyInput.parse(input);
    const challenge = this.#takeChallenge(parsed.ceremonyId, "registration");
    const verification = await verifyRegistrationResponse({
      response: parsed.response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !challenge.user_id || !challenge.name) throw new Error("passkey registration failed");

    const credential = verification.registrationInfo.credential;
    const email = challenge.name;
    const name = email.split("@")[0];
    this.db.transaction(() => {
      this.db.query("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
        .run(challenge.user_id, name, email, Date.now());
      this.db.query(`INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          credential.id,
          challenge.user_id,
          Buffer.from(credential.publicKey),
          credential.counter,
          JSON.stringify(credential.transports ?? []),
          Date.now(),
        );
    })();
    return { user: { id: challenge.user_id, name }, cookie: this.#session(challenge.user_id) };
  }

  async authenticationOptions(input?: unknown) {
    const email = input === undefined ? undefined : EmailInput.parse(input).email;
    const credentials = email
      ? this.db.query(`SELECT credentials.id, credentials.transports FROM credentials
          JOIN users ON users.id = credentials.user_id WHERE users.email = ?`).all(email) as Array<{ id: string; transports: string }>
      : [];
    if (email && credentials.length === 0) throw new Error("account not found");
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: JSON.parse(credential.transports),
      })),
    });
    return { ceremonyId: this.#challenge("authentication", options.challenge), options };
  }

  async verifyAuthentication(input: unknown): Promise<{ user: AuthUser; cookie: string }> {
    const parsed = CeremonyInput.parse(input);
    const challenge = this.#takeChallenge(parsed.ceremonyId, "authentication");
    const response = parsed.response as unknown as AuthenticationResponseJSON;
    const credential = this.db.query("SELECT * FROM credentials WHERE id = ?").get(response.id) as CredentialRow | null;
    if (!credential) throw new Error("passkey is not registered");
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.counter,
        transports: JSON.parse(credential.transports),
      },
    });
    if (!verification.verified) throw new Error("passkey authentication failed");
    this.db.query("UPDATE credentials SET counter = ? WHERE id = ?")
      .run(verification.authenticationInfo.newCounter, credential.id);
    const user = this.db.query("SELECT id, name FROM users WHERE id = ?").get(credential.user_id) as AuthUser | null;
    if (!user) throw new Error("account not found");
    return { user, cookie: this.#session(user.id) };
  }

  user(request: Request): AuthUser | null {
    const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
    if (!token) return null;
    const user = this.db.query(`SELECT users.id, users.name FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
      .get(hash(token), Date.now()) as AuthUser | null;
    return user ?? null;
  }

  logout(request: Request): string {
    const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
    if (token) this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
    return cookie("", 0, this.origin.startsWith("https://"));
  }

  #challenge(type: ChallengeRow["type"], challenge: string, userId?: string, name?: string): string {
    this.db.query("DELETE FROM challenges WHERE expires_at <= ?").run(Date.now());
    const id = crypto.randomUUID();
    this.db.query("INSERT INTO challenges (id, type, challenge, user_id, name, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, type, challenge, userId ?? null, name ?? null, Date.now() + CHALLENGE_SECONDS * 1000);
    return id;
  }

  #takeChallenge(id: string, type: ChallengeRow["type"]): ChallengeRow {
    const row = this.db.query("SELECT * FROM challenges WHERE id = ? AND type = ?").get(id, type) as ChallengeRow | null;
    this.db.query("DELETE FROM challenges WHERE id = ?").run(id);
    if (!row || row.expires_at <= Date.now()) throw new Error("passkey challenge expired");
    return row;
  }

  #session(userId: string): string {
    const token = randomToken();
    this.db.query("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    this.db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(hash(token), userId, Date.now() + SESSION_SECONDS * 1000);
    return cookie(token, SESSION_SECONDS, this.origin.startsWith("https://"));
  }
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function parseCookies(header: string | null): Record<string, string> {
  return Object.fromEntries((header ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
  }));
}
