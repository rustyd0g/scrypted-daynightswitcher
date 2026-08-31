export interface LegacySyncMigrationState {
  overrideSyncOnStartupStored: boolean;
  overrideLocationAndTime: boolean;
}

/**
 * Before startup sync had its own override, the location/time override also
 * selected the camera's startup-sync value, including its implicit true
 * default. Preserve that behavior when loading legacy camera settings.
 */
export function shouldMigrateLegacySyncOverride(state: LegacySyncMigrationState) {
  return !state.overrideSyncOnStartupStored && state.overrideLocationAndTime;
}
