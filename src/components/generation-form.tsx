'use client';

import { ModeToggle } from '@/components/mode-toggle';
import type { WorkbenchMode } from '@/components/mode-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { findBatchPromptOverLimitIndex, readBatchPromptLines } from '@/lib/batch-prompts';
import type { GptImageModel } from '@/lib/cost-utils';
import { useI18n } from '@/lib/i18n';
import { getImageOutputFormatLabel, getImageQualityLabel } from '@/lib/image-display-labels';
import { MAX_PROMPT_LENGTH } from '@/lib/image-request-limits';
import { shouldRecommendImageStreaming } from '@/lib/image-streaming-recommendation';
import type {
    ImageUpstreamFormBackend,
    ImageUpstreamFormPromptOptimization,
    ImageUpstreamFormStreamingStrategy,
    ImageUpstreamFormThinking
} from '@/lib/image-upstream-form';
import {
    getImageUpstreamRouteImpactKeys,
    isImageUpstreamStreamingStrategySelectable,
    resolveImageUpstreamEffectiveStreamingStrategy
} from '@/lib/image-upstream-form';
import {
    buildIntegerRangeOptions,
    clampIntegerToRange,
    getImageBackendCompatibility,
    resolveImageBackendSelection,
    type ImageUpstreamProfile,
    type PartialImagesCount
} from '@/lib/image-upstream-profile';
import {
    type ImageGenerationBackend,
    type ImageStreamMode,
    type ImageStreamingStrategy
} from '@/lib/image-upstream-strategy';
import { DEFAULT_MODEL_OPTIONS } from '@/lib/model-directory-options';
import {
    getPresetDimensions,
    getPresetTooltip,
    getSizePresetOptions,
    formatExactImagePixelCount,
    shouldUsePositiveIntegerImageSize,
    readImageSizeNumberInput,
    supportsCustomImageSize,
    validateGptImage2Size,
    validatePositiveIntegerImageSize
} from '@/lib/size-utils';
import type { SizePreset } from '@/lib/size-utils';
import { resolveStreamingBatchToggleState } from '@/lib/streaming-batch';
import { getStreamingStatusLabel } from '@/lib/streaming-status-label';
import { cn } from '@/lib/utils';
import {
    Square,
    RectangleHorizontal,
    RectangleVertical,
    Sparkles,
    SlidersHorizontal,
    ChevronDown,
    Eraser,
    ShieldCheck,
    ShieldAlert,
    FileImage,
    CircleOff,
    Tally1,
    Tally2,
    Tally3,
    Tally4,
    Loader2,
    BrickWall,
    Lock,
    LockOpen,
    HelpCircle,
    SquareDashed,
    WandSparkles,
    Globe2,
    ListChecks,
    Pause,
    RotateCcw,
    Bookmark
} from 'lucide-react';
import * as React from 'react';

export type GenerationFormData = {
    prompt: string;
    n: number;
    size: SizePreset;
    customWidth: number;
    customHeight: number;
    quality: 'low' | 'medium' | 'high' | 'auto';
    output_format: 'png' | 'jpeg' | 'webp';
    output_compression?: number;
    background: 'transparent' | 'opaque' | 'auto';
    moderation: 'low' | 'auto';
    model: GptImageModel;
    image_backend: ImageUpstreamFormBackend;
    streaming_strategy: ImageUpstreamFormStreamingStrategy;
    responsesModel: string;
    thinking: ImageUpstreamFormThinking;
    promptOptimization: ImageUpstreamFormPromptOptimization;
    forceWeb: boolean;
    enableParallelBatch: boolean;
    batchPrompts?: string[];
};

export type WorkbenchReuseContext = {
    sourceLabel: string;
    restoredFields: string[];
    promptPreview: string;
};

type GenerationFormProps = {
    onSubmit: (data: GenerationFormData) => void;
    onSaveInspiration: (prompt: string) => void;
    canApplyRandomInspiration: boolean;
    onPickRandomInspiration: () => string;
    isLoading: boolean;
    showLoadingState?: boolean;
    isActive: boolean;
    currentMode: WorkbenchMode;
    onModeChange: (mode: WorkbenchMode) => void;
    reuseContext: WorkbenchReuseContext | null;
    onClearReuseContext: () => void;
    isPasswordRequiredByBackend: boolean | null;
    clientPasswordHash: string | null;
    onOpenPasswordDialog: () => void;
    model: GenerationFormData['model'];
    modelOptions?: readonly string[];
    setModel: React.Dispatch<React.SetStateAction<GenerationFormData['model']>>;
    prompt: string;
    setPrompt: React.Dispatch<React.SetStateAction<string>>;
    batchPromptText: string;
    setBatchPromptText: React.Dispatch<React.SetStateAction<string>>;
    failedBatchPrompts?: string[];
    canPauseBatch?: boolean;
    isBatchPauseRequested?: boolean;
    onPauseBatch?: () => void;
    n: number[];
    setN: React.Dispatch<React.SetStateAction<number[]>>;
    size: GenerationFormData['size'];
    setSize: React.Dispatch<React.SetStateAction<GenerationFormData['size']>>;
    customWidth: number;
    setCustomWidth: React.Dispatch<React.SetStateAction<number>>;
    customHeight: number;
    setCustomHeight: React.Dispatch<React.SetStateAction<number>>;
    quality: GenerationFormData['quality'];
    setQuality: React.Dispatch<React.SetStateAction<GenerationFormData['quality']>>;
    outputFormat: GenerationFormData['output_format'];
    setOutputFormat: React.Dispatch<React.SetStateAction<GenerationFormData['output_format']>>;
    compression: number[];
    setCompression: React.Dispatch<React.SetStateAction<number[]>>;
    background: GenerationFormData['background'];
    setBackground: React.Dispatch<React.SetStateAction<GenerationFormData['background']>>;
    upstreamProfile: ImageUpstreamProfile;
    upstreamProfileMixed?: boolean;
    defaultImageBackend?: ImageGenerationBackend;
    moderation: GenerationFormData['moderation'];
    setModeration: React.Dispatch<React.SetStateAction<GenerationFormData['moderation']>>;
    streamMode: ImageStreamMode;
    setStreamMode: React.Dispatch<React.SetStateAction<ImageStreamMode>>;
    allowStreamingBatch: boolean;
    enableParallelBatch: boolean;
    setEnableParallelBatch: React.Dispatch<React.SetStateAction<boolean>>;
    partialImages: PartialImagesCount;
    setPartialImages: React.Dispatch<React.SetStateAction<PartialImagesCount>>;
    allowResponsesImageBackend: boolean;
    hasDefaultResponsesModel: boolean;
    imageBackend: GenerationFormData['image_backend'];
    setImageBackend: React.Dispatch<React.SetStateAction<GenerationFormData['image_backend']>>;
    streamingStrategy: GenerationFormData['streaming_strategy'];
    defaultStreamingStrategy: ImageStreamingStrategy;
    setStreamingStrategy: React.Dispatch<React.SetStateAction<GenerationFormData['streaming_strategy']>>;
    responsesModel: string;
    setResponsesModel: React.Dispatch<React.SetStateAction<string>>;
    thinking: GenerationFormData['thinking'];
    setThinking: React.Dispatch<React.SetStateAction<GenerationFormData['thinking']>>;
    promptOptimization: GenerationFormData['promptOptimization'];
    setPromptOptimization: React.Dispatch<React.SetStateAction<GenerationFormData['promptOptimization']>>;
    forceWeb: boolean;
    setForceWeb: React.Dispatch<React.SetStateAction<boolean>>;
    requestSummaryLabel: string;
    defaultAdvancedOpen?: boolean;
    defaultAdvancedTab?: AdvancedTab;
};

type AdvancedTab = 'output' | 'model' | 'stream' | 'route';

const compactSettingRowClass =
    'space-y-1.5 lg:grid lg:grid-cols-[3.4rem_minmax(0,1fr)] lg:items-center lg:gap-1.5 lg:space-y-0';
const compactSettingLabelClass = 'text-muted-foreground text-xs lg:pt-0.5';

function getSizePresetLabel(
    preset: SizePreset,
    t: (key: string, values?: Record<string, string | number>) => string
): string {
    switch (preset) {
        case 'auto':
            return t('common.auto');
        case 'custom':
            return t('common.custom');
        case 'square':
            return t('common.square');
        case 'landscape':
            return t('common.landscape');
        case 'portrait':
            return t('common.portrait');
        case 'square-1k':
            return '1K';
        case 'square-2k':
            return '2K';
        case 'square-4k':
            return '4K';
        case 'wide-4k':
            return '16:9';
        case 'tall-4k':
            return '9:16';
    }
}

function getSizePresetIcon(preset: SizePreset): React.ElementType {
    switch (preset) {
        case 'auto':
            return Sparkles;
        case 'custom':
            return SquareDashed;
        case 'landscape':
        case 'wide-4k':
            return RectangleHorizontal;
        case 'portrait':
        case 'tall-4k':
            return RectangleVertical;
        default:
            return Square;
    }
}

export function resolveGenerationFooterPromptTarget(input: {
    currentMode: WorkbenchMode;
    prompt: string;
    batchPromptText: string;
}): { value: string; isEmpty: boolean } {
    const value = input.currentMode === 'batch' ? input.batchPromptText : input.prompt;
    return {
        value,
        isEmpty: value.trim().length === 0
    };
}

const RadioItemWithIcon = ({
    value,
    id,
    label,
    Icon,
    disabled = false,
    tooltip
}: {
    value: string;
    id: string;
    label: string;
    Icon: React.ElementType;
    disabled?: boolean;
    tooltip?: React.ReactNode;
}) => {
    const item = (
        <RadioGroupItem
            value={value}
            id={id}
            disabled={disabled}
            aria-label={label}
            className='border-border bg-background/58 text-muted-foreground enabled:hover:border-primary/25 enabled:hover:bg-accent/45 enabled:hover:text-foreground data-[state=checked]:border-primary/55 data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary flex aspect-auto h-auto min-h-11 w-full flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 text-xs shadow-none transition-[background-color,border-color,color,box-shadow,transform] enabled:active:translate-y-0 enabled:motion-safe:hover:-translate-y-0.5 enabled:motion-safe:hover:scale-100 enabled:motion-safe:active:scale-100 lg:min-h-9 lg:flex-row lg:px-1.5 lg:text-xs [&_[data-slot=radio-group-indicator]]:hidden [&_[data-slot=radio-group-item-content]]:max-w-full [&_[data-slot=radio-group-item-content]]:min-w-0 [&_[data-slot=radio-group-item-content]]:justify-center [&_[data-slot=radio-group-item-content]]:gap-1 [&_[data-slot=radio-group-item-content]]:overflow-hidden lg:[&_[data-slot=radio-group-item-content]]:gap-1'>
            <Icon className='h-3 w-3 shrink-0 text-current opacity-50 lg:hidden' />
            <span className='max-w-full min-w-0 text-center leading-4 break-words whitespace-normal'>{label}</span>
        </RadioGroupItem>
    );

    if (!tooltip) return item;

    return (
        <Tooltip>
            <TooltipTrigger asChild>{item}</TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
    );
};

function readConcreteSize(input: {
    size: SizePreset;
    model: GptImageModel;
    customWidth: number;
    customHeight: number;
}): { width: number; height: number } | null {
    if (input.size === 'custom') {
        return { width: input.customWidth, height: input.customHeight };
    }
    const preset = getPresetDimensions(input.size, input.model);
    if (!preset) return null;
    const [width, height] = preset.split('x').map(Number);
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

function getBackendLabel(backend: GenerationFormData['image_backend'], t: (key: string) => string): string {
    if (backend === 'images-api') return t('upstream.backendImages');
    if (backend === 'responses-image-generation') return t('upstream.backendResponses');
    return t('upstream.serverDefault');
}

function getWorkbenchBackendLabel(backend: GenerationFormData['image_backend'], t: (key: string) => string): string {
    if (backend === 'images-api') return t('upstream.backendImages');
    if (backend === 'responses-image-generation') return t('upstream.backendResponses');
    return t('upstream.workbenchDefaultRoute');
}

function getStreamModeLabel(streamMode: ImageStreamMode, t: (key: string) => string): string {
    if (streamMode === 'stream') return t('streaming.modeStream');
    if (streamMode === 'non_stream') return t('streaming.modeNonStream');
    return t('streaming.modeAuto');
}

export function GenerationForm({
    onSubmit,
    onSaveInspiration,
    canApplyRandomInspiration,
    onPickRandomInspiration,
    isLoading,
    showLoadingState = isLoading,
    isActive,
    currentMode,
    onModeChange,
    reuseContext,
    onClearReuseContext,
    isPasswordRequiredByBackend,
    clientPasswordHash,
    onOpenPasswordDialog,
    model,
    modelOptions,
    setModel,
    prompt,
    setPrompt,
    batchPromptText,
    setBatchPromptText,
    failedBatchPrompts = [],
    canPauseBatch = false,
    isBatchPauseRequested = false,
    onPauseBatch,
    n,
    setN,
    size,
    setSize,
    customWidth,
    setCustomWidth,
    customHeight,
    setCustomHeight,
    quality,
    setQuality,
    outputFormat,
    setOutputFormat,
    compression,
    setCompression,
    background,
    setBackground,
    upstreamProfile,
    upstreamProfileMixed = false,
    defaultImageBackend,
    moderation,
    setModeration,
    streamMode,
    setStreamMode,
    allowStreamingBatch,
    enableParallelBatch,
    setEnableParallelBatch,
    partialImages,
    setPartialImages,
    allowResponsesImageBackend,
    hasDefaultResponsesModel,
    imageBackend,
    setImageBackend,
    streamingStrategy,
    defaultStreamingStrategy,
    setStreamingStrategy,
    responsesModel,
    setResponsesModel,
    thinking,
    setThinking,
    promptOptimization,
    setPromptOptimization,
    forceWeb,
    setForceWeb,
    requestSummaryLabel,
    defaultAdvancedOpen = false,
    defaultAdvancedTab = 'output'
}: GenerationFormProps) {
    const { locale, t } = useI18n();
    const showCompression = outputFormat === 'jpeg' || outputFormat === 'webp';
    const supportsCustomSize = supportsCustomImageSize(model);
    const usesPositiveIntegerCustomSize = shouldUsePositiveIntegerImageSize(model, upstreamProfile);
    const customSizeValidation =
        size === 'custom'
            ? usesPositiveIntegerCustomSize
                ? validatePositiveIntegerImageSize(customWidth, customHeight)
                : validateGptImage2Size(customWidth, customHeight)
            : { valid: true as const };
    const customSizeInvalid = size === 'custom' && !customSizeValidation.valid;
    const customPixelCount = formatExactImagePixelCount(customWidth, customHeight, locale);
    const customRatio = customPixelCount
        ? t('form.ratio', {
              ratio: (Math.max(customWidth, customHeight) / Math.min(customWidth, customHeight)).toFixed(2)
          })
        : t('form.noRatio');
    const customSizeError = customSizeValidation.valid
        ? null
        : t(customSizeValidation.reasonKey, customSizeValidation.values);

    const effectiveStreamingStrategy = resolveImageUpstreamEffectiveStreamingStrategy({
        streamingStrategy,
        defaultStreamingStrategy
    });
    const streamingDisabledByStrategy = effectiveStreamingStrategy === 'off';
    const concreteSize = readConcreteSize({ size, model, customWidth, customHeight });
    const recommendStreaming = Boolean(
        isActive &&
        concreteSize &&
        shouldRecommendImageStreaming({
            streamingStrategy: effectiveStreamingStrategy,
            quality,
            width: concreteSize.width,
            height: concreteSize.height,
            streamEnabled: streamMode !== 'non_stream'
        })
    );
    const [isAdvancedOpen, setIsAdvancedOpen] = React.useState(defaultAdvancedOpen);
    const [advancedTab, setAdvancedTab] = React.useState<AdvancedTab>(defaultAdvancedTab);
    const isBatchMode = currentMode === 'batch';
    const isReuseMode = currentMode === 'reuse';
    const batchPrompts = React.useMemo(() => readBatchPromptLines(batchPromptText), [batchPromptText]);
    const batchPromptOverLimitIndex = React.useMemo(
        () => findBatchPromptOverLimitIndex(batchPrompts, MAX_PROMPT_LENGTH),
        [batchPrompts]
    );
    const promptOverLimit = prompt.length > MAX_PROMPT_LENGTH;
    const parallelBatchTargetCount = isBatchMode ? batchPrompts.length : n[0];
    const parallelBatchToggle = resolveStreamingBatchToggleState({
        allowStreamingBatch,
        userEnabled: enableParallelBatch,
        targetCount: parallelBatchTargetCount,
        streamMode,
        streamingStrategy: effectiveStreamingStrategy
    });
    const canEnableParallelBatch = parallelBatchToggle.canEnable;
    const parallelBatchChecked = parallelBatchToggle.checked;
    const parallelBatchUnavailableKey = parallelBatchToggle.unavailableReasonKey;
    const hasFailedBatchPrompts = isBatchMode && failedBatchPrompts.length > 0;
    const effectiveImageBackend = resolveImageBackendSelection(imageBackend, defaultImageBackend);
    const responsesBackendUnavailable =
        effectiveImageBackend === 'responses-image-generation' && !allowResponsesImageBackend;
    const requiresResponsesModel =
        effectiveImageBackend === 'responses-image-generation' && !hasDefaultResponsesModel && !responsesModel.trim();
    const backendCompatibility = React.useMemo(
        () => getImageBackendCompatibility(upstreamProfile, 'generate', imageBackend, defaultImageBackend),
        [defaultImageBackend, imageBackend, upstreamProfile]
    );
    const backendCompatibilityMessage = backendCompatibility.compatible
        ? ''
        : backendCompatibility.errors.map((error) => error.message).join(' ');
    const submitDisabledReason = React.useMemo(() => {
        if (isLoading) return '';
        if (isBatchMode && batchPrompts.length === 0) return t('ux.disabledBatchPrompts');
        if (isBatchMode && batchPromptOverLimitIndex !== null) {
            return t('ux.disabledBatchPromptLength', {
                index: batchPromptOverLimitIndex + 1,
                limit: MAX_PROMPT_LENGTH
            });
        }
        if (responsesBackendUnavailable) return t('upstream.backendResponsesUnavailable');
        if (backendCompatibilityMessage) return backendCompatibilityMessage;
        if (!isBatchMode && !prompt.trim()) return t('ux.disabledPrompt');
        if (!isBatchMode && promptOverLimit) return t('ux.disabledPromptLength', { limit: MAX_PROMPT_LENGTH });
        if (requiresResponsesModel) return t('upstream.responsesModelRequired');
        if (customSizeInvalid) return customSizeError || t('ux.disabledCustomSize');
        return '';
    }, [
        batchPrompts.length,
        batchPromptOverLimitIndex,
        backendCompatibilityMessage,
        customSizeError,
        customSizeInvalid,
        isBatchMode,
        isLoading,
        responsesBackendUnavailable,
        prompt,
        promptOverLimit,
        requiresResponsesModel,
        t
    ]);
    const advancedSummary = [
        `${t('form.quality')}: ${getImageQualityLabel(quality, t)}`,
        `${t('form.outputFormat')}: ${getImageOutputFormatLabel(outputFormat, t)}`,
        getBackendLabel(imageBackend, t)
    ].join(', ');
    const streamModeLabel = getStreamModeLabel(streamMode, t);
    const streamStatusLabel = getStreamingStatusLabel(streamMode, t);
    const workbenchBackendLabel = getWorkbenchBackendLabel(imageBackend, t);
    const sizePresetOptions = getSizePresetOptions({ model, upstreamProfile });
    const partialImagesRange = React.useMemo(
        () => backendCompatibility.partialImagesRange ?? { min: 1, max: 3 },
        [backendCompatibility.partialImagesRange]
    );
    const partialImageOptions = buildIntegerRangeOptions(partialImagesRange) as PartialImagesCount[];
    const generationCountRange = React.useMemo(
        () => backendCompatibility.imageCountRange ?? { min: 1, max: 1 },
        [backendCompatibility.imageCountRange]
    );
    const generationCountOptions = buildIntegerRangeOptions(generationCountRange);
    const footerPromptTarget = resolveGenerationFooterPromptTarget({
        currentMode,
        prompt,
        batchPromptText
    });

    React.useEffect(() => {
        if (isActive && (partialImages < partialImagesRange.min || partialImages > partialImagesRange.max)) {
            setPartialImages(clampIntegerToRange(partialImages, partialImagesRange) as PartialImagesCount);
        }
        if (isActive && (n[0] < generationCountRange.min || n[0] > generationCountRange.max)) {
            setN([clampIntegerToRange(n[0], generationCountRange)]);
        }
        if (isActive && background === 'transparent' && !upstreamProfile.gptImage2.allowTransparentBackground) {
            setBackground('auto');
        }
    }, [
        background,
        isActive,
        n,
        generationCountRange,
        partialImages,
        partialImagesRange,
        setBackground,
        setN,
        setPartialImages,
        upstreamProfile.gptImage2.allowTransparentBackground
    ]);

    React.useEffect(() => {
        if (isActive && streamingDisabledByStrategy && streamMode !== 'non_stream') {
            setStreamMode('non_stream');
        }
    }, [isActive, streamingDisabledByStrategy, streamMode, setStreamMode]);

    // 旧版模型只支持预设尺寸；provider-defined 模型保留自定义尺寸语义。
    React.useEffect(() => {
        if (isActive && !supportsCustomSize && size === 'custom') {
            setSize('auto');
        }
    }, [isActive, setSize, size, supportsCustomSize]);

    const handleSubmit = () => {
        if (isBatchMode && batchPromptOverLimitIndex !== null) {
            return;
        }
        if (!isBatchMode && promptOverLimit) {
            return;
        }
        if (customSizeInvalid) {
            return;
        }
        if (partialImages < partialImagesRange.min || partialImages > partialImagesRange.max) {
            setPartialImages(clampIntegerToRange(partialImages, partialImagesRange) as PartialImagesCount);
            return;
        }
        if (n[0] < generationCountRange.min || n[0] > generationCountRange.max) {
            setN([clampIntegerToRange(n[0], generationCountRange)]);
            return;
        }
        if (background === 'transparent' && !upstreamProfile.gptImage2.allowTransparentBackground) {
            setBackground('auto');
            return;
        }
        const formData: GenerationFormData = {
            prompt: isBatchMode && batchPrompts.length > 0 ? batchPrompts[0] : prompt,
            n: n[0],
            size,
            customWidth,
            customHeight,
            quality,
            output_format: outputFormat,
            background,
            moderation,
            model,
            image_backend: imageBackend,
            streaming_strategy: streamingStrategy,
            responsesModel,
            thinking,
            promptOptimization,
            forceWeb,
            enableParallelBatch: parallelBatchChecked
        };
        if (isBatchMode) {
            formData.batchPrompts = batchPrompts;
        }
        if (showCompression) {
            formData.output_compression = compression[0];
        }
        onSubmit(formData);
    };

    const reuseFailedBatchPrompts = () => {
        setBatchPromptText(failedBatchPrompts.join('\n'));
    };

    return (
        <Card className='mobile-drawer-form-card workbench-panel text-card-foreground border-border flex min-h-0 w-full flex-1 flex-col gap-0 overflow-hidden rounded-lg border py-0 lg:h-full'>
            <CardHeader className='border-border/70 shrink-0 border-b px-3 pt-2 !pb-2'>
                <ModeToggle currentMode={currentMode} onModeChange={onModeChange} />
            </CardHeader>
            <div className='mobile-drawer-form-frame flex min-h-0 flex-1 flex-col overflow-hidden'>
                <CardContent className='mobile-drawer-form-content literary-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4 pb-4 lg:px-5 lg:py-3 2xl:space-y-2.5'>
                    <div className='flex items-center'>
                        <CardTitle className='editorial-title py-0.5 text-xl font-semibold'>
                            {t('workbench.creationSheet')}
                        </CardTitle>
                        {isPasswordRequiredByBackend && (
                            <Button
                                variant='ghost'
                                size='sm'
                                onClick={onOpenPasswordDialog}
                                className='text-muted-foreground hover:text-foreground ml-auto min-h-11 min-w-11 px-2 lg:min-h-7 lg:min-w-0'
                                aria-label={t('password.configure')}>
                                {clientPasswordHash ? <Lock className='h-4 w-4' /> : <LockOpen className='h-4 w-4' />}
                            </Button>
                        )}
                    </div>
                    <div className='space-y-1.5 lg:space-y-1'>
                        {!isBatchMode && (
                            <>
                                <div className='flex items-center'>
                                    <Label htmlFor='prompt' className='text-foreground text-sm font-medium'>
                                        {t('workbench.promptTitle')}
                                    </Label>
                                    {prompt.trim() && (
                                        <button
                                            type='button'
                                            onClick={() => setPrompt('')}
                                            disabled={isLoading}
                                            className='text-muted-foreground hover:text-foreground focus-visible:ring-ring -mr-2 ml-auto min-h-11 min-w-11 rounded-md px-2 text-xs transition-[color,box-shadow] focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 lg:mr-0 lg:min-h-7 lg:min-w-0 lg:px-0'>
                                            {t('common.clear')}
                                        </button>
                                    )}
                                </div>
                                <div className='relative'>
                                    <Textarea
                                        id='prompt'
                                        name='prompt'
                                        placeholder={t('form.promptPlaceholder')}
                                        value={prompt}
                                        onChange={(e) => setPrompt(e.target.value)}
                                        maxLength={MAX_PROMPT_LENGTH}
                                        required
                                        disabled={isLoading}
                                        className='bg-muted/45 min-h-[104px] rounded-md px-4 py-3 pb-8 leading-6 shadow-inner lg:min-h-[92px]'
                                    />
                                    <span className='text-muted-foreground ui-stat pointer-events-none absolute bottom-3 left-4 text-xs'>
                                        {prompt.length.toLocaleString(locale)} /{' '}
                                        {MAX_PROMPT_LENGTH.toLocaleString(locale)}
                                    </span>
                                </div>
                            </>
                        )}
                        {recommendStreaming && !isBatchMode && (
                            <p className='text-xs text-amber-700 dark:text-amber-300'>
                                {t('streaming.highResolutionRecommendation')}
                            </p>
                        )}
                        {isReuseMode && (
                            <div className='border-primary/25 bg-primary/5 rounded-md border px-3 py-2 text-xs leading-5 shadow-sm'>
                                {reuseContext ? (
                                    <div className='space-y-2'>
                                        <div className='flex items-start justify-between gap-3'>
                                            <div className='min-w-0'>
                                                <p className='text-foreground font-medium'>{t('reuse.appliedTitle')}</p>
                                                <p className='text-muted-foreground truncate'>
                                                    {reuseContext.sourceLabel}
                                                </p>
                                            </div>
                                            <button
                                                type='button'
                                                onClick={onClearReuseContext}
                                                disabled={isLoading}
                                                className='text-muted-foreground hover:text-foreground focus-visible:ring-ring -mr-2 min-h-11 shrink-0 rounded-md px-2 transition-[color,box-shadow] focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 lg:mr-0 lg:min-h-7 lg:px-0'>
                                                {t('common.clear')}
                                            </button>
                                        </div>
                                        <div className='flex flex-wrap gap-1'>
                                            {reuseContext.restoredFields.map((field) => (
                                                <span
                                                    key={field}
                                                    className='border-primary/20 bg-background/70 text-primary rounded-full border px-2 py-0.5'>
                                                    {field}
                                                </span>
                                            ))}
                                        </div>
                                        <p className='text-muted-foreground max-h-10 overflow-hidden break-words'>
                                            {reuseContext.promptPreview}
                                        </p>
                                    </div>
                                ) : (
                                    <p className='text-muted-foreground'>{t('mode.reuseHint')}</p>
                                )}
                            </div>
                        )}
                        {isBatchMode && (
                            <div className='border-border/75 bg-background/65 space-y-2 rounded-md border p-3 shadow-sm'>
                                <div className='flex items-center justify-between gap-3'>
                                    <Label htmlFor='batch-prompt-list'>{t('batch.promptList')}</Label>
                                    <span className='text-muted-foreground ui-stat shrink-0 text-xs'>
                                        {t('batch.promptCount', { count: batchPrompts.length })}
                                    </span>
                                </div>
                                <Textarea
                                    id='batch-prompt-list'
                                    name='batchPrompts'
                                    value={batchPromptText}
                                    onChange={(event) => setBatchPromptText(event.target.value)}
                                    aria-describedby='batch-prompt-length-hint'
                                    disabled={isLoading}
                                    className='bg-muted/45 min-h-[132px] rounded-md px-3 py-2 leading-6 shadow-inner'
                                    placeholder={t('batch.promptPlaceholder')}
                                />
                                <p id='batch-prompt-length-hint' className='text-muted-foreground text-xs'>
                                    {t('batch.promptLengthHint', { limit: MAX_PROMPT_LENGTH })}
                                </p>
                                {hasFailedBatchPrompts && (
                                    <div className='border-destructive/25 bg-destructive/5 text-muted-foreground flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs leading-5'>
                                        <span>
                                            {t('batch.failedReuseHint', {
                                                count: failedBatchPrompts.length
                                            })}
                                        </span>
                                        <Button
                                            type='button'
                                            variant='outline'
                                            size='sm'
                                            onClick={reuseFailedBatchPrompts}
                                            disabled={isLoading}
                                            className='bg-background/80 min-h-11 px-3 text-xs lg:h-7 lg:min-h-0 lg:px-2'>
                                            <RotateCcw className='mr-1.5 h-3.5 w-3.5' />
                                            {t('batch.reuseFailed')}
                                        </Button>
                                    </div>
                                )}
                                <div
                                    id='batch-task-summary'
                                    className='border-border/60 grid gap-2 border-t pt-2 text-xs leading-5 sm:grid-cols-2'>
                                    <div className='flex gap-2'>
                                        <ListChecks className='text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0' />
                                        <div className='min-w-0'>
                                            <div className='text-foreground font-medium'>{t('batch.summaryTitle')}</div>
                                            <p className='text-muted-foreground'>{t('batch.summaryPerLine')}</p>
                                        </div>
                                    </div>
                                    <div className='flex gap-2'>
                                        <RotateCcw className='text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0' />
                                        <div className='min-w-0'>
                                            <div className='text-foreground font-medium'>
                                                {t('batch.summaryFailureTitle')}
                                            </div>
                                            <p className='text-muted-foreground'>{t('batch.summaryFailureDetail')}</p>
                                        </div>
                                    </div>
                                    <p className='text-muted-foreground sm:col-span-2'>{t('batch.summaryProgress')}</p>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className='border-border/70 space-y-2 border-t pt-2'>
                        <div className='text-foreground block text-sm leading-none font-medium select-none'>
                            {t('workbench.basicSettings')}
                        </div>
                        <div className={compactSettingRowClass}>
                            <div className={compactSettingLabelClass}>{t('form.size')}</div>
                            <RadioGroup
                                value={size}
                                onValueChange={(value) => setSize(value as GenerationFormData['size'])}
                                disabled={isLoading}
                                name='size'
                                aria-label={t('form.size')}
                                className='grid grid-cols-2 gap-1.5'>
                                {sizePresetOptions.map((option) => (
                                    <RadioItemWithIcon
                                        key={option.value}
                                        value={option.value}
                                        id={`size-${option.value}`}
                                        label={getSizePresetLabel(option.value, t)}
                                        Icon={getSizePresetIcon(option.value)}
                                        disabled={isLoading}
                                        tooltip={getPresetTooltip(option.value, model)}
                                    />
                                ))}
                            </RadioGroup>
                        </div>
                        {supportsCustomSize && size === 'custom' && (
                            <div className='bg-muted/30 border-border space-y-2 rounded-md border p-3'>
                                <div className='flex items-center gap-3'>
                                    <div className='flex-1 space-y-1'>
                                        <Label htmlFor='custom-width' className='text-muted-foreground text-xs'>
                                            {t('form.width')}
                                        </Label>
                                        <Input
                                            id='custom-width'
                                            name='customWidth'
                                            type='number'
                                            inputMode='numeric'
                                            min={usesPositiveIntegerCustomSize ? 1 : 16}
                                            max={usesPositiveIntegerCustomSize ? undefined : 3840}
                                            step={usesPositiveIntegerCustomSize ? 1 : 16}
                                            value={customWidth}
                                            onChange={(e) => setCustomWidth(readImageSizeNumberInput(e.target.value))}
                                            disabled={isLoading}
                                        />
                                    </div>
                                    <span className='text-muted-foreground pt-5'>x</span>
                                    <div className='flex-1 space-y-1'>
                                        <Label htmlFor='custom-height' className='text-muted-foreground text-xs'>
                                            {t('form.height')}
                                        </Label>
                                        <Input
                                            id='custom-height'
                                            name='customHeight'
                                            type='number'
                                            inputMode='numeric'
                                            min={usesPositiveIntegerCustomSize ? 1 : 16}
                                            max={usesPositiveIntegerCustomSize ? undefined : 3840}
                                            step={usesPositiveIntegerCustomSize ? 1 : 16}
                                            value={customHeight}
                                            onChange={(e) => setCustomHeight(readImageSizeNumberInput(e.target.value))}
                                            disabled={isLoading}
                                        />
                                    </div>
                                </div>
                                <p className='text-muted-foreground ui-stat text-xs'>
                                    {customPixelCount
                                        ? t(
                                              usesPositiveIntegerCustomSize
                                                  ? 'form.pixelsMeta'
                                                  : 'form.pixelsMetaOfMaximum',
                                              {
                                                  pixels: customPixelCount,
                                                  percent: (((customWidth * customHeight) / 8_294_400) * 100).toFixed(
                                                      1
                                                  ),
                                                  ratio: customRatio
                                              }
                                          )
                                        : t('form.pixelsUnavailable')}
                                </p>
                                {customSizeError && <p className='text-destructive text-xs'>{customSizeError}</p>}
                                <p className='text-muted-foreground text-xs'>{t('form.customConstraints')}</p>
                            </div>
                        )}

                        <div className={compactSettingRowClass}>
                            <div className={cn(compactSettingLabelClass, 'ui-stat')}>
                                {isBatchMode
                                    ? t('form.batchNumberOfImages', { count: batchPrompts.length })
                                    : t('form.numberOfImages', { count: n[0] })}
                            </div>
                            {isBatchMode ? (
                                <div className='border-border bg-muted/25 text-muted-foreground rounded-md border px-3 py-2 text-xs leading-5'>
                                    {t('mode.batchHint')}
                                </div>
                            ) : (
                                <RadioGroup
                                    value={String(n[0])}
                                    onValueChange={(value) => setN([Number(value)])}
                                    disabled={isLoading}
                                    name='n'
                                    aria-label={t('form.numberOfImages', { count: n[0] })}
                                    className='grid grid-cols-4 gap-1.5'>
                                    {generationCountOptions.map((value) => (
                                        <RadioItemWithIcon
                                            key={value}
                                            value={String(value)}
                                            id={`n-${value}`}
                                            label={String(value)}
                                            Icon={value === 1 ? Tally1 : value === 2 ? Tally2 : Tally3}
                                            disabled={isLoading}
                                        />
                                    ))}
                                </RadioGroup>
                            )}
                        </div>

                        <div className={compactSettingRowClass}>
                            <div className={compactSettingLabelClass}>{t('form.quality')}</div>
                            <RadioGroup
                                value={quality}
                                onValueChange={(value) => setQuality(value as GenerationFormData['quality'])}
                                disabled={isLoading}
                                name='quality'
                                aria-label={t('form.quality')}
                                className='grid grid-cols-3 gap-1.5'>
                                <RadioItemWithIcon
                                    value='medium'
                                    id='quality-medium-quick'
                                    label={t('common.standard')}
                                    Icon={Tally1}
                                    disabled={isLoading}
                                />
                                <RadioItemWithIcon
                                    value='high'
                                    id='quality-high-quick'
                                    label={t('common.high')}
                                    Icon={Tally2}
                                    disabled={isLoading}
                                />
                                <RadioItemWithIcon
                                    value='auto'
                                    id='quality-auto-quick'
                                    label={t('common.auto')}
                                    Icon={Sparkles}
                                    disabled={isLoading}
                                />
                            </RadioGroup>
                        </div>

                        <div className={compactSettingRowClass}>
                            <div className={compactSettingLabelClass}>{t('form.outputFormat')}</div>
                            <RadioGroup
                                value={outputFormat}
                                onValueChange={(value) => setOutputFormat(value as GenerationFormData['output_format'])}
                                disabled={isLoading}
                                name='output_format'
                                aria-label={t('form.outputFormat')}
                                className='grid grid-cols-3 gap-1.5'>
                                <RadioItemWithIcon
                                    value='jpeg'
                                    id='format-jpeg-quick'
                                    label={t('common.jpeg')}
                                    Icon={FileImage}
                                    disabled={isLoading}
                                />
                                <RadioItemWithIcon
                                    value='png'
                                    id='format-png-quick'
                                    label={t('common.png')}
                                    Icon={FileImage}
                                    disabled={isLoading}
                                />
                                <RadioItemWithIcon
                                    value='webp'
                                    id='format-webp-quick'
                                    label={t('common.webp')}
                                    Icon={FileImage}
                                    disabled={isLoading}
                                />
                            </RadioGroup>
                        </div>
                    </div>

                    <div className='border-border bg-muted/20 rounded-md border'>
                        <button
                            type='button'
                            onClick={() => setIsAdvancedOpen((open) => !open)}
                            className='text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-3 text-left text-sm font-medium transition-[background-color,color,transform] focus-visible:ring-2 focus-visible:outline-none active:scale-[0.995]'
                            aria-expanded={isAdvancedOpen}
                            aria-controls='generation-advanced-panel'>
                            <span className='flex min-w-0 items-center gap-2'>
                                <SlidersHorizontal className='h-4 w-4 shrink-0' />
                                <span className='min-w-0'>
                                    <span className='text-foreground block'>
                                        {isAdvancedOpen ? t('ux.professionalMode') : t('ux.easyMode')}
                                    </span>
                                    <span className='text-muted-foreground block text-xs leading-4 font-normal'>
                                        {isAdvancedOpen ? advancedSummary : t('ux.easyModeSummary')}
                                    </span>
                                </span>
                            </span>
                            <ChevronDown
                                className={`h-4 w-4 shrink-0 transition-transform ${isAdvancedOpen ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {isAdvancedOpen && (
                            <div id='generation-advanced-panel' className='border-border border-t p-3'>
                                <Tabs
                                    value={advancedTab}
                                    onValueChange={(value) => setAdvancedTab(value as AdvancedTab)}
                                    className='gap-3'>
                                    <TabsList className='grid h-auto w-full grid-cols-4 rounded-md'>
                                        <TabsTrigger value='output' className='min-h-11 lg:min-h-9'>
                                            {t('ux.output')}
                                        </TabsTrigger>
                                        <TabsTrigger value='model' className='min-h-11 lg:min-h-9'>
                                            {t('ux.modelRoute')}
                                        </TabsTrigger>
                                        <TabsTrigger value='stream' className='min-h-11 lg:min-h-9'>
                                            {t('ux.streaming')}
                                        </TabsTrigger>
                                        <TabsTrigger value='route' className='min-h-11 lg:min-h-9'>
                                            {t('ux.route')}
                                        </TabsTrigger>
                                    </TabsList>
                                    <TabsContent value='model' className='space-y-5'>
                                        <div className='space-y-1.5'>
                                            <Label htmlFor='model-select'>{t('form.model')}</Label>
                                            <Select
                                                value={model}
                                                onValueChange={(value) =>
                                                    setModel(value as GenerationFormData['model'])
                                                }
                                                disabled={isLoading}
                                                name='model'>
                                                <SelectTrigger id='model-select' className='min-h-11 w-full lg:min-h-9'>
                                                    <SelectValue placeholder={t('form.selectModel')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {(modelOptions ?? DEFAULT_MODEL_OPTIONS).map((modelId) => (
                                                        <SelectItem key={modelId} value={modelId}>
                                                            {modelId}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </TabsContent>
                                    <TabsContent value='route' className='space-y-5'>
                                        <div className='grid gap-3 sm:grid-cols-2'>
                                            <div className='space-y-1.5'>
                                                <Label htmlFor='image-backend-select'>{t('upstream.backend')}</Label>
                                                <Select
                                                    value={imageBackend}
                                                    onValueChange={(value) =>
                                                        setImageBackend(value as GenerationFormData['image_backend'])
                                                    }
                                                    disabled={isLoading}
                                                    name='image_backend'>
                                                    <SelectTrigger
                                                        id='image-backend-select'
                                                        className='min-h-11 lg:min-h-9'>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value='images-api'>
                                                            {t('upstream.backendImages')}
                                                        </SelectItem>
                                                        <SelectItem
                                                            value='responses-image-generation'
                                                            disabled={!allowResponsesImageBackend}>
                                                            {t('upstream.backendResponses')}
                                                        </SelectItem>
                                                        <SelectItem value='server-default'>
                                                            {t('upstream.serverDefault')}
                                                        </SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className='space-y-1.5'>
                                                <Label htmlFor='streaming-strategy-select'>
                                                    {t('upstream.streamingStrategy')}
                                                </Label>
                                                <Select
                                                    value={streamingStrategy}
                                                    onValueChange={(value) =>
                                                        setStreamingStrategy(
                                                            value as GenerationFormData['streaming_strategy']
                                                        )
                                                    }
                                                    disabled={isLoading}
                                                    name='image_streaming_strategy'>
                                                    <SelectTrigger
                                                        id='streaming-strategy-select'
                                                        className='min-h-11 lg:min-h-9'>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value='auto'>
                                                            {t('upstream.strategyAuto')}
                                                        </SelectItem>
                                                        <SelectItem value='off'>{t('upstream.strategyOff')}</SelectItem>
                                                        <SelectItem
                                                            value='openai-sse'
                                                            disabled={
                                                                !isImageUpstreamStreamingStrategySelectable({
                                                                    imageBackend,
                                                                    streamingStrategy: 'openai-sse',
                                                                    allowResponsesImageBackend
                                                                })
                                                            }>
                                                            {t('upstream.strategyOpenAiSse')}
                                                        </SelectItem>
                                                        <SelectItem
                                                            value='newapi-keepalive-sse'
                                                            disabled={
                                                                !isImageUpstreamStreamingStrategySelectable({
                                                                    imageBackend,
                                                                    streamingStrategy: 'newapi-keepalive-sse',
                                                                    allowResponsesImageBackend
                                                                })
                                                            }>
                                                            {t('upstream.strategyKeepaliveSse')}
                                                        </SelectItem>
                                                        <SelectItem
                                                            value='responses-sse'
                                                            disabled={
                                                                !isImageUpstreamStreamingStrategySelectable({
                                                                    imageBackend,
                                                                    streamingStrategy: 'responses-sse',
                                                                    allowResponsesImageBackend
                                                                })
                                                            }>
                                                            {t('upstream.strategyResponsesSse')}
                                                        </SelectItem>
                                                        <SelectItem value='force-sse'>
                                                            {t('upstream.strategyForceSse')}
                                                        </SelectItem>
                                                        <SelectItem value='server-default'>
                                                            {t('upstream.serverDefault')}
                                                        </SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        </div>
                                        <div className='border-border bg-muted/20 text-muted-foreground space-y-1.5 rounded-md border p-3 text-xs leading-5'>
                                            <div className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                                <ShieldAlert className='text-muted-foreground h-4 w-4' />
                                                {t('upstream.routeImpactTitle')}
                                            </div>
                                            {getImageUpstreamRouteImpactKeys({
                                                backend: imageBackend,
                                                streamingStrategy,
                                                defaultStreamingStrategy,
                                                allowResponsesImageBackend,
                                                serverProfileMixed: upstreamProfileMixed
                                            }).map((key) => (
                                                <p key={key}>{t(key)}</p>
                                            ))}
                                        </div>

                                        {imageBackend === 'responses-image-generation' && (
                                            <div className='border-border bg-muted/20 space-y-3 rounded-md border p-3'>
                                                <div className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                                    <WandSparkles className='text-muted-foreground h-4 w-4' />
                                                    {t('upstream.compatibilityParams')}
                                                </div>
                                                <div className='grid gap-3 sm:grid-cols-2'>
                                                    <div className='space-y-1.5 sm:col-span-2'>
                                                        <Label htmlFor='responses-model-input'>
                                                            {t('upstream.gptModel')}
                                                        </Label>
                                                        <Input
                                                            id='responses-model-input'
                                                            name='responsesModel'
                                                            value={responsesModel}
                                                            onChange={(event) => setResponsesModel(event.target.value)}
                                                            disabled={isLoading}
                                                            autoComplete='off'
                                                            spellCheck={false}
                                                            placeholder='OPENAI_RESPONSES_API_MODEL'
                                                        />
                                                        {requiresResponsesModel && (
                                                            <p className='text-destructive text-xs'>
                                                                {t('upstream.responsesModelRequired')}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <div className='space-y-1.5'>
                                                        <Label htmlFor='thinking-select'>
                                                            {t('upstream.thinking')}
                                                        </Label>
                                                        <Select
                                                            value={thinking}
                                                            onValueChange={(value) =>
                                                                setThinking(value as GenerationFormData['thinking'])
                                                            }
                                                            disabled={isLoading}
                                                            name='thinking'>
                                                            <SelectTrigger
                                                                id='thinking-select'
                                                                className='min-h-11 lg:min-h-9'>
                                                                <SelectValue />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value='server-default'>
                                                                    {t('upstream.serverDefault')}
                                                                </SelectItem>
                                                                <SelectItem value='none'>
                                                                    {t('upstream.thinkingNone')}
                                                                </SelectItem>
                                                                <SelectItem value='minimal'>
                                                                    {t('upstream.thinkingMinimal')}
                                                                </SelectItem>
                                                                <SelectItem value='low'>
                                                                    {t('upstream.thinkingLow')}
                                                                </SelectItem>
                                                                <SelectItem value='medium'>
                                                                    {t('upstream.thinkingMedium')}
                                                                </SelectItem>
                                                                <SelectItem value='high'>
                                                                    {t('upstream.thinkingHigh')}
                                                                </SelectItem>
                                                                <SelectItem value='xhigh'>
                                                                    {t('upstream.thinkingXhigh')}
                                                                </SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                    <div className='space-y-1.5'>
                                                        <Label htmlFor='prompt-optimization-select'>
                                                            {t('upstream.promptOptimization')}
                                                        </Label>
                                                        <Select
                                                            value={promptOptimization}
                                                            onValueChange={(value) =>
                                                                setPromptOptimization(
                                                                    value as GenerationFormData['promptOptimization']
                                                                )
                                                            }
                                                            disabled={isLoading}
                                                            name='promptOptimization'>
                                                            <SelectTrigger
                                                                id='prompt-optimization-select'
                                                                className='min-h-11 lg:min-h-9'>
                                                                <SelectValue />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value='server-default'>
                                                                    {t('upstream.serverDefault')}
                                                                </SelectItem>
                                                                <SelectItem value='on'>
                                                                    {t('common.enabled')}
                                                                </SelectItem>
                                                                <SelectItem value='off'>
                                                                    {t('common.disabled')}
                                                                </SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {imageBackend === 'images-api' && (
                                            <div className='border-border bg-muted/20 space-y-3 rounded-md border p-3'>
                                                <div className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                                    <Globe2 className='text-muted-foreground h-4 w-4' />
                                                    {t('upstream.compatibilityParams')}
                                                </div>
                                                <RadioGroup
                                                    value={forceWeb ? 'true' : 'false'}
                                                    onValueChange={(value) => setForceWeb(value === 'true')}
                                                    disabled={isLoading}
                                                    name='force_web'
                                                    aria-label={t('upstream.forceWeb')}
                                                    className='grid grid-cols-2 gap-2'>
                                                    <RadioItemWithIcon
                                                        value='false'
                                                        id='force-web-false'
                                                        label={t('upstream.serverDefault')}
                                                        Icon={Sparkles}
                                                        disabled={isLoading}
                                                    />
                                                    <RadioItemWithIcon
                                                        value='true'
                                                        id='force-web-true'
                                                        label={t('upstream.forceWeb')}
                                                        Icon={Globe2}
                                                        disabled={isLoading}
                                                        tooltip={t('upstream.forceWebHint')}
                                                    />
                                                </RadioGroup>
                                            </div>
                                        )}
                                    </TabsContent>
                                    <TabsContent value='stream' className='space-y-5'>
                                        <div className='space-y-1.5'>
                                            <Label htmlFor='stream-mode-select'>{t('streaming.mode')}</Label>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <div>
                                                        <Select
                                                            value={streamMode}
                                                            onValueChange={(value) =>
                                                                setStreamMode(value as ImageStreamMode)
                                                            }
                                                            disabled={isLoading || streamingDisabledByStrategy}
                                                            name='stream_mode'>
                                                            <SelectTrigger
                                                                id='stream-mode-select'
                                                                disabled={isLoading || streamingDisabledByStrategy}
                                                                className='min-h-11 w-full lg:min-h-9'>
                                                                <SelectValue />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value='auto'>
                                                                    {t('streaming.modeAuto')}
                                                                </SelectItem>
                                                                <SelectItem value='stream'>
                                                                    {t('streaming.modeStream')}
                                                                </SelectItem>
                                                                <SelectItem value='non_stream'>
                                                                    {t('streaming.modeNonStream')}
                                                                </SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                </TooltipTrigger>
                                                <TooltipContent className='max-w-[250px]'>
                                                    {streamingDisabledByStrategy
                                                        ? t('streaming.disabledByStrategy')
                                                        : allowStreamingBatch && n[0] > 1 && streamMode !== 'non_stream'
                                                          ? t('streaming.batchDescription')
                                                          : t('streaming.description')}
                                                </TooltipContent>
                                            </Tooltip>
                                        </div>
                                        <div className='border-border bg-muted/20 flex items-start gap-3 rounded-md border p-3'>
                                            <label
                                                htmlFor='parallel-batch-enabled'
                                                className='-m-2 flex min-h-11 min-w-11 cursor-pointer items-start justify-center p-2 has-disabled:cursor-not-allowed'>
                                                <Checkbox
                                                    id='parallel-batch-enabled'
                                                    checked={parallelBatchChecked}
                                                    onCheckedChange={(value) => setEnableParallelBatch(value === true)}
                                                    disabled={isLoading || !canEnableParallelBatch}
                                                    aria-label={t('streaming.parallelBatch')}
                                                    className='mt-0.5'
                                                />
                                            </label>
                                            <div className='grid gap-1'>
                                                <Label
                                                    htmlFor='parallel-batch-enabled'
                                                    className='text-foreground text-sm leading-none font-medium'>
                                                    {t('streaming.parallelBatch')}
                                                </Label>
                                                <p className='text-muted-foreground text-xs leading-5'>
                                                    {canEnableParallelBatch
                                                        ? t('streaming.parallelBatchDescription')
                                                        : t(parallelBatchUnavailableKey)}
                                                </p>
                                            </div>
                                        </div>
                                        {streamMode !== 'non_stream' && (
                                            <div className='space-y-3'>
                                                <div className='flex items-center gap-2'>
                                                    <div className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                                        {t('streaming.previewImages')}
                                                    </div>
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <button
                                                                type='button'
                                                                className='text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent/80 focus-visible:ring-ring -my-2 inline-flex h-11 w-11 cursor-help items-center justify-center rounded-sm transition-[background-color,color,transform] focus-visible:ring-2 focus-visible:outline-none active:scale-95 lg:h-9 lg:w-9'
                                                                aria-label={t('streaming.costHint')}>
                                                                <HelpCircle className='h-4 w-4' />
                                                            </button>
                                                        </TooltipTrigger>
                                                        <TooltipContent className='max-w-[250px]'>
                                                            {t('streaming.costHint')}
                                                        </TooltipContent>
                                                    </Tooltip>
                                                </div>
                                                <RadioGroup
                                                    value={String(partialImages)}
                                                    onValueChange={(value) =>
                                                        setPartialImages(Number(value) as PartialImagesCount)
                                                    }
                                                    disabled={isLoading}
                                                    name='partial_images'
                                                    aria-label={t('streaming.previewImages')}
                                                    className='grid grid-cols-5 gap-2'>
                                                    {partialImageOptions.map((value) => (
                                                        <RadioItemWithIcon
                                                            key={value}
                                                            value={String(value)}
                                                            id={`partial-${value}`}
                                                            label={String(value)}
                                                            Icon={
                                                                value === 0
                                                                    ? CircleOff
                                                                    : value === 1
                                                                      ? Tally1
                                                                      : value === 2
                                                                        ? Tally2
                                                                        : value === 3
                                                                          ? Tally3
                                                                          : Tally4
                                                            }
                                                            disabled={isLoading}
                                                        />
                                                    ))}
                                                </RadioGroup>
                                            </div>
                                        )}
                                        {streamMode === 'non_stream' && (
                                            <div className='border-border bg-muted/20 text-muted-foreground rounded-md border border-dashed p-3 text-sm'>
                                                {streamModeLabel}
                                            </div>
                                        )}
                                    </TabsContent>
                                    <TabsContent value='output' className='space-y-5'>
                                        <div className='space-y-3'>
                                            <div className='text-foreground block text-sm leading-none font-medium select-none'>
                                                {t('form.quality')}
                                            </div>
                                            <RadioGroup
                                                value={quality}
                                                onValueChange={(value) =>
                                                    setQuality(value as GenerationFormData['quality'])
                                                }
                                                disabled={isLoading}
                                                name='quality'
                                                aria-label={t('form.quality')}
                                                className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                                                <RadioItemWithIcon
                                                    value='auto'
                                                    id='quality-auto'
                                                    label={t('common.auto')}
                                                    Icon={Sparkles}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='low'
                                                    id='quality-low'
                                                    label={t('common.low')}
                                                    Icon={Tally1}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='medium'
                                                    id='quality-medium'
                                                    label={t('common.medium')}
                                                    Icon={Tally2}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='high'
                                                    id='quality-high'
                                                    label={t('common.high')}
                                                    Icon={Tally3}
                                                    disabled={isLoading}
                                                />
                                            </RadioGroup>
                                        </div>

                                        <div className='space-y-3'>
                                            <div className='text-foreground block text-sm leading-none font-medium select-none'>
                                                {t('form.background')}
                                            </div>
                                            <RadioGroup
                                                value={background}
                                                onValueChange={(value) =>
                                                    setBackground(value as GenerationFormData['background'])
                                                }
                                                disabled={isLoading}
                                                name='background'
                                                aria-label={t('form.background')}
                                                className='grid grid-cols-1 gap-2 sm:grid-cols-3'>
                                                <RadioItemWithIcon
                                                    value='auto'
                                                    id='bg-auto'
                                                    label={t('common.auto')}
                                                    Icon={Sparkles}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='opaque'
                                                    id='bg-opaque'
                                                    label={t('form.backgroundOpaque')}
                                                    Icon={BrickWall}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='transparent'
                                                    id='bg-transparent'
                                                    label={t('form.backgroundTransparent')}
                                                    Icon={Eraser}
                                                    disabled={
                                                        isLoading ||
                                                        !upstreamProfile.gptImage2.allowTransparentBackground
                                                    }
                                                />
                                            </RadioGroup>
                                        </div>

                                        <div className='space-y-3'>
                                            <div className='text-foreground block text-sm leading-none font-medium select-none'>
                                                {t('form.outputFormat')}
                                            </div>
                                            <RadioGroup
                                                value={outputFormat}
                                                onValueChange={(value) =>
                                                    setOutputFormat(value as GenerationFormData['output_format'])
                                                }
                                                disabled={isLoading}
                                                name='output_format'
                                                aria-label={t('form.outputFormat')}
                                                className='grid grid-cols-1 gap-2 sm:grid-cols-3'>
                                                <RadioItemWithIcon
                                                    value='png'
                                                    id='format-png'
                                                    label={t('common.png')}
                                                    Icon={FileImage}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='jpeg'
                                                    id='format-jpeg'
                                                    label={t('common.jpeg')}
                                                    Icon={FileImage}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='webp'
                                                    id='format-webp'
                                                    label={t('common.webp')}
                                                    Icon={FileImage}
                                                    disabled={isLoading}
                                                />
                                            </RadioGroup>
                                        </div>

                                        {showCompression && (
                                            <div className='space-y-2 pt-2 transition-opacity duration-300'>
                                                <div className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                                    {t('form.compression', { value: compression[0] })}
                                                </div>
                                                <Slider
                                                    id='compression-slider'
                                                    name='output_compression'
                                                    thumbLabel={t('form.compression', { value: compression[0] })}
                                                    min={0}
                                                    max={100}
                                                    step={1}
                                                    value={compression}
                                                    onValueChange={setCompression}
                                                    disabled={isLoading}
                                                    className='mt-3'
                                                />
                                            </div>
                                        )}

                                        <div className='space-y-3'>
                                            <div className='text-foreground block text-sm leading-none font-medium select-none'>
                                                {t('form.moderation')}
                                            </div>
                                            <RadioGroup
                                                value={moderation}
                                                onValueChange={(value) =>
                                                    setModeration(value as GenerationFormData['moderation'])
                                                }
                                                disabled={isLoading}
                                                name='moderation'
                                                aria-label={t('form.moderation')}
                                                className='grid grid-cols-2 gap-2'>
                                                <RadioItemWithIcon
                                                    value='auto'
                                                    id='mod-auto'
                                                    label={t('common.auto')}
                                                    Icon={ShieldCheck}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='low'
                                                    id='mod-low'
                                                    label={t('common.low')}
                                                    Icon={ShieldAlert}
                                                    disabled={isLoading}
                                                />
                                            </RadioGroup>
                                        </div>
                                    </TabsContent>
                                </Tabs>
                            </div>
                        )}
                    </div>
                </CardContent>
                <CardFooter className='border-border bg-card flex shrink-0 border-t p-3'>
                    <div className='w-full space-y-2'>
                        <div className='grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5 text-xs'>
                            <span className='border-border bg-muted/45 text-muted-foreground inline-flex min-w-0 items-center justify-center rounded-md border px-2 py-1 text-center leading-4 break-words whitespace-normal'>
                                {model}
                            </span>
                            <span className='border-border bg-muted/45 text-muted-foreground inline-flex min-w-0 items-center justify-center rounded-md border px-2 py-1 text-center leading-4 break-words whitespace-normal'>
                                {workbenchBackendLabel}
                            </span>
                            <span className='border-border bg-muted/45 text-muted-foreground inline-flex min-w-0 items-center justify-center rounded-md border px-2 py-1 text-center leading-4 break-words whitespace-normal'>
                                {streamStatusLabel}
                            </span>
                            {parallelBatchChecked && (
                                <span className='inline-flex min-w-0 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-center leading-4 break-words whitespace-normal text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'>
                                    {t('streaming.parallelBatchEnabled')}
                                </span>
                            )}
                            <span className='border-primary/20 bg-primary/10 text-primary col-span-2 inline-flex min-w-0 items-center justify-center rounded-md border px-2 py-1 text-center leading-4 break-words whitespace-normal'>
                                {requestSummaryLabel}
                            </span>
                        </div>
                        {submitDisabledReason && (
                            <p className='text-muted-foreground text-center text-xs'>{submitDisabledReason}</p>
                        )}
                        <div className='grid gap-2 sm:grid-cols-[1fr_auto]'>
                            <Button
                                type='button'
                                onClick={handleSubmit}
                                disabled={isLoading || !!submitDisabledReason}
                                className='bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground flex min-h-11 w-full items-center justify-center gap-2 border-0 shadow-sm lg:min-h-9'>
                                {showLoadingState && <Loader2 className='h-4 w-4 animate-spin' />}
                                {showLoadingState ? t('generate.loading') : t('generate.submit')}
                            </Button>
                            {canPauseBatch && (
                                <Button
                                    type='button'
                                    variant='outline'
                                    onClick={() => onPauseBatch?.()}
                                    disabled={isBatchPauseRequested}
                                    title={t('batch.pauseHint')}
                                    className='bg-background/80 min-h-10 gap-2 px-3'>
                                    {isBatchPauseRequested ? (
                                        <Loader2 className='h-4 w-4 animate-spin' />
                                    ) : (
                                        <Pause className='h-4 w-4' />
                                    )}
                                    <span className='whitespace-nowrap'>
                                        {isBatchPauseRequested ? t('batch.pauseRequested') : t('batch.pause')}
                                    </span>
                                </Button>
                            )}
                        </div>
                        {canPauseBatch && (
                            <p className='text-muted-foreground text-center text-xs'>{t('batch.pauseHint')}</p>
                        )}
                        <div className='grid grid-cols-2 gap-2'>
                            <button
                                type='button'
                                className='border-border bg-background/70 text-muted-foreground hover:border-primary/25 hover:bg-accent/45 hover:text-foreground focus-visible:ring-ring flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-md border px-3 text-xs transition-[background-color,border-color,color,box-shadow,transform] focus-visible:ring-2 focus-visible:outline-none enabled:hover:-translate-y-0.5 enabled:active:translate-y-0 disabled:opacity-50 lg:min-h-9'
                                disabled={footerPromptTarget.isEmpty || isLoading}
                                onClick={() => onSaveInspiration(footerPromptTarget.value)}>
                                <Bookmark className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
                                <span className='min-w-0 whitespace-normal'>{t('workbench.saveInspiration')}</span>
                            </button>
                            <button
                                type='button'
                                className='border-border bg-background/70 text-muted-foreground hover:border-primary/25 hover:bg-accent/45 hover:text-foreground focus-visible:ring-ring flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-md border px-3 text-xs transition-[background-color,border-color,color,box-shadow,transform] focus-visible:ring-2 focus-visible:outline-none enabled:hover:-translate-y-0.5 enabled:active:translate-y-0 disabled:opacity-50 lg:min-h-9'
                                disabled={isLoading || !canApplyRandomInspiration}
                                onClick={() => {
                                    const nextPrompt = onPickRandomInspiration().trim();
                                    if (!nextPrompt) return;
                                    if (currentMode === 'batch') {
                                        setBatchPromptText(nextPrompt);
                                        return;
                                    }
                                    setPrompt(nextPrompt);
                                }}>
                                <WandSparkles className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
                                <span className='min-w-0 whitespace-normal'>{t('workbench.randomInspiration')}</span>
                            </button>
                        </div>
                    </div>
                </CardFooter>
            </div>
        </Card>
    );
}
