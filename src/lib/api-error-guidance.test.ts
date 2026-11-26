import {
    classifyApiErrorCode,
    buildApiErrorNotice,
    buildBatchPartialFailureMessage,
    buildUserFacingApiErrorMessage,
    superApiReferralUrl
} from './api-error-guidance';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

it('normalizes symbolic upstream balance errors', () => {
    assert.equal(classifyApiErrorCode('INSUFFICIENT_BALANCE', '余额不足'), 'upstream_quota_exhausted');
});

it('normalizes transport response-format errors to upstream availability', () => {
    assert.equal(classifyApiErrorCode('upstream_response_format', '上游返回 HTML 页面'), 'upstream_unavailable');
});

it('classifies upstream content-safety rejections instead of validation errors', () => {
    const realUpstreamMessage =
        '400 Your request was rejected by the safety system. If you believe this is an error, contact us at help.openai.com and include the request ID f0d5e5f0-59d5-4ef3-832f-a872850c8f41.';
    assert.equal(classifyApiErrorCode(undefined, realUpstreamMessage), 'upstream_content_policy');
    assert.equal(
        classifyApiErrorCode(undefined, '400 Your prompt was rejected by the content policy.'),
        'upstream_content_policy'
    );
    assert.equal(classifyApiErrorCode(undefined, '内容审核未通过'), 'upstream_content_policy');
    // 普通校验错误不应误判为内容策略。
    assert.equal(classifyApiErrorCode(undefined, 'prompt 必须是非空文本。'), undefined);
});

it('classifies exhausted healthy-channel selection separately from validation errors', () => {
    assert.equal(classifyApiErrorCode(undefined, '当前没有支持 images-sse 的健康渠道凭证。'), 'channel_unavailable');
    assert.equal(
        classifyApiErrorCode(undefined, '当前没有支持模型 custom-image 的健康渠道凭证。'),
        'channel_unavailable'
    );
    assert.equal(classifyApiErrorCode(undefined, 'prompt 必须是非空文本。'), undefined);
});

const translate = (key: string, values?: Record<string, string | number>) => {
    const messages: Record<string, string> = {
        'error.apiFailedWithAdvice': '{message}。建议：{advice}',
        'error.adviceAuth': '检查 API Key、访问码或渠道权限。',
        'error.adviceQuota': '上游渠道余额不足，请充值或切换可用渠道后重试。',
        'error.adviceContentPolicy': '改写提示词后重试；重试相同提示词不会通过。',
        'error.adviceChannelUnavailable': '当前没有健康的图片渠道，请等待恢复探测或切换渠道配置。',
        'error.adviceValidation': '请修正请求参数后再试；这类错误不会通过重试解决。',
        'error.adviceRateLimit': '请求被限流。请稍后重试，或降低并发和图片数量。',
        'error.adviceUpstream': '上游或 API 中转站异常。请稍后重试，或切换可用渠道。',
        'error.adviceCloudflare':
            '4K 或高分辨率出图可能超过 Cloudflare 100 秒限制。请降低分辨率，或改用支持 4K 流式出图的 API 中转站：{url}',
        'error.batchPartialFailureDetailed': '批量生成部分失败：{failed}/{total} 个任务失败。失败明细：{reasons}'
    };
    return (messages[key] || key).replace(/\{(\w+)\}/g, (match, valueKey) => String(values?.[valueKey] ?? match));
};

describe('buildUserFacingApiErrorMessage', () => {
    it('adds credential advice for authentication and authorization failures', () => {
        const message = buildUserFacingApiErrorMessage({
            message: '未授权',
            status: 401,
            t: translate
        });

        assert.match(message, /检查 API Key、访问码或渠道权限/);
    });

    it('adds rate-limit advice for 429 failures', () => {
        const message = buildUserFacingApiErrorMessage({
            message: 'Too many requests',
            status: 429,
            t: translate
        });

        assert.match(message, /请求被限流/);
        assert.match(message, /降低并发和图片数量/);
    });

    it('gives quota and channel-specific advice', () => {
        assert.match(
            buildUserFacingApiErrorMessage({
                message: '上游渠道余额不足。',
                status: 403,
                code: 'upstream_quota_exhausted',
                t: translate
            }),
            /余额不足/
        );
        assert.match(
            buildUserFacingApiErrorMessage({
                message: '没有健康渠道。',
                status: 503,
                code: 'channel_unavailable',
                t: translate
            }),
            /没有健康的图片渠道/
        );
    });

    it('adds rephrase advice for upstream content-safety rejections', () => {
        const message = buildUserFacingApiErrorMessage({
            message: '提示词被上游内容安全策略拒绝，未生成图片。',
            status: 400,
            code: 'upstream_content_policy',
            t: translate
        });

        assert.match(message, /改写提示词/);
        assert.doesNotMatch(message, /修正请求参数/);
    });

    it('adds Cloudflare advice with the configured referral link for 524 failures', () => {
        const message = buildUserFacingApiErrorMessage({
            message: 'API 请求失败，状态码 524',
            status: 524,
            t: translate
        });

        assert.match(message, /Cloudflare 100 秒限制/);
        assert.match(message, new RegExp(superApiReferralUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('adds upstream advice for non-524 gateway failures', () => {
        const message = buildUserFacingApiErrorMessage({
            message: 'Bad Gateway',
            status: 502,
            t: translate
        });

        assert.match(message, /上游或 API 中转站异常/);
    });
});

describe('buildBatchPartialFailureMessage', () => {
    it('includes every failure reason instead of only counts', () => {
        const message = buildBatchPartialFailureMessage({
            failed: 2,
            total: 4,
            errors: [
                { message: 'API 请求失败，状态码 429', status: 429 },
                { message: 'API 请求失败，状态码 524', status: 524 }
            ],
            t: translate
        });

        assert.match(message, /2\/4/);
        assert.match(message, /状态码 429/);
        assert.match(message, /请求被限流/);
        assert.match(message, /状态码 524/);
        assert.match(message, /Cloudflare 100 秒限制/);
        assert.match(message, new RegExp(superApiReferralUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
});

describe('buildApiErrorNotice', () => {
    it('keeps API error messages as text without injecting vendor links', () => {
        const notice = buildApiErrorNotice('建议降低分辨率或切换渠道。');

        assert.equal(notice.message, '建议降低分辨率或切换渠道。');
        assert.deepEqual(notice.links, []);
    });
});
