# Memory harness

The runnable path models the product loop directly:

```text
text capture → backend-owned /inbox file → Pi agent → derived memory files
```

## Run

Set `GEMINI_API_KEY` in `.env`, install dependencies, and start a capture:

```sh
bun install
bun run harness
```

Or provide the capture directly:

```sh
bun run harness -- capture "Ask Erik about deployment tomorrow. The Docker image may be causing startup latency."
```

The CLI prints the agent's tool trajectory and the paths it creates. Persistent files live in `notes/cli/` by default. The agent defaults to `gemini-3.8-flash`. Use a different sandbox with `MEMORY_ROOT=/path/to/memory` and a different Google model with `PI_MODEL=<model-id>`.

Run another capture to let the agent search and build on the same memory:

```sh
bun run harness -- capture "The image-size hypothesis was wrong; startup is waiting for the database connection."
```

Ask a natural-language question across accumulated memory:

```sh
bun run harness -- query "What do I need to discuss with Erik, and what do we know about the startup problem?"
```

Queries are read-only. The query agent receives `list_memory`, `search_memory`, and `read_memory`, but not `write_memory`.

## Inspect or debug

Open the low-level storage shell:

```sh
bun run harness -- shell
```

Its commands are `list`, `read`, `search`, and `write`. A one-shot example is:

```sh
bun run harness -- shell list /memory
```

The shell is for debugging. Normal captures always enter through the backend-only inbox writer; the agent receives no inbox-writing, shell, or raw filesystem tool.
