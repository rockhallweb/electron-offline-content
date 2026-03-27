/**
 * UI-facing demo metadata (preload → renderer). Kept in a small module so preload does not
 * import `example-content.ts` (which pulls in the fixture HTTP server).
 *
 * In production you might load these from env, remote config, or build-time defines instead.
 */
export interface ExampleClientConfig {
  demoKicker: string;
  queueLabel: string;
  sourceLabel: string;
  rootNamespace: string;
  itemLookup: {
    namespace: string;
    itemId: string;
  };
  fileStem: string;
  namespaceTreePrefix: string;
}

export const exampleClientConfig: ExampleClientConfig = {
  demoKicker: "Local Fixture Demo",
  queueLabel: "Local queue",
  sourceLabel: "Local fixtures",
  rootNamespace: "nature",
  itemLookup: {
    namespace: "nature",
    itemId: "forest-loop",
  },
  fileStem: "rose-cut",
  namespaceTreePrefix: "nature",
};
