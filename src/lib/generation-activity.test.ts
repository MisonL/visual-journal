import {
    advanceGenerationBatchProgress,
    buildFailureActivityDetail,
    buildGenerationActivityItems,
    collectFailedBatchPrompts,
    countCompletedBatchResults,
    selectAnnouncedGenerationActivity,
    type GenerationActivityItem
} from './generation-activity';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const messages: Record<string, string> = {
    'error.unexpected': '发生未知错误。',
    'history.activityEditingDetail': '正在根据参考图生成新画面，完成后会进入最近生成。',
    'history.activityFailed': '生成失败',
    'history.activityEditFailed': '编辑失败',
    'history.activityFailedDetail': '{message}',
    'history.activityBatchProgress': '批量进度',
    'history.activityBatchProgressDetail': '已完成 {completed}/{total} 条任务。',
    'history.activityBatchProgressWithFailures': '已完成 {completed}/{total} 条任务，失败 {failed} 条。',
    'history.activityGenerating': '正在生成',
    'history.activityGeneratingDetail': '正在把当前创作单送去生成，完成后会进入最近生成。',
    'history.activityPreparingEdit': '正在准备编辑素材',
    'history.activityPreparingEditDetail': '正在读取当前图片，完成后会切换到编辑创作单。',
    'history.activitySaved': '图片保存完成',
    'history.activitySavedDetail': '本次结果共 {count} 张，已可继续编辑或下载。',
    'history.activityStreaming': '流式预览已更新',
    'history.activityStreamingDetail': '已收到 {count} 张过程预览。'
};

function t(key: string, values?: Record<string, string | number>): string {
    return (messages[key] || key).replace(/\{(\w+)\}/g, (match, valueKey) => String(values?.[valueKey] ?? match));
}

function ids(items: GenerationActivityItem[]): string[] {
    return items.map((item) => item.id);
}

describe('buildGenerationActivityItems', () => {
    it('reports request start, streaming preview, and failure reason from live state flags', () => {
        const items = buildGenerationActivityItems({
            isLoading: true,
            isSendingToEdit: false,
            mode: 'edit',
            streamingPreviewCount: 2,
            errorMessage: '上游服务不可用',
            completedGenerationCount: 1,
            t
        });

        assert.deepEqual(ids(items), ['generating', 'streaming-preview', 'failed']);
        assert.match(items[0].detail, /参考图生成新画面/);
        assert.match(items[1].detail, /2 张过程预览/);
        assert.match(items[2].detail, /上游服务不可用/);
        assert.equal(items[2].label, '编辑失败');
        assert.doesNotMatch(items[2].detail, /建议检查 API 设置后重试/);
    });

    it('omits the timeline failure when the canvas already shows the same failure', () => {
        const base = {
            isLoading: false,
            isSendingToEdit: false,
            mode: 'generate' as const,
            streamingPreviewCount: 0,
            errorMessage: '上游服务不可用',
            completedGenerationCount: null,
            t
        };

        // 默认保留失败项（兼容既有调用方）。
        assert.deepEqual(ids(buildGenerationActivityItems(base)), ['failed']);

        // 画布已展示失败时，时间线不再重复。
        assert.deepEqual(ids(buildGenerationActivityItems({ ...base, errorShownInCanvas: true })), []);
    });

    it('reports saved completion only after loading ends with a completed generation count', () => {
        const items = buildGenerationActivityItems({
            isLoading: false,
            isSendingToEdit: false,
            mode: 'generate',
            streamingPreviewCount: 0,
            completedGenerationCount: 1,
            t
        });

        assert.deepEqual(ids(items), ['saved']);
        assert.match(items[0].detail, /1 张/);
    });

    it('does not report saved completion without a completed generation count', () => {
        const items = buildGenerationActivityItems({
            isLoading: false,
            isSendingToEdit: false,
            mode: 'generate',
            streamingPreviewCount: 0,
            completedGenerationCount: null,
            t
        });

        assert.deepEqual(items, []);
    });

    it('reports live batch progress while a prompt batch is running', () => {
        const items = buildGenerationActivityItems({
            isLoading: true,
            isSendingToEdit: false,
            mode: 'generate',
            streamingPreviewCount: 0,
            completedGenerationCount: null,
            batchProgress: {
                completed: 2,
                failed: 0,
                total: 3
            },
            t
        });

        assert.deepEqual(ids(items), ['generating', 'batch-progress']);
        assert.match(items[1].detail, /2\/3 条任务/);
        assert.equal(items[1].tone, 'progress');
    });

    it('keeps a batch failure summary after loading ends', () => {
        const items = buildGenerationActivityItems({
            isLoading: false,
            isSendingToEdit: false,
            mode: 'generate',
            streamingPreviewCount: 0,
            errorMessage: '上游服务不可用',
            completedGenerationCount: 2,
            batchProgress: {
                completed: 3,
                failed: 1,
                total: 3
            },
            t
        });

        assert.deepEqual(ids(items), ['batch-progress', 'failed', 'saved']);
        assert.match(items[0].detail, /失败 1 条/);
        assert.equal(items[0].tone, 'warning');
    });

    it('preserves upstream advice without appending a generic recommendation', () => {
        const detail = buildFailureActivityDetail('API 请求失败。建议：稍后重试。', t);

        assert.equal(detail, 'API 请求失败。建议：稍后重试。');
    });

    it('does not replay a saved result after preparation for editing finishes', () => {
        const buildItems = (isSendingToEdit: boolean, completedGenerationCount: number | null) =>
            buildGenerationActivityItems({
                isLoading: false,
                isSendingToEdit,
                mode: 'generate',
                streamingPreviewCount: 0,
                completedGenerationCount,
                t
            });

        assert.deepEqual(ids(buildItems(false, 1)), ['saved']);
        assert.deepEqual(ids(buildItems(true, null)), ['preparing-edit']);
        assert.deepEqual(buildItems(false, null), []);
    });
});

describe('selectAnnouncedGenerationActivity', () => {
    it('prioritizes current edit preparation over stale generation activity', () => {
        const items = buildGenerationActivityItems({
            isLoading: false,
            isSendingToEdit: true,
            mode: 'generate',
            streamingPreviewCount: 1,
            completedGenerationCount: null,
            batchProgress: {
                completed: 3,
                failed: 1,
                total: 3
            },
            t
        });

        assert.deepEqual(ids(items), ['preparing-edit', 'batch-progress', 'streaming-preview']);
        assert.equal(selectAnnouncedGenerationActivity(items)?.id, 'preparing-edit');
    });

    it('prioritizes terminal and changing batch states over stale activity', () => {
        const items: GenerationActivityItem[] = [
            { id: 'generating', label: '正在生成', detail: '请求中', tone: 'progress' },
            { id: 'streaming-preview', label: '流式预览', detail: '1 张', tone: 'progress' },
            { id: 'saved', label: '保存完成', detail: '1 张', tone: 'success' }
        ];

        assert.equal(selectAnnouncedGenerationActivity(items)?.id, 'saved');
        assert.equal(
            selectAnnouncedGenerationActivity([
                ...items,
                { id: 'batch-progress', label: '批量进度', detail: '失败 1 条', tone: 'warning' }
            ])?.id,
            'batch-progress'
        );
        assert.equal(
            selectAnnouncedGenerationActivity([
                ...items,
                { id: 'failed', label: '生成失败', detail: '上游错误', tone: 'warning' }
            ])?.id,
            'failed'
        );
    });
});

describe('advanceGenerationBatchProgress', () => {
    it('increments completed and failed counts without exceeding total', () => {
        const first = advanceGenerationBatchProgress(null, 2, false);
        const second = advanceGenerationBatchProgress(first, 2, true);
        const third = advanceGenerationBatchProgress(second, 2, true);

        assert.deepEqual(first, { completed: 1, failed: 0, total: 2 });
        assert.deepEqual(second, { completed: 2, failed: 1, total: 2 });
        assert.deepEqual(third, { completed: 2, failed: 1, total: 2 });
    });
});

describe('collectFailedBatchPrompts', () => {
    it('keeps the prompts whose batch jobs returned errors', () => {
        const failedPrompts = collectFailedBatchPrompts(
            ['窗边花束', '奶油色卧室', '海边下午'],
            [{ images: [] }, new Error('upstream failed'), new Error('timeout')]
        );

        assert.deepEqual(failedPrompts, ['奶油色卧室', '海边下午']);
    });
});

describe('countCompletedBatchResults', () => {
    it('counts only jobs that actually returned a successful result', () => {
        const completed = countCompletedBatchResults([
            { images: [] },
            { images: [] },
            new Error('批量生成已暂停，任务尚未开始。'),
            new Error('批量生成已暂停，任务尚未开始。')
        ]);

        assert.equal(completed, 2);
    });
});
