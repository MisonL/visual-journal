import { IMAGE_UPSTREAM_PROFILES } from './image-upstream-profile';
import {
    formatExactImagePixelCount,
    getPresetDimensions,
    getPresetTooltip,
    getSizePresetOptions,
    readImageSizeNumberInput,
    validateGptImage2Size,
    validatePositiveIntegerImageSize
} from './size-utils';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('size presets', () => {
    it('keeps legacy ratio presets stable for existing form state', () => {
        assert.equal(getPresetDimensions('square', 'gpt-image-1'), '1024x1024');
        assert.equal(getPresetDimensions('landscape', 'gpt-image-1'), '1536x1024');
        assert.equal(getPresetDimensions('portrait', 'gpt-image-1'), '1024x1536');
        assert.equal(getPresetDimensions('square', 'gpt-image-2'), '2048x2048');
        assert.equal(getPresetDimensions('landscape', 'gpt-image-2'), '3072x2048');
        assert.equal(getPresetDimensions('portrait', 'gpt-image-2'), '2048x3072');
    });

    it('adds profile-aware resolution presets for gpt-image-2', () => {
        const openAiOptions = getSizePresetOptions({
            model: 'gpt-image-2',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES['openai-compatible']
        }).map((option) => option.value);
        const matscaOptions = getSizePresetOptions({
            model: 'gpt-image-2',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        }).map((option) => option.value);

        assert.ok(openAiOptions.includes('square-1k'));
        assert.ok(openAiOptions.includes('square-2k'));
        assert.ok(openAiOptions.includes('wide-4k'));
        assert.ok(openAiOptions.includes('tall-4k'));
        assert.equal(openAiOptions.includes('square-4k'), false);
        assert.ok(matscaOptions.includes('square-4k'));
    });

    it('keeps the default 1K model alias on the gpt-image-2 preset path', () => {
        assert.equal(getPresetDimensions('landscape', 'gpt-image-2-1k'), '3072x2048');
        const options = getSizePresetOptions({
            model: 'gpt-image-2-1k',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES['openai-compatible']
        }).map((option) => option.value);
        assert.ok(options.includes('custom'));
        assert.ok(options.includes('wide-4k'));
    });

    it('does not expose gpt-image-2-only custom and resolution presets for legacy models', () => {
        const options = getSizePresetOptions({
            model: 'gpt-image-1',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        }).map((option) => option.value);

        assert.deepEqual(options, ['auto', 'square', 'landscape', 'portrait']);
    });

    it('reports common resolution preset tooltip ratios', () => {
        assert.match(getPresetTooltip('wide-4k', 'gpt-image-2') || '', /16:9/);
        assert.match(getPresetTooltip('tall-4k', 'gpt-image-2') || '', /9:16/);
        assert.match(getPresetTooltip('square-2k', 'gpt-image-2') || '', /1:1/);
    });
});

describe('image size numeric boundaries', () => {
    it('rejects dimensions outside the safe integer range for every gpt-image-2 policy', () => {
        const unsafeWidth = Number.MAX_SAFE_INTEGER + 1;

        const positiveIntegerResult = validatePositiveIntegerImageSize(unsafeWidth, 1);
        assert.equal(positiveIntegerResult.valid, false);
        if (!positiveIntegerResult.valid) assert.equal(positiveIntegerResult.reasonKey, 'sizeError.safeInteger');

        const openAiCompatibleResult = validateGptImage2Size(unsafeWidth, 1);
        assert.equal(openAiCompatibleResult.valid, false);
        if (!openAiCompatibleResult.valid) assert.equal(openAiCompatibleResult.reasonKey, 'sizeError.safeInteger');
    });

    it('keeps decimal dimensions distinct from unsafe integer dimensions', () => {
        const result = validatePositiveIntegerImageSize(12.5, 1);

        assert.equal(result.valid, false);
        if (!result.valid) assert.equal(result.reasonKey, 'sizeError.whole');
    });

    it('bounds provider-defined dimensions by edge and total pixels', () => {
        assert.equal(validatePositiveIntegerImageSize(4096, 4096).valid, true);

        const oversizedEdge = validatePositiveIntegerImageSize(8193, 1);
        assert.equal(oversizedEdge.valid, false);
        if (!oversizedEdge.valid) assert.equal(oversizedEdge.reasonKey, 'sizeError.maxEdge');

        assert.equal(validatePositiveIntegerImageSize(8192, 8192).valid, true);
    });

    it('preserves decimal input for validation instead of silently truncating it', () => {
        assert.equal(readImageSizeNumberInput('12.5'), 12.5);
        assert.equal(readImageSizeNumberInput('1e3'), 1000);
        assert.equal(readImageSizeNumberInput(''), 0);
    });

    it('formats large safe dimension products without losing precision', () => {
        const width = Number.MAX_SAFE_INTEGER;
        const expected = (BigInt(width) * BigInt(width)).toLocaleString('en-US');

        assert.equal(formatExactImagePixelCount(width, width, 'en-US'), expected);
        assert.equal(formatExactImagePixelCount(Number.MAX_SAFE_INTEGER + 1, 1, 'en-US'), null);
    });
});
