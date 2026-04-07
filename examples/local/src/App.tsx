import { useEffect, useState } from "react";
// These hooks call the preload bridge; wrap the tree in `<MediaCacheProvider>` (see renderer.tsx).
import {
  useMedia,
  useMediaCacheErrors,
  useMediaCacheStatus,
  useFileStemMatch,
} from "@rockhallweb/electron-offline-content/react";
import { exampleClientConfig } from "./example-client-config.js";

export function App() {
  const cacheStatus = useMediaCacheStatus();
  const rootNamespace = useMedia({
    kind: "list",
    namespace: exampleClientConfig.rootNamespace,
    limit: 20,
  });
  const tree = useMedia({
    kind: "list",
    namespace: exampleClientConfig.namespaceTreePrefix,
    recursive: true,
    limit: 40,
  });
  const fileStemMatches = useFileStemMatch(exampleClientConfig.fileStem, {
    limit: 10,
  });

  const [selected, setSelected] = useState(exampleClientConfig.itemLookup);

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

  const currentItem = useMedia({
    kind: "item",
    namespace: selected.namespace,
    id: selected.itemId,
  });
  const leadAsset = currentItem.data?.assetsByRole.primary ?? currentItem.data?.assets[0];
  const posterAsset = currentItem.data?.assetsByRole.poster;
  const subtitleAsset = currentItem.data?.assetsByRole.subtitle;
  const queue = tree.data?.items ?? [];
  const errors = useMediaCacheErrors();

  const panelCard =
    "border border-line bg-[linear-gradient(180deg,rgba(10,16,25,0.8)_0%,rgba(8,12,18,0.86)_100%)] shadow-demo backdrop-blur-[18px]";

  return (
    <main className="grid min-h-screen gap-5 p-7 max-[720px]:p-3.5">
      {errors.syncError ? (
        <section className="flex items-center gap-3 rounded-[18px] border border-[rgba(255,123,123,0.28)] bg-[rgba(98,18,18,0.42)] px-[18px] py-3.5 text-[#ffd7d7]">
          <strong className="text-[11px] uppercase tracking-[0.18em]">Sync error</strong>
          <span className="leading-6">{errors.syncError.message}</span>
        </section>
      ) : null}

      {errors.primaryError ? (
        <section className="flex items-center gap-3 rounded-[18px] border border-[rgba(255,123,123,0.28)] bg-[rgba(98,18,18,0.42)] px-[18px] py-3.5 text-[#ffd7d7]">
          <strong className="text-[11px] uppercase tracking-[0.18em]">Renderer query error</strong>
          <span className="leading-6">{errors.primaryError.message}</span>
        </section>
      ) : null}

      <section
        className={`grid gap-[26px] rounded-[30px] p-7 max-[720px]:rounded-[22px] max-[720px]:p-[18px] ${panelCard}`}
      >
        <header className="flex flex-col items-start justify-between gap-5 min-[1081px]:flex-row">
          <div>
            <p className="mb-2.5 text-[11px] uppercase tracking-[0.24em] text-accent">
              {exampleClientConfig.demoKicker}
            </p>
            <h1 className="m-0 max-w-[12ch] font-serif text-[clamp(2.6rem,5vw,4.8rem)] leading-[0.94] tracking-[-0.04em]">
              Offline media, staged once, played locally.
            </h1>
          </div>
          <div className="flex flex-wrap justify-start gap-3 min-[1081px]:justify-end">
            <MetricChip label="Source" value={exampleClientConfig.sourceLabel} />
            <MetricChip label="Phase" value={cacheStatus.phase} />
            <MetricChip
              label="Generation"
              value={String(cacheStatus.data?.activeGenerationId ?? "none")}
            />
          </div>
        </header>

        <div className="grid grid-cols-1 gap-[18px] min-[1081px]:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.55fr)]">
          <div className="relative min-h-[300px] overflow-hidden rounded-3xl border border-line bg-panel-soft min-[721px]:min-h-[560px] after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:z-10 after:h-[26%] after:bg-gradient-to-t after:from-black/35 after:to-transparent after:content-[''] max-[720px]:rounded-[18px]">
            {leadAsset?.kind === "video" ? (
              <video
                className="block h-full w-full bg-[#020406] object-cover"
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
                className="block h-full w-full bg-[#020406] object-cover"
                src={posterAsset.url}
                alt={currentItem.data?.title ?? "Poster"}
              />
            ) : (
              <div className="grid min-h-[300px] place-items-center p-6 text-center text-muted min-[721px]:min-h-[560px]">
                Waiting for the selected item to become available.
              </div>
            )}
          </div>

          <aside className="grid content-start gap-4 rounded-3xl border border-line bg-panel-soft p-[22px] max-[720px]:rounded-[18px]">
            <p className="mb-2.5 text-[11px] uppercase tracking-[0.24em] text-accent">
              {selected.namespace}
            </p>
            <h2 className="m-0 font-serif text-[clamp(2rem,3vw,3.1rem)] leading-[0.96] tracking-[-0.04em]">
              {currentItem.data?.title ?? selected.itemId}
            </h2>
            <p className="m-0 text-[15px] leading-[1.7] text-muted">
              {currentItem.data?.description ??
                "Metadata will appear here after the cache exposes the current item."}
            </p>
            <dl className="mt-2 grid gap-2.5">
              <FactRow label="Primary URL" value={leadAsset?.url ?? "pending"} />
              <FactRow
                label="Root namespace"
                value={`${exampleClientConfig.rootNamespace} (${rootNamespace.data?.items.length ?? 0})`}
              />
              <FactRow
                label="Stem matches"
                value={String(fileStemMatches.data?.items.length ?? 0)}
              />
            </dl>
          </aside>
        </div>
      </section>

      <section
        className={`grid gap-[18px] rounded-[26px] p-[22px] max-[720px]:rounded-[22px] max-[720px]:p-[18px] ${panelCard}`}
      >
        <div className="flex flex-col items-start justify-between gap-4 min-[1081px]:flex-row min-[1081px]:items-end">
          <div>
            <p className="mb-2.5 text-[11px] uppercase tracking-[0.24em] text-accent">
              {exampleClientConfig.queueLabel}
            </p>
            <h3 className="m-0 font-serif text-[1.9rem] tracking-[-0.04em]">
              Choose a synced item
            </h3>
          </div>
          <p className="m-0 text-muted">{queue.length} items ready</p>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3.5">
          {queue.map((item) => {
            const isActive = item.namespace === selected.namespace && item.id === selected.itemId;
            const itemPoster = item.assetsByRole.poster;
            const itemLead = item.assetsByRole.primary ?? item.assets[0];

            return (
              <button
                key={`${item.namespace}/${item.id}`}
                className={
                  isActive
                    ? "cursor-pointer rounded-[20px] border border-accent/50 bg-[linear-gradient(180deg,rgba(19,34,49,0.92),rgba(10,17,26,0.92))] p-3 text-left text-inherit transition duration-150 hover:-translate-y-0.5 hover:border-line-strong"
                    : "cursor-pointer rounded-[20px] border border-line bg-panel-soft p-3 text-left text-inherit transition duration-150 hover:-translate-y-0.5 hover:border-line-strong"
                }
                type="button"
                onClick={() => setSelected({ namespace: item.namespace, itemId: item.id })}
              >
                <div className="aspect-video overflow-hidden rounded-[14px] border border-white/5 bg-[linear-gradient(135deg,rgba(133,209,255,0.12),rgba(255,203,125,0.08))]">
                  {itemPoster ? (
                    <img
                      className="block h-full w-full object-cover"
                      src={itemPoster.url}
                      alt={item.title}
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-[11px] uppercase tracking-[0.18em] text-accent-warm">
                      {itemLead?.kind ?? "asset"}
                    </div>
                  )}
                </div>
                <div className="grid gap-[7px] px-1 pb-0.5 pt-3">
                  <p className="m-0 text-[11px] uppercase tracking-[0.16em] text-accent">
                    {item.namespace}
                  </p>
                  <strong className="m-0 text-base">{item.title}</strong>
                  <span className="m-0 text-sm leading-[1.55] text-muted">
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
    <div className="grid min-w-[126px] gap-1.5 rounded-full border border-line bg-white/[0.03] px-4 py-3.5">
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted">{label}</span>
      <strong className="text-sm capitalize">{value}</strong>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="mb-1.5 border-t border-line pt-3 text-[11px] uppercase tracking-[0.16em] text-muted first:border-t-0 first:pt-0">
        {label}
      </dt>
      <dd className="m-0 break-words leading-normal text-text">{value}</dd>
    </>
  );
}
