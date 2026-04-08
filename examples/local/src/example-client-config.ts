/**
 * UI-facing demo metadata (preload → renderer). Kept in a small module so preload does not
 * import `fetch-content.ts` (which pulls in the fixture HTTP server).
 *
 * In production you might load these from env, remote config, or build-time defines instead.
 */
export interface ExampleClientConfig {
  demoKicker: string;
  queueLabel: string;
  sourceLabel: string;
  collection: string;
  defaultAssetKey: string;
  fileStem: string;
}

export const exampleClientConfig: ExampleClientConfig = {
  demoKicker: "Local Fixture Demo",
  queueLabel: "Local queue",
  sourceLabel: "Local fixtures",
  collection: "nature",
  defaultAssetKey: "nature/forest-loop/main",
  fileStem: "rose-cut",
};
