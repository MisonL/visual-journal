import { buildAgentDoctorArgs, buildAgentDoctorContractArgs } from './agent-doctor.mjs';
import {
    buildAbsentReport,
    buildSkippedReport,
    hasLegacyFixtureRepoMount,
    parseDockerInspectContainer,
    summarizeDockerMounts
} from './cleanup-docker-fixtures.mjs';
import { fetchJsonWithTimeout, parseJsonPayload, pickFailureOutput, runCommand } from './command-center-utils.mjs';
import {
    assertDeploymentImageIdentity,
    assertComposeImageAutoCleanupDeploymentAllowed,
    assertImageAutoCleanupDeploymentAllowed,
    assertLocalProbeMatchesMode,
    buildDeploymentImageReference,
    buildDeploymentImageTag,
    buildDockerComposeArgs,
    buildDockerComposeEnv,
    buildLocalBaseUrl,
    isImageAutoCleanupEnabled,
    parsePublishedContainerPortBindings,
    readImageAutoCleanupValueFromComposeEnvFile,
    waitForLocalEndpoints
} from './deploy-local.mjs';
import { buildFirstRunReport, formatFirstRunText } from './first-run.mjs';
import {
    buildAdminCommands,
    buildImageUpstreamLocalEndpointStatus,
    buildImageUpstreamRealSmokeStatus,
    parseGitStatusEntries,
    readStatusEnvFromFiles,
    readRemoteStatusFromResult
} from './status.mjs';
import { buildVerifyPlan } from './verify.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const deployLocalScriptPath = fileURLToPath(new URL('./deploy-local.mjs', import.meta.url));

describe('Command center scripts', () => {
    it('exposes a small stable administrator command set', () => {
        assert.deepEqual(buildAdminCommands(), {
            first_run: 'npm run first-run',
            doctor: 'npm run doctor',
            status: 'npm run status',
            env_summary: 'npm run env:summary',
            verify: 'npm run verify',
            deploy_local: 'npm run deploy:local',
            deploy_space: 'npm run deploy:space',
            docker_cleanup_fixtures: 'npm run docker:cleanup-fixtures',
            agent_doctor: 'npm run agent:doctor',
            hf_space_doctor: 'npm run doctor:hf-space',
            hf_space_local_smoke: 'npm run smoke:hf-space-local',
            hf_space_smoke_legacy_alias: 'npm run smoke:hf-space'
        });
    });

    it('keeps the full verification gate aligned with repository policy', () => {
        assert.deepEqual(
            buildVerifyPlan().map((step) => step.name),
            [
                'version:check',
                'install-scripts:check',
                'npm-install-policy:check',
                'dependencies:check',
                'test',
                'lint',
                'format:check',
                'lint:scripts',
                'build',
                'diff-check',
                'diff-cached-check'
            ]
        );
    });

    it('supports a quick verification loop without hiding the full gate', () => {
        assert.deepEqual(
            buildVerifyPlan({ quick: true }).map((step) => step.name),
            [
                'version:check',
                'install-scripts:check',
                'npm-install-policy:check',
                'dependencies:check',
                'test:scripts',
                'lint:scripts',
                'diff-check',
                'diff-cached-check'
            ]
        );
        assert.deepEqual(
            buildVerifyPlan({ skipBuild: true }).map((step) => step.name),
            [
                'version:check',
                'install-scripts:check',
                'npm-install-policy:check',
                'dependencies:check',
                'test',
                'lint',
                'format:check',
                'lint:scripts',
                'diff-check',
                'diff-cached-check'
            ]
        );
    });

    it('can include the live PostgreSQL gate before the final diff check', () => {
        assert.deepEqual(
            buildVerifyPlan({ postgres: true }).map((step) => step.name),
            [
                'version:check',
                'install-scripts:check',
                'npm-install-policy:check',
                'dependencies:check',
                'test',
                'lint',
                'format:check',
                'lint:scripts',
                'build',
                'test:postgres',
                'diff-check',
                'diff-cached-check'
            ]
        );
        assert.deepEqual(
            buildVerifyPlan({ quick: true, postgres: true }).map((step) => step.name),
            [
                'version:check',
                'install-scripts:check',
                'npm-install-policy:check',
                'dependencies:check',
                'test:scripts',
                'lint:scripts',
                'test:postgres',
                'diff-check',
                'diff-cached-check'
            ]
        );
    });

    it('parses NUL-delimited git porcelain paths without rewriting filenames', () => {
        const output = [
            ' M README.md',
            '?? path with spaces.md',
            'R  new name.md',
            'old name.md',
            ' M path -> not rename.md',
            ' M line\nbreak.md',
            ''
        ].join('\0');

        assert.deepEqual(parseGitStatusEntries(output), [
            'README.md',
            'path with spaces.md',
            'new name.md',
            'path -> not rename.md',
            'line\nbreak.md'
        ]);
    });

    it('summarizes independent image upstream smoke readiness without exposing credentials', () => {
        const missing = buildImageUpstreamRealSmokeStatus({});
        assert.equal(missing.configuration_complete, false);
        assert.equal(missing.configured_count, 0);
        assert.deepEqual(missing.missing_cases, [
            'original-images-json',
            'gaoren-images-sse',
            'sub2api-images-sse',
            'sub2api-responses-json',
            'gpt2image-responses-sse',
            'matsca-images-sse'
        ]);
        assert.deepEqual(missing.request_modes['images-non-stream'], {
            required_count: 1,
            required_cases: ['original-images-json'],
            configuration_complete: false,
            configured_count: 0,
            configured_cases: [],
            missing_count: 1,
            missing_cases: ['original-images-json'],
            invalid_count: 0,
            invalid_cases: [],
            smoke_state: 'not_run_by_status'
        });
        assert.deepEqual(missing.request_modes['responses-sse'].required_cases, ['gpt2image-responses-sse']);
        assert.deepEqual(missing.missing_env_any['sub2api-responses-json'][0], [
            'IMAGE_REAL_SMOKE_SUB2API_RESPONSES_BASE_URL',
            'IMAGE_REAL_SMOKE_SUB2API_BASE_URL'
        ]);
        assert.equal(
            missing.final_gate_command,
            'npm run smoke:image-upstream-real -- --env-file-if-exists .env.real-smoke.local --require-independent-targets --allow-billable'
        );

        const configured = buildImageUpstreamRealSmokeStatus({
            IMAGE_REAL_SMOKE_ORIGINAL_BASE_URL: 'https://original.example/v1',
            IMAGE_REAL_SMOKE_ORIGINAL_API_KEY: 'original-secret',
            IMAGE_REAL_SMOKE_GAOREN_BASE_URL: 'https://gaoren.example/v1',
            IMAGE_REAL_SMOKE_GAOREN_API_KEY: 'gaoren-secret',
            IMAGE_REAL_SMOKE_SUB2API_BASE_URL: 'https://sub2api.example/v1',
            IMAGE_REAL_SMOKE_SUB2API_API_KEY: 'sub2api-secret',
            IMAGE_REAL_SMOKE_SUB2API_RESPONSES_RESPONSES_MODEL: 'gpt-4.1',
            IMAGE_REAL_SMOKE_GPT2IMAGE_BASE_URL: 'https://gpt2image.example/v1',
            IMAGE_REAL_SMOKE_GPT2IMAGE_API_KEY: 'gpt2image-secret',
            IMAGE_REAL_SMOKE_GPT2IMAGE_RESPONSES_MODEL: 'gpt-5.4',
            IMAGE_REAL_SMOKE_MATSCA_BASE_URL: 'https://matsca.example/v1',
            IMAGE_REAL_SMOKE_MATSCA_API_KEY: 'matsca-secret'
        });
        assert.equal(configured.configuration_complete, true);
        assert.equal(configured.configured_count, 6);
        assert.equal(configured.missing_count, 0);
        assert.equal(configured.request_modes['images-sse'].configured_count, 3);
        assert.deepEqual(configured.request_modes['responses-non-stream'].configured_cases, ['sub2api-responses-json']);
        assert.deepEqual(configured.request_modes['responses-sse'].configured_cases, ['gpt2image-responses-sse']);
        assert.doesNotMatch(JSON.stringify(configured), /secret|example\/v1/);
    });

    it('requires Responses top-level models in image upstream status readiness', () => {
        const status = buildImageUpstreamRealSmokeStatus({
            IMAGE_REAL_SMOKE_ORIGINAL_BASE_URL: 'https://original.example/v1',
            IMAGE_REAL_SMOKE_ORIGINAL_API_KEY: 'original-secret',
            IMAGE_REAL_SMOKE_GAOREN_BASE_URL: 'https://gaoren.example/v1',
            IMAGE_REAL_SMOKE_GAOREN_API_KEY: 'gaoren-secret',
            IMAGE_REAL_SMOKE_SUB2API_BASE_URL: 'https://sub2api.example/v1',
            IMAGE_REAL_SMOKE_SUB2API_API_KEY: 'sub2api-secret',
            IMAGE_REAL_SMOKE_GPT2IMAGE_BASE_URL: 'https://gpt2image.example/v1',
            IMAGE_REAL_SMOKE_GPT2IMAGE_API_KEY: 'gpt2image-secret',
            IMAGE_REAL_SMOKE_MATSCA_BASE_URL: 'https://matsca.example/v1',
            IMAGE_REAL_SMOKE_MATSCA_API_KEY: 'matsca-secret'
        });

        assert.equal(status.configuration_complete, false);
        assert.equal(status.configured_count, 4);
        assert.deepEqual(status.configured_cases, [
            'original-images-json',
            'gaoren-images-sse',
            'sub2api-images-sse',
            'matsca-images-sse'
        ]);
        assert.deepEqual(status.missing_cases, ['sub2api-responses-json', 'gpt2image-responses-sse']);
        assert.deepEqual(status.missing_env_any['sub2api-responses-json'][0], [
            'IMAGE_REAL_SMOKE_SUB2API_RESPONSES_RESPONSES_MODEL',
            'OPENAI_RESPONSES_API_MODEL'
        ]);
        assert.deepEqual(status.missing_env_any['gpt2image-responses-sse'][0], [
            'IMAGE_REAL_SMOKE_GPT2IMAGE_RESPONSES_MODEL',
            'OPENAI_RESPONSES_API_MODEL'
        ]);
        assert.doesNotMatch(JSON.stringify(status), /secret|example\/v1/);
    });

    it('does not treat the sub2api Responses image model as the Responses top-level model', () => {
        const status = buildImageUpstreamRealSmokeStatus({
            IMAGE_REAL_SMOKE_SUB2API_RESPONSES_BASE_URL: 'https://sub2api-responses.example/v1',
            IMAGE_REAL_SMOKE_SUB2API_RESPONSES_API_KEY: 'sub2api-responses-secret',
            IMAGE_REAL_SMOKE_SUB2API_RESPONSES_MODEL: 'gpt-image-2'
        });

        assert.equal(status.configuration_complete, false);
        assert.equal(status.configured_count, 0);
        assert.deepEqual(status.missing_cases, [
            'original-images-json',
            'gaoren-images-sse',
            'sub2api-images-sse',
            'sub2api-responses-json',
            'gpt2image-responses-sse',
            'matsca-images-sse'
        ]);
        assert.deepEqual(status.missing_env_any['sub2api-responses-json'][0], [
            'IMAGE_REAL_SMOKE_SUB2API_RESPONSES_RESPONSES_MODEL',
            'OPENAI_RESPONSES_API_MODEL'
        ]);
        assert.doesNotMatch(JSON.stringify(status), /sub2api-responses-secret|sub2api-responses\.example/);
    });

    it('reports unsafe independent image upstream base URLs without exposing values', () => {
        const status = buildImageUpstreamRealSmokeStatus({
            IMAGE_REAL_SMOKE_ORIGINAL_BASE_URL: 'https://user:pass@original.example/v1?token=secret#frag',
            IMAGE_REAL_SMOKE_ORIGINAL_API_KEY: 'original-secret'
        });

        assert.equal(status.configuration_complete, false);
        assert.equal(status.configured_count, 0);
        assert.equal(status.missing_count, 5);
        assert.equal(status.invalid_count, 1);
        assert.deepEqual(status.invalid_cases, ['original-images-json']);
        assert.deepEqual(status.invalid_env['original-images-json'], [
            {
                key: 'IMAGE_REAL_SMOKE_ORIGINAL_BASE_URL',
                reason: 'must_not_include_credentials'
            }
        ]);
        assert.equal(status.missing_env_any['original-images-json'], undefined);
        assert.doesNotMatch(JSON.stringify(status), /user:pass|original\.example|token=secret|original-secret/);
    });

    it('checks local real smoke endpoints without exposing URL paths or credentials', async () => {
        const status = await buildImageUpstreamLocalEndpointStatus(
            {
                IMAGE_REAL_SMOKE_ORIGINAL_BASE_URL: 'http://127.0.0.1:3010/v1?ignored=no',
                IMAGE_REAL_SMOKE_ORIGINAL_API_KEY: 'original-secret',
                IMAGE_REAL_SMOKE_GAOREN_BASE_URL: 'http://localhost:3001/v1',
                IMAGE_REAL_SMOKE_GAOREN_API_KEY: 'gaoren-secret',
                IMAGE_REAL_SMOKE_SUB2API_BASE_URL: 'https://sub2api.example/v1',
                IMAGE_REAL_SMOKE_SUB2API_API_KEY: 'sub2api-secret'
            },
            {
                probe: async (endpoint) => ({
                    ok: endpoint.port === 3001,
                    reason: endpoint.port === 3001 ? undefined : 'connection_refused'
                })
            }
        );

        assert.deepEqual(status, {
            checked_count: 1,
            unavailable_count: 0,
            unavailable_cases: [],
            results: [
                {
                    id: 'gaoren-images-sse',
                    endpoint: 'localhost:3001',
                    ok: true
                }
            ]
        });
        assert.doesNotMatch(JSON.stringify(status), /secret|\/v1|sub2api\.example|ignored=no/);
    });

    it('reports unavailable local real smoke endpoints by case id', async () => {
        const status = await buildImageUpstreamLocalEndpointStatus(
            {
                IMAGE_REAL_SMOKE_SUB2API_BASE_URL: 'http://127.0.0.1:3021/v1',
                IMAGE_REAL_SMOKE_SUB2API_API_KEY: 'sub2api-secret',
                IMAGE_REAL_SMOKE_MATSCA_BASE_URL: 'http://[::1]:3090/v1',
                IMAGE_REAL_SMOKE_MATSCA_API_KEY: 'matsca-secret'
            },
            {
                probe: async (endpoint) => ({
                    ok: false,
                    reason: endpoint.port === 3021 ? 'connection_refused' : 'timeout'
                })
            }
        );

        assert.deepEqual(status, {
            checked_count: 3,
            unavailable_count: 3,
            unavailable_cases: ['sub2api-images-sse', 'sub2api-responses-json', 'matsca-images-sse'],
            results: [
                {
                    id: 'sub2api-images-sse',
                    endpoint: '127.0.0.1:3021',
                    ok: false,
                    reason: 'connection_refused'
                },
                {
                    id: 'sub2api-responses-json',
                    endpoint: '127.0.0.1:3021',
                    ok: false,
                    reason: 'connection_refused'
                },
                {
                    id: 'matsca-images-sse',
                    endpoint: '[::1]:3090',
                    ok: false,
                    reason: 'timeout'
                }
            ]
        });
        assert.doesNotMatch(JSON.stringify(status), /secret|\/v1/);
    });

    it('loads independent image upstream smoke readiness from env files without overriding shell env', async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'image-upstream-status-'));
        const localEnvPath = path.join(tempDir, '.env.local');
        const realSmokeEnvPath = path.join(tempDir, '.env.real-smoke.local');
        await writeFile(
            localEnvPath,
            [
                'IMAGE_REAL_SMOKE_ORIGINAL_BASE_URL=https://local-original.example/v1',
                'IMAGE_REAL_SMOKE_ORIGINAL_API_KEY=local-original-secret',
                'IMAGE_REAL_SMOKE_GAOREN_BASE_URL=https://local-gaoren.example/v1',
                'IMAGE_REAL_SMOKE_GAOREN_API_KEY=local-gaoren-secret'
            ].join('\n')
        );
        await writeFile(
            realSmokeEnvPath,
            [
                'IMAGE_REAL_SMOKE_GAOREN_BASE_URL=https://real-gaoren.example/v1',
                'IMAGE_REAL_SMOKE_GAOREN_API_KEY=real-gaoren-secret',
                'IMAGE_REAL_SMOKE_SUB2API_BASE_URL=https://real-sub2api.example/v1',
                'IMAGE_REAL_SMOKE_SUB2API_API_KEY=real-sub2api-secret',
                'IMAGE_REAL_SMOKE_SUB2API_RESPONSES_RESPONSES_MODEL=gpt-4.1',
                'IMAGE_REAL_SMOKE_GPT2IMAGE_BASE_URL=https://real-gpt2image.example/v1',
                'IMAGE_REAL_SMOKE_GPT2IMAGE_API_KEY=real-gpt2image-secret',
                'IMAGE_REAL_SMOKE_GPT2IMAGE_RESPONSES_MODEL=gpt-5.4',
                'IMAGE_REAL_SMOKE_MATSCA_BASE_URL=https://real-matsca.example/v1',
                'IMAGE_REAL_SMOKE_MATSCA_API_KEY=real-matsca-secret'
            ].join('\n')
        );

        try {
            const statusEnv = readStatusEnvFromFiles(
                {
                    IMAGE_REAL_SMOKE_ORIGINAL_API_KEY: 'shell-original-secret'
                },
                [
                    { path: localEnvPath, override: false },
                    { path: realSmokeEnvPath, override: true }
                ]
            );
            const status = buildImageUpstreamRealSmokeStatus(statusEnv);

            assert.equal(statusEnv.IMAGE_REAL_SMOKE_ORIGINAL_API_KEY, 'shell-original-secret');
            assert.equal(status.configuration_complete, true);
            assert.deepEqual(status.configured_cases, [
                'original-images-json',
                'gaoren-images-sse',
                'sub2api-images-sse',
                'sub2api-responses-json',
                'gpt2image-responses-sse',
                'matsca-images-sse'
            ]);
            assert.doesNotMatch(JSON.stringify(status), /secret|example\/v1/);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it('preserves mismatched env quotes in status env files', async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'image-upstream-status-'));
        const envPath = path.join(tempDir, '.env.local');
        await writeFile(
            envPath,
            [
                'MATCHED_DOUBLE="https://quoted.example/v1"',
                "MATCHED_SINGLE='single-secret'",
                'MATCHED_DOUBLE_SPACES="  kept value  "',
                'MISMATCHED_LEADING="kept-value',
                'MISMATCHED_TRAILING=kept-value"',
                'MISMATCHED_PAIR="kept-value\'',
                'SINGLE_DOUBLE_QUOTE="',
                "SINGLE_SINGLE_QUOTE='"
            ].join('\n')
        );

        try {
            const statusEnv = readStatusEnvFromFiles({}, [{ path: envPath, override: false }]);

            assert.equal(statusEnv.MATCHED_DOUBLE, 'https://quoted.example/v1');
            assert.equal(statusEnv.MATCHED_SINGLE, 'single-secret');
            assert.equal(statusEnv.MATCHED_DOUBLE_SPACES, '  kept value  ');
            assert.equal(statusEnv.MISMATCHED_LEADING, '"kept-value');
            assert.equal(statusEnv.MISMATCHED_TRAILING, 'kept-value"');
            assert.equal(statusEnv.MISMATCHED_PAIR, '"kept-value\'');
            assert.equal(statusEnv.SINGLE_DOUBLE_QUOTE, '"');
            assert.equal(statusEnv.SINGLE_SINGLE_QUOTE, "'");
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it('builds deterministic local deploy compose arguments', () => {
        assert.deepEqual(buildDockerComposeArgs(), [
            'compose',
            '-f',
            'docker-compose.yml',
            'up',
            '-d',
            '--build',
            '--force-recreate',
            '--remove-orphans',
            '--wait',
            '--wait-timeout',
            '120'
        ]);
        assert.deepEqual(buildDockerComposeArgs({ memory: true }), [
            'compose',
            '-f',
            'docker-compose.yml',
            '-f',
            'docker-compose.memory.yml',
            'up',
            '-d',
            '--build',
            '--force-recreate',
            '--remove-orphans',
            '--wait',
            '--wait-timeout',
            '120'
        ]);
        assert.deepEqual(buildDockerComposeArgs({ postgres: true }), [
            'compose',
            '-f',
            'docker-compose.yml',
            '-f',
            'docker-compose.postgres.yml',
            'up',
            '-d',
            '--build',
            '--force-recreate',
            '--remove-orphans',
            '--wait',
            '--wait-timeout',
            '120'
        ]);
        assert.deepEqual(buildDockerComposeArgs({ tun: true }), [
            'compose',
            '-f',
            'docker-compose.yml',
            '-f',
            'docker-compose.tun.yml',
            'up',
            '-d',
            '--build',
            '--force-recreate',
            '--remove-orphans',
            '--wait',
            '--wait-timeout',
            '120'
        ]);
        assert.throws(() => buildDockerComposeArgs({ memory: true, postgres: true }), /不能同时使用/);
    });

    it('uses plain compose progress for diagnosable local deploy output', () => {
        assert.deepEqual(buildDockerComposeEnv({ PATH: '/bin', COMPOSE_PROGRESS: 'auto' }), {
            PATH: '/bin',
            COMPOSE_PROGRESS: 'plain'
        });
        assert.deepEqual(
            buildDockerComposeEnv(
                { PATH: '/bin' },
                {
                    revision: '0123456789abcdef0123456789abcdef01234567',
                    imageTag: 'local-0123456789abcdef0123456789abcdef01234567'
                }
            ),
            {
                PATH: '/bin',
                COMPOSE_PROGRESS: 'plain',
                VJ_IMAGE_REVISION: '0123456789abcdef0123456789abcdef01234567',
                VJ_IMAGE_TAG: 'local-0123456789abcdef0123456789abcdef01234567'
            }
        );
    });

    it('requires explicit confirmation before deploying with automatic WebUI image cleanup enabled', () => {
        assert.equal(isImageAutoCleanupEnabled('true'), true);
        assert.equal(isImageAutoCleanupEnabled('yes'), true);
        assert.equal(isImageAutoCleanupEnabled('false'), false);
        assert.equal(isImageAutoCleanupEnabled(undefined), false);
        assert.doesNotThrow(() => assertImageAutoCleanupDeploymentAllowed({}));
        assert.throws(
            () => assertImageAutoCleanupDeploymentAllowed({ WEBUI_IMAGE_AUTO_CLEANUP_ENABLED: 'true' }),
            /--allow-image-auto-cleanup/
        );
        assert.doesNotThrow(() =>
            assertImageAutoCleanupDeploymentAllowed(
                { WEBUI_IMAGE_AUTO_CLEANUP_ENABLED: 'true' },
                { allowImageAutoCleanup: true }
            )
        );
    });

    it('reads the automatic cleanup setting from the Compose env file instead of the shell environment', async () => {
        const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'deploy-local-cleanup-'));
        try {
            await writeFile(
                path.join(temporaryDirectory, '.env.local'),
                'WEBUI_IMAGE_AUTO_CLEANUP_ENABLED=true\nWEBUI_IMAGE_RETENTION_DAYS=30\n'
            );

            assert.equal(readImageAutoCleanupValueFromComposeEnvFile(temporaryDirectory), 'true');
            assert.throws(
                () => assertComposeImageAutoCleanupDeploymentAllowed({}, temporaryDirectory),
                /--allow-image-auto-cleanup/
            );
            assert.doesNotThrow(() =>
                assertComposeImageAutoCleanupDeploymentAllowed({ allowImageAutoCleanup: true }, temporaryDirectory)
            );
        } finally {
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    });

    it('blocks the deploy CLI before Docker runs unless automatic cleanup is explicitly confirmed', async () => {
        const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'deploy-local-cleanup-cli-'));
        const fakeBinDirectory = path.join(temporaryDirectory, 'bin');
        const dockerCallLog = path.join(temporaryDirectory, 'docker-calls.log');
        await mkdir(fakeBinDirectory);
        await writeFile(path.join(temporaryDirectory, '.env.local'), 'WEBUI_IMAGE_AUTO_CLEANUP_ENABLED=true\n');
        await writeExecutable(
            path.join(fakeBinDirectory, 'git'),
            `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' '0123456789abcdef0123456789abcdef01234567'
  exit 0
fi
if [ "$1" = "status" ]; then
  exit 0
fi
exit 1
`
        );
        await writeExecutable(
            path.join(fakeBinDirectory, 'docker'),
            `#!/bin/sh
printf '%s\\n' "$*" >> "$DEPLOY_LOCAL_DOCKER_CALL_LOG"
if [ "$1" = "compose" ]; then
  exit 0
fi
if [ "$1" = "inspect" ]; then
  case "$3" in
    *Config.Image*) printf '%s\\n' 'visual-journal:local-0123456789abcdef0123456789abcdef01234567' ;;
    *NetworkSettings.Ports*) printf '%s\\n' '[{"HostIp":"127.0.0.1","HostPort":"4783"}]' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  printf '%s\\n' '0123456789abcdef0123456789abcdef01234567'
  exit 0
fi
exit 1
`
        );

        try {
            const baseEnv = {
                PATH: `${fakeBinDirectory}${path.delimiter}${process.env.PATH || ''}`,
                DEPLOY_LOCAL_DOCKER_CALL_LOG: dockerCallLog
            };
            const blocked = await runNodeCommandAsync([deployLocalScriptPath, '--skip-probe'], {
                cwd: temporaryDirectory,
                env: baseEnv
            });

            assert.equal(blocked.status, 1);
            assert.match(blocked.stdout, /--allow-image-auto-cleanup/);
            assert.equal(existsSync(dockerCallLog), false);

            const confirmed = await runNodeCommandAsync(
                [deployLocalScriptPath, '--allow-image-auto-cleanup', '--skip-probe'],
                { cwd: temporaryDirectory, env: baseEnv }
            );
            assert.equal(confirmed.status, 0);
            assert.equal(parseJsonPayload(confirmed.stdout).ok, true);
            assert.match(await readFile(dockerCallLog, 'utf8'), /^compose /m);
        } finally {
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    });

    it('uses immutable full-revision Docker image tags for deploys', () => {
        const revision = '0123456789abcdef0123456789abcdef01234567';
        assert.equal(buildDeploymentImageTag(revision), `local-${revision}`);
        assert.equal(buildDeploymentImageReference(revision), `visual-journal:local-${revision}`);
        assert.throws(() => buildDeploymentImageTag('0123456'), /40/);
        assert.throws(() => buildDeploymentImageTag('z'.repeat(40)), /40/);
    });

    it('builds local probe URLs from the published container port mapping', () => {
        assert.equal(buildLocalBaseUrl('127.0.0.1', '4783'), 'http://127.0.0.1:4783');
        assert.equal(buildLocalBaseUrl('0.0.0.0', '4784'), 'http://127.0.0.1:4784');
        assert.equal(buildLocalBaseUrl('::1', '4783'), 'http://[::1]:4783');
        assert.deepEqual(parsePublishedContainerPortBindings('[{"HostIp":"127.0.0.1","HostPort":"4783"}]'), {
            bindHost: '127.0.0.1',
            hostPort: '4783',
            baseUrl: 'http://127.0.0.1:4783'
        });
        assert.deepEqual(
            parsePublishedContainerPortBindings(
                '[{"HostIp":"::","HostPort":"4784"},{"HostIp":"0.0.0.0","HostPort":"4784"}]'
            ),
            {
                bindHost: '0.0.0.0',
                hostPort: '4784',
                baseUrl: 'http://127.0.0.1:4784'
            }
        );
        assert.throws(() => buildLocalBaseUrl('127.0.0.1', '0'), /1 到 65535/);
        assert.throws(() => parsePublishedContainerPortBindings('not-json'), /端口映射/);
        assert.throws(() => parsePublishedContainerPortBindings('null'), /未发布/);
    });

    it('waits only between failed local endpoint probe attempts', async () => {
        let requestCount = 0;
        let sleepCount = 0;

        await assert.rejects(
            waitForLocalEndpoints('http://127.0.0.1:4783', {
                attempts: 2,
                intervalMs: 2000,
                fetchJson: async () => {
                    requestCount += 1;
                    throw new Error('container not ready');
                },
                sleep: async () => {
                    sleepCount += 1;
                }
            }),
            /container not ready/
        );

        assert.equal(requestCount, 2);
        assert.equal(sleepCount, 1);
    });

    it('reads the effective TUN mode from runtime capabilities', async () => {
        const probe = await waitForLocalEndpoints('http://127.0.0.1:4783', {
            attempts: 1,
            fetchJson: async (probePath) => {
                if (probePath === '/api/auth-status') return { passwordRequired: false };
                if (probePath === '/api/runtime-capabilities') {
                    return {
                        imageTransport: { tun_mode: 'synthetic-dns' },
                        streamingBatch: { enabled: true }
                    };
                }
                return {
                    defaults: { state_backend: 'sqlite' },
                    storage: { image_storage_mode: 'fs' },
                    image_transport: { tun_mode: 'disabled' }
                };
            }
        });

        assert.equal(probe.tunMode, 'synthetic-dns');
    });

    it('requires the running Docker image and revision label to match the deployed revision', () => {
        const deployment = {
            revision: '0123456789abcdef0123456789abcdef01234567',
            imageTag: 'local-0123456789abcdef0123456789abcdef01234567'
        };
        assert.doesNotThrow(() =>
            assertDeploymentImageIdentity(
                {
                    image: 'visual-journal:local-0123456789abcdef0123456789abcdef01234567',
                    revision: deployment.revision
                },
                deployment
            )
        );
        assert.throws(
            () =>
                assertDeploymentImageIdentity(
                    { image: 'visual-journal:local', revision: deployment.revision },
                    deployment
                ),
            /镜像不匹配/
        );
        assert.throws(
            () =>
                assertDeploymentImageIdentity(
                    {
                        image: 'visual-journal:local-0123456789abcdef0123456789abcdef01234567',
                        revision: 'different'
                    },
                    deployment
                ),
            /revision 不匹配/
        );
    });

    it('detects only the legacy fixture whole-repository Docker mount', () => {
        const repoRoot = '/Volumes/Work/code/visual-journal';
        assert.equal(
            hasLegacyFixtureRepoMount(
                [
                    {
                        Type: 'bind',
                        Source: repoRoot,
                        Destination: '/workspace',
                        Mode: 'ro',
                        RW: false
                    }
                ],
                repoRoot
            ),
            true
        );
        assert.equal(
            hasLegacyFixtureRepoMount(
                [
                    {
                        Type: 'bind',
                        Source: `${repoRoot}/generated-images`,
                        Destination: '/app/generated-images',
                        Mode: '',
                        RW: true
                    }
                ],
                repoRoot
            ),
            false
        );
    });

    it('parses and summarizes Docker fixture cleanup inspection data', () => {
        const container = parseDockerInspectContainer(
            JSON.stringify([
                {
                    Mounts: [
                        {
                            Type: 'bind',
                            Source: '/repo',
                            Destination: '/workspace',
                            Mode: 'ro',
                            RW: false
                        }
                    ]
                }
            ])
        );

        assert.deepEqual(summarizeDockerMounts(container.Mounts), [
            {
                type: 'bind',
                source: '/repo',
                destination: '/workspace',
                mode: 'ro',
                writable: false
            }
        ]);
        assert.deepEqual(buildAbsentReport('gipc-local-image-fixture'), {
            ok: true,
            command: 'docker:cleanup-fixtures',
            container: 'gipc-local-image-fixture',
            present: false,
            unsafe_repo_mount: false,
            removed: false
        });
        assert.equal(buildSkippedReport('custom', container.Mounts).removed, false);
    });

    it('requires local deploy probes to match the selected state and storage backend', () => {
        assert.doesNotThrow(() => assertLocalProbeMatchesMode({ stateBackend: 'sqlite', imageStorageMode: 'fs' }));
        assert.throws(
            () => assertLocalProbeMatchesMode({ stateBackend: 'memory', imageStorageMode: 'indexeddb' }),
            /SQLite deployment mode did not take effect/
        );
        assert.doesNotThrow(() =>
            assertLocalProbeMatchesMode({ stateBackend: 'memory', imageStorageMode: 'indexeddb' }, { memory: true })
        );
        assert.throws(
            () => assertLocalProbeMatchesMode({ stateBackend: 'sqlite', imageStorageMode: 'fs' }, { memory: true }),
            /Memory deployment mode did not take effect/
        );
        assert.doesNotThrow(() =>
            assertLocalProbeMatchesMode({ stateBackend: 'postgres', imageStorageMode: 'fs' }, { postgres: true })
        );
        assert.throws(
            () => assertLocalProbeMatchesMode({ stateBackend: 'sqlite', imageStorageMode: 'fs' }, { postgres: true }),
            /PostgreSQL deployment mode did not take effect/
        );
        assert.throws(
            () =>
                assertLocalProbeMatchesMode(
                    { stateBackend: 'memory', imageStorageMode: 'indexeddb' },
                    { memory: true, postgres: true }
                ),
            /不能同时使用/
        );
        assert.doesNotThrow(() =>
            assertLocalProbeMatchesMode(
                { stateBackend: 'sqlite', imageStorageMode: 'fs', tunMode: 'synthetic-dns' },
                { tun: true }
            )
        );
        assert.throws(
            () =>
                assertLocalProbeMatchesMode(
                    { stateBackend: 'sqlite', imageStorageMode: 'fs', tunMode: 'disabled' },
                    { tun: true }
                ),
            /tunMode=.*synthetic-dns/
        );
    });

    it('routes agent:doctor through the non-billable contract check', () => {
        const args = buildAgentDoctorArgs();
        assert.match(args[0], /generate-image\.mjs$/);
        assert.deepEqual(args.slice(1), ['--contract-check', '--timeout-ms', '60000', 'contract check']);
    });

    it('routes agent:doctor contract check through an explicit base URL', () => {
        const args = buildAgentDoctorContractArgs('https://space.example.test/');
        assert.match(args[0], /generate-image\.mjs$/);
        assert.deepEqual(args.slice(1), [
            '--contract-check',
            '--timeout-ms',
            '60000',
            '--base-url',
            'https://space.example.test/',
            'contract check'
        ]);
    });

    it('reports first-run readiness without exposing secrets', async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'first-run-'));
        await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
        await writeFile(path.join(tempDir, 'package-lock.json'), '{}');
        await writeFile(path.join(tempDir, '.env.agent.local'), 'AGENT_API_TOKEN=file-secret\n');
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    assert.equal(request.headers.authorization, 'Bearer shell-secret');
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            auth: { schemes: ['bearer'] },
                            defaults: { state_backend: 'memory' },
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    auth: {
                                        required: true,
                                        form_field: 'passwordHash'
                                    }
                                }
                            },
                            supported: { image_backend_requirements: {} }
                        })
                    );
                    return;
                }
                if (request.url === '/api/runtime-capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ streaming: { defaultMode: 'auto' } }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                try {
                    const report = await buildFirstRunReport(
                        {
                            cwd: tempDir,
                            baseUrl,
                            envFiles: ['.env.agent.local'],
                            timeoutMs: 1000
                        },
                        { AGENT_API_TOKEN: 'shell-secret' }
                    );

                    assert.equal(report.command, 'first-run');
                    assert.equal(report.billable, false);
                    assert.equal(report.service_base_url, baseUrl);
                    assert.equal(report.service_base_url_source, 'user_provided');
                    assert.equal(report.interactive_confirmation_required, false);
                    assert.deepEqual(report.agent_auth_process, {
                        has_token: true,
                        has_password_hash: false,
                        has_any_auth: true
                    });
                    assert.deepEqual(report.agent_auth_service, {
                        required: true,
                        required_schemes: ['bearer'],
                        ready: true,
                        has_token: true,
                        has_password_hash: false,
                        has_any_auth: true
                    });
                    assert.deepEqual(report.private_agent_env, {
                        exists: true,
                        has_token: true,
                        has_password_hash: false
                    });
                    assert.equal(report.service.ok, true);
                    assert.equal(
                        report.checks.find((check) => check.name === 'dependencies_installed').hint,
                        '运行 npm run install-scripts:check && npm run npm-install-policy:check && npm ci --strict-allow-scripts && npm run dependencies:check。'
                    );
                    assert.equal(
                        report.checks.find((check) => check.name === 'agent_auth_available_to_process').ok,
                        true
                    );
                    assert.equal(
                        report.checks.find((check) => check.name === 'page_sse_auth_available_to_process').ok,
                        false
                    );
                    assert.equal(
                        report.checks.find((check) => check.name === 'page_sse_auth_available_to_process').skipped,
                        false
                    );
                    assert.equal(
                        report.checks.find((check) => check.name === 'page_sse_auth_available_to_process')
                            .auth_in_private_env_file,
                        false
                    );
                    assert.equal(report.service.capabilities.page_sse_auth_required, true);
                    assert.equal(report.service.capabilities.page_sse_auth_form_field, 'passwordHash');
                    assert.equal(report.service.capabilities.page_sse_declared_supported, true);
                    assert.equal(report.service.capabilities.page_sse_real_smoke, 'not_run_by_first_run');
                    assert.equal(
                        report.service.capabilities.responses_image_backend_real_smoke,
                        'not_run_by_first_run'
                    );
                    assert.deepEqual(report.service.capabilities.page_sse_real_smoke_status, {
                        state: 'not_run',
                        billable: false,
                        reason: 'first-run is non-billable and does not call /api/images'
                    });
                    assert.deepEqual(report.service.capabilities.responses_image_backend_real_smoke_status, {
                        state: 'not_run',
                        billable: false,
                        reason: 'first-run is non-billable and does not call Responses image generation'
                    });
                    assert.match(formatFirstRunText(report), /页面 SSE：声明支持，实测=未执行真实 smoke/);
                    assert.match(
                        formatFirstRunText(report),
                        /Responses 后端：声明未支持，启用=否，实测=未执行真实 smoke/
                    );
                    assert.equal(
                        report.checks.find((check) => check.name === 'agent_auth_available_to_process')
                            .auth_in_private_env_file,
                        true
                    );
                    assert.doesNotMatch(JSON.stringify(report), /shell-secret|file-secret/);
                    assert.match(
                        JSON.stringify(report.next_actions),
                        /npm run install-scripts:check && npm run npm-install-policy:check && npm ci --strict-allow-scripts && npm run dependencies:check/
                    );
                    assert.match(JSON.stringify(report.next_actions), /agent:doctor/);
                    assert.match(JSON.stringify(report.next_actions), /GPT_IMAGE_APP_PASSWORD_HASH/);
                    assert.match(JSON.stringify(report.next_actions), /GPT_IMAGE_AGENT_TOKEN/);
                } finally {
                    await rm(tempDir, { recursive: true, force: true });
                }
            }
        );
    });

    it('does not treat an interrupted dependency installation as ready', async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'first-run-incomplete-dependencies-'));
        await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
        await writeFile(
            path.join(tempDir, 'package-lock.json'),
            JSON.stringify({
                lockfileVersion: 3,
                packages: {
                    '': { dependencies: { demo: '1.0.0' } },
                    'node_modules/demo': { version: '1.0.0' }
                }
            })
        );
        await mkdir(path.join(tempDir, 'node_modules'));
        await writeFile(
            path.join(tempDir, 'node_modules', '.package-lock.json'),
            JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/demo': { version: '1.0.0' } } })
        );
        await withServer(
            (_request, response) => {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ defaults: {}, supported: {} }));
            },
            async (baseUrl) => {
                try {
                    const report = await buildFirstRunReport(
                        { cwd: tempDir, baseUrl, envFiles: [], timeoutMs: 1000 },
                        {}
                    );
                    const dependencies = report.checks.find((check) => check.name === 'dependencies_installed');

                    assert.equal(dependencies.ok, false);
                    assert.equal(dependencies.reason, 'direct_package_missing');
                    assert.deepEqual(dependencies.missing_packages, ['demo']);
                    assert.equal(
                        dependencies.hint,
                        '运行 npm run install-scripts:check && npm run npm-install-policy:check && npm ci --strict-allow-scripts && npm run dependencies:check。'
                    );
                } finally {
                    await rm(tempDir, { recursive: true, force: true });
                }
            }
        );
    });

    it('treats bearer-required services as not ready when only APP_PASSWORD is loaded', async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'first-run-auth-bearer-'));
        await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
        await withServer(
            (_request, response) => {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(
                    JSON.stringify({
                        auth: { schemes: ['bearer'] },
                        defaults: { state_backend: 'memory' }
                    })
                );
            },
            async (baseUrl) => {
                try {
                    const report = await buildFirstRunReport(
                        {
                            cwd: tempDir,
                            baseUrl,
                            envFiles: ['.env.agent.local'],
                            timeoutMs: 1000
                        },
                        { GPT_IMAGE_APP_PASSWORD_HASH: 'shell-secret' }
                    );

                    assert.deepEqual(report.agent_auth_process, {
                        has_token: false,
                        has_password_hash: true,
                        has_any_auth: true
                    });
                    assert.deepEqual(report.agent_auth_service, {
                        required: true,
                        required_schemes: ['bearer'],
                        ready: false,
                        has_token: false,
                        has_password_hash: false,
                        has_any_auth: false
                    });
                    assert.match(formatFirstRunText(report), /当前进程鉴权：已加载访问码哈希/);
                    assert.match(formatFirstRunText(report), /服务鉴权：未满足当前服务鉴权要求/);
                    assert.match(JSON.stringify(report.next_actions), /GPT_IMAGE_AGENT_TOKEN/);
                    assert.doesNotMatch(JSON.stringify(report.next_actions), /GPT_IMAGE_APP_PASSWORD_HASH/);
                } finally {
                    await rm(tempDir, { recursive: true, force: true });
                }
            }
        );
    });

    it('formats first-run as human-readable text by default', async () => {
        const report = await buildFirstRunReport(
            { cwd: process.cwd(), baseUrl: 'not a url', envFiles: [] },
            { GPT_IMAGE_AGENT_LOAD_ENV_FILE: '0' }
        );
        const text = formatFirstRunText(report);

        assert.match(text, /^首次配置检查：需要处理/m);
        assert.match(text, /服务地址：无效/);
        assert.match(text, /当前进程鉴权：未加载/);
        assert.match(text, /私有 Agent env：不存在/);
        assert.match(text, /下一步：/);
        assert.doesNotMatch(text, /实测=passed/);
        assert.doesNotMatch(text, /^\{/);
    });

    it('preserves path-prefixed service URLs in first-run reports', async () => {
        // This test only checks local URL normalization in the report; .test is reserved and should not resolve.
        const report = await buildFirstRunReport(
            {
                cwd: process.cwd(),
                baseUrl: 'https://space.example.test/proxy/',
                envFiles: [],
                timeoutMs: 5
            },
            {}
        );

        assert.equal(report.service_base_url, 'https://space.example.test/proxy');
    });

    it('prints localized first-run help and option errors', async () => {
        const help = await runNodeCommandAsync(['scripts/first-run.mjs', '--help'], {
            env: process.env,
            timeoutMs: 5_000
        });
        assert.equal(help.ok, true);
        assert.match(help.stdout, /用法：/);
        assert.match(help.stdout, /输出机器可读 JSON/);
        assert.doesNotMatch(help.stdout, /Usage:/);

        const invalid = await runNodeCommandAsync(['scripts/first-run.mjs', '--missing-option'], {
            env: process.env,
            timeoutMs: 5_000
        });
        assert.equal(invalid.ok, false);
        assert.match(invalid.stdout, /"ok": false/);
        assert.match(invalid.stdout, /未知参数：--missing-option/);
    });

    it('keeps first-run local discovery explicit when no URL is provided', async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'first-run-default-'));
        try {
            await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));

            const report = await buildFirstRunReport({ cwd: tempDir, envFiles: [], timeoutMs: 20 }, {});

            assert.equal(report.service_base_url_source, 'default_local_probe');
            assert.equal(report.interactive_confirmation_required, true);
            assert.equal(report.ok, false);
            assert.match(JSON.stringify(report.next_actions), /确认探测到的服务地址/);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it('points first-run at auth setup when the service rejects capabilities with 401', async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'first-run-auth-'));
        await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
        await withServer(
            (_request, response) => {
                response.writeHead(401, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'unauthorized' }));
            },
            async (baseUrl) => {
                try {
                    const report = await buildFirstRunReport(
                        {
                            cwd: tempDir,
                            baseUrl: `${baseUrl}/`,
                            envFiles: [],
                            timeoutMs: 1000
                        },
                        {}
                    );

                    assert.equal(report.service_base_url, baseUrl);
                    assert.equal(
                        report.checks.find((check) => check.name === 'agent_auth_available_to_process').skipped,
                        false
                    );
                    assert.equal(report.checks.find((check) => check.name === 'service_reachable').status, 401);
                    assert.equal('runtime' in report.service, false);
                    assert.match(JSON.stringify(report.next_actions), /GPT_IMAGE_AGENT_TOKEN/);
                    assert.doesNotMatch(JSON.stringify(report.next_actions), /Start the service/);
                } finally {
                    await rm(tempDir, { recursive: true, force: true });
                }
            }
        );
    });

    it('reports layered agent:doctor diagnostics without billable smoke by default', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/proxy/api/agent/capabilities') {
                    assert.equal(request.headers.authorization, 'Bearer doctor-token');
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            defaults: { state_backend: 'memory' },
                            storage: { image_storage_mode: 'indexeddb', postgres_configured: false },
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    auth: { required: true, form_field: 'passwordHash' }
                                }
                            },
                            agent_jobs: { supported: true },
                            orchestration: {
                                supported: true,
                                endpoint: '/api/agent/image-requests',
                                transport_selection: 'server_owned'
                            },
                            request_mode_controls: {
                                global_env: 'OPENAI_UPSTREAM_REQUEST_MODES',
                                channel_env_pattern: 'OPENAI_CHANNEL_N_REQUEST_MODES',
                                agent_client_policy: 'diagnostics_only'
                            },
                            routing_rules: {
                                high_resolution_edit: {
                                    conditions: { operation: 'edit', max_edge: { operator: 'gt', value: 2048 } }
                                }
                            },
                            supported: {
                                request_modes: [
                                    'images-non-stream',
                                    'images-sse',
                                    'images-json',
                                    'responses-non-stream',
                                    'responses-sse'
                                ],
                                image_backend_requirements: {
                                    'responses-image-generation': {
                                        supported: true,
                                        enabled: true,
                                        missing_env: []
                                    }
                                }
                            },
                            upstream_request_headers: {
                                channels: [
                                    {
                                        id: 'images',
                                        request_modes: ['images-non-stream', 'images-sse']
                                    },
                                    {
                                        id: 'responses',
                                        request_modes: ['responses-sse']
                                    }
                                ]
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/proxy/api/runtime-capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            streaming: {
                                defaultMode: 'auto',
                                unavailableMarkScope: 'channel+backend+strategy+operation'
                            },
                            streamingBatch: { enabled: true, recommendedConcurrency: 2 },
                            channelQueue: { enabled: true, capacityPerCredential: 1 },
                            responsesImageBackend: { enabled: true, mode: 'experimental' },
                            channelRouting: {
                                strategy: 'round_robin',
                                requestModeControls: {
                                    global_env: 'OPENAI_UPSTREAM_REQUEST_MODES',
                                    channel_env_pattern: 'OPENAI_CHANNEL_N_REQUEST_MODES',
                                    agent_client_policy: 'diagnostics_only'
                                },
                                configuredRequestModes: ['images-non-stream', 'images-sse', 'responses-sse'],
                                effectiveRequestModes: ['images-non-stream', 'images-sse'],
                                effectiveRequestModesByChannel: [
                                    {
                                        channelId: 'images',
                                        requestModes: ['images-non-stream', 'images-sse']
                                    }
                                ]
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/proxy/api/agent/images/generate') {
                    if (request.headers['idempotency-key']) {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ images: [{ id: 'doctor-generate', filename: 'doctor.png' }] }));
                        return;
                    }
                    response.writeHead(400, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            error: {
                                code: 'idempotency_key_required',
                                message: 'missing key',
                                retryable: false
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/proxy/api/agent/image-requests') {
                    response.writeHead(400, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            error: {
                                code: 'idempotency_key_required',
                                message: 'missing key',
                                retryable: false
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/proxy/api/agent/jobs/images/generate') {
                    response.writeHead(400, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            error: {
                                code: 'idempotency_key_required',
                                message: 'missing key',
                                retryable: false
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const prefixedBaseUrl = `${baseUrl}/proxy`;
                const result = await runNodeCommandAsync(['scripts/agent-doctor.mjs'], {
                    env: {
                        ...process.env,
                        GPT_IMAGE_AGENT_TOKEN: undefined,
                        AGENT_API_TOKEN: 'doctor-token',
                        GPT_IMAGE_PLAYGROUND_URL: `${prefixedBaseUrl}/`
                    },
                    timeoutMs: 15_000
                });

                assert.equal(result.ok, true);
                const body = parseJsonPayload(result.stdout, 'agent doctor');
                assert.equal(body.ok, true);
                assert.equal(body.billable, false);
                assert.equal(body.summary.capabilities, 'ok');
                assert.equal(body.summary.runtime, 'ok');
                assert.equal(body.summary.state_backend, 'memory');
                assert.equal(body.summary.page_sse_auth_ready, false);
                assert.equal(body.summary.page_sse_declared_supported, true);
                assert.equal(body.summary.page_sse_real_smoke, 'skipped');
                assert.equal(body.summary.orchestration_generate_smoke, 'skipped');
                assert.equal(body.summary.agent_generate_smoke, 'skipped');
                assert.equal(body.summary.responses_page_sse_generate_smoke, 'skipped');
                assert.deepEqual(body.summary.real_smoke_checks, {
                    orchestration_generate_1k: 'skipped',
                    agent_generate_1k: 'skipped',
                    responses_page_sse_generate_1k: 'skipped',
                    responses_agent_generate_1k: 'skipped',
                    agent_edit_1k: 'skipped',
                    page_sse_edit_2k: 'skipped'
                });
                assert.deepEqual(body.summary.request_modes.supported, [
                    'images-non-stream',
                    'images-sse',
                    'images-json',
                    'responses-non-stream',
                    'responses-sse'
                ]);
                assert.deepEqual(body.summary.request_modes.configured, [
                    'images-non-stream',
                    'images-sse',
                    'responses-sse'
                ]);
                assert.deepEqual(body.summary.request_modes.effective, ['images-non-stream', 'images-sse']);
                assert.deepEqual(body.summary.request_modes.admin_whitelist_by_channel, [
                    { channel_id: 'images', request_modes: ['images-non-stream', 'images-sse'] },
                    { channel_id: 'responses', request_modes: ['responses-sse'] }
                ]);
                assert.deepEqual(body.summary.request_modes.effective_by_channel, [
                    { channel_id: 'images', request_modes: ['images-non-stream', 'images-sse'] }
                ]);
                assert.deepEqual(body.summary.request_modes.gaps, [
                    {
                        code: 'unrecognized_request_modes',
                        severity: 'warning',
                        request_modes: ['images-json'],
                        message: '服务返回了当前 Agent 未识别的 request mode；升级 skill 或确认服务端模式名称。'
                    },
                    {
                        code: 'configured_request_modes_not_effective',
                        severity: 'warning',
                        request_modes: ['responses-sse'],
                        message: '部分已配置 request mode 没有在 runtime 生效；检查对应渠道 key、健康状态和白名单。'
                    },
                    {
                        code: 'channels_without_effective_request_modes',
                        severity: 'warning',
                        channel_ids: ['responses'],
                        message: '部分渠道没有生效 request mode。'
                    }
                ]);
                assert.equal(body.summary.request_modes.suggested_channel_env_key, 'OPENAI_CHANNEL_N_REQUEST_MODES');
                assert.equal(body.summary.request_modes.suggested_effective_value, 'images-non-stream,images-sse');
                assert.match(body.summary.request_modes.next_action, /先修正未生效的渠道 request mode/);
                assert.deepEqual(body.summary.request_modes.smoke['responses-non-stream'].checks, [
                    'responses_agent_generate_1k'
                ]);
                assert.deepEqual(body.summary.request_modes.smoke['images-non-stream'].checks, [
                    'orchestration_generate_1k',
                    'edit_1k'
                ]);
                assert.equal(body.summary.request_modes.smoke['responses-non-stream'].state, 'skipped');
                assert.equal(body.summary.request_modes.smoke['responses-sse'].state, 'skipped');
                assert.equal(body.summary.request_modes.smoke['responses-sse'].billable, false);
                assert.equal(body.summary.responses_gpt2image_ready, true);
                assert.equal(body.summary.responses_image_backend_declared_supported, true);
                assert.deepEqual(body.summary.runtime_environment, {
                    state_backend: 'memory',
                    image_storage_mode: 'indexeddb',
                    tun_mode: 'unknown',
                    postgres_configured: false,
                    page_sse_auth_required: true,
                    agent_auth_schemes: [],
                    orchestration_endpoint: '/api/agent/image-requests',
                    orchestration_transport_selection: 'server_owned',
                    request_mode_control_policy: 'diagnostics_only',
                    request_mode_controls: {
                        global_env: 'OPENAI_UPSTREAM_REQUEST_MODES',
                        channel_env_pattern: 'OPENAI_CHANNEL_N_REQUEST_MODES',
                        agent_client_policy: 'diagnostics_only'
                    },
                    runtime_strategy: 'round_robin',
                    effective_request_modes: ['images-non-stream', 'images-sse'],
                    streaming_batch_enabled: true,
                    recommended_concurrency: 2,
                    channel_queue_enabled: true,
                    channel_queue_capacity_per_credential: 1
                });
                assert.equal(body.summary.billable_smoke, 'skipped');
                assert.equal(body.layers.find((layer) => layer.name === 'billable_smoke').skipped, true);
                assert.ok(
                    body.layers
                        .find((layer) => layer.name === 'billable_smoke')
                        .checks.some((check) => check.name === 'responses_agent_generate_1k' && check.skipped === true)
                );
                assert.equal(body.layers.find((layer) => layer.name === 'capabilities').executable_routing_rules, true);
                assert.deepEqual(body.layers.find((layer) => layer.name === 'capabilities').request_modes_supported, [
                    'images-non-stream',
                    'images-sse',
                    'images-json',
                    'responses-non-stream',
                    'responses-sse'
                ]);
                assert.deepEqual(
                    body.layers.find((layer) => layer.name === 'runtime_backend').effective_request_modes,
                    ['images-non-stream', 'images-sse']
                );
                assert.equal(
                    body.layers.find((layer) => layer.name === 'capabilities').page_sse_declared_supported,
                    true
                );
                assert.equal(body.layers.find((layer) => layer.name === 'capabilities').page_sse_auth_required, true);
                assert.equal(body.layers.find((layer) => layer.name === 'capabilities').page_sse_auth_ready, false);
                assert.equal(
                    body.layers.find((layer) => layer.name === 'responses_gpt2image_readiness').declared_supported,
                    true
                );
                assert.match(
                    body.layers.find((layer) => layer.name === 'responses_gpt2image_readiness').real_smoke_gate,
                    /gpt2image-responses-sse/
                );
                assert.deepEqual(
                    body.layers.find((layer) => layer.name === 'responses_gpt2image_readiness').real_smoke_gates,
                    [
                        'npm run smoke:image-upstream-real -- --env-file-if-exists .env.real-smoke.local --case sub2api-responses-json --allow-billable',
                        'npm run smoke:image-upstream-real -- --env-file-if-exists .env.real-smoke.local --case gpt2image-responses-sse --allow-billable'
                    ]
                );
                assert.match(
                    body.layers.find((layer) => layer.name === 'capabilities').page_sse_auth_next_action,
                    /GPT_IMAGE_APP_PASSWORD_HASH/
                );
                assert.equal(body.service_base_url, prefixedBaseUrl);
                assert.equal(body.service_base_url_source, 'GPT_IMAGE_PLAYGROUND_URL');
                assert.equal(body.interactive_confirmation_required, true);
            }
        );
    });

    it('uses an explicit base URL for agent:doctor billable smoke checks', async () => {
        const hits = [];
        await withServer(
            (request, response) => {
                hits.push(request.url);
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            defaults: { state_backend: 'memory' },
                            storage: { image_storage_mode: 'indexeddb', postgres_configured: false },
                            agent_streaming: { page_sse: { supported: true } },
                            agent_jobs: { supported: true },
                            orchestration: {
                                supported: true,
                                endpoint: '/api/agent/image-requests',
                                transport_selection: 'server_owned'
                            },
                            routing_rules: {
                                high_resolution_edit: {
                                    conditions: { operation: 'edit', max_edge: { operator: 'gt', value: 2048 } }
                                }
                            },
                            supported: {
                                image_backend_requirements: {
                                    'responses-image-generation': {
                                        supported: true,
                                        enabled: true,
                                        missing_env: []
                                    }
                                }
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/runtime-capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            streaming: {
                                defaultMode: 'auto',
                                unavailableMarkScope: 'channel+backend+strategy+operation'
                            },
                            streamingBatch: { enabled: true },
                            responsesImageBackend: { enabled: true, mode: 'experimental' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    if (request.headers['idempotency-key']) {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ images: [{ id: 'doctor-generate', filename: 'doctor.png' }] }));
                    } else {
                        response.writeHead(400, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                error: {
                                    code: 'idempotency_key_required',
                                    message: 'missing key',
                                    retryable: false
                                }
                            })
                        );
                    }
                    return;
                }
                if (request.url === '/api/images') {
                    (async () => {
                        const requestText = await readRequestText(request);
                        if (requestText.includes('contract check')) {
                            response.writeHead(400, { 'content-type': 'application/json' });
                            response.end(JSON.stringify({ error: 'clientRequestId 长度不能超过 128 个字符。' }));
                            return;
                        }
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'data: {"type":"completed","filename":"doctor-page-sse.png","path":"/api/image/doctor-page-sse.png","output_format":"png"}',
                                '',
                                'data: {"type":"done","client_request_id":"doctor-page-sse-request","images":[{"filename":"doctor-page-sse.png"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                    })().catch((error) => {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: error.message }));
                    });
                    return;
                }
                if (request.url === '/api/agent/image-requests') {
                    if (request.headers['idempotency-key']) {
                        response.writeHead(202, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                job: {
                                    id: 'doctor-orchestration-job',
                                    state: 'running',
                                    result_url: '/api/agent/jobs/doctor-orchestration-job/result',
                                    retry_after_seconds: 1
                                }
                            })
                        );
                    } else {
                        response.writeHead(400, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                error: {
                                    code: 'idempotency_key_required',
                                    message: 'missing key',
                                    retryable: false
                                }
                            })
                        );
                    }
                    return;
                }
                if (request.url === '/api/agent/jobs/doctor-orchestration-job/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'doctor-orchestration-job',
                            idempotency_key: 'agent-doctor-orchestration-generate',
                            cached: false,
                            images: [{ id: 'doctor-orchestration', filename: 'doctor-orchestration.png' }],
                            execution: {
                                transport: 'server_orchestrated',
                                endpoint: '/api/agent/image-requests',
                                route_mode: 'auto',
                                image_backend: 'images-api',
                                stream_mode: 'non_stream',
                                streaming_strategy: 'off',
                                channel_request_mode: 'images-non-stream',
                                channel_request_mode_fallback_applied: false
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/images/generate') {
                    response.writeHead(202, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            job: {
                                id: 'doctor-agent-job',
                                state: 'running',
                                result_url: '/api/agent/jobs/doctor-agent-job/result',
                                retry_after_seconds: 1
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/doctor-agent-job/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'doctor-agent-job',
                            idempotency_key: 'agent-doctor-agent-generate',
                            cached: false,
                            images: [{ id: 'doctor-agent', filename: 'doctor-agent.png' }],
                            execution: {
                                transport: 'agent_json',
                                endpoint: '/api/agent/jobs/images/generate',
                                route_mode: 'agent',
                                image_backend: 'images-api',
                                stream_mode: 'non_stream',
                                streaming_strategy: 'off',
                                channel_request_mode: 'images-non-stream',
                                channel_request_mode_fallback_applied: false
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runNodeCommandAsync(
                    ['scripts/agent-doctor.mjs', '--base-url', baseUrl, '--allow-billable'],
                    { timeoutMs: 15_000 }
                );

                assert.equal(result.ok, true);
                const body = parseJsonPayload(result.stdout, 'agent doctor');
                assert.equal(body.service_base_url_source, 'user_provided');
                assert.equal(body.interactive_confirmation_required, false);
                assert.equal(body.summary.page_sse_real_smoke, 'passed');
                assert.equal(body.summary.orchestration_generate_smoke, 'passed');
                assert.equal(body.summary.agent_generate_smoke, 'passed');
                assert.equal(body.summary.responses_page_sse_generate_smoke, 'passed');
                assert.equal(body.summary.responses_agent_generate_smoke, 'passed');
                assert.equal(body.summary.real_smoke_checks.orchestration_generate_1k, 'passed');
                assert.equal(body.summary.real_smoke_checks.agent_generate_1k, 'passed');
                assert.equal(body.summary.real_smoke_checks.responses_page_sse_generate_1k, 'passed');
                assert.equal(body.summary.real_smoke_checks.responses_agent_generate_1k, 'passed');
                assert.equal(body.summary.request_modes.smoke['images-non-stream'].state, 'passed');
                assert.equal(body.summary.request_modes.smoke['responses-non-stream'].state, 'passed');
                assert.equal(body.summary.request_modes.smoke['responses-sse'].state, 'passed');
                assert.equal(body.summary.real_smoke_checks.agent_edit_1k, 'skipped');
                assert.equal(body.summary.real_smoke_checks.page_sse_edit_2k, 'skipped');
                assert.ok(hits.includes('/api/agent/images/generate'));
                assert.ok(hits.includes('/api/agent/image-requests'));
                assert.ok(hits.includes('/api/images'));
            }
        );
    });

    it('reports failed agent:doctor page SSE smoke checks without hiding the failure', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            defaults: { state_backend: 'memory' },
                            storage: { image_storage_mode: 'indexeddb', postgres_configured: false },
                            orchestration: {
                                supported: true,
                                endpoint: '/api/agent/image-requests',
                                transport_selection: 'server_owned'
                            },
                            agent_streaming: { page_sse: { supported: true } },
                            agent_jobs: { supported: true },
                            routing_rules: {},
                            supported: {
                                request_modes: ['images-non-stream', 'responses-non-stream', 'responses-sse'],
                                image_backend_requirements: {
                                    'responses-image-generation': {
                                        supported: true,
                                        enabled: true,
                                        missing_env: []
                                    }
                                }
                            },
                            upstream_request_headers: {
                                channels: [
                                    {
                                        id: 'images',
                                        request_modes: ['images-non-stream']
                                    },
                                    {
                                        id: 'responses',
                                        request_modes: ['responses-non-stream', 'responses-sse']
                                    }
                                ]
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/runtime-capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            streaming: {
                                defaultMode: 'auto',
                                unavailableMarkScope: 'channel+backend+strategy+operation'
                            },
                            streamingBatch: { enabled: true },
                            responsesImageBackend: { enabled: true, mode: 'experimental' },
                            channelRouting: {
                                configuredRequestModes: ['images-non-stream', 'responses-non-stream', 'responses-sse'],
                                effectiveRequestModes: ['images-non-stream', 'responses-non-stream', 'responses-sse'],
                                effectiveRequestModesByChannel: [
                                    {
                                        channelId: 'images',
                                        requestModes: ['images-non-stream']
                                    },
                                    {
                                        channelId: 'responses',
                                        requestModes: ['responses-non-stream', 'responses-sse']
                                    }
                                ]
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ images: [{ id: 'doctor-generate', filename: 'doctor.png' }] }));
                    return;
                }
                if (request.url === '/api/agent/image-requests') {
                    if (request.headers['idempotency-key']) {
                        response.writeHead(202, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                job: {
                                    id: 'doctor-orchestration-job',
                                    state: 'running',
                                    result_url: '/api/agent/jobs/doctor-orchestration-job/result',
                                    retry_after_seconds: 1
                                }
                            })
                        );
                    } else {
                        response.writeHead(400, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                error: {
                                    code: 'idempotency_key_required',
                                    message: 'missing key',
                                    retryable: false
                                }
                            })
                        );
                    }
                    return;
                }
                if (request.url === '/api/agent/jobs/doctor-orchestration-job/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'doctor-orchestration-job',
                            idempotency_key: 'agent-doctor-orchestration-generate',
                            cached: false,
                            images: [{ id: 'doctor-orchestration', filename: 'doctor-orchestration.png' }],
                            execution: {
                                transport: 'server_orchestrated',
                                endpoint: '/api/agent/image-requests',
                                route_mode: 'auto',
                                image_backend: 'images-api',
                                stream_mode: 'non_stream',
                                streaming_strategy: 'off',
                                channel_request_mode: 'images-non-stream',
                                channel_request_mode_fallback_applied: false
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    (async () => {
                        const requestText = await readRequestText(request);
                        if (requestText.includes('contract check')) {
                            response.writeHead(400, { 'content-type': 'application/json' });
                            response.end(JSON.stringify({ error: 'clientRequestId 长度不能超过 128 个字符。' }));
                            return;
                        }
                        response.writeHead(503, { 'content-type': 'text/plain' });
                        response.end('503 Service temporarily unavailable');
                    })().catch((error) => {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: error.message }));
                    });
                    return;
                }
                if (request.url === '/api/agent/jobs/images/generate') {
                    response.writeHead(400, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            error: {
                                code: 'idempotency_key_required',
                                message: 'missing key',
                                retryable: false
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runNodeCommandAsync(
                    ['scripts/agent-doctor.mjs', '--base-url', baseUrl, '--allow-billable'],
                    { timeoutMs: 15_000 }
                );

                assert.equal(result.ok, false);
                const body = parseJsonPayload(result.stdout, 'agent doctor');
                assert.equal(body.ok, false);
                assert.equal(body.summary.billable_smoke, 'failed');
                assert.equal(body.summary.page_sse_real_smoke, 'failed');
                assert.equal(body.summary.orchestration_generate_smoke, 'passed');
                assert.equal(body.summary.agent_generate_smoke, 'passed');
                assert.equal(body.summary.responses_page_sse_generate_smoke, 'failed');
                assert.equal(body.summary.responses_agent_generate_smoke, 'passed');
                assert.equal(body.summary.real_smoke_checks.orchestration_generate_1k, 'passed');
                assert.equal(body.summary.real_smoke_checks.agent_generate_1k, 'passed');
                assert.equal(body.summary.real_smoke_checks.responses_page_sse_generate_1k, 'failed');
                assert.equal(body.summary.real_smoke_checks.responses_agent_generate_1k, 'passed');
                assert.equal(body.summary.request_modes.smoke['images-non-stream'].state, 'passed');
                assert.equal(body.summary.request_modes.smoke['responses-non-stream'].state, 'passed');
                assert.equal(body.summary.request_modes.smoke['responses-sse'].state, 'failed');
                assert.deepEqual(body.summary.request_modes.effective, [
                    'images-non-stream',
                    'responses-non-stream',
                    'responses-sse'
                ]);
                assert.equal(
                    body.summary.request_modes.suggested_effective_value,
                    'images-non-stream,responses-non-stream'
                );
                assert.deepEqual(
                    body.summary.request_modes.gaps.find((gap) => gap.code === 'request_mode_smoke_failed'),
                    {
                        code: 'request_mode_smoke_failed',
                        severity: 'critical',
                        request_modes: ['responses-sse'],
                        message: '真实 smoke 显示部分 request mode 不可用；不要写入渠道白名单。'
                    }
                );
                assert.equal(body.summary.real_smoke_checks.page_sse_edit_2k, 'skipped');
                const pageSseOutput = body.layers
                    .find((layer) => layer.name === 'billable_smoke')
                    .checks.find((check) => check.name === 'responses_page_sse_generate_1k').output;
                const pageSseFailure = parseJsonPayload(pageSseOutput, 'responses page SSE doctor smoke');
                assert.equal(pageSseFailure.summary.selected_channel_id, null);
                assert.equal(pageSseFailure.summary.upstream_host, null);
                assert.match(pageSseOutput, /503 Service temporarily unavailable/);
            }
        );
    });

    it('prints localized agent:doctor help and option errors', async () => {
        const help = await runNodeCommandAsync(['scripts/agent-doctor.mjs', '--help'], {
            env: process.env,
            timeoutMs: 5_000
        });
        assert.equal(help.ok, true);
        assert.match(help.stdout, /用法：/);
        assert.match(help.stdout, /真实 generate\/edit smoke/);
        assert.doesNotMatch(help.stdout, /Usage:/);

        const invalid = await runNodeCommandAsync(['scripts/agent-doctor.mjs', '--bad-option'], {
            env: process.env,
            timeoutMs: 5_000
        });
        assert.equal(invalid.ok, false);
        assert.match(invalid.stdout, /"ok": false/);
        assert.match(invalid.stdout, /未知参数：--bad-option/);
    });

    it('preserves raw child output for command consumers', () => {
        const result = runCommand(process.execPath, ['-e', 'process.stdout.write(" M README.md\\n")']);

        assert.equal(result.ok, true);
        assert.equal(result.stdout, ' M README.md\n');
    });

    it('parses JSON output after command preamble lines', () => {
        assert.deepEqual(parseJsonPayload('hint\n{"ok":true}', 'example'), { ok: true });
        assert.deepEqual(parseJsonPayload('hint\n{"ok":true}\ntrailing log', 'example'), { ok: true });
        assert.deepEqual(parseJsonPayload('[WARN] not json\n{"ok":true}', 'example'), { ok: true });
        assert.throws(() => parseJsonPayload('hint only', 'example'), /example did not return JSON output/);
        assert.throws(() => parseJsonPayload('hint\n{"ok":', 'example'), /example returned invalid JSON/);
    });

    it('times out local HTTP probes instead of hanging', async () => {
        const server = createServer(() => {});
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        try {
            assert.equal(typeof address, 'object');
            await assert.rejects(
                fetchJsonWithTimeout(`http://127.0.0.1:${address.port}/api/agent/capabilities`, { timeoutMs: 20 }),
                /timed out after 20ms/
            );
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('preserves invalid URL fetch errors while building timeout diagnostics', async () => {
        await assert.rejects(
            () => fetchJsonWithTimeout('not a url', { timeoutMs: 20 }),
            /Failed to parse URL|Invalid URL/i
        );
    });

    it('includes a response snippet when HTTP probes return non-JSON bodies', async () => {
        const server = createServer((request, response) => {
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end('<html>login page</html>');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        try {
            assert.equal(typeof address, 'object');
            await assert.rejects(
                fetchJsonWithTimeout(`http://127.0.0.1:${address.port}/api/agent/capabilities`, { timeoutMs: 1000 }),
                /did not return JSON: <html>login page<\/html>/
            );
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('redacts response snippets from production HTTP probe errors', async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const server = createServer((request, response) => {
            response.writeHead(502, { 'content-type': 'text/plain' });
            response.end('secret upstream body');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        try {
            assert.equal(typeof address, 'object');
            await assert.rejects(
                fetchJsonWithTimeout(`http://127.0.0.1:${address.port}/api/agent/capabilities`, { timeoutMs: 1000 }),
                (error) => {
                    assert.match(error.message, /failed with HTTP 502/);
                    assert.doesNotMatch(error.message, /secret upstream body/);
                    return true;
                }
            );
        } finally {
            if (originalNodeEnv === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = originalNodeEnv;
            }
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('supports command timeouts for long-running child processes', () => {
        const result = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 20 });

        assert.equal(result.ok, false);
        assert.equal(result.status, null);
        assert.match(result.error, /timed out|ETIMEDOUT|SIGTERM/i);
        assert.match(pickFailureOutput(result), /error:|signal:/);
    });

    it('includes spawn errors in failure summaries without stdout or stderr', () => {
        const summary = pickFailureOutput({ stdout: '', stderr: '', error: 'spawn missing ENOENT', signal: null });

        assert.equal(summary, 'error: spawn missing ENOENT');
    });

    it('includes non-zero exit status in failure summaries', () => {
        const summary = pickFailureOutput({ stdout: '', stderr: 'bad option', status: 129, signal: null });

        assert.equal(summary, 'bad option\nstatus: 129');
    });

    it('keeps local status usable when remote status JSON is malformed', () => {
        assert.deepEqual(readRemoteStatusFromResult({ ok: true, stdout: 'not json' }), {
            ok: false,
            error: 'hf spaces info did not return JSON output.'
        });
    });
});

async function withServer(handler, run) {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
        assert.equal(typeof address, 'object');
        assert.ok(address);
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function runNodeCommandAsync(args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, {
            cwd: options.cwd || process.cwd(),
            env: { GPT_IMAGE_AGENT_LOAD_ENV_FILE: '0', ...options.env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        const startedAt = Date.now();
        const timeout = options.timeoutMs
            ? setTimeout(() => {
                  child.kill('SIGTERM');
              }, options.timeoutMs)
            : undefined;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('close', (status, signal) => {
            if (timeout) clearTimeout(timeout);
            resolve({
                ok: status === 0,
                status,
                signal,
                stdout,
                stderr,
                elapsed_ms: Date.now() - startedAt
            });
        });
    });
}

async function writeExecutable(filepath, content) {
    await writeFile(filepath, content);
    await chmod(filepath, 0o755);
}

function readRequestText(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            body += chunk;
        });
        request.on('end', () => resolve(body));
        request.on('error', reject);
    });
}
