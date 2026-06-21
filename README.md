# ExampleSandboxENV

Ephemeral code-execution sandbox for the SMART IDLE platform. Deploy on Railway.

## Endpoints

### `POST /run`
Run a single command against a fresh workspace.
```json
{ "runtime": "node", "command": "node index.js", "files": [{ "path": "index.js", "content": "console.log(1)" }] }
```

### `POST /agent/test` (required before `/agent/install`)
Validate a user-supplied Mistral API key + model. Returns `{ ok: true }` only if the model responds correctly to a trivial instruction.
```json
{ "apiKey": "sk-...", "model": "mistral-large-latest" }
```

### `POST /agent/install`
Run an agentic install loop using the user's own Mistral key/model. The model can call a `run_command` tool inside the workspace.
```json
{
  "apiKey": "sk-...",
  "model": "mistral-large-latest",
  "instruction": "Scaffold an Express app with TypeScript and install deps.",
  "files": [],
  "runtime": "node",
  "maxSteps": 12
}
```

The endpoint re-runs the PONG check before doing real work. Each tool command has a 60-second timeout.

## Deploy

1. Fork this repo.
2. Create a Railway project from the fork (Dockerfile is auto-detected).
3. No environment variables are required — users bring their own Mistral keys at request time.
