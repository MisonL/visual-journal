import { DEFAULT_MODEL_OPTIONS, resolveModelDirectoryOptions } from './model-directory-options';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('resolveModelDirectoryOptions', () => {
    it('keeps only the union of explicitly allowlisted channel models', () => {
        assert.deepEqual(
            resolveModelDirectoryOptions({
                default_model: 'gpt-image-2',
                known_models: DEFAULT_MODEL_OPTIONS.map((id) => ({ id })),
                channels: [
                    { models: ['custom-a'], probe_status: 'failed' },
                    { models: ['custom-b'], probe_status: 'not_probed' }
                ]
            }),
            ['custom-a', 'custom-b']
        );
    });

    it('merges discovered models without hiding declared models after a partial probe', () => {
        assert.deepEqual(
            resolveModelDirectoryOptions({
                known_models: [{ id: 'custom-a' }],
                channels: [
                    { models: ['custom-a'], probe_status: 'ok' },
                    { models: ['custom-b'], probe_status: 'failed' }
                ]
            }),
            ['custom-a', 'custom-b']
        );
    });

    it('keeps generic project options when at least one channel has no allowlist', () => {
        const options = resolveModelDirectoryOptions({
            default_model: 'custom-default',
            known_models: [{ id: 'discovered-model' }],
            channels: [
                { models: [], probe_status: 'not_probed' },
                { models: ['custom-model'], probe_status: 'ok' }
            ]
        });
        assert.deepEqual(options.slice(0, 3), ['custom-default', ...DEFAULT_MODEL_OPTIONS.slice(0, 2)]);
        assert.ok(options.includes('discovered-model'));
        assert.ok(options.includes('custom-model'));
    });

    it('uses declared and known models when no channels are configured', () => {
        assert.deepEqual(
            resolveModelDirectoryOptions({ default_model: 'custom-default', known_models: [{ id: 'custom-known' }] }),
            ['custom-default', ...DEFAULT_MODEL_OPTIONS, 'custom-known']
        );
    });

    it('keeps the configured default only when it is compatible with every allowlist', () => {
        const options = resolveModelDirectoryOptions({
            default_model: 'gpt-image-2',
            channels: [{ models: ['custom-image'], probe_status: 'not_probed' }]
        });
        assert.deepEqual(options, ['custom-image']);
        assert.equal(options.includes('gpt-image-2'), false);
    });

    it('does not restore generic models when an allowlisted channel probes no matching model', () => {
        assert.deepEqual(
            resolveModelDirectoryOptions({
                default_model: 'gpt-image-2',
                known_models: [{ id: 'gpt-image-2' }, { id: 'custom-image' }],
                channels: [
                    {
                        declared_models: ['custom-image'],
                        model_allowlist_configured: true,
                        models: [],
                        probe_status: 'ok'
                    }
                ]
            }),
            ['custom-image']
        );
    });

    it('keeps redacted channel model IDs available to the selector', () => {
        assert.deepEqual(
            resolveModelDirectoryOptions({
                default_model: 'gpt-image-2',
                known_models: DEFAULT_MODEL_OPTIONS.map((id) => ({ id })),
                channels: [
                    {
                        declared_models: [],
                        model_allowlist_configured: false,
                        models: ['custom-image'],
                        probe_status: 'not_probed'
                    }
                ]
            }),
            ['custom-image']
        );
    });

    it('does not hide generic models for a redacted mixed-credential channel', () => {
        const options = resolveModelDirectoryOptions({
            default_model: 'gpt-image-2',
            known_models: DEFAULT_MODEL_OPTIONS.map((id) => ({ id })),
            channels: [
                {
                    declared_models: [],
                    model_allowlist_configured: false,
                    model_allowlist_state: 'mixed',
                    models: ['custom-image'],
                    probe_status: 'not_probed'
                }
            ]
        });
        assert.equal(options.includes('gpt-image-2'), true);
        assert.equal(options.includes('custom-image'), true);
    });
});
