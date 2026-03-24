import { app, BrowserWindow } from "electron";
import { appendFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMediaCache,
  registerMediaCacheProtocolSchemes,
  type MediaCacheLogEvent,
} from "@rockhallweb/electron-offline-content/main";
import { createExampleProfile, type ExampleClientConfig } from "./example-content.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFormat = "json" | "pretty";
type RuntimeConfig = {
  profile?: "local" | "nasa";
  logFormat?: LogFormat;
  logLevel?: LogLevel;
  devPassthrough?: boolean;
  assetBaseUrl?: string | null;
};

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const cliArgs = process.argv.slice(1);
const smokeTracePath = join(tmpdir(), "rockhallweb-electron-offline-content-example-smoke.log");
const smokeSentinelPath =
  process.env.MEDIA_CACHE_SMOKE_SENTINEL ?? readArgValue("media-cache-smoke-sentinel");
const runtimeConfig = readRuntimeConfig();
const selectedProfile =
  runtimeConfig?.profile ??
  process.env.MEDIA_CACHE_EXAMPLE_PROFILE ??
  readArgValue("media-cache-example-profile");
const selectedLogFormat =
  runtimeConfig?.logFormat ??
  normalizeLogFormat(process.env.MEDIA_CACHE_LOG_FORMAT) ??
  normalizeLogFormat(readArgValue("media-cache-log-format")) ??
  "json";
const selectedLogLevel =
  runtimeConfig?.logLevel ??
  normalizeLogLevel(process.env.MEDIA_CACHE_LOG_LEVEL) ??
  normalizeLogLevel(readArgValue("media-cache-log-level")) ??
  "info";
const selectedDevPassthrough =
  runtimeConfig?.devPassthrough ??
  normalizeBoolean(process.env.MEDIA_CACHE_DEV_PASSTHROUGH) ??
  normalizeBoolean(readArgValue("media-cache-dev-passthrough"));
const selectedAssetBaseUrl =
  runtimeConfig?.assetBaseUrl ??
  readOptionalEnv("MEDIA_CACHE_ASSET_BASE_URL") ??
  readArgValue("media-cache-asset-base-url");
const effectiveDevPassthrough = selectedDevPassthrough ?? false;
const rendererUrl =
  process.env.MEDIA_CACHE_RENDERER_URL ?? readArgValue("media-cache-renderer-url");
const rendererIndex =
  process.env.MEDIA_CACHE_RENDERER_INDEX ?? readArgValue("media-cache-renderer-index");
const isSmoke = process.env.MEDIA_CACHE_SMOKE === "1" || hasArg("media-cache-smoke");
const logger = createLogger({
  level: selectedLogLevel,
  format: selectedLogFormat,
});

traceSmoke(
  `module-loaded isSmoke=${String(isSmoke)} profile=${String(selectedProfile)} sentinel=${String(
    smokeSentinelPath,
  )} argv=${JSON.stringify(cliArgs)}`,
);
logger.info("example_bootstrap_detected", {
  is_smoke: isSmoke,
  selected_profile: selectedProfile ?? "local",
  runtime_config_profile: runtimeConfig?.profile ?? null,
  runtime_config_log_format: runtimeConfig?.logFormat ?? null,
  runtime_config_log_level: runtimeConfig?.logLevel ?? null,
  runtime_config_dev_passthrough: runtimeConfig?.devPassthrough ?? null,
  runtime_config_asset_base_url: runtimeConfig?.assetBaseUrl ?? null,
  selected_log_format: selectedLogFormat,
  selected_log_level: selectedLogLevel,
  selected_dev_passthrough: selectedDevPassthrough ?? null,
  effective_dev_passthrough: effectiveDevPassthrough,
  selected_asset_base_url: selectedAssetBaseUrl ?? null,
  renderer_url: rendererUrl ?? null,
  renderer_index: rendererIndex ?? null,
});

process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { message: String(error) });
  void failSmoke(`uncaughtException: ${String(error)}`, 1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { reason: String(reason) });
  void failSmoke(`unhandledRejection: ${String(reason)}`, 1);
});

void bootstrap().catch((error) => {
  logger.error("bootstrap_failed", { message: String(error) });
  void failSmoke(`bootstrap: ${String(error)}`, 1);
});

async function bootstrap() {
  traceSmoke("bootstrap:start");
  logger.info("bootstrap_started", {});
  if (!effectiveDevPassthrough) {
    await registerMediaCacheProtocolSchemes();
    traceSmoke("bootstrap:registered-schemes");
    logger.debug("protocol_schemes_registered", {});
  } else {
    logger.info("direct_dev_asset_urls_enabled", {
      asset_base_url: selectedAssetBaseUrl ?? null,
    });
  }

  const profileName = selectedProfile === "nasa" ? "nasa" : "local";
  const exampleProfile = await createExampleProfile(profileName);
  traceSmoke(`bootstrap:profile=${profileName}`);
  logger.info("example_profile_resolved", {
    profile: profileName,
    root_namespace: exampleProfile.clientConfig.rootNamespace,
    item_namespace: exampleProfile.clientConfig.itemLookup.namespace,
    item_id: exampleProfile.clientConfig.itemLookup.itemId,
    file_stem: exampleProfile.clientConfig.fileStem,
  });

  process.env.MEDIA_CACHE_EXAMPLE_ROOT_NAMESPACE = exampleProfile.clientConfig.rootNamespace;
  process.env.MEDIA_CACHE_EXAMPLE_ITEM_NAMESPACE = exampleProfile.clientConfig.itemLookup.namespace;
  process.env.MEDIA_CACHE_EXAMPLE_ITEM_ID = exampleProfile.clientConfig.itemLookup.itemId;
  process.env.MEDIA_CACHE_EXAMPLE_FILE_STEM = exampleProfile.clientConfig.fileStem;
  process.env.MEDIA_CACHE_EXAMPLE_NAMESPACE_TREE_PREFIX =
    exampleProfile.clientConfig.namespaceTreePrefix;
  const storageRoot =
    readOptionalEnv("MEDIA_CACHE_STORAGE_ROOT") ??
    join(app.getPath("temp"), "rockhallweb-electron-offline-content-example", profileName);

  const mediaCache = createMediaCache({
    storageRoot,
    devPassthrough: effectiveDevPassthrough,
    assetBaseUrl: effectiveDevPassthrough ? selectedAssetBaseUrl : undefined,
    logLevel: selectedLogLevel,
    onLog: (entry) => {
      logger.forward(entry);
    },
    resolveManifest: exampleProfile.resolveManifest,
  });
  logger.info("media_cache_created", {
    storage_root: storageRoot,
    dev_passthrough: selectedDevPassthrough ?? null,
    effective_dev_passthrough: effectiveDevPassthrough,
    asset_base_url: selectedAssetBaseUrl ?? null,
  });

  let mainWindow: BrowserWindow | null = null;

  app.on("window-all-closed", () => {
    logger.info("window_all_closed", { platform: process.platform });
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    logger.info("before_quit", {});
    void exampleProfile.dispose();
  });

  app.on("activate", () => {
    logger.debug("app_activate", { window_count: BrowserWindow.getAllWindows().length });
    if (BrowserWindow.getAllWindows().length === 0 && !isSmoke) {
      mainWindow = createWindow(exampleProfile.clientConfig);
    }
  });

  await app.whenReady();
  traceSmoke("bootstrap:app-ready");
  logger.info("app_ready", { app_name: app.getName() });
  if (!effectiveDevPassthrough) {
    await mediaCache.registerProtocol();
    traceSmoke("bootstrap:protocol-registered");
    logger.info("media_protocol_registered", {});
  } else {
    logger.info("media_protocol_skipped_for_dev_passthrough", {});
  }
  await mediaCache.attachIpc();
  traceSmoke("bootstrap:ipc-attached");
  logger.info("media_cache_ipc_attached", {});
  logger.info("media_cache_sync_starting", {});
  await mediaCache.start();
  traceSmoke("bootstrap:media-cache-started");
  const postStartStatus = await mediaCache.getStatus();
  logger.info("media_cache_sync_finished", {
    phase: postStartStatus.phase,
    active_generation_id: postStartStatus.activeGenerationId,
    dev_passthrough: selectedDevPassthrough ?? null,
    run_id: postStartStatus.lastRun?.id ?? null,
    run_status: postStartStatus.lastRun?.status ?? null,
    downloaded_assets: postStartStatus.lastRun?.stats.downloadedAssets ?? null,
    skipped_assets: postStartStatus.lastRun?.stats.skippedAssets ?? null,
    bytes_downloaded: postStartStatus.lastRun?.stats.bytesDownloaded ?? null,
    error_code: postStartStatus.error?.code ?? null,
    error_message: postStartStatus.error?.message ?? null,
  });

  mainWindow = createWindow(exampleProfile.clientConfig);
  traceSmoke("bootstrap:window-created");
  logger.info("main_window_created", {
    is_smoke: isSmoke,
    has_renderer_url: Boolean(rendererUrl),
    has_renderer_index: Boolean(rendererIndex),
  });

  if (isSmoke && mainWindow) {
    try {
      traceSmoke("bootstrap:smoke-start");
      logger.info("smoke_checks_started", {});
      const result = await runSmoke(mainWindow, exampleProfile.clientConfig);
      traceSmoke("bootstrap:smoke-success");
      logger.info("smoke_checks_finished", { ok: true });
      await reportSmoke({ ok: true, result });
      await exampleProfile.dispose();
      app.exit(0);
    } catch (error) {
      traceSmoke(`bootstrap:smoke-error=${String(error)}`);
      logger.error("smoke_checks_failed", { message: String(error) });
      await reportSmoke({ ok: false, message: String(error) }, true);
      await exampleProfile.dispose();
      app.exit(1);
    }
  }
}

function createWindow(clientConfig: ExampleClientConfig): BrowserWindow {
  const encodedConfig = Buffer.from(JSON.stringify(clientConfig), "utf8").toString("base64url");
  const window = new BrowserWindow({
    width: 1380,
    height: 920,
    show: !isSmoke,
    backgroundColor: "#0d1116",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--media-cache-example-config=${encodedConfig}`],
    },
  });

  if (rendererUrl) {
    const url = new URL(rendererUrl);
    url.searchParams.set("mediaCacheExampleConfig", encodedConfig);
    void window.loadURL(url.toString());
  } else if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.searchParams.set("mediaCacheExampleConfig", encodedConfig);
    void window.loadURL(url.toString());
  } else if (rendererIndex) {
    void window.loadFile(rendererIndex, {
      query: {
        mediaCacheExampleConfig: encodedConfig,
      },
    });
  } else {
    void window.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
      query: {
        mediaCacheExampleConfig: encodedConfig,
      },
    });
  }

  if (!isSmoke) {
    window.once("ready-to-show", () => {
      logger.info("window_ready_to_show", {});
      window.show();
    });
  }

  if (isSmoke) {
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      logger.error("preload_error", { preload_path: preloadPath, message: String(error) });
      traceSmoke(`preload-error path=${preloadPath} error=${String(error)}`);
    });
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      logger.warn("window_failed_load", { code, description, url });
      traceSmoke(`did-fail-load code=${String(code)} description=${description} url=${url}`);
    });
    window.webContents.on("did-finish-load", () => {
      logger.debug("window_finished_load", {});
      traceSmoke("did-finish-load");
    });
    window.webContents.on("console-message", (_event, level, message) => {
      logger.debug("renderer_console_message", { level, message });
      traceSmoke(`console-message level=${String(level)} message=${message}`);
    });
  }

  return window;
}

async function runSmoke(window: BrowserWindow, config: ExampleClientConfig) {
  await waitForWindowLoad(window);

  const result = await window.webContents.executeJavaScript(
    `(${rendererSmokeCheck.toString()})(${JSON.stringify(config)})`,
    true,
  );

  if (!result.ok) {
    throw new Error(result.reason ?? "Unknown smoke failure.");
  }

  return result;
}

async function waitForWindowLoad(window: BrowserWindow): Promise<void> {
  if (window.webContents.isLoadingMainFrame()) {
    await new Promise<void>((resolve) => {
      window.webContents.once("did-finish-load", () => resolve());
    });
  }
}

async function rendererSmokeCheck(config: ExampleClientConfig) {
  const bridge = window.mediaCache;
  if (!bridge) {
    return { ok: false, reason: "preload bridge missing" };
  }

  const startedAt = Date.now();
  let status = await bridge.getStatus();
  while (Date.now() - startedAt < 20_000 && status.phase !== "ready" && status.phase !== "error") {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = await bridge.getStatus();
  }

  if (status.phase !== "ready") {
    return { ok: false, reason: `status phase ${status.phase}` };
  }

  const namespace = await bridge.listNamespace(config.rootNamespace, { limit: 10 });
  const tree = await bridge.listNamespaceTree(config.namespaceTreePrefix, { limit: 10 });
  const item = await bridge.getItem(config.itemLookup.namespace, config.itemLookup.itemId);
  const fileStem = await bridge.findByFileStem(config.fileStem, { limit: 10 });

  const checks = [
    namespace.items.length > 0,
    tree.items.length >= namespace.items.length,
    Boolean(item?.assets.some((asset) => asset.url.startsWith("media://"))),
    fileStem.items.some((entry) => entry.matchedAssetIds.length > 0),
  ];

  return {
    ok: checks.every(Boolean),
    status,
    namespaceIds: namespace.items.map((entry) => `${entry.namespace}/${entry.id}`),
    treeIds: tree.items.map((entry) => `${entry.namespace}/${entry.id}`),
    itemUrl: item?.assets[0]?.url ?? null,
    matchedAssetIds: fileStem.items[0]?.matchedAssetIds ?? [],
  };
}

async function failSmoke(message: string, exitCode: number): Promise<void> {
  traceSmoke(`failSmoke: ${message}`);
  logger.error("smoke_failed", { message, exit_code: exitCode });
  await reportSmoke({ ok: false, message }, true);
  if (!app.isReady()) {
    app.exit(exitCode);
    return;
  }
  app.exit(exitCode);
}

async function reportSmoke(
  payload: { ok: true; result: unknown } | { ok: false; message: string },
  useStderr = false,
): Promise<void> {
  const serialized = `${JSON.stringify(payload)}\n`;
  if (useStderr) {
    process.stderr.write(serialized);
  } else {
    process.stdout.write(serialized);
  }
  traceSmoke(`reportSmoke:${serialized.trim()}`);
  if (smokeSentinelPath) {
    await writeFile(smokeSentinelPath, serialized);
  }
}

function hasArg(flag: string): boolean {
  return cliArgs.includes(`--${flag}`);
}

function readArgValue(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const match = cliArgs.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

function traceSmoke(message: string): void {
  if (!isSmoke && !smokeSentinelPath && process.env.MEDIA_CACHE_DEBUG !== "1") {
    return;
  }
  appendFileSync(smokeTracePath, `[${new Date().toISOString()}] ${message}\n`);
}

function readRuntimeConfig(): RuntimeConfig | null {
  try {
    const payload = readFileSync(join(process.cwd(), ".runtime", "example-config.json"), "utf8");
    return JSON.parse(payload) as RuntimeConfig;
  } catch {
    return null;
  }
}

function createLogger(options: { level: LogLevel; format: LogFormat }) {
  const threshold = LOG_LEVEL_WEIGHT[options.level];
  const service = "rockhallweb-electron-offline-content-example";
  const environment = app.isPackaged ? "prod" : "dev";

  return {
    debug: (event: string, fields: Record<string, unknown>) =>
      writeLog("debug", event, fields, threshold, service, environment, options.format),
    info: (event: string, fields: Record<string, unknown>) =>
      writeLog("info", event, fields, threshold, service, environment, options.format),
    warn: (event: string, fields: Record<string, unknown>) =>
      writeLog("warn", event, fields, threshold, service, environment, options.format),
    error: (event: string, fields: Record<string, unknown>) =>
      writeLog("error", event, fields, threshold, service, environment, options.format),
    forward: (entry: MediaCacheLogEvent) => writeStructuredLog(entry, threshold, options.format),
  };
}

function normalizeLogLevel(value?: string): LogLevel | null {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return null;
}

function normalizeLogFormat(value?: string): LogFormat | null {
  if (value === "json" || value === "pretty") {
    return value;
  }
  return null;
}

function normalizeBoolean(value?: string): boolean | undefined {
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return undefined;
}

function writeLog(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown>,
  threshold: number,
  service: string,
  environment: string,
  format: LogFormat,
): void {
  if (LOG_LEVEL_WEIGHT[level] < threshold) {
    return;
  }

  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service,
    environment,
    profile: selectedProfile === "nasa" ? "nasa" : "local",
    is_smoke: isSmoke,
    ...fields,
  };

  const serialized =
    format === "pretty" ? formatPrettyLog(payload, level, event) : JSON.stringify(payload);
  writeSerializedLog(level, serialized);
}

function writeStructuredLog(entry: MediaCacheLogEvent, threshold: number, format: LogFormat): void {
  if (LOG_LEVEL_WEIGHT[entry.level] < threshold) {
    return;
  }

  const serialized =
    format === "pretty" ? formatPrettyLog(entry, entry.level, entry.event) : JSON.stringify(entry);
  writeSerializedLog(entry.level, serialized);
}

function writeSerializedLog(level: LogLevel, serialized: string): void {
  if (level === "error" || level === "warn") {
    process.stderr.write(`${serialized}\n`);
    return;
  }
  process.stdout.write(`${serialized}\n`);
}

function formatPrettyLog(payload: Record<string, unknown>, level: LogLevel, event: string): string {
  const timestamp = String(payload.timestamp ?? new Date().toISOString());
  const context = Object.entries(payload)
    .filter(
      ([key]) =>
        key !== "timestamp" &&
        key !== "level" &&
        key !== "event" &&
        key !== "service" &&
        key !== "environment",
    )
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  const prefix = `${dim(timestamp)} ${colorizeLevel(level)} ${bold(event)}`;
  const suffix = context.length > 0 ? ` ${dim("|")} ${context}` : "";
  return `${prefix}${suffix}`;
}

function formatPrettyValue(value: unknown): string {
  if (value === null) {
    return dim("null");
  }

  if (typeof value === "string") {
    if (value.length === 0) {
      return '""';
    }
    return /\s|=/.test(value) ? JSON.stringify(value) : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function colorizeLevel(level: LogLevel): string {
  switch (level) {
    case "debug":
      return ansi(36, padLevel(level));
    case "info":
      return ansi(32, padLevel(level));
    case "warn":
      return ansi(33, padLevel(level));
    case "error":
      return ansi(31, padLevel(level));
  }
}

function padLevel(level: LogLevel): string {
  return level.toUpperCase().padEnd(5, " ");
}

function dim(value: string): string {
  return ansi(2, value);
}

function bold(value: string): string {
  return ansi(1, value);
}

function ansi(code: number, value: string): string {
  if (!supportsPrettyColors()) {
    return value;
  }
  return `\u001B[${code}m${value}\u001B[0m`;
}

function supportsPrettyColors(): boolean {
  return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}
