import { useEffect, useState } from "react";
// These hooks call the preload bridge; wrap the tree in `<MediaCacheProvider>` (see renderer.tsx).
import {
  useFileStemMatch,
  useMediaCacheStatus,
  useMediaItem,
  useMediaNamespace,
  useMediaNamespaceTree,
} from "@rockhallweb/electron-offline-content/react";

interface ExampleConfig {
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

declare global {
  interface Window {
    mediaCacheExample?: ExampleConfig;
  }
}

export function App() {
  const config = window.mediaCacheExample ?? {
    demoKicker: "Local Fixture Demo",
    queueLabel: "Local queue",
    sourceLabel: "Local fixtures",
    rootNamespace: "nature",
    itemLookup: { namespace: "nature", itemId: "forest-loop" },
    fileStem: "rose-cut",
    namespaceTreePrefix: "nature",
  };

  const status = useMediaCacheStatus();
  const rootNamespace = useMediaNamespace(config.rootNamespace, { limit: 20 });
  const tree = useMediaNamespaceTree(config.namespaceTreePrefix, { limit: 40 });
  const fileStemMatches = useFileStemMatch(config.fileStem, { limit: 10 });

  const [selected, setSelected] = useState(config.itemLookup);

  useEffect(() => {
    const selectedExists = tree.data?.items.some(
      (item) => item.namespace === selected.namespace && item.id === selected.itemId,
    );

    if (!selectedExists && tree.data?.items[0]) {
      setSelected({
        namespace: tree.data.items[0].namespace,
        itemId: tree.data.items[0].id,
      });
    }
  }, [selected.itemId, selected.namespace, tree.data]);

  const currentItem = useMediaItem(selected.namespace, selected.itemId);
  const leadAsset =
    currentItem.data?.assets.find((asset) => asset.role === "primary") ??
    currentItem.data?.assets[0];
  const posterAsset = currentItem.data?.assets.find((asset) => asset.role === "poster");
  const subtitleAsset = currentItem.data?.assets.find((asset) => asset.role === "subtitle");
  const queue = tree.data?.items ?? [];
  const queryError =
    status.error ?? rootNamespace.error ?? tree.error ?? fileStemMatches.error ?? currentItem.error;

  return (
    <main className="demo-shell">
      {status.data?.error ? (
        <section className="demo-alert">
          <strong>Sync error</strong>
          <span>{status.data.error.message}</span>
        </section>
      ) : null}

      {queryError ? (
        <section className="demo-alert">
          <strong>Renderer query error</strong>
          <span>{queryError.message}</span>
        </section>
      ) : null}

      <section className="demo-stage">
        <header className="demo-header">
          <div>
            <p className="demo-kicker">{config.demoKicker}</p>
            <h1>Offline media, staged once, played locally.</h1>
          </div>
          <div className="demo-meta">
            <MetricChip label="Source" value={config.sourceLabel} />
            <MetricChip label="Phase" value={status.data?.phase ?? "loading"} />
            <MetricChip
              label="Generation"
              value={String(status.data?.activeGenerationId ?? "none")}
            />
          </div>
        </header>

        <div className="demo-viewer">
          <div className="viewer-frame">
            {leadAsset?.kind === "video" ? (
              <video
                className="viewer-media"
                src={leadAsset.url}
                controls
                playsInline
                poster={posterAsset?.url}
              >
                {subtitleAsset ? (
                  <track kind="subtitles" src={subtitleAsset.url} default label="Captions" />
                ) : null}
              </video>
            ) : posterAsset ? (
              <img
                className="viewer-media"
                src={posterAsset.url}
                alt={currentItem.data?.title ?? "Poster"}
              />
            ) : (
              <div className="viewer-empty">Waiting for the selected item to become available.</div>
            )}
          </div>

          <aside className="viewer-sidebar">
            <p className="sidebar-label">{selected.namespace}</p>
            <h2>{currentItem.data?.title ?? selected.itemId}</h2>
            <p className="sidebar-copy">
              {currentItem.data?.description ??
                "Metadata will appear here after the cache exposes the current item."}
            </p>
            <dl className="sidebar-facts">
              <FactRow label="Primary URL" value={leadAsset?.url ?? "pending"} />
              <FactRow
                label="Root namespace"
                value={`${config.rootNamespace} (${rootNamespace.data?.items.length ?? 0})`}
              />
              <FactRow
                label="Stem matches"
                value={String(fileStemMatches.data?.items.length ?? 0)}
              />
            </dl>
          </aside>
        </div>
      </section>

      <section className="demo-queue">
        <div className="queue-header">
          <div>
            <p className="queue-label">{config.queueLabel}</p>
            <h3>Choose a synced item</h3>
          </div>
          <p className="queue-count">{queue.length} items ready</p>
        </div>

        <div className="queue-list">
          {queue.map((item) => {
            const isActive = item.namespace === selected.namespace && item.id === selected.itemId;
            const itemPoster = item.assets.find((asset) => asset.role === "poster");
            const itemLead =
              item.assets.find((asset) => asset.role === "primary") ?? item.assets[0];

            return (
              <button
                key={`${item.namespace}/${item.id}`}
                className={isActive ? "queue-card queue-card--active" : "queue-card"}
                type="button"
                onClick={() => setSelected({ namespace: item.namespace, itemId: item.id })}
              >
                <div className="queue-card__media">
                  {itemPoster ? (
                    <img src={itemPoster.url} alt={item.title} />
                  ) : (
                    <div className="queue-card__fallback">{itemLead?.kind ?? "asset"}</div>
                  )}
                </div>
                <div className="queue-card__body">
                  <p>{item.namespace}</p>
                  <strong>{item.title}</strong>
                  <span>
                    {item.description ?? item.summary ?? "Cached and ready for offline playback."}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
