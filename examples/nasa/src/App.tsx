import { useState } from "react";
import {
  useMediaCacheBridge,
  useFileStemMatch,
  useMediaCacheErrors,
  useMediaCacheReady,
  useMediaCacheStatus,
  useMediaItem,
  useMediaItems,
} from "@rockhallweb/electron-offline-content/react";
import { cn } from "./cn";

type SelectedItem = { namespace: string; itemId: string };
type QueueCard = {
  namespace: string;
  itemId: string;
  title: string;
  description: string;
  posterUrl: string | null;
  leadKind: string;
};
type MediaFilter = "all" | "image" | "video";

export function App() {
  const bridge = useMediaCacheBridge();
  const status = useMediaCacheStatus();
  const ready = useMediaCacheReady();
  const rootNamespace = useMediaItems("space", { limit: 20 });
  const tree = useMediaItems("space", { recursive: true, limit: 40 });
  const fileStemMatches = useFileStemMatch("mars-large-organics", { limit: 10 });
  const [isStartingDownload, setIsStartingDownload] = useState(false);
  const [downloadStartError, setDownloadStartError] = useState<string | null>(null);

  const [selectedIntent, setSelectedIntent] = useState<SelectedItem>({
    namespace: "space.images",
    itemId: "SSC-20110203-S00095H",
  });

  const items = tree.data?.items ?? [];
  const selectedExists = items.some(
    (item) => item.namespace === selectedIntent.namespace && item.id === selectedIntent.itemId,
  );
  const selected = selectedExists
    ? selectedIntent
    : items[0]
      ? { namespace: items[0].namespace, itemId: items[0].id }
      : selectedIntent;

  const currentItem = useMediaItem(selected.namespace, selected.itemId);
  const leadAsset = currentItem.data?.assetsByRole.primary ?? currentItem.data?.assets[0];
  const posterAsset = currentItem.data?.assetsByRole.poster;
  const subtitleAsset = currentItem.data?.assetsByRole.subtitle;
  const queueCards: QueueCard[] = (tree.data?.items ?? []).map((item) => ({
    namespace: item.namespace,
    itemId: item.id,
    title: item.title ?? item.id,
    description: item.description ?? item.summary ?? "Cached and ready for offline playback.",
    posterUrl: item.assetsByRole.poster?.url ?? null,
    leadKind: item.assetsByRole.primary?.kind ?? item.assets[0]?.kind ?? "asset",
  }));
  const errors = useMediaCacheErrors(status, rootNamespace, tree, fileStemMatches, currentItem);

  const phase = status.data?.phase ?? (status.loading ? "loading" : "idle");
  const generation = String(ready.data?.activeGenerationId ?? "none");
  const downloadProgress = status.data?.progress ?? null;
  const storagePath = status.data?.storagePath ?? "Resolving local storage path...";
  const isDownloading = phase === "syncing";
  const isReady = phase === "ready" && queueCards.length > 0 && currentItem.data != null;
  const syncErrorMessage = ready.data?.syncError?.message ?? null;
  const actionError = downloadStartError ?? syncErrorMessage;

  const startDownload = async () => {
    setDownloadStartError(null);
    setIsStartingDownload(true);
    try {
      await bridge.syncNow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDownloadStartError(message);
    } finally {
      setIsStartingDownload(false);
    }
  };

  return (
    <main className={cn(["min-h-screen bg-black text-text", "max-[860px]:px-1"])}>
      <div className="grid w-full gap-0">
        <ErrorBanners
          syncError={errors.syncError?.message}
          primaryError={errors.primaryError?.message}
        />

        {isDownloading ? (
          <DownloadingView
            generation={generation}
            progress={downloadProgress}
            onStartDownload={startDownload}
            isStartingDownload={isStartingDownload}
          />
        ) : isReady ? (
          <ArchiveView
            phase={phase}
            generation={generation}
            selected={selected}
            title={currentItem.data?.title ?? selected.itemId}
            description={
              currentItem.data?.description ??
              "Metadata will appear here after the cache exposes the current item."
            }
            leadAsset={leadAsset ? { kind: leadAsset.kind, url: leadAsset.url } : null}
            posterAssetUrl={posterAsset?.url ?? null}
            subtitleAssetUrl={subtitleAsset?.url ?? null}
            rootNamespaceCount={rootNamespace.data?.items.length ?? 0}
            stemMatchCount={fileStemMatches.data?.items.length ?? 0}
            queue={queueCards}
            onSelect={setSelectedIntent}
          />
        ) : (
          <PreDownloadView
            generation={generation}
            storagePath={storagePath}
            actionError={actionError}
            onStartDownload={startDownload}
            isStartingDownload={isStartingDownload}
          />
        )}
      </div>
    </main>
  );
}

function ErrorBanners({ syncError, primaryError }: { syncError?: string; primaryError?: string }) {
  const cls = cn([
    "border-l-2 border-[#f87171] bg-[rgba(248,113,113,0.08)] px-4 py-3",
    "font-tech text-[11px] tracking-[0.1em] text-[#fca5a5]",
  ]);
  return (
    <>
      {syncError ? (
        <section className={cls}>
          <strong className="mr-3 text-[#f87171]">SYNC ERROR:</strong>
          <span className="font-body text-sm tracking-[0.01em] text-[#fecaca]">{syncError}</span>
        </section>
      ) : null}
      {primaryError ? (
        <section className={cls}>
          <strong className="mr-3 text-[#f87171]">QUERY ERROR:</strong>
          <span className="font-body text-sm tracking-[0.01em] text-[#fecaca]">{primaryError}</span>
        </section>
      ) : null}
    </>
  );
}

function Header({ phase, generation }: { phase: string; generation: string }) {
  return (
    <header className="flex flex-col justify-between gap-5 border-b border-border pb-5 min-[1081px]:flex-row min-[1081px]:items-end">
      <div className="grid gap-3">
        <p className="text-tech flex items-center gap-2 text-[11px] tracking-[0.2em] text-text-dim">
          <span className="inline-block h-1.5 w-1.5 bg-accent" />
          Mission Archive
        </p>
        <h1 className="font-display max-w-[14ch] text-[clamp(2.6rem,5.4vw,5.8rem)] leading-[0.9] tracking-[-0.03em] text-[#e4e4e7]">
          Offline media staged once and played locally.
        </h1>
      </div>
      <div className="grid gap-2 self-start text-right min-[1081px]:self-end">
        <StatusReadout label="Source" value="NASA SVS" />
        <StatusReadout label="Phase" value={phase} />
        <StatusReadout label="Generation" value={generation} />
      </div>
    </header>
  );
}

function StatusReadout({ label, value }: { label: string; value: string }) {
  return (
    <p className="font-tech text-[11px] uppercase tracking-[0.11em]">
      <span className="text-text-dim">{label}:</span>{" "}
      <strong className="font-tech text-[#e4e4e7]">{value}</strong>
    </p>
  );
}

function CompactStatusBar({ phase, generation }: { phase: string; generation: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border px-4 py-2.5">
      <p className="text-tech flex items-center gap-2 text-[11px] tracking-[0.2em] text-text-dim">
        <span className="inline-block h-1.5 w-1.5 bg-accent" />
        Mission Archive
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 min-[1081px]:ml-auto">
        <StatusReadout label="Source" value="NASA SVS" />
        <StatusReadout label="Phase" value={phase} />
        <StatusReadout label="Gen" value={generation} />
      </div>
    </div>
  );
}

function PreDownloadView({
  generation,
  storagePath,
  actionError,
  onStartDownload,
  isStartingDownload,
}: {
  generation: string;
  storagePath: string;
  actionError: string | null;
  onStartDownload: () => Promise<void>;
  isStartingDownload: boolean;
}) {
  return (
    <section className="grid gap-6 border border-border bg-surface px-5 py-6 min-[860px]:px-7 min-[860px]:py-7">
      <Header phase="idle" generation={generation} />
      <div className="grid min-h-[420px] place-items-center border border-border bg-surface-alt p-7 text-center">
        <div className="grid max-w-[72ch] gap-4">
          <p className="text-tech text-[11px] tracking-[0.2em] text-text-dim">Download required</p>
          <p className="font-display text-[clamp(2rem,4vw,3.2rem)] tracking-[-0.02em] text-[#e4e4e7]">
            Archive content is downloaded to your local machine.
          </p>
          <p className="font-body mx-auto max-w-[54ch] text-lg text-[#a1a1aa]">
            This NASA demo is focused on runtime offline behavior. When you start the download,
            media files are cached locally and then served from the `media:` protocol.
          </p>
          <p className="mx-auto max-w-[64ch] break-all border border-border bg-black/30 px-4 py-3 font-tech text-xs text-[#d4d4d8]">
            {storagePath}
          </p>
          {actionError ? (
            <p className="font-body text-sm text-[#fca5a5]">Download failed: {actionError}</p>
          ) : null}
          <div>
            <button
              className={cn([
                "cursor-pointer border border-border-focus bg-[#161618] px-6 py-3 font-tech text-xs uppercase tracking-[0.2em] text-[#e4e4e7]",
                "transition-colors duration-150 hover:bg-[#27272a]",
                isStartingDownload && "cursor-wait opacity-70",
              ])}
              type="button"
              onClick={() => {
                void onStartDownload();
              }}
              disabled={isStartingDownload}
            >
              {isStartingDownload ? "Starting Download..." : "Download Archive"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function DownloadingView({
  generation,
  progress,
  onStartDownload,
  isStartingDownload,
}: {
  generation: string;
  progress: {
    phase: string;
    totalAssets: number;
    completedAssets: number;
    downloadedAssets: number;
    bytesDownloaded: number;
  } | null;
  onStartDownload: () => Promise<void>;
  isStartingDownload: boolean;
}) {
  const totalAssets = progress?.totalAssets ?? 0;
  const completedAssets = progress?.completedAssets ?? 0;
  const downloadedAssets = progress?.downloadedAssets ?? 0;
  const bytesDownloaded = progress?.bytesDownloaded ?? 0;
  const progressFraction = totalAssets === 0 ? 0 : Math.min(completedAssets / totalAssets, 1);

  return (
    <section className="grid gap-6 border border-border bg-surface px-5 py-6 min-[860px]:px-7 min-[860px]:py-7">
      <Header phase="syncing" generation={generation} />
      <div className="grid min-h-[420px] place-items-center border border-border bg-surface-alt p-7 text-center">
        <div className="grid w-full max-w-[72ch] gap-4">
          <p className="text-tech text-[11px] tracking-[0.2em] text-text-dim">Sync in progress</p>
          <p className="font-display text-[clamp(2rem,4vw,3.2rem)] tracking-[-0.02em] text-[#e4e4e7]">
            Downloading NASA archive
            <span className="ml-1 inline-block text-accent [animation:archivePulse_1.2s_ease-in-out_infinite]">
              .
            </span>
          </p>
          <div className="grid gap-2 border border-border bg-black/30 px-4 py-4 text-left">
            <StatusReadout label="Step" value={humanizeSyncPhase(progress?.phase)} />
            <StatusReadout label="Assets" value={`${completedAssets}/${totalAssets}`} />
            <StatusReadout label="Downloaded assets" value={String(downloadedAssets)} />
            <StatusReadout label="Bytes downloaded" value={formatBytes(bytesDownloaded)} />
          </div>
          <div className="h-2 w-full border border-border bg-black/20">
            <div
              className="h-full bg-accent transition-all duration-200"
              style={{ width: `${Math.round(progressFraction * 100)}%` }}
            />
          </div>
          <p className="font-body text-sm text-[#a1a1aa]">
            Progress updates come directly from the main-process sync pipeline.
          </p>
          <div>
            <button
              className={cn([
                "cursor-pointer border border-border bg-[#161618] px-4 py-2 font-tech text-[10px] uppercase tracking-[0.2em] text-[#a1a1aa]",
                "transition-colors duration-150 hover:bg-[#27272a]",
                isStartingDownload && "cursor-wait opacity-70",
              ])}
              type="button"
              onClick={() => {
                void onStartDownload();
              }}
              disabled={isStartingDownload}
            >
              Trigger Sync Again
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ArchiveView(props: {
  phase: string;
  generation: string;
  selected: SelectedItem;
  title: string;
  description: string;
  leadAsset: { kind: string; url: string } | null;
  posterAssetUrl: string | null;
  subtitleAssetUrl: string | null;
  rootNamespaceCount: number;
  stemMatchCount: number;
  queue: QueueCard[];
  onSelect: (value: SelectedItem) => void;
}) {
  const [filter, setFilter] = useState<MediaFilter>("all");
  const filteredQueue =
    filter === "all"
      ? props.queue
      : props.queue.filter((item) => mediaKindFromNamespace(item.namespace) === filter);

  return (
    <section className="min-h-screen border-x border-border bg-surface">
      <CompactStatusBar phase={props.phase} generation={props.generation} />
      <div className="grid grid-cols-1 min-[1081px]:grid-cols-[280px_1fr]">
        <nav
          className={cn([
            "border-b border-border bg-surface-alt",
            "min-[1081px]:sticky min-[1081px]:top-0 min-[1081px]:self-start",
            "min-[1081px]:max-h-screen min-[1081px]:border-b-0 min-[1081px]:border-r",
            "min-[1081px]:grid min-[1081px]:grid-rows-[auto_1fr] min-[1081px]:min-h-0",
          ])}
        >
          <div className="grid gap-2 border-b border-border px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-display text-sm tracking-[-0.01em] text-[#e4e4e7]">Archive</h3>
              <p className="font-tech text-[10px] tracking-[0.16em] text-text-dim">
                {filteredQueue.length} items
              </p>
            </div>
            <div className="flex gap-1">
              {(["all", "image", "video"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={cn([
                    "cursor-pointer px-2 py-0.5 font-tech text-[9px] uppercase tracking-[0.16em] transition-colors duration-150",
                    filter === f
                      ? "bg-accent/20 text-accent"
                      : "text-text-dim hover:text-[#e4e4e7]",
                  ])}
                  onClick={() => setFilter(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div
            className={cn([
              "filmstrip-scrollbar sidebar-scrollbar flex snap-x gap-2 overflow-x-auto p-3",
              "min-[1081px]:min-h-0 min-[1081px]:flex-col min-[1081px]:snap-y min-[1081px]:overflow-x-hidden min-[1081px]:overflow-y-auto",
            ])}
          >
            {filteredQueue.map((item) => {
              const isActive =
                item.namespace === props.selected.namespace &&
                item.itemId === props.selected.itemId;
              return (
                <button
                  key={`${item.namespace}/${item.itemId}`}
                  className={cn([
                    "shrink-0 snap-start border bg-surface-alt p-1.5 text-left text-inherit",
                    "transition-colors duration-150 hover:border-border-focus hover:bg-[#1a1a1e]",
                    "w-[180px] min-[1081px]:w-full",
                    isActive
                      ? "border-l-2 border-l-accent border-border-focus bg-[#1a1a1e]"
                      : "border-border",
                  ])}
                  type="button"
                  onClick={() => props.onSelect({ namespace: item.namespace, itemId: item.itemId })}
                >
                  <div className="relative aspect-video overflow-hidden border border-border bg-black">
                    {item.posterUrl ? (
                      <img
                        className="block h-full w-full object-cover"
                        src={item.posterUrl}
                        alt={item.title}
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center">
                        <span className="text-tech text-[10px] tracking-[0.18em] text-text-dim">
                          {item.leadKind}
                        </span>
                      </div>
                    )}
                    <MediaKindBadge namespace={item.namespace} />
                  </div>
                  <div className="grid gap-1 px-1 pb-0.5 pt-2">
                    <p className="text-tech text-[9px] tracking-[0.16em] text-text-dim">
                      {item.namespace}
                    </p>
                    <strong className="font-display text-sm leading-[1.15] text-[#e4e4e7]">
                      {item.title}
                    </strong>
                  </div>
                </button>
              );
            })}
          </div>
        </nav>

        <div className="grid content-start gap-4 p-4 min-[860px]:p-5">
          <figure className="relative aspect-video w-full overflow-hidden border border-border bg-black">
            {props.leadAsset?.kind === "video" ? (
              <video
                key={props.leadAsset.url}
                className="block h-full w-full bg-black object-contain transition-opacity duration-300"
                src={props.leadAsset.url}
                autoPlay
                controls
                playsInline
                poster={props.posterAssetUrl ?? undefined}
              >
                {props.subtitleAssetUrl ? (
                  <track kind="subtitles" src={props.subtitleAssetUrl} default label="Captions" />
                ) : null}
              </video>
            ) : props.posterAssetUrl ? (
              <img
                className="block h-full w-full bg-black object-contain transition-opacity duration-300"
                src={props.posterAssetUrl}
                alt={props.title}
              />
            ) : (
              <div className="grid h-full place-items-center p-6 text-center">
                <p className="text-tech text-[11px] tracking-[0.2em] text-text-dim">
                  Awaiting cached media
                </p>
              </div>
            )}
            {props.leadAsset?.kind !== "video" ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[28%] bg-gradient-to-t from-black via-black/25 to-transparent" />
            ) : null}
          </figure>

          <div className="grid content-start gap-3 border-l-2 border-accent bg-surface-alt p-4 min-[860px]:p-5">
            <p className="text-tech text-[10px] tracking-[0.2em] text-text-dim">
              {props.selected.namespace}
            </p>
            <h2 className="font-display text-[clamp(1.4rem,2vw,2rem)] leading-[1.05] text-[#e4e4e7]">
              {props.title}
            </h2>
            <p className="font-body text-[1rem] leading-[1.55] text-[#a1a1aa]">
              {props.description}
            </p>
            <dl className="mt-1 grid gap-2">
              <FactRow label="Primary URL" value={props.leadAsset?.url ?? "pending"} />
              <FactRow label="Root namespace" value={`space (${props.rootNamespaceCount})`} />
              <FactRow label="Stem matches" value={String(props.stemMatchCount)} />
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

function mediaKindFromNamespace(namespace: string): "image" | "video" {
  return namespace.includes(".videos") ? "video" : "image";
}

function MediaKindBadge({ namespace }: { namespace: string }) {
  const kind = mediaKindFromNamespace(namespace);
  return (
    <span
      className={cn([
        "absolute bottom-1 right-1 px-1.5 py-0.5 font-tech text-[8px] uppercase tracking-[0.14em]",
        kind === "video" ? "bg-accent/90 text-white" : "bg-white/80 text-black",
      ])}
    >
      {kind}
    </span>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="border-t border-border pt-2.5 font-tech text-[10px] tracking-[0.16em] text-text-dim first:border-t-0 first:pt-0">
        {label}
      </dt>
      <dd className="m-0 font-body text-[0.98rem] leading-[1.38] text-[#d4d4d8] [overflow-wrap:anywhere]">
        {value}
      </dd>
    </>
  );
}

function humanizeSyncPhase(phase: string | undefined): string {
  if (!phase) {
    return "Waiting";
  }
  return phase.replace(/-/g, " ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
