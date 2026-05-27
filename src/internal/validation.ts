import { DataValidationError } from "../shared/errors.js";
import type { ActiveAssetRow, GenerationAssetRow, PendingDeletion } from "../main/database.js";
import type {
  JsonValue,
  MediaCacheAppPath,
  MediaCacheStatus,
  MediaCacheStoragePath,
  MediaKind,
  PaginationInput,
  SerializedMediaCacheError,
  SyncProgress,
  SyncRunStats,
  SyncRunSummary,
} from "../shared/types.js";

interface ValidationIssue {
  path: string;
  message: string;
}

class ValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(formatValidationIssues(issues));
    this.name = "ValidationError";
  }
}

export interface Schema<T> {
  parse(value: unknown, path?: string): T;
  array(): Schema<T[]>;
}

class Validator<T> implements Schema<T> {
  constructor(private readonly parser: (value: unknown, path: string) => T) {}

  parse(value: unknown, path = "(root)"): T {
    return this.parser(value, path);
  }

  array(): Schema<T[]> {
    return array(this);
  }
}

const makeSchema = <T>(parser: (value: unknown, path: string) => T): Schema<T> =>
  new Validator(parser);

const nonNegativeIntegerSchema = makeSchema((value, path) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw issue(path, "Expected non-negative integer");
  }
  return value;
});

const nonNegativeNumberSchema = makeSchema((value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw issue(path, "Expected non-negative number");
  }
  return value;
});

const stringSchema = makeSchema((value, path) => {
  if (typeof value !== "string") {
    throw issue(path, "Expected string");
  }
  return value;
});

const nullable = <T>(schema: Schema<T>): Schema<T | null> =>
  makeSchema((value, path) => (value === null ? null : schema.parse(value, path)));

const optional = <T>(schema: Schema<T>): Schema<T | undefined> =>
  makeSchema((value, path) => (value === undefined ? undefined : schema.parse(value, path)));

const nullishToUndefined = <T>(schema: Schema<T>): Schema<T | undefined> =>
  makeSchema((value, path) =>
    value === null || value === undefined ? undefined : schema.parse(value, path),
  );

const array = <T>(schema: Schema<T>): Schema<T[]> =>
  makeSchema((value, path) => {
    if (!Array.isArray(value)) {
      throw issue(path, "Expected array");
    }
    const issues: ValidationIssue[] = [];
    const parsed: T[] = [];
    for (const [index, item] of value.entries()) {
      try {
        parsed[index] = schema.parse(item, `${path}.${index}`);
      } catch (error) {
        collectValidationIssues(error, issues);
      }
    }
    throwIfIssues(issues);
    return parsed;
  });

const object = <T extends object>(shape: { [K in keyof T]: Schema<T[K]> }): Schema<T> =>
  makeSchema((value, path) => {
    const record = expectRecord(value, path);
    const issues: ValidationIssue[] = [];
    const parsed = {} as T;
    for (const key of Object.keys(shape) as (keyof T)[]) {
      try {
        parsed[key] = shape[key].parse(record[key as string], joinPath(path, key as string));
      } catch (error) {
        collectValidationIssues(error, issues);
      }
    }
    throwIfIssues(issues);
    return parsed;
  });

const record = <T>(schema: Schema<T>): Schema<Record<string, T>> =>
  makeSchema((value, path) => {
    const input = expectRecord(value, path);
    const issues: ValidationIssue[] = [];
    const parsed = Object.create(null) as Record<string, T>;
    for (const [key, item] of Object.entries(input)) {
      try {
        parsed[key] = schema.parse(item, joinPath(path, key));
      } catch (error) {
        collectValidationIssues(error, issues);
      }
    }
    throwIfIssues(issues);
    return parsed;
  });

const oneOf = <T extends string>(values: readonly T[]): Schema<T> =>
  makeSchema((value, path) => {
    if (typeof value !== "string" || !values.includes(value as T)) {
      throw issue(path, `Expected one of: ${values.join(", ")}`);
    }
    return value as T;
  });

/**
 * Schema for IPC/API string identifiers: asset key, index name, index value, file stem.
 * Enforces min 1 and max 2000 characters.
 */
export const stringInputSchema = makeSchema((value, path) => {
  const parsed = stringSchema.parse(value, path);
  if (parsed.length < 1) {
    throw issue(path, "Expected string to contain at least 1 character");
  }
  if (parsed.length > 2000) {
    throw issue(path, "Expected string to contain at most 2000 characters");
  }
  return parsed;
});

export const jsonValueSchema: Schema<JsonValue> = makeSchema((value, path): JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return array(jsonValueSchema).parse(value, path);
  }
  if (isPlainRecord(value)) {
    return record(jsonValueSchema).parse(value, path);
  }
  throw issue(path, "Expected JSON value");
});

export const jsonObjectSchema: Schema<Record<string, JsonValue>> = record(jsonValueSchema);

export const stringRecordSchema = record(stringSchema);

export const serializedMediaCacheErrorSchema: Schema<SerializedMediaCacheError> = object({
  name: stringSchema,
  code: stringSchema,
  message: stringSchema,
});

export const syncRunStatsSchema: Schema<SyncRunStats> = object({
  totalAssets: nonNegativeIntegerSchema,
  downloadedAssets: nonNegativeIntegerSchema,
  skippedAssets: nonNegativeIntegerSchema,
  bytesDownloaded: nonNegativeNumberSchema,
});

const syncPhaseSchema: Schema<SyncProgress["phase"]> = oneOf([
  "resolving-store",
  "staging-generation",
  "diffing",
  "downloading",
  "committing",
  "pruning",
]);

export const syncProgressSchema: Schema<SyncProgress> = object({
  runId: nonNegativeIntegerSchema,
  phase: syncPhaseSchema,
  totalAssets: nonNegativeIntegerSchema,
  completedAssets: nonNegativeIntegerSchema,
  downloadedAssets: nonNegativeIntegerSchema,
  skippedAssets: nonNegativeIntegerSchema,
  bytesDownloaded: nonNegativeNumberSchema,
});

export const syncRunSummarySchema: Schema<SyncRunSummary> = object({
  id: nonNegativeIntegerSchema,
  status: oneOf(["running", "success", "error"] as const),
  startedAt: nonNegativeIntegerSchema,
  finishedAt: nullable(nonNegativeIntegerSchema),
  errorCode: nullable(stringSchema),
  errorMessage: nullable(stringSchema),
  stats: syncRunStatsSchema,
});

export const mediaCacheStatusSchema: Schema<MediaCacheStatus> = makeSchema((value, path) => {
  const parsed = object<MediaCacheStatus>({
    phase: oneOf(["idle", "syncing", "ready", "error"]),
    storageRoot: makeSchema((fieldValue, fieldPath) =>
      fieldValue === undefined ? null : nullable(stringSchema).parse(fieldValue, fieldPath),
    ),
    activeGenerationId: nullable(nonNegativeIntegerSchema),
    progress: nullable(syncProgressSchema),
    lastRun: nullable(syncRunSummarySchema),
    error: nullable(serializedMediaCacheErrorSchema),
    updatedAt: nonNegativeIntegerSchema,
  }).parse(value, path);
  return parsed;
});

const mediaKindSchema: Schema<MediaKind> = oneOf([
  "video",
  "image",
  "audio",
  "document",
  "html",
  "text",
  "binary",
]);

const mediaCacheAppPathSchema: Schema<MediaCacheAppPath> = oneOf([
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

const storagePathSegmentSchema = makeSchema((value, path) => {
  const segment = stringSchema.parse(value, path);
  if (segment.length < 1) {
    throw issue(path, "Expected string to contain at least 1 character");
  }
  if (/[/\\]/.test(segment)) {
    throw issue(path, "Storage path segments must not contain path separators");
  }
  if (segment === "." || segment === "..") {
    throw issue(path, 'Storage path segments must not be "." or ".."');
  }
  return segment;
});

export const mediaCacheStoragePathSchema: Schema<MediaCacheStoragePath> = object({
  appPath: mediaCacheAppPathSchema,
  segments: optional(array(storagePathSegmentSchema)),
});

export const statusSnapshotRowSchema = object({
  status_json: stringSchema,
});

export const syncRunRowSchema = object({
  id: nonNegativeIntegerSchema,
  started_at_ms: nonNegativeIntegerSchema,
  finished_at_ms: nullable(nonNegativeIntegerSchema),
  status: oneOf(["running", "success", "error"] as const),
  error_code: nullable(stringSchema),
  error_message: nullable(stringSchema),
  stats_json: stringSchema,
});

export const syncRunIdRowSchema = object({
  id: nonNegativeIntegerSchema,
});

export const generationIdRowSchema = object({
  id: nonNegativeIntegerSchema,
});

export const activeGenerationRowSchema = object({
  generation_id: nonNegativeIntegerSchema,
});

/** Row shape from getGenerationAssets used during sync diffing. */
export const generationAssetRowSchema: Schema<GenerationAssetRow> = object({
  assetKey: stringSchema,
  version: stringSchema,
  relativePath: nullable(stringSchema),
  mimeType: stringSchema,
  url: stringSchema,
});

/** Row shape for a fully joined active asset used for queries. */
export const activeAssetRowSchema: Schema<ActiveAssetRow> = object({
  generationId: nonNegativeIntegerSchema,
  assetKey: stringSchema,
  displayKey: stringSchema,
  version: stringSchema,
  mimeType: stringSchema,
  mediaKind: mediaKindSchema,
  byteLength: nullable(nonNegativeNumberSchema),
  metadata: stringSchema,
  indexesJson: stringSchema,
  relativePath: nullable(stringSchema),
  url: stringSchema,
  fileStem: stringSchema,
  orderIndex: nonNegativeIntegerSchema,
});

export const pendingDeletionSchema: Schema<PendingDeletion> = object({
  deletionKey: stringSchema,
  logicalKey: stringSchema,
  relativePath: stringSchema,
});

export const protocolAssetTargetRowSchema = object({
  relative_path: nullable(stringSchema),
});

export const fileStemRowSchema = object({
  assetKey: stringSchema,
});

const optionalNonNegativeIntegerSchema = nullishToUndefined(nonNegativeIntegerSchema);

const optionalStringSchema = nullishToUndefined(stringSchema);

export const paginationInputSchema: Schema<PaginationInput> = object({
  limit: optionalNonNegativeIntegerSchema,
  cursor: optionalStringSchema,
});

export const optionalPaginationInputSchema = nullishToUndefined(paginationInputSchema);

export const cursorPayloadSchema = object({
  index: nonNegativeIntegerSchema,
});

export function parseWithSchema<T>(schema: Schema<T>, value: unknown, context: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new DataValidationError(`Invalid ${context}: ${formatValidationIssues(error.issues)}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export function parseJsonWithSchema<T>(rawJson: string, schema: Schema<T>, context: string): T {
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

export function stringifyWithSchema<T>(value: unknown, schema: Schema<T>, context: string): string {
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

  parseJsonWithSchema(rawJson, schema, context);
  return rawJson;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw issue(path, "Expected object");
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinPath(base: string, key: string): string {
  return base === "(root)" ? key : `${base}.${key}`;
}

function issue(path: string, message: string): ValidationError {
  return new ValidationError([{ path, message }]);
}

function collectValidationIssues(error: unknown, issues: ValidationIssue[]): never | void {
  if (error instanceof ValidationError) {
    issues.push(...error.issues);
    return;
  }
  throw error;
}

function throwIfIssues(issues: ValidationIssue[]): void {
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
}

function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues
    .map((validationIssue) => `${validationIssue.path}: ${validationIssue.message}`)
    .join("; ");
}
