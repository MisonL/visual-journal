import { assertDockerComposeAccessPolicy, isLoopbackBindHost } from './docker-entrypoint.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Docker Compose access policy', () => {
    it('recognizes only loopback bind hosts as local-only', () => {
        for (const host of ['127.0.0.1', '127.0.12.34', 'localhost', '::1', '[::1]']) {
            assert.equal(isLoopbackBindHost(host), true, host);
        }
        for (const host of ['0.0.0.0', '10.0.90.200', '::', 'localhost.example.test']) {
            assert.equal(isLoopbackBindHost(host), false, host);
        }
    });

    it('allows standalone images and loopback Compose deployments without a page password', () => {
        assert.doesNotThrow(() => assertDockerComposeAccessPolicy({}));
        assert.doesNotThrow(() =>
            assertDockerComposeAccessPolicy({ VJ_COMPOSE_DEPLOYMENT: 'true', VJ_BIND_HOST: '127.0.0.1' })
        );
        // Legacy GIP_* names are still accepted so older Compose overrides and CI jobs keep working.
        assert.doesNotThrow(() =>
            assertDockerComposeAccessPolicy({ GIP_COMPOSE_DEPLOYMENT: 'true', GIP_BIND_HOST: '127.0.0.1' })
        );
    });

    it('prefers VJ_* over legacy GIP_* when both are set', () => {
        // New names win: a VJ_ loopback bind must not be rejected by a stale GIP_ 0.0.0.0.
        assert.doesNotThrow(() =>
            assertDockerComposeAccessPolicy({
                VJ_COMPOSE_DEPLOYMENT: 'true',
                VJ_BIND_HOST: '127.0.0.1',
                GIP_COMPOSE_DEPLOYMENT: 'true',
                GIP_BIND_HOST: '0.0.0.0'
            })
        );
    });

    it('rejects unauthenticated non-loopback Compose deployments', () => {
        assert.throws(
            () => assertDockerComposeAccessPolicy({ VJ_COMPOSE_DEPLOYMENT: 'true', VJ_BIND_HOST: '0.0.0.0' }),
            /APP_PASSWORD/
        );
        assert.throws(
            () => assertDockerComposeAccessPolicy({ VJ_COMPOSE_DEPLOYMENT: ' TRUE ', VJ_BIND_HOST: '0.0.0.0' }),
            /APP_PASSWORD/
        );
        assert.doesNotThrow(() =>
            assertDockerComposeAccessPolicy({
                VJ_COMPOSE_DEPLOYMENT: 'true',
                VJ_BIND_HOST: '10.0.90.200',
                APP_PASSWORD: 'access-code'
            })
        );
        assert.throws(
            () => assertDockerComposeAccessPolicy({ GIP_COMPOSE_DEPLOYMENT: 'true', GIP_BIND_HOST: '0.0.0.0' }),
            /APP_PASSWORD/
        );
    });
});
