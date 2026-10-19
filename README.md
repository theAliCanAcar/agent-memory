# Agent Memory

Three-level memory: working state, session history, long-term semantic memory (Supabase/pgvector or in-memory).

TypeScript package `agent-memory`.

## Install

```sh
npm install github:theAliCanAcar/agent-memory#main
```

## How to use

```ts
import { createMemory } from 'agent-memory';

const memory = createMemory({});
await memory.longTerm?.remember?.({ text: 'Customer prefers email', tags: ['pref'] });
console.log(await memory.longTerm?.search?.('email preference'));
```

## Use cases

### 1. Remember facts across turns

- **Scenario:** A user corrects a preference mid-session.
- **Outcome:** Write to long-term memory and retrieve it on later turns.

### 2. Keep working state for a multi-step task

- **Scenario:** An invoice workflow needs intermediate results.
- **Outcome:** Store transient values in working/session memory without polluting long-term storage.

## Dependencies

- `agent-tools`: `github:theAliCanAcar/agent-tools#main`

## Scripts

```sh
npm install
npm run build
```

## Notes

- Keep API keys in environment variables or a gitignored `.env`. Never commit secrets.
- Side-effecting tools should go through approval when used with `agent-approval`.
- Related packages live in separate repositories under [theAliCanAcar](https://github.com/theAliCanAcar).

## License

MIT
