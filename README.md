# Noter

Talk to it in the browser. It transcribes what you say (`gemini-3.5-transcribe`), stores the raw capture, lets a Gemini 3.8 Flash agent organize useful persistent memory, and acknowledges the capture with Gemini TTS (`gemini-3.8-flash-tts`). Telegram voice notes use the same pipeline.

## Run it

You need a Gemini API key. Get one at https://aistudio.google.com/apikey.

```sh
echo GEMINI_API_KEY=your-key > .env
docker compose up
```

Open http://localhost:3000. Tap the mic, talk, tap again. A single recording can contain information to remember, questions about existing memory, or both. The agent stores useful new information and speaks its answer; a capture without a question receives a short acknowledgement.

The project folder is mounted into the container. Saving `server.ts` restarts the server, and `index.html` changes show up when you reload the page.

## Programmatic API

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

Both endpoints currently use user 1's sandbox because authentication is not implemented yet.

## Memory

There are no users yet, so every web and Telegram capture belongs to user 1. Persistent Markdown lives in `notes/1/`:

```text
notes/1/
├── inbox/
├── tasks/
├── events/
├── memory/
└── briefings/
```

The backend creates immutable raw files under `/inbox`. The Pi agent receives only the typed `read_memory`, `list_memory`, `search_memory`, and create-only `write_memory` tools. It has no shell or raw filesystem tool and cannot write to `/inbox`. To start over, delete `notes/1/`.

Programmatic capture and query APIs remain available under [`harness/`](harness/README.md).

## Voice notes

WhatsApp and Telegram send and play voice notes as OGG/Opus. Ask `/api/talk` for `audio/ogg` and the reply comes back in that format, converted by ffmpeg. To try a round trip without either app:

```sh
curl --data-binary @note.ogg -H 'content-type: audio/ogg' -H 'accept: audio/ogg' localhost:3000/api/talk -o reply.ogg
```

The web page asks for OGG too.

## Telegram

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a name and a username ending in `bot`.
2. Put the token it gives you into `.env` as `TELEGRAM_BOT_TOKEN=…`, then restart with `docker compose up`.
3. Send your bot a voice note or a text message. It answers in kind, as a reply to yours: a voice note for a voice note, text for text. Anything else gets "Send me a voice note or a text message."

With `ECHO=1` the bot sends your own voice note or text straight back after a short pause, without calling Gemini. If something breaks, the chat only gets "Something broke, check the logs." and the details go to `docker compose logs`.

The bot asks Telegram for new messages itself, so it needs no public URL. Keep the token secret: whoever has it controls the bot. If it leaks, send `/revoke` to BotFather.

**Temporary: there is no access control.** Anyone who finds the bot's username can use it, and everything they send lands in user 1's notes. Add an allowlist of Telegram user IDs before you share the username.

## Debugging

To debug the page without spending Gemini tokens, add `ECHO=1` to `.env` and restart with `docker compose up`. The server then plays your recording back without calling Gemini.

## Run without Docker

Needs [Bun](https://bun.sh). Voice-note conversion also needs `ffmpeg`:

```sh
GEMINI_API_KEY=your-key bun --watch server.ts
```

## Test

```sh
bun test
```

Gemini is mocked in the tests, so no key is needed.

## Troubleshooting

- **The page shows a `502` with a Gemini error.** The message names the model that failed and includes Google's own error text. A `400` from `gemini-3.5-transcribe` usually means it rejected the audio format (Chrome records WebM). A `404` means your key can't reach that model ID; change it in `server.ts`. A `403` means the key is wrong.
- **The page shows a Pi or Gemini error.** Check that `GEMINI_API_KEY` is available to both the transcription calls and the memory agent.
- **The mic doesn't start.** Browsers only allow the microphone on `localhost` or HTTPS. Open the page at `localhost`, not at your LAN IP.
