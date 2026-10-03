# Noter

Talk to it in the browser. It transcribes what you say (`gemini-3.5-transcribe`), stores the raw capture, lets a Gemini Flash agent (`gemini-3.5-flash-lite`) organize useful persistent memory, and acknowledges the capture with Gemini TTS (`gemini-3.8-flash-lite-tts`). Telegram voice notes use the same pipeline.

Production: https://noter.7p80u8m6.workers.dev

## Problem, solution, and how it works

Thoughts rarely arrive as clean tasks or calendar entries. A person may mention a commitment, an uncertain idea, and a question in the same sentence. Conventional note-taking tools make the person stop, classify that information, and decide where it belongs. That friction is often enough to prevent capture entirely.

Noter is an external brain for those unstructured thoughts. The user speaks or types naturally; Noter preserves the original capture, extracts only information with future value, and organizes it into durable tasks, events, and general memory. The same interaction may also contain a question, which Noter answers from accumulated memory. No note type, form, or approval step is required.

The core flow is:

```text
speak or type
    -> transcribe when needed
    -> preserve an immutable inbox capture
    -> let the memory agent search prior context
    -> append useful derived Markdown memories
    -> answer the user's question, if any
    -> resurface relevant context through queries and morning briefings
```

The raw inbox is evidence and is never changed by the agent. Derived memories are also create-only: when later information corrects an earlier belief, the agent writes a new file instead of silently rewriting history. This deliberately small, inspectable design tests the central product idea without requiring a vector database or a rigid personal-information ontology.

## Architecture

```mermaid
flowchart TD
    U[Browser or Telegram user] -->|voice or text| W[Cloudflare Worker]
    W -->|account, passkeys, sessions, settings, Telegram links| D[(Cloudflare D1)]
    W -->|transcribe, reason, synthesize speech| G[Gemini API]
    W --> H[Typed memory harness]
    H -->|per-user Markdown objects| R[(Cloudflare R2)]
    T[Hourly Cron Trigger] --> W
    W -->|08:00 in each user's timezone| E[Resend email]
    TG[Telegram shared webhook] --> W
    W -->|chat ID resolves to user ID| D
```

The Cloudflare Worker is the production application boundary. It serves the static PWA, verifies passkeys, scopes every protected request to a user, calls Gemini, runs the memory harness, accepts Telegram updates, and runs scheduled briefings. D1 stores structured control data; R2 stores the contents of each user's virtual Markdown filesystem.

### Code layout

```text
local/       Bun development server, local passkeys, live audio, and Telegram polling
cloudflare/  Production Worker, D1/R2 adapters, briefings, and Telegram webhook
harness/     Shared Markdown memory model, typed tools, Pi agent, and programmatic CLI
```

Tests live beside the code they cover. Root-level files are project configuration and browser assets.

## Technology inventory

| Technology | Role |
| --- | --- |
| TypeScript and Bun | Application language, local server, CLI, tests, and package runner |
| Cloudflare Workers and Static Assets | Production API runtime and PWA hosting |
| Cloudflare D1 | Users, passkey credentials, challenges, sessions, settings, briefing delivery state, and Telegram links |
| Cloudflare R2 | Persistent per-user Markdown memory |
| Gemini API | Voice transcription, agent reasoning, query answers, briefings, and browser speech synthesis |
| Pi coding-agent SDK | Agent loop and typed tool execution in the local filesystem harness |
| WebAuthn via SimpleWebAuthn | Passwordless passkey registration and authentication |
| Zod | Request, tool-input, and Markdown-frontmatter validation |
| Resend | Delivery of morning briefing email |
| Telegram Bot API | Text and voice capture through a shared production webhook |
| Wrangler | Local Worker development, migrations, secrets, previews, and deployment |
| Docker Compose | Optional local Bun-server development environment |

## Run it

You need a Gemini API key. Get one at https://aistudio.google.com/apikey.

```sh
echo GEMINI_API_KEY=your-key > .env
docker compose up
```

Open http://localhost:3000. Tap the mic, talk, tap again. A single recording can contain information to remember, questions about existing memory, or both. The agent stores useful new information and speaks its answer; a capture without a question receives a short acknowledgement.

The sign-in screen always asks for an email and a passkey. A new email silently creates an account; an existing email signs in—there are no passwords. Passkeys work on `localhost`; deployed environments must use HTTPS and configure:

```sh
PASSKEY_RP_ID=noter.example.com
PASSKEY_ORIGIN=https://noter.example.com
```

The project folder is mounted into the container. Saving `local/server.ts` restarts the server, and `index.html` changes show up when you reload the page.

## Authenticated API

The capture and query endpoints require the `noter_session` HttpOnly cookie issued after passkey authentication. Browser requests include it automatically. Non-browser clients should authenticate through WebAuthn and retain the returned cookie.

### Endpoint reference

| Method and path | Authentication | Purpose |
| --- | --- | --- |
| `POST /api/auth/options` | Public | Accept an email and return either passkey registration or authentication options. |
| `POST /api/auth/register/verify` | Public ceremony | Verify a new passkey, create the account, and issue a session cookie. |
| `POST /api/auth/login/verify` | Public ceremony | Verify an existing passkey and issue a session cookie. |
| `GET /api/auth/me` | Session | Return the signed-in user. |
| `POST /api/auth/logout` | Session | Revoke the current session and clear its cookie. |
| `POST /api/capture/text` | Session | Preserve text in `/inbox`, process it, and return created and accessed paths plus a response. |
| `POST /api/query` | Session | Answer a question from stored memory without creating a capture. |
| `POST /api/talk` | Session | Transcribe uploaded audio, process capture and query content together, and return synthesized audio. |
| `GET /api/settings/briefing` | Session | Read morning-briefing settings. |
| `POST /api/settings/briefing` | Session | Enable or disable briefings and save the user's IANA timezone. |
| `GET /api/settings/telegram` | Session | Report whether this account has a linked Telegram chat. |
| `POST /api/settings/telegram/link-code` | Session | Register the shared webhook and create a single-use, ten-minute link code. |
| `POST /api/telegram/webhook` | Telegram secret | Receive Telegram updates; this is authenticated using Telegram's webhook secret rather than a user cookie. |

`POST /api/auth/options` makes sign-up and sign-in one flow: an unknown email receives registration options, while an existing email receives authentication options. Verification produces a random 30-day session token. Only its SHA-256 hash is stored in D1; the browser receives the original in a `Secure`, `HttpOnly`, `SameSite=Strict` cookie. WebAuthn challenges are single-use and expire after five minutes. In production, the relying-party ID and expected origin are derived from the request URL, so passkeys remain bound to the actual HTTPS deployment domain.

Capture unstructured text:

```sh
curl -sS localhost:3000/api/capture/text \
  -H 'content-type: application/json' \
  -d '{"text":"Ask Erik about deployment tomorrow"}'
```

The response includes the immutable inbox capture, derived paths, files consulted by the agent, and its user-facing response. Questions can be included in the same text as information to remember:

```json
{"capture":{"path":"/inbox/...md","id":"..."},"createdPaths":["/tasks/ask-erik-about-deployment.md"],"accessedPaths":[],"response":"Captured."}
```

Query accumulated memory:

```sh
curl -sS localhost:3000/api/query \
  -H 'content-type: application/json' \
  -d '{"question":"What do I need to discuss with Erik?"}'
```

```json
{"answer":"You need to discuss deployment with Erik.","accessedPaths":["/tasks/ask-erik-about-deployment.md"]}
```

Each response is scoped to the signed-in account. An unauthenticated request returns `401`.

## Memory

Each web account has an isolated persistent Markdown filesystem:

```text
notes/users/<user-id>/
├── inbox/
├── tasks/
├── events/
├── memory/
└── briefings/
```

Account, passkey, challenge, and session state is stored in `notes/accounts.sqlite`. The backend creates immutable raw files under `/inbox`. The Pi agent receives only the typed `read_memory`, `list_memory`, `search_memory`, and create-only `write_memory` tools. It has no shell or raw filesystem tool and cannot write to `/inbox`.

Telegram requires a linked passkey account and uses that account's `notes/users/<user-id>/` memory. Unlinked chats cannot invoke Gemini or the harness.

Programmatic capture and query APIs remain available under [`harness/`](harness/README.md).

## Voice notes

WhatsApp and Telegram send and play voice notes as OGG/Opus. Ask `/api/talk` for `audio/ogg` and the reply comes back in that format, converted by ffmpeg. To try a round trip without either app:

```sh
curl --data-binary @note.ogg -H 'content-type: audio/ogg' -H 'accept: audio/ogg' localhost:3000/api/talk -o reply.ogg
```

Ask for `audio/l16` instead and the reply streams as raw 24 kHz mono 16-bit PCM while Gemini generates it. The first audio arrives about 1 s after the answer is ready, instead of 3–4 s for the whole file:

```sh
curl --data-binary @note.ogg -H 'content-type: audio/ogg' -H 'accept: audio/l16' localhost:3000/api/talk -o reply.pcm
```

The web page asks for this stream and plays it as it arrives.

## Telegram

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a name and a username ending in `bot`.
2. Configure `TELEGRAM_BOT_TOKEN` for the runtime (in `.env` locally or as a Worker secret in production).
3. Sign in to Noter, open Settings, and select **Generate code** under Telegram.
4. Send `/link CODE` to the bot within 10 minutes.
5. Send your bot a voice note or text message. It uses the same memory as your web account and answers in kind.

With `ECHO=1` the bot sends your own voice note or text straight back after a short pause, without calling Gemini. If something breaks, the chat only gets "Something broke, check the logs." and the details go to `docker compose logs`.

The two runtimes receive Telegram updates differently:

- The local Bun server polls Telegram, so local development does not need a public URL.
- The deployed Worker uses one shared `POST /api/telegram/webhook` for the bot. Generating a link code configures that HTTPS webhook with `setWebhook`. Telegram signs deliveries with `TELEGRAM_WEBHOOK_SECRET`; the Worker then maps the incoming chat ID to a Noter user in D1. It does **not** register one webhook per user.

For Cloudflare, configure both secrets before generating a production link code:

```sh
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Keep the bot token and webhook secret private. Whoever has the bot token controls the bot; if it leaks, send `/revoke` to BotFather and replace the Worker secret.

An unlinked Telegram chat receives linking instructions and cannot call Gemini or access memory. Link codes are single-use, expire after 10 minutes, and require an authenticated Noter session to create.

## Debugging

To debug the page without spending Gemini tokens, add `ECHO=1` to `.env` and restart with `docker compose up`. The server then plays your recording back without calling Gemini.

## Run without Docker

Needs [Bun](https://bun.sh). Voice-note conversion also needs `ffmpeg`:

```sh
GEMINI_API_KEY=your-key bun --watch local/server.ts
```

## Deploy to Cloudflare Workers

The Worker deployment uses Cloudflare-native persistence: D1 stores accounts, passkeys, challenges, and sessions; R2 stores each account's immutable Markdown memory; Workers Static Assets serves the browser UI. The passkey RP ID and origin are derived from the deployed request URL, so both `workers.dev` and custom HTTPS domains work without rebuilding.

The production Worker is currently available at https://noter.7p80u8m6.workers.dev.

Authenticate Wrangler and create the two persistent resources once:

```sh
bunx wrangler login
bunx wrangler d1 create noter-accounts
bunx wrangler r2 bucket create noter-memory
```

When deploying into another Cloudflare account, replace `database_id` in `wrangler.jsonc` with the ID returned by `d1 create`. Then configure the secret, migrate, and deploy:

```sh
bunx wrangler secret put GEMINI_API_KEY
bunx wrangler d1 migrations apply noter-accounts --remote
bun run cf:deploy
```

For local `workerd` development, keep `GEMINI_API_KEY` in `.env` and run:

```sh
bunx wrangler d1 migrations apply noter-accounts --local
bun run cf:dev
```

The Worker serves browser speech as WAV directly because Workers cannot spawn `ffmpeg`. The Bun server remains the Telegram/OGG runtime.

### Morning briefings

Users can enable a daily email briefing from Settings. The browser saves their IANA timezone, an hourly Cron Trigger selects accounts whose local time is 08:00, and the memory harness synthesizes an immutable `/briefings/YYYY-MM-DD.md` before Resend delivers it. Daily database claims plus Resend idempotency keys prevent duplicates.

Add the Resend secret before deploying:

```sh
bunx wrangler secret put RESEND_API_KEY
```

The default sender is `Noter <onboarding@resend.dev>`, which is suitable for Resend testing. After verifying a sending domain, change `RESEND_FROM` in `wrangler.jsonc` to an address on that domain.

## Technical evaluation guide

### Multi-user isolation and persistence

Every authenticated request resolves the opaque session token to one D1 user ID before it can reach capture, query, settings, or linking logic. The Worker constructs the memory store with that user ID, and all R2 keys are namespaced under it. The agent only sees virtual paths such as `/tasks/follow-up.md`; it never sees an R2 key, host path, or another user's namespace. Telegram follows the same boundary: a chat ID must first resolve through `telegram_links` to a user ID, after which it enters the same capture pipeline as the website.

D1 and R2 have intentionally different responsibilities. D1 holds relational control data that needs lookup and uniqueness constraints: identities, public passkey credentials, short-lived challenges, hashed sessions, preferences, delivery claims, and Telegram associations. R2 holds the human-readable memory documents. This keeps memory portable and inspectable while still giving account and delivery workflows transactional storage.

### Passkeys and account lifecycle

The user enters an email and performs one passkey ceremony. If the email is new, successful WebAuthn registration creates the account and credential; if it already exists, successful authentication signs the user in. Private key material never reaches Noter. The server stores the public credential and counter in D1, requires user verification, checks the challenge, origin, and relying-party ID, and then creates a revocable session. The email identifies the intended Noter account and is also the briefing destination; the passkey proves possession of the credential registered to that account.

### Append-only memory harness

Each capture first becomes an immutable Markdown document under `/inbox`. The agent has four narrow tools—`read_memory`, `list_memory`, `search_memory`, and `write_memory`—rather than shell or unrestricted filesystem access. Search is deterministic and grep-like, frontmatter is validated with Zod, and writes are atomic create-only operations. The agent cannot write to `/inbox`, overwrite a path, edit, move, or delete a file. It may produce zero, one, or several derived files under `/tasks`, `/events`, or `/memory`, and the query response separately reports which paths were accessed for provenance without putting source citations in the user-facing answer.

Production implements the same logical contract over R2, with objects namespaced by user. The standalone [`harness`](harness/README.md) provides the filesystem-backed CLI and TypeScript API for programmatic use and testing.

### Scheduled morning briefings

An hourly Cloudflare Cron Trigger scans only users who enabled briefings. For each user, the Worker converts the current time into the saved IANA timezone and proceeds when the local hour is `08:00`. A conditional D1 update claims that user's local date before generation, preventing duplicate deliveries from overlapping or repeated invocations. The agent reads derived memory—not only the latest inbox item—synthesizes a concise `/briefings/YYYY-MM-DD.md` artifact in the user's R2 namespace, and Resend emails it. If generation or delivery fails, the date claim is released for a later retry; successful delivery records its timestamp.

### Security boundaries and deliberate V0 constraints

- The agent has no raw shell, filesystem, D1, R2, authentication, email, or Telegram tool.
- User scoping is enforced by the Worker and storage adapter, not by prompting the model.
- Raw captures and derived memories remain available for audit because agent writes are append-only.
- Telegram rejects requests without the configured webhook-secret header, and unlinked chats cannot invoke Gemini or access memory.
- The system deliberately uses deterministic file search rather than embeddings or hidden relevance scoring. This keeps retrieval behavior inspectable for the prototype.

## Test

```sh
bun test
```

Gemini is mocked in the tests, so no key is needed.

## Troubleshooting

- **The page shows a `502` with a Gemini error.** The message names the model that failed and includes Google's own error text. A `400` from `gemini-3.5-transcribe` usually means it rejected the audio format (Chrome records WebM). A `404` means your key can't reach that model ID; change it in `local/server.ts`. A `403` means the key is wrong.
- **The page shows a Pi or Gemini error.** Check that `GEMINI_API_KEY` is available to both the transcription calls and the memory agent.
- **Passkey creation or sign-in fails.** Open the app at exactly `PASSKEY_ORIGIN`. Outside localhost, HTTPS is required and `PASSKEY_RP_ID` must match the site's domain.
- **The mic doesn't start.** Browsers only allow the microphone on `localhost` or HTTPS. Open the page at `localhost`, not at your LAN IP.
