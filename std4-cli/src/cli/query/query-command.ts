import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import type { Logger } from '../obs/logger.js';
import {
  EXIT_CONFIG,
  EXIT_INTERNAL,
  EXIT_SUBPROCESS,
  EXIT_SUCCESS,
  exitCodeForHttpStatus,
} from '../obs/exit-codes.js';

export function registerQuery(program: Command, getLogger: () => Logger): void {
  program
    .command('query')
    .description('Query / poll Dash (MVP stub with test hooks)')
    .option('--project <id>', 'Project identifier')
    .option('--config <path>', 'Config file path (existence checked when passed)')
    .option('--simulate-http <code>', 'Simulate Dash HTTP status for tests')
    .option('--child-exit <code>', 'Spawn a child process with fixed exit code')
    .action(async (opts: {
      project?: string;
      config?: string;
      simulateHttp?: string;
      childExit?: string;
    }) => {
      const log = getLogger();
      log.info('query: start', { cmd: 'query', project: opts.project });

      if (process.env.STD4_CLI_LOG_SELF_TEST) {
        log.info('self-test: secret field', {
          DASH_STD4_API_KEY: process.env.DASH_STD4_API_KEY ?? '',
          Authorization: 'Bearer shadow-secret',
        });
      }

      if (opts.config) {
        try {
          await import('node:fs/promises').then((fs) => fs.access(opts.config!));
        } catch {
          log.error('configuration file missing or unreadable', { path: opts.config });
          process.exitCode = EXIT_CONFIG;
          await log.flushFile();
          return;
        }
      }

      if (opts.simulateHttp !== undefined) {
        const code = Number(opts.simulateHttp);
        if (Number.isNaN(code)) {
          log.error('invalid --simulate-http value', { value: opts.simulateHttp });
          process.exitCode = EXIT_INTERNAL;
          await log.flushFile();
          return;
        }
        log.warn('simulated Dash HTTP response', { status: code });
        process.exitCode = exitCodeForHttpStatus(code);
        await log.flushFile();
        return;
      }

      if (opts.childExit !== undefined) {
        const code = Number(opts.childExit);
        if (Number.isNaN(code)) {
          log.error('invalid --child-exit value', { value: opts.childExit });
          process.exitCode = EXIT_INTERNAL;
          await log.flushFile();
          return;
        }
        const r = spawnSync(process.execPath, ['-e', `process.exit(${code})`], {
          encoding: 'utf8',
        });
        log.info('child finished', { status: r.status });
        process.exitCode = r.status === 0 ? EXIT_SUCCESS : EXIT_SUBPROCESS;
        await log.flushFile();
        return;
      }

      log.info('query: idle (no hooks)', { cmd: 'query' });
      process.exitCode = EXIT_SUCCESS;
      await log.flushFile();
    });
}
