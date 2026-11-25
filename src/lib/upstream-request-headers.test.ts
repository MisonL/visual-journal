import {
    buildDefaultUpstreamHeaders,
    mergeUpstreamHeadersWithFixed,
    normalizeConfiguredUpstreamHeaders,
    summarizeUpstreamRequestHeaders
} from './upstream-request-headers';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('upstream request headers', () => {
    it('uses a stable product User-Agent by default', () => {
        assert.deepEqual(buildDefaultUpstreamHeaders({}), {
            'User-Agent': 'visual-journal/2.4.0'
        });
    });

    it('allows an explicit environment User-Agent override', () => {
        assert.deepEqual(buildDefaultUpstreamHeaders({ OPENAI_UPSTREAM_USER_AGENT: ' custom-agent/1.0 ' }), {
            'User-Agent': 'custom-agent/1.0'
        });
    });

    it('keeps fixed protocol headers ahead of configured extras', () => {
        assert.deepEqual(
            mergeUpstreamHeadersWithFixed(
                {
                    'User-Agent': 'custom-agent/1.0',
                    Authorization: 'Bearer wrong',
                    Accept: 'text/plain',
                    'X-App-ID': 'app'
                },
                {
                    Authorization: 'Bearer right',
                    Accept: 'application/json'
                },
                {}
            ),
            {
                'User-Agent': 'custom-agent/1.0',
                'X-App-ID': 'app',
                Authorization: 'Bearer right',
                Accept: 'application/json'
            }
        );
    });

    it('filters proxy authentication from extra headers before dispatch', () => {
        const merged = mergeUpstreamHeadersWithFixed({ 'Proxy-Authorization': 'Basic c2VjcmV0' }, {}, {});

        assert.equal(new Headers(merged).has('proxy-authorization'), false);
    });

    it('rejects unsafe configurable protocol headers', () => {
        assert.throws(
            () =>
                normalizeConfiguredUpstreamHeaders(
                    { Authorization: 'Bearer secret' },
                    'OPENAI_CHANNEL_1_UPSTREAM_HEADERS_JSON'
                ),
            /不能配置 Authorization/
        );
        assert.throws(
            () =>
                normalizeConfiguredUpstreamHeaders(
                    { 'Content-Type': 'text/plain' },
                    'OPENAI_CHANNEL_1_UPSTREAM_HEADERS_JSON'
                ),
            /不能配置 Content-Type/
        );
        assert.throws(
            () =>
                normalizeConfiguredUpstreamHeaders(
                    { 'Idempotency-Key': 'same-key-for-every-request' },
                    'OPENAI_CHANNEL_1_UPSTREAM_HEADERS_JSON'
                ),
            /不能配置 Idempotency-Key/
        );
        assert.throws(
            () =>
                normalizeConfiguredUpstreamHeaders(
                    { 'Proxy-Authorization': 'Basic c2VjcmV0' },
                    'OPENAI_CHANNEL_1_UPSTREAM_HEADERS_JSON'
                ),
            /不能配置 Proxy-Authorization/
        );
    });

    it('summarizes request headers without exposing secret values', () => {
        assert.deepEqual(
            summarizeUpstreamRequestHeaders(
                {
                    'User-Agent': 'custom-agent/1.0',
                    'X-App-ID': 'app-id',
                    'X-App-Secret': 'secret'
                },
                {}
            ),
            {
                user_agent_effective: 'custom-agent/1.0',
                has_extra_headers: true,
                allowed_header_names: ['user-agent', 'x-app-id', 'x-app-secret'],
                configured_header_names: ['user-agent', 'x-app-id', 'x-app-secret']
            }
        );
    });
});
