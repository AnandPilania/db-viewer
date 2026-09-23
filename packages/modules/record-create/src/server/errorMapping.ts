export interface FieldError {
    column: string;
    message: string;
}

interface PgLikeError {
    code?: string;
    column?: string;
    constraint?: string;
    detail?: string;
    message?: string;
}

interface MysqlLikeError {
    errno?: number;
    sqlMessage?: string;
    message?: string;
}

interface SqliteLikeError {
    code?: string;
    message?: string;
}

/** `Key (email)=(x@example.com) already exists.` -> "email" */
function extractPgDetailColumn(detail?: string): string | undefined {
    return detail?.match(/^Key \(([^)]+)\)=/)?.[1];
}

function mapPgError(err: PgLikeError): FieldError[] | null {
    switch (err.code) {
        case "23502": // not_null_violation — pg always populates .column for this one
            return err.column ? [{ column: err.column, message: `${err.column} is required` }] : null;
        case "23505": { // unique_violation
            const column = err.column ?? extractPgDetailColumn(err.detail);
            return column ? [{ column, message: `${column} must be unique` }] : null;
        }
        case "23514": { // check_violation — pg rarely gives a column for this; best effort only
            const column = err.column;
            return column ? [{ column, message: err.message ?? `${column} violates a check constraint` }] : null;
        }
        default:
            return null;
    }
}

function mapMysqlError(err: MysqlLikeError): FieldError[] | null {
    const msg = err.sqlMessage ?? err.message ?? "";
    switch (err.errno) {
        case 1048: { // ER_BAD_NULL_ERROR
            const column = msg.match(/Column '([^']+)' cannot be null/)?.[1];
            return column ? [{ column, message: `${column} is required` }] : null;
        }
        case 1062: { // ER_DUP_ENTRY
            const column = msg.match(/for key '(?:[^'.]+\.)?([^']+)'/)?.[1];
            return column ? [{ column, message: `${column} must be unique` }] : null;
        }
        case 3819: { // check constraint (MySQL 8.0.16+)
            const column = msg.match(/Check constraint '([^']+)'/)?.[1];
            return column ? [{ column, message: msg }] : null;
        }
        default:
            return null;
    }
}

function mapSqliteError(err: SqliteLikeError): FieldError[] | null {
    const msg = err.message ?? "";
    switch (err.code) {
        case "SQLITE_CONSTRAINT_NOTNULL": {
            const column = msg.match(/NOT NULL constraint failed:\s*[\w]+\.([\w]+)/)?.[1];
            return column ? [{ column, message: `${column} is required` }] : null;
        }
        case "SQLITE_CONSTRAINT_UNIQUE": {
            const column = msg.match(/UNIQUE constraint failed:\s*[\w]+\.([\w]+)/)?.[1];
            return column ? [{ column, message: `${column} must be unique` }] : null;
        }
        case "SQLITE_CONSTRAINT_CHECK": {
            const raw = msg.match(/CHECK constraint failed:\s*(.+)$/)?.[1]?.trim();
            // The text after "failed:" is either the table name, a named
            // constraint, or (some SQLite builds) the raw CHECK expression —
            // in the last case the leading identifier is almost always the
            // column being checked. Best-effort, not a parser.
            const column = raw?.match(/^\(?\s*([A-Za-z_]\w*)/)?.[1];
            return column ? [{ column, message: msg }] : null;
        }
        default:
            return null;
    }
}

/**
 * Maps a driver-thrown insert error to per-field errors, or null when the
 * shape/code isn't one we recognize — the caller falls back to today's
 * generic `{error}` response either way, so an unmapped error is never a
 * regression, just less specific.
 */
export function mapConstraintError(err: unknown, driverKey: string): FieldError[] | null {
    if (!err || typeof err !== "object") return null;
    switch (driverKey) {
        case "postgres":
            return mapPgError(err as PgLikeError);
        case "mysql":
            return mapMysqlError(err as MysqlLikeError);
        case "sqlite":
            return mapSqliteError(err as SqliteLikeError);
        default:
            return null;
    }
}
