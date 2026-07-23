// Moved to production code (agent/src/engine/stableState.ts) for Milestone 1 bullet 4:
// snapshot/restore verification needs `stableStateOf` at runtime, not just in tests. This
// file stays as a re-export so existing importers (gameFactory.spec.ts, embeddedDriver.spec.ts,
// randomLegalAgent.integration.spec.ts) need no changes.
export {stableState, stableStateOf} from '../../src/engine/stableState';
