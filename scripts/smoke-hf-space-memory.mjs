#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { readPositiveIntegerEnv } from './env-utils.mjs';

const imageName = process.env.HF_SPACE_SMOKE_IMAGE || 'visual-journal:hf-space-memory-smoke';
const containerName = process.env.HF_SPACE_SMOKE_CONTAINER || 'visual-journal-hf-space-smoke';
const parsedHostPort = readPositiveIntegerEnv('HF_SPACE_SMOKE_PORT', 4785);
if (parsedHostPort > 65_535) {
  throw new Error('HF_SPACE_SMOKE_PORT must be less than or equal to 65535');
}
const hostPort = String(parsedHostPort);
const token = process.env.HF_SPACE_SMOKE_AGENT_TOKEN || 'hf-space-smoke-token';
const baseUrl = `http://127.0.0.1:${hostPort}`;
const readyTimeoutMs = readPositiveIntegerEnv('HF_SPACE_SMOKE_READY_TIMEOUT_MS', 45_000);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) }
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${output ? `\n${output}` : ''}`);
  }
  return result.stdout || '';
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitForReady() {
  const deadline = Date.now() + readyTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
        }
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw lastError || new Error('container did not become ready');
}

function cleanup() {
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertJsonEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

cleanup();

try {
  run('docker', [
    'build',
    '--build-arg',
    'NEXT_PUBLIC_IMAGE_STORAGE_MODE=indexeddb',
    '-t',
    imageName,
    '.'
  ]);
  run('docker', [
    'run',
    '-d',
    '--name',
    containerName,
    '-p',
    `127.0.0.1:${hostPort}:4783`,
    '-e',
    'AGENT_STATE_BACKEND=memory',
    '-e',
    'AGENT_SQLITE_PATH=',
    '-e',
    'AGENT_DATABASE_URL=',
    '-e',
    'AGENT_DB_PASSWORD=',
    '-e',
    'AGENT_DB_PASSWORD_FILE=',
    '-e',
    'NEXT_PUBLIC_IMAGE_STORAGE_MODE=indexeddb',
    '-e',
    'APP_LOG_LEVEL=warn',
    '-e',
    `AGENT_API_TOKEN=${token}`,
    imageName
  ]);

  await waitForReady();

  const capabilities = await fetchJson('/api/agent/capabilities');
  assertEqual(capabilities.auth?.required, true, 'Agent auth required flag');
  assertJsonEqual(capabilities.auth?.schemes, ['bearer'], 'Agent auth schemes');
  assertEqual(capabilities.defaults?.state_backend, 'memory', 'Agent state backend');
  assertEqual(capabilities.storage?.image_storage_mode, 'indexeddb', 'Image storage mode');
  assertEqual(capabilities.storage?.postgres_configured, false, 'PostgreSQL configured flag');

  const runtime = await fetchJson('/api/runtime-capabilities');
  assertEqual(typeof runtime.streamingBatch?.enabled, 'boolean', 'Runtime capabilities shape');

  run('node', ['skills/visual-journal-image-agent/scripts/generate-image.mjs'], {
    env: {
      GPT_IMAGE_PLAYGROUND_URL: baseUrl,
      GPT_IMAGE_AGENT_TOKEN: token,
      GPT_IMAGE_AGENT_CONTRACT_CHECK: '1'
    }
  });
  run('node', ['skills/visual-journal-image-agent/scripts/edit-image.mjs'], {
    env: {
      GPT_IMAGE_PLAYGROUND_URL: baseUrl,
      GPT_IMAGE_AGENT_TOKEN: token,
      GPT_IMAGE_AGENT_CONTRACT_CHECK: '1'
    }
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        state_backend: capabilities.defaults.state_backend,
        image_storage_mode: capabilities.storage.image_storage_mode,
        agent_contract_check: true
      },
      null,
      2
    )
  );
} finally {
  cleanup();
}
