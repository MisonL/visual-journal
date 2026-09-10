import { AGENT_ENDPOINTS, AGENT_JOB_ENDPOINTS } from './agent-api-paths.mjs';
import type { AgentErrorDiagnostics } from './api-error-response';
import { readAppLogRetentionMetadata, type AppLogRetentionMetadata } from './app-log-retention';
import {
    CHANNEL_REQUEST_MODES,
    CHANNEL_REQUEST_MODE_ADMIN_CONTROL,
    getEffectiveChannelRequestModes,
    isStreamingChannelRequestMode,
    resolveChannelRequestMode,
    type ChannelRequestMode,
    type ChannelRequestModeDecision
} from './channel-request-mode';
import { getChannelPoolSummary, parseChannelPoolConfig } from './channel-router';
import { isGptImage2Model } from './cost-utils';
import {
    MAX_PROMPT_LENGTH,
    MAX_MODEL_NAME_LENGTH,
    RequestValidationError,
    resolveDefaultImageModel,
    validateApiBaseUrl,
    type GptImageModel,
    type ValidOutputFormat
} from './image-request-utils';
import {
    summarizeImageUpstreamProfile,
    summarizeUpstreamRequestHeaders,
    buildIntegerRangeOptions,
    clampIntegerToRange,
    getImageBackendCompatibility,
    getImageCountRangeCompatibilityForBackend,
    getImageCountRangeForBackend,
    getPartialImagesRangeCompatibilityForBackend,
    getPartialImagesRangeForBackend,
    isIntegerWithinRange,
    readImageUpstreamProfile,
    RESPONSES_IMAGE_COUNT_RANGE,
    RESPONSES_PARTIAL_IMAGES_RANGE,
    type ImageUpstreamProfile,
    type ImageUpstreamProfileId,
    type ImageUpstreamProfileSummary,
    type NumericRange,
    type PartialImagesCount,
    type UpstreamRequestHeaderSummary
} from './image-upstream-profile';
import {
    parseImageGenerationBackendValue,
    parseImageStreamModeValue,
    parseImageStreamingStrategyValue,
    resolveImageStreamEnabled,
    type ImageGenerationBackend,
    type ImageStreamMode,
    type ImageStreamingStrategy
} from './image-upstream-strategy';
import {
    summarizeOpenAIImageTransport,
    type ImageTransportTunMode,
    type UpstreamProxySummary
} from './openai-image-transport';
import { CHINESE_POSITIVE_INTEGER_MESSAGES, readPositiveIntegerFromEnv } from './positive-integer-config.mjs';
import { getExistingServerChannelState } from './server-channel-router';
import { readBooleanEnv } from './server-runtime';
import {
    GPT_IMAGE_2_EDGE_MULTIPLE,
    GPT_IMAGE_2_MAX_ASPECT,
    GPT_IMAGE_2_MAX_EDGE,
    GPT_IMAGE_2_MAX_PIXELS,
    GPT_IMAGE_2_MIN_PIXELS,
    validateGptImage2Size,
    validatePositiveIntegerImageSize
} from './size-utils';

export type { NumericRange } from './image-upstream-profile';

export const AGENT_API_VERSION = '1.0.0';
export const AGENT_SCHEMA_VERSION = '2026-07-29';
export const AGENT_DEFAULT_SQLITE_PATH = 'generated-images/.agent-state/agent.sqlite';
export const AGENT_DEFAULT_LEASE_MS = 10 * 60 * 1000;
export const AGENT_DEFAULT_REQUEST_TTL_SECONDS = 24 * 60 * 60;
export const AGENT_DEFAULT_RECOVERY_INTERVAL_MS = 30 * 1000;
export const AGENT_PAGE_REQUEST_DIAGNOSTICS_NO_MATCH_HINT =
    'matched_log_count=0 表示当前保留窗口内没有匹配日志；可能已被保留条数淘汰、被 APP_LOG_LEVEL 过滤，或本地日志文件被清理。';

export const AGENT_MODELS = [
    'gpt-image-1',
    'gpt-image-1-mini',
    'gpt-image-1.5',
    'gpt-image-2',
    'gpt-image-2-1k'
] as const;
export const AGENT_OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const;
const AGENT_DEFAULT_OUTPUT_FORMAT = 'webp';
const AGENT_DEFAULT_LOSSY_OUTPUT_COMPRESSION = 100;
export const AGENT_RESPONSE_MODES = ['path', 'base64', 'both'] as const;
export const AGENT_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export const AGENT_BACKGROUNDS = ['transparent', 'opaque', 'auto'] as const;
export const AGENT_MODERATIONS = ['low', 'auto'] as const;
export const AGENT_LEGACY_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const;
export const AGENT_JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'expired'] as const;
export const AGENT_IMAGE_BACKENDS = ['images-api', 'responses-image-generation'] as const;
export const PAGE_SSE_CLIENT_REQUEST_ID_MAX_LENGTH = 128;
export const AGENT_STREAMING_STRATEGIES = [
    'off',
    'auto',
    'openai-sse',
    'newapi-keepalive-sse',
    'responses-sse',
    'force-sse'
] as const;
export const AGENT_STREAM_MODES = ['auto', 'stream', 'non_stream'] as const;
export const AGENT_UPSTREAM_SSE_ACTIVATION_STRATEGIES = [
    'auto',
    'openai-sse',
    'newapi-keepalive-sse',
    'responses-sse',
    'force-sse'
] as const;
export const AGENT_UPSTREAM_SSE_GENERATE_REQUEST_FIELDS = [
    'image_backend',
    'stream_mode',
    'streaming_strategy',
    'partial_images'
] as const;
export const AGENT_UPSTREAM_SSE_EDIT_REQUEST_FIELDS = ['stream_mode', 'streaming_strategy', 'partial_images'] as const;
export const AGENT_PAGE_SSE_AGENT_USAGE =
    'explicit_diagnostics_for_generate_recommended_for_default_webp_edit_high_resolution_edit_long_image_recovery_and_complex_batch' as const;
const AGENT_DEFAULT_PARTIAL_IMAGES = 2;

export type AgentStateBackend = 'memory' | 'sqlite' | 'postgres';
export type AgentAuthScheme = 'bearer' | 'x-app-password-hash';
export type PageSseAuthScheme = 'form-password-hash';
export type AgentResponseMode = (typeof AGENT_RESPONSE_MODES)[number];
export type AgentQuality = (typeof AGENT_QUALITIES)[number];
export type AgentBackground = (typeof AGENT_BACKGROUNDS)[number];
export type AgentModeration = (typeof AGENT_MODERATIONS)[number];
export type AgentJobState = (typeof AGENT_JOB_STATES)[number];
export type AgentRoutingTransport = 'agent_json' | 'agent_job_polling' | 'page_sse';
export type AgentRoutingStrength = 'default' | 'recommended' | 'explicit';
export type AgentOrchestrationPolicy = 'server_orchestrated_generate_v1';

export type AgentChannelConstraints = {
    generate_images: NumericRange;
    edit_images: NumericRange;
    partial_images: NumericRange;
    generate_images_by_backend: Partial<Record<ImageGenerationBackend, NumericRange>>;
    edit_images_by_backend: Partial<Record<ImageGenerationBackend, NumericRange>>;
    partial_images_by_backend: Partial<Record<ImageGenerationBackend, NumericRange>>;
    upload_images: {
        max: number;
        max_single_mb: number;
        max_total_mb?: number;
    };
    gpt_image_2: {
        allow_transparent_background: boolean;
        size_policy: ImageUpstreamProfile['gptImage2']['sizePolicy'];
    };
};
export type ImageBackendRuntimeRequirement = {
    supported: true;
    enabled: boolean;
    required_env: string[];
    missing_env: string[];
    incompatible_constraints?: string[];
    streaming_incompatible_constraints?: string[];
};

export type AgentPageRequestDiagnosticsRetention = AppLogRetentionMetadata & {
    bounded: true;
    not_agent_state_backend: true;
};

export type AgentRequestDiagnosticsRetention = {
    storage: 'agent_state';
    ttl_seconds: number;
    bounded: true;
    loss_modes: ['request_expired_by_ttl', 'artifact_deleted_or_purged', 'state_backend_reset'];
};

export type AgentPageRequestDiagnosticsNote = {
    code: 'no_matching_logs_in_retention_window';
    message: string;
    retention: AgentPageRequestDiagnosticsRetention;
};

export type AgentGenerateRequest = {
    model: GptImageModel;
    prompt: string;
    n: number;
    size: string;
    quality: AgentQuality;
    output_format: ValidOutputFormat;
    output_compression?: number;
    background: AgentBackground;
    moderation: AgentModeration;
    response_mode: AgentResponseMode;
    image_backend: ImageGenerationBackend;
    stream_mode: ImageStreamMode;
    streaming_strategy: ImageStreamingStrategy;
    partial_images: 0 | 1 | 2 | 3 | 4;
    responsesModel?: string;
    thinking?: 'minimal' | 'none' | 'low' | 'medium' | 'high' | 'xhigh';
    promptOptimization?: boolean;
    force_web?: boolean;
    force_request?: boolean;
};

export type AgentImageResponseItem = {
    id: string;
    filename: string;
    content_url: string;
    metadata_url: string;
    output_format: string;
    mime_type: string;
    size_bytes: number;
    width: number | null;
    height: number | null;
    b64_json?: string;
};

export type AgentImageResponseTiming = {
    started_at: string;
    completed_at: string;
    elapsed_ms: number;
    server_elapsed_ms: number;
};

export type AgentImageResponseExecution = {
    transport: AgentRoutingTransport;
    endpoint: string;
    route_mode: 'agent' | 'job' | 'page_sse';
    operation: 'generate' | 'edit';
    image_backend: ImageGenerationBackend;
    stream_mode: ImageStreamMode;
    streaming_strategy: ImageStreamingStrategy;
    channel_request_mode?: ChannelRequestMode;
    channel_request_mode_fallback_applied?: boolean;
    route_decision?: ChannelRequestModeDecision;
    selected_channel_id?: string;
    upstream_host?: string;
    request_headers: UpstreamRequestHeaderSummary;
};

export type AgentImageResponse = {
    request_id: string;
    idempotency_key: string;
    cached: boolean;
    images: AgentImageResponseItem[];
    usage?: unknown;
    created_at: string;
    timing?: AgentImageResponseTiming;
    execution?: AgentImageResponseExecution;
};

export type AgentJobStatusResponse = {
    job: {
        id: string;
        request_id: string;
        idempotency_key: string;
        mode: 'generate' | 'edit';
        state: AgentJobState;
        created_at: string;
        updated_at: string;
        expires_at: string;
        result_url?: string;
        retry_after_seconds?: number;
        error?: {
            code: string;
            message: string;
            retryable: boolean;
            retry_after_seconds?: number;
            details?: Record<string, unknown>;
            upstream_status?: number;
            diagnostics?: AgentErrorDiagnostics;
        };
    };
};

export type AgentCapabilities = {
    api_version: string;
    schema_version: string;
    auth: {
        required: boolean;
        schemes: AgentAuthScheme[];
    };
    endpoints: Record<string, string>;
    image_transport: {
        upstream_timeout_ms: number;
        stream_data_interval_timeout_ms: number;
        upstream_max_retries: number;
        upstream_proxy: UpstreamProxySummary;
        tun_mode: ImageTransportTunMode;
    };
    upstream_profile: ImageUpstreamProfileSummary;
    upstream_request_headers: {
        default: UpstreamRequestHeaderSummary;
        channels: Array<{
            id: string;
            upstream_proxy: UpstreamProxySummary;
            request_modes: readonly ChannelRequestMode[];
            request_mode_priority: readonly ChannelRequestMode[];
            request_headers: UpstreamRequestHeaderSummary;
            constraints: AgentChannelConstraints;
            healthy_request_modes?: readonly ChannelRequestMode[];
        }>;
    };
    request_mode_controls: {
        source: 'admin_env_whitelist';
        global_env: string;
        channel_env_pattern: string;
        global_priority_env: string;
        channel_priority_env_pattern: string;
        default_priority: readonly ChannelRequestMode[];
        default_priority_policy: 'lowest_cost_first';
        mutable_at_runtime: false;
        agent_client_policy: 'diagnostics_only';
        final_gate_command: string;
        smoke_gate_commands: Record<ChannelRequestMode, readonly string[]>;
    };
    defaults: {
        model: GptImageModel;
        response_mode: AgentResponseMode;
        state_backend: AgentStateBackend;
        image_backend: ImageGenerationBackend;
        stream_mode: ImageStreamMode;
        streaming_strategy: ImageStreamingStrategy;
        partial_images: PartialImagesCount;
    };
    limits: {
        max_prompt_length: number;
        max_images: number;
        generate_images: NumericRange;
        edit_images: NumericRange;
        generate_images_by_backend: Record<ImageGenerationBackend, NumericRange>;
        edit_images_by_backend: Record<ImageGenerationBackend, NumericRange>;
        upload_images: { max: number };
        max_upload_mb: number;
        max_total_upload_mb?: number;
        partial_images: NumericRange;
        partial_images_by_backend: Record<ImageGenerationBackend, NumericRange>;
        upstream_profile: ImageUpstreamProfileId;
        upstream_profile_mixed: boolean;
    };
    force_request_controls: {
        field: 'force_request';
        cli_flag: '--force-request';
        default: false;
        effect: 'skip_local_upstream_profile_size_and_background_validation';
        still_enforced: readonly string[];
        intended_for: readonly string[];
    };
    model_limits: {
        'gpt-image-2': {
            max_edge: number;
            max_pixels: number;
            edge_multiple: number;
            max_aspect: number;
            min_pixels: number;
            size_policy: ImageUpstreamProfile['gptImage2']['sizePolicy'];
            allow_transparent_background: boolean;
            recommended_presets: Array<{ name: string; size: string; purpose: string }>;
            large_image_risk: {
                applies_to: string[];
                guidance: string;
            };
        };
        'gpt-image-2-1k': {
            max_edge: number;
            max_pixels: number;
            edge_multiple: number;
            max_aspect: number;
            min_pixels: number;
            size_policy: ImageUpstreamProfile['gptImage2']['sizePolicy'];
            allow_transparent_background: boolean;
            recommended_presets: Array<{ name: string; size: string; purpose: string }>;
            large_image_risk: {
                applies_to: string[];
                guidance: string;
            };
        };
    };
    agent_streaming: {
        generate: {
            supported: false;
            mode: 'non_streaming_only';
            endpoint: string;
        };
        edit: {
            supported: false;
            mode: 'non_streaming_only';
            endpoint: string;
        };
        upstream_sse: {
            supported: true;
            mode: 'internal_upstream_sse';
            endpoint: string;
            request_fields: typeof AGENT_UPSTREAM_SSE_GENERATE_REQUEST_FIELDS;
            request_fields_by_mode: {
                generate: typeof AGENT_UPSTREAM_SSE_GENERATE_REQUEST_FIELDS;
                edit: typeof AGENT_UPSTREAM_SSE_EDIT_REQUEST_FIELDS;
            };
            image_backends: readonly ImageGenerationBackend[];
            enabled_image_backends: readonly ImageGenerationBackend[];
            streaming_strategies: readonly ImageStreamingStrategy[];
            stream_modes: readonly ImageStreamMode[];
            activation_strategies: readonly ImageStreamingStrategy[];
            final_response_contract: 'AgentImageResponse';
        };
        page_sse: {
            supported: true;
            mode: 'form_data_sse';
            endpoint: string;
            contract: 'page_ui_only';
            transport_contract: 'page_form_data_sse';
            auth: {
                required: boolean;
                schemes: PageSseAuthScheme[];
                form_field: 'passwordHash';
            };
            client_request_id: {
                form_field: 'clientRequestId';
                source_header: 'Idempotency-Key';
                max_length: number;
            };
            agent_usage: typeof AGENT_PAGE_SSE_AGENT_USAGE;
        };
    };
    orchestration: {
        supported: true;
        policy: AgentOrchestrationPolicy;
        endpoint: string;
        client_contract: 'intent_only';
        transport_selection: 'server_owned';
        result_mode: 'job_polling';
        hidden_controls: readonly string[];
        diagnostics: {
            job_result: string;
            request_lookup: string;
        };
        current_guidance: string;
    };
    routing_rules: {
        high_resolution_edit: AgentRoutingRule;
        complex_ui_batch: AgentRoutingRule;
        long_image_recovery: AgentRoutingRule;
        agent_generate_small_smoke: AgentRoutingRule;
        page_sse_generate_diagnostics: AgentRoutingRule;
        retry_recovery: {
            reuse_failed_idempotency_key: false;
            new_attempt_guidance: string;
        };
    };
    agent_jobs: {
        supported: true;
        mode: 'job_polling';
        intended_for: string[];
        endpoints: {
            create_generate_job: string;
            get_job: string;
            get_job_result: string;
        };
        states: readonly string[];
        current_guidance: string;
    };
    supported: {
        models: readonly string[];
        output_formats: readonly string[];
        response_modes: readonly string[];
        qualities: readonly string[];
        backgrounds: readonly string[];
        moderations: readonly string[];
        legacy_sizes: readonly string[];
        image_backends: readonly ImageGenerationBackend[];
        enabled_image_backends: readonly ImageGenerationBackend[];
        image_backend_requirements: Record<ImageGenerationBackend, ImageBackendRuntimeRequirement>;
        request_modes: readonly ChannelRequestMode[];
        streaming_strategies: readonly ImageStreamingStrategy[];
        stream_modes: readonly ImageStreamMode[];
    };
    model_directory: {
        endpoint: string;
        probe_query: string;
        default_model: string;
        semantics: 'declared_models_only_until_explicit_probe';
    };
    storage: {
        image_storage_mode: string;
        postgres_configured: boolean;
    };
    page_request_diagnostics: {
        supported: true;
        source: 'app_log';
        endpoints: {
            single: string;
            batch: string;
        };
        retention: AgentPageRequestDiagnosticsRetention;
        no_match_hint: string;
    };
    agent_request_diagnostics: {
        supported: true;
        source: 'agent_state';
        endpoints: {
            lookup: string;
            single: string;
        };
        lookup: {
            by_request_id: true;
            by_idempotency_key: true;
        };
        retention: AgentRequestDiagnosticsRetention;
    };
    channel_health_diagnostics: {
        supported: true;
        endpoint: string;
        source: 'in_process_channel_router';
        state_scope: 'process_local';
        billable: false;
    };
    idempotency: {
        required: boolean;
        header: string;
        ttl_seconds: number;
    };
};

export type AgentRoutingRule = {
    when: string[];
    conditions: AgentRoutingCondition;
    endpoint: string;
    transport: AgentRoutingTransport;
    strength: AgentRoutingStrength;
    action: AgentRoutingAction;
    reason: string;
};

export type AgentRoutingCondition = {
    operation: 'generate' | 'edit' | 'generate_or_edit';
    explicit_page_sse?: boolean;
    max_edge?: {
        operator: 'gt' | 'lte';
        value: number;
    };
    batch?: boolean;
    single_request?: boolean;
    complex_ui?: boolean;
    long_image?: boolean;
    resume_or_recover?: boolean;
};

export type AgentRoutingAction = {
    endpoint: string;
    transport: AgentRoutingTransport;
    strength: AgentRoutingStrength;
    fallback_endpoint?: string;
    fallback_mode?: 'manual_after_diagnosis' | 'fix_request_before_retry';
    requires_new_idempotency_key_on_retry: boolean;
    no_automatic_fallback: boolean;
};

type FieldErrors = Record<string, string>;

function isOneOf<T extends readonly string[]>(value: string, allowed: T): value is T[number] {
    return (allowed as readonly string[]).includes(value);
}

function readStringField(body: Record<string, unknown>, field: string, fallback?: string): string | undefined {
    const value = body[field];
    if (value === undefined || value === null) return fallback;
    return typeof value === 'string' ? value : undefined;
}

function readIntegerField(
    body: Record<string, unknown>,
    field: string,
    fallback: number,
    min: number,
    max: number,
    fields: FieldErrors,
    range?: NumericRange
): number {
    const value = body[field];
    if (value === undefined || value === null || value === '') return fallback;
    const parsed =
        typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    const effectiveRange = range ?? { min, max };
    if (!isIntegerWithinRange(parsed, effectiveRange)) {
        fields[field] = effectiveRange.allowedValues
            ? `必须是以下整数之一：${effectiveRange.allowedValues.join(', ')}`
            : `必须是 ${min} 到 ${max} 之间的整数`;
        return fallback;
    }
    return parsed;
}

function validatePrompt(value: unknown, fields: FieldErrors): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        fields.prompt = '必填';
        return '';
    }
    if (value.length > MAX_PROMPT_LENGTH) {
        fields.prompt = `长度不能超过 ${MAX_PROMPT_LENGTH} 个字符`;
    }
    return value;
}

function readModel(body: Record<string, unknown>, fields: FieldErrors): GptImageModel {
    const defaultModel = resolveDefaultImageModel(process.env);
    const value = readStringField(body, 'model', defaultModel)?.trim();
    if (!value || value.length > MAX_MODEL_NAME_LENGTH) {
        fields.model = '必须是 1 到 ' + MAX_MODEL_NAME_LENGTH + ' 个字符的非空字符串';
        return defaultModel;
    }
    return value;
}

function readSize(
    body: Record<string, unknown>,
    model: GptImageModel,
    fields: FieldErrors,
    fallback: string,
    upstreamProfile: Pick<ImageUpstreamProfile, 'gptImage2'>,
    options: { forceRequest?: boolean } = {}
): string {
    const value = readStringField(body, 'size', fallback);
    if (!value) {
        fields.size = '必须是字符串';
        return fallback;
    }
    if (
        !isGptImage2Model(model) &&
        AGENT_MODELS.includes(model as (typeof AGENT_MODELS)[number]) &&
        !isOneOf(value, AGENT_LEGACY_SIZES)
    ) {
        fields.size = `${model} 的 size 必须是以下值之一：${AGENT_LEGACY_SIZES.join(', ')}`;
        return fallback;
    }
    if (!isGptImage2Model(model) && !AGENT_MODELS.includes(model as (typeof AGENT_MODELS)[number])) {
        if (value === 'auto') return value;
        const match = /^(\d+)x(\d+)$/.exec(value);
        if (!match) {
            fields.size = '必须是 auto 或 WxH 格式的尺寸值';
            return fallback;
        }
        const validation = validatePositiveIntegerImageSize(Number(match[1]), Number(match[2]));
        if (!validation.valid) {
            fields.size = validation.reason;
            return fallback;
        }
        return value;
    }
    if (isGptImage2Model(model) && value !== 'auto') {
        const match = /^(\d+)x(\d+)$/.exec(value);
        if (!match) {
            fields.size = '必须是 auto 或 WxH 格式的尺寸值';
            return fallback;
        }
        const validation =
            options.forceRequest || upstreamProfile.gptImage2.sizePolicy === 'positive-integer'
                ? validatePositiveIntegerImageSize(Number(match[1]), Number(match[2]))
                : validateGptImage2Size(Number(match[1]), Number(match[2]));
        if (!validation.valid) {
            fields.size = validation.reason;
            return fallback;
        }
    }
    return value;
}

function readOutputFormat(body: Record<string, unknown>, fields: FieldErrors): ValidOutputFormat {
    const rawValue = readStringField(body, 'output_format', AGENT_DEFAULT_OUTPUT_FORMAT);
    const normalized = rawValue?.toLowerCase() === 'jpg' ? 'jpeg' : rawValue?.toLowerCase();
    if (!normalized || !isOneOf(normalized, AGENT_OUTPUT_FORMATS)) {
        fields.output_format = `必须是以下值之一：${AGENT_OUTPUT_FORMATS.join(', ')}`;
        return 'png';
    }
    return normalized;
}

function readResponseMode(body: Record<string, unknown>, fields: FieldErrors): AgentResponseMode {
    const value = readStringField(body, 'response_mode', 'path');
    if (!value || !isOneOf(value, AGENT_RESPONSE_MODES)) {
        fields.response_mode = `必须是以下值之一：${AGENT_RESPONSE_MODES.join(', ')}`;
        return 'path';
    }
    return value;
}

function readAgentImageBackend(body: Record<string, unknown>, fields: FieldErrors): ImageGenerationBackend {
    const rawValue = body.image_backend;
    if (rawValue !== undefined && rawValue !== null && typeof rawValue !== 'string') {
        fields.image_backend = '必须是字符串';
        return 'images-api';
    }
    const value = readStringField(body, 'image_backend', 'images-api');
    if (!value) return 'images-api';
    try {
        return parseImageGenerationBackendValue(value);
    } catch (error) {
        fields.image_backend = error instanceof Error ? error.message : 'image_backend 无效';
        return 'images-api';
    }
}

function readAgentStreamingStrategy(body: Record<string, unknown>, fields: FieldErrors): ImageStreamingStrategy {
    const rawValue = body.streaming_strategy;
    if (rawValue !== undefined && rawValue !== null && typeof rawValue !== 'string') {
        fields.streaming_strategy = '必须是字符串';
        return 'auto';
    }
    const value = readStringField(body, 'streaming_strategy', 'auto');
    if (!value) return 'auto';
    try {
        return parseImageStreamingStrategyValue(value);
    } catch (error) {
        fields.streaming_strategy = error instanceof Error ? error.message : 'streaming_strategy 无效';
        return 'auto';
    }
}

function readAgentStreamMode(body: Record<string, unknown>, fields: FieldErrors): ImageStreamMode {
    const rawValue = body.stream_mode;
    if (rawValue !== undefined && rawValue !== null && typeof rawValue !== 'string') {
        fields.stream_mode = '必须是字符串';
        return 'auto';
    }
    if ((rawValue === undefined || rawValue === null || rawValue === '') && body.streaming_strategy === 'off') {
        return 'non_stream';
    }
    const value = readStringField(body, 'stream_mode', 'auto');
    if (!value) return 'auto';
    try {
        return parseImageStreamModeValue(value);
    } catch (error) {
        fields.stream_mode = error instanceof Error ? error.message : 'stream_mode 无效';
        return 'auto';
    }
}

function validateAgentImageUpstreamStrategy(input: {
    imageBackend: ImageGenerationBackend;
    streamMode: ImageStreamMode;
    streamingStrategy: ImageStreamingStrategy;
    fields: FieldErrors;
}) {
    if (input.streamMode === 'non_stream' || (input.streamMode === 'auto' && input.streamingStrategy === 'off')) {
        return;
    }
    try {
        resolveImageStreamEnabled({
            imageBackend: input.imageBackend,
            requestedStream: true,
            streamingStrategy: input.streamingStrategy
        });
    } catch (error) {
        input.fields.streaming_strategy =
            error instanceof Error ? error.message : 'streaming_strategy 与 image_backend 不兼容';
    }
}

function readAgentImageBackendCompatibility(
    profile: ImageUpstreamProfile,
    operation: 'generate' | 'edit',
    imageBackend: ImageGenerationBackend,
    fields: FieldErrors,
    options: { validatePartialImages?: boolean } = {}
): ReturnType<typeof getImageBackendCompatibility> {
    const compatibility = getImageBackendCompatibility(profile, operation, imageBackend, undefined, options);
    if (!compatibility.compatible) {
        fields.image_backend = compatibility.errors.map((error) => error.message).join(' ');
    }
    return compatibility;
}

function shouldValidateAgentPartialImages(input: {
    imageBackend: ImageGenerationBackend;
    streamMode: ImageStreamMode;
    streamingStrategy: ImageStreamingStrategy;
    hasNonStreamChannel: boolean;
}): boolean {
    if (input.streamMode === 'non_stream') return false;
    if (input.streamMode === 'auto' && input.streamingStrategy === 'off') return false;
    if (input.streamMode === 'auto' && input.streamingStrategy === 'auto') return !input.hasNonStreamChannel;
    return true;
}

function hasConfiguredNonStreamChannel(imageBackend: ImageGenerationBackend): boolean {
    const requestMode = imageBackend === 'responses-image-generation' ? 'responses-non-stream' : 'images-non-stream';
    return getChannelPoolSummary(parseChannelPoolConfig(process.env)).channels.some((channel) =>
        channel.requestModes.includes(requestMode)
    );
}

type AgentGenerateCandidate = {
    profile: ImageUpstreamProfile;
    requestMode: ChannelRequestMode;
    partialImagesRange: NumericRange;
};

function readHealthyCredentialRequestModes(): Map<string, ReadonlySet<ChannelRequestMode>> | undefined {
    const router = getExistingServerChannelState()?.router;
    if (!router) return undefined;
    return new Map(
        router
            .getHealthSnapshot()
            .channels.flatMap((channel) =>
                channel.credentials.map((credential) => [
                    credential.credentialId,
                    new Set(
                        credential.requestModes
                            .filter((requestMode) => requestMode.state === 'healthy')
                            .map((requestMode) => requestMode.mode)
                    ) as ReadonlySet<ChannelRequestMode>
                ])
            )
    );
}

function readAgentAutoGenerateCandidates(input: {
    imageBackend: ImageGenerationBackend;
    n: number;
    model: GptImageModel;
    size: string;
    background: AgentBackground;
    forceRequest: boolean;
}): { nonStream: AgentGenerateCandidate[]; streaming: AgentGenerateCandidate[] } {
    const serverState = getExistingServerChannelState();
    const credentials = serverState?.config.credentials ?? parseChannelPoolConfig(process.env).credentials;
    const healthyModesByCredential = readHealthyCredentialRequestModes();
    const isAvailable = (credential: (typeof credentials)[number], requestMode: ChannelRequestMode) => {
        if (
            credential.models !== undefined &&
            credential.models.length > 0 &&
            !credential.models.includes(input.model)
        ) {
            return false;
        }
        if (!getEffectiveChannelRequestModes(credential).includes(requestMode)) return false;
        if (
            isStreamingChannelRequestMode(requestMode) &&
            serverState?.streamingAvailability.isUnavailable({
                channelId: credential.channelId,
                imageBackend: input.imageBackend,
                streamingStrategy: 'auto',
                operation: 'generate'
            })
        ) {
            return false;
        }
        return (
            healthyModesByCredential === undefined ||
            healthyModesByCredential.get(credential.id)?.has(requestMode) === true
        );
    };
    const nonStreamRequestMode = resolveChannelRequestMode({ imageBackend: input.imageBackend, streamEnabled: false });
    const streamingRequestMode = resolveChannelRequestMode({ imageBackend: input.imageBackend, streamEnabled: true });
    const candidates = (requestMode: ChannelRequestMode, validatePartialImages: boolean) =>
        credentials.flatMap((credential) => {
            if (!isAvailable(credential, requestMode)) return [];
            const profile =
                credential.providerProfile ||
                readImageUpstreamProfile({
                    explicitProfile: credential.upstreamProfile,
                    channelId: credential.channelId,
                    baseUrl: credential.baseUrl
                });
            const compatibility = getImageBackendCompatibility(profile, 'generate', input.imageBackend, undefined, {
                validatePartialImages
            });
            const imageCountRange = compatibility.imageCountRange;
            const partialImagesRange = compatibility.partialImagesRange;
            if (!compatibility.compatible || !imageCountRange || !isIntegerWithinRange(input.n, imageCountRange)) {
                return [];
            }
            if (!input.forceRequest) {
                if (
                    isGptImage2Model(input.model) &&
                    input.background === 'transparent' &&
                    !profile.gptImage2.allowTransparentBackground
                ) {
                    return [];
                }
                if (isGptImage2Model(input.model) && input.size !== 'auto') {
                    const fields: FieldErrors = {};
                    readSize({ size: input.size }, input.model, fields, '1024x1024', profile);
                    if (fields.size) return [];
                }
            }
            if (!partialImagesRange) return [];
            return [{ profile, requestMode, partialImagesRange }];
        });
    return {
        nonStream: candidates(nonStreamRequestMode, false),
        streaming: candidates(streamingRequestMode, true)
    };
}

function resolveAgentAutoPartialImagesDefault(input: {
    body: Record<string, unknown>;
    imageBackend: ImageGenerationBackend;
    streamMode: ImageStreamMode;
    streamingStrategy: ImageStreamingStrategy;
    n: number;
    model: GptImageModel;
    size: string;
    background: AgentBackground;
    forceRequest: boolean;
}): PartialImagesCount | undefined {
    if (
        input.streamMode !== 'auto' ||
        input.streamingStrategy !== 'auto' ||
        (input.body.partial_images !== undefined &&
            input.body.partial_images !== null &&
            input.body.partial_images !== '')
    ) {
        return undefined;
    }

    const candidates = readAgentAutoGenerateCandidates(input);
    const nonStreamCandidates = candidates.nonStream;
    if (nonStreamCandidates.length > 0) {
        return clampIntegerToRange(
            AGENT_DEFAULT_PARTIAL_IMAGES,
            getAgentNonStreamPartialImagesRange()
        ) as PartialImagesCount;
    }

    const streamingCandidates = candidates.streaming.map((candidate) => candidate.partialImagesRange);
    if (streamingCandidates.length === 0) return undefined;

    const defaultRange =
        streamingCandidates.find((range) => isIntegerWithinRange(AGENT_DEFAULT_PARTIAL_IMAGES, range)) ??
        streamingCandidates[0];
    return clampIntegerToRange(AGENT_DEFAULT_PARTIAL_IMAGES, defaultRange) as PartialImagesCount;
}

function readPartialImagesForBackend(
    body: Record<string, unknown>,
    imageBackend: ImageGenerationBackend,
    fields: FieldErrors,
    profile: ImageUpstreamProfile,
    compatibility: ReturnType<typeof getImageBackendCompatibility>,
    options: { validatePartialImages?: boolean; defaultValue?: PartialImagesCount; range?: NumericRange } = {}
): PartialImagesCount {
    const limits =
        options.range ??
        (options.validatePartialImages === false
            ? getAgentNonStreamPartialImagesRange()
            : (compatibility.partialImagesRange ??
              (imageBackend === 'responses-image-generation'
                  ? RESPONSES_PARTIAL_IMAGES_RANGE
                  : profile.partialImages)));
    const fallback =
        options.defaultValue !== undefined
            ? clampIntegerToRange(options.defaultValue, limits)
            : clampDefaultPartialImages(limits);
    return readIntegerField(
        body,
        'partial_images',
        fallback,
        limits.min,
        limits.max,
        fields,
        limits
    ) as PartialImagesCount;
}

function readQuality(body: Record<string, unknown>, fields: FieldErrors): AgentQuality {
    const value = readStringField(body, 'quality', 'high');
    if (!value || !isOneOf(value, AGENT_QUALITIES)) {
        fields.quality = `必须是以下值之一：${AGENT_QUALITIES.join(', ')}`;
        return 'high';
    }
    return value;
}

function readBackground(body: Record<string, unknown>, fields: FieldErrors): AgentBackground {
    const value = readStringField(body, 'background', 'auto');
    if (!value || !isOneOf(value, AGENT_BACKGROUNDS)) {
        fields.background = `必须是以下值之一：${AGENT_BACKGROUNDS.join(', ')}`;
        return 'auto';
    }
    return value;
}

function validateAgentGenerateBackground(input: {
    model: GptImageModel;
    background: AgentBackground;
    forceRequest?: boolean;
    profile: ImageUpstreamProfile;
    fields: FieldErrors;
}): void {
    if (input.forceRequest || !isGptImage2Model(input.model) || input.background !== 'transparent') return;
    if (!input.profile.gptImage2.allowTransparentBackground) {
        input.fields.background = `${input.model} 不支持 transparent 背景。`;
    }
}

function readModeration(body: Record<string, unknown>, fields: FieldErrors): AgentModeration {
    const value = readStringField(body, 'moderation', 'auto');
    if (!value || !isOneOf(value, AGENT_MODERATIONS)) {
        fields.moderation = `必须是以下值之一：${AGENT_MODERATIONS.join(', ')}`;
        return 'auto';
    }
    return value;
}

function readOptionalStringField(
    body: Record<string, unknown>,
    field: string,
    fields: FieldErrors,
    options: { maxLength?: number } = {}
): string | undefined {
    const value = body[field];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
        fields[field] = '必须是字符串';
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        fields[field] = '必须是非空字符串';
        return undefined;
    }
    if (options.maxLength !== undefined && trimmed.length > options.maxLength) {
        fields[field] = `长度不能超过 ${options.maxLength} 个字符`;
        return undefined;
    }
    return trimmed;
}

function readOptionalBooleanField(
    body: Record<string, unknown>,
    field: string,
    fields: FieldErrors
): boolean | undefined {
    const value = body[field];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    fields[field] = '必须是布尔值';
    return undefined;
}

function readAgentResponsesModel(
    body: Record<string, unknown>,
    imageBackend: ImageGenerationBackend,
    fields: FieldErrors
): string | undefined {
    const value = readOptionalStringField(body, 'responsesModel', fields, { maxLength: MAX_MODEL_NAME_LENGTH });
    if (value && imageBackend !== 'responses-image-generation') {
        fields.responsesModel = '仅适用于 image_backend=responses-image-generation';
    }
    return value;
}

function readAgentThinking(body: Record<string, unknown>, fields: FieldErrors): AgentGenerateRequest['thinking'] {
    const value = readOptionalStringField(body, 'thinking', fields);
    if (value === undefined) return undefined;
    if (['minimal', 'none', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
        return value as AgentGenerateRequest['thinking'];
    }
    fields.thinking = '必须是 minimal、none、low、medium、high 或 xhigh';
    return undefined;
}

function readOutputCompression(
    body: Record<string, unknown>,
    outputFormat: ValidOutputFormat,
    fields: FieldErrors
): number | undefined {
    const value = body.output_compression;
    if (value === undefined || value === null || value === '') {
        return outputFormat === 'png' ? undefined : AGENT_DEFAULT_LOSSY_OUTPUT_COMPRESSION;
    }
    if (outputFormat === 'png') {
        fields.output_compression = '仅适用于 jpeg 或 webp 输出';
        return undefined;
    }
    const parsed =
        typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
        fields.output_compression = '必须是 0 到 100 之间的整数';
        return undefined;
    }
    return parsed;
}

export function validateAgentGenerateRequest(body: unknown): AgentGenerateRequest {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new RequestValidationError('请求正文必须是 JSON 对象。');
    }
    const objectBody = body as Record<string, unknown>;
    const fields: FieldErrors = {};
    const upstreamLimits = buildAgentUpstreamLimits(process.env);
    const model = readModel(objectBody, fields);
    const prompt = validatePrompt(objectBody.prompt, fields);
    const imageBackend = readAgentImageBackend(objectBody, fields);
    const streamMode = readAgentStreamMode(objectBody, fields);
    const streamingStrategy = readAgentStreamingStrategy(objectBody, fields);
    let validatePartialImages = shouldValidateAgentPartialImages({
        imageBackend,
        streamMode,
        streamingStrategy,
        hasNonStreamChannel: hasConfiguredNonStreamChannel(imageBackend)
    });
    let backendCompatibility = readAgentImageBackendCompatibility(
        upstreamLimits.validationProfile,
        'generate',
        imageBackend,
        fields,
        { validatePartialImages }
    );
    const imageCountRange = backendCompatibility.imageCountRange ?? RESPONSES_IMAGE_COUNT_RANGE;
    const n = readIntegerField(
        objectBody,
        'n',
        imageCountRange.min,
        imageCountRange.min,
        imageCountRange.max,
        fields,
        imageCountRange
    );
    const forceRequest = readOptionalBooleanField(objectBody, 'force_request', fields);
    const size = readSize(objectBody, model, fields, '1024x1024', upstreamLimits.validationProfile, {
        forceRequest: forceRequest === true
    });
    const quality = readQuality(objectBody, fields);
    const outputFormat = readOutputFormat(objectBody, fields);
    const outputCompression = readOutputCompression(objectBody, outputFormat, fields);
    const background = readBackground(objectBody, fields);
    const moderation = readModeration(objectBody, fields);
    const responseMode = readResponseMode(objectBody, fields);
    let automaticPartialImagesRange: NumericRange | undefined;
    if (streamMode === 'auto' && streamingStrategy === 'auto') {
        const candidates = readAgentAutoGenerateCandidates({
            imageBackend,
            n,
            model,
            size,
            background,
            forceRequest: forceRequest === true
        });
        validatePartialImages = candidates.nonStream.length === 0;
        if (validatePartialImages && candidates.streaming.length > 0) {
            automaticPartialImagesRange = unionRange(
                candidates.streaming.map((candidate) => candidate.partialImagesRange),
                false
            );
            backendCompatibility = readAgentImageBackendCompatibility(
                upstreamLimits.validationProfile,
                'generate',
                imageBackend,
                fields,
                { validatePartialImages: true }
            );
        } else if (!validatePartialImages) {
            backendCompatibility = readAgentImageBackendCompatibility(
                upstreamLimits.validationProfile,
                'generate',
                imageBackend,
                fields,
                { validatePartialImages: false }
            );
        }
    }
    const partialImages = readPartialImagesForBackend(
        objectBody,
        imageBackend,
        fields,
        upstreamLimits.validationProfile,
        backendCompatibility,
        {
            validatePartialImages,
            defaultValue: resolveAgentAutoPartialImagesDefault({
                body: objectBody,
                imageBackend,
                streamMode,
                streamingStrategy,
                n,
                model,
                size,
                background,
                forceRequest: forceRequest === true
            }),
            range: automaticPartialImagesRange
        }
    );
    const responsesModel = readAgentResponsesModel(objectBody, imageBackend, fields);
    const thinking = readAgentThinking(objectBody, fields);
    const promptOptimization = readOptionalBooleanField(objectBody, 'promptOptimization', fields);
    const forceWeb = readOptionalBooleanField(objectBody, 'force_web', fields);
    validateAgentGenerateBackground({
        model,
        background,
        forceRequest: forceRequest === true,
        profile: upstreamLimits.validationProfile,
        fields
    });
    validateAgentImageUpstreamStrategy({ imageBackend, streamMode, streamingStrategy, fields });

    if (Object.keys(fields).length > 0) {
        throw new RequestValidationError(JSON.stringify({ fields }), 422);
    }

    return {
        model,
        prompt,
        n,
        size,
        quality,
        output_format: outputFormat,
        ...(outputCompression !== undefined ? { output_compression: outputCompression } : {}),
        background,
        moderation,
        response_mode: responseMode,
        image_backend: imageBackend,
        stream_mode: streamMode,
        streaming_strategy: streamingStrategy,
        partial_images: partialImages,
        ...(responsesModel ? { responsesModel } : {}),
        ...(thinking ? { thinking } : {}),
        ...(promptOptimization !== undefined ? { promptOptimization } : {}),
        ...(forceWeb !== undefined ? { force_web: forceWeb } : {}),
        ...(forceRequest !== undefined ? { force_request: forceRequest } : {})
    };
}

export function readAgentStateBackend(env: Record<string, string | undefined>): AgentStateBackend {
    const backend = env.AGENT_STATE_BACKEND?.trim().toLowerCase();
    if (!backend) return 'sqlite';
    if (backend === 'memory' || backend === 'sqlite' || backend === 'postgres') return backend;
    throw new RequestValidationError('AGENT_STATE_BACKEND 必须是 memory、sqlite 或 postgres。', 500);
}

export function readAgentRequestTtlSeconds(env: Record<string, string | undefined>): number {
    return readPositiveIntegerEnv(env, 'AGENT_REQUEST_TTL_SECONDS', AGENT_DEFAULT_REQUEST_TTL_SECONDS);
}

export function readAgentLeaseMs(env: Record<string, string | undefined>): number {
    return readPositiveIntegerEnv(env, 'AGENT_REQUEST_LEASE_MS', AGENT_DEFAULT_LEASE_MS);
}

export function readAgentRecoveryIntervalMs(env: Record<string, string | undefined>): number {
    return readPositiveIntegerEnv(env, 'AGENT_RECOVERY_INTERVAL_MS', AGENT_DEFAULT_RECOVERY_INTERVAL_MS);
}

export function readAgentSqlitePath(env: Record<string, string | undefined>): string {
    return env.AGENT_SQLITE_PATH?.trim() || AGENT_DEFAULT_SQLITE_PATH;
}

export function readAgentPublicBaseUrl(env: Record<string, string | undefined>): string {
    const value = env.AGENT_PUBLIC_BASE_URL?.trim();
    if (!value) return '/';
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new RequestValidationError('AGENT_PUBLIC_BASE_URL 格式无效。', 500);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new RequestValidationError('AGENT_PUBLIC_BASE_URL 必须是 http 或 https URL。', 500);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new RequestValidationError('AGENT_PUBLIC_BASE_URL 不能包含凭据、查询参数或片段。', 500);
    }
    return parsed.toString().replace(/\/$/, '');
}

export function validateOptionalAgentApiBaseUrl(baseUrl: string | undefined): void {
    if (baseUrl) validateApiBaseUrl(baseUrl);
}

export function buildAgentAuthCapabilities(env: Record<string, string | undefined>): AgentCapabilities['auth'] {
    if (env.AGENT_API_TOKEN?.trim()) {
        return { required: true, schemes: ['bearer'] };
    }
    if (env.APP_PASSWORD?.trim()) {
        return { required: true, schemes: ['x-app-password-hash'] };
    }
    return { required: false, schemes: [] };
}

export function buildPageSseAuthCapabilities(
    env: Record<string, string | undefined>
): AgentCapabilities['agent_streaming']['page_sse']['auth'] {
    return {
        required: Boolean(env.APP_PASSWORD?.trim()),
        schemes: env.APP_PASSWORD?.trim() ? ['form-password-hash'] : [],
        form_field: 'passwordHash'
    };
}

export function buildPageRequestDiagnosticsCapabilities(
    env: Record<string, string | undefined>
): AgentCapabilities['page_request_diagnostics'] {
    const retention = buildPageRequestDiagnosticsRetention(env);
    return {
        supported: true,
        source: 'app_log',
        endpoints: {
            single: AGENT_ENDPOINTS.page_request_diagnostics,
            batch: AGENT_ENDPOINTS.page_request_diagnostics_batch
        },
        retention,
        no_match_hint: AGENT_PAGE_REQUEST_DIAGNOSTICS_NO_MATCH_HINT
    };
}

export function buildPageRequestDiagnosticsRetention(
    env: Record<string, string | undefined>
): AgentPageRequestDiagnosticsRetention {
    return {
        ...readAppLogRetentionMetadata(env),
        bounded: true,
        not_agent_state_backend: true
    };
}

export function buildAgentRequestDiagnosticsCapabilities(
    env: Record<string, string | undefined>
): AgentCapabilities['agent_request_diagnostics'] {
    return {
        supported: true,
        source: 'agent_state',
        endpoints: {
            lookup: AGENT_ENDPOINTS.agent_request_diagnostics_lookup,
            single: AGENT_ENDPOINTS.agent_request_diagnostics
        },
        lookup: {
            by_request_id: true,
            by_idempotency_key: true
        },
        retention: buildAgentRequestDiagnosticsRetention(env)
    };
}

export function buildAgentRequestDiagnosticsRetention(
    env: Record<string, string | undefined>
): AgentRequestDiagnosticsRetention {
    return {
        storage: 'agent_state',
        ttl_seconds: readAgentRequestTtlSeconds(env),
        bounded: true,
        loss_modes: ['request_expired_by_ttl', 'artifact_deleted_or_purged', 'state_backend_reset']
    };
}

export function buildPageRequestDiagnosticsNoMatchNote(input: {
    matchedLogCount: number;
    retention: AgentPageRequestDiagnosticsRetention;
}): AgentPageRequestDiagnosticsNote | undefined {
    if (input.matchedLogCount !== 0) return undefined;
    return {
        code: 'no_matching_logs_in_retention_window',
        message: AGENT_PAGE_REQUEST_DIAGNOSTICS_NO_MATCH_HINT,
        retention: input.retention
    };
}

function readEnabledImageBackends(
    requirements: Record<ImageGenerationBackend, ImageBackendRuntimeRequirement>,
    mode: 'request' | 'streaming' = 'request'
): ImageGenerationBackend[] {
    const responses = requirements['responses-image-generation'];
    const responsesEnabled =
        responses.enabled &&
        (mode !== 'streaming' || (responses.streaming_incompatible_constraints?.length ?? 0) === 0);
    return responsesEnabled ? ['images-api', 'responses-image-generation'] : ['images-api'];
}

type ImageBackendCapabilityChannel = {
    effectiveProfile: ImageUpstreamProfile;
    requestModes: readonly ChannelRequestMode[];
};

function buildImageBackendRequirements(
    env: Record<string, string | undefined>,
    profile: ImageUpstreamProfile,
    profiles: ImageUpstreamProfile[] = [profile],
    channels: readonly ImageBackendCapabilityChannel[] = []
): Record<ImageGenerationBackend, ImageBackendRuntimeRequirement> {
    const responsesMissingEnv = readResponsesImageBackendMissingEnv(env);
    const eligibleProfiles = profiles.length > 0 ? profiles : [profile];
    const incompatibleConstraints = readResponsesImageBackendIncompatibleConstraints(
        profile,
        false,
        eligibleProfiles,
        channels
    );
    const streamingIncompatibleConstraints = readResponsesImageBackendIncompatibleConstraints(
        profile,
        true,
        eligibleProfiles,
        channels
    ).filter((constraint) => !incompatibleConstraints.includes(constraint));
    return {
        'images-api': {
            supported: true,
            enabled: true,
            required_env: [],
            missing_env: []
        },
        'responses-image-generation': {
            supported: true,
            enabled: responsesMissingEnv.length === 0 && incompatibleConstraints.length === 0,
            required_env: ['ENABLE_RESPONSES_IMAGE_BACKEND', 'OPENAI_RESPONSES_API_MODEL'],
            missing_env: responsesMissingEnv,
            ...(incompatibleConstraints.length > 0 ? { incompatible_constraints: incompatibleConstraints } : {}),
            ...(streamingIncompatibleConstraints.length > 0
                ? { streaming_incompatible_constraints: streamingIncompatibleConstraints }
                : {})
        }
    };
}

function readResponsesImageBackendIncompatibleConstraints(
    profile: ImageUpstreamProfile,
    validatePartialImages: boolean,
    profiles: ImageUpstreamProfile[] = [profile],
    channels: readonly ImageBackendCapabilityChannel[] = []
): string[] {
    const hasConfiguredChannels = channels.length > 0;
    const requestModes = validatePartialImages
        ? (['responses-sse'] as const)
        : (['responses-non-stream', 'responses-sse'] as const);
    const modeChannels = channels.filter((channel) =>
        requestModes.some((requestMode) => channel.requestModes.includes(requestMode))
    );
    if (hasConfiguredChannels && modeChannels.length === 0) {
        return [validatePartialImages ? 'streaming_request_modes' : 'request_modes'];
    }
    const eligibleProfiles = hasConfiguredChannels
        ? modeChannels.map((channel) => channel.effectiveProfile)
        : profiles.length > 0
          ? profiles
          : [profile];
    const incompatible: string[] = [];
    const supportsResponsesGenerate = (candidate: ImageUpstreamProfile) =>
        getImageCountRangeCompatibilityForBackend(candidate, 'generate', 'responses-image-generation').compatible;
    const supportsResponsesEdit = (candidate: ImageUpstreamProfile) =>
        getImageCountRangeCompatibilityForBackend(candidate, 'edit', 'responses-image-generation').compatible;
    const supportsResponsesPartialImages = (candidate: ImageUpstreamProfile) =>
        getPartialImagesRangeCompatibilityForBackend(candidate, 'responses-image-generation').compatible;
    const hasResponsesGenerate = eligibleProfiles.some((candidate) => supportsResponsesGenerate(candidate));
    const hasResponsesEdit = eligibleProfiles.some((candidate) => supportsResponsesEdit(candidate));
    if (!hasResponsesGenerate) {
        incompatible.push('generate_images');
    }
    if (!hasResponsesEdit) {
        incompatible.push('edit_images');
    }
    if (validatePartialImages && hasResponsesGenerate && hasResponsesEdit) {
        const hasStreamingGenerate = eligibleProfiles.some(
            (candidate) => supportsResponsesGenerate(candidate) && supportsResponsesPartialImages(candidate)
        );
        const hasStreamingEdit = eligibleProfiles.some(
            (candidate) => supportsResponsesEdit(candidate) && supportsResponsesPartialImages(candidate)
        );
        if (!hasStreamingGenerate || !hasStreamingEdit) {
            incompatible.push('partial_images');
        }
    }
    return incompatible;
}

function readResponsesImageBackendMissingEnv(env: Record<string, string | undefined>): string[] {
    const missing: string[] = [];
    if (!readBooleanEnv(env, 'ENABLE_RESPONSES_IMAGE_BACKEND')) {
        missing.push('ENABLE_RESPONSES_IMAGE_BACKEND');
    }
    if (!env.OPENAI_RESPONSES_API_MODEL?.trim()) {
        missing.push('OPENAI_RESPONSES_API_MODEL');
    }
    return missing;
}

function readPositiveIntegerEnv(env: Record<string, string | undefined>, fieldName: string, fallback: number): number {
    try {
        return readPositiveIntegerFromEnv(env, fieldName, fallback, {
            messages: CHINESE_POSITIVE_INTEGER_MESSAGES
        });
    } catch (error) {
        throw new RequestValidationError(error instanceof Error ? error.message : `${fieldName} 必须是正整数。`, 500);
    }
}

export function buildAgentCapabilities(env: Record<string, string | undefined>): AgentCapabilities {
    const defaultModel = resolveDefaultImageModel(env);
    const upstreamLimits = buildAgentUpstreamLimits(env);
    const channelSummary = getChannelPoolSummary(parseChannelPoolConfig(env));
    const normalizedGenerateImages = getImageCountRangeForBackend(upstreamLimits.profile, 'generate', 'images-api');
    const normalizedEditImages = getImageCountRangeForBackend(upstreamLimits.profile, 'edit', 'images-api');
    const imageBackendRequirements = buildImageBackendRequirements(
        env,
        upstreamLimits.profile,
        upstreamLimits.summary.serverConstraintsByProfile,
        channelSummary.channels
    );
    const enabledImageBackends = readEnabledImageBackends(imageBackendRequirements);
    const enabledStreamingImageBackends = readEnabledImageBackends(imageBackendRequirements, 'streaming');
    const responsesBackendEnabled = imageBackendRequirements['responses-image-generation'].enabled;
    const generateImagesByBackend = buildAgentImageCountByBackend(
        upstreamLimits.profile,
        'generate',
        responsesBackendEnabled,
        upstreamLimits.summary.serverConstraintsByProfile,
        channelSummary.channels
    );
    const editImagesByBackend = buildAgentImageCountByBackend(
        upstreamLimits.profile,
        'edit',
        responsesBackendEnabled,
        upstreamLimits.summary.serverConstraintsByProfile,
        channelSummary.channels
    );
    const partialImagesByBackend = buildAgentPartialImagesByBackend(
        upstreamLimits.profile,
        responsesBackendEnabled,
        upstreamLimits.summary.serverConstraintsByProfile,
        channelSummary.channels
    );
    const defaultPartialImages = clampDefaultPartialImages(partialImagesByBackend['images-api']);
    return {
        api_version: AGENT_API_VERSION,
        schema_version: AGENT_SCHEMA_VERSION,
        auth: buildAgentAuthCapabilities(env),
        endpoints: { ...AGENT_ENDPOINTS },
        image_transport: summarizeOpenAIImageTransport(env),
        upstream_profile: upstreamLimits.summary,
        upstream_request_headers: buildAgentUpstreamRequestHeadersCapabilities(env),
        request_mode_controls: buildAgentRequestModeControlsCapabilities(),
        defaults: {
            model: defaultModel,
            response_mode: 'path',
            state_backend: readAgentStateBackend(env),
            image_backend: 'images-api',
            stream_mode: 'auto',
            streaming_strategy: 'auto',
            partial_images: defaultPartialImages
        },
        limits: {
            max_prompt_length: MAX_PROMPT_LENGTH,
            max_images: Math.min(normalizedGenerateImages.max, normalizedEditImages.max),
            generate_images: normalizedGenerateImages,
            edit_images: normalizedEditImages,
            generate_images_by_backend: generateImagesByBackend,
            edit_images_by_backend: editImagesByBackend,
            upload_images: { max: upstreamLimits.profile.upload.maxImages },
            max_upload_mb: upstreamLimits.profile.upload.maxSingleBytes / 1024 / 1024,
            ...(upstreamLimits.profile.upload.maxTotalBytes !== undefined
                ? { max_total_upload_mb: upstreamLimits.profile.upload.maxTotalBytes / 1024 / 1024 }
                : {}),
            partial_images: upstreamLimits.profile.partialImages,
            partial_images_by_backend: partialImagesByBackend,
            upstream_profile: upstreamLimits.profile.id,
            upstream_profile_mixed: upstreamLimits.summary.serverProfileMixed
        },
        force_request_controls: {
            field: 'force_request',
            cli_flag: '--force-request',
            default: false,
            effect: 'skip_local_upstream_profile_size_and_background_validation',
            still_enforced: [
                'authentication',
                'idempotency_key',
                'billable_confirmation',
                'api_base_url_safety',
                'channel_request_mode_whitelist',
                'image_count_limits',
                'partial_image_limits',
                'non_gpt_image2_size_allowlist',
                'positive_integer_size_syntax',
                'upload_file_size_and_type',
                'mask_integrity_checks'
            ],
            intended_for: [
                'upstream_compatibility_probe',
                'administrator_confirmed_provider_contract',
                'requests_where_real_upstream_should_decide'
            ]
        },
        model_limits: {
            'gpt-image-2': {
                max_edge: GPT_IMAGE_2_MAX_EDGE,
                max_pixels: GPT_IMAGE_2_MAX_PIXELS,
                edge_multiple: GPT_IMAGE_2_EDGE_MULTIPLE,
                max_aspect: GPT_IMAGE_2_MAX_ASPECT,
                min_pixels: GPT_IMAGE_2_MIN_PIXELS,
                size_policy: upstreamLimits.profile.gptImage2.sizePolicy,
                allow_transparent_background: upstreamLimits.profile.gptImage2.allowTransparentBackground,
                recommended_presets: [
                    { name: 'square', size: '2048x2048', purpose: '通用正方形构图' },
                    { name: 'landscape', size: '3072x2048', purpose: '横向宽幅构图' },
                    { name: 'portrait', size: '2048x3072', purpose: '纵向主体构图' }
                ],
                large_image_risk: {
                    applies_to: ['max_edge>2048', 'long_running_upstream'],
                    guidance: '大尺寸请求可能耗时数分钟；失败应归类为上游长耗时风险，不代表低负载路径不可用。'
                }
            },
            'gpt-image-2-1k': {
                max_edge: GPT_IMAGE_2_MAX_EDGE,
                max_pixels: GPT_IMAGE_2_MAX_PIXELS,
                edge_multiple: GPT_IMAGE_2_EDGE_MULTIPLE,
                max_aspect: GPT_IMAGE_2_MAX_ASPECT,
                min_pixels: GPT_IMAGE_2_MIN_PIXELS,
                size_policy: upstreamLimits.profile.gptImage2.sizePolicy,
                allow_transparent_background: upstreamLimits.profile.gptImage2.allowTransparentBackground,
                recommended_presets: [
                    { name: 'square', size: '2048x2048', purpose: '通用正方形构图' },
                    { name: 'landscape', size: '3072x2048', purpose: '横向宽幅构图' },
                    { name: 'portrait', size: '2048x3072', purpose: '纵向主体构图' }
                ],
                large_image_risk: {
                    applies_to: ['max_edge>2048', 'long_running_upstream'],
                    guidance: '大尺寸请求可能耗时数分钟；失败应归类为上游长耗时风险，不代表低负载路径不可用。'
                }
            }
        },
        agent_streaming: {
            generate: {
                supported: false,
                mode: 'non_streaming_only',
                endpoint: AGENT_ENDPOINTS.generate
            },
            edit: {
                supported: false,
                mode: 'non_streaming_only',
                endpoint: AGENT_ENDPOINTS.edit
            },
            upstream_sse: {
                supported: true,
                mode: 'internal_upstream_sse',
                endpoint: AGENT_ENDPOINTS.generate,
                request_fields: AGENT_UPSTREAM_SSE_GENERATE_REQUEST_FIELDS,
                request_fields_by_mode: {
                    generate: AGENT_UPSTREAM_SSE_GENERATE_REQUEST_FIELDS,
                    edit: AGENT_UPSTREAM_SSE_EDIT_REQUEST_FIELDS
                },
                image_backends: AGENT_IMAGE_BACKENDS,
                enabled_image_backends: enabledStreamingImageBackends,
                streaming_strategies: AGENT_STREAMING_STRATEGIES,
                stream_modes: AGENT_STREAM_MODES,
                activation_strategies: AGENT_UPSTREAM_SSE_ACTIVATION_STRATEGIES,
                final_response_contract: 'AgentImageResponse'
            },
            page_sse: {
                supported: true,
                mode: 'form_data_sse',
                endpoint: '/api/images',
                contract: 'page_ui_only',
                transport_contract: 'page_form_data_sse',
                auth: buildPageSseAuthCapabilities(env),
                client_request_id: {
                    form_field: 'clientRequestId',
                    source_header: 'Idempotency-Key',
                    max_length: PAGE_SSE_CLIENT_REQUEST_ID_MAX_LENGTH
                },
                agent_usage: AGENT_PAGE_SSE_AGENT_USAGE
            }
        },
        orchestration: {
            supported: true,
            policy: 'server_orchestrated_generate_v1',
            endpoint: AGENT_ENDPOINTS.create_image_request,
            client_contract: 'intent_only',
            transport_selection: 'server_owned',
            result_mode: 'job_polling',
            hidden_controls: ['transport', 'route_mode', 'client_endpoint_selection'],
            diagnostics: {
                job_result: AGENT_ENDPOINTS.job_result,
                request_lookup: AGENT_ENDPOINTS.agent_request_diagnostics_lookup
            },
            current_guidance:
                'Agent 客户端默认只提交生成意图到 /api/agent/image-requests；服务端负责选择内部执行路径、上游策略和轮询结果。显式 /api/images、Agent JSON 或 job endpoint 仅作为诊断/兼容入口。'
        },
        routing_rules: {
            high_resolution_edit: {
                when: ['operation=edit', 'max_edge>2048'],
                conditions: {
                    operation: 'edit',
                    max_edge: { operator: 'gt', value: 2048 }
                },
                endpoint: '/api/images',
                transport: 'page_sse',
                strength: 'default',
                action: {
                    endpoint: '/api/images',
                    transport: 'page_sse',
                    strength: 'default',
                    fallback_endpoint: AGENT_ENDPOINTS.edit,
                    fallback_mode: 'manual_after_diagnosis',
                    requires_new_idempotency_key_on_retry: true,
                    no_automatic_fallback: true
                },
                reason: 'High-resolution edit uses the page form-data SSE endpoint because Agent edit has a fixed output contract; if streaming has issues, diagnose first and explicitly fall back to Agent edit.'
            },
            complex_ui_batch: {
                when: ['operation=generate_or_edit', 'complex_ui=true', 'batch=true'],
                conditions: {
                    operation: 'generate_or_edit',
                    complex_ui: true,
                    batch: true
                },
                endpoint: '/api/images',
                transport: 'page_sse',
                strength: 'recommended',
                action: {
                    endpoint: '/api/images',
                    transport: 'page_sse',
                    strength: 'recommended',
                    fallback_mode: 'manual_after_diagnosis',
                    requires_new_idempotency_key_on_retry: true,
                    no_automatic_fallback: true
                },
                reason: 'Page form-data SSE keeps long-running image production observable and recoverable for complex UI batches.'
            },
            long_image_recovery: {
                when: ['operation=generate_or_edit', 'long_image=true', 'resume_or_recover=true'],
                conditions: {
                    operation: 'generate_or_edit',
                    long_image: true,
                    resume_or_recover: true
                },
                endpoint: '/api/images',
                transport: 'page_sse',
                strength: 'recommended',
                action: {
                    endpoint: '/api/images',
                    transport: 'page_sse',
                    strength: 'recommended',
                    fallback_mode: 'manual_after_diagnosis',
                    requires_new_idempotency_key_on_retry: true,
                    no_automatic_fallback: true
                },
                reason: 'Page form-data SSE exposes partial progress and final-image diagnostics needed for long-image recovery runs.'
            },
            agent_generate_small_smoke: {
                when: ['operation=generate', 'max_edge<=2048', 'single_request=true'],
                conditions: {
                    operation: 'generate',
                    max_edge: { operator: 'lte', value: 2048 },
                    single_request: true
                },
                endpoint: AGENT_ENDPOINTS.generate,
                transport: 'agent_json',
                strength: 'explicit',
                action: {
                    endpoint: AGENT_ENDPOINTS.generate,
                    transport: 'agent_json',
                    strength: 'explicit',
                    requires_new_idempotency_key_on_retry: true,
                    no_automatic_fallback: true
                },
                reason: 'Agent JSON generate remains available for compatibility and explicit diagnostics; ordinary generate clients should use orchestration.endpoint.'
            },
            page_sse_generate_diagnostics: {
                when: ['operation=generate', 'explicit_page_sse=true'],
                conditions: {
                    operation: 'generate',
                    explicit_page_sse: true,
                    single_request: true
                },
                endpoint: '/api/images',
                transport: 'page_sse',
                strength: 'explicit',
                action: {
                    endpoint: '/api/images',
                    transport: 'page_sse',
                    strength: 'explicit',
                    fallback_endpoint: AGENT_ENDPOINTS.create_image_request,
                    fallback_mode: 'manual_after_diagnosis',
                    requires_new_idempotency_key_on_retry: true,
                    no_automatic_fallback: true
                },
                reason: 'Page form-data SSE is available for explicit page-workbench or diagnostic generate runs; ordinary generate clients should use orchestration.endpoint.'
            },
            retry_recovery: {
                reuse_failed_idempotency_key: false,
                new_attempt_guidance:
                    'A failed terminal Agent request only replays the stored failure. Diagnose the failure, then create a new business operation with a new Idempotency-Key.'
            }
        },
        agent_jobs: {
            supported: true,
            mode: 'job_polling',
            intended_for: [
                'explicit_job_route',
                'manual_after_diagnosis',
                'long_running_upstream_when_page_sse_not_selected'
            ],
            endpoints: { ...AGENT_JOB_ENDPOINTS },
            states: AGENT_JOB_STATES,
            current_guidance:
                'Agent 客户端默认使用 orchestration.endpoint；直接创建 job 是兼容和诊断入口。当前执行模型为同实例后台任务，不是跨实例持久队列。'
        },
        supported: {
            models: AGENT_MODELS,
            output_formats: AGENT_OUTPUT_FORMATS,
            response_modes: AGENT_RESPONSE_MODES,
            qualities: AGENT_QUALITIES,
            backgrounds: AGENT_BACKGROUNDS,
            moderations: AGENT_MODERATIONS,
            legacy_sizes: AGENT_LEGACY_SIZES,
            image_backends: AGENT_IMAGE_BACKENDS,
            enabled_image_backends: enabledImageBackends,
            image_backend_requirements: imageBackendRequirements,
            request_modes: CHANNEL_REQUEST_MODES,
            streaming_strategies: AGENT_STREAMING_STRATEGIES,
            stream_modes: AGENT_STREAM_MODES
        },
        model_directory: {
            endpoint: AGENT_ENDPOINTS.models,
            probe_query: '?probe=true',
            default_model: defaultModel,
            semantics: 'declared_models_only_until_explicit_probe'
        },
        storage: {
            image_storage_mode: env.NEXT_PUBLIC_IMAGE_STORAGE_MODE || (env.VERCEL === '1' ? 'indexeddb' : 'fs'),
            postgres_configured: Boolean(env.AGENT_DATABASE_URL || env.AGENT_DB_PASSWORD || env.AGENT_DB_PASSWORD_FILE)
        },
        page_request_diagnostics: buildPageRequestDiagnosticsCapabilities(env),
        agent_request_diagnostics: buildAgentRequestDiagnosticsCapabilities(env),
        channel_health_diagnostics: {
            supported: true,
            endpoint: AGENT_ENDPOINTS.channel_health_diagnostics,
            source: 'in_process_channel_router',
            state_scope: 'process_local',
            billable: false
        },
        idempotency: {
            required: true,
            header: 'Idempotency-Key',
            ttl_seconds: readAgentRequestTtlSeconds(env)
        }
    };
}

function buildAgentRequestModeControlsCapabilities(): AgentCapabilities['request_mode_controls'] {
    return {
        source: CHANNEL_REQUEST_MODE_ADMIN_CONTROL.source,
        global_env: CHANNEL_REQUEST_MODE_ADMIN_CONTROL.globalEnv,
        channel_env_pattern: CHANNEL_REQUEST_MODE_ADMIN_CONTROL.channelEnvPattern,
        global_priority_env: CHANNEL_REQUEST_MODE_ADMIN_CONTROL.globalPriorityEnv,
        channel_priority_env_pattern: CHANNEL_REQUEST_MODE_ADMIN_CONTROL.channelPriorityEnvPattern,
        default_priority: CHANNEL_REQUEST_MODE_ADMIN_CONTROL.defaultPriority,
        default_priority_policy: CHANNEL_REQUEST_MODE_ADMIN_CONTROL.defaultPriorityPolicy,
        mutable_at_runtime: CHANNEL_REQUEST_MODE_ADMIN_CONTROL.mutableAtRuntime,
        agent_client_policy: 'diagnostics_only',
        final_gate_command: CHANNEL_REQUEST_MODE_ADMIN_CONTROL.finalGateCommand,
        smoke_gate_commands: CHANNEL_REQUEST_MODE_ADMIN_CONTROL.smokeGateCommands
    };
}

function buildAgentUpstreamRequestHeadersCapabilities(
    env: Record<string, string | undefined>
): AgentCapabilities['upstream_request_headers'] {
    const channelSummary = getChannelPoolSummary(parseChannelPoolConfig(env));
    const healthyModesByChannel = readHealthyRequestModesByChannel(
        channelSummary.channels.map((channel) => channel.id)
    );
    return {
        default: summarizeUpstreamRequestHeaders(undefined, env),
        channels: channelSummary.channels.map((channel) => ({
            id: channel.id,
            upstream_proxy: channel.upstreamProxy,
            request_modes: channel.requestModes,
            request_mode_priority: channel.requestModePriority,
            request_headers: channel.requestHeaders,
            constraints: buildAgentChannelConstraints(channel.effectiveProfile),
            ...(healthyModesByChannel?.has(channel.id)
                ? { healthy_request_modes: healthyModesByChannel.get(channel.id) }
                : {})
        }))
    };
}

function buildAgentChannelConstraints(profile: ImageUpstreamProfile): AgentChannelConstraints {
    const generateImagesByBackend: AgentChannelConstraints['generate_images_by_backend'] = {
        'images-api': getImageCountRangeForBackend(profile, 'generate', 'images-api')
    };
    const editImagesByBackend: AgentChannelConstraints['edit_images_by_backend'] = {
        'images-api': getImageCountRangeForBackend(profile, 'edit', 'images-api')
    };
    const partialImagesByBackend: AgentChannelConstraints['partial_images_by_backend'] = {
        'images-api': getPartialImagesRangeForBackend(profile, 'images-api')
    };
    const responseGenerate = getImageCountRangeCompatibilityForBackend(
        profile,
        'generate',
        'responses-image-generation'
    );
    const responseEdit = getImageCountRangeCompatibilityForBackend(profile, 'edit', 'responses-image-generation');
    const responsePartial = getPartialImagesRangeCompatibilityForBackend(profile, 'responses-image-generation');
    if (responseGenerate.compatible) generateImagesByBackend['responses-image-generation'] = responseGenerate.range;
    if (responseEdit.compatible) editImagesByBackend['responses-image-generation'] = responseEdit.range;
    if (responsePartial.compatible) partialImagesByBackend['responses-image-generation'] = responsePartial.range;
    return {
        generate_images: getImageCountRangeForBackend(profile, 'generate', 'images-api'),
        edit_images: getImageCountRangeForBackend(profile, 'edit', 'images-api'),
        partial_images: getPartialImagesRangeForBackend(profile, 'images-api'),
        generate_images_by_backend: generateImagesByBackend,
        edit_images_by_backend: editImagesByBackend,
        partial_images_by_backend: partialImagesByBackend,
        upload_images: {
            max: profile.upload.maxImages,
            max_single_mb: profile.upload.maxSingleBytes / 1024 / 1024,
            ...(profile.upload.maxTotalBytes === undefined
                ? {}
                : { max_total_mb: profile.upload.maxTotalBytes / 1024 / 1024 })
        },
        gpt_image_2: {
            allow_transparent_background: profile.gptImage2.allowTransparentBackground,
            size_policy: profile.gptImage2.sizePolicy
        }
    };
}

function readHealthyRequestModesByChannel(
    channelIds: string[]
): Map<string, readonly ChannelRequestMode[]> | undefined {
    const state = getExistingServerChannelState();
    if (!state) return undefined;
    const router = state.router;
    if (!router) return undefined;
    const configuredIds = Array.from(
        new Set(state.config.credentials.map((credential) => credential.channelId))
    ).sort();
    const expectedIds = Array.from(new Set(channelIds)).sort();
    if (configuredIds.length !== expectedIds.length || configuredIds.some((id, index) => id !== expectedIds[index])) {
        return undefined;
    }
    const healthy = new Map<string, readonly ChannelRequestMode[]>();
    for (const channel of router.getHealthSnapshot().channels) {
        const modes = Array.from(
            new Set(
                channel.credentials.flatMap((credential) =>
                    credential.requestModes
                        .filter((requestMode) => requestMode.state === 'healthy')
                        .map((requestMode) => requestMode.mode)
                )
            )
        );
        healthy.set(channel.channelId, modes);
    }
    return healthy;
}

function buildAgentUpstreamLimits(env: Record<string, string | undefined>): {
    profile: ImageUpstreamProfile;
    validationProfile: ImageUpstreamProfile;
    summary: ImageUpstreamProfileSummary;
} {
    const serverProfiles = readServerProfiles(env);
    const summary = summarizeImageUpstreamProfile({ serverProfiles });
    return {
        profile: summary.activeConstraints,
        validationProfile: buildAgentRequestValidationProfile(summary),
        summary
    };
}

function readServerProfiles(env: Record<string, string | undefined>): ImageUpstreamProfile[] {
    return getChannelPoolSummary(parseChannelPoolConfig(env)).channels.map((channel) => channel.effectiveProfile);
}

function buildAgentRequestValidationProfile(summary: ImageUpstreamProfileSummary): ImageUpstreamProfile {
    const profiles = summary.serverConstraintsByProfile;
    if (profiles.length <= 1 || (!summary.serverProfileMixed && !summary.serverConstraintsMixed)) {
        return summary.activeConstraints;
    }
    return {
        ...summary.activeConstraints,
        generateCount: unionRange(
            profiles.map((profile) => profile.generateCount),
            true
        ),
        editCount: unionRange(
            profiles.map((profile) => profile.editCount),
            true
        ),
        partialImages: unionRange(
            profiles.map((profile) => profile.partialImages),
            false
        ),
        upload: {
            maxImages: Math.max(...profiles.map((profile) => profile.upload.maxImages)),
            maxSingleBytes: Math.max(...profiles.map((profile) => profile.upload.maxSingleBytes)),
            ...(maxDefined(profiles.map((profile) => profile.upload.maxTotalBytes)) !== undefined
                ? { maxTotalBytes: maxDefined(profiles.map((profile) => profile.upload.maxTotalBytes)) }
                : {})
        },
        gptImage2: {
            allowTransparentBackground: profiles.some((profile) => profile.gptImage2.allowTransparentBackground),
            sizePolicy: profiles.some((profile) => profile.gptImage2.sizePolicy === 'positive-integer')
                ? 'positive-integer'
                : 'openai-compatible'
        }
    };
}

function unionRange(ranges: NumericRange[], positive: boolean): NumericRange {
    const values = ranges
        .flatMap((range) => buildIntegerRangeOptions(range))
        .filter((value) => !positive || value >= 1);
    return numericRangeFromValues(values);
}

function numericRangeFromValues(values: number[]): NumericRange {
    const normalized = Array.from(new Set(values.filter(Number.isInteger))).sort((left, right) => left - right);
    const min = normalized[0];
    const max = normalized[normalized.length - 1];
    if (min === undefined || max === undefined) return { min: 1, max: 0 };
    return normalized.length === max - min + 1 ? { min, max } : { min, max, allowedValues: normalized };
}

function maxDefined(values: Array<number | undefined>): number | undefined {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length > 0 ? Math.max(...defined) : undefined;
}

function clampDefaultPartialImages(limits: ImageUpstreamProfile['partialImages']): PartialImagesCount {
    return clampIntegerToRange(AGENT_DEFAULT_PARTIAL_IMAGES, limits) as PartialImagesCount;
}

export function getAgentNonStreamPartialImagesRange(): NumericRange {
    return { min: 0, max: 4 };
}

function buildAgentPartialImagesByBackend(
    profile: ImageUpstreamProfile,
    responsesBackendEnabled: boolean,
    profiles: ImageUpstreamProfile[] = [profile],
    channels: readonly ImageBackendCapabilityChannel[] = []
): Record<ImageGenerationBackend, NumericRange> {
    const responseProfiles = getResponsesCapabilityProfiles(profiles, channels);
    const responsesRanges = responseProfiles.flatMap((candidate) => {
        const compatibility = getPartialImagesRangeCompatibilityForBackend(candidate, 'responses-image-generation');
        return compatibility.compatible ? [compatibility.range] : [];
    });
    return {
        'images-api': getPartialImagesRangeForBackend(profile, 'images-api'),
        'responses-image-generation':
            responsesBackendEnabled && responsesRanges.length > 0
                ? unionRange(responsesRanges, false)
                : { ...RESPONSES_PARTIAL_IMAGES_RANGE }
    };
}

function buildAgentImageCountByBackend(
    profile: ImageUpstreamProfile,
    operation: 'generate' | 'edit',
    responsesBackendEnabled: boolean,
    profiles: ImageUpstreamProfile[] = [profile],
    channels: readonly ImageBackendCapabilityChannel[] = []
): Record<ImageGenerationBackend, NumericRange> {
    const responseProfiles = getResponsesCapabilityProfiles(profiles, channels);
    const responsesRanges = responseProfiles.flatMap((candidate) => {
        const compatibility = getImageCountRangeCompatibilityForBackend(
            candidate,
            operation,
            'responses-image-generation'
        );
        return compatibility.compatible ? [compatibility.range] : [];
    });
    return {
        'images-api': getImageCountRangeForBackend(profile, operation, 'images-api'),
        'responses-image-generation':
            responsesBackendEnabled && responsesRanges.length > 0
                ? unionRange(responsesRanges, true)
                : { ...RESPONSES_IMAGE_COUNT_RANGE }
    };
}

function getResponsesCapabilityProfiles(
    profiles: ImageUpstreamProfile[],
    channels: readonly ImageBackendCapabilityChannel[]
): ImageUpstreamProfile[] {
    if (channels.length === 0) return profiles.length > 0 ? profiles : [];
    return channels
        .filter(
            (channel) =>
                channel.requestModes.includes('responses-non-stream') || channel.requestModes.includes('responses-sse')
        )
        .map((channel) => channel.effectiveProfile);
}
