# Noter

Talk to it in the browser. It transcribes what you say (`gemini-3.5-transcribe`) and says it back with Gemini TTS (`gemini-3.8-flash-tts`). The harness that answers comes next.

## Run it

You need a Gemini API key. Get one at https://aistudio.google.com/apikey.

```sh
echo GEMINI_API_KEY=your-key > .env
docker compose up
```

Open http://localhost:3000. Tap the mic, talk, tap again. The page shows what you said and a Gemini voice repeats it.

The project folder is mounted into the container. Saving `server.ts` restarts the server, and `index.html` changes show up when you reload the page.

## Run without Docker

Needs [Bun](https://bun.sh):

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
- **The mic doesn't start.** Browsers only allow the microphone on `localhost` or HTTPS. Open the page at `localhost`, not at your LAN IP.
