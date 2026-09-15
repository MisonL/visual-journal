'use client';

import { ApiSettingsDialog, type ApiSettings } from '@/components/api-settings-dialog';
import { EditingForm, type EditingFormData, type EditingReuseContext } from '@/components/editing-form';
import { GenerationForm, type GenerationFormData, type WorkbenchReuseContext } from '@/components/generation-form';
import { HistoryPanel, type InspirationItem, type PromptApplySource } from '@/components/history-panel';
import { ImageOutput } from '@/components/image-output';
import { LanguageSelector } from '@/components/language-selector';
import type { WorkbenchMode } from '@/components/mode-toggle';
import { PasswordDialog } from '@/components/password-dialog';
import { ShareDialog, type ShareDialogValues } from '@/components/share-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { WorkbenchProDock } from '@/components/workbench-pro-dock';
import { WorkbenchStatusStrip } from '@/components/workbench-status-strip';
import {
    classifyApiErrorCode,
    buildApiErrorNotice,
    buildBatchPartialFailureMessage,
    buildUserFacingApiErrorMessage,
    type ApiErrorNotice
} from '@/lib/api-error-guidance';
import { findBatchPromptOverLimitIndex, formatBatchPromptHistory, readBatchPromptLines } from '@/lib/batch-prompts';
import { db, type ImageRecord } from '@/lib/db';
import {
    formatEditSourceValidationFailure,
    hasReachedEditSourceImageLimit,
    validateEditSourceInput
} from '@/lib/edit-source-limits';
import {
    advanceGenerationBatchProgress,
    buildGenerationActivityItems,
    collectFailedBatchPrompts,
    countCompletedBatchResults,
    selectAnnouncedGenerationActivity,
    type GenerationBatchProgress
} from '@/lib/generation-activity';
import { resolveHistoryCompareImage } from '@/lib/history-compare';
import {
    buildHistoryFeedbackDeletePayload,
    buildHistoryFeedbackDeleteTargets,
    buildHistoryFeedbackSyncPayload,
    buildHistoryFeedbackSyncInputs,
    parseHistoryFeedbackDeleteQueue,
    parseHistoryFeedbackSyncQueue,
    pruneHistoryFeedbackDeleteQueueForSyncQueue,
    removeHistoryFeedbackDeleteQueuePayload,
    removeHistoryFeedbackDeleteQueueTargets,
    removeHistoryFeedbackSyncQueueItem,
    removeHistoryFeedbackSyncQueueTargets,
    removeHistoryFeedbackSyncQueueTargetsForDelete,
    serializeHistoryFeedbackDeleteQueue,
    serializeHistoryFeedbackSyncQueue,
    shouldFeedbackDeleteClearSync,
    shouldFeedbackSyncClearDelete,
    shouldReplaceHistoryFeedbackDeletePayload,
    upsertHistoryFeedbackDeleteQueue,
    upsertHistoryFeedbackSyncQueue,
    type HistoryFeedbackDeletePayload,
    type HistoryFeedbackTarget,
    type HistoryFeedbackSyncInput,
    type HistoryFeedbackSyncPayload
} from '@/lib/history-feedback-sync';
import {
    buildCompletedHistoryEntry,
    buildFailedHistoryEntry,
    buildHistoryGenerationFormData,
    isSameHistoryEntry,
    normalizeHistoryEntries,
    readHistoryImageCountSelection,
    readHistorySizeSelection,
    resolveHistoryImageClientRequestId,
    uniqueStrings,
    type HistoryMetadata,
    type RequestMode,
    type ResultFeedbackValue,
    updateHistoryResultFeedback
} from '@/lib/history-metadata';
import { useI18n } from '@/lib/i18n';
import { MAX_PROMPT_LENGTH } from '@/lib/image-request-limits';
import {
    IMAGE_UPSTREAM_FORM_SERVER_DEFAULT,
    appendImageUpstreamOverrideFields,
    normalizeImageUpstreamRuntimeFields,
    shouldAllowResponsesImageBackend,
    shouldAllowResponsesHistoryRoute,
    shouldBlockResponsesRequestWithoutModel,
    shouldBlockExplicitResponsesRequest,
    type ImageUpstreamFormBackend
} from '@/lib/image-upstream-form';
import {
    clampIntegerToRange,
    getImageBackendCompatibility,
    IMAGE_UPSTREAM_PROFILES,
    summarizeImageUpstreamProfile,
    type ImageUpstreamProfile,
    type ImageUpstreamProfileId,
    type PartialImagesCount
} from '@/lib/image-upstream-profile';
import type { ImageStreamMode, ImageStreamingStrategy } from '@/lib/image-upstream-strategy';
import { resolveMobileCreationSheetGesture } from '@/lib/mobile-creation-sheet-gesture';
import { resolveMobilePrimaryDisabledReason } from '@/lib/mobile-primary-action-state';
import { DEFAULT_MODEL_OPTIONS, resolveModelDirectoryOptions } from '@/lib/model-directory-options';
import { hasPreservedDisplayedAuthError, isPagePasswordAuthErrorCode } from '@/lib/page-password-auth';
import { resolveResultActionState } from '@/lib/result-action-state';
import { resolveRuntimeHealthStatus, type RuntimeHealthStatus } from '@/lib/runtime-health-status';
import { sha256Hex } from '@/lib/sha256';
import { createImageShareFromBlob } from '@/lib/share-client';
import {
    getPresetDimensions,
    shouldUsePositiveIntegerImageSize,
    validateGptImage2Size,
    validatePositiveIntegerImageSize
} from '@/lib/size-utils';
import {
    applyStreamingClientEvent,
    BatchPausedError,
    buildStreamingBatchJobs,
    canUseStreamingBatchTransport,
    resolveStreamingBatchCapacity,
    resolveStreamingBatchToggleState,
    scheduleStreamingBatch,
    shouldUseStreamingBatch,
    type ApiImageResponseItem,
    type StreamingBatchJob,
    type StreamingClientEvent,
    type StreamingClientState
} from '@/lib/streaming-batch';
import { getStreamingStatusLabel } from '@/lib/streaming-status-label';
import type { ActualCostDetails } from '@/lib/upstream-cost/resolve';
import { cn } from '@/lib/utils';
import {
    mergeWebuiImageRetentionResults,
    readWebuiImageFileOperationResults,
    readWebuiImageRetentionFilenames,
    type WebuiImageRetentionAction
} from '@/lib/webui-image-retention-client';
import { createZipBlob } from '@/lib/zip-export';
import { useLiveQuery } from 'dexie-react-hooks';
import { Activity, ArrowUp, Loader2, Lock, Pause, PenLine, Settings2, X } from 'lucide-react';
import * as React from 'react';

type DrawnPoint = {
    x: number;
    y: number;
    size: number;
};

type MobileDrawerPointerStart = {
    x: number;
    y: number;
};

const apiSettingsLocalStorageKey = 'openaiImageApiSettings';
const inspirationsLocalStorageKey = 'openaiImageInspirations';
const resultFeedbackSyncQueueLocalStorageKey = 'openaiImageResultFeedbackSyncQueue';
const resultFeedbackDeleteQueueLocalStorageKey = 'openaiImageResultFeedbackDeleteQueue';
const emptyApiSettings: ApiSettings = { apiKey: '', baseUrl: '' };
const sseEventDelimiterPattern = /\r?\n\r?\n/;
const feedbackApiTargetBatchSize = 20;
const resultFeedbackSyncQueueMaxItems = 100;
const resultFeedbackDeleteQueueMaxItems = 100;
const completedResultFeedbackSyncKeyMaxItems = 1000;
const resultFeedbackSyncMaxAttempts = 3;
const resultFeedbackSyncRetryDelaysMs = [1000, 3000] as const;
const resultFeedbackDeleteMaxAttempts = 3;
const resultFeedbackDeleteRetryDelaysMs = [1000, 3000] as const;
const resultFeedbackRequestTimeoutMs = 10_000;
const emptyPermanentFilenames: ReadonlySet<string> = new Set();
const mobileCreationDrawerFocusableSelector =
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const mobileCreationDrawerPortalSelector =
    '[data-slot="select-content"], [role="listbox"], [role="menu"], [role="dialog"]:not(#mobile-creation-sheet)';

type ApiCallRetryArgs = [
    GenerationFormData | EditingFormData,
    RequestMode,
    ImageStreamMode,
    PartialImagesCount,
    boolean
];
type PasswordVerificationResult = 'valid' | 'invalid' | 'unavailable';
type FeedbackSyncInput = HistoryFeedbackSyncInput;
type FeedbackSyncPayload = HistoryFeedbackSyncPayload;
type FeedbackSyncScheduleOptions = {
    pruneQueuedTargets?: boolean;
};
type StoredApiSettingsReadResult = {
    settings: ApiSettings;
    shouldPersist: boolean;
    shouldRemove: boolean;
};

function createFeedbackRequestSignal(signal: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), resultFeedbackRequestTimeoutMs);
    const abortFromCaller = () => controller.abort();
    if (signal.aborted) {
        abortFromCaller();
    } else {
        signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            window.clearTimeout(timeoutId);
            signal.removeEventListener('abort', abortFromCaller);
        }
    };
}

function getWorkbenchRouteLabel(backend: ImageUpstreamFormBackend, t: (key: string) => string): string {
    if (backend === 'images-api') return t('upstream.backendImages');
    if (backend === 'responses-image-generation') return t('upstream.backendResponses');
    return t('upstream.workbenchDefaultRoute');
}

function getMobileCreationDrawerFocusableElements(root: ParentNode): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(mobileCreationDrawerFocusableSelector)).filter(
        (element) => element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"], [inert]')
    );
}

function haveHistoryFeedbackTargetOverlap(left: HistoryFeedbackTarget[], right: HistoryFeedbackTarget[]): boolean {
    const rightIds = new Set(right.map((target) => target.id));
    return left.some((target) => rightIds.has(target.id));
}

function rememberCompletedResultFeedbackSyncKey(keys: Set<string>, key: string): void {
    keys.delete(key);
    keys.add(key);
    while (keys.size > completedResultFeedbackSyncKeyMaxItems) {
        const oldestKey = keys.values().next().value;
        if (typeof oldestKey !== 'string') return;
        keys.delete(oldestKey);
    }
}

function createClientRequestId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return `web-${crypto.randomUUID()}`;
    }
    return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readLocalStorageValue(key: string): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
}

function readStoredHistory(): HistoryMetadata[] {
    const storedHistory = readLocalStorageValue('openaiImageHistory');
    if (!storedHistory) return [];
    try {
        const parsedHistory: unknown = JSON.parse(storedHistory);
        if (Array.isArray(parsedHistory)) return normalizeHistoryEntries(parsedHistory as HistoryMetadata[]);
        console.warn('localStorage 中发现无效历史记录数据。');
        window.localStorage.removeItem('openaiImageHistory');
    } catch (e) {
        console.error('加载或解析 localStorage 历史记录失败：', e);
        window.localStorage.removeItem('openaiImageHistory');
    }
    return [];
}

function normalizeStoredApiSettings(settings: Partial<ApiSettings>): StoredApiSettingsReadResult {
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
    const baseUrl = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim() : '';
    if (!apiKey && !baseUrl) {
        return { settings: emptyApiSettings, shouldPersist: false, shouldRemove: true };
    }
    if (!apiKey && baseUrl) {
        return { settings: emptyApiSettings, shouldPersist: false, shouldRemove: true };
    }
    const normalizedSettings: ApiSettings = { apiKey, baseUrl };
    return {
        settings: normalizedSettings,
        shouldPersist: normalizedSettings.apiKey !== settings.apiKey || normalizedSettings.baseUrl !== settings.baseUrl,
        shouldRemove: false
    };
}

function readStoredApiSettings(): StoredApiSettingsReadResult {
    const storedApiSettings = readLocalStorageValue(apiSettingsLocalStorageKey);
    if (!storedApiSettings) {
        return { settings: emptyApiSettings, shouldPersist: false, shouldRemove: false };
    }
    try {
        const parsedSettings = JSON.parse(storedApiSettings) as Partial<ApiSettings>;
        return normalizeStoredApiSettings(parsedSettings);
    } catch (error) {
        console.error('从 localStorage 加载 API 设置失败：', error);
        window.localStorage.removeItem(apiSettingsLocalStorageKey);
        return { settings: emptyApiSettings, shouldPersist: false, shouldRemove: false };
    }
}

type StoredInspirationsReadResult = {
    items: InspirationItem[];
    shouldPersist: boolean;
    shouldRemove: boolean;
};

function readStoredInspirations(): StoredInspirationsReadResult {
    const storedInspirations = readLocalStorageValue(inspirationsLocalStorageKey);
    if (!storedInspirations) {
        return { items: [], shouldPersist: false, shouldRemove: false };
    }
    try {
        const parsedInspirations: unknown = JSON.parse(storedInspirations);
        if (!Array.isArray(parsedInspirations)) {
            return { items: [], shouldPersist: false, shouldRemove: true };
        }
        const validInspirations = parsedInspirations.filter(
            (item): item is InspirationItem =>
                item !== null &&
                typeof item === 'object' &&
                typeof (item as InspirationItem).id === 'number' &&
                typeof (item as InspirationItem).prompt === 'string' &&
                typeof (item as InspirationItem).createdAt === 'number'
        );
        const migratedInspirations = validInspirations.filter((item) => !(item.id < 0 && item.createdAt === 0));
        return {
            items: migratedInspirations,
            shouldPersist: migratedInspirations.length !== parsedInspirations.length,
            shouldRemove: false
        };
    } catch (error) {
        console.error('加载或解析灵感相册失败：', error);
        return { items: [], shouldPersist: false, shouldRemove: true };
    }
}

function readStoredDeletePreference(): boolean {
    return readLocalStorageValue('imageGenSkipDeleteConfirm') === 'true';
}

function getMimeTypeFromFormat(format: string): string {
    if (format === 'jpeg') return 'image/jpeg';
    if (format === 'webp') return 'image/webp';

    return 'image/png';
}

const explicitModeClient = process.env.NEXT_PUBLIC_IMAGE_STORAGE_MODE;

const vercelEnvClient = process.env.NEXT_PUBLIC_VERCEL_ENV;
const isOnVercelClient = vercelEnvClient === 'production' || vercelEnvClient === 'preview';

let effectiveStorageModeClient: 'fs' | 'indexeddb';

if (explicitModeClient === 'fs') {
    effectiveStorageModeClient = 'fs';
} else if (explicitModeClient === 'indexeddb') {
    effectiveStorageModeClient = 'indexeddb';
} else if (isOnVercelClient) {
    effectiveStorageModeClient = 'indexeddb';
} else {
    effectiveStorageModeClient = 'fs';
}

type ApiImageResult = {
    path: string;
    filename: string;
    clientRequestId?: string;
    storageMode?: HistoryMetadata['storageModeUsed'];
};

type ImageStorageMode = NonNullable<HistoryMetadata['storageModeUsed']>;

type ApiUsage = {
    input_tokens_details?: {
        text_tokens?: number;
        image_tokens?: number;
    };
    output_tokens?: number;
};

type RuntimeCapabilities = {
    imageModel?: {
        defaultModel?: string;
    };
    streaming?: {
        defaultBackend?: 'images-api' | 'responses-image-generation';
        defaultMode?: ImageStreamMode;
        defaultStrategy?: ImageStreamingStrategy;
    };
    streamingBatch: {
        enabled: boolean;
        recommendedConcurrency: number;
        requestCredentialConcurrency: number;
        channelCount?: number;
        healthyChannelCount?: number;
        unhealthyChannelCount?: number;
        lastFailure?: {
            at: number;
            scope: 'credential' | 'channel';
            status?: number;
            code?: string;
            requestId?: string;
            requestMode?: string;
        };
    };
    responsesImageBackend?: {
        enabled: boolean;
        mode?: 'experimental';
        requiredEnv?: string[];
        optionalEnv?: string[];
        hasDefaultModel?: boolean;
        missingEnv?: string[];
    };
    channelRouting?: {
        effectiveRequestModes?: string[];
        requestModeHealth?: Array<{
            mode: string;
            configuredCredentialCount: number;
            healthyCredentialCount: number;
            configuredChannelCount: number;
            healthyChannelCount: number;
        }>;
        effectiveRequestModesByChannel?: Array<{
            channelId: string;
            requestModes: string[];
        }>;
    };
    upstreamProfile?: {
        activeProfile: ImageUpstreamProfileId;
        serverProfile: ImageUpstreamProfileId;
        serverProfileMixed: boolean;
        requestProfile: ImageUpstreamProfileId;
        activeConstraints?: ImageUpstreamProfile;
    };
    webuiImageCleanup?: {
        enabled: boolean;
        retentionDays?: number;
        intervalMs?: number;
    };
};

type LoadedWebuiImageRetentionState = {
    scopeKey: string;
    filenames: Set<string>;
};

class ApiRequestError extends Error {
    readonly status?: number;
    readonly code?: string;
    readonly preserveDisplayedError: boolean;

    constructor(message: string, status?: number, options: { preserveDisplayedError?: boolean; code?: string } = {}) {
        super(message);
        this.name = 'ApiRequestError';
        this.status = status;
        this.code = options.code;
        this.preserveDisplayedError = options.preserveDisplayedError === true;
    }
}

function getLocalizedImageRequestError(t: ReturnType<typeof useI18n>['t'], status: number | undefined): string {
    if (status === 400) return t('error.invalidRequest');
    if (status === undefined) return t('error.streaming');
    return t('error.apiFailed', { status });
}

function getLocalizedImageDimensionMismatchError(
    t: ReturnType<typeof useI18n>['t'],
    expected: string | undefined,
    actual: string | null | undefined
): string {
    return t('error.imageDimensionMismatch', {
        expected: expected || t('error.unknownTargetSize'),
        actual: actual || t('error.unknownActualSize')
    });
}

function summarizeApiError(
    error: unknown,
    fallbackMessage: string,
    t: ReturnType<typeof useI18n>['t']
): { message: string; status?: number; code?: string } {
    if (error instanceof ApiRequestError) {
        return { message: error.message, status: error.status, code: error.code };
    }
    if (error instanceof BatchPausedError) {
        return { message: t('batch.pausedFailure') };
    }
    return { message: fallbackMessage };
}

function renderErrorDescription(error: ApiErrorNotice): React.ReactNode {
    return (
        <div className='grid gap-2'>
            <p>{error.message}</p>
            {error.links.map((link) => (
                <a
                    className='border-destructive/45 text-destructive hover:bg-destructive/10 w-fit rounded-md border px-2 py-1 font-medium underline-offset-2 hover:underline'
                    href={link.url}
                    key={link.url}
                    rel='noreferrer'
                    target='_blank'>
                    {link.label}
                </a>
            ))}
        </div>
    );
}

function mergeUsageValues(usages: unknown[]): ApiUsage | undefined {
    const merged: ApiUsage = {
        input_tokens_details: {
            text_tokens: 0,
            image_tokens: 0
        },
        output_tokens: 0
    };
    let hasUsage = false;

    usages.forEach((usage) => {
        if (!usage || typeof usage !== 'object') return;
        const candidate = usage as ApiUsage;
        const textTokens = candidate.input_tokens_details?.text_tokens;
        const imageTokens = candidate.input_tokens_details?.image_tokens;
        const outputTokens = candidate.output_tokens;
        if (typeof textTokens === 'number') {
            merged.input_tokens_details!.text_tokens! += textTokens;
            hasUsage = true;
        }
        if (typeof imageTokens === 'number') {
            merged.input_tokens_details!.image_tokens! += imageTokens;
            hasUsage = true;
        }
        if (typeof outputTokens === 'number') {
            merged.output_tokens! += outputTokens;
            hasUsage = true;
        }
    });

    return hasUsage ? merged : undefined;
}

function mergeActualCostValues(costs: Array<ActualCostDetails | undefined>): ActualCostDetails | undefined {
    const present = costs.filter((cost): cost is ActualCostDetails => cost !== undefined);
    if (present.length === 0) return undefined;

    const actualCosts = present.filter((cost) => cost.source === 'new-api-log-token');
    if (actualCosts.length === present.length) {
        const actualQuota = actualCosts.reduce((sum, cost) => sum + (cost.actualQuota ?? 0), 0);
        const actualAmount = actualCosts.reduce((sum, cost) => sum + (cost.actualAmount ?? 0), 0);
        return {
            actualAmount: Math.round(actualAmount * 1_000_000) / 1_000_000,
            actualQuota,
            currency: 'usd-equivalent',
            source: 'new-api-log-token',
            confidence: actualCosts.every((cost) => cost.confidence === 'high') ? 'high' : 'low',
            upstreamProvider: 'new-api',
            reason: actualCosts.length > 1 ? `已汇总 ${actualCosts.length} 个子请求的实际扣费。` : undefined
        };
    }

    return {
        currency: 'usd-equivalent',
        source: 'unavailable',
        confidence: 'low',
        upstreamProvider: 'new-api',
        reason: '批量请求中存在未匹配到实际扣费的子请求，未将估算值标记为实际扣费。'
    };
}

export default function HomePage() {
    const { locale, t } = useI18n();
    const createErrorNotice = React.useCallback((message: string) => buildApiErrorNotice(message), []);
    const [mode, setMode] = React.useState<'generate' | 'edit'>('generate');
    const [workbenchMode, setWorkbenchMode] = React.useState<WorkbenchMode>('generate');
    const [reuseContext, setReuseContext] = React.useState<WorkbenchReuseContext | null>(null);
    const [editReuseContext, setEditReuseContext] = React.useState<EditingReuseContext | null>(null);
    const [isPasswordRequiredByBackend, setIsPasswordRequiredByBackend] = React.useState<boolean | null>(null);
    const [clientPasswordHash, setClientPasswordHash] = React.useState<string | null>(null);
    const [isEntryAuthenticated, setIsEntryAuthenticated] = React.useState(false);
    const [isLoading, setIsLoading] = React.useState(false);
    const [isSendingToEdit, setIsSendingToEdit] = React.useState(false);
    const [error, setError] = React.useState<ApiErrorNotice | null>(null);
    const [generationFailureMessage, setGenerationFailureMessage] = React.useState<string | null>(null);
    const [failedBatchPrompts, setFailedBatchPrompts] = React.useState<string[]>([]);
    const [latestImageBatch, setLatestImageBatch] = React.useState<ApiImageResult[] | null>(null);
    const [activeResultSource, setActiveResultSource] = React.useState<HistoryMetadata | null>(null);
    const [completedGenerationCount, setCompletedGenerationCount] = React.useState<number | null>(null);
    const [imageOutputView, setImageOutputView] = React.useState<'grid' | number>('grid');
    const [history, setHistory] = React.useState<HistoryMetadata[]>([]);
    const [inspirations, setInspirations] = React.useState<InspirationItem[]>([]);
    const hasLoadedStoredHistoryRef = React.useRef(false);
    const hasProcessedQueuedResultFeedbackDeletesRef = React.useRef(false);
    const hasProcessedQueuedResultFeedbackSyncsRef = React.useRef(false);
    const scheduledResultFeedbackSyncKeysRef = React.useRef<Set<string>>(new Set());
    const scheduledResultFeedbackSyncPayloadsRef = React.useRef<Map<string, FeedbackSyncPayload>>(new Map());
    const completedResultFeedbackSyncKeysRef = React.useRef<Set<string>>(new Set());
    const scheduledResultFeedbackDeleteKeysRef = React.useRef<Set<string>>(new Set());
    const scheduledResultFeedbackDeletePayloadsRef = React.useRef<Map<string, HistoryFeedbackDeletePayload>>(new Map());
    const scheduleResultFeedbackDeletePayloadRef = React.useRef<
        ((payload: HistoryFeedbackDeletePayload) => void) | null
    >(null);
    const resultFeedbackRetryTimersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const resultFeedbackSyncAbortControllersRef = React.useRef<Map<string, AbortController>>(new Map());
    const resultFeedbackDeleteAbortControllersRef = React.useRef<Map<string, AbortController>>(new Map());
    const blobUrlCacheRef = React.useRef<Map<string, string>>(new Map());
    const [isPasswordDialogOpen, setIsPasswordDialogOpen] = React.useState(false);
    const [isApiSettingsDialogOpen, setIsApiSettingsDialogOpen] = React.useState(false);
    const [apiSettings, setApiSettings] = React.useState<ApiSettings>(emptyApiSettings);
    const [runtimeCapabilities, setRuntimeCapabilities] = React.useState<RuntimeCapabilities | null>(null);
    const [modelOptions, setModelOptions] = React.useState<string[]>([...DEFAULT_MODEL_OPTIONS]);
    const modelProbeKeysRef = React.useRef<Set<string>>(new Set());
    const modelProbeGenerationRef = React.useRef(0);
    const modelDirectoryResolvedRef = React.useRef(false);
    const modelDirectoryOptionsRef = React.useRef<string[]>([...DEFAULT_MODEL_OPTIONS]);
    const [isRuntimeCapabilitiesLoading, setIsRuntimeCapabilitiesLoading] = React.useState(true);
    const [loadedWebuiImageRetentionState, setLoadedWebuiImageRetentionState] =
        React.useState<LoadedWebuiImageRetentionState | null>(null);
    const [passwordDialogContext, setPasswordDialogContext] = React.useState<'initial' | 'retry'>('initial');
    const [lastApiCallArgs, setLastApiCallArgs] = React.useState<ApiCallRetryArgs | null>(null);
    const [skipDeleteConfirmation, setSkipDeleteConfirmation] = React.useState<boolean>(false);
    const [itemToDeleteConfirm, setItemToDeleteConfirm] = React.useState<HistoryMetadata | null>(null);
    const [dialogCheckboxStateSkipConfirm, setDialogCheckboxStateSkipConfirm] = React.useState<boolean>(false);
    const [openLogsSignal, setOpenLogsSignal] = React.useState(0);
    const [shareDialogOpen, setShareDialogOpen] = React.useState(false);
    const [shareTargetFilename, setShareTargetFilename] = React.useState<string | null>(null);
    const [shareTargetStorageMode, setShareTargetStorageMode] = React.useState<HistoryMetadata['storageModeUsed']>();
    const [shareUrl, setShareUrl] = React.useState<string | null>(null);
    const [shareError, setShareError] = React.useState<string | null>(null);
    const [isCreatingShare, setIsCreatingShare] = React.useState(false);
    const [shareDialogSessionId, setShareDialogSessionId] = React.useState(0);
    const [isMobileCreationDrawerOpen, setIsMobileCreationDrawerOpen] = React.useState(false);
    const outputPanelRef = React.useRef<HTMLDivElement | null>(null);
    const mobileCreationDrawerCloseButtonRef = React.useRef<HTMLButtonElement | null>(null);
    const mobileCreationDrawerTriggerRef = React.useRef<HTMLButtonElement | null>(null);
    const mobileCreationDrawerFocusTargetRef = React.useRef<'trigger' | 'output' | null>(null);
    const pendingWorkbenchModeFocusRef = React.useRef<WorkbenchMode | null>(null);
    const apiSettingsDialogTriggerRef = React.useRef<HTMLButtonElement | null>(null);
    const sendingToEditRef = React.useRef(false);
    const mobileDrawerPointerStartRef = React.useRef<MobileDrawerPointerStart | null>(null);
    const mobileDrawerGestureHandledAtRef = React.useRef(0);

    const allDbImages = useLiveQuery<ImageRecord[] | undefined>(() => db.images.toArray(), []);

    const [editImageFiles, setEditImageFiles] = React.useState<File[]>([]);
    const [editSourceImagePreviewUrls, setEditSourceImagePreviewUrlsState] = React.useState<string[]>([]);
    const editSourceImagePreviewUrlsRef = React.useRef<string[]>([]);
    const updateEditSourceImagePreviewUrls = React.useCallback((nextUrls: string[]) => {
        const nextUrlSet = new Set(nextUrls);
        editSourceImagePreviewUrlsRef.current.forEach((url) => {
            if (!nextUrlSet.has(url)) {
                URL.revokeObjectURL(url);
            }
        });
        editSourceImagePreviewUrlsRef.current = nextUrls;
        setEditSourceImagePreviewUrlsState(nextUrls);
    }, []);
    const [editPrompt, setEditPrompt] = React.useState('');
    const [editN, setEditN] = React.useState([1]);
    const [editSize, setEditSize] = React.useState<EditingFormData['size']>('auto');
    const [editCustomWidth, setEditCustomWidth] = React.useState<number>(1024);
    const [editCustomHeight, setEditCustomHeight] = React.useState<number>(1024);
    const [editQuality, setEditQuality] = React.useState<EditingFormData['quality']>('auto');
    const [editOutputFormat, setEditOutputFormat] = React.useState<EditingFormData['output_format']>('webp');
    const [editCompression, setEditCompression] = React.useState([100]);
    const [editModeration, setEditModeration] = React.useState<EditingFormData['moderation']>('auto');
    const [editBrushSize, setEditBrushSize] = React.useState([20]);
    const [editShowMaskEditor, setEditShowMaskEditor] = React.useState(false);
    const [editGeneratedMaskFile, setEditGeneratedMaskFile] = React.useState<File | null>(null);
    const [editIsMaskSaved, setEditIsMaskSaved] = React.useState(false);
    const [editOriginalImageSize, setEditOriginalImageSize] = React.useState<{ width: number; height: number } | null>(
        null
    );
    const [editDrawnPoints, setEditDrawnPoints] = React.useState<DrawnPoint[]>([]);
    const [editMaskPreviewUrl, setEditMaskPreviewUrl] = React.useState<string | null>(null);
    const [editImageBackend, setEditImageBackend] = React.useState<EditingFormData['image_backend']>(
        IMAGE_UPSTREAM_FORM_SERVER_DEFAULT
    );
    const [editStreamingStrategy, setEditStreamingStrategy] = React.useState<EditingFormData['streaming_strategy']>(
        IMAGE_UPSTREAM_FORM_SERVER_DEFAULT
    );
    const [editResponsesModel, setEditResponsesModel] = React.useState('');
    const [editThinking, setEditThinking] = React.useState<EditingFormData['thinking']>(
        IMAGE_UPSTREAM_FORM_SERVER_DEFAULT
    );
    const [editPromptOptimization, setEditPromptOptimization] = React.useState<EditingFormData['promptOptimization']>(
        IMAGE_UPSTREAM_FORM_SERVER_DEFAULT
    );
    const [editForceWeb, setEditForceWeb] = React.useState(false);

    const [genModel, setGenModel] = React.useState<GenerationFormData['model']>('gpt-image-2');
    const [genPrompt, setGenPrompt] = React.useState('');
    const [genBatchPromptText, setGenBatchPromptText] = React.useState('');
    const [genN, setGenN] = React.useState([1]);
    const [genSize, setGenSize] = React.useState<GenerationFormData['size']>('auto');
    const [genCustomWidth, setGenCustomWidth] = React.useState<number>(1024);
    const [genCustomHeight, setGenCustomHeight] = React.useState<number>(1024);
    const [genQuality, setGenQuality] = React.useState<GenerationFormData['quality']>('high');
    const [genOutputFormat, setGenOutputFormat] = React.useState<GenerationFormData['output_format']>('webp');
    const [genCompression, setGenCompression] = React.useState([100]);
    const [genBackground, setGenBackground] = React.useState<GenerationFormData['background']>('auto');
    const [genModeration, setGenModeration] = React.useState<GenerationFormData['moderation']>('auto');
    const [genImageBackend, setGenImageBackend] = React.useState<GenerationFormData['image_backend']>(
        IMAGE_UPSTREAM_FORM_SERVER_DEFAULT
    );
    const [genStreamingStrategy, setGenStreamingStrategy] = React.useState<GenerationFormData['streaming_strategy']>(
        IMAGE_UPSTREAM_FORM_SERVER_DEFAULT
    );
    const [genResponsesModel, setGenResponsesModel] = React.useState('');
    const [genThinking, setGenThinking] = React.useState<GenerationFormData['thinking']>(
        IMAGE_UPSTREAM_FORM_SERVER_DEFAULT
    );
    const [genPromptOptimization, setGenPromptOptimization] = React.useState<GenerationFormData['promptOptimization']>(
        IMAGE_UPSTREAM_FORM_SERVER_DEFAULT
    );
    const [genForceWeb, setGenForceWeb] = React.useState(false);

    const [editModel, setEditModel] = React.useState<EditingFormData['model']>('gpt-image-2');
    const genModelExplicitSelectionRef = React.useRef(false);
    const editModelExplicitSelectionRef = React.useRef(false);
    const handleGenModelChange = React.useCallback<React.Dispatch<React.SetStateAction<GenerationFormData['model']>>>(
        (nextModel) => {
            genModelExplicitSelectionRef.current = true;
            setGenModel(nextModel);
        },
        []
    );
    const handleEditModelChange = React.useCallback<React.Dispatch<React.SetStateAction<EditingFormData['model']>>>(
        (nextModel) => {
            editModelExplicitSelectionRef.current = true;
            setEditModel(nextModel);
        },
        []
    );

    // 流式状态，由生成和编辑模式共用。
    const [streamMode, setStreamMode] = React.useState<ImageStreamMode>('auto');
    const [partialImages, setPartialImages] = React.useState<PartialImagesCount>(1);
    const [enableParallelBatch, setEnableParallelBatch] = React.useState(false);
    const [activeRequestStreaming, setActiveRequestStreaming] = React.useState(false);
    // 流式预览图，存储流式过程中的局部图片 base64 data URL。
    const [streamingPreviewImages, setStreamingPreviewImages] = React.useState<Map<number, string>>(new Map());
    const [batchProgress, setBatchProgress] = React.useState<GenerationBatchProgress | null>(null);
    const [isBatchPauseRequested, setIsBatchPauseRequested] = React.useState(false);
    const batchPauseRequestedRef = React.useRef(false);
    const cleanupEnabled = runtimeCapabilities?.webuiImageCleanup?.enabled === true;
    const retentionScopeKey =
        cleanupEnabled && isPasswordRequiredByBackend !== null && (!isPasswordRequiredByBackend || isEntryAuthenticated)
            ? `webui-image-retention:${isPasswordRequiredByBackend ? 'authenticated' : 'public'}`
            : null;
    const permanentlySavedFilenames =
        loadedWebuiImageRetentionState?.scopeKey === retentionScopeKey
            ? loadedWebuiImageRetentionState.filenames
            : null;
    const retentionControlsEnabled = cleanupEnabled && permanentlySavedFilenames !== null;
    const defaultStreamingStrategy = runtimeCapabilities?.streaming?.defaultStrategy ?? 'auto';
    const defaultImageBackend = runtimeCapabilities?.streaming?.defaultBackend;
    const activeUpstreamProfileSummary = summarizeImageUpstreamProfile({
        requestApiBaseUrl: apiSettings.baseUrl,
        serverProfileIds: runtimeCapabilities?.upstreamProfile
            ? [runtimeCapabilities.upstreamProfile.serverProfile]
            : []
    });
    const hasRequestApiKey = apiSettings.apiKey.trim().length > 0;
    const hasRequestApiOverride = hasRequestApiKey;
    const activeUpstreamProfile = hasRequestApiOverride
        ? activeUpstreamProfileSummary.activeConstraints
        : runtimeCapabilities?.upstreamProfile?.activeConstraints || IMAGE_UPSTREAM_PROFILES['openai-compatible'];
    const activeUpstreamProfileMixed =
        !hasRequestApiOverride && runtimeCapabilities?.upstreamProfile?.serverProfileMixed === true;
    const allowResponsesImageBackend = shouldAllowResponsesImageBackend({
        runtimeCapabilities,
        hasRequestApiOverride
    });
    const allowResponsesHistoryRoute = shouldAllowResponsesHistoryRoute({
        runtimeCapabilitiesAvailable: runtimeCapabilities !== null,
        allowResponsesImageBackend
    });
    const hasDefaultResponsesModel = runtimeCapabilities?.responsesImageBackend?.hasDefaultModel === true;
    const streamingBatchCapacity = resolveStreamingBatchCapacity({
        featureEnabled: runtimeCapabilities?.streamingBatch.enabled === true,
        hasRequestApiKey: apiSettings.apiKey.trim().length > 0,
        requestCredentialConcurrency: runtimeCapabilities?.streamingBatch.requestCredentialConcurrency ?? 1,
        serverRecommendedConcurrency: runtimeCapabilities?.streamingBatch.recommendedConcurrency ?? 0
    });
    const streamingBatchEnabled = streamingBatchCapacity.enabled;
    const isPromptBatchMode = mode === 'generate' && workbenchMode === 'batch';
    const activeBatchPrompts = React.useMemo(
        () => (isPromptBatchMode ? readBatchPromptLines(genBatchPromptText) : []),
        [genBatchPromptText, isPromptBatchMode]
    );
    const activeBatchPromptOverLimitIndex = React.useMemo(
        () => findBatchPromptOverLimitIndex(activeBatchPrompts, MAX_PROMPT_LENGTH),
        [activeBatchPrompts]
    );
    const currentPrompt =
        mode === 'generate' && workbenchMode === 'batch'
            ? genBatchPromptText
            : mode === 'generate'
              ? genPrompt
              : editPrompt;
    const hasEditSourceImage = editImageFiles.length > 0;
    const maxEditSourceImages = activeUpstreamProfile.upload.maxImages;
    const editSourceValidationFailure = React.useMemo(
        () =>
            validateEditSourceInput({
                imageFiles: editImageFiles,
                maskFile: editGeneratedMaskFile,
                upstreamProfile: activeUpstreamProfile,
                imageBackend: editImageBackend,
                defaultImageBackend
            }),
        [activeUpstreamProfile, defaultImageBackend, editGeneratedMaskFile, editImageBackend, editImageFiles]
    );
    const editSourceValidationMessage = editSourceValidationFailure
        ? formatEditSourceValidationFailure(editSourceValidationFailure, t)
        : '';
    const generateUsesPositiveIntegerCustomSize = shouldUsePositiveIntegerImageSize(genModel, activeUpstreamProfile);
    const editUsesPositiveIntegerCustomSize = shouldUsePositiveIntegerImageSize(editModel, activeUpstreamProfile);
    const currentGenerateSizeValidation =
        genSize === 'custom'
            ? generateUsesPositiveIntegerCustomSize
                ? validatePositiveIntegerImageSize(genCustomWidth, genCustomHeight)
                : validateGptImage2Size(genCustomWidth, genCustomHeight)
            : { valid: true as const };
    const currentEditSizeValidation =
        editSize === 'custom'
            ? editUsesPositiveIntegerCustomSize
                ? validatePositiveIntegerImageSize(editCustomWidth, editCustomHeight)
                : validateGptImage2Size(editCustomWidth, editCustomHeight)
            : { valid: true as const };
    const canOpenLogs = isPasswordRequiredByBackend === true && !!clientPasswordHash;
    const usesEditControls = workbenchMode === 'edit';
    const activeWorkbenchModel = usesEditControls ? editModel : genModel;
    const activeWorkbenchBackend = usesEditControls ? editImageBackend : genImageBackend;
    const activeWorkbenchStreamingStrategy = usesEditControls ? editStreamingStrategy : genStreamingStrategy;
    const activeEffectiveStreamingStrategy =
        activeWorkbenchStreamingStrategy === IMAGE_UPSTREAM_FORM_SERVER_DEFAULT
            ? defaultStreamingStrategy
            : activeWorkbenchStreamingStrategy;
    const activeRouteLabel = getWorkbenchRouteLabel(activeWorkbenchBackend, t);
    const activeRuntimeHealthStatus: RuntimeHealthStatus = resolveRuntimeHealthStatus({
        runtimeCapabilities,
        isRuntimeCapabilitiesLoading,
        hasRequestApiOverride,
        imageBackend: activeWorkbenchBackend,
        hasRequestResponsesModel: (usesEditControls ? editResponsesModel : genResponsesModel).trim().length > 0,
        streamingStrategy: activeEffectiveStreamingStrategy,
        streamMode
    });
    const activeRequestedImageCount =
        mode === 'generate' && workbenchMode === 'batch'
            ? activeBatchPrompts.length
            : mode === 'generate'
              ? genN[0]
              : editN[0];
    const activeRequestSummaryLabel = t('workbench.requestSummary', {
        count: activeRequestedImageCount
    });
    const activeParallelBatchVisible = resolveStreamingBatchToggleState({
        allowStreamingBatch: streamingBatchEnabled,
        userEnabled: enableParallelBatch,
        targetCount: activeRequestedImageCount,
        streamMode,
        streamingStrategy: activeEffectiveStreamingStrategy
    }).checked;
    const hasRandomInspirationPrompt = inspirations.some((item) => item.prompt.trim().length > 0);
    const pickRandomInspirationPrompt = React.useCallback(() => {
        const savedPrompts = inspirations.map((item) => item.prompt.trim()).filter((prompt) => prompt.length > 0);
        if (savedPrompts.length === 0) return '';
        return savedPrompts[Math.floor(Math.random() * savedPrompts.length)] ?? '';
    }, [inspirations]);

    React.useEffect(() => {
        if (allowResponsesImageBackend || runtimeCapabilities === null) return;
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            setGenImageBackend((current) =>
                current === 'responses-image-generation' ? IMAGE_UPSTREAM_FORM_SERVER_DEFAULT : current
            );
            setEditImageBackend((current) =>
                current === 'responses-image-generation' ? IMAGE_UPSTREAM_FORM_SERVER_DEFAULT : current
            );
            setGenStreamingStrategy((current) =>
                current === 'responses-sse' ? IMAGE_UPSTREAM_FORM_SERVER_DEFAULT : current
            );
            setEditStreamingStrategy((current) =>
                current === 'responses-sse' ? IMAGE_UPSTREAM_FORM_SERVER_DEFAULT : current
            );
            setGenResponsesModel('');
            setEditResponsesModel('');
            setGenThinking(IMAGE_UPSTREAM_FORM_SERVER_DEFAULT);
            setEditThinking(IMAGE_UPSTREAM_FORM_SERVER_DEFAULT);
            setGenPromptOptimization(IMAGE_UPSTREAM_FORM_SERVER_DEFAULT);
            setEditPromptOptimization(IMAGE_UPSTREAM_FORM_SERVER_DEFAULT);
        });
        return () => {
            cancelled = true;
        };
    }, [allowResponsesImageBackend, runtimeCapabilities]);

    React.useEffect(() => {
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            const generationCompatibility = getImageBackendCompatibility(
                activeUpstreamProfile,
                'generate',
                genImageBackend,
                defaultImageBackend
            );
            const editCompatibility = getImageBackendCompatibility(
                activeUpstreamProfile,
                'edit',
                editImageBackend,
                defaultImageBackend
            );
            const generationCountRange = generationCompatibility.imageCountRange;
            const editCountRange = editCompatibility.imageCountRange;
            const activeCompatibility = usesEditControls ? editCompatibility : generationCompatibility;
            const activePartialImagesRange = activeCompatibility.partialImagesRange;
            if (!generationCountRange || !editCountRange || !activePartialImagesRange) return;
            if (partialImages < activePartialImagesRange.min || partialImages > activePartialImagesRange.max) {
                setPartialImages(clampIntegerToRange(partialImages, activePartialImagesRange) as PartialImagesCount);
            }
            if (genBackground === 'transparent' && !activeUpstreamProfile.gptImage2.allowTransparentBackground) {
                setGenBackground('auto');
            }
            setGenN((current) =>
                current[0] < generationCountRange.min || current[0] > generationCountRange.max
                    ? [clampIntegerToRange(current[0], generationCountRange)]
                    : current
            );
            setEditN((current) =>
                current[0] < editCountRange.min || current[0] > editCountRange.max
                    ? [clampIntegerToRange(current[0], editCountRange)]
                    : current
            );
        });
        return () => {
            cancelled = true;
        };
    }, [
        activeUpstreamProfile,
        defaultImageBackend,
        editImageBackend,
        editN,
        genBackground,
        genImageBackend,
        genN,
        partialImages,
        usesEditControls
    ]);
    const activeLogClientRequestIds = React.useMemo(() => {
        if (!latestImageBatch || latestImageBatch.length === 0) return [];
        if (typeof imageOutputView === 'number') {
            return uniqueStrings([latestImageBatch[imageOutputView]?.clientRequestId]);
        }
        return uniqueStrings(latestImageBatch.map((image) => image.clientRequestId));
    }, [imageOutputView, latestImageBatch]);
    const activeLogFilenames = React.useMemo(() => {
        if (!latestImageBatch || latestImageBatch.length === 0) return [];
        if (typeof imageOutputView === 'number') {
            return uniqueStrings([latestImageBatch[imageOutputView]?.filename]);
        }
        return uniqueStrings(latestImageBatch.map((image) => image.filename));
    }, [imageOutputView, latestImageBatch]);
    const generationActivityItems = React.useMemo(
        () =>
            buildGenerationActivityItems({
                isLoading,
                isSendingToEdit,
                mode,
                streamingPreviewCount: streamingPreviewImages.size,
                errorMessage: error?.message,
                completedGenerationCount,
                batchProgress,
                t
            }),
        [
            batchProgress,
            completedGenerationCount,
            error?.message,
            isLoading,
            isSendingToEdit,
            mode,
            streamingPreviewImages.size,
            t
        ]
    );
    const announcedGenerationActivity = selectAnnouncedGenerationActivity(generationActivityItems);
    const mobileBackendCompatibility = getImageBackendCompatibility(
        activeUpstreamProfile,
        mode,
        mode === 'generate' ? genImageBackend : editImageBackend,
        defaultImageBackend
    );
    const mobileBackendCompatibilityMessage = mobileBackendCompatibility.compatible
        ? ''
        : mobileBackendCompatibility.errors.map((error) => error.message).join(' ');
    const mobilePrimaryDisabledReason = resolveMobilePrimaryDisabledReason({
        isLoading,
        isSendingToEdit,
        mode,
        isBatchMode: workbenchMode === 'batch',
        prompt: currentPrompt,
        batchPromptCount: activeBatchPrompts.length,
        batchPromptOverLimitIndex: activeBatchPromptOverLimitIndex,
        hasEditSourceImage,
        editSourceValidationMessage,
        backendCompatibilityMessage: mobileBackendCompatibilityMessage,
        hasUnsavedMask: editDrawnPoints.length > 0 && !editGeneratedMaskFile && !editIsMaskSaved,
        imageBackend: mode === 'generate' ? genImageBackend : editImageBackend,
        responsesModel: mode === 'generate' ? genResponsesModel : editResponsesModel,
        hasDefaultResponsesModel,
        generateSizeValidation: currentGenerateSizeValidation,
        editSizeValidation: currentEditSizeValidation,
        t
    });
    const mobilePrimaryDisabled = isLoading || isSendingToEdit || Boolean(mobilePrimaryDisabledReason);
    const { canCreateVariant: canCreateResultVariant, canReusePrompt: canReuseResultPrompt } = resolveResultActionState(
        {
            isBusy: isLoading || isSendingToEdit,
            hasResultImages: Boolean(latestImageBatch?.length),
            currentMode: mode,
            currentPrompt,
            activeResultSource: activeResultSource
                ? { mode: activeResultSource.mode, prompt: activeResultSource.prompt }
                : null
        }
    );
    const canPausePromptBatch = isLoading && isPromptBatchMode && Boolean(batchProgress);

    const handleBatchPromptTextChange = React.useCallback((nextText: React.SetStateAction<string>) => {
        setGenBatchPromptText(nextText);
        setFailedBatchPrompts([]);
    }, []);

    const handlePauseBatch = React.useCallback(() => {
        batchPauseRequestedRef.current = true;
        setIsBatchPauseRequested(true);
    }, []);

    const handleWorkbenchModeChange = React.useCallback(
        (nextMode: WorkbenchMode) => {
            if (
                typeof document !== 'undefined' &&
                document.activeElement instanceof HTMLButtonElement &&
                document.activeElement.matches('[data-workbench-mode]')
            ) {
                pendingWorkbenchModeFocusRef.current = nextMode;
            }
            setWorkbenchMode(nextMode);
            if (nextMode !== 'reuse') {
                setReuseContext(null);
            }
            if (nextMode !== 'edit') {
                setEditReuseContext(null);
            }
            if (nextMode === 'edit') {
                setMode('edit');
                return;
            }
            if (nextMode === 'batch') {
                setGenN([1]);
                setGenBatchPromptText((current) => (current.trim() ? current : genPrompt));
            }
            setMode('generate');
        },
        [genPrompt]
    );

    React.useEffect(() => {
        const focusMode = pendingWorkbenchModeFocusRef.current;
        if (!focusMode || workbenchMode !== focusMode || typeof document === 'undefined') return;

        pendingWorkbenchModeFocusRef.current = null;
        const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-workbench-mode]')).find(
            (candidate) =>
                candidate.dataset.workbenchMode === focusMode &&
                candidate.getClientRects().length > 0 &&
                !candidate.closest('[aria-hidden="true"], [inert]')
        );
        if (tab) {
            tab.focus();
        }
    }, [mode, workbenchMode]);

    const scrollToOutput = React.useCallback(() => {
        const outputTop = outputPanelRef.current?.getBoundingClientRect().top;
        if (typeof outputTop !== 'number') return;
        window.scrollTo({
            top: window.scrollY + outputTop - 12,
            behavior: 'smooth'
        });
    }, []);

    const blurActiveMobileTrigger = React.useCallback(() => {
        if (typeof document === 'undefined') return;
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
    }, []);

    const openMobileCreationDrawer = React.useCallback(() => {
        blurActiveMobileTrigger();
        setIsMobileCreationDrawerOpen(true);
    }, [blurActiveMobileTrigger]);

    const closeMobileCreationDrawer = React.useCallback(() => {
        mobileCreationDrawerFocusTargetRef.current = 'trigger';
        blurActiveMobileTrigger();
        setIsMobileCreationDrawerOpen(false);
    }, [blurActiveMobileTrigger]);

    const closeMobileCreationDrawerAfterSubmit = React.useCallback(() => {
        if (!isMobileCreationDrawerOpen) {
            mobileCreationDrawerFocusTargetRef.current = null;
            blurActiveMobileTrigger();
            outputPanelRef.current?.focus();
            return;
        }
        mobileCreationDrawerFocusTargetRef.current = 'output';
        blurActiveMobileTrigger();
        setIsMobileCreationDrawerOpen(false);
    }, [blurActiveMobileTrigger, isMobileCreationDrawerOpen]);

    const toggleMobileCreationDrawer = React.useCallback(() => {
        if (isMobileCreationDrawerOpen) {
            closeMobileCreationDrawer();
        } else {
            openMobileCreationDrawer();
        }
    }, [closeMobileCreationDrawer, isMobileCreationDrawerOpen, openMobileCreationDrawer]);

    const beginMobileCreationDrawerGesture = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        mobileDrawerPointerStartRef.current = {
            x: event.clientX,
            y: event.clientY
        };
    }, []);

    const finishMobileCreationDrawerGesture = React.useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            const start = mobileDrawerPointerStartRef.current;
            mobileDrawerPointerStartRef.current = null;
            if (!start) return;

            const gesture = resolveMobileCreationSheetGesture({
                startX: start.x,
                startY: start.y,
                currentX: event.clientX,
                currentY: event.clientY
            });
            if (gesture === 'open') {
                mobileDrawerGestureHandledAtRef.current = Date.now();
                openMobileCreationDrawer();
            } else if (gesture === 'close') {
                mobileDrawerGestureHandledAtRef.current = Date.now();
                closeMobileCreationDrawer();
            }
        },
        [closeMobileCreationDrawer, openMobileCreationDrawer]
    );

    const cancelMobileCreationDrawerGesture = React.useCallback(() => {
        mobileDrawerPointerStartRef.current = null;
    }, []);

    const handleMobileCreationDrawerHandleClick = React.useCallback(() => {
        if (Date.now() - mobileDrawerGestureHandledAtRef.current < 500) {
            mobileDrawerGestureHandledAtRef.current = 0;
            return;
        }
        toggleMobileCreationDrawer();
    }, [toggleMobileCreationDrawer]);

    const handleMobileCreationDrawerKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLElement>) => {
            if (!isMobileCreationDrawerOpen) return;
            if (event.key !== 'Tab') return;

            const focusableElements = getMobileCreationDrawerFocusableElements(event.currentTarget);
            const firstElement = focusableElements[0];
            const lastElement = focusableElements.at(-1);
            if (!firstElement || !lastElement) return;

            if (event.shiftKey && document.activeElement === firstElement) {
                event.preventDefault();
                lastElement.focus();
            } else if (!event.shiftKey && document.activeElement === lastElement) {
                event.preventDefault();
                firstElement.focus();
            }
        },
        [isMobileCreationDrawerOpen]
    );

    React.useEffect(() => {
        if (!isMobileCreationDrawerOpen || typeof document === 'undefined') return;
        const mobileCreationDrawer = document.getElementById('mobile-creation-sheet');
        if (!mobileCreationDrawer) return;

        const keepFocusInMobileCreationDrawer = (event: FocusEvent) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (mobileCreationDrawer.contains(target) || target.closest(mobileCreationDrawerPortalSelector)) return;

            getMobileCreationDrawerFocusableElements(mobileCreationDrawer)[0]?.focus();
        };

        document.addEventListener('focusin', keepFocusInMobileCreationDrawer);
        return () => document.removeEventListener('focusin', keepFocusInMobileCreationDrawer);
    }, [isMobileCreationDrawerOpen]);

    React.useEffect(() => {
        if (!isMobileCreationDrawerOpen || typeof document === 'undefined') return;

        const previousBodyOverflow = document.body.style.overflow;
        const previousHtmlOverflow = document.documentElement.style.overflow;
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = previousBodyOverflow;
            document.documentElement.style.overflow = previousHtmlOverflow;
        };
    }, [isMobileCreationDrawerOpen]);

    React.useEffect(() => {
        if (!isMobileCreationDrawerOpen || typeof document === 'undefined') return;

        const closeDrawerOnEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            if (event.target instanceof Element && event.target.closest(mobileCreationDrawerPortalSelector)) {
                return;
            }
            event.preventDefault();
            closeMobileCreationDrawer();
        };
        document.addEventListener('keydown', closeDrawerOnEscape);
        return () => document.removeEventListener('keydown', closeDrawerOnEscape);
    }, [closeMobileCreationDrawer, isMobileCreationDrawerOpen]);

    React.useEffect(() => {
        if (!isMobileCreationDrawerOpen) return;

        requestAnimationFrame(() => {
            mobileCreationDrawerCloseButtonRef.current?.focus();
        });
    }, [isMobileCreationDrawerOpen]);

    React.useEffect(() => {
        if (isMobileCreationDrawerOpen || typeof window === 'undefined') return;
        const focusTarget = mobileCreationDrawerFocusTargetRef.current;
        if (!focusTarget) return;
        mobileCreationDrawerFocusTargetRef.current = null;

        if (focusTarget === 'trigger') {
            const trigger =
                mobileCreationDrawerTriggerRef.current ??
                document.querySelector<HTMLButtonElement>('[aria-controls="mobile-creation-sheet"]');
            trigger?.focus();
        } else {
            outputPanelRef.current?.focus();
        }
    }, [isMobileCreationDrawerOpen]);

    React.useEffect(() => {
        if (!isMobileCreationDrawerOpen || typeof window === 'undefined') return;

        const desktopMediaQuery = window.matchMedia('(min-width: 1024px)');
        const closeDrawerOnDesktop = () => {
            if (desktopMediaQuery.matches) {
                mobileCreationDrawerFocusTargetRef.current = null;
                setIsMobileCreationDrawerOpen(false);
            }
        };

        closeDrawerOnDesktop();
        desktopMediaQuery.addEventListener('change', closeDrawerOnDesktop);
        window.addEventListener('resize', closeDrawerOnDesktop);
        return () => {
            desktopMediaQuery.removeEventListener('change', closeDrawerOnDesktop);
            window.removeEventListener('resize', closeDrawerOnDesktop);
        };
    }, [isMobileCreationDrawerOpen]);

    const getImageSrc = React.useCallback(
        (filename: string): string | undefined => {
            const cached = blobUrlCacheRef.current.get(filename);
            if (cached) return cached;

            const record = allDbImages?.find((img) => img.filename === filename);
            if (record?.blob) {
                const url = URL.createObjectURL(record.blob);
                blobUrlCacheRef.current.set(filename, url);
                return url;
            }

            return undefined;
        },
        [allDbImages]
    );
    const historyCompareImage = React.useMemo(
        () =>
            resolveHistoryCompareImage({
                history,
                currentFilenames: latestImageBatch?.map((image) => image.filename) ?? [],
                getIndexedDbImageSrc: getImageSrc
            }),
        [getImageSrc, history, latestImageBatch]
    );

    React.useEffect(() => {
        const cache = blobUrlCacheRef.current;
        return () => {
            cache.forEach((url) => URL.revokeObjectURL(url));
            cache.clear();
        };
    }, []);

    React.useEffect(() => {
        queueMicrotask(() => {
            setHistory(readStoredHistory());
            const storedInspirations = readStoredInspirations();
            setInspirations(storedInspirations.items);
            if (storedInspirations.shouldRemove) {
                window.localStorage.removeItem(inspirationsLocalStorageKey);
            } else if (storedInspirations.shouldPersist) {
                window.localStorage.setItem(inspirationsLocalStorageKey, JSON.stringify(storedInspirations.items));
            }
            hasLoadedStoredHistoryRef.current = true;
        });
    }, []);

    React.useEffect(() => {
        editSourceImagePreviewUrlsRef.current = editSourceImagePreviewUrls;
    }, [editSourceImagePreviewUrls]);

    const verifyEntryPasswordHash = React.useCallback(
        async (passwordHash: string): Promise<PasswordVerificationResult> => {
            try {
                const response = await fetch('/api/auth-verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ passwordHash })
                });

                if (response.ok) {
                    return 'valid';
                }
                if (response.status === 401) {
                    try {
                        const result = (await response.json()) as { code?: string };
                        return isPagePasswordAuthErrorCode(result.code) ? 'invalid' : 'unavailable';
                    } catch {
                        return 'unavailable';
                    }
                }
                return 'unavailable';
            } catch (error) {
                console.error('验证入口访问码失败：', error);
                return 'unavailable';
            }
        },
        []
    );

    const promptForExpiredPassword = React.useCallback(() => {
        localStorage.removeItem('clientPasswordHash');
        setClientPasswordHash(null);
        setIsEntryAuthenticated(false);
        setPasswordDialogContext('retry');
        setIsPasswordDialogOpen(true);
        setError(createErrorNotice(t('error.passwordExpired')));
    }, [createErrorNotice, t]);

    const refreshImageAccessCookie = React.useCallback(
        async (passwordHash = clientPasswordHash): Promise<boolean> => {
            if (!isPasswordRequiredByBackend) {
                return true;
            }
            if (!passwordHash) {
                promptForExpiredPassword();
                return false;
            }

            const verificationResult = await verifyEntryPasswordHash(passwordHash);
            if (verificationResult === 'valid') {
                setIsEntryAuthenticated(true);
                return true;
            }
            if (verificationResult === 'unavailable') {
                setError(createErrorNotice(t('error.authVerifyUnavailable')));
                return false;
            }

            promptForExpiredPassword();
            return false;
        },
        [
            clientPasswordHash,
            createErrorNotice,
            isPasswordRequiredByBackend,
            promptForExpiredPassword,
            t,
            verifyEntryPasswordHash
        ]
    );

    React.useEffect(() => {
        const fetchAuthStatus = async () => {
            try {
                const response = await fetch('/api/auth-status');
                if (!response.ok) {
                    throw new Error('获取鉴权状态失败');
                }
                const data = await response.json();
                const passwordRequired = Boolean(data.passwordRequired);
                setIsPasswordRequiredByBackend(passwordRequired);

                const storedPasswordHash = readLocalStorageValue('clientPasswordHash');
                if (!passwordRequired) {
                    setClientPasswordHash(storedPasswordHash);
                    setIsEntryAuthenticated(true);
                    return;
                }

                if (storedPasswordHash) {
                    const storedVerificationResult = await verifyEntryPasswordHash(storedPasswordHash);
                    if (storedVerificationResult === 'valid') {
                        setClientPasswordHash(storedPasswordHash);
                        setIsEntryAuthenticated(true);
                        return;
                    }
                    if (storedVerificationResult === 'unavailable') {
                        setClientPasswordHash(storedPasswordHash);
                        setPasswordDialogContext('retry');
                        setIsEntryAuthenticated(false);
                        setError(createErrorNotice(t('error.authVerifyUnavailable')));
                        return;
                    }
                }

                localStorage.removeItem('clientPasswordHash');
                setClientPasswordHash(null);
                setPasswordDialogContext('initial');
                setIsEntryAuthenticated(false);
            } catch (error) {
                console.error('获取鉴权状态失败：', error);
                setIsPasswordRequiredByBackend(false);
                setIsEntryAuthenticated(true);
            }
        };

        fetchAuthStatus();
        queueMicrotask(() => {
            const storedApiSettings = readStoredApiSettings();
            setApiSettings(storedApiSettings.settings);
            if (storedApiSettings.shouldRemove) {
                window.localStorage.removeItem(apiSettingsLocalStorageKey);
            } else if (storedApiSettings.shouldPersist) {
                window.localStorage.setItem(apiSettingsLocalStorageKey, JSON.stringify(storedApiSettings.settings));
            }
        });
    }, [createErrorNotice, t, verifyEntryPasswordHash]);

    const refreshRuntimeCapabilities = React.useCallback(async (): Promise<RuntimeCapabilities | null> => {
        setIsRuntimeCapabilitiesLoading(true);
        try {
            const response = await fetch('/api/runtime-capabilities');
            if (!response.ok) {
                throw new Error('获取运行时能力失败');
            }
            const data = (await response.json()) as RuntimeCapabilities;
            if (data === null || typeof data !== 'object') {
                throw new Error('获取运行时能力失败');
            }
            setRuntimeCapabilities(data);
            const defaultModel = data.imageModel?.defaultModel?.trim();
            const defaultModelIsCompatible =
                defaultModel !== undefined &&
                (!modelDirectoryResolvedRef.current || modelDirectoryOptionsRef.current.includes(defaultModel));
            if (defaultModel && defaultModelIsCompatible) {
                if (!genModelExplicitSelectionRef.current) {
                    setGenModel((current) => (current === 'gpt-image-2' ? defaultModel : current));
                }
                if (!editModelExplicitSelectionRef.current) {
                    setEditModel((current) => (current === 'gpt-image-2' ? defaultModel : current));
                }
                setModelOptions((current) => Array.from(new Set([defaultModel, ...current])));
            }
            return data;
        } catch (error) {
            console.error('获取运行时能力失败：', error);
            setRuntimeCapabilities(null);
            return null;
        } finally {
            setIsRuntimeCapabilitiesLoading(false);
        }
    }, []);

    React.useEffect(() => {
        queueMicrotask(() => {
            refreshRuntimeCapabilities();
        });
    }, [refreshRuntimeCapabilities]);

    React.useEffect(() => {
        const canProbeModelDirectory = isPasswordRequiredByBackend === true && Boolean(clientPasswordHash);
        const probeKey = canProbeModelDirectory ? `page:${clientPasswordHash}` : 'anonymous';
        const generation = modelProbeGenerationRef.current + 1;
        modelProbeGenerationRef.current = generation;
        if (modelProbeKeysRef.current.has(probeKey)) return;
        modelDirectoryResolvedRef.current = false;
        modelDirectoryOptionsRef.current = [...DEFAULT_MODEL_OPTIONS];
        const controller = new AbortController();
        const isCurrentProbe = () => !controller.signal.aborted && modelProbeGenerationRef.current === generation;
        const fetchModelDirectory = async (endpoint: string) => {
            const response = await fetch(endpoint, {
                signal: controller.signal,
                credentials: 'same-origin'
            });
            if (!response.ok) throw new Error('模型目录请求失败');
            return response.json();
        };
        const loadModelDirectory = async () => {
            if (!canProbeModelDirectory) {
                return fetchModelDirectory('/api/agent/models');
            }
            let lastError: unknown;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    return await fetchModelDirectory('/api/agent/models?probe=true');
                } catch (error) {
                    lastError = error;
                    if (controller.signal.aborted) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }
            if (controller.signal.aborted) throw lastError ?? new Error('模型目录请求失败');
            try {
                return await fetchModelDirectory('/api/agent/models');
            } catch {
                throw lastError ?? new Error('模型目录请求失败');
            }
        };
        loadModelDirectory()
            .then(
                (directory: {
                    known_models?: Array<{ id?: unknown }>;
                    default_model?: unknown;
                    channels?: Array<{
                        declared_models?: unknown;
                        model_allowlist_configured?: unknown;
                        model_allowlist_state?: unknown;
                        models?: unknown;
                        probe_status?: unknown;
                    }>;
                }) => {
                    if (!isCurrentProbe()) return;
                    const nextOptions = resolveModelDirectoryOptions(directory);
                    modelDirectoryResolvedRef.current = true;
                    modelDirectoryOptionsRef.current = nextOptions;
                    if (nextOptions.length > 0) setModelOptions(nextOptions);
                    const defaultModel =
                        typeof directory.default_model === 'string' ? directory.default_model.trim() : '';
                    const preferredModel =
                        defaultModel && nextOptions.includes(defaultModel) ? defaultModel : nextOptions[0];
                    if (preferredModel) {
                        setGenModel((current) => (nextOptions.includes(current) ? current : preferredModel));
                        setEditModel((current) => (nextOptions.includes(current) ? current : preferredModel));
                    }
                    modelProbeKeysRef.current.add(probeKey);
                }
            )
            .catch(() => undefined);
        return () => controller.abort();
    }, [clientPasswordHash, isPasswordRequiredByBackend]);

    React.useEffect(() => {
        if (!retentionScopeKey) return;

        const controller = new AbortController();
        const loadPermanentlySavedFilenames = async () => {
            try {
                const response = await fetch('/api/image-retention', { signal: controller.signal });
                const body: unknown = await response.json().catch(() => null);
                if (!response.ok) {
                    if (!controller.signal.aborted) {
                        setError(
                            (current) =>
                                current ??
                                createErrorNotice(
                                    response.status === 401 ? t('error.unauthorized') : t('retention.loadFailed')
                                )
                        );
                    }
                    return;
                }
                let filenames: ReturnType<typeof readWebuiImageRetentionFilenames>;
                try {
                    filenames = readWebuiImageRetentionFilenames(body);
                } catch {
                    throw new Error(t('retention.loadFailed'));
                }
                if (!controller.signal.aborted) {
                    setLoadedWebuiImageRetentionState({
                        scopeKey: retentionScopeKey,
                        filenames: new Set(filenames)
                    });
                }
            } catch (error) {
                if (controller.signal.aborted) return;
                console.error('读取自动清理保护状态失败：', error);
                setError((current) => current ?? createErrorNotice(t('retention.loadFailed')));
            }
        };

        void loadPermanentlySavedFilenames();
        return () => controller.abort();
    }, [createErrorNotice, retentionScopeKey, t]);

    const updatePermanentSave = React.useCallback(
        async (action: WebuiImageRetentionAction, filenames: string[]) => {
            if (!retentionScopeKey) {
                throw new Error(t('retention.updateFailed'));
            }

            let response: Response;
            try {
                response = await fetch('/api/image-retention', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action,
                        filenames,
                        ...(clientPasswordHash ? { passwordHash: clientPasswordHash } : {})
                    })
                });
            } catch {
                throw new Error(t('retention.updateFailed'));
            }
            let body: unknown;
            try {
                body = await response.json();
            } catch {
                throw new Error(t('retention.updateFailed'));
            }
            if (!response.ok && response.status !== 207) {
                throw new Error(response.status === 401 ? t('error.unauthorized') : t('retention.updateFailed'));
            }

            let results: ReturnType<typeof readWebuiImageFileOperationResults>;
            try {
                results = readWebuiImageFileOperationResults(body);
            } catch {
                throw new Error(t('retention.updateFailed'));
            }
            setLoadedWebuiImageRetentionState((current) =>
                current?.scopeKey === retentionScopeKey
                    ? {
                          ...current,
                          filenames: mergeWebuiImageRetentionResults(current.filenames, action, results)
                      }
                    : current
            );
            if (results.some((result) => !result.success)) {
                throw new Error(t('retention.partialUpdateFailed'));
            }
        },
        [clientPasswordHash, retentionScopeKey, t]
    );

    React.useEffect(() => {
        if (!hasLoadedStoredHistoryRef.current) return;
        try {
            localStorage.setItem('openaiImageHistory', JSON.stringify(history));
        } catch (e) {
            console.error('保存历史记录到 localStorage 失败：', e);
        }
    }, [history]);

    React.useEffect(() => {
        if (!hasLoadedStoredHistoryRef.current) return;
        try {
            localStorage.setItem(inspirationsLocalStorageKey, JSON.stringify(inspirations));
        } catch (e) {
            console.error('保存灵感相册到 localStorage 失败：', e);
        }
    }, [inspirations]);

    React.useEffect(() => {
        return () => {
            editSourceImagePreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
            editSourceImagePreviewUrlsRef.current = [];
        };
    }, []);

    React.useEffect(() => {
        queueMicrotask(() => {
            setSkipDeleteConfirmation(readStoredDeletePreference());
        });
    }, []);

    React.useEffect(() => {
        localStorage.setItem('imageGenSkipDeleteConfirm', String(skipDeleteConfirmation));
    }, [skipDeleteConfirmation]);

    React.useEffect(() => {
        const handlePaste = (event: ClipboardEvent) => {
            if (mode !== 'edit' || !event.clipboardData) {
                return;
            }

            if (
                hasReachedEditSourceImageLimit({
                    currentCount: editImageFiles.length,
                    maxImages: maxEditSourceImages
                })
            ) {
                alert(t('alert.pasteMaxImages', { count: maxEditSourceImages }));
                return;
            }

            const items = event.clipboardData.items;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    const file = items[i].getAsFile();
                    if (file) {
                        event.preventDefault();

                        const validationFailure = validateEditSourceInput({
                            imageFiles: [...editImageFiles, file],
                            maskFile: editGeneratedMaskFile,
                            upstreamProfile: activeUpstreamProfile,
                            imageBackend: editImageBackend,
                            defaultImageBackend
                        });
                        if (validationFailure) {
                            alert(formatEditSourceValidationFailure(validationFailure, t));
                            return;
                        }

                        const previewUrl = URL.createObjectURL(file);

                        setEditImageFiles((prevFiles) => [...prevFiles, file]);
                        updateEditSourceImagePreviewUrls([...editSourceImagePreviewUrlsRef.current, previewUrl]);

                        break;
                    }
                }
            }
        };

        window.addEventListener('paste', handlePaste);

        return () => {
            window.removeEventListener('paste', handlePaste);
        };
    }, [
        activeUpstreamProfile,
        defaultImageBackend,
        editGeneratedMaskFile,
        editImageBackend,
        editImageFiles,
        maxEditSourceImages,
        mode,
        t,
        updateEditSourceImagePreviewUrls
    ]);

    const handleSavePassword = async (password: string) => {
        if (!password.trim()) {
            setError(createErrorNotice(t('password.empty')));
            return;
        }
        try {
            const hash = await sha256Hex(password);
            const passwordVerificationResult = isPasswordRequiredByBackend
                ? await verifyEntryPasswordHash(hash)
                : 'valid';
            if (passwordVerificationResult === 'unavailable') {
                setError(createErrorNotice(t('error.authVerifyUnavailable')));
                return;
            }
            if (passwordVerificationResult === 'invalid') {
                localStorage.removeItem('clientPasswordHash');
                setClientPasswordHash(null);
                setIsEntryAuthenticated(false);
                setError(createErrorNotice(t('error.unauthorized')));
                setIsPasswordDialogOpen(true);
                return;
            }

            localStorage.setItem('clientPasswordHash', hash);
            setClientPasswordHash(hash);
            setIsEntryAuthenticated(true);
            setError(null);
            setIsPasswordDialogOpen(false);
            if (passwordDialogContext === 'retry' && lastApiCallArgs) {
                const retryArgs = lastApiCallArgs;
                setLastApiCallArgs(null);
                await handleApiCall(...retryArgs, hash);
            }
        } catch (e) {
            console.error('计算访问码哈希失败：', e);
            setError(createErrorNotice(t('password.hashError')));
        }
    };

    const handleOpenPasswordDialog = () => {
        setPasswordDialogContext('initial');
        setIsPasswordDialogOpen(true);
    };

    const handleSaveApiSettings = (settings: ApiSettings) => {
        if (settings.baseUrl && !settings.apiKey) {
            throw new Error(t('api.urlPairRequired'));
        }
        setApiSettings(settings);
        if (settings.apiKey || settings.baseUrl) {
            localStorage.setItem(apiSettingsLocalStorageKey, JSON.stringify(settings));
        } else {
            localStorage.removeItem(apiSettingsLocalStorageKey);
        }
    };

    const materializeImages = React.useCallback(
        async (images: ApiImageResponseItem[]): Promise<ApiImageResult[]> => {
            if (effectiveStorageModeClient === 'indexeddb') {
                const indexedDbImages = await Promise.all(
                    images.map(async (img) => {
                        if (!img.b64_json) {
                            throw new ApiRequestError(t('error.imageMissingBase64', { filename: img.filename }));
                        }
                        const byteCharacters = atob(img.b64_json);
                        const byteNumbers = new Array(byteCharacters.length);
                        for (let i = 0; i < byteCharacters.length; i++) {
                            byteNumbers[i] = byteCharacters.charCodeAt(i);
                        }
                        const byteArray = new Uint8Array(byteNumbers);
                        const blob = new Blob([byteArray], { type: getMimeTypeFromFormat(img.output_format) });

                        await db.images.put({ filename: img.filename, blob });

                        const existingUrl = blobUrlCacheRef.current.get(img.filename);
                        if (existingUrl) {
                            URL.revokeObjectURL(existingUrl);
                        }
                        const blobUrl = URL.createObjectURL(blob);
                        blobUrlCacheRef.current.set(img.filename, blobUrl);
                        return {
                            filename: img.filename,
                            path: blobUrl,
                            ...(img.clientRequestId ? { clientRequestId: img.clientRequestId } : {})
                        };
                    })
                );
                return indexedDbImages;
            }

            const fsImages = images
                .filter((img) => !!img.path)
                .map((img) => ({
                    path: img.path!,
                    filename: img.filename,
                    ...(img.clientRequestId ? { clientRequestId: img.clientRequestId } : {})
                }));
            if (fsImages.length !== images.length) {
                throw new ApiRequestError(t('error.apiOmittedPaths'));
            }
            return fsImages;
        },
        [t]
    );

    const commitCompletedImages = React.useCallback(
        async (
            images: ApiImageResponseItem[],
            usage: unknown,
            actualCost: ActualCostDetails | undefined,
            durationMsValue: number,
            formData: GenerationFormData | EditingFormData,
            requestMode: RequestMode,
            clearStreaming = false,
            promptOverride?: string
        ) => {
            if (images.length === 0) {
                throw new ApiRequestError(t('error.noImages'));
            }

            const processedImages = await materializeImages(images);
            const processedImagesWithStorage = processedImages.map((image) => ({
                ...image,
                storageMode: effectiveStorageModeClient
            }));
            setLatestImageBatch(processedImagesWithStorage);
            setCompletedGenerationCount(processedImages.length);
            setImageOutputView(processedImages.length > 1 ? 'grid' : 0);
            if (clearStreaming) {
                setStreamingPreviewImages(new Map());
            }
            const historyEntry = buildCompletedHistoryEntry({
                images,
                usage,
                actualCost,
                durationMs: durationMsValue,
                formData,
                requestMode,
                storageMode: effectiveStorageModeClient,
                promptOverride
            });
            setActiveResultSource(historyEntry);
            setHistory((prevHistory) => [historyEntry, ...prevHistory]);
        },
        [materializeImages, t]
    );

    const buildApiFormData = React.useCallback(
        (
            formData: GenerationFormData | EditingFormData,
            requestMode: RequestMode,
            options: {
                forceSingleImage?: boolean;
                streamMode: ImageStreamMode;
                partialImages: PartialImagesCount;
                passwordHash?: string | null;
            }
        ) => {
            const apiFormData = new FormData();
            const effectivePasswordHash = options.passwordHash ?? clientPasswordHash;
            if (isPasswordRequiredByBackend && effectivePasswordHash) {
                apiFormData.append('passwordHash', effectivePasswordHash);
            } else if (isPasswordRequiredByBackend && !effectivePasswordHash) {
                throw new ApiRequestError(t('error.passwordRequired'));
            }
            apiFormData.append('mode', requestMode);
            if (apiSettings.apiKey) {
                apiFormData.append('apiKey', apiSettings.apiKey);
            }
            if (apiSettings.baseUrl && apiSettings.apiKey) {
                apiFormData.append('apiBaseUrl', apiSettings.baseUrl);
            }

            apiFormData.append('stream_mode', options.streamMode);
            if (options.streamMode !== 'non_stream') {
                apiFormData.append('partial_images', options.partialImages.toString());
            }
            apiFormData.append('clientRequestId', createClientRequestId());

            if (requestMode === 'generate') {
                const genData = formData as GenerationFormData;
                apiFormData.append('model', genData.model);
                apiFormData.append('prompt', genData.prompt);
                apiFormData.append('n', options.forceSingleImage ? '1' : genData.n.toString());
                const genSizeToSend =
                    genData.size === 'custom'
                        ? `${genData.customWidth}x${genData.customHeight}`
                        : (getPresetDimensions(genData.size, genData.model) ?? genData.size);
                apiFormData.append('size', genSizeToSend);
                apiFormData.append('quality', genData.quality);
                apiFormData.append('output_format', genData.output_format);
                if (
                    (genData.output_format === 'jpeg' || genData.output_format === 'webp') &&
                    genData.output_compression !== undefined
                ) {
                    apiFormData.append('output_compression', genData.output_compression.toString());
                }
                apiFormData.append('background', genData.background);
                apiFormData.append('moderation', genData.moderation);
                appendImageUpstreamOverrideFields(apiFormData, {
                    imageBackend: genData.image_backend,
                    streamingStrategy: genData.streaming_strategy,
                    responsesModel: genData.responsesModel,
                    thinking: genData.thinking,
                    promptOptimization: genData.promptOptimization,
                    forceWeb: genData.forceWeb
                });
            } else {
                const editData = formData as EditingFormData;
                apiFormData.append('model', editData.model);
                apiFormData.append('prompt', editData.prompt);
                apiFormData.append('n', options.forceSingleImage ? '1' : editData.n.toString());
                const editSizeToSend =
                    editData.size === 'custom'
                        ? `${editData.customWidth}x${editData.customHeight}`
                        : (getPresetDimensions(editData.size, editData.model) ?? editData.size);
                apiFormData.append('size', editSizeToSend);
                apiFormData.append('quality', editData.quality);
                apiFormData.append('output_format', editData.output_format);
                if (
                    (editData.output_format === 'jpeg' || editData.output_format === 'webp') &&
                    editData.output_compression !== undefined
                ) {
                    apiFormData.append('output_compression', editData.output_compression.toString());
                }
                apiFormData.append('moderation', editData.moderation);
                appendImageUpstreamOverrideFields(apiFormData, {
                    imageBackend: editData.image_backend,
                    streamingStrategy: editData.streaming_strategy,
                    responsesModel: editData.responsesModel,
                    thinking: editData.thinking,
                    promptOptimization: editData.promptOptimization,
                    forceWeb: editData.forceWeb
                });

                editData.imageFiles.forEach((file, index) => {
                    apiFormData.append(`image_${index}`, file, file.name);
                });
                if (editData.maskFile) {
                    apiFormData.append('mask', editData.maskFile, editData.maskFile.name);
                }
            }

            return apiFormData;
        },
        [apiSettings.apiKey, apiSettings.baseUrl, clientPasswordHash, isPasswordRequiredByBackend, t]
    );

    const executeImageRequest = React.useCallback(
        async (
            apiFormData: FormData,
            options: {
                previewIndexOffset?: number;
                retryFormData?: GenerationFormData | EditingFormData;
                retryMode?: RequestMode;
                retryStreamMode?: ImageStreamMode;
                retryPartialImages?: PartialImagesCount;
                retryEnableParallelBatch?: boolean;
            } = {}
        ): Promise<{ images: ApiImageResponseItem[]; usage: unknown; actualCost?: ActualCostDetails }> => {
            const formClientRequestId = String(apiFormData.get('clientRequestId') || '');
            let response: Response;
            try {
                response = await fetch('/api/images', {
                    method: 'POST',
                    body: apiFormData
                });
            } catch {
                throw new ApiRequestError(t('error.networkRequest'));
            }

            const contentType = response.headers.get('content-type');
            if (contentType?.includes('text/event-stream')) {
                if (!response.body) {
                    throw new ApiRequestError(t('error.responseBodyNull'));
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let streamingState: StreamingClientState = {
                    completedImages: []
                };

                const processSseEvent = async (rawEvent: string) => {
                    const dataLines = rawEvent
                        .split(/\r?\n/)
                        .filter((line) => line.startsWith('data: '))
                        .map((line) => line.slice(6));
                    if (dataLines.length === 0) return;

                    let event: StreamingClientEvent;
                    try {
                        event = JSON.parse(dataLines.join('\n')) as StreamingClientEvent;
                    } catch {
                        throw new ApiRequestError(t('error.streaming'));
                    }
                    if (event.type === 'partial_image') {
                        const imageIndex = options.previewIndexOffset ?? event.index ?? 0;
                        const dataUrl = `data:image/png;base64,${event.b64_json}`;
                        setStreamingPreviewImages((prev) => {
                            const newMap = new Map(prev);
                            newMap.set(imageIndex, dataUrl);
                            return newMap;
                        });
                    } else if (event.type === 'error') {
                        const message =
                            event.code === 'image_dimension_mismatch'
                                ? getLocalizedImageDimensionMismatchError(
                                      t,
                                      event.expected_dimensions,
                                      event.actual_dimensions
                                  )
                                : getLocalizedImageRequestError(t, event.status);
                        throw new ApiRequestError(message, event.status, {
                            code: classifyApiErrorCode(event.code, message)
                        });
                    } else if (event.type === 'completed' || event.type === 'done') {
                        try {
                            streamingState = applyStreamingClientEvent(streamingState, event);
                        } catch {
                            throw new ApiRequestError(t('error.streaming'));
                        }
                    }
                };

                while (true) {
                    let chunk: ReadableStreamReadResult<Uint8Array>;
                    try {
                        chunk = await reader.read();
                    } catch {
                        throw new ApiRequestError(t('error.streaming'));
                    }
                    const { done, value } = chunk;
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const events = buffer.split(sseEventDelimiterPattern);
                    buffer = events.pop() || '';

                    for (const eventText of events) {
                        await processSseEvent(eventText);
                    }
                }
                const remainingEvent = buffer.trim();
                if (remainingEvent) {
                    await processSseEvent(remainingEvent);
                }

                return {
                    images: streamingState.completedImages.map((image) => ({
                        ...image,
                        ...(image.clientRequestId || !formClientRequestId
                            ? {}
                            : { clientRequestId: formClientRequestId })
                    })),
                    usage: streamingState.usage,
                    actualCost: streamingState.actualCost ?? undefined
                };
            }

            let result: {
                error?: string | { code?: unknown; message?: unknown };
                code?: string;
                images?: ApiImageResponseItem[];
                usage?: unknown;
                actualCost?: ActualCostDetails;
                clientRequestId?: string;
                expected_dimensions?: string;
                actual_dimensions?: string | null;
            };
            try {
                result = await response.json();
            } catch {
                if (!response.ok) {
                    throw new ApiRequestError(getLocalizedImageRequestError(t, response.status), response.status);
                }
                throw new ApiRequestError(t('error.unexpected'), response.status);
            }

            if (!response.ok) {
                if (
                    response.status === 401 &&
                    isPasswordRequiredByBackend &&
                    isPagePasswordAuthErrorCode(result.code)
                ) {
                    if (
                        options.retryFormData &&
                        options.retryMode &&
                        options.retryStreamMode !== undefined &&
                        options.retryPartialImages !== undefined &&
                        options.retryEnableParallelBatch !== undefined
                    ) {
                        setLastApiCallArgs([
                            options.retryFormData,
                            options.retryMode,
                            options.retryStreamMode,
                            options.retryPartialImages,
                            options.retryEnableParallelBatch
                        ]);
                    }
                    promptForExpiredPassword();
                    throw new ApiRequestError(t('error.passwordExpired'), 401, { preserveDisplayedError: true });
                }
                const nestedError = result.error && typeof result.error === 'object' ? result.error : undefined;
                const upstreamErrorMessage =
                    typeof result.error === 'string'
                        ? result.error
                        : typeof nestedError?.message === 'string'
                          ? nestedError.message
                          : '';
                const resultCode =
                    result.code ?? (typeof nestedError?.code === 'string' ? nestedError.code : undefined);
                const localizedMessage =
                    resultCode === 'image_dimension_mismatch'
                        ? getLocalizedImageDimensionMismatchError(
                              t,
                              result.expected_dimensions,
                              result.actual_dimensions
                          )
                        : getLocalizedImageRequestError(t, response.status);
                throw new ApiRequestError(localizedMessage, response.status, {
                    code: classifyApiErrorCode(resultCode, upstreamErrorMessage)
                });
            }

            return {
                images: (result.images || []).map((image) => ({
                    ...image,
                    ...(image.clientRequestId || !(result.clientRequestId || formClientRequestId)
                        ? {}
                        : { clientRequestId: result.clientRequestId || formClientRequestId })
                })),
                usage: result.usage,
                actualCost: result.actualCost
            };
        },
        [isPasswordRequiredByBackend, promptForExpiredPassword, t]
    );

    async function handleApiCall(
        formData: GenerationFormData | EditingFormData,
        requestMode: RequestMode = mode,
        requestStreamMode: ImageStreamMode = streamMode,
        requestPartialImages: PartialImagesCount = partialImages,
        requestEnableParallelBatch = formData.enableParallelBatch,
        requestPasswordHash: string | null = clientPasswordHash
    ) {
        const startTime = Date.now();
        let durationMs = 0;
        let shouldKeepRetryArgs = true;
        let effectiveFormData: GenerationFormData | EditingFormData = formData;

        setIsLoading(true);
        setActiveRequestStreaming(requestStreamMode !== 'non_stream');
        setError(null);
        setGenerationFailureMessage(null);
        setFailedBatchPrompts([]);
        setLastApiCallArgs(null);
        setLatestImageBatch(null);
        setActiveResultSource(null);
        setCompletedGenerationCount(null);
        setImageOutputView('grid');
        setStreamingPreviewImages(new Map());
        setBatchProgress(null);
        batchPauseRequestedRef.current = false;
        setIsBatchPauseRequested(false);
        if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
            closeMobileCreationDrawerAfterSubmit();
            window.setTimeout(scrollToOutput, 80);
        }

        try {
            const latestRuntimeCapabilities = await refreshRuntimeCapabilities();
            const currentStreamingBatchCapacity = resolveStreamingBatchCapacity({
                featureEnabled: latestRuntimeCapabilities?.streamingBatch.enabled === true,
                hasRequestApiKey: apiSettings.apiKey.trim().length > 0,
                requestCredentialConcurrency:
                    latestRuntimeCapabilities?.streamingBatch.requestCredentialConcurrency ?? 1,
                serverRecommendedConcurrency: latestRuntimeCapabilities?.streamingBatch.recommendedConcurrency ?? 0
            });
            if (isPasswordRequiredByBackend) {
                const verificationPasswordHash = requestPasswordHash;
                if (!verificationPasswordHash) {
                    const message = t('error.passwordRequired');
                    setError(createErrorNotice(message));
                    setGenerationFailureMessage(message);
                    setPasswordDialogContext('initial');
                    setIsPasswordDialogOpen(true);
                    return;
                }

                const verificationResult = await verifyEntryPasswordHash(verificationPasswordHash);
                if (verificationResult === 'valid') {
                    setIsEntryAuthenticated(true);
                } else if (verificationResult === 'unavailable') {
                    const message = t('error.authVerifyUnavailable');
                    setError(createErrorNotice(message));
                    setGenerationFailureMessage(message);
                    return;
                } else {
                    const message = t('error.passwordExpired');
                    promptForExpiredPassword();
                    setGenerationFailureMessage(message);
                    return;
                }
            }
            const allowRuntimeResponsesImageBackend = shouldAllowResponsesImageBackend({
                runtimeCapabilities: latestRuntimeCapabilities,
                hasRequestApiOverride
            });
            if (
                shouldBlockExplicitResponsesRequest({
                    imageBackend: formData.image_backend,
                    allowResponsesImageBackend: allowRuntimeResponsesImageBackend,
                    defaultImageBackend: latestRuntimeCapabilities?.streaming?.defaultBackend
                })
            ) {
                throw new ApiRequestError(
                    latestRuntimeCapabilities === null
                        ? t('upstream.responsesRuntimeUnavailable')
                        : t('upstream.backendResponsesUnavailable')
                );
            }
            const runtimeFormData = normalizeImageUpstreamRuntimeFields(formData, {
                allowResponsesImageBackend: allowRuntimeResponsesImageBackend
            });
            if (
                shouldBlockResponsesRequestWithoutModel({
                    imageBackend: runtimeFormData.image_backend,
                    responsesModel: runtimeFormData.responsesModel,
                    hasDefaultResponsesModel: latestRuntimeCapabilities?.responsesImageBackend?.hasDefaultModel === true
                })
            ) {
                throw new ApiRequestError(t('upstream.responsesModelRequired'));
            }
            const runtimeUpstreamProfile = hasRequestApiOverride
                ? summarizeImageUpstreamProfile({ requestApiBaseUrl: apiSettings.baseUrl }).activeConstraints
                : latestRuntimeCapabilities?.upstreamProfile?.activeConstraints || activeUpstreamProfile;
            const runtimeDefaultImageBackend = latestRuntimeCapabilities?.streaming?.defaultBackend;
            const runtimeBackendCompatibility = getImageBackendCompatibility(
                runtimeUpstreamProfile,
                requestMode,
                runtimeFormData.image_backend,
                runtimeDefaultImageBackend
            );
            if (!runtimeBackendCompatibility.compatible) {
                throw new ApiRequestError(runtimeBackendCompatibility.errors.map((error) => error.message).join(' '));
            }
            if (requestMode === 'edit') {
                const editFormData = runtimeFormData as EditingFormData;
                const validationFailure = validateEditSourceInput({
                    imageFiles: editFormData.imageFiles,
                    maskFile: editFormData.maskFile,
                    upstreamProfile: runtimeUpstreamProfile,
                    imageBackend: editFormData.image_backend,
                    defaultImageBackend: runtimeDefaultImageBackend
                });
                if (validationFailure) {
                    throw new ApiRequestError(formatEditSourceValidationFailure(validationFailure, t));
                }
            }
            const runtimeCountRange = runtimeBackendCompatibility.imageCountRange;
            if (!runtimeCountRange) {
                throw new ApiRequestError('当前图片后端没有可用的图片数量约束。');
            }
            const runtimeImageCount = runtimeFormData.n;
            if (runtimeImageCount < runtimeCountRange.min || runtimeImageCount > runtimeCountRange.max) {
                throw new ApiRequestError(
                    t('error.imageCountOutOfRange', {
                        min: runtimeCountRange.min,
                        max: runtimeCountRange.max
                    })
                );
            }
            if (requestStreamMode !== 'non_stream') {
                const runtimePartialImagesRange = runtimeBackendCompatibility.partialImagesRange;
                if (!runtimePartialImagesRange) {
                    throw new ApiRequestError('当前图片后端没有可用的 partial_images 约束。');
                }
                if (
                    requestPartialImages < runtimePartialImagesRange.min ||
                    requestPartialImages > runtimePartialImagesRange.max
                ) {
                    throw new ApiRequestError(
                        t('error.partialImagesOutOfRange', {
                            min: runtimePartialImagesRange.min,
                            max: runtimePartialImagesRange.max
                        })
                    );
                }
            }
            const promptBatch =
                requestMode === 'generate'
                    ? ((runtimeFormData as GenerationFormData).batchPrompts ?? [])
                          .map((prompt) => prompt.trim())
                          .filter((prompt) => prompt.length > 0)
                    : [];
            const isPromptBatch = promptBatch.length > 1;
            const historyPromptOverride =
                requestMode === 'generate' && promptBatch.length > 0
                    ? formatBatchPromptHistory(promptBatch)
                    : undefined;
            const imageCount = isPromptBatch
                ? promptBatch.length
                : requestMode === 'generate'
                  ? (runtimeFormData as GenerationFormData).n
                  : (runtimeFormData as EditingFormData).n;
            const requestStreamingStrategy =
                requestMode === 'generate'
                    ? (runtimeFormData as GenerationFormData).streaming_strategy
                    : (runtimeFormData as EditingFormData).streaming_strategy;
            const runtimeDefaultStreamingStrategy =
                latestRuntimeCapabilities?.streaming?.defaultStrategy ?? defaultStreamingStrategy;
            const effectiveRequestStreamingStrategy =
                requestStreamingStrategy === IMAGE_UPSTREAM_FORM_SERVER_DEFAULT
                    ? runtimeDefaultStreamingStrategy
                    : requestStreamingStrategy;
            const normalizedEnableParallelBatch = shouldUseStreamingBatch({
                enabled: currentStreamingBatchCapacity.enabled,
                userEnabled: requestEnableParallelBatch,
                streaming: canUseStreamingBatchTransport({
                    streamMode: requestStreamMode,
                    streamingStrategy: effectiveRequestStreamingStrategy
                }),
                imageCount
            });
            effectiveFormData = {
                ...runtimeFormData,
                enableParallelBatch: normalizedEnableParallelBatch
            };
            setLastApiCallArgs([
                effectiveFormData,
                requestMode,
                requestStreamMode,
                requestPartialImages,
                normalizedEnableParallelBatch
            ]);

            const executeImageRequestForCurrentOptions = async (
                options: { forceSingleImage: boolean; previewIndexOffset?: number; promptOverride?: string } = {
                    forceSingleImage: false
                }
            ) => {
                const requestFormData =
                    requestMode === 'generate' && options.promptOverride
                        ? {
                              ...(effectiveFormData as GenerationFormData),
                              prompt: options.promptOverride,
                              n: 1
                          }
                        : effectiveFormData;
                return executeImageRequest(
                    buildApiFormData(requestFormData, requestMode, {
                        forceSingleImage: options.forceSingleImage,
                        streamMode: requestStreamMode,
                        partialImages: requestPartialImages,
                        passwordHash: requestPasswordHash
                    }),
                    {
                        previewIndexOffset: options.previewIndexOffset,
                        retryFormData: effectiveFormData,
                        retryMode: requestMode,
                        retryStreamMode: requestStreamMode,
                        retryPartialImages: requestPartialImages,
                        retryEnableParallelBatch: normalizedEnableParallelBatch
                    }
                );
            };

            if (isPromptBatch) {
                const jobs = buildStreamingBatchJobs(promptBatch.length);
                setBatchProgress({
                    completed: 0,
                    failed: 0,
                    total: jobs.length
                });
                const batchResults = await scheduleStreamingBatch(jobs, {
                    concurrency: normalizedEnableParallelBatch ? currentStreamingBatchCapacity.concurrency : 1,
                    runJob: async (job: StreamingBatchJob) => {
                        try {
                            const result = await executeImageRequestForCurrentOptions({
                                forceSingleImage: true,
                                previewIndexOffset: job.outputIndex,
                                promptOverride: promptBatch[job.outputIndex]
                            });
                            setBatchProgress((current) => advanceGenerationBatchProgress(current, jobs.length, false));
                            return result;
                        } catch (error) {
                            setBatchProgress((current) => advanceGenerationBatchProgress(current, jobs.length, true));
                            throw error;
                        }
                    },
                    shouldPause: () => batchPauseRequestedRef.current
                });
                const errors = batchResults.filter((result): result is Error => result instanceof Error);
                const successes = batchResults.filter(
                    (
                        result
                    ): result is { images: ApiImageResponseItem[]; usage: unknown; actualCost?: ActualCostDetails } =>
                        !(result instanceof Error)
                );
                if (errors.some(hasPreservedDisplayedAuthError)) {
                    return;
                }
                const failedPromptBatch = collectFailedBatchPrompts(promptBatch, batchResults);
                if (errors.some((batchError) => batchError instanceof BatchPausedError)) {
                    setBatchProgress((current) => ({
                        completed: countCompletedBatchResults(batchResults),
                        failed: failedPromptBatch.length,
                        total: current?.total ?? jobs.length
                    }));
                }
                if (successes.length === 0) {
                    setFailedBatchPrompts(failedPromptBatch);
                    throw errors[0] || new ApiRequestError(t('error.noImages'));
                }
                const images = successes.flatMap((result) => result.images);
                const usage = mergeUsageValues(successes.map((result) => result.usage));
                const actualCost = mergeActualCostValues(successes.map((result) => result.actualCost));
                durationMs = Date.now() - startTime;
                if (errors.length > 0) {
                    setFailedBatchPrompts(failedPromptBatch);
                }
                await commitCompletedImages(
                    images,
                    usage,
                    actualCost,
                    durationMs,
                    effectiveFormData,
                    requestMode,
                    true,
                    historyPromptOverride
                );
                shouldKeepRetryArgs = false;
                if (errors.length > 0) {
                    await refreshRuntimeCapabilities();
                    setError(
                        createErrorNotice(
                            buildBatchPartialFailureMessage({
                                failed: errors.length,
                                total: jobs.length,
                                errors: errors.map((error) => summarizeApiError(error, t('error.unexpected'), t)),
                                t
                            })
                        )
                    );
                } else {
                    setFailedBatchPrompts([]);
                }
                return;
            }

            if (normalizedEnableParallelBatch) {
                const jobs = buildStreamingBatchJobs(imageCount);
                const batchResults = await scheduleStreamingBatch(jobs, {
                    concurrency: currentStreamingBatchCapacity.concurrency,
                    runJob: async (job: StreamingBatchJob) => {
                        return executeImageRequestForCurrentOptions({
                            forceSingleImage: true,
                            previewIndexOffset: job.outputIndex
                        });
                    }
                });
                const errors = batchResults.filter((result): result is Error => result instanceof Error);
                const successes = batchResults.filter(
                    (
                        result
                    ): result is { images: ApiImageResponseItem[]; usage: unknown; actualCost?: ActualCostDetails } =>
                        !(result instanceof Error)
                );
                if (errors.some(hasPreservedDisplayedAuthError)) {
                    return;
                }
                if (successes.length === 0) {
                    throw errors[0] || new ApiRequestError(t('error.noImages'));
                }
                const images = successes.flatMap((result) => result.images);
                const usage = mergeUsageValues(successes.map((result) => result.usage));
                const actualCost = mergeActualCostValues(successes.map((result) => result.actualCost));
                durationMs = Date.now() - startTime;
                await commitCompletedImages(
                    images,
                    usage,
                    actualCost,
                    durationMs,
                    effectiveFormData,
                    requestMode,
                    true
                );
                shouldKeepRetryArgs = false;
                if (errors.length > 0) {
                    await refreshRuntimeCapabilities();
                    setError(
                        createErrorNotice(
                            buildBatchPartialFailureMessage({
                                failed: errors.length,
                                total: jobs.length,
                                errors: errors.map((error) => summarizeApiError(error, t('error.unexpected'), t)),
                                t
                            })
                        )
                    );
                }
                return;
            }

            const result = await executeImageRequestForCurrentOptions();
            durationMs = Date.now() - startTime;
            await commitCompletedImages(
                result.images || [],
                result.usage,
                result.actualCost,
                durationMs,
                effectiveFormData,
                requestMode,
                false,
                historyPromptOverride
            );
            shouldKeepRetryArgs = false;
        } catch (err: unknown) {
            durationMs = Date.now() - startTime;
            console.error(`API 调用在 ${durationMs}ms 后失败：`, err);
            if (hasPreservedDisplayedAuthError(err)) {
                setGenerationFailureMessage(t('error.passwordExpired'));
                setLatestImageBatch(null);
                setStreamingPreviewImages(new Map());
                return;
            }
            const errorSummary = summarizeApiError(err, t('error.unexpected'), t);
            const message = buildUserFacingApiErrorMessage({ ...errorSummary, t });
            setError(createErrorNotice(message));
            setGenerationFailureMessage(message);
            setLatestImageBatch(null);
            setHistory((prevHistory) => [
                buildFailedHistoryEntry({
                    message,
                    durationMs,
                    formData: effectiveFormData,
                    requestMode,
                    storageMode: effectiveStorageModeClient
                }),
                ...prevHistory
            ]);
            setStreamingPreviewImages(new Map());
            await refreshRuntimeCapabilities();
        } finally {
            if (durationMs === 0) durationMs = Date.now() - startTime;
            if (!shouldKeepRetryArgs) {
                setLastApiCallArgs(null);
            }
            setActiveRequestStreaming(false);
            setIsLoading(false);
        }
    }

    function handleMobilePrimaryAction() {
        if (isLoading || isSendingToEdit) return;
        if (mobilePrimaryDisabledReason) {
            setError(createErrorNotice(mobilePrimaryDisabledReason));
            return;
        }
        if (mode === 'generate') {
            const batchPrompts = workbenchMode === 'batch' ? readBatchPromptLines(genBatchPromptText) : undefined;
            const formData: GenerationFormData = {
                prompt: batchPrompts && batchPrompts.length > 0 ? batchPrompts[0] : genPrompt,
                n: genN[0],
                size: genSize,
                customWidth: genCustomWidth,
                customHeight: genCustomHeight,
                quality: genQuality,
                output_format: genOutputFormat,
                ...(genOutputFormat === 'jpeg' || genOutputFormat === 'webp'
                    ? { output_compression: genCompression[0] }
                    : {}),
                background: genBackground,
                moderation: genModeration,
                model: genModel,
                image_backend: genImageBackend,
                streaming_strategy: genStreamingStrategy,
                responsesModel: genResponsesModel,
                thinking: genThinking,
                promptOptimization: genPromptOptimization,
                forceWeb: genForceWeb,
                enableParallelBatch,
                ...(batchPrompts ? { batchPrompts } : {})
            };
            void handleApiCall(formData);
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
            ...(editOutputFormat === 'jpeg' || editOutputFormat === 'webp'
                ? { output_compression: editCompression[0] }
                : {}),
            moderation: editModeration,
            imageFiles: editImageFiles,
            maskFile: editGeneratedMaskFile,
            model: editModel,
            image_backend: editImageBackend,
            streaming_strategy: editStreamingStrategy,
            responsesModel: editResponsesModel,
            thinking: editThinking,
            promptOptimization: editPromptOptimization,
            forceWeb: editForceWeb,
            enableParallelBatch
        };
        void handleApiCall(formData);
    }

    const buildCurrentGenerationFallbackFormData = React.useCallback((): GenerationFormData => {
        return {
            prompt: genPrompt,
            n: genN[0],
            size: genSize,
            customWidth: genCustomWidth,
            customHeight: genCustomHeight,
            quality: genQuality,
            output_format: genOutputFormat,
            ...(genOutputFormat === 'jpeg' || genOutputFormat === 'webp'
                ? { output_compression: genCompression[0] }
                : {}),
            background: genBackground,
            moderation: genModeration,
            model: genModel,
            image_backend: genImageBackend,
            streaming_strategy: genStreamingStrategy,
            responsesModel: genResponsesModel,
            thinking: genThinking,
            promptOptimization: genPromptOptimization,
            forceWeb: genForceWeb,
            enableParallelBatch
        };
    }, [
        enableParallelBatch,
        genBackground,
        genCompression,
        genCustomHeight,
        genCustomWidth,
        genForceWeb,
        genImageBackend,
        genModel,
        genModeration,
        genN,
        genOutputFormat,
        genPrompt,
        genPromptOptimization,
        genQuality,
        genResponsesModel,
        genSize,
        genStreamingStrategy,
        genThinking
    ]);

    const applyHistoryGenerationFormData = React.useCallback(
        (formData: GenerationFormData, item: HistoryMetadata) => {
            const normalizedFormData = normalizeImageUpstreamRuntimeFields(formData, {
                allowResponsesImageBackend: allowResponsesHistoryRoute
            });
            const trimmedPrompt = normalizedFormData.prompt.trim();
            const restoredFields = [t('reuse.fieldPrompt')];

            setGenPrompt(trimmedPrompt || normalizedFormData.prompt);
            handleGenModelChange(normalizedFormData.model);
            setGenSize(normalizedFormData.size);
            setGenCustomWidth(normalizedFormData.customWidth);
            setGenCustomHeight(normalizedFormData.customHeight);
            setGenQuality(normalizedFormData.quality);
            setGenBackground(normalizedFormData.background);
            setGenModeration(normalizedFormData.moderation);
            setGenOutputFormat(normalizedFormData.output_format);
            setGenImageBackend(normalizedFormData.image_backend);
            setGenStreamingStrategy(normalizedFormData.streaming_strategy);
            setGenResponsesModel(normalizedFormData.responsesModel);
            setGenThinking(normalizedFormData.thinking);
            setGenPromptOptimization(normalizedFormData.promptOptimization);
            setGenForceWeb(normalizedFormData.forceWeb);
            setEnableParallelBatch(normalizedFormData.enableParallelBatch);
            if (normalizedFormData.output_compression !== undefined) {
                setGenCompression([normalizedFormData.output_compression]);
            }

            restoredFields.push(
                t('reuse.fieldModel'),
                t('reuse.fieldSize'),
                t('reuse.fieldQuality'),
                t('reuse.fieldBackground'),
                t('reuse.fieldModeration'),
                t('reuse.fieldFormat'),
                t('reuse.fieldRoute')
            );

            if (normalizedFormData.batchPrompts && normalizedFormData.batchPrompts.length > 1) {
                setGenBatchPromptText(normalizedFormData.batchPrompts.join('\n'));
                setGenN([1]);
                setWorkbenchMode('batch');
            } else {
                setGenBatchPromptText('');
                setGenN([normalizedFormData.n]);
                restoredFields.push(t('reuse.fieldCount'));
                setWorkbenchMode('reuse');
            }

            setReuseContext({
                sourceLabel: t('reuse.sourceHistory', {
                    time: new Date(item.timestamp).toLocaleString(locale)
                }),
                restoredFields: Array.from(new Set(restoredFields)),
                promptPreview: trimmedPrompt || t('history.noPrompt')
            });
            setMode('generate');
            return normalizedFormData;
        },
        [allowResponsesHistoryRoute, handleGenModelChange, locale, t]
    );

    function handleCreateVariant() {
        if (!canCreateResultVariant || isLoading || isSendingToEdit) return;
        if (activeResultSource) {
            const formData = buildHistoryGenerationFormData(
                activeResultSource,
                buildCurrentGenerationFallbackFormData()
            );
            const normalizedFormData = applyHistoryGenerationFormData(formData, activeResultSource);
            void handleApiCall(normalizedFormData, 'generate');
            return;
        }
        handleMobilePrimaryAction();
    }

    function handleReuseCurrentPrompt() {
        if (!canReuseResultPrompt || isLoading || isSendingToEdit) return;
        if (activeResultSource) {
            const formData = buildHistoryGenerationFormData(
                activeResultSource,
                buildCurrentGenerationFallbackFormData()
            );
            applyHistoryGenerationFormData(formData, activeResultSource);
            return;
        }
        const promptToReuse = mode === 'edit' && editPrompt.trim() ? editPrompt : currentPrompt;
        const trimmedPrompt = promptToReuse.trim();
        if (trimmedPrompt) {
            setGenPrompt(trimmedPrompt);
            setReuseContext({
                sourceLabel: t('reuse.sourceCurrent'),
                restoredFields: [t('reuse.fieldPrompt')],
                promptPreview: trimmedPrompt
            });
        }
        setWorkbenchMode('reuse');
        setMode('generate');
    }

    const handleHistorySelect = React.useCallback(
        async (item: HistoryMetadata) => {
            const originalStorageMode = item.storageModeUsed || 'fs';
            if (originalStorageMode === 'fs' && !(await refreshImageAccessCookie())) {
                return;
            }
            setCompletedGenerationCount(null);

            const selectedBatchPromises = item.images.map(async (imgInfo, imageIndex) => {
                let path: string | undefined;
                if (originalStorageMode === 'indexeddb') {
                    path = getImageSrc(imgInfo.filename);
                } else {
                    path = `/api/image/${imgInfo.filename}`;
                }

                const clientRequestId = resolveHistoryImageClientRequestId(item, imageIndex);
                if (path) {
                    return {
                        path,
                        filename: imgInfo.filename,
                        storageMode: originalStorageMode,
                        ...(clientRequestId ? { clientRequestId } : {})
                    };
                } else {
                    console.warn(
                        `Could not get image source for history item: ${imgInfo.filename} (mode: ${originalStorageMode})`
                    );
                    setError(createErrorNotice(t('error.historyImageLoad', { filename: imgInfo.filename })));
                    return null;
                }
            });

            Promise.all(selectedBatchPromises).then((resolvedBatch) => {
                const validImages = resolvedBatch.filter(Boolean) as ApiImageResult[];

                if (validImages.length !== item.images.length) {
                    setError(createErrorNotice(t('error.historySomeMissing')));
                } else {
                    setError(null);
                }

                setLatestImageBatch(validImages.length > 0 ? validImages : null);
                setActiveResultSource(validImages.length > 0 ? item : null);
                setImageOutputView(validImages.length > 1 ? 'grid' : 0);
            });
        },
        [createErrorNotice, getImageSrc, refreshImageAccessCookie, t]
    );

    const handleApplyPrompt = React.useCallback(
        (prompt: string, source: PromptApplySource) => {
            const trimmedPrompt = prompt.trim();
            const restoredFields = [t('reuse.fieldPrompt')];

            if (source.type === 'history') {
                const formData = buildHistoryGenerationFormData(source.item, buildCurrentGenerationFallbackFormData());
                applyHistoryGenerationFormData(formData, source.item);
                return;
            } else {
                setGenPrompt(trimmedPrompt || prompt);
                setReuseContext({
                    sourceLabel: t('reuse.sourceInspiration', { title: source.title }),
                    restoredFields,
                    promptPreview: trimmedPrompt || t('history.noPrompt')
                });
            }

            setWorkbenchMode('reuse');
            setMode('generate');
        },
        [applyHistoryGenerationFormData, buildCurrentGenerationFallbackFormData, t]
    );

    const handleSaveInspiration = React.useCallback((prompt: string) => {
        const trimmedPrompt = prompt.trim();
        if (!trimmedPrompt) return;
        setInspirations((current) => {
            const existing = current.find((item) => item.prompt === trimmedPrompt);
            if (existing) {
                return [existing, ...current.filter((item) => item.id !== existing.id)];
            }
            return [{ id: Date.now(), prompt: trimmedPrompt, createdAt: Date.now() }, ...current].slice(0, 24);
        });
    }, []);

    const readQueuedResultFeedbackSyncs = React.useCallback((): FeedbackSyncPayload[] => {
        try {
            return parseHistoryFeedbackSyncQueue(readLocalStorageValue(resultFeedbackSyncQueueLocalStorageKey));
        } catch (error) {
            console.error('读取结果反馈补偿队列失败。', error);
            return [];
        }
    }, []);

    const writeQueuedResultFeedbackSyncs = React.useCallback((queue: FeedbackSyncPayload[]) => {
        try {
            if (queue.length === 0) {
                window.localStorage.removeItem(resultFeedbackSyncQueueLocalStorageKey);
                return;
            }
            window.localStorage.setItem(
                resultFeedbackSyncQueueLocalStorageKey,
                serializeHistoryFeedbackSyncQueue(queue)
            );
        } catch (error) {
            console.error('写入结果反馈补偿队列失败。', error);
        }
    }, []);

    const upsertQueuedResultFeedbackSync = React.useCallback(
        (payload: FeedbackSyncPayload) => {
            writeQueuedResultFeedbackSyncs(
                upsertHistoryFeedbackSyncQueue(
                    readQueuedResultFeedbackSyncs(),
                    payload,
                    resultFeedbackSyncQueueMaxItems
                )
            );
        },
        [readQueuedResultFeedbackSyncs, writeQueuedResultFeedbackSyncs]
    );

    const removeQueuedResultFeedbackSync = React.useCallback(
        (key: string) => {
            writeQueuedResultFeedbackSyncs(removeHistoryFeedbackSyncQueueItem(readQueuedResultFeedbackSyncs(), key));
        },
        [readQueuedResultFeedbackSyncs, writeQueuedResultFeedbackSyncs]
    );

    const clearScheduledResultFeedbackSync = React.useCallback((key: string) => {
        const timer = resultFeedbackRetryTimersRef.current.get(key);
        if (timer) {
            clearTimeout(timer);
            resultFeedbackRetryTimersRef.current.delete(key);
        }
        const controller = resultFeedbackSyncAbortControllersRef.current.get(key);
        if (controller) {
            controller.abort();
            resultFeedbackSyncAbortControllersRef.current.delete(key);
        }
        scheduledResultFeedbackSyncKeysRef.current.delete(key);
        scheduledResultFeedbackSyncPayloadsRef.current.delete(key);
    }, []);

    const clearOverlappingResultFeedbackSyncs = React.useCallback(
        (targets: HistoryFeedbackTarget[]) => {
            scheduledResultFeedbackSyncPayloadsRef.current.forEach((scheduledPayload, scheduledKey) => {
                if (!haveHistoryFeedbackTargetOverlap(scheduledPayload.targets, targets)) return;
                clearScheduledResultFeedbackSync(scheduledKey);
            });
        },
        [clearScheduledResultFeedbackSync]
    );

    const clearResultFeedbackSyncsForDelete = React.useCallback(
        (payload: HistoryFeedbackDeletePayload) => {
            scheduledResultFeedbackSyncPayloadsRef.current.forEach((scheduledPayload, scheduledKey) => {
                if (!shouldFeedbackDeleteClearSync(payload, scheduledPayload)) return;
                clearScheduledResultFeedbackSync(scheduledKey);
            });
        },
        [clearScheduledResultFeedbackSync]
    );

    const clearScheduledResultFeedbackDelete = React.useCallback((deleteKey: string) => {
        const retryTimerKey = `delete:${deleteKey}`;
        const timer = resultFeedbackRetryTimersRef.current.get(retryTimerKey);
        if (timer) {
            clearTimeout(timer);
            resultFeedbackRetryTimersRef.current.delete(retryTimerKey);
        }
        const controller = resultFeedbackDeleteAbortControllersRef.current.get(retryTimerKey);
        if (controller) {
            controller.abort();
            resultFeedbackDeleteAbortControllersRef.current.delete(retryTimerKey);
        }
        scheduledResultFeedbackDeleteKeysRef.current.delete(deleteKey);
        scheduledResultFeedbackDeletePayloadsRef.current.delete(deleteKey);
    }, []);

    const clearResultFeedbackDeletesForSync = React.useCallback(
        (payload: FeedbackSyncPayload, clearLegacyDeletes: boolean) => {
            const remainingPayloads: HistoryFeedbackDeletePayload[] = [];
            scheduledResultFeedbackDeletePayloadsRef.current.forEach((scheduledPayload, scheduledKey) => {
                const shouldClear =
                    scheduledPayload.deletedAt === undefined
                        ? clearLegacyDeletes &&
                          haveHistoryFeedbackTargetOverlap(scheduledPayload.targets, payload.targets)
                        : shouldFeedbackSyncClearDelete(payload, scheduledPayload);
                if (!shouldClear) return;
                remainingPayloads.push(...removeHistoryFeedbackDeleteQueueTargets([scheduledPayload], payload.targets));
                clearScheduledResultFeedbackDelete(scheduledKey);
            });
            return remainingPayloads;
        },
        [clearScheduledResultFeedbackDelete]
    );

    const readQueuedResultFeedbackDeletes = React.useCallback((): HistoryFeedbackDeletePayload[] => {
        try {
            return parseHistoryFeedbackDeleteQueue(readLocalStorageValue(resultFeedbackDeleteQueueLocalStorageKey));
        } catch (error) {
            console.error('读取结果反馈删除补偿队列失败。', error);
            return [];
        }
    }, []);

    const writeQueuedResultFeedbackDeletes = React.useCallback((queue: HistoryFeedbackDeletePayload[]) => {
        try {
            if (queue.length === 0) {
                window.localStorage.removeItem(resultFeedbackDeleteQueueLocalStorageKey);
                return;
            }
            window.localStorage.setItem(
                resultFeedbackDeleteQueueLocalStorageKey,
                serializeHistoryFeedbackDeleteQueue(queue)
            );
        } catch (error) {
            console.error('写入结果反馈删除补偿队列失败。', error);
        }
    }, []);

    const upsertQueuedResultFeedbackDeletes = React.useCallback(
        (payload: HistoryFeedbackDeletePayload) => {
            writeQueuedResultFeedbackDeletes(
                upsertHistoryFeedbackDeleteQueue(
                    readQueuedResultFeedbackDeletes(),
                    payload,
                    resultFeedbackDeleteQueueMaxItems
                )
            );
        },
        [readQueuedResultFeedbackDeletes, writeQueuedResultFeedbackDeletes]
    );

    const removeQueuedResultFeedbackDeletePayload = React.useCallback(
        (payload: HistoryFeedbackDeletePayload) => {
            writeQueuedResultFeedbackDeletes(
                removeHistoryFeedbackDeleteQueuePayload(readQueuedResultFeedbackDeletes(), payload)
            );
        },
        [readQueuedResultFeedbackDeletes, writeQueuedResultFeedbackDeletes]
    );

    const syncResultFeedback = React.useCallback(async (payload: FeedbackSyncPayload, signal: AbortSignal) => {
        const hasNoteInput = Object.prototype.hasOwnProperty.call(payload, 'note');
        const requestSignal = createFeedbackRequestSignal(signal);
        try {
            const response = await fetch('/api/feedback', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                signal: requestSignal.signal,
                body: JSON.stringify({
                    targets: payload.targets,
                    value: payload.value,
                    updatedAt: new Date(payload.updatedAt).toISOString(),
                    ...(hasNoteInput ? { note: payload.note ?? '' } : {})
                })
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(text || `反馈同步失败，状态码 ${response.status}`);
            }
        } finally {
            requestSignal.cleanup();
        }
    }, []);

    const scheduleResultFeedbackSyncPayload = React.useCallback(
        (payload: FeedbackSyncPayload, options: FeedbackSyncScheduleOptions = {}) => {
            const syncKey = payload.key;
            if (completedResultFeedbackSyncKeysRef.current.has(syncKey)) return;
            if (scheduledResultFeedbackSyncKeysRef.current.has(syncKey)) return;
            const queuedDeletes = readQueuedResultFeedbackDeletes();
            const clearLegacyDeletes = options.pruneQueuedTargets === true;
            const isBlockedByDelete = (deletePayload: HistoryFeedbackDeletePayload) => {
                if (deletePayload.deletedAt === undefined) {
                    return (
                        !clearLegacyDeletes && haveHistoryFeedbackTargetOverlap(deletePayload.targets, payload.targets)
                    );
                }
                return shouldFeedbackDeleteClearSync(deletePayload, payload);
            };
            const hasBlockingDelete =
                Array.from(scheduledResultFeedbackDeletePayloadsRef.current.values()).some(isBlockedByDelete) ||
                queuedDeletes.some(isBlockedByDelete);
            if (hasBlockingDelete) {
                const nextSyncQueue = queuedDeletes.reduce(
                    (currentQueue, deletePayload) =>
                        isBlockedByDelete(deletePayload)
                            ? removeHistoryFeedbackSyncQueueTargetsForDelete(currentQueue, deletePayload)
                            : currentQueue,
                    readQueuedResultFeedbackSyncs()
                );
                writeQueuedResultFeedbackSyncs(nextSyncQueue);
                return;
            }
            const remainingDeleteTargets = clearResultFeedbackDeletesForSync(payload, clearLegacyDeletes);
            writeQueuedResultFeedbackDeletes(
                clearLegacyDeletes
                    ? removeHistoryFeedbackDeleteQueueTargets(queuedDeletes, payload.targets)
                    : pruneHistoryFeedbackDeleteQueueForSyncQueue(queuedDeletes, [payload])
            );
            for (const remainingDeletePayload of remainingDeleteTargets) {
                scheduleResultFeedbackDeletePayloadRef.current?.(remainingDeletePayload);
            }
            if (options.pruneQueuedTargets) {
                writeQueuedResultFeedbackSyncs(
                    removeHistoryFeedbackSyncQueueTargets(readQueuedResultFeedbackSyncs(), payload.targets)
                );
                clearOverlappingResultFeedbackSyncs(payload.targets);
            }
            scheduledResultFeedbackSyncKeysRef.current.add(syncKey);
            scheduledResultFeedbackSyncPayloadsRef.current.set(syncKey, payload);

            const runAttempt = async (attempt: number): Promise<void> => {
                const controller = new AbortController();
                resultFeedbackSyncAbortControllersRef.current.set(syncKey, controller);
                try {
                    await syncResultFeedback(payload, controller.signal);
                    rememberCompletedResultFeedbackSyncKey(completedResultFeedbackSyncKeysRef.current, syncKey);
                    removeQueuedResultFeedbackSync(syncKey);
                    resultFeedbackSyncAbortControllersRef.current.delete(syncKey);
                    scheduledResultFeedbackSyncPayloadsRef.current.delete(syncKey);
                    scheduledResultFeedbackSyncKeysRef.current.delete(syncKey);
                } catch (syncError) {
                    resultFeedbackSyncAbortControllersRef.current.delete(syncKey);
                    if (controller.signal.aborted) return;
                    upsertQueuedResultFeedbackSync(payload);
                    if (attempt < resultFeedbackSyncMaxAttempts) {
                        const delayMs =
                            resultFeedbackSyncRetryDelaysMs[
                                Math.min(attempt - 1, resultFeedbackSyncRetryDelaysMs.length - 1)
                            ];
                        console.warn('结果反馈同步到服务端失败，将重试。', {
                            attempt,
                            nextAttempt: attempt + 1,
                            delayMs,
                            syncError
                        });
                        const timer = setTimeout(() => {
                            resultFeedbackRetryTimersRef.current.delete(syncKey);
                            void runAttempt(attempt + 1);
                        }, delayMs);
                        resultFeedbackRetryTimersRef.current.set(syncKey, timer);
                        return;
                    }
                    scheduledResultFeedbackSyncPayloadsRef.current.delete(syncKey);
                    scheduledResultFeedbackSyncKeysRef.current.delete(syncKey);
                    console.error('结果反馈同步到服务端失败。', syncError);
                    setError(createErrorNotice(t('error.resultFeedbackSync')));
                }
            };

            void runAttempt(1);
        },
        [
            clearOverlappingResultFeedbackSyncs,
            clearResultFeedbackDeletesForSync,
            createErrorNotice,
            readQueuedResultFeedbackDeletes,
            readQueuedResultFeedbackSyncs,
            removeQueuedResultFeedbackSync,
            syncResultFeedback,
            t,
            upsertQueuedResultFeedbackSync,
            writeQueuedResultFeedbackDeletes,
            writeQueuedResultFeedbackSyncs
        ]
    );

    const scheduleResultFeedbackSync = React.useCallback(
        (input: FeedbackSyncInput) => {
            const payload = buildHistoryFeedbackSyncPayload(input);
            if (!payload) {
                console.warn('结果反馈仅写入本地历史：缺少可同步的 clientRequestId。', {
                    timestamp: input.item.timestamp
                });
                return;
            }
            scheduleResultFeedbackSyncPayload(payload, { pruneQueuedTargets: true });
        },
        [scheduleResultFeedbackSyncPayload]
    );

    const deleteResultFeedbackPayload = React.useCallback(
        async (payload: HistoryFeedbackDeletePayload, signal: AbortSignal) => {
            for (let index = 0; index < payload.targets.length; index += feedbackApiTargetBatchSize) {
                const chunk = payload.targets.slice(index, index + feedbackApiTargetBatchSize);
                if (chunk.length === 0) continue;
                const requestSignal = createFeedbackRequestSignal(signal);
                try {
                    const response = await fetch('/api/feedback', {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        signal: requestSignal.signal,
                        body: JSON.stringify({
                            targets: chunk,
                            ...(payload.deletedAt !== undefined
                                ? { deletedAt: new Date(payload.deletedAt).toISOString() }
                                : {})
                        })
                    });
                    if (!response.ok) {
                        const text = await response.text().catch(() => '');
                        throw new Error(text || `反馈删除同步失败，状态码 ${response.status}`);
                    }
                } finally {
                    requestSignal.cleanup();
                }
            }
        },
        []
    );

    const scheduleResultFeedbackDeletePayload = React.useCallback(
        (payload: HistoryFeedbackDeletePayload) => {
            if (payload.targets.length === 0) return;
            const deleteKey = payload.key;
            const scheduledPayload = scheduledResultFeedbackDeletePayloadsRef.current.get(deleteKey);
            if (scheduledPayload) {
                if (!shouldReplaceHistoryFeedbackDeletePayload(scheduledPayload, payload)) return;
                clearScheduledResultFeedbackDelete(deleteKey);
            }
            clearResultFeedbackSyncsForDelete(payload);
            writeQueuedResultFeedbackSyncs(
                removeHistoryFeedbackSyncQueueTargetsForDelete(readQueuedResultFeedbackSyncs(), payload)
            );
            upsertQueuedResultFeedbackDeletes(payload);

            scheduledResultFeedbackDeleteKeysRef.current.add(deleteKey);
            scheduledResultFeedbackDeletePayloadsRef.current.set(deleteKey, payload);

            const retryTimerKey = `delete:${deleteKey}`;
            const runDeleteAttempt = (attempt: number) => {
                const controller = new AbortController();
                resultFeedbackDeleteAbortControllersRef.current.set(retryTimerKey, controller);
                void deleteResultFeedbackPayload(payload, controller.signal)
                    .then(() => {
                        if (resultFeedbackDeleteAbortControllersRef.current.get(retryTimerKey) === controller) {
                            resultFeedbackDeleteAbortControllersRef.current.delete(retryTimerKey);
                        }
                        if (scheduledResultFeedbackDeletePayloadsRef.current.get(deleteKey) !== payload) return;
                        removeQueuedResultFeedbackDeletePayload(payload);
                        scheduledResultFeedbackDeleteKeysRef.current.delete(deleteKey);
                        scheduledResultFeedbackDeletePayloadsRef.current.delete(deleteKey);
                    })
                    .catch((deleteError) => {
                        if (resultFeedbackDeleteAbortControllersRef.current.get(retryTimerKey) === controller) {
                            resultFeedbackDeleteAbortControllersRef.current.delete(retryTimerKey);
                        }
                        if (controller.signal.aborted) return;
                        if (scheduledResultFeedbackDeletePayloadsRef.current.get(deleteKey) !== payload) return;
                        if (attempt < resultFeedbackDeleteMaxAttempts) {
                            const delayMs =
                                resultFeedbackDeleteRetryDelaysMs[attempt - 1] ??
                                resultFeedbackDeleteRetryDelaysMs[resultFeedbackDeleteRetryDelaysMs.length - 1];
                            const retryTimer = setTimeout(() => {
                                resultFeedbackRetryTimersRef.current.delete(retryTimerKey);
                                runDeleteAttempt(attempt + 1);
                            }, delayMs);
                            resultFeedbackRetryTimersRef.current.set(retryTimerKey, retryTimer);
                            console.warn('结果反馈从服务端状态删除失败，将重试。', {
                                attempt,
                                nextAttempt: attempt + 1,
                                delayMs,
                                deleteError
                            });
                            return;
                        }
                        resultFeedbackRetryTimersRef.current.delete(retryTimerKey);
                        scheduledResultFeedbackDeleteKeysRef.current.delete(deleteKey);
                        scheduledResultFeedbackDeletePayloadsRef.current.delete(deleteKey);
                        console.error('结果反馈从服务端状态删除失败。', deleteError);
                        setError(createErrorNotice(t('error.resultFeedbackDeleteSync')));
                    });
            };

            runDeleteAttempt(1);
        },
        [
            createErrorNotice,
            clearScheduledResultFeedbackDelete,
            clearResultFeedbackSyncsForDelete,
            deleteResultFeedbackPayload,
            readQueuedResultFeedbackSyncs,
            removeQueuedResultFeedbackDeletePayload,
            t,
            upsertQueuedResultFeedbackDeletes,
            writeQueuedResultFeedbackSyncs
        ]
    );

    const scheduleResultFeedbackDeleteTargets = React.useCallback(
        (targets: HistoryFeedbackTarget[]) => {
            const payload = buildHistoryFeedbackDeletePayload(targets, Date.now());
            if (payload) scheduleResultFeedbackDeletePayload(payload);
        },
        [scheduleResultFeedbackDeletePayload]
    );

    React.useEffect(() => {
        scheduleResultFeedbackDeletePayloadRef.current = scheduleResultFeedbackDeletePayload;
        return () => {
            if (scheduleResultFeedbackDeletePayloadRef.current === scheduleResultFeedbackDeletePayload) {
                scheduleResultFeedbackDeletePayloadRef.current = null;
            }
        };
    }, [scheduleResultFeedbackDeletePayload]);

    React.useEffect(() => {
        if (hasProcessedQueuedResultFeedbackDeletesRef.current) return;
        hasProcessedQueuedResultFeedbackDeletesRef.current = true;
        const queued = readQueuedResultFeedbackDeletes();
        if (queued.length === 0) return;
        const pruned = pruneHistoryFeedbackDeleteQueueForSyncQueue(queued, readQueuedResultFeedbackSyncs());
        if (pruned.length !== queued.length) {
            writeQueuedResultFeedbackDeletes(pruned);
        }
        if (pruned.length === 0) return;
        pruned.forEach(scheduleResultFeedbackDeletePayload);
    }, [
        readQueuedResultFeedbackDeletes,
        readQueuedResultFeedbackSyncs,
        scheduleResultFeedbackDeletePayload,
        writeQueuedResultFeedbackDeletes
    ]);

    React.useEffect(() => {
        if (hasProcessedQueuedResultFeedbackSyncsRef.current) return;
        hasProcessedQueuedResultFeedbackSyncsRef.current = true;
        const queued = readQueuedResultFeedbackSyncs();
        queued.forEach((payload) => scheduleResultFeedbackSyncPayload(payload));
    }, [readQueuedResultFeedbackSyncs, scheduleResultFeedbackSyncPayload]);

    React.useEffect(() => {
        if (!hasLoadedStoredHistoryRef.current) return;
        buildHistoryFeedbackSyncInputs(history).forEach(scheduleResultFeedbackSync);
    }, [history, scheduleResultFeedbackSync]);

    React.useEffect(() => {
        const timers = resultFeedbackRetryTimersRef.current;
        const syncControllers = resultFeedbackSyncAbortControllersRef.current;
        const deleteControllers = resultFeedbackDeleteAbortControllersRef.current;
        const scheduledSyncKeys = scheduledResultFeedbackSyncKeysRef.current;
        const scheduledSyncPayloads = scheduledResultFeedbackSyncPayloadsRef.current;
        const scheduledDeleteKeys = scheduledResultFeedbackDeleteKeysRef.current;
        const scheduledDeletePayloads = scheduledResultFeedbackDeletePayloadsRef.current;
        return () => {
            timers.forEach((timer) => clearTimeout(timer));
            timers.clear();
            syncControllers.forEach((controller) => controller.abort());
            syncControllers.clear();
            deleteControllers.forEach((controller) => controller.abort());
            deleteControllers.clear();
            scheduledSyncKeys.clear();
            scheduledSyncPayloads.clear();
            scheduledDeleteKeys.clear();
            scheduledDeletePayloads.clear();
        };
    }, []);

    const handleMarkResultFeedback = React.useCallback(
        (item: HistoryMetadata, value: ResultFeedbackValue) => {
            const updatedAt = Date.now();
            const currentFeedback =
                history.find((historyItem) => isSameHistoryEntry(historyItem, item))?.resultFeedback ??
                item.resultFeedback;
            const currentLocalNote = currentFeedback?.note;

            setHistory((current) =>
                updateHistoryResultFeedback({
                    history: current,
                    item,
                    value,
                    updatedAt
                })
            );
            setActiveResultSource((current) =>
                current && isSameHistoryEntry(current, item)
                    ? {
                          ...current,
                          resultFeedback: {
                              value,
                              updatedAt,
                              ...(currentLocalNote ? { note: currentLocalNote } : {})
                          }
                      }
                    : current
            );
            scheduleResultFeedbackSync({
                item,
                value,
                updatedAt,
                ...(currentLocalNote ? { note: currentLocalNote } : {})
            });
        },
        [history, scheduleResultFeedbackSync]
    );

    const handleUpdateResultFeedbackNote = React.useCallback(
        (item: HistoryMetadata, note: string) => {
            if (!item.resultFeedback) return;
            const resultFeedbackValue = item.resultFeedback.value;
            const updatedAt = Date.now();
            setHistory((current) =>
                updateHistoryResultFeedback({
                    history: current,
                    item,
                    value: resultFeedbackValue,
                    updatedAt,
                    note
                })
            );
            setActiveResultSource((current) =>
                current && isSameHistoryEntry(current, item)
                    ? {
                          ...current,
                          resultFeedback: {
                              value: resultFeedbackValue,
                              updatedAt,
                              ...(note ? { note } : {})
                          }
                      }
                    : current
            );
            scheduleResultFeedbackSync({ item, value: resultFeedbackValue, updatedAt, ...(note ? { note } : {}) });
        },
        [scheduleResultFeedbackSync]
    );

    const handleDeleteInspiration = React.useCallback((id: number) => {
        setInspirations((current) => current.filter((item) => item.id !== id));
    }, []);

    const handleClearHistory = React.useCallback(async () => {
        const confirmationMessage =
            effectiveStorageModeClient === 'indexeddb'
                ? t('confirm.clearHistoryIndexedDb')
                : t('confirm.clearHistoryFs');

        if (window.confirm(confirmationMessage)) {
            const feedbackDeleteTargets = buildHistoryFeedbackDeleteTargets(history);

            try {
                if (effectiveStorageModeClient === 'indexeddb') {
                    await db.images.clear();
                    blobUrlCacheRef.current.forEach((url) => URL.revokeObjectURL(url));
                    blobUrlCacheRef.current.clear();
                }
                localStorage.removeItem('openaiImageHistory');
                scheduleResultFeedbackDeleteTargets(feedbackDeleteTargets);
                setHistory([]);
                setLatestImageBatch(null);
                setActiveResultSource(null);
                setCompletedGenerationCount(null);
                setImageOutputView('grid');
                setError(null);
            } catch (e) {
                console.error('清空历史记录失败：', e);
                setError(createErrorNotice(t('error.clearHistory')));
            }
        }
    }, [createErrorNotice, history, scheduleResultFeedbackDeleteTargets, t]);

    const resolveImageBlob = React.useCallback(
        async (filename: string, storageMode: ImageStorageMode = effectiveStorageModeClient): Promise<Blob> => {
            if (storageMode === 'indexeddb') {
                const record = allDbImages?.find((img) => img.filename === filename);
                if (!record?.blob) {
                    throw new ApiRequestError(t('error.imageNotFoundDb', { filename }));
                }
                return record.blob;
            }

            if (!(await refreshImageAccessCookie())) {
                throw new ApiRequestError(t('error.imageAccessRefreshFailed'));
            }
            let response: Response;
            try {
                response = await fetch(`/api/image/${filename}`);
            } catch {
                throw new ApiRequestError(t('error.retrieveImage', { filename }));
            }
            if (!response.ok) {
                throw new ApiRequestError(t('error.fetchImage', { status: response.status }));
            }
            try {
                return await response.blob();
            } catch {
                throw new ApiRequestError(t('error.retrieveImage', { filename }));
            }
        },
        [allDbImages, refreshImageAccessCookie, t]
    );

    const handleDownloadImage = React.useCallback(
        async (filename: string, storageMode?: HistoryMetadata['storageModeUsed']) => {
            try {
                const blob = await resolveImageBlob(filename, storageMode);
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 150);
            } catch (error) {
                setError(
                    createErrorNotice(
                        error instanceof ApiRequestError ? error.message : t('error.retrieveImage', { filename })
                    )
                );
            }
        },
        [createErrorNotice, resolveImageBlob, t]
    );

    const handleDownloadHistoryItem = React.useCallback(
        async (item: HistoryMetadata) => {
            try {
                const storageMode = item.storageModeUsed ?? 'fs';
                const files = await Promise.all(
                    item.images.map(async (image, index) => ({
                        name: `${String(index + 1).padStart(2, '0')}-${image.filename}`,
                        blob: await resolveImageBlob(image.filename, storageMode),
                        modifiedAt: new Date(item.timestamp)
                    }))
                );
                const zipBlob = await createZipBlob(files);
                const url = URL.createObjectURL(zipBlob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `visual-journal-history-${item.timestamp}.zip`;
                document.body.appendChild(link);
                link.click();
                link.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 150);
            } catch (error) {
                setError(
                    createErrorNotice(error instanceof ApiRequestError ? error.message : t('error.downloadHistory'))
                );
            }
        },
        [createErrorNotice, resolveImageBlob, t]
    );

    const handleOpenShareImage = React.useCallback(
        (filename: string, storageMode?: HistoryMetadata['storageModeUsed']) => {
            setShareTargetFilename(filename);
            setShareTargetStorageMode(storageMode);
            setShareUrl(null);
            setShareError(null);
            setShareDialogSessionId((current) => current + 1);
            setShareDialogOpen(true);
        },
        []
    );

    const handleCreateShare = React.useCallback(
        async (values: ShareDialogValues) => {
            if (!shareTargetFilename) return;
            setIsCreatingShare(true);
            setShareError(null);
            try {
                const blob = await resolveImageBlob(shareTargetFilename, shareTargetStorageMode);
                const result = await createImageShareFromBlob({
                    filename: shareTargetFilename,
                    blob,
                    values,
                    accessRefreshErrorMessage: t('error.imageAccessRefreshFailed'),
                    createFailedMessage: t('share.createFailed'),
                    refreshImageAccessCookie,
                    pageUrl: window.location.href
                });
                setShareUrl(result.url);
            } catch (error) {
                setShareError(error instanceof Error ? error.message : t('share.createFailed'));
            } finally {
                setIsCreatingShare(false);
            }
        },
        [refreshImageAccessCookie, resolveImageBlob, shareTargetFilename, shareTargetStorageMode, t]
    );

    const handleSendToEdit = async (
        filename: string,
        storageMode: HistoryMetadata['storageModeUsed'] = effectiveStorageModeClient
    ): Promise<boolean> => {
        if (isLoading || sendingToEditRef.current) return false;
        sendingToEditRef.current = true;
        const sourceStorageMode = storageMode || 'fs';

        const alreadyExists = editImageFiles.some((file) => file.name === filename);
        if (mode === 'edit' && alreadyExists) {
            sendingToEditRef.current = false;
            setIsSendingToEdit(false);
            return true;
        }

        if (
            mode === 'edit' &&
            hasReachedEditSourceImageLimit({
                currentCount: editImageFiles.length,
                maxImages: maxEditSourceImages
            })
        ) {
            setError(createErrorNotice(t('error.maxEditImages', { count: maxEditSourceImages })));
            sendingToEditRef.current = false;
            setIsSendingToEdit(false);
            return false;
        }

        setCompletedGenerationCount(null);
        setStreamingPreviewImages(new Map());
        setBatchProgress(null);
        setIsSendingToEdit(true);
        setError(null);

        try {
            let blob: Blob | undefined;
            let mimeType: string = 'image/png';

            if (sourceStorageMode === 'indexeddb') {
                const record = allDbImages?.find((img) => img.filename === filename);
                if (record?.blob) {
                    blob = record.blob;
                    mimeType = blob.type || mimeType;
                } else {
                    throw new ApiRequestError(t('error.imageNotFoundDb', { filename }));
                }
            } else {
                if (!(await refreshImageAccessCookie())) {
                    return false;
                }
                let response: Response;
                try {
                    response = await fetch(`/api/image/${filename}`);
                } catch {
                    throw new ApiRequestError(t('error.sendToEdit'));
                }
                if (response.status === 401 && isPasswordRequiredByBackend) {
                    let result: { code?: string } = {};
                    try {
                        result = (await response.json()) as { code?: string };
                    } catch {
                        result = {};
                    }
                    if (isPagePasswordAuthErrorCode(result.code)) {
                        promptForExpiredPassword();
                    } else {
                        setError(createErrorNotice(t('error.authVerifyUnavailable')));
                    }
                    return false;
                }
                if (!response.ok) {
                    throw new ApiRequestError(t('error.fetchImage', { status: response.status }));
                }
                try {
                    blob = await response.blob();
                } catch {
                    throw new ApiRequestError(t('error.sendToEdit'));
                }
                mimeType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim() || mimeType;
            }

            if (!blob) {
                throw new ApiRequestError(t('error.retrieveImage', { filename }));
            }

            const newFile = new File([blob], filename, { type: mimeType });
            const validationFailure = validateEditSourceInput({
                imageFiles: [newFile],
                upstreamProfile: activeUpstreamProfile,
                imageBackend: editImageBackend,
                defaultImageBackend
            });
            if (validationFailure) {
                throw new ApiRequestError(formatEditSourceValidationFailure(validationFailure, t));
            }
            const newPreviewUrl = URL.createObjectURL(blob);

            setEditImageFiles([newFile]);
            updateEditSourceImagePreviewUrls([newPreviewUrl]);
            setEditReuseContext(null);

            if (mode === 'generate') {
                setMode('edit');
                setWorkbenchMode('edit');
            }
            return true;
        } catch (err: unknown) {
            console.error('发送图片到编辑模式失败：', err);
            const errorMessage = err instanceof ApiRequestError ? err.message : t('error.sendToEdit');
            setError(createErrorNotice(errorMessage));
            return false;
        } finally {
            sendingToEditRef.current = false;
            setIsSendingToEdit(false);
        }
    };

    const handleSendHistoryToEdit = async (item: HistoryMetadata) => {
        const firstImage = item.images[0];
        if (!firstImage) {
            setError(createErrorNotice(t('error.historyMissingImage')));
            return;
        }

        const sent = await handleSendToEdit(firstImage.filename, item.storageModeUsed || 'fs');
        if (!sent) return;

        const nextModel = item.model ?? editModel;
        const normalizedRouteFields = normalizeImageUpstreamRuntimeFields(
            {
                image_backend: item.image_backend ?? editImageBackend,
                streaming_strategy: item.streaming_strategy ?? editStreamingStrategy,
                responsesModel: item.responsesModel ?? editResponsesModel,
                thinking: item.thinking ?? editThinking,
                promptOptimization: item.promptOptimization ?? editPromptOptimization
            },
            { allowResponsesImageBackend: allowResponsesHistoryRoute }
        );
        const sizeSelection = readHistorySizeSelection(item, nextModel);
        const restoredFields = [t('reuse.fieldReferenceImage'), t('reuse.fieldPrompt')];
        setEditPrompt(item.prompt);
        handleEditModelChange(nextModel);
        setEditSize(sizeSelection.size);
        if (typeof sizeSelection.customWidth === 'number') {
            setEditCustomWidth(sizeSelection.customWidth);
        }
        if (typeof sizeSelection.customHeight === 'number') {
            setEditCustomHeight(sizeSelection.customHeight);
        }
        setEditQuality(item.quality);
        setEditModeration(item.moderation);
        setEnableParallelBatch(item.enableParallelBatch === true);
        setEditImageBackend(normalizedRouteFields.image_backend);
        setEditStreamingStrategy(normalizedRouteFields.streaming_strategy);
        setEditResponsesModel(normalizedRouteFields.responsesModel);
        setEditThinking(normalizedRouteFields.thinking);
        setEditPromptOptimization(normalizedRouteFields.promptOptimization);
        setEditForceWeb(item.forceWeb === true);
        const imageCount = readHistoryImageCountSelection(item.images.length);
        if (imageCount !== null) {
            setEditN([imageCount]);
            restoredFields.push(t('reuse.fieldCount'));
        }
        restoredFields.push(
            t('reuse.fieldModel'),
            t('reuse.fieldQuality'),
            t('reuse.fieldModeration'),
            t('reuse.fieldRoute')
        );
        if (sizeSelection.restored) {
            restoredFields.push(t('reuse.fieldSize'));
        }
        if (item.output_format) {
            setEditOutputFormat(item.output_format);
            restoredFields.push(t('reuse.fieldFormat'));
        }
        setEditReuseContext({
            sourceLabel: t('reuse.sourceHistory', {
                time: new Date(item.timestamp).toLocaleString(locale)
            }),
            restoredFields: Array.from(new Set(restoredFields)),
            promptPreview: item.prompt.trim() || t('history.noPrompt')
        });
        setMode('edit');
        setWorkbenchMode('edit');
    };

    const executeDeleteItem = React.useCallback(
        async (item: HistoryMetadata) => {
            if (!item) return;
            setError(null);

            const { images: imagesInEntry } = item;
            const storageModeUsed = item.storageModeUsed ?? 'fs';
            const filenamesToDelete = imagesInEntry.map((img) => img.filename);

            try {
                if (storageModeUsed === 'indexeddb') {
                    await db.images.where('filename').anyOf(filenamesToDelete).delete();
                    filenamesToDelete.forEach((fn) => {
                        const url = blobUrlCacheRef.current.get(fn);
                        if (url) URL.revokeObjectURL(url);
                        blobUrlCacheRef.current.delete(fn);
                    });
                } else if (storageModeUsed === 'fs') {
                    const apiPayload: { filenames: string[]; passwordHash?: string } = {
                        filenames: filenamesToDelete
                    };
                    if (isPasswordRequiredByBackend && clientPasswordHash) {
                        apiPayload.passwordHash = clientPasswordHash;
                    }

                    let response: Response;
                    try {
                        response = await fetch('/api/image-delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(apiPayload)
                        });
                    } catch {
                        throw new ApiRequestError(t('error.deleteUnexpected'));
                    }

                    let result: unknown;
                    try {
                        result = await response.json();
                    } catch {
                        throw new ApiRequestError(t('error.deleteUnexpected'));
                    }
                    if (!response.ok) {
                        throw new ApiRequestError(
                            response.status === 401 ? t('error.unauthorized') : t('error.deleteUnexpected')
                        );
                    }
                    let deletionResults: ReturnType<typeof readWebuiImageFileOperationResults>;
                    try {
                        deletionResults = readWebuiImageFileOperationResults(result);
                    } catch {
                        throw new ApiRequestError(t('error.deleteUnexpected'));
                    }
                    setLoadedWebuiImageRetentionState((current) =>
                        current?.scopeKey === retentionScopeKey
                            ? {
                                  ...current,
                                  filenames: mergeWebuiImageRetentionResults(
                                      current.filenames,
                                      'release',
                                      deletionResults
                                  )
                              }
                            : current
                    );
                    const unavailableFilenames = new Set(
                        deletionResults
                            .filter(
                                (resultItem) =>
                                    resultItem.success ||
                                    resultItem.fileDeleted === true ||
                                    resultItem.fileAbsent === true
                            )
                            .map((resultItem) => resultItem.filename)
                    );
                    const remainingImages = imagesInEntry.filter((image) => !unavailableFilenames.has(image.filename));
                    if (remainingImages.length !== imagesInEntry.length) {
                        setHistory((prevHistory) =>
                            remainingImages.length === 0
                                ? prevHistory.filter((historyItem) => !isSameHistoryEntry(historyItem, item))
                                : prevHistory.map((historyItem) =>
                                      isSameHistoryEntry(historyItem, item)
                                          ? { ...historyItem, images: remainingImages }
                                          : historyItem
                                  )
                        );
                        setLatestImageBatch((prev) => {
                            if (!prev) return prev;
                            const remainingBatch = prev.filter((image) => !unavailableFilenames.has(image.filename));
                            return remainingBatch.length > 0 ? remainingBatch : null;
                        });
                        setActiveResultSource((current) =>
                            !current || !isSameHistoryEntry(current, item)
                                ? current
                                : remainingImages.length === 0
                                  ? null
                                  : { ...current, images: remainingImages }
                        );
                        if (remainingImages.length === 0) {
                            scheduleResultFeedbackDeleteTargets(buildHistoryFeedbackDeleteTargets([item]));
                        }
                    }
                    if (deletionResults.some((resultItem) => !resultItem.success)) {
                        setError(createErrorNotice(t('error.deletePartial')));
                    }
                    return;
                }

                setHistory((prevHistory) =>
                    prevHistory.filter((historyItem) => !isSameHistoryEntry(historyItem, item))
                );
                setLatestImageBatch((prev) =>
                    prev && prev.some((img) => filenamesToDelete.includes(img.filename)) ? null : prev
                );
                setActiveResultSource((current) => (current && isSameHistoryEntry(current, item) ? null : current));
                scheduleResultFeedbackDeleteTargets(buildHistoryFeedbackDeleteTargets([item]));
            } catch (e: unknown) {
                console.error('删除条目失败：', e);
                setError(createErrorNotice(e instanceof ApiRequestError ? e.message : t('error.deleteUnexpected')));
            } finally {
                setItemToDeleteConfirm(null);
            }
        },
        [
            clientPasswordHash,
            createErrorNotice,
            isPasswordRequiredByBackend,
            retentionScopeKey,
            scheduleResultFeedbackDeleteTargets,
            t
        ]
    );

    const handleRequestDeleteItem = React.useCallback(
        (item: HistoryMetadata) => {
            if (!skipDeleteConfirmation) {
                setDialogCheckboxStateSkipConfirm(skipDeleteConfirmation);
                setItemToDeleteConfirm(item);
            } else {
                executeDeleteItem(item);
            }
        },
        [skipDeleteConfirmation, executeDeleteItem]
    );

    const handleConfirmDeletion = React.useCallback(() => {
        if (itemToDeleteConfirm) {
            executeDeleteItem(itemToDeleteConfirm);
            setSkipDeleteConfirmation(dialogCheckboxStateSkipConfirm);
        }
    }, [itemToDeleteConfirm, executeDeleteItem, dialogCheckboxStateSkipConfirm]);

    const handleCancelDeletion = React.useCallback(() => {
        setItemToDeleteConfirm(null);
    }, []);

    const showEntryLock = isPasswordRequiredByBackend === true && !isEntryAuthenticated;
    const getApiSettingsDialogFocusTarget = React.useCallback(() => {
        const trigger = apiSettingsDialogTriggerRef.current;
        if (trigger && trigger.getClientRects().length > 0 && !trigger.disabled) return trigger;
        if (typeof document === 'undefined') return null;
        return (
            Array.from(document.querySelectorAll<HTMLButtonElement>('[data-api-settings-trigger]')).find(
                (candidate) => candidate.getClientRects().length > 0 && !candidate.disabled
            ) ?? null
        );
    }, []);
    const openApiSettingsDialog = (event: React.MouseEvent<HTMLButtonElement>) => {
        apiSettingsDialogTriggerRef.current = event.currentTarget;
        setIsApiSettingsDialogOpen(true);
    };
    const outputFailureMessage =
        !isLoading && !isSendingToEdit && !latestImageBatch && error?.message === generationFailureMessage
            ? generationFailureMessage
            : null;
    const shouldExpandOutputStage =
        isLoading ||
        isSendingToEdit ||
        Boolean(latestImageBatch) ||
        Boolean(outputFailureMessage) ||
        (mode === 'edit' && Boolean(editSourceImagePreviewUrls[0]));
    const canRetryLastGeneration = Boolean(lastApiCallArgs) && !isLoading && !isSendingToEdit;
    function handleRetryLastGeneration() {
        if (!lastApiCallArgs) return;
        void handleApiCall(...lastApiCallArgs, clientPasswordHash);
    }

    return (
        <main className='studio-paper text-foreground min-h-screen overflow-x-hidden pb-[calc(var(--mobile-action-dock-height)+env(safe-area-inset-bottom))] [--mobile-action-dock-height:8.5rem] xl:h-dvh xl:pb-0'>
            <PasswordDialog
                isOpen={isPasswordDialogOpen}
                onOpenChange={setIsPasswordDialogOpen}
                onSave={handleSavePassword}
                title={passwordDialogContext === 'retry' ? t('password.required') : t('password.configure')}
                description={
                    passwordDialogContext === 'retry'
                        ? t('password.retryDescription')
                        : t('password.initialDescription')
                }
            />
            <ApiSettingsDialog
                isOpen={isApiSettingsDialogOpen}
                onOpenChange={setIsApiSettingsDialogOpen}
                settings={apiSettings}
                onSave={handleSaveApiSettings}
                getReturnFocusTarget={getApiSettingsDialogFocusTarget}
            />
            <ShareDialog
                key={shareDialogSessionId}
                open={shareDialogOpen}
                onOpenChange={setShareDialogOpen}
                isCreating={isCreatingShare}
                shareUrl={shareUrl}
                error={shareError}
                onCreate={handleCreateShare}
            />
            {isMobileCreationDrawerOpen ? (
                <p
                    data-mobile-generation-activity-announcer
                    role='status'
                    aria-live='polite'
                    aria-atomic='true'
                    className='sr-only'>
                    {announcedGenerationActivity
                        ? `${announcedGenerationActivity.label} ${announcedGenerationActivity.detail}`
                        : ''}
                </p>
            ) : null}
            {showEntryLock ? (
                <div className='mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-6 px-4 text-center'>
                    <div className='absolute top-3 right-4'>
                        <LanguageSelector />
                    </div>
                    <div className='bg-primary text-primary-foreground border-primary/20 flex size-14 items-center justify-center rounded-full border shadow-sm'>
                        <Lock className='h-6 w-6' />
                    </div>
                    <div className='space-y-2'>
                        <h1 className='text-2xl font-semibold'>{t('password.required')}</h1>
                        <p className='text-muted-foreground text-sm'>{t('password.entryDescription')}</p>
                    </div>
                    {error && (
                        <Alert
                            variant='destructive'
                            className='border-destructive/45 bg-destructive/10 text-destructive text-left'>
                            <AlertTitle>{t('common.error')}</AlertTitle>
                            <AlertDescription>{renderErrorDescription(error)}</AlertDescription>
                        </Alert>
                    )}
                    <Button
                        type='button'
                        onClick={() => {
                            setError(null);
                            setPasswordDialogContext('initial');
                            setIsPasswordDialogOpen(true);
                        }}
                        className='px-6'>
                        {t('password.unlock')}
                    </Button>
                </div>
            ) : null}
            {!showEntryLock && isPasswordRequiredByBackend !== null ? (
                <>
                    <a
                        href='#workbench-content'
                        className='bg-background text-foreground focus-visible:ring-ring sr-only z-[70] rounded-md px-4 py-2 shadow-lg focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus-visible:ring-2 focus-visible:outline-none'>
                        {t('app.skipToMainContent')}
                    </a>
                    {isMobileCreationDrawerOpen && (
                        <div
                            aria-hidden='true'
                            className='bg-foreground/25 fixed inset-0 z-40 lg:hidden'
                            onClick={closeMobileCreationDrawer}
                        />
                    )}
                    <div className='workbench-shell mx-auto flex min-h-screen w-full max-w-[1880px] min-w-0 flex-col px-4 py-3 lg:px-6 lg:py-5 xl:h-full xl:min-h-0'>
                        <header
                            aria-hidden={isMobileCreationDrawerOpen}
                            inert={isMobileCreationDrawerOpen}
                            className='workbench-header border-border/80 mb-4 flex shrink-0 flex-col gap-3 border-b pb-4 xl:flex-row xl:items-center xl:justify-between'>
                            <div className='workbench-header__brand flex min-w-0 items-center gap-3'>
                                <div className='flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1'>
                                    <h1 className='editorial-title shrink-0 text-2xl font-semibold tracking-normal sm:text-3xl'>
                                        {t('app.studioTitle')}
                                    </h1>
                                    <p className='text-muted-foreground min-w-0 text-sm'>{t('app.studioSubtitle')}</p>
                                </div>
                                <Button
                                    type='button'
                                    variant='outline'
                                    size='icon'
                                    onClick={openApiSettingsDialog}
                                    className='bg-card/80 ml-auto h-11 w-11 shrink-0 shadow-sm sm:hidden'
                                    data-api-settings-trigger
                                    aria-label={t('app.apiSettings')}>
                                    <Settings2 className='h-4 w-4' />
                                </Button>
                            </div>
                            <div className='workbench-header__tools flex min-w-0 flex-wrap items-center gap-2 sm:justify-end sm:gap-4'>
                                <WorkbenchStatusStrip
                                    model={activeWorkbenchModel}
                                    routeLabel={activeRouteLabel}
                                    streamStatus={getStreamingStatusLabel(streamMode, t)}
                                    parallelBatchEnabled={activeParallelBatchVisible}
                                    requestSummaryLabel={activeRequestSummaryLabel}
                                    runtimeHealthStatus={activeRuntimeHealthStatus}
                                    channelRouting={runtimeCapabilities?.channelRouting ?? null}
                                    runtimeLastFailure={runtimeCapabilities?.streamingBatch.lastFailure ?? null}
                                />
                                <LanguageSelector />
                                <div className='text-muted-foreground hidden items-center sm:flex'>
                                    <button
                                        type='button'
                                        onClick={openApiSettingsDialog}
                                        aria-label={t('app.apiSettings')}
                                        data-api-settings-trigger
                                        className='hover:bg-accent hover:text-foreground focus-visible:ring-ring flex h-11 w-11 items-center justify-center rounded-md transition-[background-color,color,box-shadow] focus-visible:ring-2 focus-visible:outline-none active:scale-[0.98] lg:h-9 lg:w-9'>
                                        <Settings2 className='h-4 w-4' />
                                    </button>
                                </div>
                            </div>
                        </header>
                        <div
                            id='workbench-content'
                            tabIndex={-1}
                            className='workbench-layout grid min-h-0 flex-1 grid-cols-1 gap-4 focus:outline-none lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]'>
                            <section
                                id='mobile-creation-sheet'
                                aria-label={t('app.creationControls')}
                                role={isMobileCreationDrawerOpen ? 'dialog' : undefined}
                                aria-modal={isMobileCreationDrawerOpen ? true : undefined}
                                onKeyDown={handleMobileCreationDrawerKeyDown}
                                className={`order-2 lg:static lg:order-1 lg:block lg:overflow-visible lg:p-0 lg:shadow-none xl:min-h-0 xl:overflow-hidden ${
                                    isMobileCreationDrawerOpen
                                        ? 'border-border bg-card fixed inset-x-0 top-4 bottom-0 z-50 flex min-h-0 flex-col overflow-hidden rounded-t-lg border-t px-3 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-16px_36px_rgba(15,23,42,0.16)] lg:max-h-none lg:rounded-none'
                                        : 'hidden min-h-[620px]'
                                }`}>
                                {isMobileCreationDrawerOpen && (
                                    <div className='mobile-creation-sheet-handle z-10 mb-2 flex shrink-0 items-center justify-center lg:hidden'>
                                        <button
                                            type='button'
                                            className='flex h-11 w-24 touch-none items-center justify-center rounded-full select-none'
                                            onPointerDown={beginMobileCreationDrawerGesture}
                                            onPointerUp={finishMobileCreationDrawerGesture}
                                            onPointerCancel={cancelMobileCreationDrawerGesture}
                                            onClick={handleMobileCreationDrawerHandleClick}
                                            aria-label={t('ux.closeCreationSheet')}
                                            aria-controls='mobile-creation-sheet'
                                            aria-expanded={true}>
                                            <span className='bg-border h-1 w-10 rounded-full' aria-hidden='true' />
                                        </button>
                                        <Button
                                            ref={mobileCreationDrawerCloseButtonRef}
                                            type='button'
                                            variant='outline'
                                            size='icon'
                                            onClick={closeMobileCreationDrawer}
                                            className='bg-card/95 absolute top-0 right-0 h-11 w-11 shadow-sm'
                                            aria-label={t('ux.closeCreationSheetButton')}>
                                            <X className='h-4 w-4' />
                                        </Button>
                                    </div>
                                )}
                                <div
                                    aria-hidden={mode !== 'generate'}
                                    inert={mode !== 'generate'}
                                    className={
                                        mode === 'generate'
                                            ? 'mobile-drawer-form-slot flex min-h-0 w-full flex-1 flex-col lg:h-full'
                                            : 'hidden'
                                    }>
                                    <GenerationForm
                                        onSubmit={handleApiCall}
                                        onSaveInspiration={handleSaveInspiration}
                                        canApplyRandomInspiration={hasRandomInspirationPrompt}
                                        onPickRandomInspiration={pickRandomInspirationPrompt}
                                        isLoading={isLoading || isSendingToEdit}
                                        showLoadingState={isLoading}
                                        isActive={mode === 'generate'}
                                        currentMode={workbenchMode}
                                        onModeChange={handleWorkbenchModeChange}
                                        reuseContext={reuseContext}
                                        onClearReuseContext={() => setReuseContext(null)}
                                        isPasswordRequiredByBackend={isPasswordRequiredByBackend}
                                        clientPasswordHash={clientPasswordHash}
                                        onOpenPasswordDialog={handleOpenPasswordDialog}
                                        model={genModel}
                                        modelOptions={modelOptions}
                                        setModel={handleGenModelChange}
                                        prompt={genPrompt}
                                        setPrompt={setGenPrompt}
                                        batchPromptText={genBatchPromptText}
                                        setBatchPromptText={handleBatchPromptTextChange}
                                        failedBatchPrompts={failedBatchPrompts}
                                        canPauseBatch={canPausePromptBatch}
                                        isBatchPauseRequested={isBatchPauseRequested}
                                        onPauseBatch={handlePauseBatch}
                                        n={genN}
                                        setN={setGenN}
                                        size={genSize}
                                        setSize={setGenSize}
                                        customWidth={genCustomWidth}
                                        setCustomWidth={setGenCustomWidth}
                                        customHeight={genCustomHeight}
                                        setCustomHeight={setGenCustomHeight}
                                        quality={genQuality}
                                        setQuality={setGenQuality}
                                        outputFormat={genOutputFormat}
                                        setOutputFormat={setGenOutputFormat}
                                        compression={genCompression}
                                        setCompression={setGenCompression}
                                        background={genBackground}
                                        setBackground={setGenBackground}
                                        upstreamProfile={activeUpstreamProfile}
                                        upstreamProfileMixed={activeUpstreamProfileMixed}
                                        defaultImageBackend={defaultImageBackend}
                                        moderation={genModeration}
                                        setModeration={setGenModeration}
                                        streamMode={streamMode}
                                        setStreamMode={setStreamMode}
                                        allowStreamingBatch={streamingBatchEnabled}
                                        enableParallelBatch={enableParallelBatch}
                                        setEnableParallelBatch={setEnableParallelBatch}
                                        partialImages={partialImages}
                                        setPartialImages={setPartialImages}
                                        allowResponsesImageBackend={allowResponsesImageBackend}
                                        hasDefaultResponsesModel={hasDefaultResponsesModel}
                                        imageBackend={genImageBackend}
                                        setImageBackend={setGenImageBackend}
                                        streamingStrategy={genStreamingStrategy}
                                        defaultStreamingStrategy={defaultStreamingStrategy}
                                        setStreamingStrategy={setGenStreamingStrategy}
                                        responsesModel={genResponsesModel}
                                        setResponsesModel={setGenResponsesModel}
                                        thinking={genThinking}
                                        setThinking={setGenThinking}
                                        promptOptimization={genPromptOptimization}
                                        setPromptOptimization={setGenPromptOptimization}
                                        forceWeb={genForceWeb}
                                        setForceWeb={setGenForceWeb}
                                        requestSummaryLabel={activeRequestSummaryLabel}
                                    />
                                </div>
                                <div
                                    aria-hidden={mode !== 'edit'}
                                    inert={mode !== 'edit'}
                                    className={
                                        mode === 'edit'
                                            ? 'mobile-drawer-form-slot flex min-h-0 w-full flex-1 flex-col lg:h-full'
                                            : 'hidden'
                                    }>
                                    <EditingForm
                                        onSubmit={handleApiCall}
                                        onSaveInspiration={handleSaveInspiration}
                                        canApplyRandomInspiration={hasRandomInspirationPrompt}
                                        onPickRandomInspiration={pickRandomInspirationPrompt}
                                        isLoading={isLoading || isSendingToEdit}
                                        showLoadingState={isLoading}
                                        isActive={mode === 'edit'}
                                        currentMode={workbenchMode}
                                        onModeChange={handleWorkbenchModeChange}
                                        reuseContext={editReuseContext}
                                        onClearReuseContext={() => setEditReuseContext(null)}
                                        isPasswordRequiredByBackend={isPasswordRequiredByBackend}
                                        clientPasswordHash={clientPasswordHash}
                                        onOpenPasswordDialog={handleOpenPasswordDialog}
                                        editModel={editModel}
                                        modelOptions={modelOptions}
                                        setEditModel={handleEditModelChange}
                                        imageFiles={editImageFiles}
                                        sourceImagePreviewUrls={editSourceImagePreviewUrls}
                                        setImageFiles={setEditImageFiles}
                                        setSourceImagePreviewUrls={(nextUrls) => {
                                            const resolvedUrls =
                                                typeof nextUrls === 'function'
                                                    ? nextUrls(editSourceImagePreviewUrlsRef.current)
                                                    : nextUrls;
                                            updateEditSourceImagePreviewUrls(resolvedUrls);
                                        }}
                                        maxImages={activeUpstreamProfile.upload.maxImages}
                                        editPrompt={editPrompt}
                                        setEditPrompt={setEditPrompt}
                                        editN={editN}
                                        setEditN={setEditN}
                                        editSize={editSize}
                                        setEditSize={setEditSize}
                                        editCustomWidth={editCustomWidth}
                                        setEditCustomWidth={setEditCustomWidth}
                                        editCustomHeight={editCustomHeight}
                                        setEditCustomHeight={setEditCustomHeight}
                                        editQuality={editQuality}
                                        setEditQuality={setEditQuality}
                                        editOutputFormat={editOutputFormat}
                                        setEditOutputFormat={setEditOutputFormat}
                                        editCompression={editCompression}
                                        setEditCompression={setEditCompression}
                                        upstreamProfile={activeUpstreamProfile}
                                        upstreamProfileMixed={activeUpstreamProfileMixed}
                                        defaultImageBackend={defaultImageBackend}
                                        editModeration={editModeration}
                                        setEditModeration={setEditModeration}
                                        editBrushSize={editBrushSize}
                                        setEditBrushSize={setEditBrushSize}
                                        editShowMaskEditor={editShowMaskEditor}
                                        setEditShowMaskEditor={setEditShowMaskEditor}
                                        editGeneratedMaskFile={editGeneratedMaskFile}
                                        setEditGeneratedMaskFile={setEditGeneratedMaskFile}
                                        editIsMaskSaved={editIsMaskSaved}
                                        setEditIsMaskSaved={setEditIsMaskSaved}
                                        editOriginalImageSize={editOriginalImageSize}
                                        setEditOriginalImageSize={setEditOriginalImageSize}
                                        editDrawnPoints={editDrawnPoints}
                                        setEditDrawnPoints={setEditDrawnPoints}
                                        editMaskPreviewUrl={editMaskPreviewUrl}
                                        setEditMaskPreviewUrl={setEditMaskPreviewUrl}
                                        streamMode={streamMode}
                                        setStreamMode={setStreamMode}
                                        allowStreamingBatch={streamingBatchEnabled}
                                        enableParallelBatch={enableParallelBatch}
                                        setEnableParallelBatch={setEnableParallelBatch}
                                        partialImages={partialImages}
                                        setPartialImages={setPartialImages}
                                        allowResponsesImageBackend={allowResponsesImageBackend}
                                        hasDefaultResponsesModel={hasDefaultResponsesModel}
                                        editImageBackend={editImageBackend}
                                        setEditImageBackend={setEditImageBackend}
                                        editStreamingStrategy={editStreamingStrategy}
                                        defaultStreamingStrategy={defaultStreamingStrategy}
                                        setEditStreamingStrategy={setEditStreamingStrategy}
                                        editResponsesModel={editResponsesModel}
                                        setEditResponsesModel={setEditResponsesModel}
                                        editThinking={editThinking}
                                        setEditThinking={setEditThinking}
                                        editPromptOptimization={editPromptOptimization}
                                        setEditPromptOptimization={setEditPromptOptimization}
                                        editForceWeb={editForceWeb}
                                        setEditForceWeb={setEditForceWeb}
                                        requestSummaryLabel={activeRequestSummaryLabel}
                                    />
                                </div>
                            </section>
                            <section
                                ref={outputPanelRef}
                                tabIndex={-1}
                                aria-label={t('app.canvasPreview')}
                                aria-hidden={isMobileCreationDrawerOpen}
                                inert={isMobileCreationDrawerOpen}
                                className='order-1 flex min-h-[380px] min-w-0 scroll-mt-4 flex-col sm:min-h-[460px] lg:order-2 xl:min-h-0'>
                                {error && (
                                    <Alert
                                        variant='destructive'
                                        className='border-destructive/45 bg-destructive/10 text-destructive mb-4'>
                                        <AlertTitle>{t('common.error')}</AlertTitle>
                                        <AlertDescription>{renderErrorDescription(error)}</AlertDescription>
                                    </Alert>
                                )}
                                <div className='min-h-0 shrink-0 xl:flex-1'>
                                    <ImageOutput
                                        imageBatch={latestImageBatch}
                                        viewMode={imageOutputView}
                                        onViewChange={setImageOutputView}
                                        altText={t('output.alt')}
                                        isLoading={isLoading || isSendingToEdit}
                                        onSendToEdit={handleSendToEdit}
                                        onDownloadImage={handleDownloadImage}
                                        onShareImage={handleOpenShareImage}
                                        onCreateVariant={handleCreateVariant}
                                        onReusePrompt={handleReuseCurrentPrompt}
                                        failureMessage={outputFailureMessage}
                                        onRetry={canRetryLastGeneration ? handleRetryLastGeneration : undefined}
                                        compareImage={historyCompareImage}
                                        canCreateVariant={canCreateResultVariant}
                                        canReusePrompt={canReuseResultPrompt}
                                        currentMode={mode}
                                        baseImagePreviewUrl={editSourceImagePreviewUrls[0] || null}
                                        streamingPreviewImages={streamingPreviewImages}
                                        isStreamingRequest={activeRequestStreaming}
                                        clientPasswordHash={clientPasswordHash}
                                        canOpenLogs={canOpenLogs}
                                        openLogsSignal={openLogsSignal}
                                        logClientRequestIds={activeLogClientRequestIds}
                                        logFilenames={activeLogFilenames}
                                        isLogScopeBatch={
                                            imageOutputView === 'grid' && (latestImageBatch?.length ?? 0) > 1
                                        }
                                    />
                                </div>
                                <WorkbenchProDock
                                    outputFormat={mode === 'generate' ? genOutputFormat : editOutputFormat}
                                    onOutputFormatChange={
                                        mode === 'generate' ? setGenOutputFormat : setEditOutputFormat
                                    }
                                    quality={mode === 'generate' ? genQuality : editQuality}
                                    onQualityChange={mode === 'generate' ? setGenQuality : setEditQuality}
                                    model={mode === 'generate' ? genModel : editModel}
                                    modelOptions={modelOptions}
                                    onModelChange={mode === 'generate' ? handleGenModelChange : handleEditModelChange}
                                    size={mode === 'generate' ? genSize : editSize}
                                    customWidth={mode === 'generate' ? genCustomWidth : editCustomWidth}
                                    customHeight={mode === 'generate' ? genCustomHeight : editCustomHeight}
                                    streamMode={streamMode}
                                    onStreamModeChange={setStreamMode}
                                    allowStreamingBatch={streamingBatchEnabled}
                                    enableParallelBatch={enableParallelBatch}
                                    onEnableParallelBatchChange={setEnableParallelBatch}
                                    parallelBatchTargetCount={
                                        mode === 'generate' && workbenchMode === 'batch'
                                            ? readBatchPromptLines(genBatchPromptText).length
                                            : mode === 'generate'
                                              ? genN[0]
                                              : editN[0]
                                    }
                                    allowResponsesImageBackend={allowResponsesImageBackend}
                                    upstreamProfileMixed={activeUpstreamProfileMixed}
                                    hasDefaultResponsesModel={hasDefaultResponsesModel}
                                    imageBackend={mode === 'generate' ? genImageBackend : editImageBackend}
                                    onImageBackendChange={
                                        mode === 'generate' ? setGenImageBackend : setEditImageBackend
                                    }
                                    streamingStrategy={
                                        mode === 'generate' ? genStreamingStrategy : editStreamingStrategy
                                    }
                                    defaultStreamingStrategy={defaultStreamingStrategy}
                                    onStreamingStrategyChange={
                                        mode === 'generate' ? setGenStreamingStrategy : setEditStreamingStrategy
                                    }
                                    responsesModel={mode === 'generate' ? genResponsesModel : editResponsesModel}
                                    onResponsesModelChange={
                                        mode === 'generate' ? setGenResponsesModel : setEditResponsesModel
                                    }
                                    disabled={isLoading || isSendingToEdit}
                                />
                            </section>
                            <aside
                                aria-label={t('history.title')}
                                aria-hidden={isMobileCreationDrawerOpen}
                                inert={isMobileCreationDrawerOpen}
                                className={cn(
                                    'workbench-history-column order-3 min-h-[17.5rem] min-w-0 lg:col-span-2 xl:h-full',
                                    shouldExpandOutputStage && 'workbench-history-column--contained'
                                )}>
                                <HistoryPanel
                                    history={history}
                                    inspirations={inspirations}
                                    activityItems={generationActivityItems}
                                    isSendingToEdit={isLoading || isSendingToEdit}
                                    onSelectImage={handleHistorySelect}
                                    onApplyPrompt={handleApplyPrompt}
                                    onSaveInspiration={handleSaveInspiration}
                                    onSendHistoryToEdit={handleSendHistoryToEdit}
                                    onMarkResultFeedback={handleMarkResultFeedback}
                                    onUpdateResultFeedbackNote={handleUpdateResultFeedbackNote}
                                    onDeleteInspiration={handleDeleteInspiration}
                                    onDownloadHistoryItem={handleDownloadHistoryItem}
                                    onClearHistory={handleClearHistory}
                                    getImageSrc={getImageSrc}
                                    onDeleteItemRequest={handleRequestDeleteItem}
                                    itemPendingDeleteConfirmation={itemToDeleteConfirm}
                                    onConfirmDeletion={handleConfirmDeletion}
                                    onCancelDeletion={handleCancelDeletion}
                                    deletePreferenceDialogValue={dialogCheckboxStateSkipConfirm}
                                    onDeletePreferenceDialogChange={setDialogCheckboxStateSkipConfirm}
                                    cleanupEnabled={retentionControlsEnabled}
                                    permanentlySavedFilenames={permanentlySavedFilenames ?? emptyPermanentFilenames}
                                    onUpdatePermanentSave={updatePermanentSave}
                                />
                            </aside>
                        </div>
                    </div>
                    {!isMobileCreationDrawerOpen && (
                        <div className='bg-background border-border fixed right-0 bottom-0 left-0 z-40 min-h-[var(--mobile-action-dock-height)] border-t px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-12px_30px_rgba(15,23,42,0.1)] lg:hidden'>
                            <div
                                className='mx-auto mb-2 flex h-3 w-24 touch-none items-center justify-center rounded-full select-none'
                                onPointerDown={beginMobileCreationDrawerGesture}
                                onPointerUp={finishMobileCreationDrawerGesture}
                                onPointerCancel={cancelMobileCreationDrawerGesture}
                                onClick={handleMobileCreationDrawerHandleClick}
                                aria-hidden='true'>
                                <span className='bg-border h-1 w-10 rounded-full' aria-hidden='true' />
                            </div>
                            <div className='mx-auto flex max-w-screen-sm items-stretch gap-2'>
                                <Button
                                    ref={mobileCreationDrawerTriggerRef}
                                    type='button'
                                    variant='outline'
                                    size='icon'
                                    onClick={openMobileCreationDrawer}
                                    className='text-muted-foreground hover:text-foreground h-11 w-11 shrink-0'
                                    aria-label={t('ux.openCreationSheet')}
                                    aria-controls='mobile-creation-sheet'
                                    aria-expanded={false}>
                                    <PenLine className='h-4 w-4' />
                                </Button>
                                <Button
                                    type='button'
                                    onClick={handleMobilePrimaryAction}
                                    disabled={mobilePrimaryDisabled}
                                    className='bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground min-h-11 min-w-0 flex-1'>
                                    {(isLoading || isSendingToEdit) && (
                                        <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                                    )}
                                    {mode === 'generate'
                                        ? isLoading
                                            ? t('generate.loading')
                                            : t('generate.submit')
                                        : isLoading
                                          ? t('edit.loading')
                                          : t('edit.submit')}
                                </Button>
                                {canPausePromptBatch && (
                                    <Button
                                        type='button'
                                        variant='outline'
                                        size='icon'
                                        onClick={handlePauseBatch}
                                        disabled={isBatchPauseRequested}
                                        className='text-muted-foreground hover:text-foreground h-11 w-11 shrink-0'
                                        aria-label={
                                            isBatchPauseRequested ? t('batch.pauseRequested') : t('batch.pause')
                                        }>
                                        {isBatchPauseRequested ? (
                                            <Loader2 className='h-4 w-4 animate-spin' />
                                        ) : (
                                            <Pause className='h-4 w-4' />
                                        )}
                                    </Button>
                                )}
                                <Button
                                    type='button'
                                    variant='outline'
                                    size='icon'
                                    onClick={scrollToOutput}
                                    className='text-muted-foreground hover:text-foreground h-11 w-11 shrink-0'
                                    aria-label={t('ux.jumpToResult')}>
                                    <ArrowUp className='h-4 w-4' />
                                </Button>
                                {canOpenLogs && (
                                    <Button
                                        type='button'
                                        variant='outline'
                                        size='icon'
                                        onClick={() => setOpenLogsSignal((value) => value + 1)}
                                        className='text-muted-foreground hover:text-foreground h-11 w-11 shrink-0'
                                        aria-label={t('logs.open')}>
                                        <Activity className='h-4 w-4' />
                                    </Button>
                                )}
                            </div>
                            {mobilePrimaryDisabledReason && (
                                <p className='text-muted-foreground mx-auto mt-2 max-w-screen-sm text-center text-xs leading-4'>
                                    {mobilePrimaryDisabledReason}
                                </p>
                            )}
                        </div>
                    )}
                </>
            ) : null}
        </main>
    );
}
