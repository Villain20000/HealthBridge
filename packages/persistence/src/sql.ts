/**
 * SQL access layer.
 *
 * The connection contract is deliberately tiny (`query` + `execute` +
 * `transaction`) so the MySQL adapter is the only dialect-specific code and the
 * repositories can be verified without a server. `RecordingSqlConnection` exists
 * for exactly that: it records the statements and parameters a repository
 * produces, which is how tenant-scoping and parameterisation are tested in CI.
 */

export interface SqlQueryResult {
  rows: Record<string, unknown>[];
  affectedRows: number;
}

export interface SqlExecutor {
  /** SELECT-style statement. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** INSERT/UPDATE/DELETE. */
  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number; insertId?: number }>;
}

export interface SqlConnection extends SqlExecutor {
  readonly dialect: "mysql" | "recording";
  /** Runs `fn` inside a transaction; rolls back when `fn` throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface RecordedStatement {
  sql: string;
  params: unknown[];
  kind: "query" | "execute" | "transaction-start" | "transaction-commit" | "transaction-rollback";
}

/**
 * In-memory recorder used by repository tests. It never interprets SQL: it can
 * assert *what* was sent (scoping, placeholder count, ordering) but not what a
 * real database would return, and it is not a stand-in for MySQL in production.
 */
export class RecordingSqlConnection implements SqlConnection {
  public readonly dialect = "recording" as const;
  public readonly statements: RecordedStatement[] = [];
  public readonly handlers: Array<{ match: RegExp; rows: Record<string, unknown>[] }> = [];
  public failNext: Error | undefined;
  private inTransaction = false;

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.statements.push({ sql, params, kind: "query" });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    const handler = this.handlers.find((h) => h.match.test(sql));
    return (handler?.rows ?? []) as T[];
  }

  public async execute(sql: string, params: unknown[] = []): Promise<{ affectedRows: number; insertId?: number }> {
    this.statements.push({ sql, params, kind: "execute" });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    return { affectedRows: 1 };
  }

  public async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.statements.push({ sql: "", params: [], kind: "transaction-start" });
    this.inTransaction = true;
    try {
      const result = await fn(this);
      this.statements.push({ sql: "", params: [], kind: "transaction-commit" });
      return result;
    } catch (error) {
      this.statements.push({ sql: "", params: [], kind: "transaction-rollback" });
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  public async close(): Promise<void> {
    /* nothing to close */
  }

  public get isInTransaction(): boolean {
    return this.inTransaction;
  }

  /** Statements that touched a given table, for scoping assertions. */
  public statementsFor(table: string): RecordedStatement[] {
    return this.statements.filter((statement) => new RegExp(`\\b${table}\\b`, "i").test(statement.sql));
  }
}

/**
 * MySQL connection backed by `mysql2/promise`.
 *
 * `mysql2` is an optional dependency: the platform must boot in demo/in-memory
 * mode without a database, and must fail with an actionable error — never
 * silently degrade — when a database is configured but the driver is missing.
 */
export interface MySqlConnectionOptions {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
  timezone?: string;
}

interface MySqlPool {
  query(options: { sql: string; values: unknown[] }): Promise<[unknown, unknown]>;
  execute(options: { sql: string; values: unknown[] }): Promise<[unknown, unknown]>;
  getConnection(): Promise<MySqlPooledConnection>;
  end(): Promise<void>;
}

interface MySqlPooledConnection {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  query(options: { sql: string; values: unknown[] }): Promise<[unknown, unknown]>;
  execute(options: { sql: string; values: unknown[] }): Promise<[unknown, unknown]>;
}

/**
 * The compatibility boundary, as a pure function so it can be exercised without a server.
 * Returns normally when the version is supported; throws with the reason when it is not.
 */
export function assertSupportedServerVersion(version: string): void {
  if (/mariadb/i.test(version)) {
    throw new Error(
      `MariaDB is not supported (reported version: ${version}). The schema uses the MySQL 8 collation ` +
        "utf8mb4_0900_ai_ci and the job queue claims work with FOR UPDATE SKIP LOCKED, neither of which " +
        "MariaDB provides. Point DATABASE_URL at MySQL 8.0+, or unset it to run in demo mode.",
    );
  }
  const major = Number(version.split(".")[0]);
  if (!Number.isFinite(major) || major < 8) {
    throw new Error(
      `MySQL 8.0 or newer is required (reported version: ${version}). The job queue claims work with ` +
        "FOR UPDATE SKIP LOCKED, added in 8.0. Point DATABASE_URL at MySQL 8.0+, or unset it to run in demo mode.",
    );
  }
}

export class MySqlConnection implements SqlConnection {
  public readonly dialect = "mysql" as const;
  private constructor(private readonly pool: MySqlPool) {}

  public static async open(options: MySqlConnectionOptions): Promise<MySqlConnection> {
    let module: { createPool(config: Record<string, unknown>): MySqlPool };
    try {
      // Optional dependency: resolved at runtime only when a database is used.
      // Resolved through a variable so TypeScript does not require the optional
      // package (and its types) to be installed for the demo build to succeed.
      const specifier = "mysql2/promise";
      module = (await import(specifier)) as unknown as {
        createPool(config: Record<string, unknown>): MySqlPool;
      };
    } catch {
      throw new Error(
        "MySQL persistence was selected but the 'mysql2' package is not installed. " +
          "Run `npm install mysql2` in the repository root, or unset DATABASE_URL to use demo (in-memory) mode.",
      );
    }

    const pool = module.createPool({
      host: options.host,
      port: options.port ?? 3306,
      user: options.user,
      password: options.password,
      database: options.database,
      connectionLimit: options.connectionLimit ?? 10,
      timezone: options.timezone ?? "Z",
      dateStrings: true,
      charset: "utf8mb4",
      supportBigNumbers: true,
    });

    const connection = new MySqlConnection(pool);
    try {
      await connection.assertSupportedServer();
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
    return connection;
  }

  /**
   * Refuses a server the schema cannot work on, at boot, with the reason.
   *
   * The schema pins `utf8mb4_0900_ai_ci` (MySQL 8.0+ only) and the queue claims with
   * `FOR UPDATE SKIP LOCKED` (also 8.0+). MariaDB and 5.7 would fail halfway through the
   * first migration with a collation or syntax error that reads like a bug in the
   * migration rather than a compatibility boundary, so this check names the boundary.
   */
  public async assertSupportedServer(): Promise<string> {
    const rows = await this.query<{ version: string }>("SELECT VERSION() AS version");
    const version = String(rows[0]?.version ?? "unknown");
    assertSupportedServerVersion(version);
    return version;
  }

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query({ sql, values: params });
    return (rows as T[]) ?? [];
  }

  public async execute(sql: string, params: unknown[] = []): Promise<{ affectedRows: number; insertId?: number }> {
    const [result] = await this.pool.execute({ sql, values: params });
    const header = result as { affectedRows?: number; insertId?: number };
    return { affectedRows: header.affectedRows ?? 0, insertId: header.insertId };
  }

  public async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    const tx: SqlExecutor = {
      query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const [rows] = await connection.query({ sql, values: params });
        return (rows as R[]) ?? [];
      },
      execute: async (sql: string, params: unknown[] = []) => {
        const [result] = await connection.execute({ sql, values: params });
        const header = result as { affectedRows?: number; insertId?: number };
        return { affectedRows: header.affectedRows ?? 0, insertId: header.insertId };
      },
    };

    await connection.beginTransaction();
    try {
      const result = await fn(tx);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
