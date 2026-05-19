import type { Command } from 'commander';
import type { Logger } from '../obs/logger.js';
import {
  EXIT_SUCCESS,
  EXIT_VALIDATION,
} from '../obs/exit-codes.js';

export function registerCreate(program: Command, getLogger: () => Logger): void {
  program
    .command('create')
    .description('Create a resource (MVP stub)')
    .option('--non-interactive', 'Fail fast if required fields are missing', false)
    .option('--title <title>', 'Display title (required with --non-interactive)')
    .action(async (opts: { nonInteractive?: boolean; title?: string }) => {
      const log = getLogger();
      log.info('create: start', { cmd: 'create' });

      if (opts.nonInteractive && !opts.title) {
        log.error('missing required parameter: --title (non-interactive mode)', {
          missing: ['--title'],
        });
        process.exitCode = EXIT_VALIDATION;
        await log.flushFile();
        return;
      }

      if (!opts.title && !process.stdin.isTTY) {
        log.info('create: no TTY and no --title; skipping interactive prompts', { cmd: 'create' });
        process.exitCode = EXIT_SUCCESS;
        await log.flushFile();
        return;
      }

      if (!opts.title && process.stdin.isTTY) {
        log.info('create: interactive mode placeholder (no-op)', { cmd: 'create' });
      }

      log.info('create: done', { cmd: 'create' });
      process.exitCode = EXIT_SUCCESS;
      await log.flushFile();
    });
}
