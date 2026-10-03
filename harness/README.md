# Memory harness

The harness is intended for programmatic use:

```text
capture → backend-owned /inbox file → Pi agent → derived memory
query → read-only Pi agent → answer + accessed paths
```

Set `GEMINI_API_KEY` in the environment or `.env`. `MEMORY_ROOT` selects the persistent user sandbox and defaults to `notes/cli`. `PI_MODEL` optionally overrides the default `gemini-3.8-flash` model.

## JSON CLI

Every invocation writes exactly one JSON object to standard output. Errors also use JSON and return a nonzero exit status.

```sh
bun harness/cli.ts capture \
  "Ask Erik about deployment tomorrow. The Docker image may be causing startup latency."
```

```json
{"capture":{"path":"/inbox/...md","id":"capture-id"},"createdPaths":["/tasks/ask-erik-about-deployment.md"],"response":"Capture processed."}
```

Query accumulated memory:

```sh
bun harness/cli.ts query "What do I need to discuss with Erik?"
```

```json
{"answer":"You need to discuss deployment with Erik.","accessedPaths":["/tasks/ask-erik-about-deployment.md"]}
```

`accessedPaths` is separate provenance metadata and is not included in the answer. The older `--json` flag remains accepted but is unnecessary because all output is JSON.

## TypeScript API

```ts
import { captureMemory, queryMemoryWorkflow } from "./harness";

const capture = await captureMemory({
  sandboxRoot: "./notes/user-1",
  transcript: "Ask Erik about deployment tomorrow",
  source: "text",
});

const query = await queryMemoryWorkflow({
  sandboxRoot: "./notes/user-1",
  question: "What do I need to discuss with Erik?",
});

console.log(capture.createdPaths);
console.log(query.answer, query.accessedPaths);
```

The high-level API accepts optional `model` and `onEvent` fields. Lower-level schemas, storage operations, and tool factories remain exported from `./harness` for backend integration and testing.
