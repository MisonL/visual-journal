import {
    IMAGE_MODEL_FAMILIES,
    normalizeImageModelId,
    readFamilyQualityTiers,
    readImageModelLifecycle,
    resolveImageModelFamily,
    toDirectorySizePolicy
} from './image-model-family';
import { getPresetDimensions, supportsCustomImageSize } from './size-utils';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('image model families', () => {
    it('resolves OpenAI image models to their own families', () => {
        assert.equal(resolveImageModelFamily('gpt-image-2').id, 'openai-gpt-image-2');
        assert.equal(resolveImageModelFamily('gpt-image-2-1k').id, 'openai-gpt-image-2');
        assert.equal(resolveImageModelFamily('gpt-image-1').id, 'openai-gpt-image-1');
        assert.equal(resolveImageModelFamily('gpt-image-1-mini').id, 'openai-gpt-image-1');
        assert.equal(resolveImageModelFamily('gpt-image-1.5').id, 'openai-gpt-image-1');
        assert.equal(resolveImageModelFamily('gpt-image-2.5').id, 'openai-gpt-image-2.5');
    });

    it('matches versioned members of a family through prefix rules', () => {
        assert.equal(resolveImageModelFamily('gpt-image-2.5-flare').id, 'openai-gpt-image-2.5');
        assert.equal(resolveImageModelFamily('gpt-image-2.5-sunburst').id, 'openai-gpt-image-2.5');
        assert.equal(resolveImageModelFamily('gemini-3.1-flash-image').id, 'google-gemini-image');
        assert.equal(resolveImageModelFamily('flux-1.1-pro').id, 'bfl-flux');
        assert.equal(resolveImageModelFamily('seedream-4').id, 'bytedance-seedream');
        assert.equal(resolveImageModelFamily('qwen-image-plus').id, 'alibaba-qwen-image');
        assert.equal(resolveImageModelFamily('dall-e-3').id, 'openai-dall-e');
        assert.equal(resolveImageModelFamily('sdxl-turbo').id, 'stability-diffusion');
    });

    it('falls back to the custom family for unregistered models', () => {
        assert.equal(resolveImageModelFamily('my-private-image-model').id, 'custom');
        assert.equal(resolveImageModelFamily(undefined).id, 'custom');
        assert.equal(resolveImageModelFamily('').id, 'custom');
        assert.equal(resolveImageModelFamily('my-private-image-model').sizePolicy, 'provider_defined');
    });

    it('normalizes model ids before matching', () => {
        assert.equal(normalizeImageModelId('  GPT-Image-2.5  '), 'gpt-image-2.5');
        assert.equal(resolveImageModelFamily('  GPT-Image-2.5-FLARE ').id, 'openai-gpt-image-2.5');
        assert.equal(resolveImageModelFamily(null).id, 'custom');
    });

    it('maps every size policy onto a directory policy', () => {
        assert.equal(toDirectorySizePolicy('legacy_allowlist'), 'legacy_allowlist');
        assert.equal(toDirectorySizePolicy('provider_defined'), 'provider_defined');
        assert.equal(toDirectorySizePolicy('openai_compatible'), 'provider_defined');
    });

    it('keeps the registry internally consistent', () => {
        const ids = new Set<string>();
        for (const family of IMAGE_MODEL_FAMILIES) {
            assert.equal(ids.has(family.id), false, `重复的族 id：${family.id}`);
            ids.add(family.id);
            assert.ok(family.label.trim().length > 0, `${family.id} 缺少展示名`);
            if (family.sizePolicy === 'legacy_allowlist') {
                assert.ok(family.legacySizes && family.legacySizes.length > 0, `${family.id} 缺少 legacySizes`);
                assert.ok(family.legacySizes.includes('auto'), `${family.id} 的 legacySizes 应包含 auto`);
            }
            for (const preset of family.recommendedPresets ?? []) {
                assert.match(preset.size, /^\d+x\d+$/, `${family.id} 的预设尺寸格式不合法`);
            }
            // 精确 id 必须能解析回自己
            for (const exactId of family.exactIds) {
                assert.equal(resolveImageModelFamily(exactId).id, family.id);
            }
        }
    });

    it('drives legacy size gating from the family table', () => {
        // gpt-image-1 系仍是 legacy 白名单，不接受自定义尺寸
        assert.equal(supportsCustomImageSize('gpt-image-1'), false);
        assert.equal(supportsCustomImageSize('gpt-image-1.5'), false);
        // gpt-image-2 系、2.5 系、第三方主流模型与未登记模型都接受自定义尺寸
        for (const model of [
            'gpt-image-2',
            'gpt-image-2-1k',
            'gpt-image-2.5',
            'gpt-image-2.5-flare',
            'gemini-3.1-flash-image',
            'flux-1.1-pro',
            'seedream-4',
            'my-private-image-model'
        ]) {
            assert.equal(supportsCustomImageSize(model), true, `${model} 应支持自定义尺寸`);
        }
    });

    it('derives ratio presets per family instead of hardcoding gpt-image-2', () => {
        assert.equal(getPresetDimensions('square', 'gpt-image-2'), '2048x2048');
        assert.equal(getPresetDimensions('landscape', 'gpt-image-2'), '3072x2048');
        assert.equal(getPresetDimensions('square', 'gpt-image-1'), '1024x1024');
        // gpt-image-2.5 按官方文档推荐 1K 三档
        assert.equal(getPresetDimensions('square', 'gpt-image-2.5'), '1024x1024');
        assert.equal(getPresetDimensions('landscape', 'gpt-image-2.5-flare'), '1536x1024');
        assert.equal(getPresetDimensions('portrait', 'gpt-image-2.5-sunburst'), '1024x1536');
        assert.equal(getPresetDimensions('landscape', 'gemini-3.1-flash-image'), '1344x768');
        assert.equal(getPresetDimensions('portrait', 'flux-1.1-pro'), '768x1344');
        // 未登记模型保持既有 1K 默认值，避免改变旧行为
        assert.equal(getPresetDimensions('square', 'my-private-image-model'), '1024x1024');
        assert.equal(getPresetDimensions('auto', 'gpt-image-2'), null);
        assert.equal(getPresetDimensions('custom', 'gpt-image-2'), null);
    });
});

describe('newest vendor families', () => {
    it('routes gpt-image-2.6 to its own family instead of falling back to custom', () => {
        // 2.6 官方没有日期化快照，前缀匹配不能要求 -YYYY-MM-DD 结尾。
        assert.equal(resolveImageModelFamily('gpt-image-2.6-flare').id, 'openai-gpt-image-2.6');
        assert.equal(resolveImageModelFamily('gpt-image-2.6-sunburst').id, 'openai-gpt-image-2.6');
        assert.equal(resolveImageModelFamily('gpt-image-2.5-flare').id, 'openai-gpt-image-2.5');
    });

    it('keeps 2.6 openai_compatible but does not leak its extra capabilities to older models', () => {
        const next = resolveImageModelFamily('gpt-image-2.6-flare');
        assert.equal(next.sizePolicy, 'openai_compatible');
        assert.deepEqual(next.extendedQualityTiers, ['xhigh', 'max']);
        assert.equal(next.supportsComplexity, true);
        assert.equal(next.supportsMarkupEdits, true);
        assert.deepEqual(next.extraOutputFormats, ['svg', 'gif']);

        // 2 及更早的族不能被带上 2.6 的能力。
        const older = resolveImageModelFamily('gpt-image-2');
        assert.equal(older.supportsComplexity, undefined);
        assert.equal(older.extraOutputFormats, undefined);
        assert.equal(older.extendedQualityTiers, undefined);
    });

    it('registers xAI grok-imagine as its own provider_defined family', () => {
        assert.equal(resolveImageModelFamily('grok-imagine').id, 'xai-grok-imagine');
        assert.equal(resolveImageModelFamily('grok-imagine-edit').id, 'xai-grok-imagine');
        assert.equal(resolveImageModelFamily('grok-imagine-image-2').id, 'xai-grok-imagine');
        assert.equal(resolveImageModelFamily('grok-imagine').sizePolicy, 'provider_defined');
    });

    it('registers z-image without guessing its vendor-specific constraints', () => {
        const family = resolveImageModelFamily('z-image');
        assert.equal(family.id, 'z-image');
        assert.equal(family.sizePolicy, 'provider_defined');
        // 未核实的能力一律保持 null/undefined，不预先承诺。
        assert.equal(family.allowTransparentBackground, null);
    });
});

describe('quality tier declarations', () => {
    const BASE = ['low', 'medium', 'high', 'auto'] as const;
    const ALL = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;

    it('adds extended tiers only for families that declare them', () => {
        assert.deepEqual(readFamilyQualityTiers('gpt-image-2.6-flare', BASE, ALL), [
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
            'auto'
        ]);
        assert.deepEqual(readFamilyQualityTiers('gpt-image-2.5-sunburst', BASE, ALL), [
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
            'auto'
        ]);
        assert.deepEqual(readFamilyQualityTiers('gpt-image-2', BASE, ALL), ['low', 'medium', 'high', 'auto']);
        assert.deepEqual(readFamilyQualityTiers('flux-2-pro', BASE, ALL), ['low', 'medium', 'high', 'auto']);
    });

    it('ignores registered tiers that the contract does not declare', () => {
        // 登记表若写了契约里不存在的档位，必须被丢弃而不是放宽出去。
        assert.deepEqual(readFamilyQualityTiers('gpt-image-2.6-flare', BASE, BASE), ['low', 'medium', 'high', 'auto']);
    });
});

describe('model lifecycle declarations', () => {
    it('reports official shutdown and deprecation facts per model id', () => {
        assert.equal(readImageModelLifecycle('gpt-image-1')?.status, 'shutdown');
        assert.equal(readImageModelLifecycle('gpt-image-1')?.shutdownDate, '2026-10-23');
        assert.equal(readImageModelLifecycle('gpt-image-2')?.status, 'deprecated');
        assert.equal(readImageModelLifecycle('gpt-image-2')?.shutdownDate, '2027-02-10');
        assert.equal(readImageModelLifecycle('gpt-image-2.6-flare'), undefined);
    });
});
