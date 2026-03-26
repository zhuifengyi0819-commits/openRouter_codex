# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the TypeScript source. Use `src/server.ts` as the service entry point, `src/routes/` for Fastify route registration, `src/core/` for runtime, routing, auth, scheduling, and storage logic, `src/providers/` for upstream API clients, `src/adapters/` for provider-specific translation, `src/cli/` for local admin commands, and `src/types/` for shared API types. Compiled output is written to `dist/` and should stay buildable from source. Runtime secrets and local state live in `.env` and `.gateway-data/`; treat both as local-only.

## Build, Test, and Development Commands
Install dependencies with `npm install`. Use `npm run dev` to start the gateway in watch mode via `tsx`. Use `npm run login` or `npm run admin` to launch the local admin setup flow. Use `npm run build` to compile TypeScript to `dist/`, `npm run start` to run the built server, and `npm run check` to run the strict TypeScript type check without emitting files.

## Coding Style & Naming Conventions
Match the existing code style: TypeScript ESM, 2-space indentation, double quotes, and no semicolons. Keep imports explicit and use `.js` extensions in local import specifiers, even inside `.ts` files. Prefer descriptive PascalCase for classes (`GatewayRuntime`), camelCase for functions and variables (`loadConfig`), and suffix-based filenames such as `*.provider.ts`, `*.adapter.ts`, and `*.route`-style route modules under `src/routes/`.

## Testing Guidelines
There is no dedicated automated test suite configured in this checkout. Before opening changes, run `npm run check`, then smoke test the affected flow with `npm run dev` or `npm run login`. For new tests, place them near the feature or under a future `test/` directory, and name them after the target module, for example `router.test.ts`.

## Commit & Pull Request Guidelines
Git history is not available in this workspace snapshot, so follow a simple convention: short imperative commit subjects such as `Add OAuth token refresh guard`. Keep commits focused and explain behavior changes in the body when needed. Pull requests should summarize the user-visible impact, list config changes, link the relevant issue, and include screenshots or terminal output when admin UI or setup flows change.

## Security & Configuration Tips
Never commit real API keys, OAuth secrets, `.env`, or `.gateway-data/`. Document new environment variables in `.env.example` and `README.md` whenever configuration behavior changes.
