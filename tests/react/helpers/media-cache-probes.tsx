import {
  useFileStemMatch,
  useMediaAsset,
  useMediaBridge,
  useMediaByIndex,
  useMediaCacheErrors,
  useMediaCacheReady,
  useMediaCacheStatus,
} from "../../../src/react/index.js";

export function MediaAssetProbe({ assetKey }: { assetKey: string }) {
  const asset = useMediaAsset(assetKey);
  return <div data-testid="asset-key">{asset.data?.key ?? "loading"}</div>;
}

export function MediaVersionProbe({ refetchOnSyncComplete }: { refetchOnSyncComplete?: boolean }) {
  const asset = useMediaAsset("forest", { refetchOnSyncComplete });
  return <div data-testid="item-version">{asset.data?.version ?? "loading"}</div>;
}

export function MediaByIndexProbe({
  indexName,
  value,
}: {
  indexName: string;
  value: string;
}) {
  const assets = useMediaByIndex(indexName, value);
  return <div>{assets.data?.items[0]?.key ?? "loading"}</div>;
}

export function StatusProbe() {
  const status = useMediaCacheStatus();
  return <div data-testid="status-phase">{status.phase}</div>;
}

export function MediaCacheStatusPhaseProbe() {
  const status = useMediaCacheStatus();
  return <div data-testid="status-hook-phase">{status.phase}</div>;
}

export function MediaAndBridgePhaseProbe() {
  const _asset = useMediaAsset("forest");
  const bridge = useMediaBridge();
  return (
    <div>
      <div data-testid="media-phase">{bridge.phase}</div>
      <div data-testid="bridge-phase">{bridge.phase}</div>
    </div>
  );
}

export function ReadyAndErrorProbe() {
  const ready = useMediaCacheReady();
  const _asset = useMediaAsset("forest");
  const errors = useMediaCacheErrors();

  return (
    <div>
      <div data-testid="ready-flag">{String(ready.data?.ready ?? false)}</div>
      <div data-testid="media-status-phase">{ready.data?.phase ?? "loading"}</div>
      <div data-testid="error-flag">{String(errors.hasError)}</div>
      <div data-testid="sync-error-code">{errors.syncError?.code ?? "none"}</div>
      <div data-testid="primary-error-message">{errors.primaryError?.message ?? "none"}</div>
      <div data-testid="query-error-count">{String(errors.queryErrors.length)}</div>
    </div>
  );
}

export function GlobalErrorsProbe() {
  useMediaAsset("forest");
  useFileStemMatch("forest");
  const errors = useMediaCacheErrors();

  return (
    <div>
      <div data-testid="global-query-error-count">{String(errors.queryErrors.length)}</div>
      <div data-testid="global-primary-error-message">{errors.primaryError?.message ?? "none"}</div>
    </div>
  );
}

export function BridgeProbe() {
  useMediaAsset("forest");
  const { syncNow, phase, errors } = useMediaBridge();

  return (
    <div>
      <button type="button" onClick={() => void syncNow()}>
        sync-now
      </button>
      <div data-testid="bridge-status-phase">{phase}</div>
      <div data-testid="bridge-query-error-count">{String(errors.queryErrors.length)}</div>
      <div data-testid="bridge-primary-error-message">{errors.primaryError?.message ?? "none"}</div>
    </div>
  );
}

export function ProviderRuntimeProbe() {
  const asset = useMediaAsset("forest");
  const errors = useMediaCacheErrors();

  return (
    <div data-testid="provider-runtime-phase">
      {errors.hasError ? "error" : asset.loading ? "loading" : "ready"}
    </div>
  );
}

export function SyncPrimaryErrorProbe() {
  const errors = useMediaCacheErrors();

  return (
    <div>
      <div data-testid="sync-primary-error-name">{errors.primaryError?.name ?? "none"}</div>
      <div data-testid="sync-primary-error-message">{errors.primaryError?.message ?? "none"}</div>
    </div>
  );
}
