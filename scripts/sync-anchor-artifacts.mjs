#!/usr/bin/env node

import { copyFile, mkdir, readFile, access, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

const root = process.cwd();
const sourceIdl = path.join(root, 'target', 'idl', 'agenc_coordination.json');
const sourceTypes = path.join(root, 'target', 'types', 'agenc_coordination.ts');
const destIdl = path.join(root, 'artifacts', 'anchor', 'idl', 'agenc_coordination.json');
const destTypes = path.join(root, 'artifacts', 'anchor', 'types', 'agenc_coordination.ts');
const manifestPath = path.join(root, 'artifacts', 'anchor', 'manifest.json');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readUtf8(filePath) {
  return readFile(filePath, 'utf8');
}

async function writeManifest(idlContent, typeContent) {
  const idl = JSON.parse(idlContent);
  const manifest = {
    program: {
      name: idl.metadata?.name ?? 'agenc_coordination',
      address: idl.address,
      version: idl.metadata?.version ?? null,
      spec: idl.metadata?.spec ?? null,
    },
    artifacts: {
      idl: {
        path: 'artifacts/anchor/idl/agenc_coordination.json',
        sha256: sha256(idlContent),
      },
      types: {
        path: 'artifacts/anchor/types/agenc_coordination.ts',
        sha256: sha256(typeContent),
      },
      verifierRouterIdl: {
        path: 'scripts/idl/verifier_router.json',
      },
    },
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function refresh() {
  if (!(await exists(sourceIdl)) || !(await exists(sourceTypes))) {
    throw new Error(
      'Missing Anchor build artifacts in target/idl or target/types. Run "anchor build" first.',
    );
  }

  await mkdir(path.dirname(destIdl), { recursive: true });
  await mkdir(path.dirname(destTypes), { recursive: true });

  await copyFile(sourceIdl, destIdl);
  await copyFile(sourceTypes, destTypes);

  const [idlContent, typeContent] = await Promise.all([readUtf8(destIdl), readUtf8(destTypes)]);
  await writeManifest(idlContent, typeContent);

  process.stdout.write('Protocol artifacts refreshed.\n');
}

async function check() {
  if (!(await exists(destIdl)) || !(await exists(destTypes))) {
    throw new Error('Committed protocol artifacts are missing. Run "npm run artifacts:refresh".');
  }

  if (!(await exists(sourceIdl)) || !(await exists(sourceTypes))) {
    process.stdout.write(
      'Anchor build artifacts not present; verified committed protocol artifacts exist.\n',
    );
    return;
  }

  const [sourceIdlContent, sourceTypeContent, committedIdlContent, committedTypeContent] =
    await Promise.all([
      readUtf8(sourceIdl),
      readUtf8(sourceTypes),
      readUtf8(destIdl),
      readUtf8(destTypes),
    ]);

  if (sourceIdlContent !== committedIdlContent || sourceTypeContent !== committedTypeContent) {
    throw new Error('Committed protocol artifacts are stale. Run "npm run artifacts:refresh".');
  }

  await writeManifest(committedIdlContent, committedTypeContent);
  process.stdout.write('Committed protocol artifacts match the current Anchor build.\n');
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    await check();
    return;
  }

  await refresh();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

