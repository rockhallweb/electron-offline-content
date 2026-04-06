import { z } from "zod";
import { DataValidationError } from "../shared/errors.js";
import type { ActiveAssetRow, PendingDeletion } from "../main/database.js";
import type {
  DownloadRequest,
  JsonValue,
  ManifestItem,
  MediaAssetDefinition,
  MediaCacheAppPath,
  MediaCacheStatus,
  MediaCacheStoragePath,
  MediaContentDefinition,
  MediaKind,
  MediaNamespaceDefinition,
  MediaCacheManifest,
  MediaRemoteSource,
  SerializedMediaCacheError,
  SyncProgress,
  SyncRunStats,
  SyncRunSummary,
} from "../shared/types.js";

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nonNegativeNumberSchema = z.number().nonnegative();

/**
 * Schema for IPC/API string identifiers: namespace, item ID, namespace tree prefix, file stem.
 * Enforces min 1 and max 2000 characters. Used by getItem, listNamespace, listNamespaceTree, findByFileStem.
 */
export const stringInputSchema = z.string().min(1).max(2000);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<Record<string, JsonValue>> = z.record(
  z.string(),
  jsonValueSchema,
);

export const stringRecordSchema = z.record(z.string(), z.string());

export const serializedMediaCacheErrorSchema: z.ZodType<SerializedMediaCacheError> = z.object({
  name: z.string(),
  code: z.string(),
  message: z.string(),
});

export const syncRunStatsSchema: z.ZodType<SyncRunStats> = z.object({
  totalAssets: nonNegativeIntegerSchema,
  downloadedAssets: nonNegativeIntegerSchema,
  skippedAssets: nonNegativeIntegerSchema,
  bytesDownloaded: nonNegativeNumberSchema,
});

export const syncProgressSchema: z.ZodType<SyncProgress> = z.object({
  runId: nonNegativeIntegerSchema,
  phase: z.enum([
    "resolving-manifest",
    "staging-generation",
    "diffing",
    "downloading",
    "committing",
    "pruning",
  ]),
  totalAssets: nonNegativeIntegerSchema,
  completedAssets: nonNegativeIntegerSchema,
  downloadedAssets: nonNegativeIntegerSchema,
  skippedAssets: nonNegativeIntegerSchema,
  bytesDownloaded: nonNegativeNumberSchema,
});

export const syncRunSummarySchema: z.ZodType<SyncRunSummary> = z.object({
  id: nonNegativeIntegerSchema,
  status: z.enum(["running", "success", "error"]),
  startedAt: nonNegativeIntegerSchema,
  finishedAt: nonNegativeIntegerSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  stats: syncRunStatsSchema,
});

export const mediaCacheStatusSchema: z.ZodType<MediaCacheStatus> = z.object({
  phase: z.enum(["idle", "syncing", "ready", "error"]),
  storageRoot: z.string().nullable().default(null),
  activeGenerationId: nonNegativeIntegerSchema.nullable(),
  progress: syncProgressSchema.nullable(),
  lastRun: syncRunSummarySchema.nullable(),
  error: serializedMediaCacheErrorSchema.nullable(),
  updatedAt: nonNegativeIntegerSchema,
});

export const downloadRequestSchema: z.ZodType<DownloadRequest> = z.object({
  url: z.string(),
  method: z.literal("GET").optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const mediaKindSchema: z.ZodType<MediaKind> = z.enum([
  "video",
  "image",
  "audio",
  "document",
  "html",
  "text",
  "binary",
]);

export const mediaRemoteSourceSchema: z.ZodType<MediaRemoteSource> = z.object({
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), {
      message: "Asset source URL must use http or https",
    }),
  method: z.literal("GET").optional(),
  headers: stringRecordSchema.optional(),
});

export const mediaAssetDefinitionSchema: z.ZodType<MediaAssetDefinition> = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  kind: z.union([
    mediaKindSchema,
    z.literal("subtitle"),
    z.literal("caption"),
    z.literal("poster"),
    z.literal("thumbnail"),
  ]),
  version: z.string().min(1).optional(),
  mimeType: z.string().optional(),
  fileName: z.string().min(1).optional(),
  byteLength: z.number().nonnegative().optional(),
  source: mediaRemoteSourceSchema,
  metadata: jsonObjectSchema.optional(),
});

export const mediaContentDefinitionSchema: z.ZodType<MediaContentDefinition | ManifestItem> =
  z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    kind: mediaKindSchema,
    title: z.string().optional(),
    description: z.string().optional(),
    summary: z.string().optional(),
    blobs: stringRecordSchema.optional(),
    metadata: jsonObjectSchema.optional(),
    assets: z.array(mediaAssetDefinitionSchema),
  });

export const mediaNamespaceDefinitionSchema: z.ZodType<MediaNamespaceDefinition> = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  metadata: jsonObjectSchema.optional(),
  items: z.array(mediaContentDefinitionSchema),
});

export const mediaCacheManifestSchema: z.ZodType<MediaCacheManifest> = z.object({
  snapshotId: z.string().optional(),
  retrievedAt: z.string().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  namespaces: z.array(mediaNamespaceDefinitionSchema),
});

const mediaCacheAppPathSchema: z.ZodType<MediaCacheAppPath> = z.enum([
  "home",
  "appData",
  "userData",
  "sessionData",
  "temp",
  "exe",
  "module",
  "desktop",
  "documents",
  "downloads",
  "music",
  "pictures",
  "videos",
  "recent",
  "logs",
  "crashDumps",
]);

const storagePathSegmentSchema = z
  .string()
  .min(1)
  .refine((segment) => !/[/\\]/.test(segment), {
    message: "Storage path segments must not contain path separators",
  })
  .refine((segment) => segment !== "." && segment !== "..", {
    message: 'Storage path segments must not be "." or ".."',
  });

export const mediaCacheStoragePathSchema: z.ZodType<MediaCacheStoragePath> = z.object({
  appPath: mediaCacheAppPathSchema,
  segments: z.array(storagePathSegmentSchema).optional(),
});

export const statusSnapshotRowSchema = z.object({
  status_json: z.string(),
});

export const syncRunRowSchema = z.object({
  id: nonNegativeIntegerSchema,
  started_at_ms: nonNegativeIntegerSchema,
  finished_at_ms: nonNegativeIntegerSchema.nullable(),
  status: z.enum(["running", "success", "error"]),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  stats_json: z.string(),
});

export const syncRunIdRowSchema = z.object({
  id: nonNegativeIntegerSchema,
});

export const generationIdRowSchema = z.object({
  id: nonNegativeIntegerSchema,
});

export const activeGenerationRowSchema = z.object({
  generation_id: nonNegativeIntegerSchema,
});

export const generationAssetKeyRowSchema = z.object({
  namespaceKey: z.string(),
  itemId: z.string(),
  assetId: z.string(),
});

export const activeAssetRowSchema: z.ZodType<ActiveAssetRow> = z.object({
  generationId: nonNegativeIntegerSchema,
  namespace: z.string(),
  namespaceOrder: nonNegativeIntegerSchema,
  itemId: z.string(),
  itemVersion: z.string(),
  itemKind: mediaKindSchema,
  itemTitle: z.string().nullable(),
  itemDescription: z.string().nullable(),
  itemSummary: z.string().nullable(),
  itemBlobsJson: z.string(),
  itemMetadataJson: z.string(),
  itemOrder: nonNegativeIntegerSchema,
  assetId: z.string(),
  assetRole: z.string(),
  assetKind: z.string(),
  mimeType: z.string().nullable(),
  byteLength: nonNegativeNumberSchema.nullable(),
  assetMetadataJson: z.string(),
  relativePath: z.string().nullable(),
  sourceJson: z.string(),
  fileStem: z.string(),
});

export const pendingDeletionSchema: z.ZodType<PendingDeletion> = z.object({
  deletionKey: z.string(),
  logicalKey: z.string(),
  relativePath: z.string(),
});

export const assetPathRowSchema = z.object({
  relative_path: z.string().nullable(),
});

export const protocolAssetTargetRowSchema = z.object({
  relative_path: z.string().nullable(),
});

export const fileStemRowSchema = z.object({
  namespace: z.string(),
  itemId: z.string(),
  assetId: z.string(),
});

const optionalNonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((value) => value ?? undefined);

const optionalStringSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);

export const paginationInputSchema = z.object({
  limit: optionalNonNegativeIntegerSchema,
  cursor: optionalStringSchema,
});

export const findByFileStemOptionsSchema = paginationInputSchema.extend({
  namespace: optionalStringSchema,
});

export const optionalPaginationInputSchema = paginationInputSchema
  .nullish()
  .transform((value) => value ?? undefined);

export const optionalFindByFileStemOptionsSchema = findByFileStemOptionsSchema
  .nullish()
  .transform((value) => value ?? undefined);

export const cursorPayloadSchema = z.object({
  index: z.number().int().nonnegative(),
});

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  throw new DataValidationError(`Invalid ${context}: ${formatZodIssues(result.error)}`, {
    cause: result.error,
  });
}

export function parseJsonWithSchema<T>(rawJson: string, schema: z.ZodType<T>, context: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new DataValidationError(`Invalid ${context}: failed to parse JSON.`, {
      cause: error,
    });
  }

  return parseWithSchema(schema, parsed, context);
}

export function stringifyWithSchema<T>(
  value: unknown,
  schema: z.ZodType<T>,
  context: string,
): string {
  let rawJson: string | undefined;
  try {
    rawJson = JSON.stringify(value);
  } catch (error) {
    throw new DataValidationError(`Invalid ${context}: value is not JSON serializable.`, {
      cause: error,
    });
  }
  if (rawJson === undefined) {
    throw new DataValidationError(`Invalid ${context}: value is not JSON serializable.`);
  }

  // Validate the serialized JSON round-trip, but preserve the original JSON.stringify output so
  // optional-field semantics stay intact (for example, undefined object properties are omitted).
  parseJsonWithSchema(rawJson, schema, context);
  return rawJson;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
