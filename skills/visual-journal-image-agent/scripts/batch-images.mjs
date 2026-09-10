#!/usr/bin/env node
import { AGENT_ENDPOINTS, buildAgentJobResultPath } from './lib/agent-api-paths.mjs';
import { enrichFailureWithAgentDiagnostics } from './lib/agent-diagnostics-summary.mjs';
import {
    assertImageDimensions,
    buildDimensionCheckFailureBody,
    FAILURE_KIND_DIMENSION_CHECK,
    parseExpectedDimensions,
    sanitizeImageResponse
} from './lib/dimension-check.mjs';
import {
    PAGE_SSE_ENDPOINT,
    assertPageSseReady,
    buildPageSseFailureOutput,
    formatPageSseOutput,
    normalizeImageBackendForPage,
    postPageSse
} from './lib/page-sse-client.mjs';
import {
    attachSummary,
    buildFailureSummary as buildScriptFailureSummary,
    buildSuccessSummary,
    completeScriptTiming,
    startScriptTiming
} from './lib/script-summary.mjs';
import {
    errorMessage,
    assertValidImageSizeForModel,
    normalizeOutputFormat,
    readCapabilitiesImageTransportTimeoutMs,
    readConfiguredPositiveInteger,
    readMaxImageEdge,
    readOptionValue,
    readPartialImages,
    loadPrivateAgentEnvFile,
    resolveAgentToken,
    resolveConfiguredDefaultImageModel,
    resolvePlaygroundBaseUrl,
    resolveCapabilitiesDefaultImageModel,
    resolveSameOriginUrl,
    validateAgentEditRequestAgainstCapabilities,
    validateAgentGenerateRequestAgainstCapabilities
} from './lib/script-utils.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IMAGE_BACKENDS = new Set(['images-api', 'images', 'responses', 'responses-image-generation']);
const MODEL_PATTERN = /^[^\s]{1,200}$/;
const OUTPUT_FORMATS = new Set(['png', 'jpeg', 'webp']);
const DEFAULT_OUTPUT_FORMAT = 'webp';
const DEFAULT_OUTPUT_COMPRESSION = 100;
const QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const BACKGROUNDS = new Set(['transparent', 'opaque', 'auto']);
const MODERATIONS = new Set(['low', 'auto']);
const RESPONSE_MODES = new Set(['path', 'base64', 'both']);
const STREAM_MODES = new Set(['auto', 'stream', 'non_stream']);
const BATCH_TRANSPORTS = new Set(['page_sse', 'agent_json']);
const STREAMING_STRATEGIES = new Set([
    'off',
    'auto',
    'openai-sse',
    'newapi-keepalive-sse',
    'responses-sse',
    'force-sse'
]);
const MAX_EDIT_IMAGES = 10;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const DEFAULT_BATCH_MAX_ATTEMPTS = 1;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 0;
const DEFAULT_BATCH_CONCURRENCY = 1;
const DIMENSION_CHECK_URL_FIELDS = ['absolute_content_url', 'content_url', 'absolute_path', 'path'];
const GENERATE_ONLY_FIELDS = ['background'];
const PAGE_ADVANCED_FIELDS = [
    'output_format',
    'format',
    'output_compression',
    'moderation',
    'image_backend',
    'responsesModel',
    'gptModel',
    'gpt_model',
    'thinking',
    'promptOptimization',
    'prompt_optimization',
    'force_web',
    'forceWeb',
    'force_request',
    'forceRequest',
    'sse_log_path'
];
const EDIT_ONLY_FIELDS = ['image_path', 'image_paths', 'mask_path'];
const BOOLEAN_ROUTING_FIELDS = ['page_sse', 'complex_ui', 'long_image', 'resume_or_recover'];
const THINKING_VALUES = new Set(['minimal', 'none', 'low', 'medium', 'high', 'xhigh']);

const TASK_FIELDS = new Set([
    'id',
    'mode',
    'prompt',
    'idempotency_key',
    'model',
    'n',
    'size',
    'quality',
    'response_mode',
    'stream_mode',
    'streaming_strategy',
    'partial_images',
    'page_sse',
    'transport',
    'complex_ui',
    'long_image',
    'resume_or_recover',
    ...GENERATE_ONLY_FIELDS,
    ...PAGE_ADVANCED_FIELDS,
    ...EDIT_ONLY_FIELDS
]);

loadPrivateAgentEnvFile();
const DEFAULT_MODEL = resolveConfiguredDefaultImageModel();
const token = resolveAgentToken();
const passwordHash = process.env.GPT_IMAGE_APP_PASSWORD_HASH || '';

let options;
try {
    options = parseArgs(process.argv.slice(2));
} catch (error) {
    console.error(errorMessage(error));
    printUsage();
    process.exit(2);
}
if (options.help) {
    printUsage();
    process.exit(0);
}

let baseUrl;
let baseUrlInfo;
let tasks;
let timeoutMs;
let capabilities;
let capabilitiesPromise;
let runtimeCapabilities;
let runtimeCapabilitiesPromise;
try {
    if (!options.input) throw new Error('--input 需要 JSONL 文件路径。');
    baseUrlInfo = resolvePlaygroundBaseUrl(options.baseUrl, process.env);
    baseUrl = baseUrlInfo.baseUrl;
    timeoutMs = readConfiguredPositiveInteger(options.timeoutMs, '--timeout-ms', 420000);
    options.maxAttempts = readConfiguredPositiveInteger(
        options.maxAttempts ?? DEFAULT_BATCH_MAX_ATTEMPTS,
        '--max-attempts',
        DEFAULT_BATCH_MAX_ATTEMPTS
    );
    options.maxConsecutiveFailures = readNonNegativeInteger(
        options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
        '--max-consecutive-failures'
    );
    options.concurrency = readConfiguredPositiveInteger(
        options.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
        '--concurrency',
        DEFAULT_BATCH_CONCURRENCY
    );
    if (options.concurrency > 1 && options.maxConsecutiveFailures > 0) {
        throw new Error(
            '--concurrency 大于 1 时不能同时使用 --max-consecutive-failures；请使用 --concurrency 1 保持严格顺序熔断。'
        );
    }
    tasks = readJsonlTasks(options.input);
} catch (error) {
    console.error(errorMessage(error));
    process.exit(2);
}

const manifestPath = resolveManifestPath(options);
let planned;
try {
    planned = tasks.map((task, index) => normalizeTask(task, index, options));
} catch (error) {
    console.error(errorMessage(error));
    process.exit(2);
}

if (!options.allowBillable || options.dryRun) {
    console.log(
        JSON.stringify(
            {
                ok: true,
                billable: false,
                dry_run: true,
                verification_scope: buildDryRunVerificationScope(),
                input: options.input,
                manifest: manifestPath,
                manifest_written: false,
                manifest_write_reason: 'dry_run',
                total: planned.length,
                max_attempts: options.maxAttempts,
                max_consecutive_failures: options.maxConsecutiveFailures,
                concurrency: options.concurrency,
                guardrails: buildDryRunGuardrails(planned, options),
                tasks: planned.map((task) => {
                    const routing = buildTaskRouting(task);
                    return {
                        index: task.index,
                        id: task.id,
                        mode: task.mode,
                        idempotency_key: task.idempotencyKey,
                        endpoint: routing.endpoint,
                        routing,
                        request: buildDryRunRequestPreview(task, routing)
                    };
                }),
                next_step: '重新执行并添加 --allow-billable 才会发起真实批量请求。'
            },
            null,
            2
        )
    );
    process.exit(0);
}

if (!manifestPath) {
    console.error('--input - 真实执行必须显式设置 --manifest，避免无法续跑或审计。');
    process.exit(2);
}

try {
    const capacityFeedback = await resolveBatchCapacityFeedback();
    const completed = options.resume ? readCompletedManifestKeys(manifestPath) : new Set();
    const { results, failedTasks } = await runPlannedTasks(planned, completed, capacityFeedback.effective_concurrency);
    const failed = results.filter((result) => !result.ok).length;
    console.log(
        JSON.stringify(
            {
                ok: failed === 0,
                total: results.length,
                failed,
                manifest: manifestPath,
                max_attempts: options.maxAttempts,
                max_consecutive_failures: options.maxConsecutiveFailures,
                concurrency: capacityFeedback.effective_concurrency,
                requested_concurrency: capacityFeedback.requested_concurrency,
                effective_concurrency: capacityFeedback.effective_concurrency,
                capacity_feedback: capacityFeedback,
                failure_summary: buildFailureSummary(failedTasks),
                resume_fix_list: buildResumeFixList(failedTasks),
                results
            },
            null,
            2
        )
    );
    process.exit(failed === 0 ? 0 : 1);
} catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
}

function parseArgs(argv) {
    const parsed = {
        input: undefined,
        manifest: undefined,
        orderedPrefix: 'batch',
        timeoutMs: undefined,
        maxAttempts: undefined,
        maxConsecutiveFailures: undefined,
        concurrency: undefined,
        baseUrl: undefined,
        allowBillable: false,
        dryRun: false,
        resume: false,
        dimensionCheck: false,
        help: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--allow-billable') parsed.allowBillable = true;
        else if (arg === '--dry-run') parsed.dryRun = true;
        else if (arg === '--resume') parsed.resume = true;
        else if (arg === '--dimension-check') parsed.dimensionCheck = true;
        else if (arg === '--help' || arg === '-h') parsed.help = true;
        else if (arg === '--input') parsed.input = normalizeInputPath(readOptionValue(argv, (index += 1), arg));
        else if (arg === '--manifest') parsed.manifest = readOptionValue(argv, (index += 1), arg);
        else if (arg === '--ordered-prefix') parsed.orderedPrefix = readOptionValue(argv, (index += 1), arg);
        else if (arg === '--timeout-ms') parsed.timeoutMs = readOptionValue(argv, (index += 1), arg);
        else if (arg === '--base-url') parsed.baseUrl = readOptionValue(argv, (index += 1), arg);
        else if (arg === '--max-attempts') parsed.maxAttempts = readOptionValue(argv, (index += 1), arg);
        else if (arg === '--max-consecutive-failures') {
            parsed.maxConsecutiveFailures = readOptionValue(argv, (index += 1), arg);
        } else if (arg === '--concurrency') parsed.concurrency = readOptionValue(argv, (index += 1), arg);
        else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
        else if (!parsed.input) parsed.input = normalizeInputPath(arg);
        else throw new Error(`未知位置参数：${arg}`);
    }
    return parsed;
}

function normalizeInputPath(value) {
    return value === '-' ? '/dev/stdin' : value;
}

function resolveManifestPath(parsed) {
    if (parsed.manifest) return parsed.manifest;
    if (parsed.input === '/dev/stdin') return null;
    return `${parsed.input}.manifest.jsonl`;
}

function buildDryRunVerificationScope() {
    return {
        mode: 'local_planning_only',
        service_base_url: baseUrl,
        service_base_url_source: baseUrlInfo.source,
        interactive_confirmation_required: baseUrlInfo.interactive_confirmation_required,
        remote_capabilities_verified: false,
        runtime_capacity_verified: false,
        auth_verified: false,
        billable_request_sent: false,
        note: 'Dry-run validates JSONL parsing, idempotency keys, request previews and static routing only; run with --allow-billable to verify remote capabilities, capacity and auth.'
    };
}

function readJsonlTasks(filePath) {
    const input = filePath === '/dev/stdin' ? 0 : filePath;
    return fs
        .readFileSync(input, 'utf8')
        .split(/\r?\n/)
        .map((line, index) => ({ line: line.trim(), index }))
        .filter((item) => item.line && !item.line.startsWith('#'))
        .map((item) => {
            try {
                return JSON.parse(item.line);
            } catch (error) {
                throw new Error(`${filePath}:${item.index + 1} 不是有效 JSON：${errorMessage(error)}`);
            }
        });
}

function normalizeTask(raw, index, parsedOptions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`第 ${index + 1} 行必须是 JSON 对象。`);
    }
    const mode = normalizeMode(raw.mode, index);
    const id = normalizeTaskId(raw.id, mode, index);
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
        throw new Error(`${id} 缺少 prompt。`);
    }
    validateTaskFields(raw, id, mode);
    validateTaskSize(raw, id, mode, parsedOptions.dimensionCheck);
    validateTaskRoutingFields(raw, id, mode);
    if (mode === 'edit') validateEditImages(raw, id);
    return {
        id,
        index,
        mode,
        raw,
        idempotencyKey: normalizeIdempotencyKey(raw.idempotency_key, parsedOptions.orderedPrefix, index, id)
    };
}

function normalizeTaskId(value, mode, index) {
    if (value === undefined || value === null || value === '') return `${mode}-${index + 1}`;
    return String(value);
}

function normalizeMode(value, index) {
    if (value === undefined || value === null || value === '' || value === 'generate') return 'generate';
    if (value === 'edit') return 'edit';
    throw new Error(`第 ${index + 1} 行 mode 必须是 generate 或 edit。`);
}

function normalizeIdempotencyKey(value, orderedPrefix, index, id) {
    if (value === undefined || value === null || value === '') return buildOrderedKey(orderedPrefix, index, id);
    if (typeof value !== 'string') throw new Error(`${id} idempotency_key 必须是字符串。`);
    return value;
}

function validateTaskSize(raw, id, mode, dimensionCheck) {
    if (raw.size !== undefined) {
        assertValidImageSizeForModel(raw.size, raw.model || DEFAULT_MODEL, `${id}.size`);
    }
    if (!dimensionCheck) return;
    const size = raw.size || (mode === 'generate' ? '1024x1024' : undefined);
    if (!parseExpectedSize(size)) {
        throw new Error(`${id} --dimension-check 需要 size 为 WIDTHxHEIGHT。`);
    }
}

function validateEditImages(raw, id) {
    const imagePaths = readEditImagePaths(raw, id);
    if (imagePaths.length === 0) throw new Error(`${id} edit 任务必须提供 image_path 或 image_paths。`);
    if (imagePaths.length > MAX_EDIT_IMAGES) throw new Error(`${id} edit 任务最多支持 ${MAX_EDIT_IMAGES} 张源图。`);
    if (hasOwn(raw, 'mask_path')) readNonEmptyString(raw.mask_path, `${id}.mask_path`);
}

function validateTaskFields(raw, id, mode) {
    validateKnownTaskFields(raw, id);
    validateModeSpecificFields(raw, id, mode);
    validateRoutingControlFields(raw, id, mode);
    validateAmbiguousAliasFields(raw, id);
    if (hasOwn(raw, 'model')) {
        if (typeof raw.model !== 'string' || !MODEL_PATTERN.test(raw.model)) {
            throw new Error(`${id}.model 必须是 1 到 200 个字符且不能包含空白。`);
        }
    }
    if (raw.n !== undefined) readConfiguredPositiveInteger(raw.n, `${id}.n`, 1);
    if (hasOwn(raw, 'quality')) normalizeEnumValue(raw.quality, QUALITIES, `${id}.quality`);
    if (hasOwn(raw, 'response_mode')) normalizeEnumValue(raw.response_mode, RESPONSE_MODES, `${id}.response_mode`);
    if (hasOwn(raw, 'image_backend')) normalizeEnumValue(raw.image_backend, IMAGE_BACKENDS, `${id}.image_backend`);
    if (hasOwn(raw, 'background')) normalizeEnumValue(raw.background, BACKGROUNDS, `${id}.background`);
    if (hasOwn(raw, 'moderation')) normalizeEnumValue(raw.moderation, MODERATIONS, `${id}.moderation`);
    if (hasOwn(raw, 'thinking')) normalizeEnumValue(raw.thinking, THINKING_VALUES, `${id}.thinking`);
    readPromptOptimization(raw, id);
    if (hasOwn(raw, 'force_web')) readBooleanAlias(raw.force_web, `${id}.force_web`);
    if (hasOwn(raw, 'forceWeb')) readBooleanAlias(raw.forceWeb, `${id}.forceWeb`);
    if (hasOwn(raw, 'force_request')) readBooleanAlias(raw.force_request, `${id}.force_request`);
    if (hasOwn(raw, 'forceRequest')) readBooleanAlias(raw.forceRequest, `${id}.forceRequest`);
    if (hasOwn(raw, 'sse_log_path')) readNonEmptyString(raw.sse_log_path, `${id}.sse_log_path`);
    validateResponsesModelField(raw, id);
    if (hasOwn(raw, 'stream_mode')) normalizeEnumValue(raw.stream_mode, STREAM_MODES, `${id}.stream_mode`);
    if (hasOwn(raw, 'streaming_strategy')) {
        normalizeEnumValue(raw.streaming_strategy, STREAMING_STRATEGIES, `${id}.streaming_strategy`);
    }
    if (hasOwn(raw, 'partial_images')) readPartialImages(raw.partial_images, `${id}.partial_images`);
    if (hasOwn(raw, 'output_format') || hasOwn(raw, 'format')) {
        normalizeEnumValue(readOutputFormatField(raw, id), OUTPUT_FORMATS, `${id}.output_format`);
    }
    validateOutputCompression(raw, id);
}

function validateAmbiguousAliasFields(raw, id) {
    if (hasOwn(raw, 'output_format') && hasOwn(raw, 'format')) {
        throw new Error(`${id}.output_format 与 format 不能同时设置。`);
    }
    if (hasOwn(raw, 'image_path') && hasOwn(raw, 'image_paths')) {
        throw new Error(`${id}.image_path 与 image_paths 不能同时设置。`);
    }
}

function validateKnownTaskFields(raw, id) {
    for (const field of Object.keys(raw)) {
        if (!TASK_FIELDS.has(field)) {
            throw new Error(`${id}.${field} 不是支持的 batch JSONL 字段。`);
        }
    }
}

function validateModeSpecificFields(raw, id, mode) {
    const fields = mode === 'edit' ? GENERATE_ONLY_FIELDS : EDIT_ONLY_FIELDS;
    const expectedMode = mode === 'edit' ? 'generate' : 'edit';
    for (const field of fields) {
        if (hasOwn(raw, field)) {
            throw new Error(`${id}.${modeSpecificFieldLabel(field)} 仅适用于 ${expectedMode} 任务。`);
        }
    }
}

function modeSpecificFieldLabel(field) {
    return field === 'format' ? 'output_format' : field;
}

function validateRoutingControlFields(raw, id, mode) {
    for (const field of BOOLEAN_ROUTING_FIELDS) {
        if (hasOwn(raw, field) && typeof raw[field] !== 'boolean') {
            throw new Error(`${id}.${field} 必须是布尔值。`);
        }
    }
    if (hasOwn(raw, 'transport')) {
        if (!BATCH_TRANSPORTS.has(raw.transport)) {
            throw new Error(`${id}.transport 必须是 page_sse 或 agent_json。`);
        }
        if (raw.transport === 'agent_json' && mode !== 'edit') {
            throw new Error(`${id}.transport=agent_json 仅适用于 edit 任务。`);
        }
        if (raw.transport === 'agent_json' && raw.page_sse === true) {
            throw new Error(`${id}.transport=agent_json 不能同时设置 page_sse=true。`);
        }
        if (raw.transport === 'agent_json') {
            const unsupportedFields = PAGE_ADVANCED_FIELDS.filter((field) => hasOwn(raw, field));
            if (unsupportedFields.length > 0) {
                throw new Error(
                    `${id}.transport=agent_json 不支持页面 SSE 高级字段：${unsupportedFields.join(', ')}。`
                );
            }
        }
    }
}

function validateOutputCompression(raw, id) {
    readOutputCompression(raw, id);
}

function validateResponsesModelField(raw, id) {
    const responsesModel = readResponsesModel(raw, id);
    if (!responsesModel) return;
    if (!hasOwn(raw, 'image_backend')) {
        throw new Error(`${id}.responsesModel 必须同时设置 image_backend=responses-image-generation。`);
    }
    const imageBackend = normalizeEnumValue(raw.image_backend, IMAGE_BACKENDS, `${id}.image_backend`);
    if (imageBackend !== 'responses-image-generation' && imageBackend !== 'responses') {
        throw new Error(`${id}.responsesModel 仅适用于 image_backend=responses-image-generation。`);
    }
}

function readResponsesModel(raw, id) {
    const fields = ['responsesModel', 'gptModel', 'gpt_model'];
    const present = fields.filter((field) => hasOwn(raw, field));
    if (present.length === 0) return undefined;
    if (present.length > 1) throw new Error(`${id}.responsesModel、gptModel 与 gpt_model 不能同时设置。`);
    return readNonEmptyString(raw[present[0]], `${id}.${present[0]}`);
}

function readPromptOptimization(raw, id) {
    const fields = ['promptOptimization', 'prompt_optimization'];
    const present = fields.filter((field) => hasOwn(raw, field));
    if (present.length === 0) return undefined;
    if (present.length > 1) throw new Error(`${id}.promptOptimization 与 prompt_optimization 不能同时设置。`);
    return readBooleanAlias(raw[present[0]], `${id}.${present[0]}`);
}

function readForceWeb(raw, id) {
    const fields = ['force_web', 'forceWeb'];
    const present = fields.filter((field) => hasOwn(raw, field));
    if (present.length === 0) return undefined;
    if (present.length > 1) throw new Error(`${id}.force_web 与 forceWeb 不能同时设置。`);
    return readBooleanAlias(raw[present[0]], `${id}.${present[0]}`);
}

function readForceRequest(raw, id) {
    const fields = ['force_request', 'forceRequest'];
    const present = fields.filter((field) => hasOwn(raw, field));
    if (present.length === 0) return undefined;
    if (present.length > 1) throw new Error(`${id}.force_request 与 forceRequest 不能同时设置。`);
    return readBooleanAlias(raw[present[0]], `${id}.${present[0]}`);
}

function readBooleanAlias(value, name) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${name} 必须是布尔值。`);
}

function readOutputCompression(raw, id) {
    const outputFormat =
        hasOwn(raw, 'output_format') || hasOwn(raw, 'format') ? readOutputFormatField(raw, id) : DEFAULT_OUTPUT_FORMAT;
    if (outputFormat === 'png') {
        return undefined;
    }
    const value = hasOwn(raw, 'output_compression') ? raw.output_compression : DEFAULT_OUTPUT_COMPRESSION;
    const parsed =
        typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
        throw new Error(`${id}.output_compression 必须是 0 到 100 之间的整数。`);
    }
    return parsed;
}

function readTaskNormalizations(raw, id) {
    if (!hasOwn(raw, 'output_compression')) return undefined;
    const outputFormat =
        hasOwn(raw, 'output_format') || hasOwn(raw, 'format') ? readOutputFormatField(raw, id) : DEFAULT_OUTPUT_FORMAT;
    if (outputFormat !== 'png') return undefined;
    return { output_compression_ignored_for_png: true };
}

function readOutputFormatField(raw, id) {
    const value = raw.output_format ?? raw.format;
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${id}.output_format 必须是字符串。`);
    }
    return normalizeOutputFormat(value);
}

function validateTaskRoutingFields(raw, id, mode) {
    if (
        (raw.page_sse === true || raw.transport === 'page_sse') &&
        (raw.stream_mode === 'non_stream' || raw.streaming_strategy === 'off')
    ) {
        throw new Error(`${id} stream_mode=non_stream 或 streaming_strategy=off 时不能强制使用页面 SSE。`);
    }
    if (hasOwn(raw, 'sse_log_path') && (raw.stream_mode === 'non_stream' || raw.streaming_strategy === 'off')) {
        throw new Error(
            `${id}.sse_log_path 需要页面 SSE 路径，不能同时设置 stream_mode=non_stream 或 streaming_strategy=off。`
        );
    }
    if (
        hasPageAdvancedFields(raw) &&
        (raw.stream_mode === 'non_stream' || raw.streaming_strategy === 'off') &&
        mode === 'edit'
    ) {
        throw new Error(
            `${id} 图生图高级参数需要页面 SSE，不能同时设置 stream_mode=non_stream 或 streaming_strategy=off。`
        );
    }
    if (
        mode === 'edit' &&
        raw.transport !== 'agent_json' &&
        (raw.stream_mode === 'non_stream' || raw.streaming_strategy === 'off')
    ) {
        throw new Error(
            `${id} 默认 WebP edit 任务需要页面 SSE；若要使用 Agent JSON 固定输出，请在该 JSONL 任务中显式设置 transport=agent_json。`
        );
    }
}

function hasPageAdvancedFields(raw) {
    return PAGE_ADVANCED_FIELDS.some((field) => hasOwn(raw, field));
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function readEditImagePaths(raw, id = 'edit') {
    if (Array.isArray(raw.image_paths)) {
        if (raw.image_paths.length === 0) throw new Error(`${id}.image_paths 必须是非空字符串数组。`);
        return raw.image_paths.map((value, index) => readNonEmptyString(value, `${id}.image_paths[${index}]`));
    }
    if (hasOwn(raw, 'image_paths')) throw new Error(`${id}.image_paths 必须是非空字符串数组。`);
    if (hasOwn(raw, 'image_path')) return [readNonEmptyString(raw.image_path, `${id}.image_path`)];
    return [];
}

function readNonEmptyString(value, name) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${name} 必须是非空字符串。`);
    }
    return value;
}

function buildOrderedKey(prefix, index, id) {
    const safePrefix = sanitizeKeyPart(prefix || 'batch');
    const safeId = sanitizeKeyPart(id || `item-${index + 1}`);
    return `${safePrefix}-${String(index + 1).padStart(4, '0')}-${safeId}`.slice(0, 200);
}

function sanitizeKeyPart(value) {
    return (
        String(value)
            .trim()
            .replace(/[^A-Za-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'item'
    );
}

function authHeaders() {
    if (token) return { Authorization: `Bearer ${token}` };
    if (passwordHash) return { 'X-App-Password-Hash': passwordHash };
    return {};
}

async function readCapabilities() {
    const { response, result, text } = await fetchJson(`${baseUrl}${AGENT_ENDPOINTS.capabilities}`, {
        headers: authHeaders()
    });
    if (!response.ok) throw new Error(`capabilities 请求失败，状态码 ${response.status}：${text}`);
    return result;
}

async function readRuntimeCapabilities() {
    const { response, result, text } = await fetchJson(`${baseUrl}/api/runtime-capabilities`, {
        headers: authHeaders()
    });
    if (!response.ok) throw new Error(`runtime-capabilities 请求失败，状态码 ${response.status}：${text}`);
    return result;
}

async function ensureCapabilities() {
    if (capabilities) return capabilities;
    capabilitiesPromise ??= readCapabilities();
    try {
        capabilities = await capabilitiesPromise;
        if (options.timeoutMs === undefined) {
            timeoutMs = readCapabilitiesImageTransportTimeoutMs(capabilities, timeoutMs);
        }
    } catch (error) {
        capabilitiesPromise = undefined;
        throw error;
    }
    return capabilities;
}

async function ensureRuntimeCapabilities() {
    if (runtimeCapabilities) return runtimeCapabilities;
    runtimeCapabilitiesPromise ??= readRuntimeCapabilities();
    try {
        runtimeCapabilities = await runtimeCapabilitiesPromise;
    } catch (error) {
        runtimeCapabilitiesPromise = undefined;
        throw error;
    }
    return runtimeCapabilities;
}

async function resolveBatchCapacityFeedback() {
    const requested = options.concurrency;
    if (requested <= 1) {
        return {
            queue_policy: 'single_worker_no_runtime_capacity_probe',
            requested_concurrency: requested,
            effective_concurrency: requested,
            adjusted: false
        };
    }
    let runtime;
    try {
        runtime = await ensureRuntimeCapabilities();
    } catch (error) {
        return {
            queue_policy: 'runtime_capabilities_unavailable',
            requested_concurrency: requested,
            effective_concurrency: requested,
            adjusted: false,
            warning: errorMessage(error)
        };
    }
    const recommended = readRuntimeRecommendedConcurrency(runtime);
    if (recommended < 1) {
        throw new Error('服务端当前没有可用的健康渠道凭证，不能发起真实批量请求。');
    }
    const effective = Math.min(requested, recommended);
    return {
        queue_policy: 'client_worker_limited_by_runtime_capabilities',
        requested_concurrency: requested,
        effective_concurrency: effective,
        recommended_concurrency: recommended,
        adjusted: effective !== requested,
        channel_queue: readRuntimeChannelQueueSummary(runtime)
    };
}

function readRuntimeRecommendedConcurrency(runtime) {
    const value = runtime?.streamingBatch?.recommendedConcurrency;
    if (Number.isInteger(value) && value >= 0) return value;
    const queueCapacity = runtime?.channelQueue?.capacityPerCredential;
    if (Number.isInteger(queueCapacity) && queueCapacity > 0) return queueCapacity;
    return options.concurrency;
}

function readRuntimeChannelQueueSummary(runtime) {
    const queue = runtime?.channelQueue;
    if (!queue || typeof queue !== 'object') return undefined;
    return {
        enabled: Boolean(queue.enabled),
        capacity_per_credential: Number.isInteger(queue.capacityPerCredential)
            ? queue.capacityPerCredential
            : undefined,
        max_wait_ms: Number.isInteger(queue.maxWaitMs) ? queue.maxWaitMs : undefined,
        max_size: Number.isInteger(queue.maxSize) ? queue.maxSize : undefined,
        active: Number.isInteger(queue.active) ? queue.active : undefined,
        queued: Number.isInteger(queue.queued) ? queue.queued : undefined
    };
}

async function runTask(task) {
    const routing = buildTaskRouting(task);
    const taskTiming = startScriptTiming();
    try {
        const usesPageSse = routing.transport === 'page_sse';
        let response = usesPageSse
            ? await postPageSseTask(task, routing)
            : task.mode === 'edit'
              ? await postEditTask(task)
              : await postGenerateTask(task);
        if (options.dimensionCheck) {
            response = await assertDimensions(
                task,
                usesPageSse ? formatPageSseTaskDimensionCheckInput(task, response) : response
            );
        }
        if (usesPageSse) response = formatPageSseTaskOutput(task, response);
        const summary = buildSuccessSummary({
            result: response,
            routing,
            timing: completeScriptTiming(taskTiming),
            idempotencyKey: task.idempotencyKey
        });
        const output = {
            ok: true,
            status: 'succeeded',
            id: task.id,
            idempotency_key: task.idempotencyKey,
            routing,
            response,
            summary
        };
        appendManifest(manifestPath, {
            ...baseManifestEntry(task),
            status: 'succeeded',
            routing,
            response: sanitizeImageResponse(response),
            summary
        });
        return output;
    } catch (error) {
        const failure = buildTaskFailureOutput(error, routing);
        const summary = buildScriptFailureSummary({
            errorBody: failure,
            routing: failure.routing || routing,
            timing: completeScriptTiming(taskTiming),
            idempotencyKey: task.idempotencyKey,
            billable: failure.billable !== false,
            nextAction: failure.next_step
        });
        const failureOutput = {
            ok: false,
            status: 'failed',
            id: task.id,
            idempotency_key: task.idempotencyKey,
            ...failure,
            summary
        };
        const enriched = shouldEnrichAgentFailure(failure)
            ? await enrichFailureWithAgentDiagnostics({
                  baseUrl,
                  authHeaders,
                  idempotencyKey: task.idempotencyKey,
                  failureOutput,
                  summary,
                  timeoutMs
              })
            : { failureOutput, summary };
        const output = attachSummary(enriched.failureOutput, enriched.summary);
        appendManifest(manifestPath, {
            ...baseManifestEntry(task),
            status: 'failed',
            ...failure,
            ...(enriched.failureOutput.agent_failure_diagnostics
                ? { agent_failure_diagnostics: enriched.failureOutput.agent_failure_diagnostics }
                : {}),
            summary: enriched.summary
        });
        return output;
    }
}

async function runTaskWithAttempts(task) {
    let lastResult;
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
        const attemptTask = buildAttemptTask(task, attempt);
        const result = await runTask(attemptTask);
        lastResult = addAttemptMetadata(result, task, attempt);
        if (result.ok) return lastResult;
    }
    return lastResult;
}

async function runPlannedTasks(plannedTasks, completed, effectiveConcurrency) {
    const results = new Array(plannedTasks.length);
    const failedTasks = [];
    let consecutiveFailures = 0;
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < plannedTasks.length) {
            const index = nextIndex;
            nextIndex += 1;
            const task = plannedTasks[index];

            if (completed.has(task.idempotencyKey) || completed.has(task.id)) {
                results[index] = handleResumeSkippedTask(task);
                continue;
            }

            if (options.maxConsecutiveFailures > 0 && consecutiveFailures >= options.maxConsecutiveFailures) {
                results[index] = handleCircuitBreakerSkippedTask(task, consecutiveFailures);
                continue;
            }

            const result = await runTaskWithAttempts(task);
            results[index] = result;
            if (result.ok) {
                consecutiveFailures = 0;
            } else {
                consecutiveFailures += 1;
                failedTasks.push(buildFailedTaskSummary(result, task));
            }
        }
    }

    const workerCount = Math.min(effectiveConcurrency, plannedTasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    failedTasks.sort((left, right) => left.index - right.index);
    return { results, failedTasks };
}

function handleResumeSkippedTask(task) {
    const skipped = {
        ok: true,
        status: 'skipped',
        id: task.id,
        idempotency_key: task.idempotencyKey,
        billable: false,
        skipped_reason: 'resume'
    };
    appendManifest(manifestPath, {
        ...baseManifestEntry(task),
        status: 'skipped',
        billable: false,
        skipped_reason: 'resume'
    });
    return skipped;
}

function handleCircuitBreakerSkippedTask(task, consecutiveFailures) {
    const skipped = buildCircuitBreakerSkippedTask(task, consecutiveFailures);
    appendManifest(manifestPath, { ...baseManifestEntry(task), ...skipped });
    return { ok: true, id: task.id, idempotency_key: task.idempotencyKey, ...skipped };
}

function buildAttemptTask(task, attempt) {
    if (attempt === 1) return { ...task, attempt, rootIdempotencyKey: task.idempotencyKey };
    return {
        ...task,
        attempt,
        rootIdempotencyKey: task.idempotencyKey,
        idempotencyKey: buildAttemptIdempotencyKey(task.idempotencyKey, attempt)
    };
}

function buildAttemptIdempotencyKey(idempotencyKey, attempt) {
    const suffix = `-attempt-${attempt}`;
    if (idempotencyKey.length + suffix.length <= MAX_IDEMPOTENCY_KEY_LENGTH) {
        return `${idempotencyKey}${suffix}`;
    }
    const digest = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12);
    const hashedSuffix = `-${digest}${suffix}`;
    return `${idempotencyKey.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH - hashedSuffix.length)}${hashedSuffix}`;
}

function addAttemptMetadata(result, rootTask, attempt) {
    return {
        ...result,
        attempt,
        max_attempts: options.maxAttempts,
        ...(attempt > 1 ? { root_idempotency_key: rootTask.idempotencyKey } : {})
    };
}

function buildTaskFailureOutput(error, routing) {
    if (error?.pageSseFailure && typeof error.pageSseFailure === 'object') {
        return {
            billable: error.pageSseFailure.billable,
            error: error.pageSseFailure.error,
            routing: error.pageSseFailure.routing || routing,
            next_step: error.pageSseFailure.next_step
        };
    }
    if (error?.code === 'dimension_check_failed') {
        return buildDimensionCheckFailureBody(error, routing);
    }
    return {
        ...(error?.billable === false ? { billable: false } : {}),
        error: errorMessage(error),
        routing,
        ...(typeof error?.nextStep === 'string' ? { next_step: error.nextStep } : {})
    };
}

function shouldEnrichAgentFailure(failure) {
    return (
        failure.billable !== false &&
        failure.routing?.transport !== 'page_sse' &&
        failure.validation_failure_kind !== FAILURE_KIND_DIMENSION_CHECK
    );
}

function buildCircuitBreakerSkippedTask(task, consecutiveFailures) {
    return {
        status: 'skipped',
        billable: false,
        skipped_reason: 'max_consecutive_failures',
        consecutive_failures: consecutiveFailures,
        next_step: '先处理 failure_summary 中的失败任务，再用 --resume 续跑剩余任务。'
    };
}

function buildDryRunGuardrails(plannedTasks, parsedOptions) {
    const hasExplicitFixedSize = plannedTasks.some((task) => {
        const size = task.raw?.size;
        return typeof size === 'string' && size !== 'auto';
    });
    return {
        ordered_prefix: parsedOptions.orderedPrefix,
        repeat_ordered_prefix_on_real_run: true,
        dimension_check_recommended: hasExplicitFixedSize && !parsedOptions.dimensionCheck,
        dimension_check_reason:
            hasExplicitFixedSize && !parsedOptions.dimensionCheck
                ? '输入包含固定尺寸；真实上游可能返回非请求尺寸，尺寸敏感任务应添加 --dimension-check。'
                : null
    };
}

function buildFailedTaskSummary(result, task) {
    const error = normalizeFailureError(result.error);
    return {
        index: task.index,
        id: task.id,
        idempotency_key: task.idempotencyKey,
        attempt: result.attempt,
        route: result.routing?.transport,
        endpoint: result.routing?.endpoint,
        billable: result.billable !== false,
        failure_kind: readFailureKind(result),
        code: error.code,
        message: error.message,
        artifact_ids: Array.isArray(result.summary?.artifact_ids) ? result.summary.artifact_ids : [],
        content_urls: Array.isArray(result.summary?.content_urls) ? result.summary.content_urls : [],
        absolute_content_urls: Array.isArray(result.summary?.absolute_content_urls)
            ? result.summary.absolute_content_urls
            : [],
        next_step: result.next_step || buildFailureNextStep(error)
    };
}

function readFailureKind(result) {
    if (typeof result?.validation_failure_kind === 'string') return result.validation_failure_kind;
    return 'request_failed';
}

function normalizeFailureError(error) {
    if (error && typeof error === 'object') {
        return {
            code: typeof error.code === 'string' ? error.code : 'batch_task_failed',
            message: typeof error.message === 'string' ? error.message : JSON.stringify(error)
        };
    }
    return { code: 'batch_task_failed', message: String(error || '任务失败。') };
}

function buildFailureNextStep(error) {
    if (error.code === 'page_sse_request_rejected')
        return '修正请求参数或鉴权后，使用新的 Idempotency-Key 重试失败任务。';
    if (error.code === 'page_sse_unavailable')
        return '补齐 page_sse capability，或用新的 Idempotency-Key 改走服务端编排或显式诊断路径。';
    return '诊断失败原因后，用新的 Idempotency-Key 重试失败任务；不要复用终态失败 key。';
}

function buildFailureSummary(failedTasks) {
    return {
        count: failedTasks.length,
        billable_count: failedTasks.filter((task) => task.billable).length,
        non_billable_count: failedTasks.filter((task) => !task.billable).length,
        validation_failure_count: failedTasks.filter((task) => task.failure_kind === FAILURE_KIND_DIMENSION_CHECK)
            .length,
        request_failure_count: failedTasks.filter((task) => task.failure_kind !== FAILURE_KIND_DIMENSION_CHECK).length,
        tasks: failedTasks
    };
}

function buildResumeFixList(failedTasks) {
    return failedTasks.map((task) => ({
        id: task.id,
        previous_idempotency_key: task.idempotency_key,
        suggested_idempotency_key: buildAttemptIdempotencyKey(task.idempotency_key, (task.attempt || 1) + 1),
        route: task.route,
        next_step: task.next_step
    }));
}

function buildTaskRouting(task) {
    if (shouldUsePageSseForTask(task)) {
        const reason = buildPageSseRoutingReason(task);
        return {
            endpoint: PAGE_SSE_ENDPOINT,
            transport: 'page_sse',
            strength: task.mode === 'edit' && readTaskMaxEdge(task) > 2048 ? 'default' : 'recommended',
            fallback_endpoint: task.mode === 'edit' ? AGENT_ENDPOINTS.edit : AGENT_ENDPOINTS.create_image_request,
            fallback_mode: 'manual_after_diagnosis',
            reason
        };
    }
    if (task.mode === 'generate') {
        return {
            endpoint: AGENT_ENDPOINTS.create_image_request,
            transport: 'server_orchestrated',
            strength: 'default',
            route_mode: 'job',
            result_mode: 'job_polling',
            reason: 'Batch generate tasks submit intent to the server orchestration endpoint; the service owns internal route selection.'
        };
    }
    return {
        endpoint: AGENT_ENDPOINTS.edit,
        transport: 'agent_json',
        strength: 'default',
        reason: 'Agent JSON-compatible batch edit tasks use the Agent response contract.'
    };
}

function buildPageSseRoutingReason(task) {
    if (task.raw.sse_log_path) {
        return 'Task requested raw SSE event logging, so it uses page form-data SSE for observable diagnostics.';
    }
    if (task.mode === 'edit' && hasPageAdvancedFields(task.raw)) {
        return 'GPT2Image-compatible edit options require page form-data SSE; Agent JSON edit does not accept those fields.';
    }
    if (task.mode === 'edit') {
        return 'Default WebP edit output uses page form-data SSE; Agent JSON edit has a fixed output contract.';
    }
    if (task.mode === 'edit' && readTaskMaxEdge(task) > 2048) {
        return 'High-resolution edit defaults to page form-data SSE; fall back explicitly after diagnosis if streaming has issues.';
    }
    return 'Large or complex batch image tasks should use page form-data SSE for observability and recovery.';
}

function buildDryRunRequestPreview(task, routing) {
    if (routing.transport === 'page_sse') return buildPageSseRequestPreview(task);
    if (task.mode === 'edit') return buildAgentEditRequestPreview(task.raw);
    return buildGenerateBody(task.raw);
}

function buildAgentEditRequestPreview(raw) {
    validateEditStrategyFields(raw);
    const preview = {};
    const fields = [
        'prompt',
        'model',
        'n',
        'size',
        'quality',
        'response_mode',
        'stream_mode',
        'streaming_strategy',
        'partial_images'
    ];
    for (const field of fields) {
        if (raw[field] !== undefined) preview[field] = raw[field];
    }
    if (!raw.model) preview.model = DEFAULT_MODEL;
    if (!raw.response_mode) preview.response_mode = 'path';
    preview.image_fields = readEditImagePaths(raw, String(raw.id || 'edit')).map((_, index) => `image_${index}`);
    if (raw.mask_path) preview.mask = 'provided';
    return preview;
}

function buildPageSseRequestPreview(task) {
    const raw = task.raw;
    const preview = {
        mode: task.mode,
        prompt: raw.prompt,
        model: raw.model || DEFAULT_MODEL,
        size: raw.size || (task.mode === 'generate' ? '1024x1024' : 'auto'),
        quality: raw.quality || (task.mode === 'generate' ? 'high' : 'auto'),
        response_mode: readResponseMode(raw),
        clientRequestId: task.idempotencyKey
    };
    if (raw.n !== undefined) preview.n = readConfiguredPositiveInteger(raw.n, `${task.id}.n`, 1);
    if (raw.stream_mode) preview.stream_mode = String(raw.stream_mode);
    if (raw.streaming_strategy) preview.image_streaming_strategy = String(raw.streaming_strategy);
    if (raw.partial_images !== undefined)
        preview.partial_images = readPartialImages(raw.partial_images, `${task.id}.partial_images`);
    if (raw.image_backend) preview.image_backend = normalizeImageBackendForPage(String(raw.image_backend));
    if (readResponsesModel(raw, task.id)) preview.responsesModel = readResponsesModel(raw, task.id);
    if (raw.thinking) preview.thinking = String(raw.thinking);
    if (readPromptOptimization(raw, task.id) !== undefined)
        preview.promptOptimization = readPromptOptimization(raw, task.id);
    if (readForceWeb(raw, task.id) !== undefined) preview.force_web = readForceWeb(raw, task.id);
    if (readForceRequest(raw, task.id) !== undefined) preview.force_request = readForceRequest(raw, task.id);
    if (raw.sse_log_path) preview.sse_log_path = readNonEmptyString(raw.sse_log_path, `${task.id}.sse_log_path`);
    if (raw.background) preview.background = String(raw.background);
    if (raw.moderation) preview.moderation = String(raw.moderation);
    if (readOutputCompression(raw, task.id) !== undefined)
        preview.output_compression = readOutputCompression(raw, task.id);
    if (readTaskNormalizations(raw, task.id)) preview.normalizations = readTaskNormalizations(raw, task.id);
    if (task.mode === 'edit') {
        preview.image_fields = readEditImagePaths(raw, task.id).map((_, index) => `image_${index}`);
        if (raw.mask_path) preview.mask = 'provided';
    }
    preview.output_format = readOutputFormat(raw);
    return preview;
}

function shouldUsePageSseForTask(task) {
    const pageSseAllowed = isPageSseAllowedForTask(task);
    if (task.raw.transport === 'agent_json') return false;
    if (task.raw.page_sse === true || task.raw.transport === 'page_sse') {
        if (!pageSseAllowed) {
            throw new Error(`${task.id} stream_mode=non_stream 或 streaming_strategy=off 时不能强制使用页面 SSE。`);
        }
        return true;
    }
    if (!pageSseAllowed) return false;
    if (task.raw.complex_ui === true || task.raw.long_image === true || task.raw.resume_or_recover === true)
        return true;
    if (task.raw.sse_log_path) return true;
    if (task.mode === 'edit' && hasPageAdvancedFields(task.raw)) return true;
    if (task.mode === 'edit') return true;
    if (task.mode === 'edit' && readTaskMaxEdge(task) > 2048) return true;
    return false;
}

function isPageSseAllowedForTask(task) {
    return task.raw.streaming_strategy !== 'off' && task.raw.stream_mode !== 'non_stream';
}

async function postGenerateTask(task) {
    const taskCapabilities = await ensureCapabilities();
    const body = buildGenerateBody(task.raw, resolveTaskModel(task.raw, taskCapabilities));
    validateLocalRequest(() => validateResolvedTaskSize(task.raw, body.model, task.id));
    validateLocalRequest(() =>
        validateAgentGenerateRequestAgainstCapabilities(
            {
                n: body.n,
                ...(body.partial_images === undefined ? {} : { partial_images: body.partial_images }),
                image_backend: body.image_backend,
                stream_mode: body.stream_mode,
                streaming_strategy: body.streaming_strategy,
                model: body.model,
                size: body.size,
                background: body.background,
                force_request: body.force_request
            },
            taskCapabilities
        )
    );
    const { response, result, text } = await fetchJson(`${baseUrl}${AGENT_ENDPOINTS.create_image_request}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': task.idempotencyKey, ...authHeaders() },
        body: JSON.stringify(body)
    });
    if (!response.ok)
        throw new Error(readErrorMessage(result) || `generate 请求失败，状态码 ${response.status}：${text}`);
    if (!result?.job) return enrichImageUrls(result);
    return pollJobResult(result.job);
}

async function pollJobResult(job) {
    if (!job || typeof job.id !== 'string') {
        throw new Error('创建 job 的响应缺少 job.id。');
    }
    const resultUrl = resolveSameOriginUrl(
        baseUrl,
        job.result_url || buildAgentJobResultPath(job.id),
        'job.result_url'
    );
    const deadlineMs = Date.now() + timeoutMs;
    let lastResult;

    while (Date.now() < deadlineMs) {
        const { response, result, text } = await fetchJson(resultUrl, {
            headers: authHeaders()
        });
        if (response.ok) return enrichImageUrls(result);
        lastResult = result;
        if (result?.error?.code !== 'request_in_progress' || result?.error?.retryable !== true) {
            throw new Error(readErrorMessage(result) || `job result 请求失败，状态码 ${response.status}：${text}`);
        }
        await sleep(readJobRetryAfterSeconds(result, job));
    }

    throw new Error(readErrorMessage(lastResult) || '等待 job result 超时。');
}

function readJobRetryAfterSeconds(result, job) {
    const value = result?.retry_after ?? result?.error?.retry_after_seconds ?? job?.retry_after_seconds;
    return readRetryAfterSeconds(value);
}

function readRetryAfterSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.min(value, 30);
    if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return Math.min(Number(value), 30);
    return 1;
}

async function sleep(seconds) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

async function postEditTask(task) {
    const formData = new FormData();
    const imagePaths = readEditImagePaths(task.raw, task.id);
    const taskCapabilities = await ensureCapabilities();
    const model = resolveTaskModel(task.raw, taskCapabilities);
    validateLocalRequest(() => validateResolvedTaskSize(task.raw, model, task.id));
    validateLocalRequest(() =>
        validateAgentEditRequestAgainstCapabilities(
            {
                n: task.raw.n === undefined ? 1 : readConfiguredPositiveInteger(task.raw.n, `${task.id}.n`, 1),
                ...(hasOwn(task.raw, 'partial_images')
                    ? { partial_images: readPartialImages(task.raw.partial_images, `${task.id}.partial_images`) }
                    : {}),
                imageCount: imagePaths.length,
                image_backend: task.raw.image_backend,
                stream_mode: task.raw.stream_mode,
                streaming_strategy: task.raw.streaming_strategy,
                model,
                size: task.raw.size,
                force_request: readForceRequest(task.raw, task.id)
            },
            taskCapabilities
        )
    );
    appendEditFields(formData, task.raw, model);
    const { response, result, text } = await fetchJson(`${baseUrl}${AGENT_ENDPOINTS.edit}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': task.idempotencyKey, ...authHeaders() },
        body: formData
    });
    if (!response.ok) throw new Error(readErrorMessage(result) || `edit 请求失败，状态码 ${response.status}：${text}`);
    return enrichImageUrls(result);
}

async function postPageSseTask(task, routing) {
    const pageSseCapabilities = await ensureCapabilities();
    const model = resolveTaskModel(task.raw, pageSseCapabilities);
    validateLocalRequest(() => validateResolvedTaskSize(task.raw, model, task.id));
    validatePageSseTaskAgainstCapabilities(task, pageSseCapabilities, model);
    try {
        assertPageSseReady({
            capabilities: pageSseCapabilities,
            passwordHash,
            idempotencyKey: task.idempotencyKey
        });
        const formData = buildPageSseTaskFormData(task, model);
        const result = await postPageSse({
            url: `${baseUrl}${PAGE_SSE_ENDPOINT}`,
            formData,
            timeoutMs,
            sseLogPath: task.raw.sse_log_path,
            errorMessage
        });
        return result;
    } catch (error) {
        const pageSseFailure = buildPageSseFailureOutput({
            error,
            fallbackEndpoint: routing.fallback_endpoint,
            errorMessage
        });
        const taskError = new Error(pageSseFailure.error?.message || errorMessage(error));
        taskError.pageSseFailure = pageSseFailure;
        throw taskError;
    }
}

function formatPageSseTaskOutput(task, result) {
    return formatPageSseOutput({
        result,
        baseUrl,
        responseMode: readResponseMode(task.raw),
        defaultOutputFormat: readOutputFormat(task.raw)
    });
}

function formatPageSseTaskDimensionCheckInput(task, result) {
    return formatPageSseOutput({
        result,
        baseUrl,
        responseMode: 'both',
        defaultOutputFormat: readOutputFormat(task.raw)
    });
}

function validatePageSseTaskAgainstCapabilities(
    task,
    taskCapabilities,
    model = resolveTaskModel(task.raw, taskCapabilities)
) {
    validateLocalRequest(() => {
        if (task.mode === 'edit') {
            validateAgentEditRequestAgainstCapabilities(
                {
                    n: task.raw.n === undefined ? 1 : readConfiguredPositiveInteger(task.raw.n, `${task.id}.n`, 1),
                    ...(hasOwn(task.raw, 'partial_images')
                        ? { partial_images: readPartialImages(task.raw.partial_images, `${task.id}.partial_images`) }
                        : {}),
                    imageCount: readEditImagePaths(task.raw, task.id).length,
                    image_backend: readTaskImageBackend(task.raw),
                    stream_mode: task.raw.stream_mode,
                    streaming_strategy: task.raw.streaming_strategy,
                    model,
                    size: task.raw.size,
                    force_request: readForceRequest(task.raw, task.id)
                },
                taskCapabilities
            );
            return;
        }
        validateAgentGenerateRequestAgainstCapabilities(
            {
                n: task.raw.n === undefined ? 1 : readConfiguredPositiveInteger(task.raw.n, `${task.id}.n`, 1),
                ...(hasOwn(task.raw, 'partial_images')
                    ? { partial_images: readPartialImages(task.raw.partial_images, `${task.id}.partial_images`) }
                    : {}),
                image_backend: readTaskImageBackend(task.raw),
                stream_mode: task.raw.stream_mode,
                streaming_strategy: task.raw.streaming_strategy,
                model,
                size: task.raw.size,
                background: task.raw.background,
                force_request: readForceRequest(task.raw, task.id)
            },
            taskCapabilities
        );
    });
}

function readTaskImageBackend(raw) {
    return raw.image_backend ? normalizeImageBackendForPage(String(raw.image_backend)) : undefined;
}

function validateLocalRequest(callback) {
    try {
        callback();
    } catch (error) {
        const validationError = new Error(errorMessage(error));
        validationError.billable = false;
        validationError.nextStep = '修正任务参数后，使用新的 Idempotency-Key 重试失败任务。';
        throw validationError;
    }
}

function buildGenerateBody(raw, model = DEFAULT_MODEL) {
    const outputFormat =
        hasOwn(raw, 'output_format') || hasOwn(raw, 'format')
            ? normalizeOutputFormat(raw.output_format ?? raw.format)
            : DEFAULT_OUTPUT_FORMAT;
    const outputCompression = readOutputCompression(raw, String(raw.id || 'generate'));
    const responsesModel = readResponsesModel(raw, String(raw.id || 'generate'));
    const thinking = hasOwn(raw, 'thinking')
        ? normalizeEnumValue(raw.thinking, THINKING_VALUES, 'thinking')
        : undefined;
    const promptOptimization = readPromptOptimization(raw, String(raw.id || 'generate'));
    const forceWeb = readForceWeb(raw, String(raw.id || 'generate'));
    const forceRequest = readForceRequest(raw, String(raw.id || 'generate'));
    const body = {
        prompt: raw.prompt,
        model: raw.model || model,
        n: readConfiguredPositiveInteger(raw.n, 'n', 1),
        size: raw.size || '1024x1024',
        quality: raw.quality || 'high',
        output_format: normalizeEnumValue(outputFormat, OUTPUT_FORMATS, 'output_format'),
        response_mode: normalizeEnumValue(
            hasOwn(raw, 'response_mode') ? raw.response_mode : 'path',
            RESPONSE_MODES,
            'response_mode'
        ),
        ...(outputCompression !== undefined ? { output_compression: outputCompression } : {}),
        ...(raw.background ? { background: raw.background } : {}),
        ...(raw.moderation ? { moderation: raw.moderation } : {}),
        ...(hasOwn(raw, 'image_backend')
            ? { image_backend: normalizeEnumValue(raw.image_backend, IMAGE_BACKENDS, 'image_backend') }
            : {}),
        ...(responsesModel ? { responsesModel } : {}),
        ...(thinking ? { thinking } : {}),
        ...(promptOptimization !== undefined ? { promptOptimization } : {}),
        ...(forceWeb !== undefined ? { force_web: forceWeb } : {}),
        ...(forceRequest !== undefined ? { force_request: forceRequest } : {}),
        ...(hasOwn(raw, 'stream_mode')
            ? { stream_mode: normalizeEnumValue(raw.stream_mode, STREAM_MODES, 'stream_mode') }
            : {}),
        ...(hasOwn(raw, 'streaming_strategy')
            ? {
                  streaming_strategy: normalizeEnumValue(
                      raw.streaming_strategy,
                      STREAMING_STRATEGIES,
                      'streaming_strategy'
                  )
              }
            : {}),
        ...(hasOwn(raw, 'partial_images')
            ? { partial_images: readPartialImages(raw.partial_images, 'partial_images') }
            : {})
    };
    const normalizations = readTaskNormalizations(raw, String(raw.id || 'generate'));
    return normalizations ? { ...body, normalizations } : body;
}

function buildPageSseTaskFormData(task, model = DEFAULT_MODEL) {
    const raw = task.raw;
    const formData = new FormData();
    formData.append('mode', task.mode);
    formData.append('prompt', raw.prompt);
    formData.append('model', raw.model || model);
    formData.append('size', raw.size || (task.mode === 'generate' ? '1024x1024' : 'auto'));
    formData.append('quality', raw.quality || (task.mode === 'generate' ? 'high' : 'auto'));
    formData.append('response_mode', readResponseMode(raw));
    formData.append('clientRequestId', task.idempotencyKey);
    if (raw.n !== undefined) formData.append('n', String(readConfiguredPositiveInteger(raw.n, `${task.id}.n`, 1)));
    if (raw.stream_mode) formData.append('stream_mode', String(raw.stream_mode));
    if (raw.streaming_strategy) formData.append('image_streaming_strategy', String(raw.streaming_strategy));
    if (raw.partial_images !== undefined)
        formData.append('partial_images', String(readPartialImages(raw.partial_images, `${task.id}.partial_images`)));
    if (raw.image_backend) formData.append('image_backend', normalizeImageBackendForPage(String(raw.image_backend)));
    if (readResponsesModel(raw, task.id)) formData.append('responsesModel', readResponsesModel(raw, task.id));
    if (raw.thinking) formData.append('thinking', String(raw.thinking));
    if (readPromptOptimization(raw, task.id) !== undefined) {
        formData.append('promptOptimization', String(readPromptOptimization(raw, task.id)));
    }
    if (readForceWeb(raw, task.id) !== undefined) formData.append('force_web', String(readForceWeb(raw, task.id)));
    if (readForceRequest(raw, task.id) !== undefined)
        formData.append('force_request', String(readForceRequest(raw, task.id)));
    if (raw.background) formData.append('background', String(raw.background));
    if (raw.moderation) formData.append('moderation', String(raw.moderation));
    if (readOutputCompression(raw, task.id) !== undefined) {
        formData.append('output_compression', String(readOutputCompression(raw, task.id)));
    }
    if (passwordHash) formData.append('passwordHash', passwordHash);
    if (task.mode === 'edit') {
        readEditImagePaths(raw, task.id).forEach((filePath, index) => appendFile(formData, `image_${index}`, filePath));
        if (raw.mask_path) appendFile(formData, 'mask', raw.mask_path);
    }
    formData.append('output_format', readOutputFormat(raw));
    return formData;
}

function readResponseMode(raw) {
    return normalizeEnumValue(
        hasOwn(raw, 'response_mode') ? raw.response_mode : 'path',
        RESPONSE_MODES,
        'response_mode'
    );
}

function readOutputFormat(raw) {
    const outputFormat =
        hasOwn(raw, 'output_format') || hasOwn(raw, 'format')
            ? normalizeOutputFormat(raw.output_format ?? raw.format)
            : DEFAULT_OUTPUT_FORMAT;
    return normalizeEnumValue(outputFormat, OUTPUT_FORMATS, 'output_format');
}

function appendEditFields(formData, raw, model = DEFAULT_MODEL) {
    validateEditStrategyFields(raw);
    const fields = [
        'prompt',
        'model',
        'n',
        'size',
        'quality',
        'response_mode',
        'stream_mode',
        'streaming_strategy',
        'partial_images'
    ];
    for (const field of fields) {
        if (raw[field] !== undefined) formData.append(field, String(raw[field]));
    }
    if (!raw.model) formData.append('model', model);
    if (!raw.response_mode) formData.append('response_mode', 'path');
    readEditImagePaths(raw, String(raw.id || 'edit')).forEach((filePath, index) =>
        appendFile(formData, `image_${index}`, filePath)
    );
    if (raw.mask_path) appendFile(formData, 'mask', raw.mask_path);
}

function readTaskMaxEdge(task) {
    return readMaxImageEdge(task.raw.size || (task.mode === 'generate' ? '1024x1024' : undefined));
}

function resolveTaskModel(raw, capabilities) {
    return raw.model || resolveCapabilitiesDefaultImageModel(capabilities, DEFAULT_MODEL);
}

function validateResolvedTaskSize(raw, model, id) {
    if (raw.size !== undefined) assertValidImageSizeForModel(raw.size, model, `${id}.size`);
}

function validateEditStrategyFields(raw) {
    if (hasOwn(raw, 'response_mode')) normalizeEnumValue(raw.response_mode, RESPONSE_MODES, 'response_mode');
    if (hasOwn(raw, 'stream_mode')) normalizeEnumValue(raw.stream_mode, STREAM_MODES, 'stream_mode');
    if (hasOwn(raw, 'streaming_strategy')) {
        normalizeEnumValue(raw.streaming_strategy, STREAMING_STRATEGIES, 'streaming_strategy');
    }
    if (hasOwn(raw, 'partial_images')) readPartialImages(raw.partial_images, 'partial_images');
}

function normalizeEnumValue(value, allowed, name) {
    const normalized = String(value);
    if (allowed.has(normalized)) return normalized;
    throw new Error(`${name} 的值无效：${normalized}`);
}

function readNonNegativeInteger(value, name) {
    const parsed =
        typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${name} 必须是非负整数。`);
    }
    return parsed;
}

function appendFile(formData, field, filePath) {
    const buffer = fs.readFileSync(filePath);
    formData.append(field, new Blob([buffer], { type: mimeTypeForPath(filePath) }), path.basename(filePath));
}

async function fetchJson(url, init) {
    const { response, text } = await fetchText(url, init);
    let result = null;
    try {
        result = text ? JSON.parse(text) : null;
    } catch (error) {
        if (response.ok) throw new Error(`响应不是有效 JSON：${errorMessage(error)}`);
    }
    return { response, result, text };
}

async function fetchText(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        return { response, text: await response.text() };
    } finally {
        clearTimeout(timer);
    }
}

function readErrorMessage(result) {
    if (typeof result?.error === 'string') return result.error;
    if (typeof result?.error?.message === 'string') return result.error.message;
    return undefined;
}

function enrichImageUrls(result) {
    if (!result || !Array.isArray(result.images)) return result;
    return {
        ...result,
        images: result.images.map((image) => ({
            ...image,
            ...(image.content_url
                ? { absolute_content_url: new URL(image.content_url, `${baseUrl}/`).toString() }
                : {}),
            ...(image.metadata_url
                ? { absolute_metadata_url: new URL(image.metadata_url, `${baseUrl}/`).toString() }
                : {})
        }))
    };
}

async function assertDimensions(task, response) {
    const expected = parseExpectedSize(task.raw.size || (task.mode === 'generate' ? '1024x1024' : undefined));
    return assertImageDimensions({
        response,
        expected,
        baseUrl,
        authHeaders,
        timeoutMs,
        messagePrefix: `${task.id} 尺寸校验失败`,
        missingSizeMessage: `${task.id} --dimension-check 需要 size 为 WIDTHxHEIGHT。`,
        readUrlFields: DIMENSION_CHECK_URL_FIELDS
    });
}

function parseExpectedSize(size) {
    return parseExpectedDimensions(size);
}

function readCompletedManifestKeys(filePath) {
    if (!fs.existsSync(filePath)) return new Set();
    const keys = new Set();
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (entry.status === 'succeeded') {
            if (entry.id) keys.add(entry.id);
            if (entry.idempotency_key) keys.add(entry.idempotency_key);
        }
    }
    return keys;
}

function appendManifest(filePath, entry) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

function baseManifestEntry(task) {
    return {
        at: new Date().toISOString(),
        index: task.index,
        id: task.id,
        mode: task.mode,
        idempotency_key: task.idempotencyKey,
        attempt: task.attempt || 1,
        ...(task.rootIdempotencyKey && task.rootIdempotencyKey !== task.idempotencyKey
            ? { root_idempotency_key: task.rootIdempotencyKey }
            : {})
    };
}

function mimeTypeForPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    return 'image/png';
}

function printUsage() {
    console.error('用法：batch-images.mjs --input tasks.jsonl [options]');
    console.error('默认只输出 dry-run；添加 --allow-billable 才会按 routing rules 逐行真实请求 Agent API 或页面 SSE。');
    console.error(
        '常用参数：--manifest --resume --ordered-prefix --dimension-check --max-attempts --max-consecutive-failures --concurrency --timeout-ms --base-url --dry-run --allow-billable'
    );
}
