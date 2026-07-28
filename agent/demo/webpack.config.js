/**
 * Builds the Engine's web client for the spectator demo:
 *
 *   npx webpack --config agent/demo/webpack.config.js
 *
 * Why this exists instead of `npm run build:client`. The root webpack config runs
 * ForkTsCheckerWebpackPlugin, which type-checks everything the *root* tsconfig includes -
 * and that's `**\/*.ts`, which sweeps in `agent/test/**`. Those specs use Mocha globals
 * (`describe`, `it`) that the root tsconfig doesn't declare types for, so the check reports
 * a few hundred errors, and in production mode webpack refuses to emit when there are
 * errors. Net effect: `npm run build:client` currently produces no bundle in this repo.
 *
 * That's a main-project matter, not this side quest's, and this demo is not allowed to
 * touch a file outside `agent/demo/`. So this config takes the root config as-is and drops
 * the type-checker: the client's types are the main project's business, and a bundle to
 * spectate with doesn't need them re-verified. Everything else - entry points, loaders,
 * aliases, chunk splitting, the `build/` output directory - is inherited unchanged, so the
 * UI you get is the real one.
 *
 * Development mode, because it builds in seconds and the demo server runs with NODE_ENV
 * unset, which means it serves the uncompressed assets anyway.
 */
const base = require('../../webpack.config.js');

module.exports = {
  ...base,
  mode: 'development',
  // Match by name rather than `instanceof` so this doesn't need its own dependency on the
  // plugin package.
  plugins: base.plugins.filter((plugin) => plugin?.constructor?.name !== 'ForkTsCheckerWebpackPlugin'),
};
