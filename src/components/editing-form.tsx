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
import type { GptImageModel } from '@/lib/cost-utils';
import { isGptImage2Model } from '@/lib/cost-utils';
import {
    formatEditSourceValidationFailure,
    formatEditUploadLimit,
    getResponsesEditInputLimitLabel,
    isResponsesEditInputLimitActive,
    validateEditSourceInput
} from '@/lib/edit-source-limits';
import { useI18n } from '@/lib/i18n';
import { getImageOutputFormatLabel, getImageQualityLabel } from '@/lib/image-display-labels';
import { MAX_PROMPT_LENGTH } from '@/lib/image-request-limits';
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
import type { ImageGenerationBackend, ImageStreamMode, ImageStreamingStrategy } from '@/lib/image-upstream-strategy';
import { DEFAULT_MODEL_OPTIONS } from '@/lib/model-directory-options';
import {
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
import {
    Bookmark,
    Eraser,
    Save,
    Square,
    RectangleHorizontal,
    RectangleVertical,
    Sparkles,
    SlidersHorizontal,
    ChevronDown,
    CircleOff,
    Tally1,
    Tally2,
    Tally3,
    Tally4,
    Loader2,
    X,
    ScanEye,
    UploadCloud,
    Lock,
    LockOpen,
    HelpCircle,
    SquareDashed,
    FileImage,
    WandSparkles,
    Globe2,
    ShieldCheck,
    ShieldAlert
} from 'lucide-react';
import Image from 'next/image';
import * as React from 'react';

type DrawnPoint = {
    x: number;
    y: number;
    size: number;
};

export type EditingFormData = {
    prompt: string;
    n: number;
    size: SizePreset;
    customWidth: number;
    customHeight: number;
    quality: 'low' | 'medium' | 'high' | 'auto';
    output_format: 'png' | 'jpeg' | 'webp';
    output_compression?: number;
    moderation: 'low' | 'auto';
    imageFiles: File[];
    maskFile: File | null;
    model: GptImageModel;
    image_backend: ImageUpstreamFormBackend;
    streaming_strategy: ImageUpstreamFormStreamingStrategy;
    responsesModel: string;
    thinking: ImageUpstreamFormThinking;
    promptOptimization: ImageUpstreamFormPromptOptimization;
    forceWeb: boolean;
    enableParallelBatch: boolean;
};

type EditingFormProps = {
    onSubmit: (data: EditingFormData) => void;
    onSaveInspiration: (prompt: string) => void;
    canApplyRandomInspiration: boolean;
    onPickRandomInspiration: () => string;
    isLoading: boolean;
    showLoadingState?: boolean;
    isActive: boolean;
    currentMode: WorkbenchMode;
    onModeChange: (mode: WorkbenchMode) => void;
    reuseContext: EditingReuseContext | null;
    onClearReuseContext: () => void;
    isPasswordRequiredByBackend: boolean | null;
    clientPasswordHash: string | null;
    onOpenPasswordDialog: () => void;
    editModel: EditingFormData['model'];
    modelOptions?: readonly string[];
    setEditModel: React.Dispatch<React.SetStateAction<EditingFormData['model']>>;
    imageFiles: File[];
    sourceImagePreviewUrls: string[];
    setImageFiles: React.Dispatch<React.SetStateAction<File[]>>;
    setSourceImagePreviewUrls: React.Dispatch<React.SetStateAction<string[]>>;
    maxImages: number;
    editPrompt: string;
    setEditPrompt: React.Dispatch<React.SetStateAction<string>>;
    editN: number[];
    setEditN: React.Dispatch<React.SetStateAction<number[]>>;
    editSize: EditingFormData['size'];
    setEditSize: React.Dispatch<React.SetStateAction<EditingFormData['size']>>;
    editCustomWidth: number;
    setEditCustomWidth: React.Dispatch<React.SetStateAction<number>>;
    editCustomHeight: number;
    setEditCustomHeight: React.Dispatch<React.SetStateAction<number>>;
    editQuality: EditingFormData['quality'];
    setEditQuality: React.Dispatch<React.SetStateAction<EditingFormData['quality']>>;
    editOutputFormat: EditingFormData['output_format'];
    setEditOutputFormat: React.Dispatch<React.SetStateAction<EditingFormData['output_format']>>;
    editCompression: number[];
    setEditCompression: React.Dispatch<React.SetStateAction<number[]>>;
    upstreamProfile: ImageUpstreamProfile;
    upstreamProfileMixed?: boolean;
    defaultImageBackend?: ImageGenerationBackend;
    editModeration: EditingFormData['moderation'];
    setEditModeration: React.Dispatch<React.SetStateAction<EditingFormData['moderation']>>;
    editBrushSize: number[];
    setEditBrushSize: React.Dispatch<React.SetStateAction<number[]>>;
    editShowMaskEditor: boolean;
    setEditShowMaskEditor: React.Dispatch<React.SetStateAction<boolean>>;
    editGeneratedMaskFile: File | null;
    setEditGeneratedMaskFile: React.Dispatch<React.SetStateAction<File | null>>;
    editIsMaskSaved: boolean;
    setEditIsMaskSaved: React.Dispatch<React.SetStateAction<boolean>>;
    editOriginalImageSize: { width: number; height: number } | null;
    setEditOriginalImageSize: React.Dispatch<React.SetStateAction<{ width: number; height: number } | null>>;
    editDrawnPoints: DrawnPoint[];
    setEditDrawnPoints: React.Dispatch<React.SetStateAction<DrawnPoint[]>>;
    editMaskPreviewUrl: string | null;
    setEditMaskPreviewUrl: React.Dispatch<React.SetStateAction<string | null>>;
    streamMode: ImageStreamMode;
    setStreamMode: React.Dispatch<React.SetStateAction<ImageStreamMode>>;
    allowStreamingBatch: boolean;
    enableParallelBatch: boolean;
    setEnableParallelBatch: React.Dispatch<React.SetStateAction<boolean>>;
    partialImages: PartialImagesCount;
    setPartialImages: React.Dispatch<React.SetStateAction<PartialImagesCount>>;
    allowResponsesImageBackend: boolean;
    hasDefaultResponsesModel: boolean;
    editImageBackend: EditingFormData['image_backend'];
    setEditImageBackend: React.Dispatch<React.SetStateAction<EditingFormData['image_backend']>>;
    editStreamingStrategy: EditingFormData['streaming_strategy'];
    defaultStreamingStrategy: ImageStreamingStrategy;
    setEditStreamingStrategy: React.Dispatch<React.SetStateAction<EditingFormData['streaming_strategy']>>;
    editResponsesModel: string;
    setEditResponsesModel: React.Dispatch<React.SetStateAction<string>>;
    editThinking: EditingFormData['thinking'];
    setEditThinking: React.Dispatch<React.SetStateAction<EditingFormData['thinking']>>;
    editPromptOptimization: EditingFormData['promptOptimization'];
    setEditPromptOptimization: React.Dispatch<React.SetStateAction<EditingFormData['promptOptimization']>>;
    editForceWeb: boolean;
    setEditForceWeb: React.Dispatch<React.SetStateAction<boolean>>;
    requestSummaryLabel: string;
    initialAdvancedOpen?: boolean;
    initialAdvancedTab?: AdvancedTab;
};

export type EditingReuseContext = {
    sourceLabel: string;
    restoredFields: string[];
    promptPreview: string;
};

type AdvancedTab = 'output' | 'model' | 'stream' | 'route';

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
            className='border-border bg-background/58 text-muted-foreground enabled:hover:border-primary/25 enabled:hover:bg-accent/45 enabled:hover:text-foreground data-[state=checked]:border-primary/55 data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary flex aspect-auto h-auto min-h-11 w-full flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 text-xs shadow-none transition-[background-color,border-color,color,box-shadow,transform] enabled:active:translate-y-0 enabled:motion-safe:hover:-translate-y-0.5 enabled:motion-safe:hover:scale-100 enabled:motion-safe:active:scale-100 lg:min-h-9 lg:px-1.5 lg:text-xs [&_[data-slot=radio-group-indicator]]:hidden [&_[data-slot=radio-group-item-content]]:max-w-full [&_[data-slot=radio-group-item-content]]:min-w-0 [&_[data-slot=radio-group-item-content]]:justify-center [&_[data-slot=radio-group-item-content]]:overflow-hidden'>
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

function getBackendLabel(backend: EditingFormData['image_backend'], t: (key: string) => string): string {
    if (backend === 'images-api') return t('upstream.backendImages');
    if (backend === 'responses-image-generation') return t('upstream.backendResponses');
    return t('upstream.serverDefault');
}

function getWorkbenchBackendLabel(backend: EditingFormData['image_backend'], t: (key: string) => string): string {
    if (backend === 'images-api') return t('upstream.backendImages');
    if (backend === 'responses-image-generation') return t('upstream.backendResponses');
    return t('upstream.workbenchDefaultRoute');
}

function getStreamModeLabel(streamMode: ImageStreamMode, t: (key: string) => string): string {
    if (streamMode === 'stream') return t('streaming.modeStream');
    if (streamMode === 'non_stream') return t('streaming.modeNonStream');
    return t('streaming.modeAuto');
}

export function EditingForm({
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
    editModel,
    modelOptions,
    setEditModel,
    imageFiles,
    sourceImagePreviewUrls,
    setImageFiles,
    setSourceImagePreviewUrls,
    maxImages,
    editPrompt,
    setEditPrompt,
    editN,
    setEditN,
    editSize,
    setEditSize,
    editCustomWidth,
    setEditCustomWidth,
    editCustomHeight,
    setEditCustomHeight,
    editQuality,
    setEditQuality,
    editOutputFormat,
    setEditOutputFormat,
    editCompression,
    setEditCompression,
    upstreamProfile,
    upstreamProfileMixed = false,
    defaultImageBackend,
    editModeration,
    setEditModeration,
    editBrushSize,
    setEditBrushSize,
    editShowMaskEditor,
    setEditShowMaskEditor,
    editGeneratedMaskFile,
    setEditGeneratedMaskFile,
    editIsMaskSaved,
    setEditIsMaskSaved,
    editOriginalImageSize,
    setEditOriginalImageSize,
    editDrawnPoints,
    setEditDrawnPoints,
    editMaskPreviewUrl,
    setEditMaskPreviewUrl,
    streamMode,
    setStreamMode,
    allowStreamingBatch,
    enableParallelBatch,
    setEnableParallelBatch,
    partialImages,
    setPartialImages,
    allowResponsesImageBackend,
    hasDefaultResponsesModel,
    editImageBackend,
    setEditImageBackend,
    editStreamingStrategy,
    defaultStreamingStrategy,
    setEditStreamingStrategy,
    editResponsesModel,
    setEditResponsesModel,
    editThinking,
    setEditThinking,
    editPromptOptimization,
    setEditPromptOptimization,
    editForceWeb,
    setEditForceWeb,
    requestSummaryLabel,
    initialAdvancedOpen = false,
    initialAdvancedTab = 'output'
}: EditingFormProps) {
    const { locale, t } = useI18n();
    const selectableModelOptions = React.useMemo(
        () => Array.from(new Set([editModel, ...(modelOptions ?? DEFAULT_MODEL_OPTIONS)])),
        [editModel, modelOptions]
    );
    const [firstImagePreviewUrl, setFirstImagePreviewUrl] = React.useState<string | null>(null);

    const isGptImage2 = isGptImage2Model(editModel);
    const supportsCustomSize = supportsCustomImageSize(editModel);
    const usesPositiveIntegerCustomSize = shouldUsePositiveIntegerImageSize(editModel, upstreamProfile);
    const customSizeValidation =
        editSize === 'custom'
            ? usesPositiveIntegerCustomSize
                ? validatePositiveIntegerImageSize(editCustomWidth, editCustomHeight)
                : validateGptImage2Size(editCustomWidth, editCustomHeight)
            : { valid: true as const };
    const customSizeInvalid = editSize === 'custom' && !customSizeValidation.valid;
    const editCustomPixelCount = formatExactImagePixelCount(editCustomWidth, editCustomHeight, locale);
    const editCustomRatio = editCustomPixelCount
        ? t('form.ratio', {
              ratio: (
                  Math.max(editCustomWidth, editCustomHeight) / Math.min(editCustomWidth, editCustomHeight)
              ).toFixed(2)
          })
        : t('form.noRatio');
    const editCustomSizeError = customSizeValidation.valid
        ? null
        : t(customSizeValidation.reasonKey, customSizeValidation.values);
    const showCompression = editOutputFormat === 'jpeg' || editOutputFormat === 'webp';
    const effectiveStreamingStrategy = resolveImageUpstreamEffectiveStreamingStrategy({
        streamingStrategy: editStreamingStrategy,
        defaultStreamingStrategy
    });
    const streamingDisabledByStrategy = effectiveStreamingStrategy === 'off';
    const parallelBatchToggle = resolveStreamingBatchToggleState({
        allowStreamingBatch,
        userEnabled: enableParallelBatch,
        targetCount: editN[0],
        streamMode,
        streamingStrategy: effectiveStreamingStrategy
    });
    const canEnableParallelBatch = parallelBatchToggle.canEnable;
    const parallelBatchChecked = parallelBatchToggle.checked;
    const parallelBatchUnavailableKey = parallelBatchToggle.unavailableReasonKey;

    const [isAdvancedOpen, setIsAdvancedOpen] = React.useState(initialAdvancedOpen);
    const [advancedTab, setAdvancedTab] = React.useState<AdvancedTab>(initialAdvancedTab);
    const effectiveImageBackend = resolveImageBackendSelection(editImageBackend, defaultImageBackend);
    const responsesBackendUnavailable =
        effectiveImageBackend === 'responses-image-generation' && !allowResponsesImageBackend;
    const requiresResponsesModel =
        effectiveImageBackend === 'responses-image-generation' &&
        !hasDefaultResponsesModel &&
        !editResponsesModel.trim();
    const backendCompatibility = React.useMemo(
        () => getImageBackendCompatibility(upstreamProfile, 'edit', editImageBackend, defaultImageBackend),
        [defaultImageBackend, editImageBackend, upstreamProfile]
    );
    const backendCompatibilityMessage = backendCompatibility.compatible
        ? ''
        : backendCompatibility.errors.map((error) => error.message).join(' ');
    const editPromptOverLimit = editPrompt.length > MAX_PROMPT_LENGTH;
    const editSourceValidationFailure = React.useMemo(
        () =>
            validateEditSourceInput({
                imageFiles,
                maskFile: editGeneratedMaskFile,
                upstreamProfile,
                imageBackend: editImageBackend,
                defaultImageBackend
            }),
        [defaultImageBackend, editGeneratedMaskFile, editImageBackend, imageFiles, upstreamProfile]
    );
    const editSourceValidationMessage = editSourceValidationFailure
        ? formatEditSourceValidationFailure(editSourceValidationFailure, t)
        : '';
    const editUploadHint = React.useMemo(() => {
        const values: Record<string, string | number> = {
            count: maxImages,
            singleLimit: formatEditUploadLimit(upstreamProfile.upload.maxSingleBytes),
            totalHint:
                upstreamProfile.upload.maxTotalBytes === undefined
                    ? t('edit.referenceNoTotalLimit')
                    : t('edit.referenceTotalLimit', {
                          limit: formatEditUploadLimit(upstreamProfile.upload.maxTotalBytes)
                      })
        };
        return t('edit.referenceHint', values);
    }, [maxImages, t, upstreamProfile.upload.maxSingleBytes, upstreamProfile.upload.maxTotalBytes]);
    const editReferenceEmptyHint = t('edit.referenceEmpty', {
        singleLimit: formatEditUploadLimit(upstreamProfile.upload.maxSingleBytes)
    });
    const responsesEditInputLimitActive = isResponsesEditInputLimitActive({
        imageBackend: editImageBackend,
        defaultImageBackend
    });
    const submitDisabledReason = React.useMemo(() => {
        if (isLoading) return '';
        if (imageFiles.length === 0) return t('ux.disabledSourceImage');
        if (imageFiles.length > maxImages) return t('alert.maxImages', { count: maxImages });
        if (editSourceValidationMessage) return editSourceValidationMessage;
        if (responsesBackendUnavailable) return t('upstream.backendResponsesUnavailable');
        if (backendCompatibilityMessage) return backendCompatibilityMessage;
        if (!editPrompt.trim()) return t('ux.disabledPrompt');
        if (editPromptOverLimit) return t('ux.disabledPromptLength', { limit: MAX_PROMPT_LENGTH });
        if (editDrawnPoints.length > 0 && !editGeneratedMaskFile && !editIsMaskSaved) {
            return t('ux.disabledUnsavedMask');
        }
        if (requiresResponsesModel) return t('upstream.responsesModelRequired');
        if (customSizeInvalid) return editCustomSizeError || t('ux.disabledCustomSize');
        return '';
    }, [
        customSizeInvalid,
        backendCompatibilityMessage,
        editCustomSizeError,
        editDrawnPoints.length,
        editGeneratedMaskFile,
        editIsMaskSaved,
        editPrompt,
        editPromptOverLimit,
        editSourceValidationMessage,
        imageFiles.length,
        isLoading,
        maxImages,
        requiresResponsesModel,
        responsesBackendUnavailable,
        t
    ]);
    const advancedSummary = [
        `${t('form.quality')}: ${getImageQualityLabel(editQuality, t)}`,
        `${t('form.outputFormat')}: ${getImageOutputFormatLabel(editOutputFormat, t)}`,
        getBackendLabel(editImageBackend, t)
    ].join(', ');
    const streamModeLabel = getStreamModeLabel(streamMode, t);
    const streamStatusLabel = getStreamingStatusLabel(streamMode, t);
    const workbenchBackendLabel = getWorkbenchBackendLabel(editImageBackend, t);
    const editSizePresetOptions = getSizePresetOptions({ model: editModel, upstreamProfile });
    const partialImagesRange = React.useMemo(
        () => backendCompatibility.partialImagesRange ?? { min: 1, max: 3 },
        [backendCompatibility.partialImagesRange]
    );
    const partialImageOptions = buildIntegerRangeOptions(partialImagesRange) as PartialImagesCount[];
    const editCountRange = React.useMemo(
        () => backendCompatibility.imageCountRange ?? { min: 1, max: 1 },
        [backendCompatibility.imageCountRange]
    );

    // 旧版模型只支持预设尺寸；provider-defined 模型保留自定义尺寸语义。
    React.useEffect(() => {
        if (isActive && !supportsCustomSize && editSize === 'custom') {
            setEditSize('auto');
        }
    }, [editSize, isActive, setEditSize, supportsCustomSize]);

    React.useEffect(() => {
        if (isActive && streamingDisabledByStrategy && streamMode !== 'non_stream') {
            setStreamMode('non_stream');
        }
    }, [isActive, streamingDisabledByStrategy, streamMode, setStreamMode]);

    React.useEffect(() => {
        if (isActive && (partialImages < partialImagesRange.min || partialImages > partialImagesRange.max)) {
            setPartialImages(clampIntegerToRange(partialImages, partialImagesRange) as PartialImagesCount);
        }
    }, [isActive, partialImages, partialImagesRange, setPartialImages]);

    React.useEffect(() => {
        if (isActive && (editN[0] < editCountRange.min || editN[0] > editCountRange.max)) {
            setEditN([clampIntegerToRange(editN[0], editCountRange)]);
        }
    }, [editCountRange, editN, isActive, setEditN]);

    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    const visualFeedbackCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const isDrawing = React.useRef(false);
    const lastPos = React.useRef<{ x: number; y: number } | null>(null);
    const imageInputRef = React.useRef<HTMLInputElement>(null);
    const maskInputRef = React.useRef<HTMLInputElement>(null);
    const primaryImagePreviewUrl = sourceImagePreviewUrls[0] ?? null;
    const hasSourceImages = imageFiles.length > 0;
    const hasSourcePreviews = sourceImagePreviewUrls.length > 0;
    const canAddSourceImage = !isLoading && imageFiles.length < maxImages;

    React.useEffect(() => {
        if (editOriginalImageSize) {
            if (!visualFeedbackCanvasRef.current) {
                visualFeedbackCanvasRef.current = document.createElement('canvas');
            }
            visualFeedbackCanvasRef.current.width = editOriginalImageSize.width;
            visualFeedbackCanvasRef.current.height = editOriginalImageSize.height;
        }
    }, [editOriginalImageSize]);

    React.useEffect(() => {
        let cancelled = false;

        queueMicrotask(() => {
            if (cancelled) return;
            setEditGeneratedMaskFile(null);
            setEditIsMaskSaved(false);
            setEditOriginalImageSize(null);
            setFirstImagePreviewUrl(null);
            setEditDrawnPoints([]);
            setEditMaskPreviewUrl(null);
        });

        if (primaryImagePreviewUrl) {
            const img = new window.Image();
            img.onload = () => {
                if (cancelled) return;
                setEditOriginalImageSize({ width: img.width, height: img.height });
            };
            img.src = primaryImagePreviewUrl;
            queueMicrotask(() => {
                if (!cancelled) {
                    setFirstImagePreviewUrl(primaryImagePreviewUrl);
                }
            });
        } else {
            queueMicrotask(() => {
                if (!cancelled) {
                    setEditShowMaskEditor(false);
                }
            });
        }

        return () => {
            cancelled = true;
        };
    }, [
        primaryImagePreviewUrl,
        setEditGeneratedMaskFile,
        setEditIsMaskSaved,
        setEditOriginalImageSize,
        setFirstImagePreviewUrl,
        setEditDrawnPoints,
        setEditMaskPreviewUrl,
        setEditShowMaskEditor
    ]);

    React.useEffect(() => {
        const displayCtx = canvasRef.current?.getContext('2d');
        const displayCanvas = canvasRef.current;
        const feedbackCanvas = visualFeedbackCanvasRef.current;

        if (!displayCtx || !displayCanvas || !feedbackCanvas || !editOriginalImageSize) return;

        const feedbackCtx = feedbackCanvas.getContext('2d');
        if (!feedbackCtx) return;

        feedbackCtx.clearRect(0, 0, feedbackCanvas.width, feedbackCanvas.height);
        feedbackCtx.fillStyle = 'red';
        editDrawnPoints.forEach((point) => {
            feedbackCtx.beginPath();
            feedbackCtx.arc(point.x, point.y, point.size, 0, Math.PI * 2);
            feedbackCtx.fill();
        });

        displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        displayCtx.save();
        displayCtx.globalAlpha = 0.5;
        displayCtx.drawImage(feedbackCanvas, 0, 0, displayCanvas.width, displayCanvas.height);
        displayCtx.restore();
    }, [editDrawnPoints, editOriginalImageSize]);

    const getMousePos = (e: React.MouseEvent | React.TouchEvent) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY
        };
    };

    const addPoint = (x: number, y: number) => {
        setEditDrawnPoints((prevPoints) => [...prevPoints, { x, y, size: editBrushSize[0] }]);
        setEditIsMaskSaved(false);
        setEditMaskPreviewUrl(null);
    };

    const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        isDrawing.current = true;
        const currentPos = getMousePos(e);
        if (!currentPos) return;
        lastPos.current = currentPos;
        addPoint(currentPos.x, currentPos.y);
    };

    const drawLine = (e: React.MouseEvent | React.TouchEvent) => {
        if (!isDrawing.current) return;
        e.preventDefault();
        const currentPos = getMousePos(e);
        if (!currentPos || !lastPos.current) return;

        const dist = Math.hypot(currentPos.x - lastPos.current.x, currentPos.y - lastPos.current.y);
        const angle = Math.atan2(currentPos.y - lastPos.current.y, currentPos.x - lastPos.current.x);
        const step = Math.max(1, editBrushSize[0] / 4);

        for (let i = step; i < dist; i += step) {
            const x = lastPos.current.x + Math.cos(angle) * i;
            const y = lastPos.current.y + Math.sin(angle) * i;
            addPoint(x, y);
        }
        addPoint(currentPos.x, currentPos.y);

        lastPos.current = currentPos;
    };

    const drawMaskStroke = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => {
        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
    };

    const stopDrawing = () => {
        isDrawing.current = false;
        lastPos.current = null;
    };

    const handleClearMask = () => {
        setEditDrawnPoints([]);
        setEditGeneratedMaskFile(null);
        setEditIsMaskSaved(false);
        setEditMaskPreviewUrl(null);
    };

    const generateAndSaveMask = () => {
        if (!editOriginalImageSize || editDrawnPoints.length === 0) {
            setEditGeneratedMaskFile(null);
            setEditIsMaskSaved(false);
            setEditMaskPreviewUrl(null);
            return;
        }

        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = editOriginalImageSize.width;
        offscreenCanvas.height = editOriginalImageSize.height;
        const offscreenCtx = offscreenCanvas.getContext('2d');

        if (!offscreenCtx) return;

        offscreenCtx.fillStyle = '#000000';
        offscreenCtx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
        offscreenCtx.globalCompositeOperation = 'destination-out';
        editDrawnPoints.forEach((point) => {
            drawMaskStroke(offscreenCtx, point.x, point.y, point.size);
        });

        try {
            const dataUrl = offscreenCanvas.toDataURL('image/png');
            setEditMaskPreviewUrl(dataUrl);
        } catch (e) {
            console.error('生成遮罩预览 data URL 失败：', e);
            setEditMaskPreviewUrl(null);
        }

        offscreenCanvas.toBlob((blob) => {
            if (blob) {
                const maskFile = new File([blob], 'generated-mask.png', { type: 'image/png' });
                const validationFailure = validateEditSourceInput({
                    imageFiles,
                    maskFile,
                    upstreamProfile,
                    imageBackend: editImageBackend,
                    defaultImageBackend
                });
                if (validationFailure) {
                    alert(formatEditSourceValidationFailure(validationFailure, t));
                    setEditGeneratedMaskFile(null);
                    setEditIsMaskSaved(false);
                    setEditMaskPreviewUrl(null);
                    return;
                }
                setEditGeneratedMaskFile(maskFile);
                setEditIsMaskSaved(true);
            } else {
                console.error('生成遮罩 blob 失败。');
                setEditIsMaskSaved(false);
                setEditMaskPreviewUrl(null);
            }
        }, 'image/png');
    };

    const handleImageFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files) {
            const newFiles = Array.from(event.target.files);
            const totalFiles = imageFiles.length + newFiles.length;

            if (totalFiles > maxImages) {
                alert(t('alert.maxImages', { count: maxImages }));
                event.target.value = '';
                return;
            }

            const validationFailure = validateEditSourceInput({
                imageFiles: [...imageFiles, ...newFiles],
                maskFile: editGeneratedMaskFile,
                upstreamProfile,
                imageBackend: editImageBackend,
                defaultImageBackend
            });
            if (validationFailure) {
                alert(formatEditSourceValidationFailure(validationFailure, t));
                event.target.value = '';
                return;
            }

            setImageFiles((prevFiles) => [...prevFiles, ...newFiles]);

            const newFilePromises = newFiles.map((file) => {
                return new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
            });

            Promise.all(newFilePromises)
                .then((newUrls) => {
                    setSourceImagePreviewUrls((prevUrls) => [...prevUrls, ...newUrls]);
                })
                .catch((error) => {
                    console.error('读取新图片文件失败：', error);
                });

            event.target.value = '';
        }
    };

    const handleRemoveImage = (indexToRemove: number) => {
        setImageFiles((prevFiles) => prevFiles.filter((_, index) => index !== indexToRemove));
        setSourceImagePreviewUrls((prevUrls) => prevUrls.filter((_, index) => index !== indexToRemove));
    };

    const handleMaskFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !editOriginalImageSize) {
            event.target.value = '';
            return;
        }

        const validationFailure = validateEditSourceInput({
            imageFiles,
            maskFile: file,
            upstreamProfile,
            imageBackend: editImageBackend,
            defaultImageBackend
        });
        if (validationFailure) {
            alert(formatEditSourceValidationFailure(validationFailure, t));
            event.target.value = '';
            return;
        }

        const reader = new FileReader();
        const img = new window.Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = () => {
            if (img.width !== editOriginalImageSize.width || img.height !== editOriginalImageSize.height) {
                alert(
                    t('alert.maskDimensionMismatch', {
                        actual: `${img.width}x${img.height}`,
                        expected: `${editOriginalImageSize.width}x${editOriginalImageSize.height}`
                    })
                );
                URL.revokeObjectURL(objectUrl);
                event.target.value = '';
                return;
            }

            setEditGeneratedMaskFile(file);
            setEditIsMaskSaved(true);
            setEditDrawnPoints([]);

            reader.onloadend = () => {
                setEditMaskPreviewUrl(reader.result as string);
                URL.revokeObjectURL(objectUrl);
            };
            reader.onerror = () => {
                console.error('读取遮罩预览文件失败。');
                setEditMaskPreviewUrl(null);
                URL.revokeObjectURL(objectUrl);
            };
            reader.readAsDataURL(file);

            event.target.value = '';
        };

        img.onerror = () => {
            alert(t('alert.maskLoadFailed'));
            URL.revokeObjectURL(objectUrl);
            event.target.value = '';
        };

        img.src = objectUrl;
    };

    const handleSubmit = () => {
        if (imageFiles.length === 0) {
            alert(t('alert.editNoImage'));
            return;
        }
        if (imageFiles.length > maxImages) {
            alert(t('alert.maxImages', { count: maxImages }));
            return;
        }
        if (editSourceValidationMessage) {
            alert(editSourceValidationMessage);
            return;
        }
        if (!editPrompt.trim() || editPromptOverLimit) {
            return;
        }
        if (editDrawnPoints.length > 0 && !editGeneratedMaskFile && !editIsMaskSaved) {
            alert(t('alert.saveMaskBeforeSubmit'));
            return;
        }
        if (customSizeInvalid) {
            return;
        }
        if (partialImages < partialImagesRange.min || partialImages > partialImagesRange.max) {
            setPartialImages(clampIntegerToRange(partialImages, partialImagesRange) as PartialImagesCount);
            return;
        }
        if (editN[0] < editCountRange.min || editN[0] > editCountRange.max) {
            setEditN([clampIntegerToRange(editN[0], editCountRange)]);
            return;
        }

        const formData: EditingFormData = {
            prompt: editPrompt,
            n: editN[0],
            size: editSize,
            customWidth: editCustomWidth,
            customHeight: editCustomHeight,
            quality: editQuality,
            output_format: editOutputFormat,
            ...(showCompression ? { output_compression: editCompression[0] } : {}),
            moderation: editModeration,
            imageFiles: imageFiles,
            maskFile: editGeneratedMaskFile,
            model: editModel,
            image_backend: editImageBackend,
            streaming_strategy: editStreamingStrategy,
            responsesModel: editResponsesModel,
            thinking: editThinking,
            promptOptimization: editPromptOptimization,
            forceWeb: editForceWeb,
            enableParallelBatch: parallelBatchChecked
        };
        onSubmit(formData);
    };

    return (
        <Card className='mobile-drawer-form-card workbench-panel text-card-foreground border-border flex min-h-0 w-full flex-1 flex-col gap-0 overflow-hidden rounded-lg border py-0 lg:h-full'>
            <CardHeader className='border-border/70 shrink-0 border-b px-3 pt-2 !pb-2'>
                <ModeToggle currentMode={currentMode} onModeChange={onModeChange} />
            </CardHeader>
            <div className='mobile-drawer-form-frame flex min-h-0 flex-1 flex-col overflow-hidden'>
                <CardContent className='mobile-drawer-form-content literary-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pb-4 lg:px-5 lg:py-3'>
                    <div className='space-y-1'>
                        <div className='flex items-center'>
                            <CardTitle className='editorial-title py-0.5 text-xl font-semibold'>
                                {t('workbench.creationSheet')}
                            </CardTitle>
                            {isPasswordRequiredByBackend && (
                                <Button
                                    variant='ghost'
                                    size='sm'
                                    onClick={onOpenPasswordDialog}
                                    className='text-muted-foreground hover:text-foreground ml-auto min-h-11 min-w-11 px-2 lg:h-7 lg:min-h-0 lg:min-w-0'
                                    aria-label={t('password.configure')}>
                                    {clientPasswordHash ? (
                                        <Lock className='h-4 w-4' />
                                    ) : (
                                        <LockOpen className='h-4 w-4' />
                                    )}
                                </Button>
                            )}
                        </div>
                    </div>
                    {reuseContext && (
                        <div className='border-primary/25 bg-primary/5 rounded-md border px-3 py-2 text-xs leading-5 shadow-sm'>
                            <div className='space-y-2'>
                                <div className='flex items-start justify-between gap-3'>
                                    <div className='min-w-0'>
                                        <p className='text-foreground font-medium'>{t('reuse.editAppliedTitle')}</p>
                                        <p className='text-muted-foreground truncate'>{reuseContext.sourceLabel}</p>
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
                                <p className='text-muted-foreground'>{t('reuse.editMutableHint')}</p>
                            </div>
                        </div>
                    )}
                    <div className='border-border/80 space-y-3 border-b border-dashed pb-4'>
                        <div className='flex items-start justify-between gap-3'>
                            <div className='space-y-1'>
                                <div
                                    id='source-image-upload-label'
                                    className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                    {t('edit.referenceTitle')}
                                </div>
                                <p
                                    id='source-image-upload-description'
                                    className='text-muted-foreground text-xs leading-5'>
                                    {editUploadHint}
                                </p>
                            </div>
                            <span className='border-primary/20 bg-primary/10 text-primary ui-stat rounded-full border px-2 py-1 text-xs'>
                                {t('edit.referenceCount', { count: imageFiles.length, max: maxImages })}
                            </span>
                        </div>
                        <button
                            type='button'
                            onClick={() => imageInputRef.current?.click()}
                            disabled={!canAddSourceImage}
                            aria-label={t('edit.referenceAction')}
                            aria-describedby='source-image-upload-description'
                            className={`group hover:border-primary/35 focus-visible:ring-ring border-input bg-muted/35 hover:bg-muted/55 flex w-full cursor-pointer rounded-md border border-dashed text-center shadow-inner transition-[background-color,border-color,box-shadow,transform] focus-visible:ring-2 focus-visible:outline-none enabled:active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-60 ${
                                hasSourceImages
                                    ? 'min-h-11 flex-row items-center justify-start gap-2 px-3 py-2 text-left'
                                    : 'min-h-[116px] flex-col items-center justify-center gap-2 px-4 py-4'
                            }`}>
                            <span
                                className={`border-primary/20 bg-background/80 text-primary flex items-center justify-center rounded-md border shadow-sm transition-transform group-hover:-translate-y-0.5 ${
                                    hasSourceImages ? 'h-8 w-8 shrink-0' : 'h-10 w-10'
                                }`}>
                                <UploadCloud className='h-5 w-5' />
                            </span>
                            <span className={hasSourceImages ? 'min-w-0' : ''}>
                                <span className='text-foreground block text-sm font-medium'>
                                    {hasSourceImages ? t('edit.referenceAddMore') : t('edit.referenceAction')}
                                </span>
                                <span className='text-muted-foreground block max-w-[18rem] text-xs leading-5'>
                                    {hasSourceImages ? t('edit.referenceReady') : editReferenceEmptyHint}
                                </span>
                            </span>
                        </button>
                        <Input
                            ref={imageInputRef}
                            id='image-files-input'
                            name='sourceImages'
                            type='file'
                            accept='image/png, image/jpeg, image/webp'
                            multiple
                            onChange={handleImageFileChange}
                            disabled={isLoading || imageFiles.length >= maxImages}
                            className='hidden'
                        />
                        {!hasSourceImages && (
                            <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-200'>
                                {t('edit.referenceRequiredNote')}
                            </div>
                        )}
                        {hasSourceImages && !hasSourcePreviews && (
                            <div className='border-border/70 bg-background/60 text-muted-foreground rounded-md border px-3 py-2 text-xs leading-5'>
                                {t('edit.referencePreparing')}
                            </div>
                        )}
                        {responsesEditInputLimitActive && (
                            <p className='text-muted-foreground text-xs leading-5'>
                                {t('edit.responsesInputLimit', {
                                    limit: getResponsesEditInputLimitLabel()
                                })}
                            </p>
                        )}
                        {hasSourcePreviews && (
                            <div className='flex space-x-2 overflow-x-auto pt-1.5'>
                                {sourceImagePreviewUrls.map((url, index) => (
                                    <div
                                        key={url}
                                        className='group border-border bg-card relative shrink-0 rounded-sm border p-1 shadow-[0_6px_14px_rgb(15,23,42,0.1)]'>
                                        <Image
                                            src={url}
                                            alt={t('edit.sourcePreview', { index: index + 1 })}
                                            width={96}
                                            height={96}
                                            className='image-edge h-24 w-24 rounded-[3px] object-cover'
                                            unoptimized
                                        />
                                        <Button
                                            type='button'
                                            variant='secondary'
                                            size='icon'
                                            className='border-background/80 absolute top-1.5 right-1.5 min-h-9 min-w-9 rounded-full border bg-slate-800/80 p-0 text-white opacity-100 shadow-sm transition-opacity hover:bg-slate-900 hover:text-white sm:min-h-7 sm:min-w-7 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100'
                                            onClick={() => handleRemoveImage(index)}
                                            aria-label={t('edit.removeImage', { index: index + 1 })}>
                                            <X className='h-3 w-3' />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className='border-border/80 space-y-1.5 border-b border-dashed pb-4'>
                        <Label htmlFor='edit-prompt'>{t('edit.instructionTitle')}</Label>
                        <div className='relative'>
                            <Textarea
                                id='edit-prompt'
                                name='editPrompt'
                                placeholder={t('form.editPromptPlaceholder')}
                                value={editPrompt}
                                onChange={(e) => setEditPrompt(e.target.value)}
                                maxLength={MAX_PROMPT_LENGTH}
                                required
                                disabled={isLoading}
                                className='bg-muted/45 min-h-[118px] rounded-md px-4 py-3 pb-9 leading-7 shadow-inner'
                            />
                            <span className='text-muted-foreground ui-stat pointer-events-none absolute bottom-3 left-4 text-xs'>
                                {editPrompt.length.toLocaleString(locale)} / {MAX_PROMPT_LENGTH.toLocaleString(locale)}
                            </span>
                        </div>
                    </div>

                    <div className='border-border bg-background space-y-3 rounded-md border p-3'>
                        <div className='text-foreground block text-sm leading-none font-medium select-none'>
                            {t('edit.mask')}
                        </div>
                        <p className='text-muted-foreground text-xs leading-5'>
                            {t('edit.maskHint', {
                                singleLimit: formatEditUploadLimit(upstreamProfile.upload.maxSingleBytes)
                            })}
                        </p>
                        <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            onClick={() => setEditShowMaskEditor(!editShowMaskEditor)}
                            disabled={isLoading || !editOriginalImageSize}
                            className='min-h-9 w-full justify-start px-3'>
                            {editShowMaskEditor
                                ? t('edit.closeMaskEditor')
                                : editGeneratedMaskFile
                                  ? t('edit.editSavedMask')
                                  : t('edit.createMask')}
                            {editIsMaskSaved && !editShowMaskEditor && (
                                <span className='ml-auto text-xs text-emerald-600 dark:text-emerald-400'>
                                    ({t('edit.maskAppliedStatus')})
                                </span>
                            )}
                            <ScanEye className='mt-0.5' />
                        </Button>

                        {editShowMaskEditor && firstImagePreviewUrl && editOriginalImageSize && (
                            <div className='bg-muted/20 border-border space-y-3 rounded-md border p-3'>
                                <p className='text-muted-foreground text-xs'>{t('edit.drawMaskHint')}</p>
                                <div
                                    className='border-border image-edge relative mx-auto w-full overflow-hidden rounded border'
                                    style={{
                                        maxWidth: `min(100%, ${editOriginalImageSize.width}px)`,
                                        aspectRatio: `${editOriginalImageSize.width} / ${editOriginalImageSize.height}`
                                    }}>
                                    <Image
                                        src={firstImagePreviewUrl}
                                        alt={t('edit.imagePreviewForMasking')}
                                        width={editOriginalImageSize.width}
                                        height={editOriginalImageSize.height}
                                        className='block h-auto w-full'
                                        unoptimized
                                    />
                                    <canvas
                                        ref={canvasRef}
                                        width={editOriginalImageSize.width}
                                        height={editOriginalImageSize.height}
                                        className='absolute top-0 left-0 h-full w-full cursor-crosshair'
                                        onMouseDown={startDrawing}
                                        onMouseMove={drawLine}
                                        onMouseUp={stopDrawing}
                                        onMouseLeave={stopDrawing}
                                        onTouchStart={startDrawing}
                                        onTouchMove={drawLine}
                                        onTouchEnd={stopDrawing}
                                    />
                                </div>
                                <div className='grid grid-cols-1 gap-4 pt-2'>
                                    <div className='space-y-2'>
                                        <div className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                            <span className='ui-stat'>
                                                {t('edit.brushSize', { value: editBrushSize[0] })}
                                            </span>
                                        </div>
                                        <Slider
                                            id='brush-size-slider'
                                            name='brush-size'
                                            thumbLabel={t('edit.brushSizeLabel')}
                                            min={5}
                                            max={100}
                                            step={1}
                                            value={editBrushSize}
                                            onValueChange={setEditBrushSize}
                                            disabled={isLoading}
                                            className='mt-1'
                                        />
                                    </div>
                                </div>
                                <div className='flex flex-col items-stretch gap-2 pt-3 sm:flex-row sm:items-center sm:justify-between'>
                                    <Button
                                        type='button'
                                        variant='outline'
                                        size='sm'
                                        onClick={() => maskInputRef.current?.click()}
                                        disabled={isLoading || !editOriginalImageSize}
                                        className='w-full sm:mr-auto sm:w-auto'>
                                        <UploadCloud className='mr-1.5 h-4 w-4' /> {t('edit.uploadMask')}
                                    </Button>
                                    <Input
                                        ref={maskInputRef}
                                        id='mask-file-input'
                                        name='maskFile'
                                        type='file'
                                        accept='image/png'
                                        onChange={handleMaskFileChange}
                                        className='hidden'
                                    />
                                    <div className='flex flex-col gap-2 sm:flex-row'>
                                        <Button
                                            type='button'
                                            variant='outline'
                                            size='sm'
                                            onClick={handleClearMask}
                                            disabled={isLoading}
                                            className='w-full sm:w-auto'>
                                            <Eraser className='mr-1.5 h-4 w-4' /> {t('edit.clearMask')}
                                        </Button>
                                        <Button
                                            type='button'
                                            variant='default'
                                            size='sm'
                                            onClick={generateAndSaveMask}
                                            disabled={isLoading || editDrawnPoints.length === 0}
                                            className='w-full sm:w-auto'>
                                            <Save className='mr-1.5 h-4 w-4' /> {t('edit.saveMask')}
                                        </Button>
                                    </div>
                                </div>
                                {editMaskPreviewUrl && (
                                    <div className='border-border mt-3 border-t pt-3 text-center'>
                                        <div className='text-foreground mb-1.5 block text-sm leading-none font-medium select-none'>
                                            {t('edit.maskPreview')}
                                        </div>
                                        <div className='border-border bg-background inline-block rounded border p-1'>
                                            <Image
                                                src={editMaskPreviewUrl}
                                                alt={t('edit.generatedMaskPreviewAlt')}
                                                width={editOriginalImageSize.width}
                                                height={editOriginalImageSize.height}
                                                className='block max-w-full'
                                                style={{ width: 'auto', height: '134px' }}
                                                unoptimized
                                            />
                                        </div>
                                    </div>
                                )}
                                {editIsMaskSaved && !editMaskPreviewUrl && (
                                    <p className='pt-1 text-center text-xs text-yellow-600 dark:text-yellow-400'>
                                        {t('edit.maskPreviewLoading')}
                                    </p>
                                )}
                                {editIsMaskSaved && editMaskPreviewUrl && (
                                    <p className='pt-1 text-center text-xs text-emerald-600 dark:text-emerald-400'>
                                        {t('edit.maskSaved')}
                                    </p>
                                )}
                            </div>
                        )}
                        {!editShowMaskEditor && editGeneratedMaskFile && (
                            <p className='pt-1 text-xs text-emerald-600 dark:text-emerald-400'>
                                {t('edit.maskApplied', { name: editGeneratedMaskFile.name })}
                            </p>
                        )}
                    </div>

                    <div className='border-border bg-background space-y-3 rounded-md border p-3'>
                        <div className='text-foreground block text-sm leading-none font-medium select-none'>
                            {t('form.size')}
                        </div>
                        <RadioGroup
                            value={editSize}
                            onValueChange={(value) => setEditSize(value as EditingFormData['size'])}
                            disabled={isLoading}
                            name='edit-size'
                            aria-label={t('form.size')}
                            className='grid grid-cols-2 gap-2 sm:grid-cols-3'>
                            {editSizePresetOptions.map((option) => (
                                <RadioItemWithIcon
                                    key={option.value}
                                    value={option.value}
                                    id={`edit-size-${option.value}`}
                                    label={getSizePresetLabel(option.value, t)}
                                    Icon={getSizePresetIcon(option.value)}
                                    disabled={isLoading}
                                    tooltip={getPresetTooltip(option.value, editModel)}
                                />
                            ))}
                        </RadioGroup>
                        {supportsCustomSize && editSize === 'custom' && (
                            <div className='bg-muted/30 border-border space-y-2 rounded-md border p-3'>
                                <div className='flex items-center gap-3'>
                                    <div className='flex-1 space-y-1'>
                                        <Label htmlFor='edit-custom-width' className='text-muted-foreground text-xs'>
                                            {t('form.width')}
                                        </Label>
                                        <Input
                                            id='edit-custom-width'
                                            name='editCustomWidth'
                                            type='number'
                                            inputMode='numeric'
                                            min={usesPositiveIntegerCustomSize ? 1 : 16}
                                            max={usesPositiveIntegerCustomSize ? undefined : 3840}
                                            step={usesPositiveIntegerCustomSize ? 1 : 16}
                                            value={editCustomWidth}
                                            onChange={(e) =>
                                                setEditCustomWidth(readImageSizeNumberInput(e.target.value))
                                            }
                                            disabled={isLoading}
                                        />
                                    </div>
                                    <span className='text-muted-foreground pt-5'>x</span>
                                    <div className='flex-1 space-y-1'>
                                        <Label htmlFor='edit-custom-height' className='text-muted-foreground text-xs'>
                                            {t('form.height')}
                                        </Label>
                                        <Input
                                            id='edit-custom-height'
                                            name='editCustomHeight'
                                            type='number'
                                            inputMode='numeric'
                                            min={usesPositiveIntegerCustomSize ? 1 : 16}
                                            max={usesPositiveIntegerCustomSize ? undefined : 3840}
                                            step={usesPositiveIntegerCustomSize ? 1 : 16}
                                            value={editCustomHeight}
                                            onChange={(e) =>
                                                setEditCustomHeight(readImageSizeNumberInput(e.target.value))
                                            }
                                            disabled={isLoading}
                                        />
                                    </div>
                                </div>
                                <p className='text-muted-foreground ui-stat text-xs'>
                                    {editCustomPixelCount
                                        ? t(
                                              usesPositiveIntegerCustomSize
                                                  ? 'form.pixelsMeta'
                                                  : 'form.pixelsMetaOfMaximum',
                                              {
                                                  pixels: editCustomPixelCount,
                                                  percent: (
                                                      ((editCustomWidth * editCustomHeight) / 8_294_400) *
                                                      100
                                                  ).toFixed(1),
                                                  ratio: editCustomRatio
                                              }
                                          )
                                        : t('form.pixelsUnavailable')}
                                </p>
                                {editCustomSizeError && (
                                    <p className='text-destructive text-xs'>{editCustomSizeError}</p>
                                )}
                                <p className='text-muted-foreground text-xs'>{t('form.customConstraints')}</p>
                            </div>
                        )}
                    </div>

                    <div className='border-border bg-muted/20 rounded-md border'>
                        <button
                            type='button'
                            onClick={() => setIsAdvancedOpen((open) => !open)}
                            className='text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-3 text-left text-sm font-medium transition-[background-color,color,transform] focus-visible:ring-2 focus-visible:outline-none active:scale-[0.995]'
                            aria-expanded={isAdvancedOpen}
                            aria-controls='editing-advanced-panel'>
                            <span className='flex min-w-0 items-center gap-2'>
                                <SlidersHorizontal className='h-4 w-4 shrink-0' />
                                <span className='min-w-0'>
                                    <span className='text-foreground block'>{t('ux.professionalMode')}</span>
                                    <span className='text-muted-foreground block text-xs leading-4 font-normal'>
                                        {advancedSummary}
                                    </span>
                                </span>
                            </span>
                            <ChevronDown
                                className={`h-4 w-4 shrink-0 transition-transform ${isAdvancedOpen ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {isAdvancedOpen && (
                            <div id='editing-advanced-panel' className='border-border border-t p-3'>
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
                                            <div className='flex items-center justify-between gap-2'>
                                                <Label htmlFor='edit-model-select'>{t('form.model')}</Label>
                                                {isGptImage2 && (
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <button
                                                                type='button'
                                                                className='text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent/80 focus-visible:ring-ring -my-2 inline-flex h-9 w-9 cursor-help items-center justify-center rounded-sm transition-[background-color,color,transform] focus-visible:ring-2 focus-visible:outline-none active:scale-95'
                                                                aria-label={t('edit.fidelityHint')}>
                                                                <HelpCircle className='h-4 w-4' />
                                                            </button>
                                                        </TooltipTrigger>
                                                        <TooltipContent className='max-w-[280px]'>
                                                            {t('edit.fidelityHint')}
                                                        </TooltipContent>
                                                    </Tooltip>
                                                )}
                                            </div>
                                            <Select
                                                value={editModel}
                                                onValueChange={(value) =>
                                                    setEditModel(value as EditingFormData['model'])
                                                }
                                                disabled={isLoading}
                                                name='edit-model'>
                                                <SelectTrigger
                                                    id='edit-model-select'
                                                    className='min-h-11 w-full lg:min-h-9'>
                                                    <SelectValue placeholder={t('form.selectModel')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {selectableModelOptions.map((modelId) => (
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
                                                <Label htmlFor='edit-image-backend-select'>
                                                    {t('upstream.backend')}
                                                </Label>
                                                <Select
                                                    value={editImageBackend}
                                                    onValueChange={(value) =>
                                                        setEditImageBackend(value as EditingFormData['image_backend'])
                                                    }
                                                    disabled={isLoading}
                                                    name='edit-image_backend'>
                                                    <SelectTrigger
                                                        id='edit-image-backend-select'
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
                                                <Label htmlFor='edit-streaming-strategy-select'>
                                                    {t('upstream.streamingStrategy')}
                                                </Label>
                                                <Select
                                                    value={editStreamingStrategy}
                                                    onValueChange={(value) =>
                                                        setEditStreamingStrategy(
                                                            value as EditingFormData['streaming_strategy']
                                                        )
                                                    }
                                                    disabled={isLoading}
                                                    name='edit-image_streaming_strategy'>
                                                    <SelectTrigger
                                                        id='edit-streaming-strategy-select'
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
                                                                    imageBackend: editImageBackend,
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
                                                                    imageBackend: editImageBackend,
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
                                                                    imageBackend: editImageBackend,
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
                                                backend: editImageBackend,
                                                streamingStrategy: editStreamingStrategy,
                                                defaultStreamingStrategy,
                                                allowResponsesImageBackend,
                                                serverProfileMixed: upstreamProfileMixed
                                            }).map((key) => (
                                                <p key={key}>{t(key)}</p>
                                            ))}
                                        </div>

                                        {editImageBackend === 'responses-image-generation' && (
                                            <div className='border-border bg-muted/20 space-y-3 rounded-md border p-3'>
                                                <div className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                                    <WandSparkles className='text-muted-foreground h-4 w-4' />
                                                    {t('upstream.compatibilityParams')}
                                                </div>
                                                <div className='grid gap-3 sm:grid-cols-2'>
                                                    <div className='space-y-1.5 sm:col-span-2'>
                                                        <Label htmlFor='edit-responses-model-input'>
                                                            {t('upstream.gptModel')}
                                                        </Label>
                                                        <Input
                                                            id='edit-responses-model-input'
                                                            name='editResponsesModel'
                                                            value={editResponsesModel}
                                                            onChange={(event) =>
                                                                setEditResponsesModel(event.target.value)
                                                            }
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
                                                        <Label htmlFor='edit-thinking-select'>
                                                            {t('upstream.thinking')}
                                                        </Label>
                                                        <Select
                                                            value={editThinking}
                                                            onValueChange={(value) =>
                                                                setEditThinking(value as EditingFormData['thinking'])
                                                            }
                                                            disabled={isLoading}
                                                            name='edit-thinking'>
                                                            <SelectTrigger
                                                                id='edit-thinking-select'
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
                                                        <Label htmlFor='edit-prompt-optimization-select'>
                                                            {t('upstream.promptOptimization')}
                                                        </Label>
                                                        <Select
                                                            value={editPromptOptimization}
                                                            onValueChange={(value) =>
                                                                setEditPromptOptimization(
                                                                    value as EditingFormData['promptOptimization']
                                                                )
                                                            }
                                                            disabled={isLoading}
                                                            name='edit-promptOptimization'>
                                                            <SelectTrigger
                                                                id='edit-prompt-optimization-select'
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

                                        {editImageBackend === 'images-api' && (
                                            <div className='border-border bg-muted/20 space-y-3 rounded-md border p-3'>
                                                <div className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                                    <Globe2 className='text-muted-foreground h-4 w-4' />
                                                    {t('upstream.compatibilityParams')}
                                                </div>
                                                <RadioGroup
                                                    value={editForceWeb ? 'true' : 'false'}
                                                    onValueChange={(value) => setEditForceWeb(value === 'true')}
                                                    disabled={isLoading}
                                                    name='edit-force_web'
                                                    aria-label={t('upstream.forceWeb')}
                                                    className='grid grid-cols-2 gap-2'>
                                                    <RadioItemWithIcon
                                                        value='false'
                                                        id='edit-force-web-false'
                                                        label={t('upstream.serverDefault')}
                                                        Icon={Sparkles}
                                                        disabled={isLoading}
                                                    />
                                                    <RadioItemWithIcon
                                                        value='true'
                                                        id='edit-force-web-true'
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
                                            <Label htmlFor='edit-stream-mode-select'>{t('streaming.mode')}</Label>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <div>
                                                        <Select
                                                            value={streamMode}
                                                            onValueChange={(value) =>
                                                                setStreamMode(value as ImageStreamMode)
                                                            }
                                                            disabled={isLoading || streamingDisabledByStrategy}
                                                            name='edit-stream_mode'>
                                                            <SelectTrigger
                                                                id='edit-stream-mode-select'
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
                                                        : allowStreamingBatch &&
                                                            editN[0] > 1 &&
                                                            streamMode !== 'non_stream'
                                                          ? t('streaming.batchDescription')
                                                          : t('streaming.description')}
                                                </TooltipContent>
                                            </Tooltip>
                                        </div>
                                        <div className='border-border bg-muted/20 flex items-start gap-3 rounded-md border p-3'>
                                            <label
                                                htmlFor='edit-parallel-batch-enabled'
                                                className='-m-2 flex min-h-11 min-w-11 cursor-pointer items-start justify-center p-2 has-disabled:cursor-not-allowed'>
                                                <Checkbox
                                                    id='edit-parallel-batch-enabled'
                                                    checked={parallelBatchChecked}
                                                    onCheckedChange={(value) => setEnableParallelBatch(value === true)}
                                                    disabled={isLoading || !canEnableParallelBatch}
                                                    aria-label={t('streaming.parallelBatch')}
                                                    className='mt-0.5'
                                                />
                                            </label>
                                            <div className='grid gap-1'>
                                                <Label
                                                    htmlFor='edit-parallel-batch-enabled'
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
                                                    name='edit-partial_images'
                                                    aria-label={t('streaming.previewImages')}
                                                    className='grid grid-cols-5 gap-2'>
                                                    {partialImageOptions.map((value) => (
                                                        <RadioItemWithIcon
                                                            key={value}
                                                            value={String(value)}
                                                            id={`edit-partial-${value}`}
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
                                                value={editQuality}
                                                onValueChange={(value) =>
                                                    setEditQuality(value as EditingFormData['quality'])
                                                }
                                                disabled={isLoading}
                                                name='edit-quality'
                                                aria-label={t('form.quality')}
                                                className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                                                <RadioItemWithIcon
                                                    value='auto'
                                                    id='edit-quality-auto'
                                                    label={t('common.auto')}
                                                    Icon={Sparkles}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='low'
                                                    id='edit-quality-low'
                                                    label={t('common.low')}
                                                    Icon={Tally1}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='medium'
                                                    id='edit-quality-medium'
                                                    label={t('common.medium')}
                                                    Icon={Tally2}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='high'
                                                    id='edit-quality-high'
                                                    label={t('common.high')}
                                                    Icon={Tally3}
                                                    disabled={isLoading}
                                                />
                                            </RadioGroup>
                                        </div>

                                        <div className='space-y-3'>
                                            <div className='text-foreground block text-sm leading-none font-medium select-none'>
                                                {t('form.outputFormat')}
                                            </div>
                                            <RadioGroup
                                                value={editOutputFormat}
                                                onValueChange={(value) =>
                                                    setEditOutputFormat(value as EditingFormData['output_format'])
                                                }
                                                disabled={isLoading}
                                                name='edit-output_format'
                                                aria-label={t('form.outputFormat')}
                                                className='grid grid-cols-1 gap-2 sm:grid-cols-3'>
                                                <RadioItemWithIcon
                                                    value='png'
                                                    id='edit-format-png'
                                                    label={t('common.png')}
                                                    Icon={FileImage}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='jpeg'
                                                    id='edit-format-jpeg'
                                                    label={t('common.jpeg')}
                                                    Icon={FileImage}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='webp'
                                                    id='edit-format-webp'
                                                    label={t('common.webp')}
                                                    Icon={FileImage}
                                                    disabled={isLoading}
                                                />
                                            </RadioGroup>
                                        </div>

                                        {showCompression && (
                                            <div className='space-y-2 pt-2 transition-opacity duration-300'>
                                                <div className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                                    {t('form.compression', { value: editCompression[0] })}
                                                </div>
                                                <Slider
                                                    id='edit-compression-slider'
                                                    name='edit-output_compression'
                                                    thumbLabel={t('form.compression', { value: editCompression[0] })}
                                                    min={0}
                                                    max={100}
                                                    step={1}
                                                    value={editCompression}
                                                    onValueChange={setEditCompression}
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
                                                value={editModeration}
                                                onValueChange={(value) =>
                                                    setEditModeration(value as EditingFormData['moderation'])
                                                }
                                                disabled={isLoading}
                                                name='edit-moderation'
                                                aria-label={t('form.moderation')}
                                                className='grid grid-cols-2 gap-2'>
                                                <RadioItemWithIcon
                                                    value='auto'
                                                    id='edit-mod-auto'
                                                    label={t('common.auto')}
                                                    Icon={ShieldCheck}
                                                    disabled={isLoading}
                                                />
                                                <RadioItemWithIcon
                                                    value='low'
                                                    id='edit-mod-low'
                                                    label={t('common.low')}
                                                    Icon={ShieldAlert}
                                                    disabled={isLoading}
                                                />
                                            </RadioGroup>
                                        </div>

                                        <div className='space-y-2'>
                                            <div className='text-foreground flex items-center gap-2 text-sm leading-none font-medium select-none'>
                                                {t('form.numberOfImages', { count: editN[0] })}
                                            </div>
                                            <Slider
                                                id='edit-n-slider'
                                                name='edit-n'
                                                thumbLabel={t('form.numberOfImages', { count: editN[0] })}
                                                min={editCountRange.min}
                                                max={editCountRange.max}
                                                step={1}
                                                value={editN}
                                                onValueChange={setEditN}
                                                disabled={isLoading}
                                                className='mt-3'
                                            />
                                        </div>
                                    </TabsContent>
                                </Tabs>
                            </div>
                        )}
                    </div>
                </CardContent>
                <CardFooter className='border-border bg-card flex shrink-0 border-t p-4'>
                    <div className='w-full space-y-2'>
                        <div className='grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5 text-xs'>
                            <span className='border-border bg-muted/45 text-muted-foreground inline-flex min-w-0 items-center justify-center rounded-md border px-2 py-1 text-center leading-4 break-words whitespace-normal'>
                                {editModel}
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
                        <Button
                            type='button'
                            onClick={handleSubmit}
                            disabled={isLoading || !!submitDisabledReason}
                            className='bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground flex min-h-11 w-full items-center justify-center gap-2 rounded-md border-0 shadow-sm lg:min-h-9'>
                            {showLoadingState && <Loader2 className='h-4 w-4 animate-spin' />}
                            {showLoadingState ? t('edit.loading') : t('edit.submit')}
                        </Button>
                        <div className='grid grid-cols-2 gap-2'>
                            <button
                                type='button'
                                className='border-border bg-background/70 text-muted-foreground hover:border-primary/25 hover:bg-accent/45 hover:text-foreground focus-visible:ring-ring flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-md border px-2 text-xs transition-[background-color,border-color,color,box-shadow,transform] focus-visible:ring-2 focus-visible:outline-none enabled:hover:-translate-y-0.5 enabled:active:translate-y-0 disabled:opacity-50 lg:min-h-9'
                                disabled={!editPrompt.trim() || isLoading}
                                onClick={() => onSaveInspiration(editPrompt)}>
                                <Bookmark className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
                                <span className='min-w-0 whitespace-normal'>{t('workbench.saveInspiration')}</span>
                            </button>
                            <button
                                type='button'
                                className='border-border bg-background/70 text-muted-foreground hover:border-primary/25 hover:bg-accent/45 hover:text-foreground focus-visible:ring-ring flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-md border px-2 text-xs transition-[background-color,border-color,color,box-shadow,transform] focus-visible:ring-2 focus-visible:outline-none enabled:hover:-translate-y-0.5 enabled:active:translate-y-0 disabled:opacity-50 lg:min-h-9'
                                disabled={isLoading || !canApplyRandomInspiration}
                                onClick={() => {
                                    const nextPrompt = onPickRandomInspiration().trim();
                                    if (!nextPrompt) return;
                                    setEditPrompt(nextPrompt);
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
