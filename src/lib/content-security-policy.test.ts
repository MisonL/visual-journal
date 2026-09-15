import { buildContentSecurityPolicy } from './content-security-policy';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('buildContentSecurityPolicy', () => {
    it('uses a request nonce instead of inline script allowances', () => {
        const policy = buildContentSecurityPolicy('nonce-value');

        assert.match(policy, /script-src 'self' 'nonce-nonce-value' 'strict-dynamic'/);
        assert.equal(policy.includes("script-src 'self' 'unsafe-inline'"), false);
        assert.equal(policy.includes("script-src 'self' 'unsafe-eval'"), false);
        assert.match(policy, /style-src 'self' 'unsafe-inline'/);
    });

    it('only enables eval for development builds', () => {
        assert.equal(buildContentSecurityPolicy('nonce-value').includes("'unsafe-eval'"), false);
        assert.equal(buildContentSecurityPolicy('nonce-value', true).includes("'unsafe-eval'"), true);
    });

    it('only allows localhost image and connection sources in development', () => {
        const productionPolicy = buildContentSecurityPolicy('nonce-value');
        const developmentPolicy = buildContentSecurityPolicy('nonce-value', true);

        assert.equal(productionPolicy.includes('http://localhost:*'), false);
        assert.match(developmentPolicy, /img-src[^;]*http:\/\/localhost:\*/);
        assert.match(developmentPolicy, /connect-src[^;]*http:\/\/localhost:\*/);
    });
});
