import {
  useFileStemMatch,
  useMedia,
  useMediaBridge,
  useMediaCacheErrors,
  useMediaCacheReady,
  useMediaCacheStatus,
} from "../../../src/react/index.js";

export function MediaItemProbe({ itemId }: { itemId: string }) {
  const item = useMedia({ kind: "item", namespace: "nature", id: itemId });
  return <div data-testid="item-id">{item.data?.id ?? "loading"}</div>;
}

export function MediaVersionProbe({ refetchOnSyncComplete }: { refetchOnSyncComplete?: boolean }) {
  const item = useMedia({
    kind: "item",
    namespace: "nature",
    id: "forest",
    refetchOnSyncComplete,
  });
  return <div data-testid="item-version">{item.data?.version ?? "loading"}</div>;
}

export function MediaListProbe({ recursive }: { recursive: boolean }) {
  const items = useMedia({ kind: "list", namespace: "nature", recursive });
  return <div>{items.data?.items[0]?.id ?? "loading"}</div>;
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
  const media = useMedia({ kind: "item", namespace: "nature", id: "forest" });
  const bridge = useMediaBridge();
  return (
    <div>
      <div data-testid="media-phase">{media.phase}</div>
      <div data-testid="bridge-phase">{bridge.phase}</div>
    </div>
  );
}

export function ReadyAndErrorProbe() {
  const ready = useMediaCacheReady();
  const media = useMedia({ kind: "item", namespace: "nature", id: "forest" });
  const errors = useMediaCacheErrors();

  return (
    <div>
      <div data-testid="ready-flag">{String(ready.data?.ready ?? false)}</div>
      <div data-testid="media-status-phase">{media.phase}</div>
      <div data-testid="error-flag">{String(errors.hasError)}</div>
      <div data-testid="sync-error-code">{errors.syncError?.code ?? "none"}</div>
      <div data-testid="primary-error-message">{errors.primaryError?.message ?? "none"}</div>
      <div data-testid="query-error-count">{String(errors.queryErrors.length)}</div>
    </div>
  );
}

export function GlobalErrorsProbe() {
  useMedia({ kind: "item", namespace: "nature", id: "forest" });
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
  useMedia({ kind: "item", namespace: "nature", id: "forest" });
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
  const media = useMedia({ kind: "item", namespace: "nature", id: "forest" });
  const errors = useMediaCacheErrors();

  return <div data-testid="provider-runtime-phase">{errors.hasError ? "error" : media.phase}</div>;
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
