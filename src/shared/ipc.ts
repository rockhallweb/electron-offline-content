export const MEDIA_CACHE_IPC = {
  getStatus: 'rockhallweb:media-cache:get-status',
  getItem: 'rockhallweb:media-cache:get-item',
  listNamespace: 'rockhallweb:media-cache:list-namespace',
  listNamespaceTree: 'rockhallweb:media-cache:list-namespace-tree',
  findByFileStem: 'rockhallweb:media-cache:find-by-file-stem',
  statusChanged: 'rockhallweb:media-cache:status-changed',
} as const;
