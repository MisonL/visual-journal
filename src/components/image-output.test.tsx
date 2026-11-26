import { buildImageActionTarget, formatLogTime, ImageOutput, resolveLogScopeCopy } from './image-output';
import { I18nProvider } from '@/lib/i18n';
import { renderInClientDom } from '@/test-utils/react-dom';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const noop = () => {};
const buttonContentPattern = '[\\s\\S]*?';

function renderImageOutput(viewMode: 'grid' | number): string {
    return renderToStaticMarkup(
        <I18nProvider>
            <ImageOutput
                imageBatch={[
                    { path: '/api/image/first.png', filename: 'first.png' },
                    { path: '/api/image/second.png', filename: 'second.png' }
                ]}
                viewMode={viewMode}
                onViewChange={noop}
                isLoading={false}
                onSendToEdit={noop}
                onDownloadImage={noop}
                onShareImage={noop}
                onCreateVariant={noop}
                onReusePrompt={noop}
                canCreateVariant
                canReusePrompt
                currentMode='generate'
                baseImagePreviewUrl={null}
                clientPasswordHash={null}
                canOpenLogs={false}
            />
        </I18nProvider>
    );
}

describe('ImageOutput result actions', () => {
    it('does not show fixed preview timing or dimensions before real image metadata is known', () => {
        const html = renderImageOutput(0);

        assert.match(html, /第 1 张 \/ 共 2 张/);
        assert.doesNotMatch(html, /预计 8-12 秒/);
        assert.doesNotMatch(html, /1024 x 768/);
    });

    it('uses the localized generated-image alt text when a caller does not override it', () => {
        const html = renderImageOutput(0);

        assert.match(html, /alt="生成图片输出"/);
        assert.doesNotMatch(html, /Generated image output/);
    });

    it('formats activity timestamps with the selected app locale and preserves invalid diagnostic values', () => {
        const timestamp = '2026-05-31T12:15:30.000Z';

        assert.equal(formatLogTime(timestamp, 'zh-CN'), new Date(timestamp).toLocaleTimeString('zh-CN'));
        assert.equal(formatLogTime(timestamp, 'en-US'), new Date(timestamp).toLocaleTimeString('en-US'));
        assert.equal(formatLogTime('not-a-timestamp', 'zh-CN'), 'not-a-timestamp');
    });

    it('uses the no-image state in the preview header before generation', () => {
        const html = renderToStaticMarkup(
            <I18nProvider>
                <ImageOutput
                    imageBatch={null}
                    viewMode='grid'
                    onViewChange={noop}
                    isLoading={false}
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    canCreateVariant={false}
                    canReusePrompt={false}
                    currentMode='generate'
                    baseImagePreviewUrl={null}
                    clientPasswordHash={null}
                    canOpenLogs={false}
                />
            </I18nProvider>
        );

        assert.match(html, /还没有生成图像/);
        assert.match(html, /写下灵感后点击生成/);
        assert.match(html, /workbench-panel[^"]*h-fit xl:h-full[\s\S]*preview-gallery-board/);
        assert.match(html, /min-h-\[220px\] shrink-0 sm:min-h-\[248px\] lg:min-h-\[272px\] xl:min-h-0 xl:flex-1/);
        assert.doesNotMatch(html, /min-h-\[20rem\]/);
        assert.match(html, /max-w-\[30rem\]/);
        assert.match(html, /items-center justify-center/);
        assert.match(html, /text-center/);
        assert.doesNotMatch(html, /2xl:max-w-\[34rem\]/);
        assert.doesNotMatch(html, /photo-paper relative flex aspect-\[8\/5\]/);
        assert.doesNotMatch(html, /max-w-\[780px\] flex-col justify-between/);
        assert.doesNotMatch(html, /<img/);
        assert.doesNotMatch(html, /workbench-sample/);
        assert.doesNotMatch(html, /灵感样张/);
        assert.doesNotMatch(html, /1024 x 768/);
        for (const action of ['继续编辑', '再次生成', '复用提示词', '对比', '下载']) {
            assert.match(
                html,
                new RegExp(
                    `<button[^>]*disabled=""[^>]*>${buttonContentPattern}${action}${buttonContentPattern}</button>`
                )
            );
        }
    });

    it('keeps the full preview stage height after images exist', () => {
        const html = renderImageOutput(0);

        assert.match(html, /workbench-panel[^"]*h-full[\s\S]*preview-gallery-board/);
        assert.match(html, /min-h-\[300px\] flex-1 sm:min-h-\[420px\] lg:min-h-\[520px\]/);
        assert.doesNotMatch(html, /min-h-\[220px\] shrink-0 sm:min-h-\[248px\] lg:min-h-\[272px\]/);
    });

    it('uses an edit reference placeholder instead of the sample image in edit mode', () => {
        const html = renderToStaticMarkup(
            <I18nProvider>
                <ImageOutput
                    imageBatch={null}
                    viewMode='grid'
                    onViewChange={noop}
                    isLoading={false}
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    canCreateVariant={false}
                    canReusePrompt={false}
                    currentMode='edit'
                    baseImagePreviewUrl={null}
                    clientPasswordHash={null}
                    canOpenLogs={false}
                />
            </I18nProvider>
        );

        assert.match(html, /先放入参考图/);
        assert.match(html, /等待参考图/);
        assert.doesNotMatch(html, /min-h-\[18rem\]/);
        assert.match(html, /max-w-\[30rem\]/);
        assert.doesNotMatch(html, /photo-paper relative flex aspect-\[4\/3\]/);
        assert.doesNotMatch(html, /灵感样张/);
    });

    it('shows the edit reference image before an edit result exists', () => {
        const html = renderToStaticMarkup(
            <I18nProvider>
                <ImageOutput
                    imageBatch={null}
                    viewMode='grid'
                    onViewChange={noop}
                    isLoading={false}
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    canCreateVariant={false}
                    canReusePrompt={false}
                    currentMode='edit'
                    baseImagePreviewUrl='data:image/png;base64,reference'
                    clientPasswordHash={null}
                    canOpenLogs={false}
                />
            </I18nProvider>
        );

        assert.match(html, /参考图已就绪/);
        assert.match(html, /图生图参考图预览/);
        assert.match(html, /参考图/);
        assert.doesNotMatch(html, /灵感样张/);
    });

    it('requires an explicit selection before single-image actions in the multi-image grid view', () => {
        const html = renderImageOutput('grid');

        assert.match(html, /aria-label="选择第 1 张图片"/);
        assert.match(html, /aria-label="选择第 2 张图片"/);
        assert.match(html, /请选择一张图片/);
        assert.doesNotMatch(html, /第 1 张 \/ 共 2 张/);

        for (const action of ['继续编辑', '对比', '下载', '分享']) {
            assert.match(
                html,
                new RegExp(
                    `<button[^>]*disabled=""[^>]*>${buttonContentPattern}${action}${buttonContentPattern}</button>`
                )
            );
        }
    });

    it('keeps single-image actions available after selecting a multi-image result', () => {
        const html = renderImageOutput(1);

        assert.match(html, /第 2 张 \/ 共 2 张/);

        for (const action of ['继续编辑', '对比', '下载', '分享']) {
            assert.match(
                html,
                new RegExp(`<button[^>]*>${buttonContentPattern}${action}${buttonContentPattern}</button>`)
            );
            assert.doesNotMatch(
                html,
                new RegExp(
                    `<button[^>]*disabled=""[^>]*>${buttonContentPattern}${action}${buttonContentPattern}</button>`
                )
            );
        }
    });

    it('builds selected image action targets with storage mode', () => {
        assert.deepEqual(
            buildImageActionTarget({
                path: 'data:image/png;base64,selected',
                filename: 'selected.png',
                storageMode: 'indexeddb'
            }),
            { filename: 'selected.png', storageMode: 'indexeddb' }
        );
        assert.deepEqual(
            buildImageActionTarget({
                path: '/api/image/fs.png',
                filename: 'fs.png'
            }),
            { filename: 'fs.png' }
        );
        assert.equal(buildImageActionTarget(null), null);
    });

    it('keeps compare disabled for single-image results', () => {
        const html = renderToStaticMarkup(
            <I18nProvider>
                <ImageOutput
                    imageBatch={[{ path: '/api/image/only.png', filename: 'only.png' }]}
                    viewMode={0}
                    onViewChange={noop}
                    isLoading={false}
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    canCreateVariant
                    canReusePrompt
                    currentMode='generate'
                    baseImagePreviewUrl={null}
                    clientPasswordHash={null}
                    canOpenLogs={false}
                />
            </I18nProvider>
        );

        assert.match(
            html,
            new RegExp(`<button[^>]*disabled=""[^>]*>${buttonContentPattern}对比${buttonContentPattern}</button>`)
        );
    });

    it('enables compare for single-image results with a previous history image', () => {
        const html = renderToStaticMarkup(
            <I18nProvider>
                <ImageOutput
                    imageBatch={[{ path: '/api/image/only.png', filename: 'only.png' }]}
                    compareImage={{ path: '/api/image/previous.png', filename: 'previous.png' }}
                    viewMode={0}
                    onViewChange={noop}
                    isLoading={false}
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    canCreateVariant
                    canReusePrompt
                    currentMode='generate'
                    baseImagePreviewUrl={null}
                    clientPasswordHash={null}
                    canOpenLogs={false}
                />
            </I18nProvider>
        );

        assert.match(
            html,
            new RegExp(`<button(?![^>]*disabled="")[^>]*>${buttonContentPattern}对比${buttonContentPattern}</button>`)
        );
    });

    it('closes comparison and disables a target that fails to load', async () => {
        const view = await renderInClientDom(
            <I18nProvider>
                <ImageOutput
                    imageBatch={[{ path: '/api/image/current.png', filename: 'current.png' }]}
                    compareImage={{ path: '/api/image/missing.png', filename: 'missing.png' }}
                    viewMode={0}
                    onViewChange={noop}
                    isLoading={false}
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    canCreateVariant
                    canReusePrompt
                    currentMode='generate'
                    baseImagePreviewUrl={null}
                    clientPasswordHash={null}
                    canOpenLogs={false}
                />
            </I18nProvider>
        );
        try {
            const compareButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
                button.textContent?.includes('对比')
            );
            assert.ok(compareButton, 'missing compare button');
            await view.click(compareButton);

            const compareImage = [...view.container.querySelectorAll<HTMLImageElement>('img')].find(
                (image) => image.alt === '上一张 missing.png'
            );
            assert.ok(compareImage, 'missing comparison target image');
            const errorEvent = new compareImage.ownerDocument.defaultView!.Event('error', { bubbles: true });
            await act(async () => {
                compareImage.dispatchEvent(errorEvent);
            });

            assert.match(view.container.textContent ?? '', /对比中的图片已不可访问，已退出对比/);
            const disabledCompareButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
                (button) => button.textContent?.includes('对比')
            );
            assert.equal(disabledCompareButton?.disabled, true);
        } finally {
            await view.cleanup();
        }
    });

    it('closes comparison and disables it when the current image fails to load', async () => {
        const view = await renderInClientDom(
            <I18nProvider>
                <ImageOutput
                    imageBatch={[{ path: '/api/image/current.png', filename: 'current.png' }]}
                    compareImage={{ path: '/api/image/previous.png', filename: 'previous.png' }}
                    viewMode={0}
                    onViewChange={noop}
                    isLoading={false}
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    canCreateVariant
                    canReusePrompt
                    currentMode='generate'
                    baseImagePreviewUrl={null}
                    clientPasswordHash={null}
                    canOpenLogs={false}
                />
            </I18nProvider>
        );
        try {
            const compareButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
                button.textContent?.includes('对比')
            );
            assert.ok(compareButton, 'missing compare button');
            await view.click(compareButton);

            const currentImage = [...view.container.querySelectorAll<HTMLImageElement>('img')].find(
                (image) => image.alt === '当前图 current.png'
            );
            assert.ok(currentImage, 'missing current comparison image');
            const errorEvent = new currentImage.ownerDocument.defaultView!.Event('error', { bubbles: true });
            await act(async () => {
                currentImage.dispatchEvent(errorEvent);
            });

            assert.match(view.container.textContent ?? '', /对比中的图片已不可访问，已退出对比/);
            const disabledCompareButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
                (button) => button.textContent?.includes('对比')
            );
            assert.equal(disabledCompareButton?.disabled, true);
        } finally {
            await view.cleanup();
        }
    });

    it('uses batch-specific activity scope copy for a multi-image grid', () => {
        assert.deepEqual(
            resolveLogScopeCopy({
                hasLogScope: true,
                hasSelectedImageBatch: true,
                hasScopeCandidate: true,
                isLogScopeBatch: true
            }),
            { scopeKey: 'logs.scopeBatch', emptyKey: 'logs.emptyForBatch' }
        );
        assert.deepEqual(
            resolveLogScopeCopy({
                hasLogScope: false,
                hasSelectedImageBatch: true,
                hasScopeCandidate: false,
                isLogScopeBatch: true
            }),
            { scopeKey: 'logs.scopeMissingBatch', emptyKey: 'logs.historyBatchWithoutScope' }
        );
    });

    it('uses user-facing generation activity copy for the activity entry', () => {
        const html = renderToStaticMarkup(
            <I18nProvider>
                <ImageOutput
                    imageBatch={[{ path: '/api/image/only.png', filename: 'only.png' }]}
                    viewMode={0}
                    onViewChange={noop}
                    isLoading={false}
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    canCreateVariant
                    canReusePrompt
                    currentMode='generate'
                    baseImagePreviewUrl={null}
                    clientPasswordHash='test-hash'
                    canOpenLogs
                />
            </I18nProvider>
        );

        assert.match(html, /查看动态/);
        assert.doesNotMatch(html, /查看日志/);
    });

    it('shows an explicit failure state with retry near the canvas', () => {
        const html = renderToStaticMarkup(
            <I18nProvider>
                <ImageOutput
                    imageBatch={null}
                    viewMode='grid'
                    onViewChange={noop}
                    isLoading={false}
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    failureMessage='上游或 API 中转站异常。请稍后重试。'
                    onRetry={noop}
                    canCreateVariant={false}
                    canReusePrompt={false}
                    currentMode='generate'
                    baseImagePreviewUrl={null}
                    clientPasswordHash={null}
                    canOpenLogs={false}
                />
            </I18nProvider>
        );

        assert.match(html, /生成失败/);
        assert.match(html, /上游或 API 中转站异常。请稍后重试。/);
        assert.match(html, new RegExp(`<button[^>]*>${buttonContentPattern}重试生成${buttonContentPattern}</button>`));
        assert.doesNotMatch(html, /灵感样张/);
    });

    it('uses edit-specific failure and retry text for an image-edit request', () => {
        const html = renderToStaticMarkup(
            <I18nProvider>
                <ImageOutput
                    imageBatch={null}
                    viewMode='grid'
                    onViewChange={noop}
                    isLoading={false}
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    failureMessage='编辑上游不可用。'
                    onRetry={noop}
                    canCreateVariant={false}
                    canReusePrompt={false}
                    currentMode='edit'
                    baseImagePreviewUrl={null}
                    clientPasswordHash={null}
                    canOpenLogs={false}
                />
            </I18nProvider>
        );

        assert.match(html, /编辑失败/);
        assert.match(html, new RegExp(`<button[^>]*>${buttonContentPattern}重试编辑${buttonContentPattern}</button>`));
        assert.doesNotMatch(html, /重试生成/);
    });
});

describe('ImageOutput generation progress', () => {
    function renderLoading(props: { elapsedSeconds?: number; onCancel?: () => void }): string {
        return renderToStaticMarkup(
            <I18nProvider>
                <ImageOutput
                    imageBatch={null}
                    viewMode='grid'
                    onViewChange={noop}
                    isLoading
                    onSendToEdit={noop}
                    onDownloadImage={noop}
                    onShareImage={noop}
                    onCreateVariant={noop}
                    onReusePrompt={noop}
                    canCreateVariant={false}
                    canReusePrompt={false}
                    currentMode='generate'
                    baseImagePreviewUrl={null}
                    clientPasswordHash={null}
                    canOpenLogs={false}
                    {...props}
                />
            </I18nProvider>
        );
    }

    it('shows how long the request has been waiting instead of a bare spinner', () => {
        const html = renderLoading({ elapsedSeconds: 42 });

        assert.match(html, /已等待 42 秒/);
        assert.match(html, /data-testid="generation-elapsed"/);
    });

    it('hides the elapsed line before the first second ticks', () => {
        const html = renderLoading({ elapsedSeconds: 0 });

        assert.doesNotMatch(html, /已等待/);
    });

    it('offers a cancel action while a generation is running', () => {
        const html = renderLoading({ elapsedSeconds: 5, onCancel: noop });

        assert.match(html, new RegExp(`<button[^>]*>${buttonContentPattern}取消生成${buttonContentPattern}</button>`));
        assert.match(html, /data-testid="cancel-generation"/);
    });

    it('does not render a cancel action when the caller cannot cancel', () => {
        const html = renderLoading({ elapsedSeconds: 5 });

        assert.doesNotMatch(html, /取消生成/);
    });
});
