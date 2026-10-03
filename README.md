# Noter

Talk to it in the browser. Right now it transcribes what you say with Gemini and plays your recording back. The harness and Gemini TTS come next.

## Run it

You need a Gemini API key. Get one at https://aistudio.google.com/apikey.

```sh
echo GEMINI_API_KEY=your-key > .env
docker compose up
```

Open http://localhost:3000. Tap the mic, talk, tap again. The page shows what you said and plays your voice back.

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

- **The page shows a `502` with a Gemini error.** The text after the status code is Google's own error message. `400` usually means Gemini rejected the audio format (Chrome records WebM). `403` means the key is wrong.
- **The mic doesn't start.** Browsers only allow the microphone on `localhost` or HTTPS. Open the page at `localhost`, not at your LAN IP.
