type Translate = (key: string, values?: Record<string, string | number>) => string;

export type GenerationActivityItem = {
    id: string;
    label: string;
    detail: string;
    tone: 'progress' | 'success' | 'warning' | 'neutral';
};

export type GenerationBatchProgress = {
    completed: number;
    failed: number;
    total: number;
};

export type GenerationBatchResult = unknown | Error;

type GenerationActivityOptions = {
    isLoading: boolean;
    isSendingToEdit: boolean;
    mode: 'generate' | 'edit';
    streamingPreviewCount: number;
    errorMessage?: string;
    /** 失败详情已在画布内呈现，时间线无需重复。 */
    errorShownInCanvas?: boolean;
    completedGenerationCount: number | null;
    batchProgress?: GenerationBatchProgress | null;
    t: Translate;
};

export function buildGenerationActivityItems(options: GenerationActivityOptions): GenerationActivityItem[] {
    const items: GenerationActivityItem[] = [];

    if (options.isLoading) {
        items.push({
            id: 'generating',
            label: options.t('history.activityGenerating'),
            detail:
                options.mode === 'edit'
                    ? options.t('history.activityEditingDetail')
                    : options.t('history.activityGeneratingDetail'),
            tone: 'progress'
        });
    } else if (options.isSendingToEdit) {
        items.push({
            id: 'preparing-edit',
            label: options.t('history.activityPreparingEdit'),
            detail: options.t('history.activityPreparingEditDetail'),
            tone: 'progress'
        });
    }

    if (
        options.batchProgress &&
        options.batchProgress.total > 1 &&
        (options.isLoading || options.batchProgress.failed > 0)
    ) {
        items.push({
            id: 'batch-progress',
            label: options.t('history.activityBatchProgress'),
            detail: buildBatchProgressDetail(options.batchProgress, options.t),
            tone: options.batchProgress.failed > 0 ? 'warning' : 'progress'
        });
    }

    if (options.streamingPreviewCount > 0) {
        items.push({
            id: 'streaming-preview',
            label: options.t('history.activityStreaming'),
            detail: options.t('history.activityStreamingDetail', { count: options.streamingPreviewCount }),
            tone: 'progress'
        });
    }

    // 画布内已经展示了失败卡片时，时间线不再重复同一条失败，避免同一错误出现两遍。
    if (options.errorMessage && options.errorShownInCanvas !== true) {
        const failedLabel =
            options.mode === 'edit' ? options.t('history.activityEditFailed') : options.t('history.activityFailed');
        items.push({
            id: 'failed',
            label: failedLabel,
            detail: buildFailureActivityDetail(options.errorMessage, options.t),
            tone: 'warning'
        });
    }

    if (!options.isLoading && !options.isSendingToEdit && options.completedGenerationCount !== null) {
        items.push({
            id: 'saved',
            label: options.t('history.activitySaved'),
            detail: options.t('history.activitySavedDetail', { count: options.completedGenerationCount }),
            tone: 'success'
        });
    }

    return items;
}

export function selectAnnouncedGenerationActivity(items: GenerationActivityItem[]): GenerationActivityItem | undefined {
    return (
        items.find((item) => item.id === 'preparing-edit') ??
        items.find((item) => item.id === 'failed') ??
        items.find((item) => item.id === 'batch-progress' && item.tone === 'warning') ??
        items.find((item) => item.id === 'saved') ??
        items.find((item) => item.id === 'batch-progress') ??
        items.at(-1)
    );
}

export function advanceGenerationBatchProgress(
    current: GenerationBatchProgress | null,
    total: number,
    didFail: boolean
): GenerationBatchProgress {
    const safeTotal = Math.max(0, Math.floor(total));
    const base =
        current && current.total === safeTotal
            ? current
            : {
                  completed: 0,
                  failed: 0,
                  total: safeTotal
              };
    if (base.completed >= safeTotal) {
        return base;
    }
    return {
        completed: Math.min(safeTotal, base.completed + 1),
        failed: Math.min(safeTotal, base.failed + (didFail ? 1 : 0)),
        total: safeTotal
    };
}

export function collectFailedBatchPrompts(prompts: string[], results: GenerationBatchResult[]): string[] {
    return results.flatMap((result, index) => (result instanceof Error ? [prompts[index]] : []));
}

export function countCompletedBatchResults(results: GenerationBatchResult[]): number {
    return results.filter((result) => !(result instanceof Error)).length;
}

export function buildFailureActivityDetail(message: string, t: Translate): string {
    const trimmedMessage = message.trim();
    const effectiveMessage = trimmedMessage || t('error.unexpected');
    return t('history.activityFailedDetail', { message: effectiveMessage });
}

function buildBatchProgressDetail(progress: GenerationBatchProgress, t: Translate): string {
    if (progress.failed > 0) {
        return t('history.activityBatchProgressWithFailures', {
            completed: progress.completed,
            failed: progress.failed,
            total: progress.total
        });
    }

    return t('history.activityBatchProgressDetail', {
        completed: progress.completed,
        total: progress.total
    });
}
