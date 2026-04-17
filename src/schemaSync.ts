import mysql, { Connection, RowDataPacket } from 'mysql2/promise';
import { ToolConfig } from './config.js';
import { createTunnel } from './sshTunnel.js';

export type TableStatus = 'created' | 'updated' | 'skipped';

export interface TableResult {
  table: string;
  status: TableStatus;
  detail?: string;
}

export interface SyncReport {
  tableResults: TableResult[];
  errors: { table?: string; message: string }[];
}

interface TableRow extends RowDataPacket {
  TABLE_NAME: string;
}

interface ColumnRow extends RowDataPacket {
  Field: string;
  Extra?: string;
}

const escapeId = (identifier: string): string => `\`${identifier.replace(/`/g, '``')}\``;

const canonicalizeDDL = (ddl: string): string =>
  ddl
    .replace(/AUTO_INCREMENT=\d+/gi, 'AUTO_INCREMENT=?')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const tableExists = async (connection: Connection, schema: string, table: string): Promise<boolean> => {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT COUNT(1) as cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1',
    [schema, table],
  );
  const count = rows[0]?.cnt as number | undefined;
  return Boolean(count && count > 0);
};

const getCreateTable = async (connection: Connection, table: string): Promise<string> => {
  const [rows] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${escapeId(table)}`);
  const ddl = rows[0]?.['Create Table'] as string | undefined;
  if (!ddl) throw new Error(`无法获取 ${table} 的建表语句`);
  return ddl;
};

const shouldInclude = (table: string, include: string[], exclude: string[]): boolean => {
  if (include.length > 0 && !include.includes(table)) return false;
  if (exclude.includes(table)) return false;
  return true;
};

const getRowCount = async (connection: Connection, table: string): Promise<number> => {
  const [rows] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM ${escapeId(table)}`);
  const count = rows[0]?.cnt as number | undefined;
  return count ?? 0;
};

const isGeneratedColumnExtra = (extra: string | undefined): boolean => {
  if (!extra) return false;
  const upper = extra.toUpperCase();
  // Avoid matching DEFAULT_GENERATED; generated columns show up as VIRTUAL/STORED GENERATED.
  return upper.includes('VIRTUAL GENERATED') || upper.includes('STORED GENERATED');
};

const getInsertableColumns = async (connection: Connection, table: string): Promise<string[]> => {
  const [rows] = await connection.query<ColumnRow[]>(`SHOW FULL COLUMNS FROM ${escapeId(table)}`);
  return rows.filter((row) => !isGeneratedColumnExtra(row.Extra)).map((row) => row.Field);
};

const copyTableData = async (
  remote: Connection,
  local: Connection,
  table: string,
  dryRun: boolean,
  disableForeignKeys: () => Promise<void>,
): Promise<number> => {
  if (dryRun) {
    return getRowCount(remote, table);
  }

  // MySQL generated columns cannot be assigned explicitly.
  const columns = await getInsertableColumns(local, table);
  if (columns.length === 0) {
    throw new Error(`表 ${table} 没有可写列（可能全部是 generated columns），无法同步数据`);
  }

  await disableForeignKeys();
  await local.execute(`TRUNCATE TABLE ${escapeId(table)}`);

  const selectList = columns.map((col) => escapeId(col)).join(', ');
  const [rows] = await remote.query<RowDataPacket[]>(`SELECT ${selectList} FROM ${escapeId(table)}`);
  if (rows.length === 0) {
    return 0;
  }

  const columnList = columns.map((col) => escapeId(col)).join(', ');
  const chunkSize = 500;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    const values = chunk.flatMap((row) => columns.map((col) => row[col]));
    const insertSql = `INSERT INTO ${escapeId(table)} (${columnList}) VALUES ${placeholders}`;
    await local.query(insertSql, values);
  }

  return rows.length;
};

export const syncSchemas = async (config: ToolConfig): Promise<SyncReport> => {
  const tunnel = await createTunnel(config.ssh, config.remoteDb.host, config.remoteDb.port);
  const remote = await mysql.createConnection({
    host: config.remoteDb.host,
    user: config.remoteDb.user,
    password: config.remoteDb.password,
    database: config.remoteDb.database,
    stream: tunnel.stream,
  });

  const local = await mysql.createConnection({
    host: config.localDb.host,
    port: config.localDb.port,
    user: config.localDb.user,
    password: config.localDb.password,
    database: config.localDb.database,
    multipleStatements: true,
  });

  const results: TableResult[] = [];
  const errors: { table?: string; message: string }[] = [];
  let fkDisabled = false;
  const dataTableSet = new Set(config.dataTables);
  const disableForeignKeys = async (): Promise<void> => {
    if (!fkDisabled) {
      await local.execute('SET FOREIGN_KEY_CHECKS=0');
      fkDisabled = true;
    }
  };

  try {
    const [tables] = await remote.query<TableRow[]>(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [config.remoteDb.database],
    );

    const filteredTables = tables
      .map((row) => row.TABLE_NAME)
      .filter((name) => shouldInclude(name, config.includeTables, config.excludeTables));

    if (config.dataTables.length > 0) {
      const availableTables = new Set(filteredTables);
      for (const table of config.dataTables) {
        if (!availableTables.has(table)) {
          errors.push({
            table,
            message: '数据同步被请求，但该表未包含在同步列表或者远端不存在',
          });
        }
      }
    }

    for (const table of filteredTables) {
      try {
        const detailParts: string[] = [];
        let status: TableStatus = 'skipped';
        const shouldCopyData = dataTableSet.has(table);

        const remoteDDL = await getCreateTable(remote, table);
        const canonicalRemote = canonicalizeDDL(remoteDDL);
        const existsLocally = await tableExists(local, config.localDb.database, table);

        if (!existsLocally) {
          if (!config.dryRun) {
            await disableForeignKeys();
            await local.execute(remoteDDL);
          }
          status = 'created';
          detailParts.push(config.dryRun ? 'dry-run' : '已同步远端建表语句');
        } else {
          const localDDL = await getCreateTable(local, table);
          const canonicalLocal = canonicalizeDDL(localDDL);

          if (canonicalLocal === canonicalRemote) {
            status = 'skipped';
            detailParts.push('结构一致');
          } else {
            if (!config.dryRun) {
              await disableForeignKeys();
              await local.execute(`DROP TABLE IF EXISTS ${escapeId(table)}`);
              await local.query(remoteDDL);
            }
            status = 'updated';
            detailParts.push(config.dryRun ? 'dry-run' : '已重建以匹配远端');
          }
        }

        if (shouldCopyData) {
          const rowCount = await copyTableData(remote, local, table, config.dryRun, disableForeignKeys);
          detailParts.push(config.dryRun ? `数据预估 ${rowCount} 行` : `数据已同步 ${rowCount} 行`);
        }

        results.push({ table, status, detail: detailParts.join('；') });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ table, message });
      }
    }

    return { tableResults: results, errors };
  } finally {
    if (fkDisabled) {
      await local.execute('SET FOREIGN_KEY_CHECKS=1');
    }
    await remote.end();
    await local.end();
    await tunnel.close();
  }
};
