'use client';

import { selectAnnouncedGenerationActivity, type GenerationActivityItem } from '@/lib/generation-activity';
import { getHistoryEntryId, type HistoryMetadata } from '@/lib/history-metadata';
import { cn } from '@/lib/utils';
import Image from 'next/image';

type ActivityTimelineProps = {
    activityItems: GenerationActivityItem[];
    history: HistoryMetadata[];
    onSelectImage: (item: HistoryMetadata) => void;
    onClearHistory: () => void;
    getImageSrc: (filename: string) => string | undefined;
    formatStatusTime: (timestamp: number) => string;
    formatDuration: (ms: number) => string;
    t: (key: string, values?: Record<string, string | number>) => string;
};

function getActivityToneClass(tone: GenerationActivityItem['tone']): string {
    if (tone === 'progress') return 'bg-sky-500';
    if (tone === 'success') return 'bg-emerald-500';
    if (tone === 'warning') return 'bg-amber-500';
    return 'bg-slate-400';
}

function getActivityToneLabel(tone: GenerationActivityItem['tone'], t: ActivityTimelineProps['t']): string {
    if (tone === 'progress') return t('history.activityToneProgress');
    if (tone === 'success') return t('history.activityToneSuccess');
    if (tone === 'warning') return t('history.activityToneWarning');
    return t('history.activityToneNeutral');
}

function GenerationActivityRows({
    items,
    t,
    compact = false
}: {
    items: GenerationActivityItem[];
    t: ActivityTimelineProps['t'];
    compact?: boolean;
}) {
    return (
        <>
            {items.map((item, index) => (
                <div
                    key={item.id}
                    style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}
                    className={cn(
                        'reveal-image grid grid-cols-[auto_auto_1fr] items-start gap-2 rounded-md px-2 text-left transition-[background-color]',
                        index === 0 ? 'bg-muted/70' : 'bg-background/58',
                        compact ? 'py-1.5' : 'py-2',
                        item.tone === 'warning' && 'bg-destructive/5'
                    )}>
                    <span className='text-muted-foreground mt-0.5 w-10 shrink-0 text-right text-[10px] leading-4 tabular-nums'>
                        {getActivityToneLabel(item.tone, t)}
                    </span>
                    <span className={cn('flex h-full w-3 justify-center', compact ? 'pt-1' : 'pt-1.5')}>
                        <span className={cn('h-2 w-2 rounded-full', getActivityToneClass(item.tone))} />
                    </span>
                    <span className='min-w-0'>
                        <span className='text-foreground block truncate text-xs font-medium'>{item.label}</span>
                        <span
                            className={cn(
                                'text-muted-foreground block text-[11px] break-words',
                                compact ? 'mt-0 leading-4' : 'mt-0.5'
                            )}>
                            {item.detail}
                        </span>
                    </span>
                </div>
            ))}
        </>
    );
}

function ActivityHistoryRow({
    item,
    index,
    hasLiveActivity,
    onSelectImage,
    getImageSrc,
    formatStatusTime,
    formatDuration,
    t
}: {
    item: HistoryMetadata;
    index: number;
    hasLiveActivity: boolean;
    onSelectImage: (item: HistoryMetadata) => void;
    getImageSrc: (filename: string) => string | undefined;
    formatStatusTime: (timestamp: number) => string;
    formatDuration: (ms: number) => string;
    t: (key: string, values?: Record<string, string | number>) => string;
}) {
    const isLatestQuietActivity = index === 0 && !hasLiveActivity;
    const isFailedItem = item.status === 'failed';
    const activityLabel = isFailedItem
        ? t('history.failedStatus')
        : item.mode === 'edit'
          ? t('history.statusEditDone')
          : t('history.statusCreateDone');
    const activityDetail = isFailedItem
        ? item.failureMessage?.trim() || t('history.failedReasonUnavailable')
        : t('history.statusBatchSummary', {
              count: item.images.length,
              duration: formatDuration(item.durationMs)
          });

    return (
        <button
            type='button'
            onClick={() => onSelectImage(item)}
            disabled={isFailedItem}
            style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}
            className={cn(
                'reveal-image grid w-full grid-cols-[auto_auto_1fr_auto] items-start gap-2 rounded-md px-2 py-2 text-left transition-[background-color,color]',
                isLatestQuietActivity
                    ? 'text-foreground bg-muted'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/70',
                isFailedItem && 'cursor-default'
            )}>
            <span className='text-muted-foreground mt-0.5 w-10 shrink-0 text-right text-[10px] leading-4 tabular-nums'>
                {formatStatusTime(item.timestamp)}
            </span>
            <span className='flex h-full w-3 justify-center pt-1.5'>
                <span
                    className={cn(
                        'h-2 w-2 rounded-full',
                        isFailedItem ? 'bg-destructive' : isLatestQuietActivity ? 'bg-amber-500' : 'bg-emerald-500'
                    )}
                />
            </span>
            <span className='min-w-0'>
                <span className='flex min-w-0 items-center gap-2'>
                    <span className='text-foreground truncate text-xs font-medium'>{activityLabel}</span>
                </span>
                <span className='text-muted-foreground mt-0.5 block text-[11px] leading-4 break-words'>
                    {activityDetail}
                </span>
            </span>
            <span className='hidden shrink-0 gap-1 sm:flex'>
                {item.images.slice(0, 3).map((image) => {
                    const source =
                        item.storageModeUsed === 'indexeddb'
                            ? getImageSrc(image.filename)
                            : `/api/image/${image.filename}`;
                    return source ? (
                        <span
                            key={image.filename}
                            className='border-background bg-muted relative h-7 w-7 overflow-hidden rounded-sm border shadow-sm'>
                            <Image
                                src={source}
                                alt={image.filename}
                                width={28}
                                height={28}
                                sizes='28px'
                                className='image-edge h-full w-full object-cover'
                                unoptimized
                            />
                        </span>
                    ) : null;
                })}
            </span>
        </button>
    );
}

export function ActivityTimeline({
    activityItems,
    history,
    onSelectImage,
    onClearHistory,
    getImageSrc,
    formatStatusTime,
    formatDuration,
    t
}: ActivityTimelineProps) {
    const hasActivity = activityItems.length > 0 || history.length > 0;
    const liveActivity = selectAnnouncedGenerationActivity(activityItems);

    if (!hasActivity) return null;

    return (
        <div className='border-border/60 bg-background/48 shrink-0 border-t p-3 lg:mt-1 lg:min-h-[16.5rem] lg:border-t-0 lg:bg-transparent xl:min-h-0 xl:flex-1 xl:shrink'>
            <div className='border-border bg-card space-y-2 rounded-md border p-2.5 shadow-[0_6px_16px_rgb(15,23,42,0.06)] xl:flex xl:h-full xl:min-h-0 xl:flex-col'>
                <div className='flex items-center justify-between gap-2'>
                    <div className='min-w-0'>
                        <div className='flex items-center gap-2'>
                            <span className='h-2 w-2 rounded-full bg-amber-500' />
                            <p className='text-sm font-medium'>{t('history.generationStatus')}</p>
                        </div>
                        <p className='text-muted-foreground mt-0.5 text-[11px] leading-4 break-words'>
                            {t('history.generationStatusHint')}
                        </p>
                    </div>
                    {history.length > 0 ? (
                        <button
                            type='button'
                            className='text-muted-foreground hover:text-foreground focus-visible:ring-ring min-h-11 shrink-0 rounded-md px-2 py-2 text-xs transition-[color,box-shadow] focus-visible:ring-2 focus-visible:outline-none lg:min-h-8 lg:py-1'
                            onClick={onClearHistory}>
                            {t('history.clear')}
                        </button>
                    ) : null}
                </div>
                <p role='status' aria-live='polite' aria-atomic='true' className='sr-only'>
                    {liveActivity ? `${liveActivity.label} ${liveActivity.detail}` : ''}
                </p>
                <div className='max-h-56 space-y-2 overflow-y-auto pr-1 text-xs lg:max-h-[12.5rem] xl:max-h-none xl:min-h-0 xl:flex-1'>
                    <GenerationActivityRows items={activityItems} t={t} compact />
                    {history.slice(0, 4).map((item, index) => (
                        <ActivityHistoryRow
                            key={getHistoryEntryId(item)}
                            item={item}
                            index={index}
                            hasLiveActivity={activityItems.length > 0}
                            onSelectImage={onSelectImage}
                            getImageSrc={getImageSrc}
                            formatStatusTime={formatStatusTime}
                            formatDuration={formatDuration}
                            t={t}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
