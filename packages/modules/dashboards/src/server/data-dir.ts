import path from "node:path";

// ponytail: same computation as apps/server/src/crypto.ts's DATA_DIR — both
// run in the same process/cwd, so this is byte-identical rather than a
// separate value threaded in as a plugin option. Promote to a DI'd option if
// this module is ever hosted as a genuinely separate process.
export const DATA_DIR = path.resolve(process.cwd(), ".data");
