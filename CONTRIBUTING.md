# Contributing

Bug reports, driver contributions, and PRs are welcome.

## Setup

```bash
pnpm install
pnpm dev          # Fastify on :4000, Vite on :5173
```

Node `^20.19` or `>=22.12`. `pnpm dev:server` and `pnpm dev:web` run the two
halves separately if you only need one.

## Before opening a PR

```bash
pnpm typecheck
pnpm test
pnpm build
```

All three should pass. Add a test under `tests/` for anything with a branch
in it — query building, validation, pagination. Follow the style of the file
you are editing rather than reformatting it.

## Bug reports

Include the driver, the database version, and what you did. If it involves a
query, the generated SQL from the server log (`LOG_LEVEL=debug`) is usually
the fastest path to a fix.

## Adding a driver

1. Create `packages/drivers/<name>/` implementing `DatabaseDriver` from
   `@pilaniaanand/driver-interface`.
2. Register it in `apps/server/src/registry.ts`.
3. Add it to `KNOWN_DRIVERS` in `bin/db-viewer.js` so `driver add <name>`
   can install it.

The server, the connection store, and every frontend component talk only to
the shared interface, so nothing else needs to change. Capabilities a
database genuinely lacks belong in `DriverCapabilities` — it is better to
report a missing feature than to emulate it badly.

## Security

Do not open a public issue for a security problem. Email
pilaniaanand@gmail.com instead.
