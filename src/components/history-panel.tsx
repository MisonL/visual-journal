'use client';

import { ActivityTimeline } from '@/components/generation-activity-timeline';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DialogFooter,
    DialogClose
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
    getModelRates,
    RATED_IMAGE_MODELS,
    isGptImageModel,
    isNonNegativeFiniteNumber,
    isValidCostDetails
} from '@/lib/cost-utils';
import type { GenerationActivityItem } from '@/lib/generation-activity';
import {
    RESULT_FEEDBACK_NOTE_MAX_LENGTH,
    getHistoryEntryId,
    isSameHistoryEntry,
    type HistoryMetadata,
    type ResultFeedbackValue
} from '@/lib/history-metadata';
import { useI18n } from '@/lib/i18n';
import {
    formatImageDurationLabel,
    getImageBackgroundLabel,
    getImageModerationLabel,
    getImageOutputFormatLabel,
    getImageQualityLabel
} from '@/lib/image-display-labels';
import { cn } from '@/lib/utils';
import {
    Copy,
    Check,
    Layers,
    DollarSign,
    Pencil,
    Sparkles as SparklesIcon,
    HardDrive,
    Database,
    FileImage,
    Trash2,
    WandSparkles,
    Bookmark,
    Plus,
    ChevronDown,
    AlertTriangle,
    ThumbsUp,
    ThumbsDown,
    X
} from 'lucide-react';
import Image from 'next/image';
import * as React from 'react';

type HistoryPanelProps = {
    history: HistoryMetadata[];
    inspirations: InspirationItem[];
    activityItems?: GenerationActivityItem[];
    isSendingToEdit?: boolean;
    onSelectImage: (item: HistoryMetadata) => void;
    onApplyPrompt: (prompt: string, source: PromptApplySource) => void;
    onSaveInspiration: (prompt: string) => void;
    onSendHistoryToEdit: (item: HistoryMetadata) => void | Promise<void>;
    onMarkResultFeedback: (item: HistoryMetadata, value: ResultFeedbackValue) => void;
    onUpdateResultFeedbackNote: (item: HistoryMetadata, note: string) => void;
    onDeleteInspiration: (id: number) => void;
    onDownloadHistoryItem: (item: HistoryMetadata) => void;
    onClearHistory: () => void;
    getImageSrc: (filename: string) => string | undefined;
    onDeleteItemRequest: (item: HistoryMetadata) => void;
    itemPendingDeleteConfirmation: HistoryMetadata | null;
    onConfirmDeletion: () => void;
    onCancelDeletion: () => void;
    deletePreferenceDialogValue: boolean;
    onDeletePreferenceDialogChange: (isChecked: boolean) => void;
    cleanupEnabled?: boolean;
    permanentlySavedFilenames?: ReadonlySet<string>;
    onUpdatePermanentSave?: (action: 'preserve' | 'release', filenames: string[]) => Promise<void>;
};

type HistoryPanelTab = 'inspiration' | 'history';

export function resolveHistoryPanelTabSync(input: {
    activeTab: HistoryPanelTab;
    historyCount: number;
    inspirationCount: number;
}): HistoryPanelTab {
    if (input.activeTab === 'inspiration' && input.historyCount > 0 && input.inspirationCount === 0) {
        return 'history';
    }
    if (input.activeTab === 'history' && input.historyCount === 0 && input.inspirationCount > 0) {
        return 'inspiration';
    }
    return input.activeTab;
}

export type InspirationItem = {
    id: number;
    prompt: string;
    createdAt: number;
};

export type { GenerationActivityItem } from '@/lib/generation-activity';

export type PromptApplySource =
    | {
          type: 'inspiration';
          title: string;
      }
    | {
          type: 'history';
          item: HistoryMetadata;
      };

const emptyPermanentFilenames: ReadonlySet<string> = new Set();

const calculateCost = (value: number, rate: number): string | null => {
    if (!isNonNegativeFiniteNumber(value) || !isNonNegativeFiniteNumber(rate)) return null;
    const cost = value * rate;
    return isNonNegativeFiniteNumber(cost) ? cost.toFixed(4) : null;
};

const formatMoney = (value: number): string | null => (isNonNegativeFiniteNumber(value) ? value.toFixed(4) : null);
const formatEstimatedTokenCost = (value: number, rate: number | undefined, unavailableLabel: string): string => {
    if (rate === undefined) return unavailableLabel;
    const cost = calculateCost(value, rate);
    return cost === null ? unavailableLabel : `$${cost}`;
};

export type HistoryCostSummary = {
    totalCost: number;
    totalImages: number;
    estimatedImages: number;
    averageCost: number;
};

export function summarizeHistoryCosts(history: HistoryMetadata[]): HistoryCostSummary {
    let totalCost = 0;
    let totalImages = 0;
    let estimatedImages = 0;

    for (const item of history) {
        const imageCount = item.images.length;
        totalImages += imageCount;
        if (!isValidCostDetails(item.costDetails)) continue;

        totalCost += item.costDetails.estimated_cost_usd;
        estimatedImages += imageCount;
    }

    const roundedTotalCost = Math.round(totalCost * 10000) / 10000;
    return {
        totalCost: roundedTotalCost,
        totalImages,
        estimatedImages,
        averageCost: estimatedImages > 0 ? roundedTotalCost / estimatedImages : 0
    };
}

function getHistoryModelLabel(item: HistoryMetadata, t: ReturnType<typeof useI18n>['t']): string {
    return item.model ?? t('history.modelNotRecorded');
}

function getStorageLabel(storageMode: HistoryMetadata['storageModeUsed'], t: ReturnType<typeof useI18n>['t']): string {
    return storageMode === 'fs' ? t('history.storageFile') : t('history.storageDb');
}

function getCostBadge(
    item: HistoryMetadata,
    labels: { actual: string; estimated: string; pending: string }
): { label: string; actual: boolean } | null {
    if (
        item.actualCostDetails?.source === 'new-api-log-token' &&
        isNonNegativeFiniteNumber(item.actualCostDetails.actualAmount)
    ) {
        const amount = formatMoney(item.actualCostDetails.actualAmount);
        if (amount) return { label: `${labels.actual} $${amount}`, actual: true };
    }
    if (item.actualCostDetails?.source === 'pending') {
        return { label: labels.pending, actual: false };
    }
    if (isValidCostDetails(item.costDetails)) {
        const amount = formatMoney(item.costDetails.estimated_cost_usd);
        if (amount) return { label: `${labels.estimated} $${amount}`, actual: false };
    }
    return null;
}

function formatActualCostLabel(item: HistoryMetadata, unavailableLabel: string, pendingLabel: string): string {
    if (item.actualCostDetails?.source === 'pending') {
        return pendingLabel;
    }
    if (
        item.actualCostDetails?.source === 'new-api-log-token' &&
        isNonNegativeFiniteNumber(item.actualCostDetails.actualAmount)
    ) {
        const amount = formatMoney(item.actualCostDetails.actualAmount);
        return amount ? `$${amount}` : unavailableLabel;
    }
    return unavailableLabel;
}

function getHistoryClientRequestIds(item: HistoryMetadata): string[] {
    return Array.from(
        new Set(
            [...(item.clientRequestIds ?? []), ...item.images.map((image) => image.clientRequestId)].filter(
                (value): value is string => typeof value === 'string' && value.length > 0
            )
        )
    );
}

function getCostStatusLabel(
    item: HistoryMetadata,
    labels: { actual: string; pending: string; unavailable: string; estimated: string }
) {
    if (
        item.actualCostDetails?.source === 'new-api-log-token' &&
        isNonNegativeFiniteNumber(item.actualCostDetails.actualAmount)
    ) {
        return labels.actual;
    }
    if (item.actualCostDetails?.source === 'pending') return labels.pending;
    if (item.actualCostDetails?.source === 'unavailable') return labels.unavailable;
    if (isValidCostDetails(item.costDetails)) return labels.estimated;
    return '-';
}

function getActualCostSourceLabel(source: string, t: ReturnType<typeof useI18n>['t']): string {
    if (source === 'new-api-log-token') return t('history.costSourceMatchedLog');
    if (source === 'pending') return t('history.costSourcePending');
    if (source === 'unavailable') return t('history.costSourceUnavailable');
    if (source === 'estimate') return t('history.costSourceEstimate');
    return source;
}

function getActualCostConfidenceLabel(confidence: string, t: ReturnType<typeof useI18n>['t']): string {
    if (confidence === 'exact') return t('history.costConfidenceExact');
    if (confidence === 'high') return t('history.costConfidenceHigh');
    if (confidence === 'low') return t('history.costConfidenceLow');
    if (confidence === 'none') return t('history.costConfidenceNone');
    return confidence;
}

function getActualCostReasonLabel(
    details: NonNullable<HistoryMetadata['actualCostDetails']>,
    t: ReturnType<typeof useI18n>['t']
): string | null {
    if (details.source === 'pending') return t('history.costReasonPending');
    if (details.source === 'unavailable') return t('history.costReasonUnavailable');
    if (details.confidence === 'low' || details.confidence === 'none') return t('history.costReasonLowConfidence');
    return null;
}

function getHistoryStorageMode(item: HistoryMetadata): NonNullable<HistoryMetadata['storageModeUsed']> {
    return item.storageModeUsed ?? 'fs';
}

function getHistoryFailureStatusLabel(item: HistoryMetadata, t: ReturnType<typeof useI18n>['t']): string {
    return item.mode === 'edit' ? t('history.editFailedStatus') : t('history.failedStatus');
}

function isRetentionManagedHistoryItem(item: HistoryMetadata): boolean {
    return item.status !== 'failed' && getHistoryStorageMode(item) === 'fs' && item.images.length > 0;
}

function HistoryPanelImpl({
    history,
    inspirations,
    activityItems = [],
    isSendingToEdit = false,
    onSelectImage,
    onApplyPrompt,
    onSaveInspiration,
    onSendHistoryToEdit,
    onMarkResultFeedback,
    onUpdateResultFeedbackNote,
    onDeleteInspiration,
    onDownloadHistoryItem,
    onClearHistory,
    getImageSrc,
    onDeleteItemRequest,
    itemPendingDeleteConfirmation,
    onConfirmDeletion,
    onCancelDeletion,
    deletePreferenceDialogValue,
    onDeletePreferenceDialogChange,
    cleanupEnabled = false,
    permanentlySavedFilenames = emptyPermanentFilenames,
    onUpdatePermanentSave
}: HistoryPanelProps) {
    const { locale, t } = useI18n();
    const [activeTab, setActiveTab] = React.useState<HistoryPanelTab>(() =>
        history.length > 0 && inspirations.length === 0 ? 'history' : 'inspiration'
    );
    const [openPromptDialogId, setOpenPromptDialogId] = React.useState<string | null>(null);
    const [openCostDialogId, setOpenCostDialogId] = React.useState<string | null>(null);
    const [isTotalCostDialogOpen, setIsTotalCostDialogOpen] = React.useState(false);
    const [copiedHistoryId, setCopiedHistoryId] = React.useState<string | null>(null);
    const [imageResolutions, setImageResolutions] = React.useState<Record<string, string>>({});
    const [failedThumbnails, setFailedThumbnails] = React.useState<Record<string, boolean>>({});
    const [expandedBatchId, setExpandedBatchId] = React.useState<string | null>(null);
    const [isSelectingRetention, setIsSelectingRetention] = React.useState(false);
    const [selectedRetentionFilenames, setSelectedRetentionFilenames] = React.useState<Set<string>>(() => new Set());
    const [isUpdatingRetention, setIsUpdatingRetention] = React.useState(false);
    const [retentionError, setRetentionError] = React.useState<string | null>(null);
    const effectiveActiveTab = resolveHistoryPanelTabSync({
        activeTab,
        historyCount: history.length,
        inspirationCount: inspirations.length
    });
    const hasRetentionManagedHistory = React.useMemo(() => history.some(isRetentionManagedHistoryItem), [history]);
    const canManageRetention = cleanupEnabled && hasRetentionManagedHistory && !!onUpdatePermanentSave;
    const retentionManagedFilenames = React.useMemo(
        () =>
            new Set(
                history
                    .filter(isRetentionManagedHistoryItem)
                    .flatMap((item) => item.images.map((image) => image.filename))
            ),
        [history]
    );
    const activeSelectedRetentionFilenames = React.useMemo(
        () => new Set([...selectedRetentionFilenames].filter((filename) => retentionManagedFilenames.has(filename))),
        [retentionManagedFilenames, selectedRetentionFilenames]
    );
    const isRetentionSelectionActive = isSelectingRetention && canManageRetention && effectiveActiveTab === 'history';

    const { totalCost, totalImages, estimatedImages, averageCost } = React.useMemo(
        () => summarizeHistoryCosts(history),
        [history]
    );

    const clearRetentionSelection = React.useCallback(() => {
        setIsSelectingRetention(false);
        setSelectedRetentionFilenames(new Set());
        setRetentionError(null);
    }, []);

    const handleRetentionSelectionModeChange = React.useCallback(() => {
        if (isRetentionSelectionActive) {
            clearRetentionSelection();
            return;
        }
        setIsSelectingRetention(true);
        setSelectedRetentionFilenames(new Set());
        setRetentionError(null);
    }, [clearRetentionSelection, isRetentionSelectionActive]);

    const handleRetentionImageSelection = React.useCallback(
        (filename: string, isSelected: boolean) => {
            setSelectedRetentionFilenames((current) => {
                const next = new Set(
                    [...current].filter((currentFilename) => retentionManagedFilenames.has(currentFilename))
                );
                if (isSelected) {
                    next.add(filename);
                } else {
                    next.delete(filename);
                }
                return next;
            });
            setRetentionError(null);
        },
        [retentionManagedFilenames]
    );

    const submitRetentionUpdate = React.useCallback(
        async (action: 'preserve' | 'release') => {
            if (!onUpdatePermanentSave || activeSelectedRetentionFilenames.size === 0 || isUpdatingRetention) return;
            const filenames = [...activeSelectedRetentionFilenames];
            setIsUpdatingRetention(true);
            setRetentionError(null);
            try {
                await onUpdatePermanentSave(action, filenames);
                setSelectedRetentionFilenames(new Set());
            } catch (error) {
                console.error('更新图片自动清理保护失败：', error);
                setRetentionError(
                    error instanceof Error && error.message ? error.message : t('retention.updateFailed')
                );
            } finally {
                setIsUpdatingRetention(false);
            }
        },
        [activeSelectedRetentionFilenames, isUpdatingRetention, onUpdatePermanentSave, t]
    );

    const handleCopy = async (text: string | null | undefined, historyId: string) => {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setCopiedHistoryId(historyId);
            setTimeout(() => setCopiedHistoryId(null), 1500);
        } catch (err) {
            console.error('复制文本失败：', err);
        }
    };
    const formatTimestamp = React.useCallback(
        (timestamp: number) => new Date(timestamp).toLocaleString(locale),
        [locale]
    );
    const formatStatusTime = React.useCallback(
        (timestamp: number) =>
            new Date(timestamp).toLocaleTimeString(locale, {
                hour: '2-digit',
                minute: '2-digit'
            }),
        [locale]
    );
    const formatDuration = React.useCallback(
        (durationMs: number) => formatImageDurationLabel(durationMs, locale, t),
        [locale, t]
    );
    const handleThumbnailLoad = React.useCallback((filename: string, event: React.SyntheticEvent<HTMLImageElement>) => {
        const image = event.currentTarget;
        if (!image.naturalWidth || !image.naturalHeight) return;
        const resolution = `${image.naturalWidth}x${image.naturalHeight}`;
        setImageResolutions((current) => {
            if (current[filename] === resolution) return current;
            return { ...current, [filename]: resolution };
        });
    }, []);
    const handleThumbnailError = React.useCallback((filename: string) => {
        setFailedThumbnails((current) => {
            if (current[filename]) return current;
            return { ...current, [filename]: true };
        });
    }, []);
    const formatResolution = React.useCallback(
        (item: HistoryMetadata, firstImage: { filename: string } | undefined) => {
            if (firstImage && imageResolutions[firstImage.filename]) return imageResolutions[firstImage.filename];
            if (item.size && item.size !== 'auto') return item.size;
            return '-';
        },
        [imageResolutions]
    );

    return (
        <Card
            className={cn(
                'workbench-panel text-card-foreground border-border flex h-auto min-h-[17.5rem] w-full flex-col gap-0 overflow-hidden rounded-lg border py-0 xl:h-full xl:min-h-0'
            )}>
            <CardHeader className='workbench-panel-header border-border/70 flex flex-col gap-2 border-b px-4 pt-3 !pb-3'>
                {estimatedImages > 0 ? (
                    <div className='flex items-center justify-end gap-3'>
                        <Dialog open={isTotalCostDialogOpen} onOpenChange={setIsTotalCostDialogOpen}>
                            <DialogTrigger asChild>
                                <button
                                    type='button'
                                    className='bg-secondary text-secondary-foreground hover:bg-secondary/80 ui-stat mt-0.5 flex min-h-9 cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-[12px] transition-[background-color] lg:min-h-7'
                                    aria-label={t('history.showTotalCost')}>
                                    {t('history.totalCost', { cost: totalCost.toFixed(4) })}
                                </button>
                            </DialogTrigger>
                            <DialogContent className='sm:max-w-[450px]'>
                                <DialogHeader>
                                    <DialogTitle>{t('history.totalCostSummary')}</DialogTitle>
                                    <DialogDescription className='sr-only'>
                                        {t('history.costSummaryDescription')}
                                    </DialogDescription>
                                </DialogHeader>
                                <div className='text-muted-foreground space-y-1 pt-1 text-xs'>
                                    {RATED_IMAGE_MODELS.map((model) => {
                                        const rates = getModelRates(model);
                                        if (!rates) return null;
                                        return (
                                            <React.Fragment key={model}>
                                                <p className='mt-2 font-medium first:mt-0'>{model}:</p>
                                                <ul className='list-disc pl-4'>
                                                    <li>
                                                        {t('history.textInput')} ${rates.textInputPerMillion}
                                                        {t('history.tokens1m')}
                                                    </li>
                                                    <li>
                                                        {t('history.imageInput')} ${rates.imageInputPerMillion}
                                                        {t('history.tokens1m')}
                                                    </li>
                                                    <li>
                                                        {t('history.imageOutput')} ${rates.imageOutputPerMillion}
                                                        {t('history.tokens1m')}
                                                    </li>
                                                </ul>
                                            </React.Fragment>
                                        );
                                    })}
                                </div>
                                <div className='text-muted-foreground space-y-2 py-4 text-sm'>
                                    <div className='flex justify-between'>
                                        <span>{t('history.totalImages')}</span>{' '}
                                        <span className='ui-stat'>{totalImages.toLocaleString(locale)}</span>
                                    </div>
                                    <div className='flex justify-between'>
                                        <span>{t('history.estimatedImages')}</span>{' '}
                                        <span className='ui-stat'>{estimatedImages.toLocaleString(locale)}</span>
                                    </div>
                                    <div className='flex justify-between'>
                                        <span>{t('history.averageCost')}</span>{' '}
                                        <span className='ui-stat'>${averageCost.toFixed(4)}</span>
                                    </div>
                                    <hr className='border-border my-2' />
                                    <div className='text-foreground flex justify-between font-medium'>
                                        <span>{t('history.totalEstimatedCost')}</span>
                                        <span className='ui-stat'>${totalCost.toFixed(4)}</span>
                                    </div>
                                </div>
                                <DialogFooter>
                                    <DialogClose asChild>
                                        <Button
                                            type='button'
                                            variant='secondary'
                                            size='sm'
                                            className='hover:border-border hover:bg-accent hover:text-accent-foreground border border-transparent shadow-sm active:scale-[0.98]'>
                                            {t('common.close')}
                                        </Button>
                                    </DialogClose>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
                    </div>
                ) : null}
                <Tabs
                    value={effectiveActiveTab}
                    onValueChange={(value) => {
                        const nextTab = value as HistoryPanelTab;
                        setActiveTab(nextTab);
                        if (nextTab !== 'history') clearRetentionSelection();
                    }}
                    className='gap-0'>
                    <TabsList className='border-border grid h-auto w-full grid-cols-2 rounded-none border-0 border-b bg-transparent p-0'>
                        <TabsTrigger
                            value='inspiration'
                            className='data-[state=active]:border-primary data-[state=active]:text-primary min-h-11 rounded-none border-0 border-b-2 border-transparent bg-transparent px-1 shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none lg:min-h-8'>
                            {t('history.inspirationAlbum')}
                        </TabsTrigger>
                        <TabsTrigger
                            value='history'
                            className='data-[state=active]:border-primary data-[state=active]:text-primary min-h-11 rounded-none border-0 border-b-2 border-transparent bg-transparent px-1 shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none lg:min-h-8'>
                            {t('history.recentGenerated')}
                        </TabsTrigger>
                    </TabsList>
                    <TabsContent value='inspiration' forceMount className='hidden' />
                    <TabsContent value='history' forceMount className='hidden' />
                </Tabs>
                {history.length > 0 && effectiveActiveTab === 'history' ? (
                    <div className='flex items-center justify-between gap-2'>
                        {canManageRetention ? (
                            <Button
                                type='button'
                                variant='ghost'
                                size='sm'
                                onClick={handleRetentionSelectionModeChange}
                                className='text-muted-foreground hover:text-foreground min-h-11 px-2 text-xs lg:min-h-8'
                                aria-label={
                                    isRetentionSelectionActive
                                        ? t('retention.exitSelection')
                                        : t('retention.selectHistory')
                                }
                                title={t('retention.hint')}>
                                {isRetentionSelectionActive ? <X className='h-3.5 w-3.5' /> : null}
                                {isRetentionSelectionActive ? t('retention.exitSelection') : t('retention.select')}
                            </Button>
                        ) : (
                            <span />
                        )}
                        <Button
                            variant='ghost'
                            size='sm'
                            onClick={onClearHistory}
                            className='text-muted-foreground hover:text-foreground min-h-11 rounded-md px-2 py-1 lg:min-h-8'>
                            {t('history.clear')}
                        </Button>
                    </div>
                ) : null}
            </CardHeader>
            <CardContent
                className={cn(
                    'literary-scrollbar min-h-0 p-3 lg:max-h-[17.5rem] lg:overflow-y-auto lg:p-3 xl:flex xl:max-h-none xl:flex-1 xl:flex-col'
                )}>
                {effectiveActiveTab === 'inspiration' ? (
                    <div
                        className={cn(
                            'space-y-3 lg:space-y-2',
                            inspirations.length === 0 && 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:space-y-0'
                        )}>
                        {inspirations.length === 0 ? (
                            <div className='workbench-empty-state text-muted-foreground border-border/70 bg-muted/20 flex min-h-28 flex-col items-center justify-center gap-2 rounded-md border px-4 text-center text-sm xl:my-auto'>
                                <WandSparkles className='h-5 w-5 opacity-70' aria-hidden='true' />
                                <p>{t('history.inspirationEmpty')}</p>
                            </div>
                        ) : (
                            <div className='-mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-1 lg:mx-0 lg:block lg:space-y-2 lg:overflow-visible lg:px-0 lg:pb-0'>
                                {inspirations.map((item) => {
                                    const title = item.prompt.trim() || t('history.inspirationAlbum');
                                    return (
                                        <div
                                            key={item.id}
                                            className='group border-border/70 bg-card/58 hover:border-primary/30 flex w-[min(84vw,360px)] shrink-0 snap-start items-stretch gap-3 rounded-md border p-2 shadow-sm transition-[border-color,box-shadow] hover:shadow-md lg:w-auto lg:gap-2 lg:p-1.5 2xl:p-1'>
                                            <button
                                                type='button'
                                                onClick={() =>
                                                    onApplyPrompt(item.prompt, { type: 'inspiration', title })
                                                }
                                                aria-label={t('history.applyInspirationPrompt', { title })}
                                                className='border-border bg-muted/30 text-muted-foreground flex min-h-24 w-24 shrink-0 items-center justify-center rounded border shadow-sm lg:min-h-20 lg:w-20 2xl:min-h-18 2xl:w-18'>
                                                <Bookmark className='h-5 w-5' />
                                            </button>
                                            <div className='flex min-w-0 flex-1 flex-col gap-1.5 pr-1 2xl:gap-1'>
                                                <div className='flex items-start justify-between gap-1.5'>
                                                    <div className='min-w-0'>
                                                        <p
                                                            className='line-clamp-2 text-[15px] leading-5 font-medium 2xl:text-sm'
                                                            title={title}>
                                                            {title}
                                                        </p>
                                                    </div>
                                                    <div className='flex shrink-0 gap-0.5 opacity-65 transition-opacity group-hover:opacity-100'>
                                                        <span
                                                            className='text-primary flex h-11 w-11 items-center justify-center rounded-md lg:h-7 lg:w-7'
                                                            aria-label={t('history.savedInspiration')}
                                                            role='img'>
                                                            <Bookmark className='h-3.5 w-3.5 fill-current' />
                                                        </span>
                                                        <Button
                                                            type='button'
                                                            variant='ghost'
                                                            size='icon'
                                                            className='text-muted-foreground hover:text-destructive h-11 w-11 lg:h-7 lg:w-7'
                                                            onClick={() => onDeleteInspiration(item.id)}
                                                            aria-label={t('history.deleteInspiration')}>
                                                            <Trash2 className='h-3.5 w-3.5' />
                                                        </Button>
                                                    </div>
                                                </div>
                                                <div className='flex items-center justify-between gap-2'>
                                                    <span className='text-muted-foreground text-[11px]'>
                                                        {item.createdAt > 0
                                                            ? formatTimestamp(item.createdAt)
                                                            : t('history.template')}
                                                    </span>
                                                    <Button
                                                        type='button'
                                                        size='sm'
                                                        variant='ghost'
                                                        className='min-h-11 px-3 text-xs lg:min-h-7 lg:px-2'
                                                        onClick={() =>
                                                            onApplyPrompt(item.prompt, { type: 'inspiration', title })
                                                        }>
                                                        {t('history.applyInspiration')}
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        <div
                            className={cn(
                                'flex items-center justify-between rounded-md px-1 text-sm',
                                inspirations.length === 0 && 'xl:mt-auto'
                            )}>
                            <button
                                type='button'
                                className='text-muted-foreground hover:text-primary focus-visible:ring-ring -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 transition-[color,box-shadow] focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 lg:ml-0 lg:min-h-8 lg:px-0'
                                disabled={!inspirations[0]}
                                onClick={() =>
                                    inspirations[0] &&
                                    onApplyPrompt(inspirations[0].prompt, {
                                        type: 'inspiration',
                                        title: t('history.inspirationAlbum')
                                    })
                                }>
                                <Plus className='h-4 w-4' />
                                {t('history.applyFirstTemplate')}
                            </button>
                            <span className='text-muted-foreground -mr-2 min-h-11 rounded-md px-2 py-3 lg:mr-0 lg:min-h-8 lg:py-1.5'>
                                {t('history.inspirationCount', { count: inspirations.length })}
                            </span>
                        </div>
                    </div>
                ) : history.length === 0 ? (
                    <div
                        className={cn(
                            'workbench-empty-state text-muted-foreground border-border/70 bg-muted/20 flex min-h-28 flex-1 flex-col items-center justify-center gap-2 rounded-md border px-4 text-center text-sm'
                        )}>
                        <FileImage className='h-5 w-5 opacity-70' aria-hidden='true' />
                        <p>{t('history.empty')}</p>
                    </div>
                ) : (
                    <div className='-mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-1 lg:mx-0 lg:grid lg:grid-cols-1 lg:overflow-visible lg:px-0 lg:pb-0'>
                        {[...history].map((item) => {
                            const firstImage = item.images?.[0];
                            const imageCount = item.images?.length ?? 0;
                            const isFailedItem = item.status === 'failed';
                            const failureMessage = item.failureMessage?.trim();
                            const isMultiImage = imageCount > 1;
                            const itemKey = getHistoryEntryId(item);
                            const hasPrompt = item.prompt.trim().length > 0;
                            const resultFeedback = item.resultFeedback;
                            const resultFeedbackNote = resultFeedback?.note ?? '';
                            const resultFeedbackLabel = resultFeedback
                                ? resultFeedback.value === 'usable'
                                    ? t('history.resultFeedbackUsable')
                                    : t('history.resultFeedbackNeedsRevision')
                                : t('history.resultFeedbackEmpty');
                            const originalStorageMode = getHistoryStorageMode(item);
                            const isRetentionManagedItem = cleanupEnabled && isRetentionManagedHistoryItem(item);
                            const firstImageIsPermanentlySaved =
                                !!firstImage && permanentlySavedFilenames.has(firstImage.filename);
                            const isFirstImageSelected =
                                !!firstImage && activeSelectedRetentionFilenames.has(firstImage.filename);
                            const outputFormat = item.output_format || 'png';
                            const costBadge = getCostBadge(item, {
                                actual: t('history.actualCostShort'),
                                estimated: t('history.estimatedCostShort'),
                                pending: t('history.actualCostPending')
                            });
                            const requestIds = getHistoryClientRequestIds(item);
                            const filenames = item.images.map((image) => image.filename);
                            const isBatchExpanded = expandedBatchId === itemKey;
                            const costStatus = getCostStatusLabel(item, {
                                actual: t('history.actualCostShort'),
                                pending: t('history.actualCostPending'),
                                unavailable: t('history.actualCostUnavailable'),
                                estimated: t('history.estimatedCostShort')
                            });
                            const actualCostReason = item.actualCostDetails
                                ? getActualCostReasonLabel(item.actualCostDetails, t)
                                : null;
                            const failureStatusLabel = getHistoryFailureStatusLabel(item, t);

                            let thumbnailUrl: string | undefined;
                            if (firstImage) {
                                if (originalStorageMode === 'indexeddb') {
                                    thumbnailUrl = getImageSrc(firstImage.filename);
                                } else {
                                    thumbnailUrl = `/api/image/${firstImage.filename}`;
                                }
                            }
                            const isThumbnailUnavailable =
                                !thumbnailUrl || (firstImage ? failedThumbnails[firstImage.filename] : false);

                            return (
                                <div
                                    key={itemKey}
                                    className='flex w-[min(76vw,280px)] shrink-0 snap-start flex-col lg:w-auto'>
                                    <div className='group relative'>
                                        <button
                                            type='button'
                                            onClick={() => {
                                                if (!isRetentionSelectionActive || !isRetentionManagedItem) {
                                                    onSelectImage(item);
                                                }
                                            }}
                                            disabled={
                                                isFailedItem || (isRetentionSelectionActive && isRetentionManagedItem)
                                            }
                                            className={cn(
                                                'focus:ring-ring focus:ring-offset-background border-border relative block aspect-square w-full overflow-hidden rounded-t-md border transition-[border-color,filter,transform,box-shadow] duration-150 focus:ring-2 focus:ring-offset-2 focus:outline-none active:translate-y-0',
                                                isFailedItem || (isRetentionSelectionActive && isRetentionManagedItem)
                                                    ? 'cursor-default'
                                                    : 'hover:border-foreground/20 cursor-pointer hover:-translate-y-0.5 hover:brightness-110'
                                            )}
                                            aria-label={
                                                isFailedItem
                                                    ? t('history.viewFailed', { time: formatTimestamp(item.timestamp) })
                                                    : t('history.viewBatch', { time: formatTimestamp(item.timestamp) })
                                            }>
                                            {isFailedItem ? (
                                                <div className='bg-destructive/5 text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-xs'>
                                                    <AlertTriangle
                                                        size={20}
                                                        className='text-destructive'
                                                        aria-hidden='true'
                                                    />
                                                    <span className='text-foreground font-medium'>
                                                        {failureStatusLabel}
                                                    </span>
                                                    <span className='line-clamp-2'>
                                                        {failureMessage || t('history.failedReasonUnavailable')}
                                                    </span>
                                                </div>
                                            ) : !isThumbnailUnavailable && thumbnailUrl && firstImage ? (
                                                <Image
                                                    src={thumbnailUrl}
                                                    alt={t('history.previewBatch', {
                                                        time: formatTimestamp(item.timestamp)
                                                    })}
                                                    width={150}
                                                    height={150}
                                                    className='image-edge h-full w-full object-cover'
                                                    onLoad={(event) => handleThumbnailLoad(firstImage.filename, event)}
                                                    onError={() => handleThumbnailError(firstImage.filename)}
                                                    unoptimized
                                                />
                                            ) : (
                                                <div className='bg-muted text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-1 px-3 text-center text-xs'>
                                                    <FileImage size={18} className='text-muted-foreground' />
                                                    <span>{t('history.previewUnavailable')}</span>
                                                </div>
                                            )}
                                            <div
                                                className={cn(
                                                    'ui-stat pointer-events-none absolute top-1 left-1 z-10 flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px]',
                                                    isFailedItem
                                                        ? 'border-destructive/35 bg-destructive/90 text-destructive-foreground'
                                                        : item.mode === 'edit'
                                                          ? 'border-primary/30 bg-primary/88 text-primary-foreground'
                                                          : 'border-secondary/40 bg-secondary/90 text-secondary-foreground'
                                                )}>
                                                {isFailedItem ? (
                                                    <AlertTriangle size={12} />
                                                ) : item.mode === 'edit' ? (
                                                    <Pencil size={12} />
                                                ) : (
                                                    <SparklesIcon size={12} />
                                                )}
                                                {isFailedItem
                                                    ? failureStatusLabel
                                                    : item.mode === 'edit'
                                                      ? t('history.modeEdit')
                                                      : t('history.modeCreate')}
                                            </div>
                                            {isMultiImage && (
                                                <div className='ui-stat pointer-events-none absolute right-1 bottom-1 z-10 flex items-center gap-1 rounded-sm bg-slate-900/80 px-1.5 py-0.5 text-[12px] text-white'>
                                                    <Layers size={16} />
                                                    {imageCount}
                                                </div>
                                            )}
                                            <div className='pointer-events-none absolute bottom-1 left-1 z-10 flex items-center gap-1'>
                                                <div className='bg-background/85 text-muted-foreground border-border flex items-center gap-1 rounded-sm border px-1 py-0.5 text-[11px]'>
                                                    {originalStorageMode === 'fs' ? (
                                                        <HardDrive size={12} className='text-muted-foreground' />
                                                    ) : (
                                                        <Database size={12} className='text-primary' />
                                                    )}
                                                    <span>{getStorageLabel(originalStorageMode, t)}</span>
                                                </div>
                                                {item.output_format && (
                                                    <div className='bg-background/85 text-muted-foreground border-border flex items-center gap-1 rounded-sm border px-1 py-0.5 text-[11px]'>
                                                        <FileImage size={12} className='text-muted-foreground' />
                                                        <span>{getImageOutputFormatLabel(outputFormat, t)}</span>
                                                    </div>
                                                )}
                                            </div>
                                        </button>
                                        {isRetentionManagedItem && firstImageIsPermanentlySaved ? (
                                            <span
                                                className='bg-background/92 text-primary border-primary/25 pointer-events-none absolute top-1 right-1 z-20 flex h-7 w-7 items-center justify-center rounded-sm border shadow-sm'
                                                aria-label={t('retention.permanentlySaved')}
                                                role='img'>
                                                <Bookmark className='h-3.5 w-3.5 fill-current' aria-hidden='true' />
                                            </span>
                                        ) : null}
                                        {isRetentionManagedItem &&
                                        isRetentionSelectionActive &&
                                        firstImage &&
                                        !isMultiImage ? (
                                            <div className='bg-background/92 border-border absolute top-1 right-1 z-30 flex h-9 w-9 items-center justify-center rounded-sm border shadow-sm'>
                                                <Checkbox
                                                    checked={isFirstImageSelected}
                                                    onCheckedChange={(checked) =>
                                                        handleRetentionImageSelection(
                                                            firstImage.filename,
                                                            checked === true
                                                        )
                                                    }
                                                    disabled={isUpdatingRetention}
                                                    data-retention-image={firstImage.filename}
                                                    aria-label={t('retention.selectImage')}
                                                />
                                            </div>
                                        ) : null}
                                        {costBadge && (
                                            <Dialog
                                                open={openCostDialogId === itemKey}
                                                onOpenChange={(isOpen) => !isOpen && setOpenCostDialogId(null)}>
                                                <DialogTrigger asChild>
                                                    <button
                                                        type='button'
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setOpenCostDialogId(itemKey);
                                                        }}
                                                        className={cn(
                                                            'ui-stat absolute top-7 right-1 z-20 flex min-h-9 cursor-pointer items-center gap-0.5 rounded-sm px-2 py-1 text-[11px] text-white shadow-sm transition-[background-color,transform] hover:-translate-y-0.5 active:translate-y-0 lg:min-h-7',
                                                            costBadge.actual
                                                                ? 'bg-secondary text-secondary-foreground hover:bg-secondary/85'
                                                                : 'bg-foreground/80 text-background hover:bg-foreground/70'
                                                        )}
                                                        aria-label={`${t('history.showCost')} ${costBadge.label}`}>
                                                        <DollarSign size={12} />
                                                        {costBadge.label}
                                                    </button>
                                                </DialogTrigger>
                                                <DialogContent className='sm:max-w-[450px]'>
                                                    <DialogHeader>
                                                        <DialogTitle>{t('history.costBreakdown')}</DialogTitle>
                                                        <DialogDescription className='sr-only'>
                                                            {t('history.costBreakdownDescription')}
                                                        </DialogDescription>
                                                    </DialogHeader>
                                                    {(() => {
                                                        const modelForRates = item.model;
                                                        const rates = isGptImageModel(modelForRates)
                                                            ? getModelRates(modelForRates)
                                                            : undefined;
                                                        return (
                                                            <>
                                                                <div className='text-muted-foreground space-y-1 pt-1 text-xs'>
                                                                    {modelForRates && rates ? (
                                                                        <>
                                                                            <p>
                                                                                {t('history.pricingFor', {
                                                                                    model: modelForRates
                                                                                })}
                                                                            </p>
                                                                            <ul className='list-disc pl-4'>
                                                                                <li>
                                                                                    {t('history.textInput')} $
                                                                                    {rates.textInputPerMillion}
                                                                                    {t('history.tokens1m')}
                                                                                </li>
                                                                                <li>
                                                                                    {t('history.imageInput')} $
                                                                                    {rates.imageInputPerMillion}
                                                                                    {t('history.tokens1m')}
                                                                                </li>
                                                                                <li>
                                                                                    {t('history.imageOutput')} $
                                                                                    {rates.imageOutputPerMillion}
                                                                                    {t('history.tokens1m')}
                                                                                </li>
                                                                            </ul>
                                                                        </>
                                                                    ) : (
                                                                        <p>{t('history.pricingUnavailable')}</p>
                                                                    )}
                                                                </div>
                                                                <div className='text-muted-foreground space-y-2 py-4 text-sm'>
                                                                    {item.actualCostDetails && (
                                                                        <div className='border-border bg-card/70 space-y-2 rounded-md border p-3'>
                                                                            <div className='flex justify-between gap-3'>
                                                                                <span>{t('history.actualCost')}</span>
                                                                                <span className='text-foreground ui-stat font-medium'>
                                                                                    {formatActualCostLabel(
                                                                                        item,
                                                                                        t(
                                                                                            'history.actualCostUnavailable'
                                                                                        ),
                                                                                        t('history.actualCostPending')
                                                                                    )}
                                                                                </span>
                                                                            </div>
                                                                            <div className='flex justify-between gap-3'>
                                                                                <span>{t('history.costSource')}</span>
                                                                                <span className='text-right'>
                                                                                    {getActualCostSourceLabel(
                                                                                        item.actualCostDetails.source,
                                                                                        t
                                                                                    )}
                                                                                </span>
                                                                            </div>
                                                                            <div className='flex justify-between gap-3'>
                                                                                <span>
                                                                                    {t('history.costConfidence')}
                                                                                </span>
                                                                                <span>
                                                                                    {getActualCostConfidenceLabel(
                                                                                        item.actualCostDetails
                                                                                            .confidence,
                                                                                        t
                                                                                    )}
                                                                                </span>
                                                                            </div>
                                                                            {typeof item.actualCostDetails
                                                                                .actualQuota === 'number' && (
                                                                                <div className='flex justify-between gap-3'>
                                                                                    <span>
                                                                                        {t('history.actualQuota')}
                                                                                    </span>
                                                                                    <span className='ui-stat'>
                                                                                        {item.actualCostDetails.actualQuota.toLocaleString(
                                                                                            locale
                                                                                        )}
                                                                                    </span>
                                                                                </div>
                                                                            )}
                                                                            {typeof item.actualCostDetails
                                                                                .matchedLogId === 'number' && (
                                                                                <div className='flex justify-between gap-3'>
                                                                                    <span>
                                                                                        {t('history.matchedLogId')}
                                                                                    </span>
                                                                                    <span className='ui-stat'>
                                                                                        {
                                                                                            item.actualCostDetails
                                                                                                .matchedLogId
                                                                                        }
                                                                                    </span>
                                                                                </div>
                                                                            )}
                                                                            {actualCostReason && (
                                                                                <p className='text-xs'>
                                                                                    {actualCostReason}
                                                                                </p>
                                                                            )}
                                                                        </div>
                                                                    )}
                                                                    {isValidCostDetails(item.costDetails) && (
                                                                        <>
                                                                            <div className='flex justify-between'>
                                                                                <span>
                                                                                    {t('history.textInputTokens')}
                                                                                </span>{' '}
                                                                                <span className='ui-stat'>
                                                                                    {item.costDetails.text_input_tokens.toLocaleString(
                                                                                        locale
                                                                                    )}{' '}
                                                                                    (
                                                                                    {formatEstimatedTokenCost(
                                                                                        item.costDetails
                                                                                            .text_input_tokens,
                                                                                        rates?.textInputPerToken,
                                                                                        t('common.unavailable')
                                                                                    )}
                                                                                    )
                                                                                </span>
                                                                            </div>
                                                                            {item.costDetails.image_input_tokens >
                                                                                0 && (
                                                                                <div className='flex justify-between'>
                                                                                    <span>
                                                                                        {t('history.imageInputTokens')}
                                                                                    </span>{' '}
                                                                                    <span className='ui-stat'>
                                                                                        {item.costDetails.image_input_tokens.toLocaleString(
                                                                                            locale
                                                                                        )}{' '}
                                                                                        (
                                                                                        {formatEstimatedTokenCost(
                                                                                            item.costDetails
                                                                                                .image_input_tokens,
                                                                                            rates?.imageInputPerToken,
                                                                                            t('common.unavailable')
                                                                                        )}
                                                                                        )
                                                                                    </span>
                                                                                </div>
                                                                            )}
                                                                            <div className='flex justify-between'>
                                                                                <span>
                                                                                    {t('history.imageOutputTokens')}
                                                                                </span>{' '}
                                                                                <span className='ui-stat'>
                                                                                    {item.costDetails.image_output_tokens.toLocaleString(
                                                                                        locale
                                                                                    )}{' '}
                                                                                    (
                                                                                    {formatEstimatedTokenCost(
                                                                                        item.costDetails
                                                                                            .image_output_tokens,
                                                                                        rates?.imageOutputPerToken,
                                                                                        t('common.unavailable')
                                                                                    )}
                                                                                    )
                                                                                </span>
                                                                            </div>
                                                                            <hr className='border-border my-2' />
                                                                            <div className='text-foreground flex justify-between font-medium'>
                                                                                <span>
                                                                                    {t('history.totalEstimatedCost')}
                                                                                </span>
                                                                                <span className='ui-stat'>
                                                                                    $
                                                                                    {item.costDetails.estimated_cost_usd.toFixed(
                                                                                        4
                                                                                    )}
                                                                                </span>
                                                                            </div>
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </>
                                                        );
                                                    })()}
                                                    <DialogFooter>
                                                        <DialogClose asChild>
                                                            <Button
                                                                type='button'
                                                                variant='secondary'
                                                                size='sm'
                                                                className='hover:border-border hover:bg-accent hover:text-accent-foreground border border-transparent shadow-sm active:scale-[0.98]'>
                                                                {t('common.close')}
                                                            </Button>
                                                        </DialogClose>
                                                    </DialogFooter>
                                                </DialogContent>
                                            </Dialog>
                                        )}
                                    </div>

                                    <div className='text-muted-foreground bg-card/70 border-border space-y-1 rounded-b-md border border-t-0 p-2 text-xs'>
                                        <p title={t('history.generatedOn', { time: formatTimestamp(item.timestamp) })}>
                                            <span className='text-foreground font-medium'>
                                                {t('history.generatedAt')}
                                            </span>{' '}
                                            {formatStatusTime(item.timestamp)}
                                            <span className='text-muted-foreground/70 px-1'>/</span>
                                            {isFailedItem
                                                ? t('history.statusFailedSummary', {
                                                      status: failureStatusLabel,
                                                      duration: formatDuration(item.durationMs)
                                                  })
                                                : t('history.statusBatchSummary', {
                                                      count: imageCount,
                                                      duration: formatDuration(item.durationMs)
                                                  })}
                                        </p>
                                        {isFailedItem && (
                                            <p className='border-destructive/25 bg-destructive/5 text-destructive rounded-sm border px-2 py-1 leading-4'>
                                                <span className='font-medium'>{t('history.failureReason')}</span>{' '}
                                                {failureMessage || t('history.failedReasonUnavailable')}
                                            </p>
                                        )}
                                        <p>
                                            <span className='text-foreground font-medium'>{t('history.model')}</span>{' '}
                                            {getHistoryModelLabel(item, t)}
                                        </p>
                                        <p>
                                            <span className='text-foreground font-medium'>
                                                {t('history.resolution')}
                                            </span>{' '}
                                            {formatResolution(item, firstImage)}
                                        </p>
                                        <p>
                                            <span className='text-foreground font-medium'>{t('history.quality')}</span>{' '}
                                            {getImageQualityLabel(item.quality, t)}
                                        </p>
                                        <p>
                                            <span className='text-foreground font-medium'>{t('history.bg')}</span>{' '}
                                            {getImageBackgroundLabel(item.background, t)}
                                        </p>
                                        <p>
                                            <span className='text-foreground font-medium'>{t('history.mod')}</span>{' '}
                                            {getImageModerationLabel(item.moderation, t)}
                                        </p>
                                        <p
                                            className='mt-2 max-h-10 min-h-8 overflow-hidden leading-5 break-words'
                                            title={item.prompt || t('history.noPrompt')}>
                                            {item.prompt || t('history.noPrompt')}
                                        </p>
                                        {!isFailedItem && (
                                            <div className='mt-2 space-y-1'>
                                                <div className='flex items-center justify-between gap-2'>
                                                    <span className='text-muted-foreground text-[11px]'>
                                                        {t('history.resultFeedback')}
                                                    </span>
                                                    <span className='text-muted-foreground text-[11px]'>
                                                        {resultFeedback
                                                            ? `${resultFeedbackLabel} ${formatStatusTime(resultFeedback.updatedAt)}`
                                                            : resultFeedbackLabel}
                                                    </span>
                                                </div>
                                                <div className='grid grid-cols-2 gap-1'>
                                                    <Button
                                                        type='button'
                                                        variant={
                                                            resultFeedback?.value === 'usable' ? 'secondary' : 'outline'
                                                        }
                                                        size='sm'
                                                        className='min-h-11 min-w-0 px-2 text-[11px] lg:h-7 lg:min-h-0 lg:px-2'
                                                        onClick={() => onMarkResultFeedback(item, 'usable')}
                                                        aria-pressed={resultFeedback?.value === 'usable'}
                                                        aria-label={t('history.markResultUsable')}>
                                                        <ThumbsUp className='h-3.5 w-3.5' />
                                                        <span className='truncate'>
                                                            {t('history.resultFeedbackUsable')}
                                                        </span>
                                                    </Button>
                                                    <Button
                                                        type='button'
                                                        variant={
                                                            resultFeedback?.value === 'needs_revision'
                                                                ? 'secondary'
                                                                : 'outline'
                                                        }
                                                        size='sm'
                                                        className='min-h-11 min-w-0 px-2 text-[11px] lg:h-7 lg:min-h-0 lg:px-2'
                                                        onClick={() => onMarkResultFeedback(item, 'needs_revision')}
                                                        aria-pressed={resultFeedback?.value === 'needs_revision'}
                                                        aria-label={t('history.markResultNeedsRevision')}>
                                                        <ThumbsDown className='h-3.5 w-3.5' />
                                                        <span className='truncate'>
                                                            {t('history.resultFeedbackNeedsRevision')}
                                                        </span>
                                                    </Button>
                                                </div>
                                                <label className='sr-only' htmlFor={`result-feedback-note-${itemKey}`}>
                                                    {t('history.resultFeedbackNote')}
                                                </label>
                                                <Textarea
                                                    id={`result-feedback-note-${itemKey}`}
                                                    value={resultFeedbackNote}
                                                    placeholder={
                                                        resultFeedback
                                                            ? t('history.resultFeedbackNotePlaceholder')
                                                            : t('history.resultFeedbackNoteDisabled')
                                                    }
                                                    disabled={!resultFeedback}
                                                    rows={2}
                                                    maxLength={RESULT_FEEDBACK_NOTE_MAX_LENGTH}
                                                    className='min-h-12 resize-none px-2 py-1.5 text-[11px] leading-4 shadow-none md:text-xs'
                                                    onChange={(event) =>
                                                        resultFeedback &&
                                                        onUpdateResultFeedbackNote(item, event.currentTarget.value)
                                                    }
                                                />
                                            </div>
                                        )}
                                        <div className='mt-2 grid grid-cols-3 gap-1'>
                                            <Button
                                                type='button'
                                                variant='outline'
                                                size='sm'
                                                className='min-h-11 min-w-0 px-2 text-[11px] lg:h-7 lg:min-h-0 lg:px-1'
                                                disabled={!hasPrompt}
                                                onClick={() => onSaveInspiration(item.prompt)}
                                                aria-label={t('history.saveHistoryPrompt')}>
                                                <Bookmark className='h-3.5 w-3.5' />
                                                <span className='truncate'>{t('history.saveToInspiration')}</span>
                                            </Button>
                                            <Button
                                                type='button'
                                                variant='outline'
                                                size='sm'
                                                className='min-h-11 min-w-0 px-2 text-[11px] lg:h-7 lg:min-h-0 lg:px-1'
                                                disabled={!hasPrompt}
                                                onClick={() => onApplyPrompt(item.prompt, { type: 'history', item })}
                                                aria-label={t('history.reuseHistoryPrompt')}>
                                                <WandSparkles className='h-3.5 w-3.5' />
                                                <span className='truncate'>{t('history.reuseHistory')}</span>
                                            </Button>
                                            <Button
                                                type='button'
                                                variant='outline'
                                                size='sm'
                                                className='min-h-11 min-w-0 px-2 text-[11px] lg:h-7 lg:min-h-0 lg:px-1'
                                                disabled={!firstImage || isFailedItem || isSendingToEdit}
                                                onClick={() => onSendHistoryToEdit(item)}
                                                aria-label={t('history.continueHistoryEdit')}>
                                                <Pencil className='h-3.5 w-3.5' />
                                                <span className='truncate'>{t('history.continueEdit')}</span>
                                            </Button>
                                        </div>
                                        <Button
                                            type='button'
                                            variant='outline'
                                            size='sm'
                                            className='mt-1 min-h-11 w-full min-w-0 px-2 text-[11px] lg:h-7 lg:min-h-0 lg:px-1'
                                            disabled={isFailedItem || imageCount === 0}
                                            onClick={() => onDownloadHistoryItem(item)}
                                            aria-label={t('history.downloadBatch')}>
                                            <FileImage className='h-3.5 w-3.5' />
                                            <span className='truncate'>{t('history.downloadBatch')}</span>
                                        </Button>
                                        {isMultiImage && (
                                            <div className='mt-2 space-y-1.5'>
                                                {!isRetentionSelectionActive ? (
                                                    <Button
                                                        type='button'
                                                        variant='ghost'
                                                        size='sm'
                                                        className='text-muted-foreground hover:text-foreground min-h-11 w-full justify-between px-2 text-[11px] lg:h-7 lg:min-h-0'
                                                        aria-expanded={isBatchExpanded}
                                                        aria-controls={`history-batch-${itemKey}`}
                                                        onClick={() =>
                                                            setExpandedBatchId((current) =>
                                                                current === itemKey ? null : itemKey
                                                            )
                                                        }>
                                                        <span>
                                                            {isBatchExpanded
                                                                ? t('history.collapseBatch')
                                                                : t('history.expandBatch')}
                                                        </span>
                                                        <span className='inline-flex items-center gap-1'>
                                                            {t('history.batchImageCount', { count: imageCount })}
                                                            <ChevronDown
                                                                className={cn(
                                                                    'h-3.5 w-3.5 transition-transform',
                                                                    isBatchExpanded && 'rotate-180'
                                                                )}
                                                            />
                                                        </span>
                                                    </Button>
                                                ) : null}
                                                {(isBatchExpanded || isRetentionSelectionActive) && (
                                                    <div
                                                        id={`history-batch-${itemKey}`}
                                                        className='batch-thumbnail-strip grid grid-cols-3 gap-1.5'
                                                        aria-label={t('history.batchThumbnails')}>
                                                        {item.images.map((image, index) => {
                                                            const imageSrc =
                                                                originalStorageMode === 'indexeddb'
                                                                    ? getImageSrc(image.filename)
                                                                    : `/api/image/${image.filename}`;
                                                            const unavailable =
                                                                !imageSrc || failedThumbnails[image.filename];

                                                            const isPermanentlySaved = permanentlySavedFilenames.has(
                                                                image.filename
                                                            );
                                                            const isSelectedForRetention =
                                                                activeSelectedRetentionFilenames.has(image.filename);

                                                            return (
                                                                <div
                                                                    key={`${itemKey}-${image.filename}`}
                                                                    className='border-border bg-muted image-edge relative aspect-square overflow-hidden rounded-sm border'>
                                                                    {!isRetentionSelectionActive ? (
                                                                        <button
                                                                            type='button'
                                                                            onClick={() => onSelectImage(item)}
                                                                            className='focus-visible:ring-ring absolute inset-0 z-10 rounded-sm focus-visible:ring-2 focus-visible:outline-none'
                                                                            aria-label={t('history.batchThumbnail', {
                                                                                index: index + 1
                                                                            })}
                                                                        />
                                                                    ) : null}
                                                                    {!unavailable ? (
                                                                        <Image
                                                                            src={imageSrc}
                                                                            alt={t('history.batchThumbnail', {
                                                                                index: index + 1
                                                                            })}
                                                                            width={88}
                                                                            height={88}
                                                                            sizes='88px'
                                                                            className='h-full w-full object-cover'
                                                                            onLoad={(event) =>
                                                                                handleThumbnailLoad(
                                                                                    image.filename,
                                                                                    event
                                                                                )
                                                                            }
                                                                            onError={() =>
                                                                                handleThumbnailError(image.filename)
                                                                            }
                                                                            unoptimized
                                                                        />
                                                                    ) : (
                                                                        <span className='text-muted-foreground flex h-full items-center justify-center px-1 text-center text-[10px] leading-3'>
                                                                            {t('history.previewUnavailable')}
                                                                        </span>
                                                                    )}
                                                                    {isRetentionManagedItem && isPermanentlySaved ? (
                                                                        <span
                                                                            className='bg-background/92 text-primary border-primary/25 pointer-events-none absolute top-1 right-1 z-20 flex h-6 w-6 items-center justify-center rounded-sm border shadow-sm'
                                                                            aria-label={t('retention.permanentlySaved')}
                                                                            role='img'>
                                                                            <Bookmark
                                                                                className='h-3 w-3 fill-current'
                                                                                aria-hidden='true'
                                                                            />
                                                                        </span>
                                                                    ) : null}
                                                                    {isRetentionManagedItem &&
                                                                    isRetentionSelectionActive ? (
                                                                        <div className='bg-background/92 border-border absolute top-1 right-1 z-30 flex h-7 w-7 items-center justify-center rounded-sm border shadow-sm'>
                                                                            <Checkbox
                                                                                checked={isSelectedForRetention}
                                                                                onCheckedChange={(checked) =>
                                                                                    handleRetentionImageSelection(
                                                                                        image.filename,
                                                                                        checked === true
                                                                                    )
                                                                                }
                                                                                disabled={isUpdatingRetention}
                                                                                data-retention-image={image.filename}
                                                                                aria-label={t('retention.selectImage')}
                                                                            />
                                                                        </div>
                                                                    ) : null}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        <div className='mt-1 flex items-center gap-1'>
                                            <Dialog
                                                open={openPromptDialogId === itemKey}
                                                onOpenChange={(isOpen) => !isOpen && setOpenPromptDialogId(null)}>
                                                <DialogTrigger asChild>
                                                    <Button
                                                        variant='outline'
                                                        size='sm'
                                                        className='min-h-11 flex-grow px-2 py-1 text-xs lg:min-h-7'
                                                        onClick={() => setOpenPromptDialogId(itemKey)}>
                                                        {t('history.showDetails')}
                                                    </Button>
                                                </DialogTrigger>
                                                <DialogContent className='sm:max-w-[625px]'>
                                                    <DialogHeader>
                                                        <DialogTitle>{t('history.details')}</DialogTitle>
                                                        <DialogDescription className='sr-only'>
                                                            {t('history.detailsDescription')}
                                                        </DialogDescription>
                                                    </DialogHeader>
                                                    <div className='space-y-3'>
                                                        <dl className='border-border bg-card/70 grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border p-3 text-sm sm:grid-cols-3'>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.generatedAt')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {formatTimestamp(item.timestamp)}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.time')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {formatDuration(item.durationMs)}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.mode')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {item.mode === 'edit'
                                                                        ? t('history.modeEdit')
                                                                        : t('history.modeCreate')}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.model')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {getHistoryModelLabel(item, t)}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.resolution')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {formatResolution(item, firstImage)}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.quality')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {getImageQualityLabel(item.quality, t)}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.bg')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {getImageBackgroundLabel(item.background, t)}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.mod')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {getImageModerationLabel(item.moderation, t)}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.imageCount')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {imageCount.toLocaleString(locale)}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.outputFormat')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {getImageOutputFormatLabel(outputFormat, t)}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.storage')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {getStorageLabel(originalStorageMode, t)}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.costStatus')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {costStatus}
                                                                </dd>
                                                            </div>
                                                            {isFailedItem && (
                                                                <div>
                                                                    <dt className='text-muted-foreground'>
                                                                        {t('history.status')}
                                                                    </dt>
                                                                    <dd className='text-destructive font-medium'>
                                                                        {failureStatusLabel}
                                                                    </dd>
                                                                </div>
                                                            )}
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.actualCost')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {formatActualCostLabel(
                                                                        item,
                                                                        t('history.actualCostUnavailable'),
                                                                        t('history.actualCostPending')
                                                                    )}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.totalEstimatedCost')}
                                                                </dt>
                                                                <dd className='text-foreground font-medium'>
                                                                    {isValidCostDetails(item.costDetails)
                                                                        ? `$${item.costDetails.estimated_cost_usd.toFixed(4)}`
                                                                        : '-'}
                                                                </dd>
                                                            </div>
                                                        </dl>
                                                        {isFailedItem && (
                                                            <div>
                                                                <p className='mb-1 text-sm font-medium'>
                                                                    {t('history.failureReason')}
                                                                </p>
                                                                <div className='border-destructive/25 bg-destructive/5 text-destructive max-h-[180px] overflow-y-auto rounded-md border p-3 text-sm break-words whitespace-pre-wrap'>
                                                                    {failureMessage ||
                                                                        t('history.failedReasonUnavailable')}
                                                                </div>
                                                            </div>
                                                        )}
                                                        <dl className='border-border bg-card/70 space-y-2 rounded-md border p-3 text-sm'>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.filename')}
                                                                </dt>
                                                                <dd className='text-foreground mt-1 font-mono text-xs break-all'>
                                                                    {filenames.length > 0 ? filenames.join(', ') : '-'}
                                                                </dd>
                                                            </div>
                                                            <div>
                                                                <dt className='text-muted-foreground'>
                                                                    {t('history.requestId')}
                                                                </dt>
                                                                <dd className='text-foreground mt-1 font-mono text-xs break-all'>
                                                                    {requestIds.length > 0
                                                                        ? requestIds.join(', ')
                                                                        : '-'}
                                                                </dd>
                                                            </div>
                                                        </dl>
                                                        {!isFailedItem && (
                                                            <div>
                                                                <p className='mb-1 text-sm font-medium'>
                                                                    {t('history.resultFeedback')}
                                                                </p>
                                                                <div className='border-border bg-card/70 space-y-2 rounded-md border p-3 text-sm'>
                                                                    <div className='flex items-center justify-between gap-3'>
                                                                        <span className='text-muted-foreground'>
                                                                            {resultFeedback
                                                                                ? formatTimestamp(
                                                                                      resultFeedback.updatedAt
                                                                                  )
                                                                                : t('history.resultFeedbackEmpty')}
                                                                        </span>
                                                                        <span className='text-foreground font-medium'>
                                                                            {resultFeedbackLabel}
                                                                        </span>
                                                                    </div>
                                                                    <div className='text-muted-foreground max-h-[120px] overflow-y-auto break-words whitespace-pre-wrap'>
                                                                        {resultFeedbackNote ||
                                                                            t('history.resultFeedbackNoteEmpty')}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                        <div>
                                                            <p className='mb-1 text-sm font-medium'>
                                                                {t('history.prompt')}
                                                            </p>
                                                            <div className='text-foreground bg-muted border-border max-h-[320px] overflow-y-auto rounded-md border p-3 py-4 text-sm break-words whitespace-pre-wrap'>
                                                                {item.prompt || t('history.noPrompt')}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <DialogFooter>
                                                        <Button
                                                            variant='outline'
                                                            size='sm'
                                                            onClick={() => handleCopy(item.prompt, itemKey)}>
                                                            {copiedHistoryId === itemKey ? (
                                                                <Check className='mr-2 h-4 w-4 text-emerald-600 dark:text-emerald-400' />
                                                            ) : (
                                                                <Copy className='mr-2 h-4 w-4' />
                                                            )}
                                                            {copiedHistoryId === itemKey
                                                                ? t('common.copied')
                                                                : t('common.copy')}
                                                        </Button>
                                                        <DialogClose asChild>
                                                            <Button
                                                                type='button'
                                                                variant='secondary'
                                                                size='sm'
                                                                className='hover:border-border hover:bg-accent hover:text-accent-foreground border border-transparent shadow-sm active:scale-[0.98]'>
                                                                {t('common.close')}
                                                            </Button>
                                                        </DialogClose>
                                                    </DialogFooter>
                                                </DialogContent>
                                            </Dialog>
                                            <Dialog
                                                open={Boolean(
                                                    itemPendingDeleteConfirmation &&
                                                    isSameHistoryEntry(itemPendingDeleteConfirmation, item)
                                                )}
                                                onOpenChange={(isOpen) => {
                                                    if (!isOpen) onCancelDeletion();
                                                }}>
                                                <DialogTrigger asChild>
                                                    <Button
                                                        className='bg-destructive hover:bg-destructive/90 min-h-11 min-w-11 text-white lg:min-h-7 lg:min-w-7'
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onDeleteItemRequest(item);
                                                        }}
                                                        aria-label={t('history.deleteItem')}>
                                                        <Trash2 size={14} />
                                                    </Button>
                                                </DialogTrigger>
                                                <DialogContent className='sm:max-w-md'>
                                                    <DialogHeader>
                                                        <DialogTitle>{t('history.confirmDeletion')}</DialogTitle>
                                                        <DialogDescription className='pt-2'>
                                                            {t('history.confirmDeletionDescription', {
                                                                count: item.images.length
                                                            })}
                                                        </DialogDescription>
                                                    </DialogHeader>
                                                    <div className='flex items-center space-x-2 py-2'>
                                                        <Checkbox
                                                            id={`dont-ask-${itemKey}`}
                                                            checked={deletePreferenceDialogValue}
                                                            onCheckedChange={(checked) =>
                                                                onDeletePreferenceDialogChange(!!checked)
                                                            }
                                                            className='data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground'
                                                        />
                                                        <label
                                                            htmlFor={`dont-ask-${itemKey}`}
                                                            className='text-muted-foreground text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70'>
                                                            {t('history.dontAskAgain')}
                                                        </label>
                                                    </div>
                                                    <DialogFooter className='gap-2 sm:justify-end'>
                                                        <Button
                                                            type='button'
                                                            variant='outline'
                                                            size='sm'
                                                            onClick={onCancelDeletion}>
                                                            {t('common.cancel')}
                                                        </Button>
                                                        <Button
                                                            type='button'
                                                            variant='destructive'
                                                            size='sm'
                                                            onClick={onConfirmDeletion}>
                                                            {t('common.delete')}
                                                        </Button>
                                                    </DialogFooter>
                                                </DialogContent>
                                            </Dialog>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
                {isRetentionSelectionActive ? (
                    <div className='bg-background/96 border-border sticky bottom-0 z-40 mt-3 flex min-h-14 items-center gap-2 border-t px-3 py-2 shadow-[0_-8px_16px_rgba(15,23,42,0.08)] backdrop-blur-sm'>
                        <div className='mr-auto min-w-0'>
                            <p className='text-muted-foreground text-xs'>
                                {t('retention.selectedCount', { count: activeSelectedRetentionFilenames.size })}
                            </p>
                            {retentionError ? (
                                <p className='text-destructive mt-0.5 text-[11px]' role='status'>
                                    {retentionError}
                                </p>
                            ) : null}
                        </div>
                        <Button
                            type='button'
                            size='sm'
                            disabled={activeSelectedRetentionFilenames.size === 0 || isUpdatingRetention}
                            onClick={() => void submitRetentionUpdate('preserve')}
                            className='min-h-10 px-3 text-xs lg:min-h-8'>
                            <Bookmark className='h-3.5 w-3.5' />
                            {t('retention.preserve')}
                        </Button>
                        <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            disabled={activeSelectedRetentionFilenames.size === 0 || isUpdatingRetention}
                            onClick={() => void submitRetentionUpdate('release')}
                            className='min-h-10 px-3 text-xs lg:min-h-8'>
                            {t('retention.release')}
                        </Button>
                    </div>
                ) : null}
            </CardContent>
            <ActivityTimeline
                activityItems={activityItems}
                history={history}
                onSelectImage={onSelectImage}
                onClearHistory={onClearHistory}
                getImageSrc={getImageSrc}
                formatStatusTime={formatStatusTime}
                formatDuration={formatDuration}
                t={t}
            />
        </Card>
    );
}

export const HistoryPanel = React.memo(HistoryPanelImpl);
