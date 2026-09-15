import { EditingForm, type EditingFormData } from './editing-form';
import { I18nProvider } from '@/lib/i18n';
import { MAX_OPENAI_UPLOAD_BYTES, MAX_PROMPT_LENGTH } from '@/lib/image-request-limits';
import {
    IMAGE_UPSTREAM_PROFILES,
    type ImageUpstreamProfile,
    type PartialImagesCount
} from '@/lib/image-upstream-profile';
import type { ImageStreamingStrategy } from '@/lib/image-upstream-strategy';
import { renderInClientDom } from '@/test-utils/react-dom';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type RenderOptions = {
    backend: EditingFormData['image_backend'];
    outputFormat?: EditingFormData['output_format'];
    advancedOpen?: boolean;
    advancedTab?: 'output' | 'model' | 'stream' | 'route';
    reuseContext?: React.ComponentProps<typeof EditingForm>['reuseContext'];
    allowStreamingBatch?: boolean;
    enableParallelBatch?: boolean;
    editN?: number[];
    streamingStrategy?: EditingFormData['streaming_strategy'];
    defaultStreamingStrategy?: ImageStreamingStrategy;
    allowResponsesImageBackend?: boolean;
    hasDefaultResponsesModel?: boolean;
    defaultImageBackend?: React.ComponentProps<typeof EditingForm>['defaultImageBackend'];
    editResponsesModel?: string;
    editPrompt?: string;
    editModel?: React.ComponentProps<typeof EditingForm>['editModel'];
    modelOptions?: readonly string[];
    editSize?: React.ComponentProps<typeof EditingForm>['editSize'];
    editCustomWidth?: number;
    editCustomHeight?: number;
    canApplyRandomInspiration?: boolean;
    imageFiles?: File[];
    maskFile?: File | null;
    upstreamProfile?: ImageUpstreamProfile;
    upstreamProfileMixed?: boolean;
    isActive?: boolean;
    partialImages?: PartialImagesCount;
    streamMode?: React.ComponentProps<typeof EditingForm>['streamMode'];
    isLoading?: boolean;
    showLoadingState?: boolean;
};

const noop = () => {};

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

function assertButtonDisabled(html: string, label: string) {
    const button = html.match(/<button[^>]*>[\s\S]*?<\/button>/g)?.find((candidate) => candidate.includes(label));

    assert.ok(button, `missing button for ${label}`);
    assert.match(button, /^<button[^>]*disabled=""/);
}

function createEditingFormProps({
    backend,
    outputFormat = 'png',
    advancedOpen = true,
    advancedTab = 'route',
    reuseContext = null,
    allowStreamingBatch = false,
    enableParallelBatch = false,
    editN = [1],
    streamingStrategy = 'server-default',
    defaultStreamingStrategy = 'auto',
    allowResponsesImageBackend = true,
    hasDefaultResponsesModel = true,
    defaultImageBackend,
    editResponsesModel = '',
    editPrompt = '',
    editModel = 'gpt-image-2',
    modelOptions,
    editSize = 'auto',
    editCustomWidth = 1024,
    editCustomHeight = 1024,
    canApplyRandomInspiration = true,
    imageFiles = [],
    maskFile = null,
    upstreamProfile = IMAGE_UPSTREAM_PROFILES['openai-compatible'],
    upstreamProfileMixed = false,
    isActive = true,
    partialImages = 1,
    streamMode = 'auto',
    isLoading = false,
    showLoadingState = isLoading
}: RenderOptions): React.ComponentProps<typeof EditingForm> {
    return {
        onSubmit: noop,
        onSaveInspiration: noop,
        canApplyRandomInspiration,
        onPickRandomInspiration: () => '用户保存的编辑提示词',
        isLoading,
        showLoadingState,
        isActive,
        currentMode: 'edit',
        onModeChange: noop,
        reuseContext,
        onClearReuseContext: noop,
        isPasswordRequiredByBackend: false,
        clientPasswordHash: null,
        onOpenPasswordDialog: noop,
        editModel,
        modelOptions,
        setEditModel: noop,
        imageFiles,
        sourceImagePreviewUrls: [],
        setImageFiles: noop,
        setSourceImagePreviewUrls: noop,
        maxImages: upstreamProfile.upload.maxImages,
        editPrompt,
        setEditPrompt: noop,
        editN,
        setEditN: noop,
        editSize,
        setEditSize: noop,
        editCustomWidth,
        setEditCustomWidth: noop,
        editCustomHeight,
        setEditCustomHeight: noop,
        editQuality: 'auto',
        setEditQuality: noop,
        editOutputFormat: outputFormat,
        setEditOutputFormat: noop,
        editCompression: [85],
        setEditCompression: noop,
        upstreamProfile,
        upstreamProfileMixed,
        editModeration: 'auto',
        setEditModeration: noop,
        editBrushSize: [20],
        setEditBrushSize: noop,
        editShowMaskEditor: false,
        setEditShowMaskEditor: noop,
        editGeneratedMaskFile: maskFile,
        setEditGeneratedMaskFile: noop,
        editIsMaskSaved: false,
        setEditIsMaskSaved: noop,
        editOriginalImageSize: null,
        setEditOriginalImageSize: noop,
        editDrawnPoints: [],
        setEditDrawnPoints: noop,
        editMaskPreviewUrl: null,
        setEditMaskPreviewUrl: noop,
        streamMode,
        setStreamMode: noop,
        allowStreamingBatch,
        enableParallelBatch,
        setEnableParallelBatch: noop,
        partialImages,
        setPartialImages: noop,
        allowResponsesImageBackend,
        hasDefaultResponsesModel,
        defaultImageBackend,
        editImageBackend: backend,
        setEditImageBackend: noop,
        editStreamingStrategy: streamingStrategy,
        defaultStreamingStrategy,
        setEditStreamingStrategy: noop,
        editResponsesModel,
        setEditResponsesModel: noop,
        editThinking: 'server-default',
        setEditThinking: noop,
        editPromptOptimization: 'server-default',
        setEditPromptOptimization: noop,
        editForceWeb: false,
        setEditForceWeb: noop,
        requestSummaryLabel: '请求 1 张图片',
        initialAdvancedOpen: advancedOpen,
        initialAdvancedTab: advancedTab
    };
}

function renderEditingForm(options: RenderOptions): string {
    return renderToStaticMarkup(
        <I18nProvider>
            <EditingForm {...createEditingFormProps(options)} />
        </I18nProvider>
    );
}

describe('EditingForm submit footer', { concurrency: false }, () => {
    it('uses the server prompt limit in the instruction counter and input constraint', () => {
        const html = renderEditingForm({ backend: 'server-default', editPrompt: '用户真实编辑要求' });

        assert.match(html, new RegExp(`maxLength="${MAX_PROMPT_LENGTH}"`));
        assert.match(html, new RegExp(`\\/ ${MAX_PROMPT_LENGTH.toLocaleString('zh-CN')}`));
        assert.doesNotMatch(html, /\/ 1000/);
    });

    it('keeps the submit footer available outside desktop breakpoints', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            editPrompt: '用户真实编辑要求',
            imageFiles: [new File(['x'], 'source.png', { type: 'image/png' })]
        });

        assertSubmitFooterAvailable(html, '编辑图像');
        assert.match(html, /grid grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\] gap-1\.5 text-xs/);
        assert.match(html, /min-w-0 items-center justify-center rounded-md/);
        assert.doesNotMatch(html, /text-center whitespace-nowrap/);
        assert.doesNotMatch(html, /min-\[1760px\]:flex/);
        assert.match(html, /收藏提示词/);
        assert.match(html, /随机套用/);
        assert.match(html, /min-h-11 min-w-0 items-center justify-center/);
        assert.match(html, /focus-visible:ring-2 focus-visible:outline-none/);
        assert.match(html, /flex min-h-0 flex-1 flex-col overflow-hidden/);
        assert.match(html, /min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pb-4/);
        assert.match(html, /border-border bg-card flex shrink-0 border-t p-4/);
    });

    it('keeps submit copy while another busy action disables the form', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            isLoading: true,
            showLoadingState: false
        });

        assert.match(html, /编辑图像/);
        assert.doesNotMatch(html, /编辑中\.\.\./);
    });

    it('disables edit inspiration actions when the prompt or saved inspirations are unavailable', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            editPrompt: '',
            canApplyRandomInspiration: false
        });

        assertButtonDisabled(html, '收藏提示词');
        assertButtonDisabled(html, '随机套用');
        assert.doesNotMatch(html, /用户保存的编辑提示词/);
    });

    it('runs edit inspiration actions through the rendered footer controls', async () => {
        const savedPrompts: string[] = [];
        const appliedPrompts: string[] = [];
        const props = createEditingFormProps({
            backend: 'server-default',
            editPrompt: '  当前编辑灵感  '
        });
        props.onSaveInspiration = (prompt) => savedPrompts.push(prompt);
        props.onPickRandomInspiration = () => '  随机编辑灵感  ';
        props.setEditPrompt = (nextPrompt) => {
            appliedPrompts.push(typeof nextPrompt === 'function' ? nextPrompt('') : nextPrompt);
        };

        const view = await renderInClientDom(
            <I18nProvider>
                <EditingForm {...props} />
            </I18nProvider>
        );

        try {
            const saveButton = [...view.container.querySelectorAll('button')].find((button) =>
                button.textContent?.includes('收藏提示词')
            );
            const randomButton = [...view.container.querySelectorAll('button')].find((button) =>
                button.textContent?.includes('随机套用')
            );

            assert.ok(saveButton, 'missing edit save inspiration button');
            assert.ok(randomButton, 'missing edit random inspiration button');

            await view.click(saveButton);
            await view.click(randomButton);

            assert.deepEqual(savedPrompts, ['  当前编辑灵感  ']);
            assert.deepEqual(appliedPrompts, ['随机编辑灵感']);
        } finally {
            await view.cleanup();
        }
    });

    it('only applies edit profile corrections after the form becomes active', async () => {
        const countCorrections: number[][] = [];
        const partialImageCorrections: number[] = [];
        const streamModeCorrections: string[] = [];
        const sizeCorrections: string[] = [];
        const props = createEditingFormProps({
            backend: 'server-default',
            isActive: false,
            editN: [0],
            editModel: 'gpt-image-1',
            editSize: 'custom',
            partialImages: 0,
            streamMode: 'auto',
            streamingStrategy: 'off'
        });
        props.setEditN = (nextCount) => {
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
        props.setEditSize = (nextSize) => {
            sizeCorrections.push(typeof nextSize === 'function' ? nextSize('custom') : nextSize);
        };

        const view = await renderInClientDom(
            <I18nProvider>
                <EditingForm {...props} />
            </I18nProvider>
        );

        try {
            assert.deepEqual(countCorrections, []);
            assert.deepEqual(partialImageCorrections, []);
            assert.deepEqual(streamModeCorrections, []);
            assert.deepEqual(sizeCorrections, []);

            await view.render(
                <I18nProvider>
                    <EditingForm {...props} isActive />
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
});

describe('EditingForm advanced upstream controls', () => {
    it('keeps translated preset labels inside responsive control cells', () => {
        const html = renderEditingForm({ backend: 'server-default' });

        assert.match(html, /radio-group-item-content\]\]:min-w-0/);
        assert.match(html, /radio-group-item-content\]\]:overflow-hidden/);
        assert.match(html, /max-w-full min-w-0 text-center leading-4 break-words whitespace-normal/);
        assert.doesNotMatch(html, /radio-group-item-content\]\]:overflow-visible/);
        assert.doesNotMatch(html, /2xl:grid-cols-5/);
        assert.doesNotMatch(html, /lg:hidden 2xl:block/);
    });

    it('keeps the full professional accordion available on desktop and mobile', () => {
        const html = renderEditingForm({ backend: 'server-default', advancedTab: 'route' });

        assert.match(
            html,
            /<div class="border-border bg-muted\/20 rounded-md border"><button[^>]*aria-controls="editing-advanced-panel"/
        );
        assert.doesNotMatch(
            html,
            /<div class="[^"]*lg:hidden[^"]*"><button[^>]*aria-controls="editing-advanced-panel"/
        );
    });

    it('keeps model and streaming controls out of the default edit form surface', () => {
        const html = renderEditingForm({ backend: 'server-default', advancedOpen: false });

        assert.match(html, /参考图/);
        assert.match(html, /修改想法/);
        assert.match(html, /专业模式/);
        assert.doesNotMatch(html, /block truncate text-xs font-normal/);
        assert.doesNotMatch(html, /edit-model-select/);
        assert.doesNotMatch(html, /edit-stream-mode-select/);
    });

    it('translates the default backend into a user-facing route label near submit', () => {
        const html = renderEditingForm({ backend: 'server-default', advancedOpen: false });

        assert.match(html, /默认线路/);
        assert.match(html, /请求 1 张图片/);
    });

    it('renders edit model controls only in the professional model tab', () => {
        const html = renderEditingForm({ backend: 'server-default', advancedTab: 'model' });

        assert.match(html, /edit-model-select/);
        assert.match(html, /gpt-image-2 始终以高保真方式处理参考图/);
        assert.doesNotMatch(html, /edit-image-backend-select/);
    });

    it('keeps a restored edit model visible when the current directory does not list it', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            advancedTab: 'model',
            editModel: 'restored-provider-model',
            modelOptions: ['gpt-image-2']
        });

        assert.match(html, /restored-provider-model/);
    });

    it('renders edit stream controls only in the professional stream tab', () => {
        const html = renderEditingForm({ backend: 'server-default', advancedTab: 'stream' });

        assert.match(html, /edit-stream-mode-select/);
        assert.match(html, /edit-partial-1/);
        assert.doesNotMatch(html, /edit-model-select/);
    });

    it('hides Matsca-only edit stream controls for the default OpenAI-compatible profile', () => {
        const html = renderEditingForm({ backend: 'server-default', advancedTab: 'stream' });

        assert.doesNotMatch(html, /edit-partial-0/);
        assert.match(html, /edit-partial-1/);
        assert.match(html, /edit-partial-3/);
        assert.doesNotMatch(html, /edit-partial-4/);
    });

    it('renders Matsca edit stream controls when the active upstream profile allows them', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            advancedTab: 'stream',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });

        assert.match(html, /edit-partial-0/);
        assert.match(html, /edit-partial-4/);
    });

    it('intersects Matsca edit output and preview options with the Responses backend contract', () => {
        const streamHtml = renderEditingForm({
            backend: 'responses-image-generation',
            advancedTab: 'stream',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });
        const outputHtml = renderEditingForm({
            backend: 'responses-image-generation',
            advancedTab: 'output',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });

        assert.doesNotMatch(streamHtml, /edit-partial-0/);
        assert.match(streamHtml, /edit-partial-1/);
        assert.match(streamHtml, /edit-partial-3/);
        assert.doesNotMatch(streamHtml, /edit-partial-4/);
        assert.match(outputHtml, /id="edit-n-slider"/);
        assert.match(outputHtml, /aria-valuemax="1"/);
    });

    it('applies Responses limits to the default edit route when runtime selects that backend', () => {
        const streamHtml = renderEditingForm({
            backend: 'server-default',
            defaultImageBackend: 'responses-image-generation',
            advancedTab: 'stream',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });
        const outputHtml = renderEditingForm({
            backend: 'server-default',
            defaultImageBackend: 'responses-image-generation',
            advancedTab: 'output',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });

        assert.doesNotMatch(streamHtml, /edit-partial-0/);
        assert.match(streamHtml, /edit-partial-1/);
        assert.match(streamHtml, /edit-partial-3/);
        assert.doesNotMatch(streamHtml, /edit-partial-4/);
        assert.match(outputHtml, /id="edit-n-slider"/);
        assert.match(outputHtml, /aria-valuemax="1"/);
    });

    it('uses Matsca edit upload limits when the active upstream profile requires them', () => {
        const imageFiles = Array.from(
            { length: 9 },
            (_, index) => new File(['x'], `source-${index}.png`, { type: 'image/png' })
        );
        const html = renderEditingForm({
            backend: 'server-default',
            advancedOpen: false,
            editPrompt: '用户真实编辑要求',
            imageFiles,
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });

        assert.match(html, /最多 8 张/);
        assert.match(html, /9 \/ 8 张/);
        assert.match(html, /最多只能选择 8 张图片。/);
        assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*编辑图像[\s\S]*<\/button>/);
    });

    it('explains active profile upload limits and blocks invalid reference files before submit', () => {
        const emptyFile = { name: 'empty.png', size: 0, type: 'image/png' } as File;
        const html = renderEditingForm({
            backend: 'server-default',
            advancedOpen: false,
            editPrompt: '用户真实编辑要求',
            imageFiles: [emptyFile]
        });

        assert.match(html, /单张不超过 25 MB/);
        assert.match(html, /当前线路未声明参考图总大小上限/);
        assert.match(html, /参考图不能为空/);
        assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*编辑图像[\s\S]*<\/button>/);
    });

    it('shows the Responses combined input limit and disables an oversized reference-plus-mask set', () => {
        const imageFiles = [
            { name: 'source-a.png', size: MAX_OPENAI_UPLOAD_BYTES, type: 'image/png' } as File,
            { name: 'source-b.png', size: MAX_OPENAI_UPLOAD_BYTES, type: 'image/png' } as File
        ];
        const html = renderEditingForm({
            backend: 'responses-image-generation',
            advancedOpen: false,
            editPrompt: '用户真实编辑要求',
            imageFiles,
            maskFile: { name: 'mask.png', size: 1, type: 'image/png' } as File
        });

        assert.match(html, /当前 Responses 路线下，参考图和蒙版合计不能超过 50 MB/);
        assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*编辑图像[\s\S]*<\/button>/);
    });

    it('renders profile-aware high resolution edit size presets', () => {
        const openAiHtml = renderEditingForm({ backend: 'server-default' });
        const matscaHtml = renderEditingForm({
            backend: 'server-default',
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });

        assert.match(openAiHtml, /id="edit-size-wide-4k"/);
        assert.doesNotMatch(openAiHtml, /id="edit-size-square-4k"/);
        assert.match(matscaHtml, /id="edit-size-square-4k"/);
    });

    it('does not present unsafe custom edit dimensions as a valid exact pixel calculation', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            editSize: 'custom',
            editCustomWidth: Number.MAX_SAFE_INTEGER + 1,
            upstreamProfile: IMAGE_UPSTREAM_PROFILES.matsca
        });

        assert.match(html, /请先输入可精确计算的正整数尺寸。/);
        assert.match(html, /宽度和高度超出可精确处理的整数范围。/);
        assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*编辑图像[\s\S]*<\/button>/);
    });

    it('renders an explicit parallel batch toggle in edit stream settings', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            advancedTab: 'stream',
            allowStreamingBatch: true,
            enableParallelBatch: true,
            editN: [2]
        });

        assert.match(html, /并发批量/);
        assert.match(html, /多张图或多条提示词会按当前服务端配置的并发上限尝试执行/);
        assert.match(html, /id="edit-parallel-batch-enabled"/);
        assert.match(html, /aria-checked="true"/);
    });

    it('keeps edit parallel batch disabled for a single output image', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            advancedTab: 'stream',
            allowStreamingBatch: true,
            enableParallelBatch: true
        });

        assert.match(html, /选择至少 2 张图片或 2 条提示词后可启用并发/);
        assert.match(html, /id="edit-parallel-batch-enabled"/);
        assert.match(html, /aria-checked="false"/);
        assert.match(html, /disabled=""/);
    });

    it('keeps edit parallel batch disabled when streaming strategy is off', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            advancedTab: 'stream',
            allowStreamingBatch: true,
            enableParallelBatch: true,
            editN: [2],
            streamingStrategy: 'off'
        });

        assert.match(html, /并发批量需要流式模式；非流式会保持顺序执行。/);
        assert.match(html, /id="edit-parallel-batch-enabled"/);
        assert.match(html, /aria-checked="false"/);
        assert.match(html, /disabled=""/);
    });

    it('keeps edit parallel batch disabled when the server default streaming strategy is off', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            advancedTab: 'stream',
            allowStreamingBatch: true,
            enableParallelBatch: true,
            editN: [2],
            defaultStreamingStrategy: 'off'
        });

        assert.match(html, /并发批量需要流式模式；非流式会保持顺序执行。/);
        assert.match(html, /id="edit-parallel-batch-enabled"/);
        assert.match(html, /aria-checked="false"/);
        assert.match(html, /disabled=""/);
    });

    it('disables the edit stream mode selector when the server default streaming strategy is off', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            advancedTab: 'stream',
            defaultStreamingStrategy: 'off'
        });

        assert.match(
            html,
            /<button[^>]*(?:disabled=""[^>]*id="edit-stream-mode-select"|id="edit-stream-mode-select"[^>]*disabled="")/
        );
    });

    it('renders Responses-specific edit controls when the Responses backend is selected', () => {
        const html = renderEditingForm({ backend: 'responses-image-generation', upstreamProfileMixed: true });

        assert.match(html, /图片生成后端/);
        assert.match(html, /影响说明/);
        assert.match(html, /Responses image_generation 需要实验开关和顶层模型/);
        assert.match(html, /当前服务端渠道包含不同上游模式/);
        assert.match(
            html,
            /当前自动策略会由服务端按渠道选择传输方式，可能直接使用非流式；仅在实际选中流式且上游支持时使用流式。/
        );
        assert.match(html, /GPT 顶层模型/);
        assert.match(html, /思考强度/);
        assert.match(html, /提示词优化/);
        assert.doesNotMatch(html, /优先 Web 账号/);
    });

    it('explains the resolved edit server default streaming strategy', () => {
        const offHtml = renderEditingForm({
            backend: 'server-default',
            advancedTab: 'route',
            streamingStrategy: 'server-default',
            defaultStreamingStrategy: 'off'
        });
        const forceHtml = renderEditingForm({
            backend: 'server-default',
            advancedTab: 'route',
            streamingStrategy: 'server-default',
            defaultStreamingStrategy: 'force-sse'
        });

        assert.match(offHtml, /关闭流式会减少长连接不稳定因素/);
        assert.doesNotMatch(offHtml, /当前自动策略会由服务端按渠道选择传输方式/);
        assert.match(forceHtml, /强制 SSE 会跳过自动判断/);
        assert.doesNotMatch(forceHtml, /当前自动策略会由服务端按渠道选择传输方式/);
    });

    it('disables the experimental Responses backend when runtime capabilities do not allow it', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            allowResponsesImageBackend: false
        });

        assert.match(html, /当前运行时或默认服务器渠道未开放 Responses image_generation/);
        assert.doesNotMatch(html, /GPT 顶层模型/);
    });

    it('blocks Responses edits until a top-level model is available', () => {
        const html = renderEditingForm({
            backend: 'responses-image-generation',
            hasDefaultResponsesModel: false,
            editResponsesModel: '',
            editPrompt: '用户真实编辑要求',
            imageFiles: [new File(['x'], 'source.png', { type: 'image/png' })]
        });

        assert.match(html, /Responses image_generation 需要填写 GPT 顶层模型/);
        assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*编辑图像[\s\S]*<\/button>/);
    });

    it('renders Images API edit controls and compression when JPEG output is selected', () => {
        const html = renderEditingForm({ backend: 'images-api', outputFormat: 'jpeg', advancedTab: 'output' });

        assert.match(html, /Images API/);
        assert.match(html, /输出格式/);
        assert.match(html, /压缩：85%/);
        assert.match(html, /内容审核级别/);
        assert.doesNotMatch(html, /GPT 顶层模型/);
    });
});

describe('EditingForm reused history context', () => {
    it('shows which history values were carried into edit mode', () => {
        const html = renderEditingForm({
            backend: 'server-default',
            reuseContext: {
                sourceLabel: '最近生成：2026/6/2 12:00:00',
                restoredFields: ['参考图', '提示词', '模型', '尺寸', '数量'],
                promptPreview: '用户真实编辑提示词'
            }
        });

        assert.match(html, /已带入内容/);
        assert.match(html, /最近生成：2026\/6\/2 12:00:00/);
        assert.match(html, /参考图/);
        assert.match(html, /提示词/);
        assert.match(html, /模型/);
        assert.match(html, /尺寸/);
        assert.match(html, /数量/);
        assert.match(html, /用户真实编辑提示词/);
        assert.match(html, /这些内容已经写入编辑单，可以修改后再生成。/);
    });
});
