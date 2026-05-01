declare module "bun:sqlite" {
  export class Database {
    constructor(filename?: string, options?: { readonly?: boolean; create?: boolean; strict?: boolean });
    run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    query<T = unknown, P extends unknown[] = unknown[]>(sql: string): {
      get(...params: P): T | null;
      all(...params: P): T[];
      run(...params: P): { changes: number; lastInsertRowid: number | bigint };
    };
    exec(sql: string): void;
    close(): void;
  }
}
