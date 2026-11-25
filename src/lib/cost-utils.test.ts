import {
    calculateApiCost,
    getModelRates,
    GPT_IMAGE_MODELS,
    isGptImage25Model,
    isGptImage26Model,
    isGptImage2Model,
    isGptImageModel,
    isNonNegativeFiniteNumber,
    isNonNegativeSafeInteger,
    isValidCostDetails,
    RATED_IMAGE_MODELS
} from './cost-utils';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('cost-utils', () => {
    it('uses the shared model-rate table for every supported image model and accepts custom names', () => {
        for (const model of GPT_IMAGE_MODELS) {
            const rates = getModelRates(model);

            assert.equal(isGptImageModel(model), true);
            assert.ok(rates);
            assert.ok(rates.textInputPerToken > 0);
            assert.ok(rates.imageInputPerToken > 0);
            assert.ok(rates.imageOutputPerToken > 0);
        }
        assert.equal(isGptImageModel('custom-image-model'), true);
        assert.equal(getModelRates('custom-image-model'), null);
        assert.equal(isGptImage2Model('gpt-image-2'), true);
        assert.equal(isGptImage2Model('gpt-image-2-1k'), true);
        assert.equal(isGptImage2Model('gpt-image-1.5'), false);
    });

    it('accepts only finite nonnegative usage and cost values', () => {
        assert.equal(isNonNegativeFiniteNumber(0), true);
        assert.equal(isNonNegativeFiniteNumber(1.25), true);
        assert.equal(isNonNegativeFiniteNumber(-1), false);
        assert.equal(isNonNegativeFiniteNumber(Number.NaN), false);
        assert.equal(isNonNegativeFiniteNumber(Number.POSITIVE_INFINITY), false);
        assert.equal(isNonNegativeSafeInteger(0), true);
        assert.equal(isNonNegativeSafeInteger(1.25), false);
        assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER), true);
        assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1), false);

        assert.equal(
            isValidCostDetails({
                estimated_cost_usd: 0.03,
                text_input_tokens: 100,
                image_input_tokens: 0,
                image_output_tokens: 500
            }),
            true
        );
        assert.equal(
            isValidCostDetails({
                estimated_cost_usd: Number.NaN,
                text_input_tokens: 100,
                image_input_tokens: 0,
                image_output_tokens: 500
            }),
            false
        );
    });

    it('calculates a rounded local estimate with the selected model rate', () => {
        assert.deepEqual(
            calculateApiCost(
                {
                    input_tokens_details: { text_tokens: 100, image_tokens: 200 },
                    output_tokens: 1000
                },
                'gpt-image-2'
            ),
            {
                estimated_cost_usd: 0.0321,
                text_input_tokens: 100,
                image_input_tokens: 200,
                image_output_tokens: 1000
            }
        );
    });

    it('rejects malformed or overflowed usage instead of returning a misleading estimate', () => {
        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            for (const outputTokens of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_VALUE]) {
                assert.equal(
                    calculateApiCost(
                        {
                            input_tokens_details: { text_tokens: 100, image_tokens: 0 },
                            output_tokens: outputTokens
                        },
                        'gpt-image-2'
                    ),
                    null
                );
            }
        } finally {
            console.error = originalConsoleError;
        }
    });
});

describe('gpt-image-2.6 rates', () => {
    it('shares the 2.5 token tiers because the official model pages list identical rates', () => {
        for (const model of ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']) {
            const rates = getModelRates(model);
            assert.ok(rates, `${model} 必须有费率，否则成本面板会静默留空`);
            assert.equal(rates.imageOutputPerMillion, 30);
            assert.equal(rates.imageInputPerMillion, 8);
            assert.equal(rates.textInputPerMillion, 5);
        }
        assert.deepEqual(getModelRates('gpt-image-2.6-flare'), getModelRates('gpt-image-2.5-flare'));
    });

    it('is rated and recognized as the newest family', () => {
        assert.ok((RATED_IMAGE_MODELS as readonly string[]).includes('gpt-image-2.6-flare'));
        assert.equal(isGptImage26Model('gpt-image-2.6-sunburst'), true);
        assert.equal(isGptImage26Model('gpt-image-2.5-sunburst'), false);
        assert.equal(isGptImage25Model('gpt-image-2.6-sunburst'), false);
    });
});
