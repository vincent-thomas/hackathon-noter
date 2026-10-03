# Noter

Talk to it in the browser. It transcribes what you say (`gemini-3.5-transcribe`), hands the text to a harness running in a sandbox container, and speaks the harness's reply with Gemini TTS (`gemini-3.8-flash-tts`). For now the harness only files each transcript as a note and replies with it unchanged. The LLM that records, queries and updates notes comes next.

## Run it

You need a Gemini API key. Get one at https://aistudio.google.com/apikey.

```sh
echo GEMINI_API_KEY=your-key > .env
docker compose up
```

Open http://localhost:3000. Tap the mic, talk, tap again. The page shows what you said, and a Gemini voice says it back.

The project folder is mounted into the container. Saving `server.ts` restarts the server, and `index.html` changes show up when you reload the page.

## The sandbox

Each request runs the harness in a new `alpine` container with no network, no Linux capabilities, 256 MB of memory and a read-only filesystem. The container is deleted when it exits. The first request is slow while Docker pulls `alpine`.

Notes are plain files in `notes/<user id>/` in the project folder (gitignored). There are no users yet, so every request belongs to user 1 and everything goes to `notes/1/`. Each sandbox gets only its user's folder, mounted at `/notes`, and that is the only place the harness can write. To start over, delete the folder.

Docker mounts that folder through the host's Docker daemon, so the app container sees the project at the same absolute path as your machine. Run `docker compose` from the project folder; it uses `$PWD` for that path.

The app container gets the Docker socket so it can start sandboxes. That gives it root on your machine, so keep this setup on your own laptop.

## Voice notes

WhatsApp and Telegram send and play voice notes as OGG/Opus. Ask `/api/talk` for `audio/ogg` and the reply comes back in that format, converted by ffmpeg. To try a round trip without either app:

```sh
curl --data-binary @note.ogg -H 'content-type: audio/ogg' -H 'accept: audio/ogg' localhost:3000/api/talk -o reply.ogg
```

The web page asks for OGG too.

## Telegram

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a name and a username ending in `bot`.
2. Put the token it gives you into `.env` as `TELEGRAM_BOT_TOKEN=…`, then restart with `docker compose up`.
3. Send your bot a voice note. It answers with a voice note, as a reply to yours. Anything else gets "Send me a voice note."

With `ECHO=1` the bot sends your own voice note straight back, without calling Gemini. If something breaks, the chat only gets "Something broke, check the logs." and the details go to `docker compose logs`.

The bot asks Telegram for new messages itself, so it needs no public URL. Keep the token secret: whoever has it controls the bot. If it leaks, send `/revoke` to BotFather.

**Temporary: there is no access control.** Anyone who finds the bot's username can use it, and everything they send lands in user 1's notes. Add an allowlist of Telegram user IDs before you share the username.

## Debugging

To debug the page without spending Gemini tokens, add `ECHO=1` to `.env` and restart with `docker compose up`. The server then plays your recording back without calling Gemini.

## Run without Docker

Needs [Bun](https://bun.sh) and Docker for the sandbox:

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
- **The page shows `docker exited …`.** The text after it is Docker's own error. `Cannot connect to the Docker daemon` means the app can't reach the Docker socket; check that Docker is running.
- **The mic doesn't start.** Browsers only allow the microphone on `localhost` or HTTPS. Open the page at `localhost`, not at your LAN IP.
