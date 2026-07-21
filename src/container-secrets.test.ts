import { execFileSync, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupContainerSecretFiles,
  CONTAINER_SECRET_MOUNT_PATH,
  extractContainerEnvironmentArgs,
  serializeContainerSecrets,
  writeContainerSecretFile,
} from './container-secrets.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-container-secrets-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('extractContainerEnvironmentArgs', () => {
  it('removes Docker environment flags without truncating values containing equals signs', () => {
    const result = extractContainerEnvironmentArgs(
      [
        'run',
        '-e',
        'API_TOKEN=abc=def',
        '--env=SERVICE_URL=https://example.com?a=b',
        '--env',
        'FROM_HOST',
        '--name',
        'test',
      ],
      { FROM_HOST: 'host-value' },
    );

    expect(result.args).toEqual(['run', '--name', 'test']);
    expect(result.env).toEqual({
      API_TOKEN: 'abc=def',
      SERVICE_URL: 'https://example.com?a=b',
      FROM_HOST: 'host-value',
    });
  });

  it('drops an unset name-only environment flag', () => {
    expect(extractContainerEnvironmentArgs(['run', '-e', 'NOT_SET'], {}).args).toEqual(['run']);
  });

  it('rejects malformed environment assignments', () => {
    expect(() => extractContainerEnvironmentArgs(['run', '-e', 'BAD-KEY=value'])).toThrow(
      'Invalid container environment key',
    );
    expect(() => extractContainerEnvironmentArgs(['run', '-e'])).toThrow('-e requires an environment assignment');
  });
});

describe('container secret files', () => {
  it('round-trips shell-sensitive and multiline values without executing them', () => {
    const directory = temporaryDirectory();
    const markerPath = path.join(directory, 'must-not-exist');
    const dangerousValue = `first line
quote ' and dollar $(touch ${markerPath}) $HOME
last line`;
    const filePath = writeContainerSecretFile(
      'nanoclaw-v2-test-123',
      {
        DANGEROUS_VALUE: dangerousValue,
        EMPTY_VALUE: '',
      },
      directory,
    );

    expect(filePath).not.toBeNull();
    expect(fs.statSync(filePath!).mode & 0o777).toBe(0o600);

    const output = execFileSync(
      '/bin/bash',
      [
        '-c',
        'set -euo pipefail; set -a; . "$1"; set +a; printf "%s\\n---\\n%s" "$DANGEROUS_VALUE" "$EMPTY_VALUE"',
        'bash',
        filePath!,
      ],
      { encoding: 'utf8' },
    );
    expect(output).toBe(`${dangerousValue}\n---\n`);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('does not create a file for an empty environment', () => {
    const directory = path.join(temporaryDirectory(), 'secrets');
    expect(writeContainerSecretFile('nanoclaw-v2-test-123', {}, directory)).toBeNull();
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('cleans stale files without removing the secret directory', () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, 'stale.env'), 'secret');
    fs.mkdirSync(path.join(directory, 'stale-dir'));
    fs.writeFileSync(path.join(directory, 'stale-dir', 'value'), 'secret');

    cleanupContainerSecretFiles(directory);

    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('rejects invalid names and NUL bytes', () => {
    expect(() => serializeContainerSecrets({ 'BAD-KEY': 'value' })).toThrow('Invalid container environment key');
    expect(() => serializeContainerSecrets({ VALID_KEY: 'before\0after' })).toThrow('cannot contain NUL bytes');
    expect(() => writeContainerSecretFile('../escape', { VALID_KEY: 'value' }, temporaryDirectory())).toThrow(
      'Invalid container name',
    );
  });

  it.runIf(process.env.NANOCLAW_DOCKER_SECRET_TEST === '1')(
    'loads a read-only bundle without persisting values in Docker metadata',
    () => {
      const directory = temporaryDirectory();
      const secretValue = `sentinel-${randomUUID()}`;
      const containerName = `nanoclaw-secret-test-${process.pid}-${Date.now()}`;
      const filePath = writeContainerSecretFile(containerName, { NANOCLAW_SECRET_SENTINEL: secretValue }, directory)!;
      const image = process.env.NANOCLAW_DOCKER_TEST_IMAGE || 'nanoclaw-agent:latest';
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;

      try {
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '-d',
            '--name',
            containerName,
            '--user',
            `${uid}:${gid}`,
            '-v',
            `${filePath}:${CONTAINER_SECRET_MOUNT_PATH}:ro`,
            '--entrypoint',
            'bash',
            image,
            '-c',
            `set -euo pipefail; set -a; . ${CONTAINER_SECRET_MOUNT_PATH}; set +a; exec sleep 60`,
          ],
          { stdio: 'pipe' },
        );

        const inspected = JSON.parse(execFileSync('docker', ['inspect', containerName], { encoding: 'utf8' }))[0] as {
          Config: { Cmd: string[]; Env: string[] };
          Mounts: Array<{ Destination: string; RW: boolean }>;
        };

        expect(inspected.Config.Env.some((value) => value.startsWith('NANOCLAW_SECRET_SENTINEL='))).toBe(false);
        expect(JSON.stringify(inspected.Config.Cmd)).not.toContain(secretValue);
        expect(inspected.Mounts.find((mount) => mount.Destination === CONTAINER_SECRET_MOUNT_PATH)?.RW).toBe(false);

        execFileSync(
          'docker',
          [
            'exec',
            containerName,
            'node',
            '-e',
            "const fs=require('fs');const env=fs.readFileSync('/proc/1/environ');process.exit(env.includes(Buffer.from('NANOCLAW_SECRET_SENTINEL='))?0:1)",
          ],
          { stdio: 'pipe' },
        );
      } finally {
        spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      }
    },
  );
});
