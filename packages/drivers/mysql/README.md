# @db-viewer/driver-mysql (planned — Phase 3)

Not implemented yet. Follow the same shape as `packages/drivers/postgres`:
implement `DatabaseDriver` from `@db-viewer/driver-interface` using `mysql2`,
with keyset pagination on the primary key and `mysql2`'s streaming query mode
for `streamQuery`. Register it in `apps/server/src/registry.ts` once ready.
