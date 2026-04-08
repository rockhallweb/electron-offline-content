import { useState } from "react";
import {
  useFileStemMatch,
  useMediaAsset,
  useMediaByIndex,
  useMediaCacheStatus,
  useMediaBridge,
  type ResolvedMediaAsset,
} from "@rockhallweb/electron-offline-content/react";
import { cn } from "./cn";
import { formatBytes } from "./util";

type SyncDownloadControlsProps = {
  onStartDownload: () => Promise<void>;
  isStartingDownload: boolean;
};

type DownloadActionProps = SyncDownloadControlsProps & {
  downloadStartError?: string | null;
};

export function App() {
  const { syncNow, phase, status, errors } = useMediaBridge();
  const hasCommittedSnapshot = status.data?.activeGenerationId != null;
  const [isStartingDownload, setIsStartingDownload] = useState(false);
  const [downloadStartError, setDownloadStartError] = useState<string | null>(null);

  const startDownload = async () => {
    setDownloadStartError(null);
    setIsStartingDownload(true);
    try {
      await syncNow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDownloadStartError(message);
    } finally {
      setIsStartingDownload(false);
    }
  };

  const errorClasses = cn([
    "border-l-2 border-[#f87171] bg-[rgba(248,113,113,0.08)] px-4 py-3",
    "font-tech text-[11px] tracking-[0.1em] text-[#fca5a5]",
  ]);

  return (
    <main className={cn(["min-h-screen bg-black text-text", "max-[860px]:px-1"])}>
      <div className="grid w-full gap-0">
        {(errors.primaryError?.message ?? errors.syncError?.message) ? (
          <section className={errorClasses}>
            <strong className="mr-3 text-[#f87171]">ERROR:</strong>
            <span className="font-body text-sm tracking-[0.01em] text-[#fecaca]">
              {errors.primaryError?.message ?? errors.syncError?.message}
            </span>
          </section>
        ) : null}

        {hasCommittedSnapshot ? (
          <ArchiveView />
        ) : phase === "syncing" ? (
          <DownloadingView
            onStartDownload={startDownload}
            isStartingDownload={isStartingDownload}
          />
        ) : (
          <PreDownloadView
            downloadStartError={downloadStartError}
            onStartDownload={startDownload}
            isStartingDownload={isStartingDownload}
          />
        )}
      </div>
    </main>
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
  downloadStartError,
  onStartDownload,
  isStartingDownload,
}: DownloadActionProps) {
  const status = useMediaCacheStatus();
  const { phase } = status;
  const generation = String(status.data?.activeGenerationId ?? "none");
  const storagePath = status.data?.storageRoot ?? "Resolving local storage path...";
  const actionError = downloadStartError ?? status.data?.error?.message ?? null;

  return (
    <section className="grid gap-6 border border-border bg-surface px-5 py-6 min-[860px]:px-7 min-[860px]:py-7">
      <Header phase={phase} generation={generation} />
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

function DownloadingView({ onStartDownload, isStartingDownload }: SyncDownloadControlsProps) {
  const status = useMediaCacheStatus();
  const generation = String(status.data?.activeGenerationId ?? "none");
  const progress = status.data?.progress ?? null;
  const totalAssets = progress?.totalAssets ?? 0;
  const completedAssets = progress?.completedAssets ?? 0;
  const downloadedAssets = progress?.downloadedAssets ?? 0;
  const bytesDownloaded = progress?.bytesDownloaded ?? 0;
  const progressFraction = totalAssets === 0 ? 0 : Math.min(completedAssets / totalAssets, 1);

  return (
    <section className="grid gap-6 border border-border bg-surface px-5 py-6 min-[860px]:px-7 min-[860px]:py-7">
      <Header phase={status.phase} generation={generation} />
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
            <StatusReadout label="Step" value={progress?.phase?.replace(/-/g, " ") ?? "Waiting"} />
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

/** Derives a poster asset key from a primary asset key by swapping the trailing segment. */
function posterKeyFrom(primaryKey: string): string {
  return primaryKey.replace(/\/primary$/, "/poster");
}

/** Extracts the collection path from an asset key (e.g. "space.images" from "space.images/ID/primary"). */
function collectionFromKey(key: string): string {
  const parts = key.split("/");
  return parts.length >= 3 ? parts.slice(0, -2).join("/") : key;
}

function ArchiveView() {
  const status = useMediaCacheStatus();
  const primaryAssets = useMediaByIndex("role", "primary", { limit: 40 });
  const fileStemMatches = useFileStemMatch("mars-large-organics", { limit: 10 });

  const [selectedKey, setSelectedKey] = useState("space.images/SSC-20110203-S00095H/primary");
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const { phase } = status;
  const generation = String(status.data?.activeGenerationId ?? "none");

  const queue = primaryAssets.data?.items ?? [];
  const filteredQueue =
    filter === "all"
      ? queue
      : queue.filter((asset) => {
          const mt = asset.indexes.mediaType;
          return typeof mt === "string" && mt === filter;
        });

  const selectedExists = filteredQueue.some((asset) => asset.key === selectedKey);
  const effectiveKey = selectedExists
    ? selectedKey
    : (filteredQueue[0]?.key ?? queue[0]?.key ?? selectedKey);

  const currentAsset = useMediaAsset(effectiveKey);
  const posterAsset = useMediaAsset(posterKeyFrom(effectiveKey));

  const title = String(currentAsset.data?.metadata.title ?? effectiveKey);
  const description = String(
    currentAsset.data?.metadata.description ??
      "Metadata will appear here after the cache exposes the current asset.",
  );
  const isPrimaryVideo = currentAsset.data?.kind === "video";
  const primaryUrl = currentAsset.data?.url ?? null;
  const posterUrl = posterAsset.data?.url ?? null;
  const imageUrl = !isPrimaryVideo && primaryUrl ? primaryUrl : posterUrl;

  return (
    <section className="min-h-screen border-x border-border bg-surface">
      <CompactStatusBar phase={phase} generation={generation} />
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
            {filteredQueue.map((asset) => (
              <QueueCard
                key={asset.key}
                asset={asset}
                isActive={asset.key === effectiveKey}
                onSelect={() => setSelectedKey(asset.key)}
              />
            ))}
          </div>
        </nav>

        <div className="grid content-start gap-4 p-4 min-[860px]:p-5">
          <figure className="relative aspect-video w-full overflow-hidden border border-border bg-black">
            {isPrimaryVideo ? (
              <video
                key={primaryUrl}
                className="block h-full w-full bg-black object-contain transition-opacity duration-300"
                src={primaryUrl ?? undefined}
                autoPlay
                controls
                playsInline
                poster={posterUrl ?? undefined}
              />
            ) : imageUrl ? (
              <img
                className="block h-full w-full bg-black object-contain transition-opacity duration-300"
                src={imageUrl}
                alt={title}
              />
            ) : (
              <div className="grid h-full place-items-center p-6 text-center">
                <p className="text-tech text-[11px] tracking-[0.2em] text-text-dim">
                  Awaiting cached media
                </p>
              </div>
            )}
            {!isPrimaryVideo ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[28%] bg-gradient-to-t from-black via-black/25 to-transparent" />
            ) : null}
          </figure>

          <div className="grid content-start gap-3 border-l-2 border-accent bg-surface-alt p-4 min-[860px]:p-5">
            <p className="text-tech text-[10px] tracking-[0.2em] text-text-dim">
              {collectionFromKey(effectiveKey)}
            </p>
            <h2 className="font-display text-[clamp(1.4rem,2vw,2rem)] leading-[1.05] text-[#e4e4e7]">
              {title}
            </h2>
            <p className="font-body text-[1rem] leading-[1.55] text-[#a1a1aa]">{description}</p>
            <dl className="mt-1 grid gap-2">
              <FactRow label="Primary URL" value={currentAsset.data?.url ?? "pending"} />
              <FactRow label="Primary assets" value={String(queue.length)} />
              <FactRow
                label="Stem matches"
                value={String(fileStemMatches.data?.items.length ?? 0)}
              />
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

function QueueCard({
  asset,
  isActive,
  onSelect,
}: {
  asset: ResolvedMediaAsset;
  isActive: boolean;
  onSelect: () => void;
}) {
  const posterAsset = useMediaAsset(posterKeyFrom(asset.key));
  const posterUrl = posterAsset.data?.url ?? null;
  const cardMediaType =
    typeof asset.indexes.mediaType === "string" ? asset.indexes.mediaType : "asset";
  const assetTitle = String(asset.metadata.title ?? asset.key);
  const collection = collectionFromKey(asset.key);

  return (
    <button
      className={cn([
        "shrink-0 snap-start border bg-surface-alt p-1.5 text-left text-inherit",
        "transition-colors duration-150 hover:border-border-focus hover:bg-[#1a1a1e]",
        "w-[180px] min-[1081px]:w-full",
        isActive ? "border-l-2 border-l-accent border-border-focus bg-[#1a1a1e]" : "border-border",
      ])}
      type="button"
      onClick={onSelect}
    >
      <div className="relative aspect-video overflow-hidden border border-border bg-black">
        {posterUrl ? (
          <img className="block h-full w-full object-cover" src={posterUrl} alt={assetTitle} />
        ) : (
          <div className="grid h-full w-full place-items-center">
            <span className="text-tech text-[10px] tracking-[0.18em] text-text-dim">
              {cardMediaType}
            </span>
          </div>
        )}
        <span
          className={cn([
            "absolute bottom-1 right-1 px-1.5 py-0.5 font-tech text-[8px] uppercase tracking-[0.14em]",
            cardMediaType === "video" ? "bg-accent/90 text-white" : "bg-white/80 text-black",
          ])}
        >
          {cardMediaType}
        </span>
      </div>
      <div className="grid gap-1 px-1 pb-0.5 pt-2">
        <p className="text-tech text-[9px] tracking-[0.16em] text-text-dim">{collection}</p>
        <strong className="font-display text-sm leading-[1.15] text-[#e4e4e7]">{assetTitle}</strong>
      </div>
    </button>
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
