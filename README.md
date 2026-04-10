# kyodb-db-sync

使用 TypeScript 编写的 CLI 工具，用来通过 SSH 跳板机把 AWS RDS (MySQL) 的 `kyodb` 库表结构同步到本地 MySQL。核心流程：

1. 通过 `ssh2` 建立到跳板机 (`13.0.0.1`) 的隧道，并进一步转发到 RDS `kyodb-dev-aurra-cluster.cluster.ap-northeast-1.rds.amazonaws.com:3306`。
2. 使用远端 `SHOW CREATE TABLE` 结果对比本地 `kyodb` 的表结构。
3. 默认执行 **dry-run**，只有在 `--apply` 或 `SYNC_APPLY=true` 时才会在本地 `DROP/CREATE` 表（会清空该表数据，请谨慎操作）。

## 快速开始

```bash
cp .env.example .env  # 根据实际情况调整密钥路径和密码
npm install
npm run sync          # dry-run，看看有哪些表需要变更
npm run sync:apply    # 真正执行同步（会 drop 重建）
npm run sync -- --apply --data table_a table_b   # 指定表同步数据
npm run sync -- --include table_a table_b --data table_a table_b --apply # 仅处理 table_a、table_b 这几个表，且在结构同步后清空并复制其数据
```

也可以直接带参数：

```bash
npm run sync -- --include users orders
npm run sync -- --data info_user info_media --include info_user info_media
npm run sync:apply -- --exclude migration_log
npm run sync -- --json > sync-report.json
```

## 配置项

所有配置既可以通过 `.env`，也可以通过环境变量/命令行覆盖：

| 变量                                     | 说明                                                                           | 默认值                       |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------- |
| `SSH_HOST` / `SSH_PORT`                  | 跳板机 IP/端口                                                                 | `13.0.0.1` / `22`            |
| `SSH_USER`                               | 跳板机账号                                                                     | `ec2-user`                   |
| `SSH_KEY_PATH`                           | 私钥路径，脚本会直接读取该文件；如果没有访问权限，请改为可读路径或自建密钥     | `/Users/kyo/.ssh/id_rsa_dev` |
| `REMOTE_DB_HOST/PORT/USER/PASSWORD/NAME` | RDS 连接信息                                                                   | 见 `.env.example`            |
| `LOCAL_DB_HOST/PORT/USER/PASSWORD/NAME`  | 本地 MySQL (`kyodb`) 信息                                                      | `127.0.0.1:3306 root 空密码` |
| `TABLE_INCLUDE`                          | 逗号分隔，只同步这些表                                                         | 空                           |
| `TABLE_EXCLUDE`                          | 逗号分隔，需要跳过的表                                                         | 空                           |
| `DATA_TABLES`                            | 逗号分隔，需要同步 **数据** 的表；这些表会在同步时先 `TRUNCATE` 再写入远端数据 | 空                           |
| `SYNC_APPLY`                             | `true` 时执行真实写入，否则为 dry-run                                          | `false`                      |

> ⚠️ `DROP TABLE` + `CREATE TABLE` 会直接重建表结构，意味着本地该表的数据会被清空。必要时请先备份或只在空库中执行。

## 原理说明

- 使用 `SHOW CREATE TABLE` 的结果作为最权威的建表语句。
- 通过正则去掉 `AUTO_INCREMENT` 的数字差异，避免因为自增值不同而频繁重建。
- `--data <table...>` 或 `DATA_TABLES` 会在结构同步后 **清空本地表并写入远端全量数据**，dry-run 模式下仅统计远端行数。
- 目前的实现对结构差异的处理方式是 **重建表**，暂未做复杂的 `ALTER TABLE` diff。如果需要更精细的列级同步，可以在 `src/schemaSync.ts` 中扩展。

## 常见问题

- **提示无法读取 SSH 私钥**：确认 `SSH_KEY_PATH` 是否正确、文件权限是否允许当前用户读取。如果私钥路径与 `.env.example` 不同，可以在 `.env` 里覆盖。
- **提示本地无法连接 MySQL**：确认 `.env` 里的 `LOCAL_DB_PORT` 指向真正运行 MySQL 的端口（默认 3306）；如果配置成了 Redis 端口（例如 6379）就会一直超时。
- **数据同步太慢/占内存**：`--data` 会把指定表的所有数据读到内存再批量插入，大表请谨慎使用或自行改造成分批拉取/流式复制。
- **只想看结果不执行**：保持默认 dry-run，或 `npm run sync`。
- **希望脚本在 CI 里使用**：可以结合 `npm run sync -- --json` 得到机器可读结果，根据 `process.exitCode` 判断是否成功。
