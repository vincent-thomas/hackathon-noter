# Noter

Talk to it in the browser. It transcribes what you say (`gemini-3.5-transcribe`), stores the raw capture, lets a Gemini 3.8 Flash agent organize useful persistent memory, and acknowledges the capture with Gemini TTS (`gemini-3.8-flash-lite-tts`). Telegram voice notes use the same pipeline.

## Run it

You need a Gemini API key. Get one at https://aistudio.google.com/apikey.

```sh
echo GEMINI_API_KEY=your-key > .env
docker compose up
```

For optional large-context compression, add `CONDENSE_API_KEY=ak_...` to `.env`. Condense is only called when derived memory exceeds the harness's inline budget; it compresses prompt context, never stored memory. API access and the `compress` capability must be enabled on the Condense account.

Open http://localhost:3000. Tap the mic, talk, tap again. A single recording can contain information to remember, questions about existing memory, or both. The agent stores useful new information and speaks its answer; a capture without a question receives a short acknowledgement.

The sign-in screen always asks for an email and a passkey. A new email silently creates an account; an existing email signs in—there are no passwords. Passkeys work on `localhost`; deployed environments must use HTTPS and configure:

```sh
PASSKEY_RP_ID=noter.example.com
PASSKEY_ORIGIN=https://noter.example.com
```

The project folder is mounted into the container. Saving `server.ts` restarts the server, and `index.html` changes show up when you reload the page.

## Authenticated API

The capture and query endpoints require the `noter_session` HttpOnly cookie issued after passkey authentication. Browser requests include it automatically. Non-browser clients should authenticate through WebAuthn and retain the returned cookie.

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
2. Put the token it gives you into `.env` as `TELEGRAM_BOT_TOKEN=…`, then restart with `docker compose up`.
3. Sign in to the locally running Noter website, open Settings, and select **Generate code** under Telegram.
4. Send `/link CODE` to the bot within 10 minutes.
5. Send your bot a voice note or text message. It uses the same memory as your web account and answers in kind.

With `ECHO=1` the bot sends your own voice note or text straight back after a short pause, without calling Gemini. If something breaks, the chat only gets "Something broke, check the logs." and the details go to `docker compose logs`.

The bot asks Telegram for new messages itself, so it needs no public URL. Keep the token secret: whoever has it controls the bot. If it leaks, send `/revoke` to BotFather.

An unlinked Telegram chat receives linking instructions and cannot call Gemini or access memory. Link codes are single-use, expire after 10 minutes, and require an authenticated Noter session to create.

## Debugging

To debug the page without spending Gemini tokens, add `ECHO=1` to `.env` and restart with `docker compose up`. The server then plays your recording back without calling Gemini.

## Run without Docker

Needs [Bun](https://bun.sh). Voice-note conversion also needs `ffmpeg`:

```sh
GEMINI_API_KEY=your-key bun --watch server.ts
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
bunx wrangler secret put CONDENSE_API_KEY # optional
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

## Test

```sh
bun test
```

Gemini is mocked in the tests, so no key is needed.

## Troubleshooting

- **The page shows a `502` with a Gemini error.** The message names the model that failed and includes Google's own error text. A `400` from `gemini-3.5-transcribe` usually means it rejected the audio format (Chrome records WebM). A `404` means your key can't reach that model ID; change it in `server.ts`. A `403` means the key is wrong.
- **The page shows a Pi or Gemini error.** Check that `GEMINI_API_KEY` is available to both the transcription calls and the memory agent.
- **Passkey creation or sign-in fails.** Open the app at exactly `PASSKEY_ORIGIN`. Outside localhost, HTTPS is required and `PASSKEY_RP_ID` must match the site's domain.
- **The mic doesn't start.** Browsers only allow the microphone on `localhost` or HTTPS. Open the page at `localhost`, not at your LAN IP.
