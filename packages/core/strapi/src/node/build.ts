import * as tsUtils from '@strapi/typescript-utils';
import glob from 'glob';
import * as path from 'path';
import type { CLIContext } from '../cli/types';
import { checkRequiredDependencies } from './core/dependencies';
import { getTimer, prettyTime } from './core/timer';
import { createBuildContext } from './create-build-context';
import { writeStaticClientFiles } from './staticFiles';

interface BuildOptions extends CLIContext {
  /**
   * Which bundler to use for building.
   *
   * @default webpack
   */
  bundler?: 'webpack' | 'vite';
  /**
   * Minify the output
   *
   * @default true
   */
  minify?: boolean;
  /**
   * Generate sourcemaps – useful for debugging bugs in the admin panel UI.
   */
  sourcemaps?: boolean;
  /**
   * Print stats for build
   */
  stats?: boolean;
}

/**
 * @example `$ strapi build`
 *
 * @description Builds the admin panel of the strapi application.
 */
const build = async ({ logger, cwd, tsconfig, ...options }: BuildOptions) => {
  const timer = getTimer();

  const { didInstall } = await checkRequiredDependencies({ cwd, logger }).catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });

  if (didInstall) {
    return;
  }

  if (tsconfig?.config) {
    timer.start('compilingTS');
    const compilingTsSpinner = logger.spinner(`Compiling TS`).start();

    try {
      await tsUtils.compile(cwd, { configOptions: { ignoreDiagnostics: false } });
    } catch {
      // Match previous compiler behavior (process.exit inside basic.run).
      process.exit(1);
    }

    const compilingDuration = timer.end('compilingTS');
    compilingTsSpinner.text = `Compiling TS (${prettyTime(compilingDuration)})`;
    compilingTsSpinner.succeed();
  }

  timer.start('createBuildContext');
  const contextSpinner = logger.spinner(`Building build context`).start();
  console.log('');

  const ctx = await createBuildContext({
    cwd,
    logger,
    tsconfig,
    options,
  });

  const contextDuration = timer.end('createBuildContext');
  contextSpinner.text = `Building build context (${prettyTime(contextDuration)})`;
  contextSpinner.succeed();

  timer.start('buildAdmin');
  const buildingSpinner = logger.spinner(`Building admin panel`).start();
  console.log('');

  try {
    await writeStaticClientFiles(ctx);

    if (ctx.bundler === 'webpack') {
      const { build: buildWebpack } = await import('./webpack/build');
      await buildWebpack(ctx);
    } else if (ctx.bundler === 'vite') {
      const { build: buildVite } = await import('./vite/build');
      await buildVite(ctx);
    }

    const buildDuration = timer.end('buildAdmin');
    buildingSpinner.text = `Building admin panel (${prettyTime(buildDuration)})`;
    buildingSpinner.succeed();

    // Clean up local plugin build artifacts to reduce disk usage.
    // Local plugins' node_modules can bloat the installation (e.g. from ~300MB to ~1.6GB
    // per plugin) because @strapi/* and other deps are installed independently for each plugin.
    // After a production build the source tooling is no longer needed.
    try {
      const path = await import('path');
      const fs = await import('fs/promises');
      const { promisify } = await import('util');
      const glob = (await import('glob')).default;

      const pluginsDir = path.join(cwd, 'src', 'plugins');
      const entries = await fs.readdir(pluginsDir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(pluginsDir, entry.name);

        // Remove node_modules (the biggest contributor to disk bloat)
        const nmDir = path.join(pluginDir, 'node_modules');
        await fs.rm(nmDir, { recursive: true, force: true });

        // Remove TS source files outside dist/ (keep dist/ for runtime)
        const tsFiles = await glob('**/*.ts', {
          cwd: pluginDir,
          ignore: ['dist/**', 'node_modules/**'],
          absolute: true,
        });
        await Promise.all(tsFiles.map(f => fs.rm(f, { force: true }).catch(() => {})));

        // Remove config files that are only needed at build time
        for (const f of ['tsconfig.json', '.eslintrc.js', '.eslintrc.cjs', 'prettier.config.js', 'prettier.config.cjs']) {
          await fs.rm(path.join(pluginDir, f), { force: true }).catch(() => {});
        }
      }

      logger.info('Cleaned up local plugin build artifacts to reduce disk usage.');
    } catch (cleanupErr) {
      // Non-fatal: log a warning but don't fail the build
      logger.warn('Could not clean up local plugin artifacts: ' + (cleanupErr as Error).message);
    }
  } catch (err) {
    buildingSpinner.fail();
    throw err;
  }
};

export { build };
export type { BuildOptions };
