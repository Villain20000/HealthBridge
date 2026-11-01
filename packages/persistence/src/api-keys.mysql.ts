import type { ApiKeyRecord, ApiKeyStore } from "@healthbridge/auth";
import type { SqlExecutor } from "./sql.js";

const COLUMNS =
  "id, workspace_id, name, role, scopes, prefix, secret_hash, created_at, created_by, expires_at, last_used_at, revoked_at";

/** MySQL API key store. Only the HMAC of a key's secret is ever written. */
export class MySqlApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: SqlExecutor) {}

  public async findByPrefix(prefix: string): Promise<ApiKeyRecord | undefined> {
    const rows = await this.db.query(`SELECT ${COLUMNS} FROM api_keys WHERE prefix = ?`, [prefix]);
    return rows[0] ? mapKey(rows[0]) : undefined;
  }

  public async findById(id: string): Promise<ApiKeyRecord | undefined> {
    const rows = await this.db.query(`SELECT ${COLUMNS} FROM api_keys WHERE id = ?`, [id]);
    return rows[0] ? mapKey(rows[0]) : undefined;
  }

  public async listByWorkspace(workspaceId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.db.query(`SELECT ${COLUMNS} FROM api_keys WHERE workspace_id = ? ORDER BY created_at ASC`, [
      workspaceId,
    ]);
    return rows.map(mapKey);
  }

  public async save(record: ApiKeyRecord): Promise<void> {
    await this.db.execute(`INSERT INTO api_keys (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      record.id,
      record.workspaceId,
      record.name,
      record.role,
      JSON.stringify(record.scopes),
      record.prefix,
      record.secretHash,
      toSql(record.createdAt),
      record.createdBy ?? null,
      record.expiresAt ? toSql(record.expiresAt) : null,
      record.lastUsedAt ? toSql(record.lastUsedAt) : null,
      record.revokedAt ? toSql(record.revokedAt) : null,
    ]);
  }

  public async update(id: string, patch: Partial<ApiKeyRecord>): Promise<void> {
    // The workspace and the secret hash of an existing key are immutable.
    const assignments: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      assignments.push("name = ?");
      params.push(patch.name);
    }
    if (patch.scopes !== undefined) {
      assignments.push("scopes = ?");
      params.push(JSON.stringify(patch.scopes));
    }
    if (patch.expiresAt !== undefined) {
      assignments.push("expires_at = ?");
      params.push(patch.expiresAt ? toSql(patch.expiresAt) : null);
    }
    if (patch.lastUsedAt !== undefined) {
      assignments.push("last_used_at = ?");
      params.push(patch.lastUsedAt ? toSql(patch.lastUsedAt) : null);
    }
    if (patch.revokedAt !== undefined) {
      assignments.push("revoked_at = ?");
      params.push(patch.revokedAt ? toSql(patch.revokedAt) : null);
    }

    if (assignments.length === 0) return;
    params.push(id);
    await this.db.execute(`UPDATE api_keys SET ${assignments.join(", ")} WHERE id = ?`, params);
  }

  public async revokeAll(workspaceId: string, revokedAt: string): Promise<number> {
    const result = await this.db.execute(
      `UPDATE api_keys SET revoked_at = ? WHERE workspace_id = ? AND revoked_at IS NULL`,
      [toSql(revokedAt), workspaceId],
    );
    return result.affectedRows;
  }

  public async deleteByWorkspace(workspaceId: string): Promise<number> {
    const result = await this.db.execute(`DELETE FROM api_keys WHERE workspace_id = ?`, [workspaceId]);
    return result.affectedRows;
  }
}

function toSql(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").replace("Z", "");
}

function mapKey(row: Record<string, unknown>): ApiKeyRecord {
  const scopes =
    typeof row.scopes === "string" ? (JSON.parse(row.scopes) as string[]) : ((row.scopes as string[]) ?? []);
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    role: String(row.role) as ApiKeyRecord["role"],
    scopes: scopes as ApiKeyRecord["scopes"],
    prefix: String(row.prefix),
    secretHash: String(row.secret_hash),
    createdAt: new Date(String(row.created_at).replace(" ", "T") + "Z").toISOString(),
    createdBy: row.created_by ? String(row.created_by) : undefined,
    expiresAt: row.expires_at ? new Date(String(row.expires_at).replace(" ", "T") + "Z").toISOString() : undefined,
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at).replace(" ", "T") + "Z").toISOString() : undefined,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at).replace(" ", "T") + "Z").toISOString() : undefined,
  };
}
