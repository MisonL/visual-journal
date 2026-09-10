import {
    buildCompletedHistoryEntry,
    buildFailedHistoryEntry,
    buildHistoryGenerationFormData,
    readHistorySizeSelection,
    resolveHistoryImageClientRequestId,
    updateHistoryResultFeedback,
    type HistoryMetadata
} from './history-metadata';
import type { GenerationFormData } from '@/components/generation-form';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const fallbackGenerationForm: GenerationFormData = {
    prompt: '当前表单提示词',
    n: 1,
    size: 'square',
    customWidth: 2048,
    customHeight: 2048,
    quality: 'medium',
    output_format: 'png',
    background: 'auto',
    moderation: 'auto',
    model: 'gpt-image-2',
    image_backend: 'server-default',
    streaming_strategy: 'server-default',
    responsesModel: '',
    thinking: 'server-default',
    promptOptimization: 'server-default',
    forceWeb: false,
    enableParallelBatch: false
};

function historyWithSize(size: string): HistoryMetadata {
    return {
        timestamp: 1,
        images: [],
        durationMs: 100,
        quality: 'high',
        background: 'auto',
        moderation: 'auto',
        prompt: '提示词',
        mode: 'generate',
        costDetails: null,
        model: 'gpt-image-2',
        size
    };
}

describe('buildCompletedHistoryEntry', () => {
    it('records the submitted form data instead of unrelated current UI state', () => {
        const submittedForm: GenerationFormData = {
            ...fallbackGenerationForm,
            prompt: '历史图变体提示词',
            n: 2,
            size: 'portrait',
            quality: 'high',
            output_format: 'webp',
            output_compression: 82,
            background: 'opaque',
            moderation: 'low',
            model: 'gpt-image-1.5',
            image_backend: 'responses-image-generation',
            streaming_strategy: 'responses-sse',
            responsesModel: 'gpt-5.4',
            thinking: 'high',
            promptOptimization: 'on',
            forceWeb: true,
            enableParallelBatch: true
        };

        const entry = buildCompletedHistoryEntry({
            images: [{ filename: 'variant.webp', output_format: 'webp', clientRequestId: 'request-1' }],
            usage: {
                input_tokens_details: { text_tokens: 10, image_tokens: 0 },
                output_tokens: 20
            },
            actualCost: undefined,
            durationMs: 1200,
            formData: submittedForm,
            requestMode: 'generate',
            storageMode: 'indexeddb'
        });

        assert.equal(entry.prompt, '历史图变体提示词');
        assert.equal(entry.model, 'gpt-image-1.5');
        assert.equal(entry.size, '1024x1536');
        assert.equal(entry.quality, 'high');
        assert.equal(entry.output_format, 'webp');
        assert.equal(entry.background, 'opaque');
        assert.equal(entry.moderation, 'low');
        assert.equal(entry.image_backend, 'responses-image-generation');
        assert.equal(entry.streaming_strategy, 'responses-sse');
        assert.equal(entry.responsesModel, 'gpt-5.4');
        assert.equal(entry.thinking, 'high');
        assert.equal(entry.promptOptimization, 'on');
        assert.equal(entry.forceWeb, true);
        assert.equal(entry.enableParallelBatch, true);
        assert.deepEqual(entry.clientRequestIds, ['request-1']);
    });

    it('uses an explicit prompt override for prompt batch history display', () => {
        const entry = buildCompletedHistoryEntry({
            images: [{ filename: 'batch-1.png', output_format: 'png' }],
            usage: null,
            actualCost: undefined,
            durationMs: 900,
            formData: {
                ...fallbackGenerationForm,
                prompt: '第一行',
                batchPrompts: ['第一行', '第二行'],
                enableParallelBatch: true
            },
            requestMode: 'generate',
            storageMode: 'fs',
            promptOverride: '第一行\n第二行'
        });

        assert.equal(entry.prompt, '第一行\n第二行');
        assert.equal(entry.costDetails, null);
    });
});

describe('buildFailedHistoryEntry', () => {
    it('records failed prompt batches as the submitted batch text', () => {
        const entry = buildFailedHistoryEntry({
            message: '上游失败',
            durationMs: 300,
            formData: {
                ...fallbackGenerationForm,
                prompt: '第一行',
                batchPrompts: ['第一行', '第二行'],
                enableParallelBatch: true
            },
            requestMode: 'generate',
            storageMode: 'fs'
        });

        assert.equal(entry.status, 'failed');
        assert.equal(entry.failureMessage, '上游失败');
        assert.equal(entry.prompt, '第一行\n第二行');
        assert.equal(entry.model, 'gpt-image-2');
        assert.equal(entry.size, '2048x2048');
        assert.equal(entry.enableParallelBatch, true);
    });
});

describe('history metadata helpers', () => {
    it('marks result feedback on only the selected history entry', () => {
        const first = historyWithSize('2048x2048');
        const second = { ...historyWithSize('3072x2048'), timestamp: 2 };
        const updated = updateHistoryResultFeedback({
            history: [first, second],
            item: second,
            value: 'usable',
            updatedAt: 1770000000000
        });

        assert.equal(updated[0], first);
        assert.deepEqual(updated[1].resultFeedback, {
            value: 'usable',
            updatedAt: 1770000000000
        });
    });

    it('preserves in-progress result feedback notes and clears empty notes', () => {
        const base = historyWithSize('2048x2048');
        const withNote = updateHistoryResultFeedback({
            history: [base],
            item: base,
            value: 'usable',
            updatedAt: 1770000000001,
            note: '  首版已经可以发给运营确认  '
        });

        assert.deepEqual(withNote[0].resultFeedback, {
            value: 'usable',
            updatedAt: 1770000000001,
            note: '  首版已经可以发给运营确认  '
        });

        const preservedNote = updateHistoryResultFeedback({
            history: withNote,
            item: withNote[0],
            value: 'needs_revision',
            updatedAt: 1770000000002
        });

        assert.deepEqual(preservedNote[0].resultFeedback, {
            value: 'needs_revision',
            updatedAt: 1770000000002,
            note: '  首版已经可以发给运营确认  '
        });

        const clearedNote = updateHistoryResultFeedback({
            history: preservedNote,
            item: preservedNote[0],
            value: 'needs_revision',
            updatedAt: 1770000000003,
            note: ''
        });

        assert.deepEqual(clearedNote[0].resultFeedback, {
            value: 'needs_revision',
            updatedAt: 1770000000003
        });
    });

    it('restores compatible history size presets and custom gpt-image-2 dimensions', () => {
        assert.deepEqual(readHistorySizeSelection(historyWithSize('3072x2048'), 'gpt-image-2'), {
            size: 'landscape',
            customWidth: null,
            customHeight: null,
            restored: true
        });
        assert.deepEqual(readHistorySizeSelection(historyWithSize('2304x1536'), 'gpt-image-2'), {
            size: 'custom',
            customWidth: 2304,
            customHeight: 1536,
            restored: true
        });
    });

    it('restores custom dimensions for the default 1K model alias', () => {
        assert.deepEqual(readHistorySizeSelection(historyWithSize('2304x1536'), 'gpt-image-2-1k'), {
            size: 'custom',
            customWidth: 2304,
            customHeight: 1536,
            restored: true
        });
    });

    it('preserves provider-defined model dimensions instead of mapping them to legacy presets', () => {
        assert.deepEqual(readHistorySizeSelection(historyWithSize('2048x2048'), 'custom-image-model'), {
            size: 'custom',
            customWidth: 2048,
            customHeight: 2048,
            restored: true
        });
        assert.deepEqual(readHistorySizeSelection(historyWithSize('4096x2160'), 'custom-image-model'), {
            size: 'custom',
            customWidth: 4096,
            customHeight: 2160,
            restored: true
        });
    });

    it('serializes restored provider-defined ratio presets as concrete dimensions', () => {
        const form = buildHistoryGenerationFormData(
            {
                ...historyWithSize('square'),
                model: 'custom-image-model'
            },
            fallbackGenerationForm
        );

        assert.equal(form.size, 'square');
        const entry = buildCompletedHistoryEntry({
            images: [{ filename: 'custom.png', output_format: 'png' }],
            usage: null,
            actualCost: undefined,
            durationMs: 100,
            formData: form,
            requestMode: 'generate',
            storageMode: 'fs'
        });

        assert.equal(entry.model, 'custom-image-model');
        assert.equal(entry.size, '1024x1024');
    });

    it('does not restore zero or unsafe custom dimensions from saved history', () => {
        for (const size of ['0x1536', '2304x0', '9007199254740992x1536']) {
            assert.deepEqual(readHistorySizeSelection(historyWithSize(size), 'gpt-image-2'), {
                size: 'auto',
                customWidth: null,
                customHeight: null,
                restored: false
            });
        }
    });

    it('restores legacy preset dimensions even when the current fallback model differs', () => {
        assert.deepEqual(readHistorySizeSelection(historyWithSize('1536x1024'), 'gpt-image-2'), {
            size: 'landscape',
            customWidth: null,
            customHeight: null,
            restored: true
        });
        assert.deepEqual(readHistorySizeSelection(historyWithSize('1024x1536'), 'gpt-image-2'), {
            size: 'portrait',
            customWidth: null,
            customHeight: null,
            restored: true
        });
    });

    it('builds generation form data from a selected history entry', () => {
        const form = buildHistoryGenerationFormData(
            {
                timestamp: 1,
                images: [{ filename: 'a.png' }, { filename: 'b.png' }],
                durationMs: 100,
                quality: 'high',
                background: 'transparent',
                moderation: 'low',
                prompt: '历史提示词',
                mode: 'generate',
                costDetails: null,
                output_format: 'jpeg',
                model: 'gpt-image-2',
                size: '2048x3072',
                image_backend: 'responses-image-generation',
                streaming_strategy: 'responses-sse',
                responsesModel: 'gpt-5.4',
                thinking: 'medium',
                promptOptimization: 'off',
                forceWeb: true,
                enableParallelBatch: true
            },
            fallbackGenerationForm
        );

        assert.equal(form.prompt, '历史提示词');
        assert.equal(form.n, 2);
        assert.equal(form.size, 'portrait');
        assert.equal(form.quality, 'high');
        assert.equal(form.output_format, 'jpeg');
        assert.equal(form.background, 'transparent');
        assert.equal(form.moderation, 'low');
        assert.equal(form.model, 'gpt-image-2');
        assert.equal(form.image_backend, 'responses-image-generation');
        assert.equal(form.streaming_strategy, 'responses-sse');
        assert.equal(form.responsesModel, 'gpt-5.4');
        assert.equal(form.thinking, 'medium');
        assert.equal(form.promptOptimization, 'off');
        assert.equal(form.forceWeb, true);
        assert.equal(form.enableParallelBatch, true);
        assert.equal(form.batchPrompts, undefined);
    });

    it('does not inherit the current parallel batch toggle for old history entries', () => {
        const form = buildHistoryGenerationFormData(
            {
                timestamp: 1,
                images: [{ filename: 'a.png' }, { filename: 'b.png' }],
                durationMs: 100,
                quality: 'high',
                background: 'auto',
                moderation: 'auto',
                prompt: '旧历史提示词',
                mode: 'generate',
                costDetails: null,
                output_format: 'png',
                model: 'gpt-image-2',
                size: '2048x2048'
            },
            {
                ...fallbackGenerationForm,
                image_backend: 'images-api',
                streaming_strategy: 'force-sse',
                responsesModel: 'stale-model',
                thinking: 'high',
                promptOptimization: 'on',
                forceWeb: true,
                enableParallelBatch: true
            }
        );

        assert.equal(form.image_backend, 'server-default');
        assert.equal(form.streaming_strategy, 'server-default');
        assert.equal(form.responsesModel, '');
        assert.equal(form.thinking, 'server-default');
        assert.equal(form.promptOptimization, 'server-default');
        assert.equal(form.forceWeb, false);
        assert.equal(form.enableParallelBatch, false);
    });

    it('restores failed batch history as batch prompts for retry', () => {
        const form = buildHistoryGenerationFormData(
            {
                timestamp: 1,
                images: [],
                status: 'failed',
                failureMessage: '上游失败',
                durationMs: 100,
                quality: 'medium',
                background: 'opaque',
                moderation: 'low',
                prompt: '第一行\n第二行',
                mode: 'generate',
                costDetails: null,
                output_format: 'webp',
                model: 'gpt-image-1.5',
                size: '1024x1536',
                image_backend: 'images-api',
                streaming_strategy: 'force-sse',
                responsesModel: 'unused',
                thinking: 'low',
                promptOptimization: 'on',
                forceWeb: true,
                enableParallelBatch: true
            },
            {
                ...fallbackGenerationForm,
                output_format: 'webp',
                output_compression: 88
            }
        );

        assert.equal(form.prompt, '第一行');
        assert.deepEqual(form.batchPrompts, ['第一行', '第二行']);
        assert.equal(form.model, 'gpt-image-1.5');
        assert.equal(form.size, 'portrait');
        assert.equal(form.quality, 'medium');
        assert.equal(form.output_format, 'webp');
        assert.equal(form.output_compression, 88);
        assert.equal(form.background, 'opaque');
        assert.equal(form.moderation, 'low');
        assert.equal(form.image_backend, 'images-api');
        assert.equal(form.streaming_strategy, 'force-sse');
        assert.equal(form.responsesModel, 'unused');
        assert.equal(form.thinking, 'low');
        assert.equal(form.promptOptimization, 'on');
        assert.equal(form.forceWeb, true);
        assert.equal(form.enableParallelBatch, true);
    });

    it('resolves image-level request ids before entry-level request ids', () => {
        assert.equal(
            resolveHistoryImageClientRequestId(
                {
                    timestamp: 1,
                    images: [{ filename: 'a.png' }, { filename: 'b.png', clientRequestId: 'image-b' }],
                    durationMs: 100,
                    quality: 'high',
                    background: 'auto',
                    moderation: 'auto',
                    prompt: '提示词',
                    mode: 'generate',
                    costDetails: null,
                    clientRequestIds: ['entry-a', 'entry-b']
                },
                1
            ),
            'image-b'
        );
    });
});
