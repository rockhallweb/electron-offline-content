/**
 * UI-facing demo metadata (preload → renderer). Kept in a small module so preload stays free of
 * manifest logic.
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
  demoKicker: "NASA Manual Demo",
  queueLabel: "Mission queue",
  sourceLabel: "NASA SVS",
  rootNamespace: "space",
  itemLookup: {
    namespace: "space",
    itemId: "hubble-cosmos",
  },
  fileStem: "mars-large-organics",
  namespaceTreePrefix: "space",
};
