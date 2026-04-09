import type { MediaCacheErrors, MediaCacheReadyState, MediaCacheStatus } from "../shared/types.js";
import type { MediaAsyncState } from "./runtime.js";

function toPrimaryError(syncError: MediaCacheStatus["error"]): Error | null {
  if (!syncError) {
    return null;
  }

  const error = new Error(syncError.message);
  error.name = syncError.name;
  return error;
}

/** Derive {@link MediaCacheReadyState} from a status snapshot, or `null` if status is missing. */
export function mediaCacheReadyFromStatus(
  status: MediaCacheStatus | null | undefined,
): MediaCacheReadyState | null {
  if (!status) {
    return null;
  }

  return {
    ready: status.phase === "ready",
    syncing: status.phase === "syncing",
    phase: status.phase,
    activeGenerationId: status.activeGenerationId,
    syncError: status.error,
  };
}

/** Combine status loading failures, sync errors, and query errors (same rules as `useMediaCacheErrors`). */
export function aggregateMediaCacheErrors(
  statusState: MediaAsyncState<MediaCacheStatus>,
  queryErrors: Error[],
): MediaCacheErrors {
  const syncError = statusState.data?.error ?? null;
  const statusError = statusState.error;
  const primaryError = statusError ?? queryErrors[0] ?? toPrimaryError(syncError);

  return {
    syncError,
    statusError,
    queryErrors,
    hasError: primaryError !== null,
    primaryError,
  };
}
