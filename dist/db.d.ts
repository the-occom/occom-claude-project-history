import { PGlite } from "@electric-sql/pglite";
export declare const SCHEMA_VERSION = 6;
export declare function getDb(): Promise<PGlite>;
export declare function newId(): string;
export declare class ConflictError extends Error {
    table: string;
    recordId: string;
    constructor(table: string, id: string);
}
export declare function withTransaction<T>(fn: (tx: Parameters<Parameters<PGlite["transaction"]>[0]>[0]) => Promise<T>): Promise<T>;
export declare function findOne<T>(db: PGlite, query: string, params: unknown[]): Promise<T | null>;
export declare function exists(db: PGlite, table: string, id: string): Promise<boolean>;
export declare function buildWhereClause(conditions: Array<{
    field: string;
    value: unknown;
} | null>): {
    clause: string;
    values: unknown[];
};
export declare const PRIORITY_ORDER = "\n  CASE priority\n    WHEN 'critical' THEN 0\n    WHEN 'high'     THEN 1\n    WHEN 'medium'   THEN 2\n    WHEN 'low'      THEN 3\n  END\n";
//# sourceMappingURL=db.d.ts.map