/**
 * Preflight check for the Engine's built web client. Kept free of Engine imports so
 * `--help` and a missing-build error can both be reported without booting the server.
 */
import {existsSync} from 'fs';

/** What the UI can't render without. `assets/index.html` is checked in; the rest is built. */
const REQUIRED_ASSETS = [
  'build/main.js',
  'build/vendors.js',
  'build/styles.css',
  'assets/index.html',
];

export class ClientNotBuiltError extends Error {
  constructor(public readonly missing: ReadonlyArray<string>) {
    super(
      `The engine's web client hasn't been built in this checkout, so there is no UI to watch.\n` +
      `Missing: ${missing.join(', ')}\n\n` +
      `Build it (well under a minute), then re-run this script:\n\n` +
      `  npm run make:static\n` +
      `  npm run make:cards\n` +
      `  npx webpack --config agent/demo/webpack.config.js\n\n` +
      `(agent/demo/webpack.config.js explains why that isn't just \`npm run build\`.)\n`);
  }
}

/** Fails fast, with an actionable message, rather than serving a blank page. */
export function assertClientBuilt(): void {
  const missing = REQUIRED_ASSETS.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new ClientNotBuiltError(missing);
  }
}
