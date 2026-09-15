import { GenerationForm, resolveGenerationFooterPromptTarget } from './generation-form';
import { I18nProvider } from '@/lib/i18n';
import { MAX_PROMPT_LENGTH } from '@/lib/image-request-limits';
import {
    IMAGE_UPSTREAM_PROFILES,
    type ImageUpstreamProfile,
    type PartialImagesCount
} from '@/lib/image-upstream-profile';
import type { ImageStreamingStrategy } from '@/lib/image-upstream-strategy';
import { validatePositiveIntegerImageSize } from '@/lib/size-utils';
import { renderInClientDom } from '@/test-utils/react-dom';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const noop = () => {};

function readButtonById(html: string, id: string): string {
    const match = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(match, `missing button ${id}`);
    return match[0];
}

function readSubmitFooterClass(html: string, submitLabel: string): string {
    const footerPattern = /<div(?=[^>]*data-slot="card-footer")(?=[^>]*class="([^"]*)")[^>]*>/g;
    const footers = [...html.matchAll(footerPattern)];

    for (const [index, footer] of footers.entries()) {
        const start = footer.index;
        const end = footers[index + 1]?.index ?? html.length;
        const footerHtml = html.slice(start, end);
        if (footerHtml.includes(submitLabel)) return footer[1];
    }

    assert.fail(`missing submit footer for ${submitLabel}`);
}

function assertSubmitFooterAvailable(html: string, submitLabel: string) {
    const classNames = readSubmitFooterClass(html, submitLabel).split(/\s+/);
    const hiddenClassName = classNames.find((className) => className === 'hidden' || className.endsWith(':hidden'));

    assert.equal(hiddenClassName, undefined);
    assert.equal(classNames.includes('flex'), true);
    assert.equal(classNames.includes('border-t'), true);
}

type GenerationRenderOptions = {
    currentMode?: 'generate' | 'edit' | 'batch' | 'reuse';
    defaultAdvancedTab?: 'output' | 'model' | 'stream' | 'route';
    failedBatchPrompts?: string[];
    canPauseBatch?: boolean;
    isBatchPauseRequested?: boolean;
    defaultAdvancedOpen?: boolean;
    omitPauseHandler?: boolean;
    allowStreamingBatch?: boolean;
    enableParallelBatch?: boolean;
    streamingStrategy?: React.ComponentProps<typeof GenerationForm>['streamingStrategy'];
    defaultStreamingStrategy?: ImageStreamingStrategy;
    prompt?: string;
    batchPromptText?: string;
    canApplyRandomInspiration?: boolean;
    allowResponsesImageBackend?: boolean;
    hasDefaultResponsesModel?: boolean;
    responsesModel?: string;
    imageBackend?: React.ComponentProps<typeof GenerationForm>['imageBackend'];
    defaultImageBackend?: React.ComponentProps<typeof GenerationForm>['defaultImageBackend'];
    upstreamProfile?: ImageUpstreamProfile;
    upstreamProfileMixed?: boolean;
    isActive?: boolean;
    n?: number[];
    partialImages?: PartialImagesCount;
    streamMode?: React.ComponentProps<typeof GenerationForm>['streamMode'];
    model?: React.ComponentProps<typeof GenerationForm>['model'];
    modelOptions?: readonly string[];
    size?: React.ComponentProps<typeof GenerationForm>['size'];
    customWidth?: number;
    customHeight?: number;
    isLoading?: boolean;
    showLoadingState?: boolean;
};

function createGenerationFormProps(options: GenerationRenderOptions = {}): React.ComponentProps<typeof GenerationForm> {
    return {
        onSubmit: noop,
        onSaveInspiration: noop,
        canApplyRandomInspiration: options.canApplyRandomInspiration ?? true,
        onPickRandomInspiration: () => '用户保存的真实提示词',
        isLoading: options.isLoading ?? false,
        showLoadingState: options.showLoadingState,
        isActive: options.isActive ?? true,
        currentMode: options.currentMode ?? 'generate',
        onModeChange: noop,
        reuseContext: null,
        onClearReuseContext: noop,
        isPasswordRequiredByBackend: false,
        clientPasswordHash: null,
        onOpenPasswordDialog: noop,
        model: options.model ?? 'gpt-image-2',
        modelOptions: options.modelOptions,
        setModel: noop,
        prompt: options.prompt ?? '用户真实提示词 A',
        setPrompt: noop,
        batchPromptText: options.batchPromptText ?? '用户真实提示词 A\n用户真实提示词 B',
        setBatchPromptText: noop,
        failedBatchPrompts: options.failedBatchPrompts,
        canPauseBatch: options.canPauseBatch,
        isBatchPauseRequested: options.isBatchPauseRequested,
        onPauseBatch: options.omitPauseHandler ? undefined : noop,
        n: options.n ?? [1],
        setN: noop,
        size: options.size ?? 'auto',
        setSize: noop,
        customWidth: options.customWidth ?? 1024,
        setCustomWidth: noop,
        customHeight: options.customHeight ?? 1024,
        setCustomHeight: noop,
        quality: 'high',
        setQuality: noop,
        outputFormat: 'png',
        setOutputFormat: noop,
        compression: [100],
        setCompression: noop,
        background: 'auto',
        setBackground: noop,
        upstreamProfile: options.upstreamProfile ?? IMAGE_UPSTREAM_PROFILES['openai-compatible'],
        upstreamProfileMixed: options.upstreamProfileMixed ?? false,
        moderation: 'auto',
        setModeration: noop,
        streamMode: options.streamMode ?? 'auto',
        setStreamMode: noop,
        allowStreamingBatch: options.allowStreamingBatch ?? false,
        enableParallelBatch: options.enableParallelBatch ?? false,
        setEnableParallelBatch: noop,
        partialImages: options.partialImages ?? 1,
        setPartialImages: noop,
        allowResponsesImageBackend: options.allowResponsesImageBackend ?? true,
        hasDefaultResponsesModel: options.hasDefaultResponsesModel ?? true,
        imageBackend: options.imageBackend ?? 'server-default',
        setImageBackend: noop,
        defaultImageBackend: options.defaultImageBackend,
        streamingStrategy: options.streamingStrategy ?? 'server-default',
        defaultStreamingStrategy: options.defaultStreamingStrategy ?? 'auto',
        setStreamingStrategy: noop,
        responsesModel: options.responsesModel ?? '',
        setResponsesModel: noop,
        thinking: 'server-default',
        setThinking: noop,
        promptOptimization: 'server-default',
        setPromptOptimization: noop,
        forceWeb: false,
        setForceWeb: noop,
        requestSummaryLabel: '请求 1 张图片',
        defaultAdvancedOpen: options.defaultAdvancedOpen,
        defaultAdvancedTab: options.defaultAdvancedTab
    };
}

function renderGenerationForm(options: GenerationRenderOptions = {}) {
    return renderToStaticMarkup(
        <I18nProvider>
            <GenerationForm {...createGenerationFormProps(options)} />
        </I18nProvider>
    );
}

describe('GenerationForm submit footer', () => {
    it('uses the server prompt limit in the visible counter and input constraint', () => {
        const html = renderGenerationForm({ prompt: '用户真实提示词' });

        assert.match(html, new RegExp(`maxLength="${MAX_PROMPT_LENGTH}"`));
        assert.match(html, new RegExp(`\\/ ${MAX_PROMPT_LENGTH.toLocaleString('zh-CN')}`));
        assert.doesNotMatch(html, /\/ 1000/);
    });

    it('keeps the form disabled without showing generation copy for other busy work', () => {
        const html = renderGenerationForm({ isLoading: true, showLoadingState: false });

        assert.match(html, /disabled=""/);
        assert.match(html, />生成图像<\/button>/);
        assert.doesNotMatch(html, /生成中/);
        assert.doesNotMatch(html, /animate-spin/);
    });

    it('shows generation loading feedback for a real generation request', () => {
        const html = renderGenerationForm({ isLoading: true, showLoadingState: true });

        assert.match(html, /disabled=""/);
        assert.match(html, /animate-spin/);
        assert.match(html, /生成中\.\.\.<\/button>/);
        assert.doesNotMatch(html, /生成图像<\/button>/);
    });

    it('keeps the submit footer available outside desktop breakpoints', () => {
        const html = renderGenerationForm();

        assertSubmitFooterAvailable(html, '生成图像');
        assert.match(html, /grid grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\] gap-1\.5 text-xs/);
        assert.match(html, /min-w-0 items-center justify-center rounded-md/);
        assert.match(html, /min-h-11 min-w-0 items-center justify-center/);
        assert.match(html, /h-3\.5 w-3\.5 shrink-0" aria-hidden="true"/);
        assert.match(html, /min-w-0 whitespace-normal/);
        assert.match(html, /focus-visible:ring-2 focus-visible:outline-none/);
        assert.doesNotMatch(html, /text-center whitespace-nowrap/);
        assert.doesNotMatch(html, /min-\[1760px\]:flex/);
    });

    it('lets the scrollable controls use the remaining desktop height without clipping the footer', () => {
        const html = renderGenerationForm();

        assert.match(html, /flex min-h-0 flex-1 flex-col overflow-hidden/);
        assert.match(html, /literary-scrollbar min-h-0 flex-1 space-y-2\.5 overflow-y-auto p-4 pb-4/);
        assert.match(html, /border-border bg-card flex shrink-0 border-t p-3/);
        assert.doesNotMatch(html, /lg:max-h-\[calc\(100%-9\.75rem\)\]/);
    });
});

describe('GenerationForm custom model sizing', () => {
    it('uses positive-integer input constraints for custom provider models', () => {
        const html = renderGenerationForm({
            model: 'custom-image-model',
            size: 'custom'
        });

        assert.match(html, /id="custom-width"[^>]*min="1"/);
        assert.match(html, /id="custom-width"[^>]*step="1"/);
        assert.doesNotMatch(html, /id="custom-width"[^>]*max="3840"/);
        assert.match(html, /id="custom-height"[^>]*min="1"/);
        assert.match(html, /id="custom-height"[^>]*step="1"/);
        assert.doesNotMatch(html, /id="custom-height"[^>]*max="3840"/);
    });

    it('accepts the smallest positive custom size and rejects zero dimensions', () => {
        assert.equal(validatePositiveIntegerImageSize(1, 1).valid, true);
        assert.equal(validatePositiveIntegerImageSize(0, 1).valid, false);
    });
});

describe('GenerationForm inactive state', { concurrency: false }, () => {
    it('only shows the high-resolution streaming recommendation for the active form', () => {
        const options = { size: 'landscape' as const, streamMode: 'non_stream' as const };
        const activeHtml = renderGenerationForm(options);
        const inactiveHtml = renderGenerationForm({ ...options, isActive: false });

        assert.match(activeHtml, /当前是 high 质量大尺寸请求/);
        assert.doesNotMatch(inactiveHtml, /当前是 high 质量大尺寸请求/);
    });

    it('only applies profile-driven corrections after the form becomes active', async () => {
        const countCorrections: number[][] = [];
        const partialImageCorrections: number[] = [];
        const streamModeCorrections: string[] = [];
        const sizeCorrections: string[] = [];
        const props = createGenerationFormProps({
            isActive: false,
            n: [0],
            model: 'gpt-image-1',
            size: 'custom',
            partialImages: 0,
            streamMode: 'auto',
            streamingStrategy: 'off'
        });
        props.setN = (nextCount) => {
            countCorrections.push(typeof nextCount === 'function' ? nextCount([]) : nextCount);
        };
        props.setPartialImages = (nextPartialImages) => {
            partialImageCorrections.push(
                typeof nextPartialImages === 'function' ? nextPartialImages(1) : nextPartialImages
            );
        };
        props.setStreamMode = (nextStreamMode) => {
            streamModeCorrections.push(typeof nextStreamMode === 'function' ? nextStreamMode('auto') : nextStreamMode);
        };
        props.setSize = (nextSize) => {
            sizeCorrections.push(typeof nextSize === 'function' ? nextSize('custom') : nextSize);
        };

        const view = await renderInClientDom(
            <I18nProvider>
                <GenerationForm {...props} />
            </I18nProvider>
        );

        try {
            assert.deepEqual(countCorrections, []);
            assert.deepEqual(partialImageCorrections, []);
            assert.deepEqual(streamModeCorrections, []);
            assert.deepEqual(sizeCorrections, []);

            await view.render(
                <I18nProvider>
                    <GenerationForm {...props} isActive />
                </I18nProvider>
            );

            assert.deepEqual(countCorrections, [[1]]);
            assert.deepEqual(partialImageCorrections, [1]);
            assert.deepEqual(streamModeCorrections, ['non_stream']);
            assert.deepEqual(sizeCorrections, ['auto']);
        } finally {
            await view.cleanup();
        }
    });

    it('runs generation inspiration actions through the rendered footer controls', async () => {
        const savedPrompts: string[] = [];
        const appliedPrompts: string[] = [];
        const props = createGenerationFormProps({ prompt: '  当前生成灵感  ' });
        props.onSaveInspiration = (prompt) => savedPrompts.push(prompt);
        props.onPickRandomInspiration = () => '  随机生成灵感  ';
        props.setPrompt = (nextPrompt) => {
            appliedPrompts.push(typeof nextPrompt === 'function' ? nextPrompt('') : nextPrompt);
        };

        const view = await renderInClientDom(
            <I18nProvider>
                <GenerationForm {...props} />
            </I18nProvider>
        );

        try {
            const saveButton = [...view.container.querySelectorAll('button')].find((button) =>
                button.textContent?.includes('收藏提示词')
            );
            const randomButton = [...view.container.querySelectorAll('button')].find((button) =>
                button.textContent?.includes('随机套用')
            );

            assert.ok(saveButton, 'missing generation save inspiration button');
            assert.ok(randomButton, 'missing generation random inspiration button');

            await view.click(saveButton);
            await view.click(randomButton);

            assert.deepEqual(savedPrompts, ['  当前生成灵感  ']);
            assert.deepEqual(appliedPrompts, ['随机生成灵感']);
        } finally {
            await view.cleanup();
        }
    });

    it('routes random inspiration through the rendered batch footer control', async () => {
        const appliedBatchPrompts: string[] = [];
        const props = createGenerationFormProps({
            currentMode: 'batch',
            batchPromptText: '当前批量任务'
        });
        props.onPickRandomInspiration = () => '  随机批量灵感  ';
        props.setBatchPromptText = (nextPrompt) => {
            appliedBatchPrompts.push(typeof nextPrompt === 'function' ? nextPrompt('') : nextPrompt);
        };

        const view = await renderInClientDom(
            <I18nProvider>
                <GenerationForm {...props} />
            </I18nProvider>
        );

        try {
            const randomButton = [...view.container.querySelectorAll('button')].find((button) =>
                button.textContent?.includes('随机套用')
            );

            assert.ok(randomButton, 'missing batch random inspiration button');
            await view.click(randomButton);

            assert.deepEqual(appliedBatchPrompts, ['随机批量灵感']);
        } finally {
            await view.cleanup();
        }
    });
});

describe('GenerationForm advanced groups', () => {
    it('keeps translated preset labels inside responsive control cells', () => {
        const html = renderGenerationForm();

        assert.match(html, /grid grid-cols-2 gap-1.5/);
        assert.match(html, /max-w-full min-w-0 text-center leading-4 break-words whitespace-normal/);
        assert.match(html, /radio-group-item-content\]\]:min-w-0/);
        assert.match(html, /radio-group-item-content\]\]:overflow-hidden/);
        assert.doesNotMatch(html, /radio-group-item-content\]\]:overflow-visible/);
        assert.doesNotMatch(html, /2xl:text-xs/);
        assert.doesNotMatch(html, /truncate text-center leading-4/);
        assert.doesNotMatch(html, /lg:hidden 2xl:block/);
        assert.doesNotMatch(html, /2xl:grid-cols-5/);
        assert.doesNotMatch(html, /2xl:grid-cols-6/);
    });

    it('shows task-specific descriptions in the mode segmented control', () => {
        const html = renderGenerationForm();

        for (const label of ['从灵感开始', '基于参考图编辑', '一次多张', '套用已有提示词']) {
            assert.match(html, new RegExp(label));
        }
    });

    it('keeps the full professional accordion available on desktop and mobile', () => {
        const html = renderGenerationForm({ defaultAdvancedTab: 'route' });

        assert.match(
            html,
            /<div class="border-border bg-muted\/20 rounded-md border"><button[^>]*aria-controls="generation-advanced-panel"/
        );
        assert.doesNotMatch(
            html,
            /<div class="[^"]*lg:hidden[^"]*"><button[^>]*aria-controls="generation-advanced-panel"/
        );
    });

    it('labels the collapsed mobile advanced drawer as easy mode', () => {
        const html = renderGenerationForm();

        assert.match(html, /省心模式/);
        assert.match(html, /常用参数已放在基础设置里/);
        assert.doesNotMatch(html, /block truncate text-xs font-normal/);
    });

    it('translates the default backend into a user-facing route label near submit', () => {
        const html = renderGenerationForm();

        assert.match(html, /默认线路/);
        assert.match(html, /请求 1 张图片/);
    });

    it('labels the expanded mobile advanced drawer as professional mode', () => {
        const html = renderGenerationForm({ defaultAdvancedOpen: true });

        assert.match(html, /专业模式/);
        assert.match(html, /清晰度: 高, 输出格式: PNG, 服务端默认/);
    });

    it('renders route controls in a separate professional tab', () => {
        const html = renderGenerationForm({ defaultAdvancedOpen: true, defaultAdvancedTab: 'route' });

        for (const label of ['输出', '模型', '流式', '路由']) {
            assert.match(html, new RegExp(label));
        }
        assert.match(html, /image-backend-select/);
        assert.match(html, /streaming-strategy-select/);
        assert.doesNotMatch(html, /model-select/);
    });

    it('explains route choices that affect stability and cost', () => {
        const html = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'route',
            upstreamProfileMixed: true
        });

        assert.match(html, /影响说明/);
        assert.match(html, /服务端默认会沿用当前部署配置/);
        assert.match(html, /当前服务端渠道包含不同上游模式/);
        assert.match(
            html,
            /当前自动策略会由服务端按渠道选择传输方式，可能直接使用非流式；仅在实际选中流式且上游支持时使用流式。/
        );
        assert.match(html, /费用主要由模型、尺寸、数量和预览图数量决定/);
    });

    it('explains the resolved server default streaming strategy', () => {
        const offHtml = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'route',
            streamingStrategy: 'server-default',
            defaultStreamingStrategy: 'off'
        });
        const forceHtml = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'route',
            streamingStrategy: 'server-default',
            defaultStreamingStrategy: 'force-sse'
        });

        assert.match(offHtml, /关闭流式会减少长连接不稳定因素/);
        assert.doesNotMatch(offHtml, /当前自动策略会由服务端按渠道选择传输方式/);
        assert.match(forceHtml, /强制 SSE 会跳过自动判断/);
        assert.doesNotMatch(forceHtml, /当前自动策略会由服务端按渠道选择传输方式/);
    });

    it('disables the experimental Responses backend when runtime capabilities do not allow it', () => {
        const html = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'route',
            allowResponsesImageBackend: false
        });

        assert.match(html, /当前运行时或默认服务器渠道未开放 Responses image_generation/);
        assert.doesNotMatch(html, /GPT 顶层模型/);
    });

    it('blocks Responses generation until a top-level model is available', () => {
        const html = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'route',
            imageBackend: 'responses-image-generation',
            hasDefaultResponsesModel: false,
            responsesModel: ''
        });

        assert.match(html, /Responses image_generation 需要填写 GPT 顶层模型/);
        assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*生成图像[\s\S]*<\/button>/);
    });

    it('allows Responses generation when the runtime has a default top-level model', () => {
        const html = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'route',
            imageBackend: 'responses-image-generation',
            hasDefaultResponsesModel: true,
            responsesModel: ''
        });

        assert.match(html, /GPT 顶层模型/);
        assert.doesNotMatch(html, /Responses image_generation 需要填写 GPT 顶层模型/);
    });

    it('keeps the model selector out of the route group', () => {
        const html = renderGenerationForm({ defaultAdvancedOpen: true, defaultAdvancedTab: 'model' });

        assert.match(html, /model-select/);
        assert.doesNotMatch(html, /image-backend-select/);
    });

    it('keeps a restored model visible when the current directory does not list it', () => {
        const html = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'model',
            model: 'restored-provider-model',
            modelOptions: ['gpt-image-2']
        });

        assert.match(html, /restored-provider-model/);
    });

    it('keeps OpenAI-compatible generation controls within its upstream profile', () => {
        const streamHtml = renderGenerationForm({ defaultAdvancedOpen: true, defaultAdvancedTab: 'stream' });
        const outputHtml = renderGenerationForm({ defaultAdvancedOpen: true, defaultAdvancedTab: 'output' });

        assert.doesNotMatch(streamHtml, /partial-0/);
        assert.match(streamHtml, /partial-1/);
        assert.match(streamHtml, /partial-3/);
        assert.doesNotMatch(streamHtml, /partial-4/);
        assert.match(outputHtml, /n-3/);
        assert.match(outputHtml, /n-10/);
        assert.match(outputHtml, /n-8/);
        assert.match(readButtonById(outputHtml, 'bg-transparent'), /disabled=""/);
    });

    it('renders Matsca generation controls when the active upstream profile allows them', () => {
        const streamHtml = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'stream',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });
        const outputHtml = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'output',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });

        assert.match(streamHtml, /partial-0/);
        assert.match(streamHtml, /partial-4/);
        assert.match(outputHtml, /n-3/);
        assert.doesNotMatch(outputHtml, /n-8/);
        assert.doesNotMatch(readButtonById(outputHtml, 'bg-transparent'), /disabled=""/);
    });

    it('intersects Matsca output and preview options with the Responses backend contract', () => {
        const streamHtml = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'stream',
            imageBackend: 'responses-image-generation',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });
        const outputHtml = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'output',
            imageBackend: 'responses-image-generation',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });

        assert.doesNotMatch(streamHtml, /partial-0/);
        assert.match(streamHtml, /partial-1/);
        assert.match(streamHtml, /partial-3/);
        assert.doesNotMatch(streamHtml, /partial-4/);
        assert.match(outputHtml, /n-1/);
        assert.doesNotMatch(outputHtml, /id="n-2"/);
    });

    it('applies Responses limits to the server-default route when runtime selects that backend', () => {
        const streamHtml = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'stream',
            imageBackend: 'server-default',
            defaultImageBackend: 'responses-image-generation',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });
        const outputHtml = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'output',
            imageBackend: 'server-default',
            defaultImageBackend: 'responses-image-generation',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });

        assert.doesNotMatch(streamHtml, /partial-0/);
        assert.match(streamHtml, /partial-1/);
        assert.match(streamHtml, /partial-3/);
        assert.doesNotMatch(streamHtml, /partial-4/);
        assert.match(outputHtml, /n-1/);
        assert.doesNotMatch(outputHtml, /id="n-2"/);
    });

    it('renders profile-aware high resolution size presets', () => {
        const openAiHtml = renderGenerationForm();
        const matscaHtml = renderGenerationForm({ upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca });

        assert.match(openAiHtml, /id="size-wide-4k"/);
        assert.doesNotMatch(openAiHtml, /id="size-square-4k"/);
        assert.match(matscaHtml, /id="size-square-4k"/);
    });

    it('does not present unsafe custom dimensions as a valid exact pixel calculation', () => {
        const html = renderGenerationForm({
            size: 'custom',
            customWidth: Number.MAX_SAFE_INTEGER + 1,
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });

        assert.match(html, /请先输入可精确计算的正整数尺寸。/);
        assert.match(html, /宽度和高度超出可精确处理的整数范围。/);
        assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*生成图像[\s\S]*<\/button>/);
    });

    it('disables random inspiration when no saved prompt is available', () => {
        const html = renderGenerationForm({ canApplyRandomInspiration: false });

        assert.match(html, /随机套用/);
        assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*随机套用[\s\S]*<\/button>/);
        assert.doesNotMatch(html, /夏日窗边的奶油色房间/);
    });

    it('does not render built-in prompt style chips before the user enters real content', () => {
        const html = renderGenerationForm();

        assert.doesNotMatch(html, /风格偏好/);
        assert.doesNotMatch(html, /胶片感/);
        assert.doesNotMatch(html, /奶油色/);
        assert.doesNotMatch(html, /夏日窗边/);
    });
});

describe('GenerationForm batch mode', () => {
    it('shows the per-line prompt limit for batch input', () => {
        const html = renderGenerationForm({ currentMode: 'batch' });

        assert.match(html, /每条提示词最多 32000 个字符。/);
        assert.match(html, /aria-describedby="batch-prompt-length-hint"/);
    });

    it('uses the visible batch prompt text for footer prompt actions', () => {
        assert.deepEqual(
            resolveGenerationFooterPromptTarget({
                currentMode: 'batch',
                prompt: 'hidden single prompt',
                batchPromptText: 'first batch prompt\nsecond batch prompt'
            }),
            {
                value: 'first batch prompt\nsecond batch prompt',
                isEmpty: false
            }
        );
        assert.deepEqual(
            resolveGenerationFooterPromptTarget({
                currentMode: 'generate',
                prompt: 'visible single prompt',
                batchPromptText: 'hidden batch prompt'
            }),
            {
                value: 'visible single prompt',
                isEmpty: false
            }
        );
    });

    it('renders a real batch prompt list only in batch mode', () => {
        const html = renderGenerationForm({ currentMode: 'batch' });

        assert.match(html, /批量提示词列表/);
        assert.match(html, /2 条任务/);
        assert.match(html, /batch-prompt-list/);
        assert.doesNotMatch(html, /id="prompt"/);
    });

    it('shows a low-interruption task summary for batch jobs', () => {
        const html = renderGenerationForm({ currentMode: 'batch' });

        assert.match(html, /batch-task-summary/);
        assert.match(html, /任务摘要/);
        assert.match(html, /每一行会生成一张图/);
        assert.match(html, /失败后处理/);
        assert.match(html, /生成动态/);
        assert.match(html, /不占用中央单张预览/);
    });

    it('shows a reusable failed-task entry for partial batch failures', () => {
        const html = renderGenerationForm({
            currentMode: 'batch',
            failedBatchPrompts: ['用户真实提示词 B']
        });

        assert.match(html, /上次批量有 1 条未完成/);
        assert.match(html, /只保留失败项/);
    });

    it('keeps the batch prompt list out of the default generate mode', () => {
        const html = renderGenerationForm({ failedBatchPrompts: ['用户真实提示词 B'] });

        assert.doesNotMatch(html, /batch-prompt-list/);
        assert.doesNotMatch(html, /batch-task-summary/);
        assert.doesNotMatch(html, /只保留失败项/);
    });

    it('shows a real pause action while a batch is loading', () => {
        const html = renderGenerationForm({
            currentMode: 'batch',
            canPauseBatch: true
        });

        assert.match(html, /暂停批量/);
        assert.match(html, /已开始的任务会完成，未开始的任务会保留为失败项再重试。/);
    });

    it('keeps the pause action renderable when the handler is omitted', () => {
        const html = renderGenerationForm({
            currentMode: 'batch',
            canPauseBatch: true,
            omitPauseHandler: true
        });

        assert.match(html, /暂停批量/);
    });

    it('switches the pause action into requested state after pause is requested', () => {
        const html = renderGenerationForm({
            currentMode: 'batch',
            canPauseBatch: true,
            isBatchPauseRequested: true
        });

        assert.match(html, /暂停中/);
        assert.match(html, /disabled=""/);
    });

    it('renders an explicit parallel batch toggle in stream settings', () => {
        const html = renderGenerationForm({
            currentMode: 'batch',
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'stream',
            allowStreamingBatch: true,
            enableParallelBatch: true
        });

        assert.match(html, /并发批量/);
        assert.match(html, /多张图或多条提示词会按当前服务端配置的并发上限尝试执行/);
        assert.match(html, /id="parallel-batch-enabled"/);
        assert.match(html, /aria-checked="true"/);
    });

    it('keeps the parallel batch toggle disabled for a single image request', () => {
        const html = renderGenerationForm({
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'stream',
            allowStreamingBatch: true,
            enableParallelBatch: true
        });

        assert.match(html, /选择至少 2 张图片或 2 条提示词后可启用并发/);
        assert.match(html, /id="parallel-batch-enabled"/);
        assert.match(html, /aria-checked="false"/);
        assert.match(html, /disabled=""/);
    });

    it('keeps the parallel batch toggle disabled when streaming strategy is off', () => {
        const html = renderGenerationForm({
            currentMode: 'batch',
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'stream',
            allowStreamingBatch: true,
            enableParallelBatch: true,
            streamingStrategy: 'off'
        });

        assert.match(html, /并发批量需要流式模式；非流式会保持顺序执行。/);
        assert.match(html, /id="parallel-batch-enabled"/);
        assert.match(html, /aria-checked="false"/);
        assert.match(html, /disabled=""/);
    });

    it('keeps the parallel batch toggle disabled when the server default streaming strategy is off', () => {
        const html = renderGenerationForm({
            currentMode: 'batch',
            defaultAdvancedOpen: true,
            defaultAdvancedTab: 'stream',
            allowStreamingBatch: true,
            enableParallelBatch: true,
            defaultStreamingStrategy: 'off'
        });

        assert.match(html, /并发批量需要流式模式；非流式会保持顺序执行。/);
        assert.match(html, /id="parallel-batch-enabled"/);
        assert.match(html, /aria-checked="false"/);
        assert.match(html, /disabled=""/);
    });
});
