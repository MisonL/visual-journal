import {
    buildMatscaAppHeaders,
    combineImageUpstreamProfiles,
    getImageCountRangeForBackend,
    getPartialImagesRangeForBackend,
    IMAGE_UPSTREAM_PROFILES,
    readImageUpstreamProfile,
    summarizeImageUpstreamProfile
} from './image-upstream-profile';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('readImageUpstreamProfile', () => {
    it('recognizes Matsca by explicit profile, channel id, and official base URL', () => {
        assert.equal(readImageUpstreamProfile({ explicitProfile: 'matsca' }).id, 'matsca');
        assert.equal(readImageUpstreamProfile({ channelId: 'matsca' }).id, 'matsca');
        assert.equal(readImageUpstreamProfile({ baseUrl: 'https://img.matsca.com/v1' }).id, 'matsca');
    });

    it('keeps non-Matsca sources on the OpenAI-compatible profile', () => {
        assert.equal(readImageUpstreamProfile({ baseUrl: 'https://api.openai.com/v1' }).id, 'openai-compatible');
        assert.equal(readImageUpstreamProfile({ baseUrl: 'https://matsca.example.com/v1' }).id, 'openai-compatible');
        assert.deepEqual(IMAGE_UPSTREAM_PROFILES['openai-compatible'].partialImages, { min: 1, max: 3 });
    });

    it('rejects invalid explicit profiles instead of silently falling back', () => {
        assert.throws(() => readImageUpstreamProfile({ explicitProfile: 'unknown' }), /不支持的图片上游 profile/);
    });
});

describe('buildMatscaAppHeaders', () => {
    it('requires Matsca app id and secret as a pair', () => {
        assert.deepEqual(buildMatscaAppHeaders({ appId: ' app ', appSecret: ' secret ' }), {
            'X-App-ID': 'app',
            'X-App-Secret': 'secret'
        });
        assert.equal(buildMatscaAppHeaders({}), undefined);
        assert.throws(() => buildMatscaAppHeaders({ appId: 'app' }), /必须同时配置/);
        assert.throws(() => buildMatscaAppHeaders({ appSecret: 'secret' }), /必须同时配置/);
    });
});

describe('backend-specific image limits', () => {
    it('keeps Responses image_generation to one image and one to three previews', () => {
        const profile = IMAGE_UPSTREAM_PROFILES.matsca;

        assert.deepEqual(getImageCountRangeForBackend(profile, 'generate', 'images-api'), { min: 1, max: 4 });
        assert.deepEqual(getImageCountRangeForBackend(profile, 'edit', 'images-api'), { min: 1, max: 4 });
        assert.deepEqual(getImageCountRangeForBackend(profile, 'generate', 'responses-image-generation'), {
            min: 1,
            max: 1
        });
        assert.deepEqual(getImageCountRangeForBackend(profile, 'edit', 'responses-image-generation'), {
            min: 1,
            max: 1
        });
        assert.deepEqual(
            getImageCountRangeForBackend(profile, 'generate', 'server-default', 'responses-image-generation'),
            { min: 1, max: 1 }
        );
        assert.deepEqual(getPartialImagesRangeForBackend(profile, 'responses-image-generation'), { min: 1, max: 3 });
        assert.deepEqual(getPartialImagesRangeForBackend(profile, 'server-default', 'responses-image-generation'), {
            min: 1,
            max: 3
        });
        assert.deepEqual(getPartialImagesRangeForBackend(profile, 'server-default'), { min: 0, max: 4 });
    });

    it('rejects a Responses backend when the upstream count range has no overlap', () => {
        const profile = {
            ...IMAGE_UPSTREAM_PROFILES['openai-compatible'],
            generateCount: { min: 2, max: 2 },
            editCount: { min: 2, max: 2 }
        };

        assert.throws(
            () => getImageCountRangeForBackend(profile, 'generate', 'responses-image-generation'),
            /图片数量范围没有可用交集/
        );
        assert.throws(
            () => getImageCountRangeForBackend(profile, 'edit', 'responses-image-generation'),
            /图片数量范围没有可用交集/
        );
    });
});

describe('summarizeImageUpstreamProfile', () => {
    it('lets a request Matsca URL drive client-side constraints without waiting for server profile metadata', () => {
        const summary = summarizeImageUpstreamProfile({
            requestApiBaseUrl: 'https://img.matsca.com/v1',
            serverProfileIds: []
        });

        assert.equal(summary.activeProfile, 'matsca');
        assert.equal(summary.serverProfile, 'openai-compatible');
        assert.equal(summary.serverProfileMixed, false);
        assert.equal(summary.requestProfile, 'matsca');
        assert.equal(summary.activeConstraints.id, 'matsca');
        assert.equal(summary.serverConstraints.id, 'openai-compatible');
        assert.equal(summary.requestConstraints.id, 'matsca');
        assert.equal(summary.activeConstraints.upload.maxImages, 8);
    });

    it('uses the single server profile only when the request does not override the upstream URL', () => {
        const summary = summarizeImageUpstreamProfile({
            serverProfileIds: ['matsca']
        });

        assert.equal(summary.activeProfile, 'matsca');
        assert.equal(summary.serverProfile, 'matsca');
        assert.equal(summary.serverProfileMixed, false);
        assert.equal(summary.requestProfile, 'openai-compatible');
        assert.equal(summary.activeConstraints.id, 'matsca');
        assert.equal(summary.serverConstraints.id, 'matsca');
        assert.equal(summary.requestConstraints.id, 'openai-compatible');
        assert.equal(summary.activeConstraints.generateCount.max, 4);
    });

    it('uses conservative intersection constraints for mixed server pools', () => {
        const summary = summarizeImageUpstreamProfile({
            serverProfileIds: ['matsca', 'openai-compatible']
        });

        assert.equal(summary.activeProfile, 'openai-compatible');
        assert.equal(summary.serverProfile, 'openai-compatible');
        assert.equal(summary.serverProfileMixed, true);
        assert.equal(summary.requestProfile, 'openai-compatible');
        assert.equal(summary.activeConstraints.id, 'openai-compatible');
        assert.equal(summary.activeConstraints.generateCount.max, 4);
        assert.equal(summary.activeConstraints.editCount.max, 4);
        assert.equal(summary.activeConstraints.upload.maxImages, 8);
        assert.equal(summary.activeConstraints.upload.maxSingleBytes, 10 * 1024 * 1024);
        assert.equal(summary.activeConstraints.upload.maxTotalBytes, 80 * 1024 * 1024);
        assert.deepEqual(summary.activeConstraints.partialImages, { min: 1, max: 3 });
        assert.equal(summary.activeConstraints.gptImage2.sizePolicy, 'openai-compatible');
        assert.equal(summary.activeConstraints.gptImage2.allowTransparentBackground, false);
    });

    it('treats same-id provider constraint differences as a mixed server pool', () => {
        const summary = summarizeImageUpstreamProfile({
            serverProfiles: [
                IMAGE_UPSTREAM_PROFILES['openai-compatible'],
                {
                    ...IMAGE_UPSTREAM_PROFILES['openai-compatible'],
                    generateCount: { min: 1, max: 2 },
                    upload: {
                        maxImages: 3,
                        maxSingleBytes: 10 * 1024 * 1024
                    }
                }
            ]
        });

        assert.equal(summary.activeProfile, 'openai-compatible');
        assert.equal(summary.serverProfile, 'openai-compatible');
        assert.equal(summary.serverProfileMixed, true);
        assert.deepEqual(summary.activeConstraints.generateCount, { min: 1, max: 2 });
        assert.equal(summary.activeConstraints.upload.maxImages, 3);
        assert.equal(summary.activeConstraints.upload.maxSingleBytes, 10 * 1024 * 1024);
    });

    it('keeps mixed server capabilities valid when a range has no common value', () => {
        const fixedOne = {
            ...IMAGE_UPSTREAM_PROFILES['openai-compatible'],
            generateCount: { min: 1, max: 1 }
        };
        const fixedTwo = {
            ...IMAGE_UPSTREAM_PROFILES['openai-compatible'],
            generateCount: { min: 2, max: 2 }
        };

        const summary = summarizeImageUpstreamProfile({ serverProfiles: [fixedOne, fixedTwo] });

        assert.equal(summary.serverProfileMixed, true);
        assert.equal(summary.serverConstraintsMixed, true);
        assert.deepEqual(summary.serverConstraintsByProfile, [fixedOne, fixedTwo]);
        assert.ok(summary.serverConstraints.generateCount.min <= summary.serverConstraints.generateCount.max);
        assert.deepEqual(summary.serverConstraints.generateCount, { min: 1, max: 2 });
    });

    it('preserves gaps when mixed server count ranges are unioned', () => {
        const fixedOne = {
            ...IMAGE_UPSTREAM_PROFILES['openai-compatible'],
            generateCount: { min: 1, max: 1 }
        };
        const fixedThree = {
            ...IMAGE_UPSTREAM_PROFILES['openai-compatible'],
            generateCount: { min: 3, max: 3 }
        };

        const summary = summarizeImageUpstreamProfile({ serverProfiles: [fixedOne, fixedThree] });

        assert.deepEqual(summary.serverConstraints.generateCount, {
            min: 1,
            max: 3,
            allowedValues: [1, 3]
        });
    });
});

describe('output dimension policy', () => {
    it('keeps built-in profiles on the strict requested contract', () => {
        assert.equal(IMAGE_UPSTREAM_PROFILES['openai-compatible'].outputDimensions, 'requested');
        assert.equal(IMAGE_UPSTREAM_PROFILES.matsca.outputDimensions, 'requested');
    });

    it('only relaxes the merged profile when every channel is upstream_controlled', () => {
        const relaxed = combineImageUpstreamProfiles([
            { ...IMAGE_UPSTREAM_PROFILES['openai-compatible'], outputDimensions: 'upstream_controlled' },
            { ...IMAGE_UPSTREAM_PROFILES['openai-compatible'], outputDimensions: 'upstream_controlled' }
        ]);
        assert.equal(relaxed.outputDimensions, 'upstream_controlled');

        // 只要有一个渠道保证按请求尺寸，整体就必须保持严格，不能被放宽的渠道带偏。
        const mixed = combineImageUpstreamProfiles([
            { ...IMAGE_UPSTREAM_PROFILES['openai-compatible'], outputDimensions: 'upstream_controlled' },
            { ...IMAGE_UPSTREAM_PROFILES['openai-compatible'], outputDimensions: 'requested' }
        ]);
        assert.equal(mixed.outputDimensions, 'requested');
    });
});
