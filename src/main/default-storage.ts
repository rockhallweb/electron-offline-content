import { homedir } from 'node:os';
import { join } from 'node:path';

export async function defaultStorageRoot(): Promise<string> {
  const appName = await getAppName();

  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Caches', appName, 'media-cache');
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
      return join(localAppData, appName, 'media-cache');
    }
    default: {
      const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
      return join(cacheHome, appName, 'media-cache');
    }
  }
}

async function getAppName(): Promise<string> {
  try {
    const electron = await import('electron');
    return sanitizeName(electron.app.getName());
  } catch {
    return 'electron-offline-content';
  }
}

function sanitizeName(name: string): string {
  return (
    name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'electron-offline-content'
  );
}
