#!/usr/bin/env node
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadConfig } from './config.js';
import { syncSchemas } from './schemaSync.js';

const argv = await yargs(hideBin(process.argv))
  .option('apply', {
    type: 'boolean',
    default: false,
    describe: '执行实际的建表/删表操作（默认仅 dry-run）',
  })
  .option('include', {
    type: 'array',
    string: true,
    describe: '仅同步指定的表，多个表用空格分隔',
  })
  .option('exclude', {
    type: 'array',
    string: true,
    describe: '排除不想同步的表，多个表用空格分隔',
  })
  .option('json', {
    type: 'boolean',
    default: false,
    describe: '以 JSON 的形式输出结果，方便脚本处理',
  })
  .option('data', {
    type: 'array',
    string: true,
    describe: '同步指定表的数据（会先清空再写入），多个表用空格分隔',
  })
  .option('include-data', {
    type: 'array',
    string: true,
    describe: '同时设定 --include 和 --data（避免重复输入表名），多个表用空格分隔',
  })
  .strict()
  .help()
  .alias('h', 'help')
  .parseAsync();

const includeData = (argv['include-data'] ?? []) as string[];
const include = [...new Set([...(argv.include ?? []), ...includeData])] as string[];
const exclude = (argv.exclude ?? []) as string[];
const dataTables = [...new Set([...(argv.data ?? []), ...includeData])] as string[];

const config = loadConfig({
  apply: argv.apply,
  include,
  exclude,
  dataTables,
});

console.log(chalk.cyan(`开始同步远端 ${config.remoteDb.database} -> 本地 ${config.localDb.database}`));
console.log(chalk.cyan(config.dryRun ? '当前为 dry-run，不会改动本地数据库' : '将会直接覆盖本地表结构，请谨慎确认'));

try {
  const report = await syncSchemas(config);

  if (argv.json) {
    console.log(JSON.stringify({ ...report, dryRun: config.dryRun }, null, 2));
  } else {
    for (const result of report.tableResults) {
      const statusLabel = result.status === 'created'
        ? chalk.green('CREATE')
        : result.status === 'updated'
          ? chalk.yellow('UPDATE')
          : chalk.gray('SKIP');
      console.log(`${statusLabel} ${result.table} ${result.detail ? '- ' + result.detail : ''}`);
    }

    if (report.errors.length > 0) {
      console.error(chalk.red('以下表同步失败:'));
      report.errors.forEach((err) => {
        console.error(chalk.red(`- ${err.table ?? 'N/A'}: ${err.message}`));
      });
    }
  }

  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  type NetworkError = NodeJS.ErrnoException & { address?: string; port?: number };
  const err = error as NetworkError;
  const message = err instanceof Error ? err.message : String(err);
  const code = err?.code ? ` (code: ${err.code})` : '';
  const address = err?.address ? ` target=${err.address}` : '';
  const port = typeof err?.port === 'number' ? ` port=${err.port}` : '';
  console.error(chalk.red(`同步过程中出现错误: ${message}${code}${address}${port}`));

  if (err?.code === 'ETIMEDOUT') {
    console.error(
      chalk.yellow(
        '提示: 连接超时通常是 SSH 隧道未打通或目标端口被安全组阻止。请确认跳板机能访问 RDS，并检查 SSH 私钥/安全组配置。',
      ),
    );
  }

  if (process.env.DEBUG_SYNC === '1') {
    console.error(err);
  }
  process.exitCode = 1;
}
