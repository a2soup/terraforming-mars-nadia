/**
 * Side-effect module that MUST be imported before any Engine module. Two jobs:
 *
 * 1. `process.chdir` to the repo root. The Engine's asset routes read `build/...` and
 *    `assets/...` relative to the *current working directory*, and `ServeAsset.INSTANCE`
 *    is a static field that slurps `build/styles.css` the moment the module is loaded -
 *    so the chdir has to happen before that import, not inside `main()`.
 * 2. Install the headless Engine bootstrap (no-op Database + `globalInitialize`), same as
 *    every other Nadia entry point. The demo keeps the whole game in memory; nothing is
 *    written to disk and no real database is contacted.
 */
import {resolve} from 'path';

export const REPO_ROOT = resolve(__dirname, '..', '..');

process.chdir(REPO_ROOT);

// Imported *after* the chdir on purpose - see above. `require` rather than `import` so the
// ordering survives however TypeScript decides to emit this file.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {ensureHeadlessEngine} = require('../src/engine/headlessEngine') as typeof import('../src/engine/headlessEngine');

ensureHeadlessEngine();
