'use client';

import { ImageCompareView, resolveCompareTargetIndex } from '@/components/image-compare-view';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { getActivityLogLevelLabel } from '@/lib/image-display-labels';
import { buildLogScopeDiagnostics, filterLogsByScope, resolveLogClientRequestIds } from '@/lib/log-filter';
import { cn } from '@/lib/utils';
import {
    Copy,
    Download,
    GitCompare,
    Grid,
    Loader2,
    RefreshCcw,
    Send,
    Share2,
    Activity,
    Trash2,
    ImageIcon
} from 'lucide-react';
import Image from 'next/image';
import * as React from 'react';

type ImageInfo = {
    path: string;
    filename: string;
    clientRequestId?: string;
    storageMode?: 'fs' | 'indexeddb';
};

type ImageActionTarget = {
    filename: string;
    storageMode?: ImageInfo['storageMode'];
};

type ImageOutputProps = {
    imageBatch: ImageInfo[] | null;
    viewMode: 'grid' | number;
    onViewChange: (view: 'grid' | number) => void;
    altText?: string;
    isLoading: boolean;
    onSendToEdit: (filename: string, storageMode?: ImageInfo['storageMode']) => void;
    onDownloadImage: (filename: string, storageMode?: ImageInfo['storageMode']) => void;
    onShareImage: (filename: string, storageMode?: ImageInfo['storageMode']) => void;
    onCreateVariant: () => void;
    onReusePrompt: () => void;
    failureMessage?: string | null;
    onRetry?: () => void;
    compareImage?: ImageInfo | null;
    compareImageLabel?: string;
    canCreateVariant: boolean;
    canReusePrompt: boolean;
    currentMode: 'generate' | 'edit';
    baseImagePreviewUrl: string | null;
    streamingPreviewImages?: Map<number, string>;
    isStreamingRequest?: boolean;
    /** 已等待秒数；>0 时在加载态副标题里显示，让用户知道还在跑。 */
    elapsedSeconds?: number;
    /** 生成中提供取消；未传则不显示取消按钮。 */
    onCancel?: () => void;
    clientPasswordHash: string | null;
    canOpenLogs: boolean;
    openLogsSignal?: number;
    logClientRequestIds?: string[];
    logFilenames?: string[];
    isLogScopeBatch?: boolean;
};

type LogEntry = {
    id: number;
    at: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    context?: string;
    clientRequestId?: string;
    filenames?: string[];
};

type ImageDimensions = {
    width: number;
    height: number;
};

type UnavailableCompareImage = {
    imageBatch: ImageInfo[] | null;
    filenames: string[];
};

export function buildImageActionTarget(image: ImageInfo | null): ImageActionTarget | null {
    if (!image) return null;
    return {
        filename: image.filename,
        ...(image.storageMode ? { storageMode: image.storageMode } : {})
    };
}

export function formatLogTime(value: string, locale: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleTimeString(locale);
}

export function resolveLogScopeCopy(input: {
    hasLogScope: boolean;
    hasSelectedImageBatch: boolean;
    hasScopeCandidate: boolean;
    isLogScopeBatch: boolean;
}): { scopeKey: string; emptyKey: string } {
    if (input.hasLogScope) {
        return {
            scopeKey: input.isLogScopeBatch ? 'logs.scopeBatch' : 'logs.scopeSelected',
            emptyKey: input.isLogScopeBatch ? 'logs.emptyForBatch' : 'logs.emptyForSelection'
        };
    }

    if (input.hasSelectedImageBatch) {
        return {
            scopeKey: input.isLogScopeBatch ? 'logs.scopeMissingBatch' : 'logs.scopeMissing',
            emptyKey:
                !input.hasScopeCandidate && input.isLogScopeBatch
                    ? 'logs.historyBatchWithoutScope'
                    : !input.hasScopeCandidate
                      ? 'logs.historyWithoutScope'
                      : 'logs.selectImage'
        };
    }

    return { scopeKey: 'logs.scopeNone', emptyKey: 'logs.selectImage' };
}

function formatLogScopeValues(values: string[]): string {
    return values.length > 0 ? values.join(', ') : '-';
}

function readImageDimensionsFromSource(source: string): Promise<ImageDimensions | null> {
    return new Promise((resolve) => {
        const image = new window.Image();
        image.onload = () => {
            if (!image.naturalWidth || !image.naturalHeight) {
                resolve(null);
                return;
            }
            resolve({
                width: image.naturalWidth,
                height: image.naturalHeight
            });
        };
        image.onerror = () => resolve(null);
        image.src = source;
    });
}

const getGridColsClass = (count: number): string => {
    if (count <= 1) return 'grid-cols-1';
    if (count <= 4) return 'grid-cols-2';
    if (count <= 9) return 'grid-cols-3';
    return 'grid-cols-3';
};

type ResultActionButtonProps = {
    icon: React.ReactNode;
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    active?: boolean;
    emphasized?: boolean;
    iconOnly?: boolean;
};

function ResultActionButton({
    icon,
    label,
    onClick,
    disabled = false,
    active = false,
    emphasized = false,
    iconOnly = false
}: ResultActionButtonProps) {
    return (
        <Button
            variant='ghost'
            size='sm'
            onClick={onClick}
            disabled={disabled}
            className={cn(
                'touch-target text-muted-foreground hover:text-foreground shrink-0 rounded-md px-3 text-xs transition-[background-color,color,box-shadow,transform] enabled:active:scale-[0.96] disabled:opacity-50 lg:px-2',
                active && 'bg-accent text-accent-foreground hover:text-accent-foreground',
                emphasized && 'border-border/70 bg-card/80 border'
            )}
            aria-label={iconOnly ? label : undefined}>
            {icon}
            {!iconOnly && <span>{label}</span>}
        </Button>
    );
}

export function ImageOutput({
    imageBatch,
    viewMode,
    onViewChange,
    altText,
    isLoading,
    onSendToEdit,
    onDownloadImage,
    onShareImage,
    onCreateVariant,
    onReusePrompt,
    failureMessage = null,
    onRetry,
    compareImage = null,
    compareImageLabel,
    canCreateVariant,
    canReusePrompt,
    currentMode,
    baseImagePreviewUrl,
    streamingPreviewImages,
    isStreamingRequest = false,
    elapsedSeconds = 0,
    onCancel,
    clientPasswordHash,
    canOpenLogs,
    openLogsSignal,
    logClientRequestIds = [],
    logFilenames = [],
    isLogScopeBatch = false
}: ImageOutputProps) {
    const { locale, t } = useI18n();
    const resolvedAltText = altText ?? t('output.alt');
    const [isLogDialogOpen, setIsLogDialogOpen] = React.useState(false);
    const [logs, setLogs] = React.useState<LogEntry[]>([]);
    const [logConnectionState, setLogConnectionState] = React.useState<'idle' | 'connected' | 'error'>('idle');
    const [copiedLogScopeText, setCopiedLogScopeText] = React.useState<string | null>(null);
    const [compareSelection, setCompareSelection] = React.useState<{
        imageBatch: ImageInfo[];
        selectedImageIndex: number;
        compareTargetFilename: string;
    } | null>(null);
    const [unavailableCompareImage, setUnavailableCompareImage] = React.useState<UnavailableCompareImage | null>(null);
    const [imageDimensions, setImageDimensions] = React.useState<Record<string, ImageDimensions>>({});
    const logEndRef = React.useRef<HTMLDivElement | null>(null);
    const resolvedLogClientRequestIds = React.useMemo(
        () => resolveLogClientRequestIds({ logs, clientRequestIds: logClientRequestIds, filenames: logFilenames }),
        [logClientRequestIds, logFilenames, logs]
    );
    const filteredLogs = React.useMemo(
        () => filterLogsByScope({ logs, clientRequestIds: resolvedLogClientRequestIds, filenames: [] }) as LogEntry[],
        [logs, resolvedLogClientRequestIds]
    );
    const logScopeDiagnostics = React.useMemo(
        () =>
            buildLogScopeDiagnostics({
                clientRequestIds: logClientRequestIds,
                filenames: logFilenames,
                resolvedClientRequestIds: resolvedLogClientRequestIds
            }),
        [logClientRequestIds, logFilenames, resolvedLogClientRequestIds]
    );
    const hasSelectedImageBatch = !!imageBatch && imageBatch.length > 0;
    const hasLogScope = resolvedLogClientRequestIds.length > 0;
    const hasScopeCandidate = logClientRequestIds.length > 0 || logFilenames.length > 0;
    const logScopeCopy = resolveLogScopeCopy({
        hasLogScope,
        hasSelectedImageBatch,
        hasScopeCandidate,
        isLogScopeBatch
    });
    const visibleLogs = React.useMemo(() => (hasLogScope ? filteredLogs : []), [filteredLogs, hasLogScope]);
    const showCarousel = Boolean(imageBatch && imageBatch.length > 1);
    const selectedImageIndex =
        imageBatch && imageBatch.length > 0
            ? typeof viewMode === 'number' && imageBatch[viewMode]
                ? viewMode
                : showCarousel
                  ? null
                  : 0
            : null;
    const selectedImage = selectedImageIndex === null ? null : imageBatch?.[selectedImageIndex] || null;
    const sameBatchCompareTargetIndex = imageBatch
        ? resolveCompareTargetIndex(imageBatch.length, selectedImageIndex)
        : null;
    const sameBatchCompareTargetImage =
        sameBatchCompareTargetIndex === null ? null : imageBatch?.[sameBatchCompareTargetIndex] || null;
    const candidateCompareTargetImage = sameBatchCompareTargetImage || compareImage || null;
    const unavailableCompareFilenames =
        unavailableCompareImage?.imageBatch === imageBatch ? unavailableCompareImage.filenames : [];
    const isSelectedImageUnavailable =
        selectedImage !== null && unavailableCompareFilenames.includes(selectedImage.filename);
    const isCandidateCompareTargetUnavailable =
        candidateCompareTargetImage !== null &&
        unavailableCompareFilenames.includes(candidateCompareTargetImage.filename);
    const compareTargetImage =
        candidateCompareTargetImage && !isCandidateCompareTargetUnavailable ? candidateCompareTargetImage : null;
    const compareError =
        isSelectedImageUnavailable || isCandidateCompareTargetUnavailable ? t('output.compareUnavailable') : null;
    const selectedImageDimensions = selectedImage ? imageDimensions[selectedImage.filename] : null;
    const hasFailure = !isLoading && !hasSelectedImageBatch && Boolean(failureMessage);
    const hasEditReferencePreview = currentMode === 'edit' && Boolean(baseImagePreviewUrl);
    const isGenerateEmptyState = !isLoading && !hasFailure && !hasSelectedImageBatch && currentMode === 'generate';
    const failureTitle = currentMode === 'edit' ? t('output.editFailedTitle') : t('output.failedTitle');
    const failureKicker = currentMode === 'edit' ? t('output.editFailedKicker') : t('output.failedKicker');
    const retryLabel = currentMode === 'edit' ? t('output.retryEdit') : t('output.retry');
    const previewStateLabel = isLoading
        ? t('output.progressDeveloping')
        : hasFailure
          ? failureTitle
          : hasEditReferencePreview
            ? t('output.editReferenceReady')
            : currentMode === 'edit'
              ? t('output.editReferenceNeeded')
              : imageBatch && imageBatch.length > 0
                ? t('output.previewReady')
                : t('output.emptyTitle');
    const previewMetaItems = [
        !isLoading && imageBatch && imageBatch.length > 0
            ? selectedImageIndex === null
                ? t('output.selectImageForActions')
                : t('output.selectedImageMeta', {
                      index: selectedImageIndex + 1,
                      count: imageBatch.length
                  })
            : null,
        !isLoading && selectedImageDimensions
            ? t('output.imageDimensions', {
                  width: selectedImageDimensions.width,
                  height: selectedImageDimensions.height
              })
            : null,
        isLoading ? (isStreamingRequest ? t('output.streaming') : t('output.progressGenerating')) : null
    ].filter((item): item is string => Boolean(item));
    const canUseSelectedImageActions = !isLoading && !!selectedImage;
    const canCompareImages = !isLoading && !!selectedImage && !isSelectedImageUnavailable && !!compareTargetImage;
    const isCompareView =
        !!compareSelection &&
        compareSelection.imageBatch === imageBatch &&
        compareSelection.selectedImageIndex === selectedImageIndex &&
        compareSelection.compareTargetFilename === compareTargetImage?.filename;
    const compareReferenceLabel = sameBatchCompareTargetImage
        ? selectedImageIndex === 0
            ? t('output.compareOther')
            : t('output.compareReference')
        : (compareImageLabel ?? t('output.compareReference'));

    const handleSendClick = () => {
        const target = buildImageActionTarget(selectedImage);
        if (!target) return;
        onSendToEdit(target.filename, target.storageMode);
    };

    const handleDownloadClick = () => {
        const target = buildImageActionTarget(selectedImage);
        if (!target) return;
        onDownloadImage(target.filename, target.storageMode);
    };

    const handleShareClick = () => {
        const target = buildImageActionTarget(selectedImage);
        if (!target) return;
        onShareImage(target.filename, target.storageMode);
    };

    const handleCompareClick = () => {
        if (isCompareView) {
            setCompareSelection(null);
            return;
        }
        if (canCompareImages && imageBatch && selectedImageIndex !== null && compareTargetImage) {
            setCompareSelection({ imageBatch, selectedImageIndex, compareTargetFilename: compareTargetImage.filename });
        }
    };

    const handleCompareImageError = React.useCallback(
        (image: ImageInfo) => {
            if (image.filename !== selectedImage?.filename && image.filename !== compareTargetImage?.filename) return;
            setUnavailableCompareImage((current) => {
                if (current?.imageBatch === imageBatch && current.filenames.includes(image.filename)) return current;
                return {
                    imageBatch,
                    filenames:
                        current?.imageBatch === imageBatch ? [...current.filenames, image.filename] : [image.filename]
                };
            });
            setCompareSelection(null);
        },
        [compareTargetImage?.filename, imageBatch, selectedImage?.filename]
    );

    const handleImageLoad = React.useCallback((filename: string, event: React.SyntheticEvent<HTMLImageElement>) => {
        const source = event.currentTarget.currentSrc || event.currentTarget.src;
        if (!source) return;

        void readImageDimensionsFromSource(source).then((nextDimensions) => {
            if (!nextDimensions) return;
            setImageDimensions((current) => {
                const currentDimensions = current[filename];
                if (
                    currentDimensions?.width === nextDimensions.width &&
                    currentDimensions.height === nextDimensions.height
                ) {
                    return current;
                }
                return { ...current, [filename]: nextDimensions };
            });
        });
    }, []);

    const handleLogDialogOpenChange = (open: boolean) => {
        setIsLogDialogOpen(open);
        if (!open) {
            setLogConnectionState('idle');
            setCopiedLogScopeText(null);
        }
    };

    const handleCopyLogScope = async () => {
        try {
            if (!navigator.clipboard?.writeText) {
                throw new Error('Clipboard API unavailable.');
            }
            await navigator.clipboard.writeText(logScopeDiagnostics.copyText);
            setCopiedLogScopeText(logScopeDiagnostics.copyText);
            window.setTimeout(() => {
                setCopiedLogScopeText((current) => (current === logScopeDiagnostics.copyText ? null : current));
            }, 1500);
        } catch (error) {
            console.error('复制日志诊断范围失败。', error);
        }
    };

    React.useEffect(() => {
        if (!isLogDialogOpen || !canOpenLogs) return;

        const abortController = new AbortController();
        const readLogs = async () => {
            try {
                const response = await fetch('/api/logs', {
                    headers: clientPasswordHash ? { Authorization: `Bearer ${clientPasswordHash}` } : {},
                    signal: abortController.signal
                });
                if (!response.ok || !response.body) {
                    setLogConnectionState('error');
                    return;
                }

                setLogConnectionState('connected');
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                const processEvent = (rawEvent: string) => {
                    const dataLines = rawEvent
                        .split(/\r?\n/)
                        .filter((line) => line.startsWith('data: '))
                        .map((line) => line.slice(6));
                    if (dataLines.length === 0) return;

                    let entry: LogEntry;
                    try {
                        entry = JSON.parse(dataLines.join('\n')) as LogEntry;
                    } catch (error) {
                        console.error('解析日志事件失败。', error);
                        return;
                    }

                    setLogs((prevLogs) => {
                        const nextLogs = prevLogs.some((log) => log.id === entry.id)
                            ? prevLogs
                            : [...prevLogs, entry].slice(-300);
                        return nextLogs;
                    });
                };

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const events = buffer.split(/\n\n|\r\n\r\n/);
                    buffer = events.pop() || '';
                    events.forEach(processEvent);
                }

                const remainingEvent = buffer.trim();
                if (remainingEvent) {
                    processEvent(remainingEvent);
                }
                setLogConnectionState('idle');
            } catch (error) {
                if (abortController.signal.aborted) return;
                console.error('读取日志流失败。', error);
                setLogConnectionState('error');
            }
        };

        void readLogs();

        return () => {
            abortController.abort();
        };
    }, [canOpenLogs, clientPasswordHash, isLogDialogOpen]);

    React.useEffect(() => {
        if (!isLogDialogOpen) return;
        logEndRef.current?.scrollIntoView({ block: 'end' });
    }, [isLogDialogOpen, visibleLogs]);

    React.useEffect(() => {
        if (!openLogsSignal || !canOpenLogs) return;
        queueMicrotask(() => setIsLogDialogOpen(true));
    }, [canOpenLogs, openLogsSignal]);

    return (
        <div
            className={cn(
                'workbench-panel text-card-foreground border-border flex min-h-[300px] w-full flex-col overflow-hidden rounded-lg border',
                isGenerateEmptyState ? 'h-fit xl:h-full' : 'h-full'
            )}>
            <div className='workbench-panel-header border-border/70 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3'>
                <h2 className='editorial-title text-xl font-semibold'>{t('output.previewTitle')}</h2>
                <div className='text-muted-foreground ui-stat flex flex-wrap items-center gap-3 text-xs'>
                    <span className='inline-flex items-center gap-1.5'>
                        {isLoading ? (
                            <Loader2 className='text-primary h-3.5 w-3.5 animate-spin' />
                        ) : (
                            <span
                                className={cn(
                                    'h-2 w-2 rounded-full',
                                    imageBatch && imageBatch.length > 0 ? 'bg-emerald-500' : 'bg-muted-foreground/45'
                                )}
                            />
                        )}
                        {previewStateLabel}
                    </span>
                    {previewMetaItems.map((item) => (
                        <span key={item}>{item}</span>
                    ))}
                </div>
            </div>
            <div
                className={cn(
                    'preview-gallery-board relative flex items-center justify-center overflow-hidden px-3 py-5 sm:px-6',
                    isGenerateEmptyState
                        ? 'min-h-[220px] shrink-0 sm:min-h-[248px] lg:min-h-[272px] xl:min-h-0 xl:flex-1'
                        : 'min-h-[300px] flex-1 sm:min-h-[420px] lg:min-h-[520px]'
                )}>
                {isLoading ? (
                    streamingPreviewImages && streamingPreviewImages.size > 0 ? (
                        // 展示流式预览图，单图时和最终视图一样居中。
                        <div className='photo-paper relative flex aspect-[4/3] w-full max-w-[780px] items-center justify-center p-3 2xl:max-w-[860px]'>
                            {/* 展示最新的预览图，也就是最大索引图片。 */}
                            {(() => {
                                const entries = Array.from(streamingPreviewImages.entries());
                                const latestEntry = entries[entries.length - 1];
                                if (!latestEntry) return null;
                                const [, dataUrl] = latestEntry;
                                return (
                                    <Image
                                        src={dataUrl}
                                        alt={t('output.streaming')}
                                        width={512}
                                        height={512}
                                        className='image-edge h-full w-full rounded-md object-contain'
                                        unoptimized
                                    />
                                );
                            })()}
                            {/* 在底部居中叠加加载状态。 */}
                            <div className='bg-foreground/80 text-background animate-in fade-in-0 absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 duration-200'>
                                <Loader2 className='h-4 w-4 animate-spin' />
                                <p className='text-sm'>{t('output.streaming')}</p>
                            </div>
                        </div>
                    ) : currentMode === 'edit' && baseImagePreviewUrl ? (
                        <div className='photo-paper relative flex aspect-[4/3] w-full max-w-[780px] items-center justify-center p-3 2xl:max-w-[860px]'>
                            <Image
                                src={baseImagePreviewUrl}
                                alt={t('output.editing')}
                                fill
                                style={{ objectFit: 'contain' }}
                                className='image-edge rounded-md blur-md filter'
                                unoptimized
                            />
                            <div className='absolute inset-0 flex flex-col items-center justify-center bg-black/50 text-white/80'>
                                <Loader2 className='mb-2 h-8 w-8 animate-spin' />
                                <p>{t('output.editing')}</p>
                            </div>
                        </div>
                    ) : (
                        <div className='text-muted-foreground animate-in fade-in-0 flex flex-col items-center justify-center duration-300'>
                            <div className='relative mb-3 flex h-12 w-12 items-center justify-center'>
                                <span
                                    aria-hidden='true'
                                    className='bg-primary/20 breathing-halo absolute inset-0 rounded-full'
                                />
                                <Loader2 className='text-primary relative h-7 w-7 animate-spin' />
                            </div>
                            <p className='text-foreground/85 text-sm font-medium'>
                                {isStreamingRequest ? t('output.keepalive') : t('output.generating')}
                            </p>
                            {elapsedSeconds > 0 && (
                                <p className='mt-1 text-xs tabular-nums' data-testid='generation-elapsed'>
                                    {t('output.elapsed', { seconds: elapsedSeconds })}
                                </p>
                            )}
                            <div
                                aria-hidden='true'
                                data-testid='generation-wait-indicator'
                                className='bg-primary/15 shimmer-sweep mt-3 h-1 w-28 overflow-hidden rounded-full'
                            />
                            {onCancel && (
                                <Button
                                    type='button'
                                    variant='outline'
                                    size='sm'
                                    className='mt-3'
                                    onClick={onCancel}
                                    data-testid='cancel-generation'>
                                    {t('output.cancelGeneration')}
                                </Button>
                            )}
                        </div>
                    )
                ) : hasFailure ? (
                    <div className='photo-paper reveal-image relative flex aspect-[4/3] w-full max-w-[780px] flex-col justify-between p-5 sm:p-6 2xl:max-w-[860px]'>
                        <div className='space-y-3'>
                            <div className='text-muted-foreground text-xs'>{failureKicker}</div>
                            <div className='space-y-2'>
                                <h3 className='editorial-title text-2xl font-semibold'>{failureTitle}</h3>
                                <p className='text-muted-foreground max-w-[46rem] text-sm leading-6'>
                                    {failureMessage}
                                </p>
                            </div>
                        </div>
                        <div className='flex flex-wrap items-center gap-2'>
                            {onRetry ? (
                                <Button type='button' onClick={onRetry} className='min-h-11'>
                                    <RefreshCcw className='mr-2 h-4 w-4' />
                                    {retryLabel}
                                </Button>
                            ) : null}
                            {canOpenLogs ? (
                                <Button
                                    type='button'
                                    variant='outline'
                                    onClick={() => setIsLogDialogOpen(true)}
                                    className='bg-background/76 min-h-11'>
                                    <Activity className='mr-2 h-4 w-4' />
                                    {t('logs.open')}
                                </Button>
                            ) : null}
                        </div>
                    </div>
                ) : isCompareView && selectedImage && compareTargetImage ? (
                    <ImageCompareView
                        leftImage={compareTargetImage}
                        leftLabel={compareReferenceLabel}
                        rightImage={selectedImage}
                        rightLabel={t('output.compareCurrent')}
                        onImageError={handleCompareImageError}
                    />
                ) : imageBatch && imageBatch.length > 0 ? (
                    viewMode === 'grid' ? (
                        <div
                            className={`grid ${getGridColsClass(imageBatch.length)} w-full max-w-[780px] gap-2 2xl:max-w-[860px]`}>
                            {imageBatch.map((img, index) => (
                                <button
                                    type='button'
                                    key={img.filename}
                                    onClick={() => onViewChange(index)}
                                    style={{ animationDelay: `${Math.min(index, 8) * 55}ms` }}
                                    className={cn(
                                        'photo-paper reveal-image group relative aspect-square overflow-hidden p-2 text-left transition-[box-shadow,transform] enabled:motion-safe:hover:-translate-y-0.5',
                                        selectedImageIndex === index
                                            ? 'ring-ring ring-offset-background ring-2 ring-offset-2'
                                            : 'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2'
                                    )}
                                    aria-label={t('output.selectImage', { index: index + 1 })}>
                                    <Image
                                        src={img.path}
                                        alt={t('output.generatedImage', { index: index + 1 })}
                                        fill
                                        style={{ objectFit: 'contain' }}
                                        className='image-edge rounded-md transition-transform duration-500 ease-out motion-safe:group-hover:scale-[1.03]'
                                        sizes='(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 25vw'
                                        onLoad={(event) => handleImageLoad(img.filename, event)}
                                        unoptimized
                                    />
                                </button>
                            ))}
                        </div>
                    ) : imageBatch[viewMode] ? (
                        <div
                            key={imageBatch[viewMode].filename}
                            className='photo-paper reveal-image relative aspect-[4/3] w-full max-w-[780px] p-3 2xl:max-w-[860px]'>
                            <Image
                                src={imageBatch[viewMode].path}
                                alt={resolvedAltText}
                                fill
                                sizes='(max-width: 768px) 92vw, (max-width: 1536px) 44vw, 860px'
                                className='image-edge rounded-md object-contain'
                                onLoad={(event) => handleImageLoad(imageBatch[viewMode].filename, event)}
                                unoptimized
                            />
                        </div>
                    ) : (
                        <div className='text-muted-foreground text-center'>
                            <p>{t('output.error')}</p>
                        </div>
                    )
                ) : currentMode === 'edit' ? (
                    baseImagePreviewUrl ? (
                        <div className='photo-paper relative flex aspect-[4/3] w-full max-w-[780px] items-center justify-center p-3 2xl:max-w-[860px]'>
                            <Image
                                src={baseImagePreviewUrl}
                                alt={t('output.editReferenceAlt')}
                                fill
                                sizes='(max-width: 768px) 92vw, (max-width: 1536px) 44vw, 860px'
                                className='image-edge rounded-md object-contain p-3'
                                unoptimized
                            />
                            <div className='border-border/70 bg-background/86 text-muted-foreground absolute bottom-5 left-6 rounded-md border px-3 py-1 text-xs shadow-sm'>
                                {t('output.editReferenceReadyLabel')}
                            </div>
                        </div>
                    ) : (
                        <div className='relative mx-auto flex w-full max-w-[30rem] flex-col items-center justify-center gap-3 px-6 py-7 text-center'>
                            <div className='workbench-empty-state__icon border-border/70 bg-background/70 text-muted-foreground flex h-11 w-11 items-center justify-center rounded-md border shadow-sm'>
                                <ImageIcon className='h-5 w-5' aria-hidden='true' />
                            </div>
                            <div className='space-y-2'>
                                <h3 className='editorial-title text-lg font-semibold'>
                                    {t('output.editReferenceNeeded')}
                                </h3>
                                <p className='text-muted-foreground max-w-[36rem] text-sm leading-6'>
                                    {t('output.editReferenceDescription')}
                                </p>
                            </div>
                            <span className='border-border bg-card text-muted-foreground rounded-md border px-3 py-1 text-xs'>
                                {t('output.editReferenceWaitingLabel')}
                            </span>
                        </div>
                    )
                ) : (
                    <div className='workbench-empty-state relative mx-auto flex w-full max-w-[30rem] flex-col items-center justify-center gap-3 px-6 py-7 text-center'>
                        <div className='workbench-empty-state__icon border-border/70 bg-background/70 text-muted-foreground flex h-11 w-11 items-center justify-center rounded-md border shadow-sm'>
                            <ImageIcon className='h-5 w-5' aria-hidden='true' />
                        </div>
                        <div className='space-y-2'>
                            <h3 className='editorial-title text-lg font-semibold'>{t('output.emptyTitle')}</h3>
                            <p className='text-muted-foreground text-sm leading-6'>{t('output.emptyDescription')}</p>
                        </div>
                    </div>
                )}
            </div>

            {compareError ? (
                <div
                    role='status'
                    className='border-destructive/30 bg-destructive/5 text-destructive mx-3 mt-3 rounded-md border px-3 py-2 text-xs'>
                    {compareError}
                </div>
            ) : null}

            <Dialog open={isLogDialogOpen} onOpenChange={handleLogDialogOpenChange}>
                <DialogContent className='sm:max-w-[760px]'>
                    <DialogHeader>
                        <DialogTitle>{t('logs.title')}</DialogTitle>
                        <DialogDescription>{t('logs.description')}</DialogDescription>
                    </DialogHeader>
                    <div className='text-muted-foreground bg-muted/40 border-border flex items-center justify-between rounded-md border px-3 py-2 text-xs'>
                        <span>{t(`logs.status.${logConnectionState}`)}</span>
                        <span>{t('logs.count', { count: visibleLogs.length })}</span>
                    </div>
                    {hasLogScope ? (
                        <div className='text-muted-foreground border-border bg-muted/20 rounded-md border px-3 py-2 text-xs'>
                            {t(logScopeCopy.scopeKey)}
                        </div>
                    ) : hasSelectedImageBatch ? (
                        <div className='text-muted-foreground border-border rounded-md border border-dashed px-3 py-2 text-xs'>
                            {t(logScopeCopy.scopeKey)}
                        </div>
                    ) : (
                        <div className='text-muted-foreground border-border rounded-md border border-dashed px-3 py-2 text-xs'>
                            {t(logScopeCopy.scopeKey)}
                        </div>
                    )}
                    <div className='border-border bg-card/70 flex flex-col gap-2 rounded-md border px-3 py-2 text-xs sm:flex-row sm:items-start sm:justify-between'>
                        <div className='text-muted-foreground min-w-0 space-y-1'>
                            <p className='break-all'>
                                {t('logs.scopeRequestIds', {
                                    value: formatLogScopeValues(logScopeDiagnostics.requestIds)
                                })}
                            </p>
                            <p className='break-all'>
                                {t('logs.scopeFilenames', {
                                    value: formatLogScopeValues(logScopeDiagnostics.filenames)
                                })}
                            </p>
                            <p className='break-all'>
                                {t('logs.scopeResolvedRequestIds', {
                                    value: formatLogScopeValues(logScopeDiagnostics.filenameMatchedRequestIds)
                                })}
                            </p>
                        </div>
                        <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            className='shrink-0'
                            onClick={handleCopyLogScope}>
                            <Copy className='mr-2 h-4 w-4' />
                            {copiedLogScopeText === logScopeDiagnostics.copyText
                                ? t('common.copied')
                                : t('logs.copyScope')}
                        </Button>
                    </div>
                    <div className='literary-scrollbar bg-muted/30 border-border text-foreground/80 h-[420px] overflow-y-auto rounded-md border p-3 font-mono text-xs leading-5'>
                        {visibleLogs.length === 0 ? (
                            <p className='text-muted-foreground'>{t(logScopeCopy.emptyKey)}</p>
                        ) : (
                            visibleLogs.map((entry) => (
                                <div key={entry.id} className='border-border/50 border-b py-2 last:border-b-0'>
                                    <div className='flex flex-wrap items-center gap-2'>
                                        <span className='text-muted-foreground'>{formatLogTime(entry.at, locale)}</span>
                                        <span
                                            className={cn(
                                                'rounded border px-1.5 py-0.5 uppercase',
                                                entry.level === 'error' &&
                                                    'border-red-500/40 text-red-700 dark:border-red-400/40 dark:text-red-200',
                                                entry.level === 'warn' &&
                                                    'border-yellow-500/40 text-yellow-700 dark:border-yellow-400/40 dark:text-yellow-200',
                                                entry.level === 'info' &&
                                                    'border-blue-500/40 text-blue-700 dark:border-blue-300/30 dark:text-blue-100',
                                                entry.level === 'debug' && 'border-border text-muted-foreground'
                                            )}>
                                            {getActivityLogLevelLabel(entry.level, t)}
                                        </span>
                                        <span className='text-foreground break-all'>{entry.message}</span>
                                    </div>
                                    {entry.context ? (
                                        <pre className='text-muted-foreground mt-1 break-words whitespace-pre-wrap'>
                                            {entry.context}
                                        </pre>
                                    ) : null}
                                </div>
                            ))
                        )}
                        <div ref={logEndRef} />
                    </div>
                    <DialogFooter>
                        <Button type='button' variant='outline' size='sm' onClick={() => setLogs([])}>
                            <Trash2 className='mr-2 h-4 w-4' />
                            {t('logs.clearCurrent')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <div
                className={cn(
                    'border-border/40 flex w-full shrink-0 flex-wrap items-center justify-center gap-1.5 border-t bg-transparent px-3 py-2',
                    !hasSelectedImageBatch && 'bg-background/36'
                )}>
                {hasSelectedImageBatch ? (
                    <>
                        {showCarousel && (
                            <div className='bg-card/80 border-border literary-scrollbar flex max-w-full items-center gap-1.5 overflow-x-auto rounded-md border p-1'>
                                <Button
                                    variant='ghost'
                                    size='icon'
                                    className={cn(
                                        'touch-target rounded p-1',
                                        viewMode === 'grid'
                                            ? 'bg-accent text-accent-foreground'
                                            : 'text-muted-foreground'
                                    )}
                                    onClick={() => onViewChange('grid')}
                                    aria-label={t('output.showGrid')}>
                                    <Grid className='h-4 w-4' />
                                </Button>
                                {imageBatch.map((img, index) => (
                                    <Button
                                        key={img.filename}
                                        variant='ghost'
                                        size='icon'
                                        className={cn(
                                            'touch-target overflow-hidden rounded p-0.5',
                                            viewMode === index
                                                ? 'ring-ring ring-offset-background ring-2 ring-offset-1'
                                                : 'opacity-60 hover:opacity-100'
                                        )}
                                        onClick={() => onViewChange(index)}
                                        aria-label={t('output.selectImage', { index: index + 1 })}>
                                        <Image
                                            src={img.path}
                                            alt={t('output.thumbnail', { index: index + 1 })}
                                            width={28}
                                            height={28}
                                            className='image-edge h-full w-full rounded object-cover'
                                            unoptimized
                                        />
                                    </Button>
                                ))}
                            </div>
                        )}

                        {canOpenLogs && (
                            <ResultActionButton
                                icon={<Activity className='mr-2 h-4 w-4' />}
                                label={t('logs.open')}
                                onClick={() => setIsLogDialogOpen(true)}
                            />
                        )}

                        <ResultActionButton
                            icon={<Download className='mr-2 h-4 w-4' />}
                            label={t('output.download')}
                            onClick={handleDownloadClick}
                            disabled={!canUseSelectedImageActions}
                            emphasized={showCarousel && viewMode === 'grid'}
                        />
                        <ResultActionButton
                            icon={<Send className='mr-2 h-4 w-4' />}
                            label={t('output.continueEdit')}
                            onClick={handleSendClick}
                            disabled={!canUseSelectedImageActions}
                            emphasized={showCarousel && viewMode === 'grid'}
                        />
                        <ResultActionButton
                            icon={<RefreshCcw className='mr-2 h-4 w-4' />}
                            label={t('output.createVariant')}
                            onClick={onCreateVariant}
                            disabled={isLoading || !canCreateVariant}
                        />
                        <ResultActionButton
                            icon={<Copy className='mr-2 h-4 w-4' />}
                            label={t('output.reusePrompt')}
                            onClick={onReusePrompt}
                            disabled={isLoading || !canReusePrompt}
                        />
                        <ResultActionButton
                            icon={<GitCompare className='mr-2 h-4 w-4' />}
                            label={isCompareView ? t('output.exitCompare') : t('output.compare')}
                            onClick={handleCompareClick}
                            disabled={!canCompareImages}
                            active={isCompareView}
                        />
                        <ResultActionButton
                            icon={<Share2 className='mr-2 h-4 w-4' />}
                            label={t('output.share')}
                            onClick={handleShareClick}
                            disabled={!canUseSelectedImageActions}
                            emphasized={showCarousel && viewMode === 'grid'}
                        />
                    </>
                ) : (
                    <>
                        <ResultActionButton
                            icon={<Download className='mr-2 h-4 w-4' />}
                            label={t('output.download')}
                            disabled
                        />
                        <ResultActionButton
                            icon={<Send className='mr-2 h-4 w-4' />}
                            label={t('output.continueEdit')}
                            disabled
                        />
                        <ResultActionButton
                            icon={<RefreshCcw className='mr-2 h-4 w-4' />}
                            label={t('output.createVariant')}
                            disabled
                        />
                        <ResultActionButton
                            icon={<Copy className='mr-2 h-4 w-4' />}
                            label={t('output.reusePrompt')}
                            disabled
                        />
                        <ResultActionButton
                            icon={<GitCompare className='mr-2 h-4 w-4' />}
                            label={t('output.compare')}
                            disabled
                        />
                    </>
                )}
            </div>
        </div>
    );
}
