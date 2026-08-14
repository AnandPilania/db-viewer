declare module "pg-cursor" {
  import type { Submittable, Connection, QueryResult } from "pg";

  class Cursor implements Submittable {
    constructor(text: string, values?: unknown[]);
    read(rowCount: number, callback: (err: Error, rows: unknown[], result?: QueryResult) => void): void;
    close(callback: (err?: Error) => void): void;
    submit(connection: Connection): void;
  }

  export = Cursor;
}
