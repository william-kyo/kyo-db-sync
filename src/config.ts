import { config as loadEnv } from "dotenv";

loadEnv();

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  passphrase?: string;
}

export interface ToolConfig {
  ssh: SSHConfig;
  remoteDb: DbConfig;
  localDb: DbConfig;
  includeTables: string[];
  excludeTables: string[];
  dataTables: string[];
  dryRun: boolean;
}

export interface CliOverrides {
  apply?: boolean;
  include?: string[];
  exclude?: string[];
  dataTables?: string[];
}

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const parseList = (value?: string): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
};

const parseBool = (value?: string): boolean => {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

export const loadConfig = (overrides: CliOverrides = {}): ToolConfig => {
  const includeFromEnv = parseList(process.env.TABLE_INCLUDE);
  const excludeFromEnv = parseList(process.env.TABLE_EXCLUDE);
  const dataTablesFromEnv = parseList(process.env.DATA_TABLES);

  const includeTables =
    overrides.include && overrides.include.length > 0
      ? overrides.include
      : includeFromEnv;
  const excludeTables =
    overrides.exclude && overrides.exclude.length > 0
      ? overrides.exclude
      : excludeFromEnv;
  const dataTables =
    overrides.dataTables && overrides.dataTables.length > 0
      ? overrides.dataTables
      : dataTablesFromEnv;

  let normalizedInclude = includeTables;
  if (includeTables.length > 0 && dataTables.length > 0) {
    const includeSet = new Set(includeTables);
    let changed = false;
    for (const table of dataTables) {
      if (table && !includeSet.has(table)) {
        includeSet.add(table);
        changed = true;
      }
    }
    if (changed) {
      normalizedInclude = Array.from(includeSet);
    }
  }

  const dryRun = !(overrides.apply ?? parseBool(process.env.SYNC_APPLY));

  return {
    ssh: {
      host: process.env.SSH_HOST ?? "13.0.0.1",
      port: parseNumber(process.env.SSH_PORT, 22),
      username: process.env.SSH_USER ?? "ec2-user",
      privateKeyPath: process.env.SSH_KEY_PATH ?? "/Users/kyo/.ssh/id_rsa_dev",
      passphrase: process.env.SSH_KEY_PASSPHRASE,
    },
    remoteDb: {
      host:
        process.env.REMOTE_DB_HOST ??
        "kyodb-dev-aurra-cluster.cluster.ap-northeast-1.rds.amazonaws.com",
      port: parseNumber(process.env.REMOTE_DB_PORT, 3306),
      user: process.env.REMOTE_DB_USER ?? "admin",
      password: process.env.REMOTE_DB_PASSWORD ?? "",
      database: process.env.REMOTE_DB_NAME ?? "kyodb",
    },
    localDb: {
      host: process.env.LOCAL_DB_HOST ?? "127.0.0.1",
      port: parseNumber(process.env.LOCAL_DB_PORT, 3306),
      user: process.env.LOCAL_DB_USER ?? "root",
      password: process.env.LOCAL_DB_PASSWORD ?? "",
      database: process.env.LOCAL_DB_NAME ?? "kyodb",
    },
    includeTables: normalizedInclude,
    excludeTables,
    dataTables,
    dryRun,
  };
};
