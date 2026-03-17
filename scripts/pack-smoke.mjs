import { mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const exampleDir = join(repoRoot, 'examples', 'electron-react');

const workspaceTmp = await mkdtemp(join(tmpdir(), 'media-cache-pack-smoke-'));
const packDir = join(workspaceTmp, 'pack');
const copiedExampleDir = join(workspaceTmp, 'example');
const smokeSentinel = join(workspaceTmp, 'smoke-result.json');
const smokeStorageRoot = join(workspaceTmp, 'cache');

await run('pnpm', ['pack', '--pack-destination', packDir], {
  cwd: repoRoot,
  env: process.env,
});

const tarball = (await listDir(packDir)).find((file) => file.endsWith('.tgz'));
if (!tarball) {
  throw new Error('pnpm pack did not produce a tarball.');
}

await cp(exampleDir, copiedExampleDir, {
  recursive: true,
  filter(source) {
    return !source.includes('node_modules') && !source.includes('.vite') && !source.includes('out');
  },
});

await writeFile(
  join(copiedExampleDir, '.npmrc'),
  'node-linker=hoisted\n',
);

const packageJsonPath = join(copiedExampleDir, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
packageJson.dependencies['@rockhallweb/electron-offline-content'] = join(packDir, tarball);
packageJson.pnpm = {
  ...(packageJson.pnpm ?? {}),
  onlyBuiltDependencies: ['electron', 'esbuild'],
};
await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

await run('pnpm', ['install', '--ignore-scripts=false'], {
  cwd: copiedExampleDir,
  env: process.env,
});

await run('pnpm', ['run', 'smoke'], {
  cwd: copiedExampleDir,
  env: {
    ...process.env,
    MEDIA_CACHE_EXAMPLE_PROFILE: 'local',
    MEDIA_CACHE_SMOKE_SENTINEL: smokeSentinel,
    MEDIA_CACHE_STORAGE_ROOT: smokeStorageRoot,
  },
});

await waitForFile(smokeSentinel, 30_000);
const smokePayload = JSON.parse(await readFile(smokeSentinel, 'utf8'));
process.stdout.write(`MEDIA_CACHE_PACK_SMOKE_RESULT ${JSON.stringify(smokePayload)}\n`);
if (!smokePayload.ok) {
  throw new Error('Packed smoke run reported failure.');
}

await rm(workspaceTmp, { recursive: true, force: true });

async function listDir(path) {
  const { readdir } = await import('node:fs/promises');
  return readdir(path);
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code ?? 'unknown'}.`));
      }
    });
  });
}

async function waitForFile(path, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await readFile(path, 'utf8');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Timed out waiting for smoke sentinel at ${path}.`);
}
