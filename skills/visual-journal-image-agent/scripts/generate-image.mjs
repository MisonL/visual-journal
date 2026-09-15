#!/usr/bin/env node
import { AGENT_ENDPOINTS, buildAgentArtifactSharePath, buildAgentJobResultPath } from './lib/agent-api-paths.mjs';
import { enrichFailureWithAgentDiagnostics } from './lib/agent-diagnostics-summary.mjs';
import {
    assertImageDimensions,
    buildDimensionCheckFailureBody,
    isDimensionCheckError,
    parseExpectedDimensions
} from './lib/dimension-check.mjs';
import { formatPageSseOutput as formatSharedPageSseOutput } from './lib/page-sse-client.mjs';
import {
    attachSummary,
    buildFailureSummary,
    buildSuccessSummary,
    completeScriptTiming,
    startScriptTiming
} from './lib/script-summary.mjs';
import {
    errorMessage,
    assertValidImageSizeForModel,
    normalizeOutputFormat,
    parseImageSizeValue,
    parseRetryAfterValue,
    readCapabilitiesImageTransportTimeoutMs,
    readCapabilitiesDefaultImageModel,
    readConfiguredPositiveInteger,
    readMaxImageEdge,
    readOptionValue,
    readPartialImages,
    loadPrivateAgentEnvFile,
    resolveAgentToken,
    resolveConfiguredDefaultImageModel,
    resolvePlaygroundBaseUrl,
    resolveSameOriginUrl,
    sleep,
    validateAgentGenerateRequestAgainstCapabilities
} from './lib/script-utils.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IMAGE_BACKENDS = new Set(['images-api', 'images', 'responses', 'responses-image-generation']);
const RESPONSE_MODES = new Set(['path', 'base64', 'both']);
const STREAMING_STRATEGIES = new Set([
    'off',
    'auto',
    'openai-sse',
    'newapi-keepalive-sse',
    'responses-sse',
    'force-sse'
]);
const STREAM_MODES = new Set(['auto', 'stream', 'non_stream']);
const THINKING_VALUES = new Set(['minimal', 'none', 'low', 'medium', 'high', 'xhigh']);
const OUTPUT_FORMATS = new Set(['png', 'jpeg', 'webp']);
const DEFAULT_OUTPUT_FORMAT = 'webp';
const DEFAULT_OUTPUT_COMPRESSION = 100;
const DEFAULT_PAGE_SSE_CLIENT_REQUEST_ID_MAX_LENGTH = 128;
const PAGE_SSE_ENDPOINT = '/api/images';
const DIMENSION_CHECK_URL_FIELDS = ['absolute_content_url', 'content_url', 'absolute_path', 'path'];
const SERVER_ORCHESTRATED_TRANSPORT = 'server_orchestrated';
const MIN_SHARE_ACCESS_CODE_LENGTH = 8;
const MAX_SHARE_ACCESS_CODE_LENGTH = 128;
const GENERATE_PRESETS = {
    '1k-smoke-agent': ['--agent', '--size', '1024x1024', '--quality', 'low', '--stream-mode', 'non_stream'],
    '4k-agent-nonstream': ['--agent', '--size', '3840x2160', '--quality', 'high', '--stream-mode', 'non_stream'],
    '4k-page-sse': ['--page-sse', '--size', '3840x2160', '--quality', 'high', '--stream-mode', 'stream'],
    '4k-upstream-sse-newapi': [
        '--agent',
        '--image-backend',
        'images-api',
        '--size',
        '3840x2160',
        '--quality',
        'high',
        '--stream-mode',
        'stream',
        '--streaming-strategy',
        'newapi-keepalive-sse',
        '--partial-images',
        '2'
    ]
};

loadPrivateAgentEnvFile();
const DEFAULT_MODEL = resolveConfiguredDefaultImageModel();
const token = resolveAgentToken();
const passwordHash = process.env.GPT_IMAGE_APP_PASSWORD_HASH || '';
const contractCheck = process.env.GPT_IMAGE_AGENT_CONTRACT_CHECK === '1' || process.argv.includes('--contract-check');
let pageSseClientRequestIdMaxLength = DEFAULT_PAGE_SSE_CLIENT_REQUEST_ID_MAX_LENGTH;
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

let prompt;
let maxAttempts;
let timeoutMs;
let idempotencyKey;
let requestBody;
const scriptTiming = startScriptTiming();
try {
    maxAttempts = readConfiguredPositiveInteger(
        process.env.GPT_IMAGE_AGENT_MAX_ATTEMPTS,
        'GPT_IMAGE_AGENT_MAX_ATTEMPTS',
        3
    );
    timeoutMs = readConfiguredPositiveInteger(options.timeoutMs, '--timeout-ms', 420000);
    idempotencyKey =
        options.idempotencyKey ||
        process.env.GPT_IMAGE_AGENT_IDEMPOTENCY_KEY ||
        `agent-generate-${crypto.randomUUID()}`;
    if (isNonBillableDryRun(options, contractCheck)) {
        if (!hasPromptSource(options)) {
            printUsage();
            process.exit(2);
        }
        requestBody = buildDryRunRequestBody(options);
    } else {
        prompt = readPrompt(options, { readPromptFile: !contractCheck });
        requestBody = buildRequestBody(prompt, options);
    }
} catch (error) {
    console.error(errorMessage(error));
    printUsage();
    process.exit(2);
}

if (!isNonBillableDryRun(options, contractCheck) && !prompt && !contractCheck) {
    printUsage();
    process.exit(2);
}

let baseUrl;
let baseUrlInfo;
try {
    baseUrlInfo = resolvePlaygroundBaseUrl(options.baseUrl, process.env);
    baseUrl = baseUrlInfo.baseUrl;
} catch (error) {
    console.error(errorMessage(error));
    process.exit(2);
}

if (isNonBillableDryRun(options, contractCheck)) {
    let remoteCheck;
    try {
        remoteCheck = options.checkRemote ? await runRemotePlanningCheck() : buildSkippedRemotePlanningCheck();
        if (!options.modelExplicit) {
            const resolvedModel = remoteCheck.default_model || requestBody.model || DEFAULT_MODEL;
            requestBody = {
                ...requestBody,
                model: resolvedModel,
                size: assertValidImageSizeForModel(requestBody.size, resolvedModel, '--size')
            };
        }
    } catch (error) {
        console.error(errorMessage(error));
        process.exit(1);
    }
    console.log(
        JSON.stringify(
            {
                ok: true,
                billable: false,
                dry_run: true,
                verification_scope: buildDryRunVerificationScope(remoteCheck),
                endpoint: dryRunEndpoint(requestBody, options.routeMode),
                route_mode: options.routeMode,
                routing_guidance: buildGenerateRoutingGuidance(requestBody, options.routeMode),
                idempotency_key: idempotencyKey,
                request: requestBody,
                next_step: '重新执行并添加 --allow-billable 才会发起真实生图请求。'
            },
            null,
            2
        )
    );
    process.exit(0);
}

const capabilities = await readCapabilitiesOrExit();
try {
    applyCapabilitiesRuntimeValues(capabilities);
    const resolvedCapabilitiesModel = readCapabilitiesDefaultImageModel(capabilities);
    if (!options.modelExplicit) {
        const resolvedModel = resolvedCapabilitiesModel || requestBody.model || DEFAULT_MODEL;
        requestBody = {
            ...requestBody,
            model: resolvedModel,
            size: assertValidImageSizeForModel(requestBody.size, resolvedModel, '--size')
        };
    }
} catch (error) {
    console.error(errorMessage(error));
    process.exit(2);
}

if (contractCheck) {
    await runContractCheck(capabilities);
    process.exit(0);
}

try {
    validateAgentGenerateRequestAgainstCapabilities(
        {
            n: requestBody.n,
            ...(requestBody.partial_images === undefined ? {} : { partial_images: requestBody.partial_images }),
            image_backend: requestBody.image_backend,
            stream_mode: requestBody.stream_mode,
            streaming_strategy: requestBody.streaming_strategy,
            model: requestBody.model,
            size: requestBody.size,
            background: requestBody.background,
            force_request: requestBody.force_request
        },
        capabilities
    );
} catch (error) {
    console.error(errorMessage(error));
    process.exit(2);
}

try {
    if (shouldUseServerOrchestration(capabilities, requestBody, options.routeMode)) {
        await runGenerateJob({
            createEndpoint: AGENT_ENDPOINTS.create_image_request,
            routing: {
                transport: SERVER_ORCHESTRATED_TRANSPORT,
                endpoint: AGENT_ENDPOINTS.create_image_request
            }
        });
    } else if (shouldUseJobPolling(capabilities, options.routeMode)) {
        await runGenerateJob({
            createEndpoint: AGENT_ENDPOINTS.create_generate_job,
            routing: {
                transport: 'agent_job_polling',
                endpoint: AGENT_ENDPOINTS.create_generate_job
            }
        });
    } else if (shouldUsePageSse(capabilities, requestBody, options.routeMode)) {
        const routing = {
            ...buildPageSseSummaryRouting(),
            fallback_endpoint: AGENT_ENDPOINTS.create_image_request,
            fallback_mode: 'manual_after_diagnosis'
        };
        try {
            const result = await runPageSseRequest();
            const checkedResult = await assertDimensionsIfRequested(
                formatPageSseOutput(result, { preserveBase64: true })
            );
            await writeSuccessOutputAndExit(
                formatPageSseOutput(checkedResult),
                routing,
                completeScriptTiming(scriptTiming),
                {
                    dimensionChecked: true
                }
            );
        } catch (error) {
            if (isDimensionCheckError(error)) {
                console.error(JSON.stringify(buildDimensionCheckFailureOutput(error, routing), null, 2));
                process.exit(1);
            }
            console.error(
                JSON.stringify(buildPageSseFailureOutput(error, completeScriptTiming(scriptTiming)), null, 2)
            );
            process.exit(1);
        }
    } else {
        await runGenerateRequest({ routing: { transport: 'agent_json', endpoint: AGENT_ENDPOINTS.generate } });
    }
} catch (error) {
    if (isScriptError(error)) {
        console.error(JSON.stringify(buildPageSseFailureOutput(error, completeScriptTiming(scriptTiming)), null, 2));
        process.exit(1);
    }
    console.error(errorMessage(error));
    process.exit(1);
}

function parseArgs(argv) {
    const expandedArgv = expandPresetArgs(argv);
    const parsed = {
        model: undefined,
        modelExplicit: false,
        size: '1024x1024',
        quality: 'high',
        n: '1',
        format: DEFAULT_OUTPUT_FORMAT,
        outputCompression: undefined,
        responseMode: 'path',
        imageBackend: undefined,
        responsesModel: undefined,
        thinking: undefined,
        promptOptimization: undefined,
        forceWeb: undefined,
        forceRequest: false,
        share: false,
        shareExpiresMinutes: undefined,
        dimensionCheck: false,
        streamMode: undefined,
        streamingStrategy: undefined,
        partialImages: undefined,
        sseLogPath: undefined,
        timeoutMs: undefined,
        baseUrl: undefined,
        promptFile: undefined,
        idempotencyKey: undefined,
        routeMode: 'auto',
        dryRun: false,
        allowBillable: false,
        checkRemote: false,
        help: false,
        promptParts: []
    };
    for (let index = 0; index < expandedArgv.length; index += 1) {
        const arg = expandedArgv[index];
        if (arg === '--dry-run') parsed.dryRun = true;
        else if (arg === '--allow-billable') parsed.allowBillable = true;
        else if (arg === '--job') parsed.routeMode = 'job';
        else if (arg === '--no-job' || arg === '--agent') parsed.routeMode = 'agent';
        else if (arg === '--page-sse') parsed.routeMode = 'page_sse';
        else if (arg === '--help' || arg === '-h') parsed.help = true;
        else if (arg === '--contract-check') continue;
        else if (arg === '--preset') parsed.preset = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--model') {
            parsed.model = readOptionValue(expandedArgv, (index += 1), arg);
            parsed.modelExplicit = true;
        } else if (arg === '--size') parsed.size = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--quality') parsed.quality = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--n') parsed.n = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--format' || arg === '--output-format')
            parsed.format = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--output-compression')
            parsed.outputCompression = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--response-mode') parsed.responseMode = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--image-backend') parsed.imageBackend = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--responses-model' || arg === '--gpt-model')
            parsed.responsesModel = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--thinking') parsed.thinking = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--prompt-optimization')
            parsed.promptOptimization = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--force-web') parsed.forceWeb = true;
        else if (arg === '--force-request') parsed.forceRequest = true;
        else if (arg === '--share') parsed.share = true;
        else if (arg === '--share-expires-minutes')
            parsed.shareExpiresMinutes = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--dimension-check') parsed.dimensionCheck = true;
        else if (arg === '--stream-mode') parsed.streamMode = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--streaming-strategy')
            parsed.streamingStrategy = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--partial-images') parsed.partialImages = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--sse-log') parsed.sseLogPath = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--timeout-ms') parsed.timeoutMs = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--base-url') parsed.baseUrl = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--prompt-file') parsed.promptFile = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--idempotency-key') parsed.idempotencyKey = readOptionValue(expandedArgv, (index += 1), arg);
        else if (arg === '--check-remote') parsed.checkRemote = true;
        else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
        else parsed.promptParts.push(arg);
    }
    return parsed;
}

function expandPresetArgs(argv) {
    const output = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg !== '--preset') {
            output.push(arg);
            continue;
        }
        const presetName = readOptionValue(argv, (index += 1), arg);
        const presetArgs = GENERATE_PRESETS[presetName];
        if (!presetArgs) {
            throw new Error(`未知 preset：${presetName}。可用值：${Object.keys(GENERATE_PRESETS).join(', ')}。`);
        }
        output.push(...presetArgs);
    }
    return output;
}

function readPrompt(parsed, { readPromptFile }) {
    if (parsed.promptFile) {
        if (readPromptFile) {
            return fs.readFileSync(parsed.promptFile, 'utf8');
        }
        return parsed.promptParts.join(' ') || 'contract check';
    }
    return parsed.promptParts.join(' ');
}

function buildRequestBody(promptValue, parsed) {
    const model = parsed.model || DEFAULT_MODEL;
    return addUpstreamStrategyFields(
        {
            prompt: promptValue || 'contract check',
            model,
            n: readConfiguredPositiveInteger(parsed.n, '--n', 1),
            size: assertValidImageSizeForModel(parsed.size, parsed.modelExplicit ? model : undefined, '--size'),
            quality: parsed.quality,
            output_format: normalizeOutputFormat(parsed.format),
            ...(readOutputCompression(parsed) !== undefined
                ? { output_compression: readOutputCompression(parsed) }
                : {}),
            response_mode: parsed.responseMode
        },
        parsed
    );
}

function buildDryRunRequestBody(parsed) {
    const model = parsed.model || DEFAULT_MODEL;
    const validationModel = parsed.modelExplicit || !parsed.checkRemote ? model : undefined;
    const body = addUpstreamStrategyFields(
        {
            model,
            n: readConfiguredPositiveInteger(parsed.n, '--n', 1),
            size: assertValidImageSizeForModel(parsed.size, validationModel, '--size'),
            quality: parsed.quality,
            output_format: normalizeOutputFormat(parsed.format),
            ...(readOutputCompression(parsed) !== undefined
                ? { output_compression: readOutputCompression(parsed) }
                : {}),
            response_mode: parsed.responseMode
        },
        parsed
    );
    if (parsed.promptFile) {
        return { ...body, prompt_file: parsed.promptFile };
    }
    return { ...body, prompt: parsed.promptParts.join(' ') };
}

function addUpstreamStrategyFields(body, parsed) {
    validateUpstreamStrategyOptions(parsed);
    return {
        ...body,
        ...(parsed.imageBackend ? { image_backend: parsed.imageBackend } : {}),
        ...(parsed.responsesModel
            ? { responsesModel: readNonEmptyString(parsed.responsesModel, '--responses-model') }
            : {}),
        ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
        ...(parsed.promptOptimization !== undefined
            ? { promptOptimization: readBooleanOption(parsed.promptOptimization, '--prompt-optimization') }
            : {}),
        ...(parsed.forceWeb !== undefined ? { force_web: true } : {}),
        ...(parsed.forceRequest ? { force_request: true } : {}),
        ...(parsed.streamMode ? { stream_mode: parsed.streamMode } : {}),
        ...(parsed.streamingStrategy ? { streaming_strategy: parsed.streamingStrategy } : {}),
        ...(parsed.partialImages !== undefined
            ? { partial_images: readPartialImages(parsed.partialImages, '--partial-images') }
            : {})
    };
}

function validateUpstreamStrategyOptions(parsed) {
    if (!RESPONSE_MODES.has(parsed.responseMode)) {
        throw new Error('--response-mode 必须是 path、base64 或 both。');
    }
    if (parsed.dimensionCheck && !parseImageSizeValue(parsed.size)) {
        throw new Error('--dimension-check 需要 --size 为 WIDTHxHEIGHT。');
    }
    if (parsed.imageBackend && !IMAGE_BACKENDS.has(parsed.imageBackend)) {
        throw new Error('--image-backend 必须是 images-api、images、responses 或 responses-image-generation。');
    }
    if (parsed.responsesModel !== undefined) {
        readNonEmptyString(parsed.responsesModel, '--responses-model');
        validateResponsesModelBackend(parsed);
    }
    if (parsed.thinking && !THINKING_VALUES.has(parsed.thinking)) {
        throw new Error('--thinking 必须是 minimal、none、low、medium、high 或 xhigh。');
    }
    if (parsed.promptOptimization !== undefined) readBooleanOption(parsed.promptOptimization, '--prompt-optimization');
    if (parsed.streamMode && !STREAM_MODES.has(parsed.streamMode)) {
        throw new Error('--stream-mode 必须是 auto、stream 或 non_stream。');
    }
    if (!parsed.share && parsed.shareExpiresMinutes !== undefined) {
        throw new Error('--share-expires-minutes 需要和 --share 一起使用。');
    }
    if (parsed.shareExpiresMinutes !== undefined) {
        readConfiguredPositiveInteger(parsed.shareExpiresMinutes, '--share-expires-minutes', 1);
    }
    if (parsed.share && process.env.GPT_IMAGE_SHARE_ACCESS_CODE !== undefined) {
        readShareAccessCodeFromEnv();
    }
    if (parsed.streamingStrategy && !STREAMING_STRATEGIES.has(parsed.streamingStrategy)) {
        throw new Error(
            '--streaming-strategy 必须是 off、auto、openai-sse、newapi-keepalive-sse、responses-sse 或 force-sse。'
        );
    }
    if (parsed.routeMode === 'page_sse' && (parsed.streamingStrategy === 'off' || parsed.streamMode === 'non_stream')) {
        throw new Error('stream_mode=non_stream 或 streaming_strategy=off 时不能强制使用页面 SSE。');
    }
    if (!OUTPUT_FORMATS.has(normalizeOutputFormat(parsed.format))) {
        throw new Error('--format 必须是 png、jpeg 或 webp。');
    }
    if (parsed.outputCompression !== undefined) readOutputCompression(parsed);
}

function validateResponsesModelBackend(parsed) {
    if (!parsed.imageBackend) {
        throw new Error('--responses-model 必须同时设置 --image-backend responses-image-generation。');
    }
    const backend = normalizeImageBackendForPage(parsed.imageBackend);
    if (backend !== 'responses-image-generation') {
        throw new Error('--responses-model 仅适用于 --image-backend responses-image-generation。');
    }
}

function readOutputCompression(parsed) {
    const outputFormat = normalizeOutputFormat(parsed.format);
    if (outputFormat === 'png') return undefined;
    const value =
        parsed.outputCompression === undefined ? String(DEFAULT_OUTPUT_COMPRESSION) : String(parsed.outputCompression);
    if (!/^\d+$/.test(value)) throw new Error('--output-compression 必须是 0 到 100 之间的整数。');
    const parsedValue = Number(value);
    if (!Number.isInteger(parsedValue) || parsedValue < 0 || parsedValue > 100) {
        throw new Error('--output-compression 必须是 0 到 100 之间的整数。');
    }
    return parsedValue;
}

function readBooleanOption(value, name) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new Error(`${name} 必须是 true 或 false。`);
}

function readNonEmptyString(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串。`);
    return value.trim();
}

function hasPromptSource(parsed) {
    return Boolean(parsed.promptFile || parsed.promptParts.length > 0);
}

function isNonBillableDryRun(parsed, isContractCheck) {
    return parsed.dryRun || (!isContractCheck && !parsed.allowBillable);
}

function authHeaders() {
    if (token) return { Authorization: `Bearer ${token}` };
    if (passwordHash) return { 'X-App-Password-Hash': passwordHash };
    return {};
}

function absoluteUrl(value) {
    if (typeof value !== 'string' || !value) return undefined;
    return new URL(value, `${baseUrl}/`).toString();
}

function enrichImageUrls(result) {
    if (!result || !Array.isArray(result.images)) return result;
    return {
        ...result,
        images: result.images.map((image) => ({
            ...image,
            ...(image.content_url ? { absolute_content_url: absoluteUrl(image.content_url) } : {}),
            ...(image.metadata_url ? { absolute_metadata_url: absoluteUrl(image.metadata_url) } : {})
        }))
    };
}

function buildDryRunVerificationScope(remoteCheck = buildSkippedRemotePlanningCheck()) {
    return {
        mode: remoteCheck.remote_capabilities_verified ? 'remote_contract_and_local_planning' : 'local_planning_only',
        service_base_url: baseUrl,
        service_base_url_source: baseUrlInfo.source,
        interactive_confirmation_required: baseUrlInfo.interactive_confirmation_required,
        remote_capabilities_verified: remoteCheck.remote_capabilities_verified,
        runtime_capacity_verified: remoteCheck.runtime_capacity_verified,
        auth_verified: remoteCheck.auth_verified,
        billable_request_sent: false,
        remote_check: {
            default_model: remoteCheck.default_model,
            capabilities: remoteCheck.capabilities,
            runtime: remoteCheck.runtime
        },
        note: remoteCheck.remote_capabilities_verified
            ? 'Dry-run validated local request construction and read non-billable remote capabilities/runtime state; it did not send a billable image request.'
            : 'Dry-run validates local request construction and routing guidance only; run --check-remote, --contract-check or --allow-billable to verify the remote service.'
    };
}

async function runRemotePlanningCheck() {
    const capabilities = await readCapabilities();
    const runtime = await readRuntimeCapabilities();
    const defaultModel = readCapabilitiesDefaultImageModel(capabilities) ?? null;
    return {
        remote_capabilities_verified: true,
        runtime_capacity_verified: true,
        auth_verified: true,
        default_model: defaultModel,
        capabilities: {
            endpoint: AGENT_ENDPOINTS.capabilities,
            default_model: defaultModel,
            orchestration_supported: capabilities?.orchestration?.supported === true,
            orchestration_endpoint: capabilities?.orchestration?.endpoint || null,
            page_sse_supported: capabilities?.agent_streaming?.page_sse?.supported === true,
            request_modes: readRequestModeList(capabilities?.supported?.request_modes)
        },
        runtime: {
            endpoint: '/api/runtime-capabilities',
            streaming_batch_enabled: runtime?.streamingBatch?.enabled === true,
            recommended_concurrency: runtime?.streamingBatch?.recommendedConcurrency ?? null,
            effective_request_modes: readRequestModeList(runtime?.channelRouting?.effectiveRequestModes)
        }
    };
}

async function readRuntimeCapabilities() {
    const { response, result, text } = await fetchJson(`${baseUrl}/api/runtime-capabilities`, {
        headers: authHeaders(),
        timeoutMs
    });
    if (!response.ok) {
        throw new Error(`runtime-capabilities 请求失败，状态码 ${response.status}：${text}`);
    }
    return result;
}

function buildSkippedRemotePlanningCheck() {
    return {
        remote_capabilities_verified: false,
        runtime_capacity_verified: false,
        auth_verified: false,
        capabilities: null,
        runtime: null
    };
}

function readRequestModeList(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => typeof item === 'string');
}

function dryRunEndpoint(body, routeMode) {
    if (routeMode === 'auto' && shouldPreferServerOrchestration(body)) {
        return `${baseUrl}${AGENT_ENDPOINTS.create_image_request}`;
    }
    if (routeMode === 'job') return `${baseUrl}${AGENT_ENDPOINTS.create_generate_job}`;
    if (routeMode === 'agent') return `${baseUrl}${AGENT_ENDPOINTS.generate}`;
    if (routeMode === 'page_sse') return `${baseUrl}${PAGE_SSE_ENDPOINT}`;
    return `${baseUrl}${AGENT_ENDPOINTS.generate}`;
}

function buildGenerateRoutingGuidance(body, routeMode) {
    if (routeMode === 'auto' && shouldPreferServerOrchestration(body)) {
        return {
            recommended_endpoint: AGENT_ENDPOINTS.create_image_request,
            transport: SERVER_ORCHESTRATED_TRANSPORT,
            strength: 'recommended',
            result_mode: 'job_polling',
            reason: 'Agent 客户端只提交生成意图；服务端负责选择内部执行路径和轮询结果。'
        };
    }
    if (routeMode === 'job') {
        return {
            recommended_endpoint: AGENT_ENDPOINTS.create_generate_job,
            transport: 'agent_job_polling',
            strength: 'recommended',
            reason: 'Explicit --job requests use Agent job polling.'
        };
    }
    if (routeMode === 'page_sse' && !isPageSseAllowed(body)) {
        throw new Error('stream_mode=non_stream 或 streaming_strategy=off 时不能强制使用页面 SSE。');
    }
    if (routeMode === 'page_sse' && isPageSseAllowed(body)) {
        return {
            recommended_endpoint: PAGE_SSE_ENDPOINT,
            transport: 'page_sse',
            strength: 'recommended',
            fallback_endpoint: AGENT_ENDPOINTS.create_image_request,
            fallback_mode: 'manual_after_diagnosis',
            reason: 'Explicit --page-sse requests use the page form-data SSE endpoint.'
        };
    }
    return {
        recommended_endpoint: AGENT_ENDPOINTS.generate,
        transport: 'agent_json',
        strength: 'default',
        reason: 'Normal single-image generate requests use the Agent JSON response contract.'
    };
}

async function readCapabilities() {
    const { response, result, text } = await fetchJson(`${baseUrl}${AGENT_ENDPOINTS.capabilities}`, {
        headers: authHeaders(),
        timeoutMs
    });
    if (!response.ok) {
        throw new Error(`capabilities 请求失败，状态码 ${response.status}：${text}`);
    }
    return result;
}

async function readCapabilitiesOrExit() {
    try {
        return await readCapabilities();
    } catch (error) {
        if (isScriptError(error)) {
            console.error(JSON.stringify(buildPageSseFailureOutput(error), null, 2));
            process.exit(1);
        }
        console.error(errorMessage(error));
        process.exit(1);
    }
}

function applyCapabilitiesRuntimeValues(capabilitiesValue) {
    if (options.timeoutMs === undefined) {
        timeoutMs = readCapabilitiesImageTransportTimeoutMs(capabilitiesValue, timeoutMs);
    }
    const maxLength = capabilitiesValue?.agent_streaming?.page_sse?.client_request_id?.max_length;
    if (Number.isSafeInteger(maxLength) && maxLength > 0) {
        pageSseClientRequestIdMaxLength = maxLength;
    }
}

async function runGenerateRequest(options = {}) {
    let lastResult;
    let lastRetryAfter = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const { response, result } = await fetchJson(`${baseUrl}${AGENT_ENDPOINTS.generate}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey,
                ...authHeaders()
            },
            body: JSON.stringify(requestBody),
            timeoutMs
        });

        if (response.ok) {
            await writeSuccessOutputAndExit(
                enrichImageUrls(result),
                options.routing,
                completeScriptTiming(scriptTiming)
            );
        }

        const retryAfter = parseRetryAfterValue(response.headers.get('retry-after'));
        lastResult = result;
        lastRetryAfter = retryAfter;
        if (!shouldRetry(result) || attempt === maxAttempts) break;
        await sleep(retryAfter);
    }

    console.error(
        JSON.stringify(
            await buildAgentFailureOutput(
                { ...lastResult, retry_after: lastRetryAfter },
                { transport: 'agent_json', endpoint: AGENT_ENDPOINTS.generate }
            ),
            null,
            2
        )
    );
    process.exit(1);
}

async function runPageSseRequest() {
    const url = `${baseUrl}${PAGE_SSE_ENDPOINT}`;
    const formData = buildPageSseFormData();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    appendPageSseTrace('request_started', {
        client_request_id: idempotencyKey,
        endpoint: PAGE_SSE_ENDPOINT
    });
    try {
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });
        } catch (error) {
            appendPageSseTrace('request_failed', {
                client_request_id: idempotencyKey,
                endpoint: PAGE_SSE_ENDPOINT,
                elapsed_ms: completeScriptTiming(scriptTiming).elapsed_ms,
                error: errorMessage(error)
            });
            throw new Error(`请求失败：${url}。${errorMessage(error)}`);
        }
        try {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('text/event-stream')) {
                return await collectPageSseResult(response, controller.signal);
            }
            const text = await response.text();
            if (!response.ok) {
                throw createPageSseHttpError(response.status, readErrorFromJsonText(text) || text);
            }
            const result = parseJsonResponse(text, true, url);
            appendPageSseTrace('request_completed', {
                client_request_id: idempotencyKey,
                endpoint: PAGE_SSE_ENDPOINT,
                elapsed_ms: completeScriptTiming(scriptTiming).elapsed_ms
            });
            return result;
        } catch (error) {
            if (controller.signal.aborted) {
                appendPageSseTrace('request_failed', {
                    client_request_id: idempotencyKey,
                    endpoint: PAGE_SSE_ENDPOINT,
                    elapsed_ms: completeScriptTiming(scriptTiming).elapsed_ms,
                    error: errorMessage(error)
                });
                throw new Error(`请求失败：${url}。${errorMessage(error)}`);
            }
            appendPageSseTrace('request_failed', {
                client_request_id: idempotencyKey,
                endpoint: PAGE_SSE_ENDPOINT,
                elapsed_ms: completeScriptTiming(scriptTiming).elapsed_ms,
                error: errorMessage(error)
            });
            throw error;
        }
    } finally {
        clearTimeout(timeout);
    }
}

function assertPageSseReady(capabilitiesValue) {
    const pageSse = capabilitiesValue?.agent_streaming?.page_sse;
    if (!supportsPageSse(capabilitiesValue)) {
        throw createScriptError(
            'page_sse_unavailable',
            '显式页面 SSE 或页面专属字段需要 agent_streaming.page_sse.supported=true；capabilities 未声明时不能静默降级到 Agent JSON。'
        );
    }
    if (pageSse?.auth?.required === true && !passwordHash) {
        throw createScriptError(
            'page_sse_auth_required',
            '页面 SSE 路径需要表单字段 passwordHash；请在本机私有 .env.agent.local 中设置 GPT_IMAGE_APP_PASSWORD_HASH，或导出该环境变量后重试。只有 GPT_IMAGE_AGENT_TOKEN 不能用于页面 SSE 表单鉴权。'
        );
    }
}

function buildPageSseFormData() {
    const formData = new FormData();
    assertPageSseClientRequestIdLength(idempotencyKey);
    formData.append('mode', 'generate');
    formData.append('prompt', requestBody.prompt);
    formData.append('model', requestBody.model);
    formData.append('n', String(requestBody.n));
    formData.append('size', requestBody.size);
    formData.append('quality', requestBody.quality);
    formData.append('output_format', requestBody.output_format);
    formData.append('response_mode', requestBody.response_mode);
    formData.append('clientRequestId', idempotencyKey);
    if (requestBody.stream_mode) formData.append('stream_mode', requestBody.stream_mode);
    if (requestBody.partial_images !== undefined) {
        formData.append('partial_images', String(requestBody.partial_images));
    }
    if (requestBody.image_backend)
        formData.append('image_backend', normalizeImageBackendForPage(requestBody.image_backend));
    if (requestBody.responsesModel) formData.append('responsesModel', requestBody.responsesModel);
    if (requestBody.thinking) formData.append('thinking', requestBody.thinking);
    if (requestBody.promptOptimization !== undefined) {
        formData.append('promptOptimization', String(requestBody.promptOptimization));
    }
    if (requestBody.force_web !== undefined) formData.append('force_web', String(requestBody.force_web));
    if (requestBody.force_request !== undefined) formData.append('force_request', String(requestBody.force_request));
    if (requestBody.streaming_strategy) {
        formData.append('image_streaming_strategy', requestBody.streaming_strategy);
    }
    if (requestBody.background) formData.append('background', requestBody.background);
    if (requestBody.moderation) formData.append('moderation', requestBody.moderation);
    if (requestBody.output_compression !== undefined) {
        formData.append('output_compression', String(requestBody.output_compression));
    }
    if (passwordHash) formData.append('passwordHash', passwordHash);
    return formData;
}

function assertPageSseClientRequestIdLength(clientRequestId) {
    if (clientRequestId.length > pageSseClientRequestIdMaxLength) {
        throw createScriptError(
            'page_sse_client_request_id_too_long',
            `页面 SSE 的 clientRequestId 不能超过 ${pageSseClientRequestIdMaxLength} 个字符；请缩短 Idempotency-Key。`
        );
    }
}

function formatPageSseOutput(result, { preserveBase64 = false } = {}) {
    return formatSharedPageSseOutput({
        result,
        baseUrl,
        responseMode: requestBody.response_mode,
        defaultOutputFormat: requestBody.output_format,
        preserveBase64
    });
}

function createPageSseState() {
    return {
        completedImages: [],
        usage: undefined,
        actualCost: undefined,
        doneReceived: false,
        completedEventCount: 0,
        partialImageCount: 0,
        lastEventType: undefined
    };
}

function normalizeImageBackendForPage(value) {
    if (value === 'images') return 'images-api';
    if (value === 'responses') return 'responses-image-generation';
    return value;
}

function readPageSseClientRequestId(event) {
    if (typeof event.clientRequestId === 'string') return event.clientRequestId;
    if (typeof event.client_request_id === 'string') return event.client_request_id;
    return undefined;
}

function normalizePageSseImage(image, fallbackClientRequestId) {
    const clientRequestId = image.clientRequestId || image.client_request_id || fallbackClientRequestId;
    return {
        ...image,
        output_format: image.outputFormat || image.output_format || requestBody.output_format,
        ...(clientRequestId ? { clientRequestId } : {})
    };
}

function mergePageSseDoneImages(doneImages, completedImages, fallbackClientRequestId) {
    if (!Array.isArray(doneImages) || doneImages.length === 0) {
        return completedImages.map((image) => normalizePageSseImage(image, fallbackClientRequestId));
    }
    const imageCount = Math.max(doneImages.length, completedImages.length);
    return Array.from({ length: imageCount }, (_, index) =>
        normalizePageSseImage(
            { ...(completedImages[index] || {}), ...(doneImages[index] || {}) },
            fallbackClientRequestId
        )
    );
}

async function collectPageSseResult(response, signal) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('页面 SSE 响应缺少 body。');
    const decoder = new TextDecoder();
    const state = createPageSseState();
    let buffer = '';
    while (true) {
        const { done, value } = await readPageSseChunk(reader, signal);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        for (const rawEvent of events) {
            appendPageSseLog(rawEvent);
            applyPageSseEvent(state, rawEvent);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
        appendPageSseLog(buffer);
        applyPageSseEvent(state, buffer);
    }
    if (state.completedImages.length === 0) {
        throw withPageSseDiagnostics(new Error('页面 SSE 未返回最终图片。'), state);
    }
    if (!state.doneReceived) {
        throw withPageSseDiagnostics(new Error('页面 SSE 缺少最终 done 事件，流式响应可能已提前中断。'), state);
    }
    appendPageSseTrace('request_completed', {
        client_request_id: idempotencyKey,
        endpoint: PAGE_SSE_ENDPOINT,
        elapsed_ms: completeScriptTiming(scriptTiming).elapsed_ms,
        final_image_count: state.completedImages.length
    });
    return {
        images: state.completedImages,
        usage: state.usage,
        actualCost: state.actualCost,
        sse_diagnostics: buildPageSseDiagnostics(state)
    };
}

function appendPageSseLog(rawEvent) {
    if (!options.sseLogPath || !rawEvent.trim()) return;
    try {
        fs.mkdirSync(path.dirname(options.sseLogPath), { recursive: true });
        fs.appendFileSync(
            options.sseLogPath,
            `${JSON.stringify({ at: new Date().toISOString(), raw_event: rawEvent })}\n`
        );
    } catch (error) {
        console.warn(`SSE log write failed: ${errorMessage(error)}`);
    }
}

function appendPageSseTrace(event, details) {
    if (!options.sseLogPath) return;
    try {
        fs.mkdirSync(path.dirname(options.sseLogPath), { recursive: true });
        fs.appendFileSync(
            options.sseLogPath,
            `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`
        );
    } catch (error) {
        console.warn(`SSE log write failed: ${errorMessage(error)}`);
    }
}

function readPageSseChunk(reader, signal) {
    if (!signal) return reader.read();
    if (signal.aborted) {
        return Promise.reject(new Error('请求超时。'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('请求超时。'));
        signal.addEventListener('abort', onAbort, { once: true });
        reader
            .read()
            .then(resolve, reject)
            .finally(() => {
                signal.removeEventListener('abort', onAbort);
            });
    });
}

function applyPageSseEvent(state, rawEvent) {
    const event = parsePageSseEvent(rawEvent);
    if (!event) return;
    const eventType = readPageSseEventType(event);
    state.lastEventType = eventType;
    if (isPartialPageSseEvent(event, eventType)) state.partialImageCount += 1;
    if (event.type === 'error') {
        throw createPageSseStreamError(event, state);
    }
    if (event.type === 'completed' && event.filename) {
        state.completedEventCount += 1;
        state.completedImages.push(
            normalizePageSseImage(
                {
                    filename: event.filename,
                    b64_json: event.b64_json,
                    path: event.path,
                    output_format: event.outputFormat || event.output_format || requestBody.output_format
                },
                readPageSseClientRequestId(event)
            )
        );
        return;
    }
    if (event.type === 'done') {
        state.doneReceived = true;
        const clientRequestId = readPageSseClientRequestId(event);
        state.completedImages = mergePageSseDoneImages(event.images, state.completedImages, clientRequestId);
        state.usage = event.usage;
        state.actualCost = event.actualCost !== undefined ? event.actualCost : event.actual_cost;
    }
}

function readPageSseEventType(event) {
    if (typeof event.type === 'string' && event.type.trim()) return event.type;
    if (typeof event.event === 'string' && event.event.trim()) return event.event;
    return undefined;
}

function isPartialPageSseEvent(event, eventType) {
    if (typeof eventType === 'string' && eventType.includes('partial_image')) return true;
    return Boolean(event.partial_image || event.partialImage || event.partial_image_b64 || event.partialImageB64);
}

function formatPageSseError(value) {
    if (typeof value === 'string' && value.trim()) return value;
    if (value && typeof value === 'object') {
        if (typeof value.message === 'string' && value.message.trim()) return value.message;
        if (typeof value.code === 'string' && value.code.trim()) return value.code;
        try {
            return JSON.stringify(value);
        } catch {
            return '页面 SSE 返回错误事件。';
        }
    }
    return '页面 SSE 返回错误事件。';
}

function createPageSseStreamError(event, state) {
    const error = new Error(formatPageSseError(event.error));
    const status = readPageSseStreamStatus(event);
    if (Number.isInteger(status)) {
        error.streamStatus = status;
    }
    return withPageSseDiagnostics(error, state);
}

function readPageSseStreamStatus(event) {
    if (Number.isInteger(event.status)) return event.status;
    if (event.error && typeof event.error === 'object' && Number.isInteger(event.error.status)) {
        return event.error.status;
    }
    return undefined;
}

function parsePageSseEvent(rawEvent) {
    const lines = rawEvent.split(/\r?\n/);
    const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
        .trim();
    if (!data || data === '[DONE]') return undefined;
    try {
        return JSON.parse(data);
    } catch (error) {
        throw new Error(`页面 SSE 事件不是有效 JSON：${errorMessage(error)}`);
    }
}

async function buildSuccessOutput(result, routing, timing, { dimensionChecked = false } = {}) {
    const checkedResult = dimensionChecked ? result : await assertDimensionsIfRequested(result);
    const output = attachSummary(
        routing ? { ...checkedResult, routing } : checkedResult,
        buildSuccessSummary({
            result: checkedResult,
            routing,
            timing,
            idempotencyKey,
            billable: true
        })
    );
    if (!options.share) {
        return output;
    }
    const shareSummary = await maybeCreateShares(output);
    return shareSummary
        ? attachSummary({ ...output, shares: shareSummary.share_results }, { ...output.summary, ...shareSummary })
        : output;
}

async function writeSuccessOutputAndExit(result, routing, timing, options = {}) {
    try {
        console.log(JSON.stringify(await buildSuccessOutput(result, routing, timing, options), null, 2));
        process.exit(0);
    } catch (error) {
        if (!isDimensionCheckError(error)) throw error;
        console.error(JSON.stringify(buildDimensionCheckFailureOutput(error, routing), null, 2));
        process.exit(1);
    }
}

async function assertDimensionsIfRequested(response) {
    if (!options.dimensionCheck) return response;
    return assertImageDimensions({
        response,
        expected: parseExpectedDimensions(requestBody.size),
        baseUrl,
        authHeaders,
        timeoutMs,
        readUrlFields: DIMENSION_CHECK_URL_FIELDS
    });
}

async function maybeCreateShares(output) {
    const images = Array.isArray(output?.images) ? output.images : [];
    const shareResults = [];
    for (const image of images) {
        if (typeof image?.id !== 'string' || !image.id) continue;
        shareResults.push(await createShareForArtifact(image.id));
    }
    if (shareResults.length === 0) {
        throw new Error('--share 需要服务端返回可分享的 Agent artifact。');
    }
    return {
        share_results: shareResults,
        share_urls: shareResults.map((item) => item.share_url).filter(Boolean),
        direct_content_urls: shareResults.map((item) => item.direct_content_url).filter(Boolean)
    };
}

async function createShareForArtifact(artifactId) {
    const body = {};
    if (options.shareExpiresMinutes !== undefined) {
        body.expires_in_minutes = readConfiguredPositiveInteger(
            options.shareExpiresMinutes,
            '--share-expires-minutes',
            1
        );
    }
    if (process.env.GPT_IMAGE_SHARE_ACCESS_CODE !== undefined) {
        body.access_code = readShareAccessCodeFromEnv();
    }
    const { response, result, text } = await fetchJson(`${baseUrl}${buildAgentArtifactSharePath(artifactId)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders()
        },
        body: JSON.stringify(body),
        timeoutMs
    });
    if (!response.ok) {
        throw new Error(`创建分享链接失败，状态码 ${response.status}：${text || JSON.stringify(result)}`);
    }
    return {
        artifact_id: result?.artifact_id || artifactId,
        token: result?.token || null,
        share_url: resolveShareOutputUrl(result?.share_url),
        direct_content_url: resolveShareOutputUrl(result?.direct_content_url),
        expires_at: result?.expires_at ?? null,
        access_code_required: result?.access_code_required === true
    };
}

function readShareAccessCodeFromEnv() {
    const rawValue = process.env.GPT_IMAGE_SHARE_ACCESS_CODE;
    if (rawValue === undefined) return undefined;
    const accessCode = rawValue.trim();
    if (!accessCode) return undefined;
    if (accessCode.length < MIN_SHARE_ACCESS_CODE_LENGTH || accessCode.length > MAX_SHARE_ACCESS_CODE_LENGTH) {
        throw new Error('GPT_IMAGE_SHARE_ACCESS_CODE 长度必须在 8 到 128 个字符之间。');
    }
    return accessCode;
}

function resolveShareOutputUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    return new URL(value, `${baseUrl}/`).toString();
}

function buildPageSseFailureOutput(error, timing = completeScriptTiming(scriptTiming)) {
    const diagnostics = readPageSseDiagnostics(error);
    if (isScriptError(error)) {
        return buildPageSseScriptFailure(error, diagnostics, timing);
    }
    if (isPageSseRequestRejected(error)) {
        return buildPageSseRequestRejectedFailure(error, diagnostics, timing);
    }
    return buildBillablePageSseFailure(error, diagnostics, timing);
}

function buildPageSseRouting(fallbackMode) {
    return {
        ...buildPageSseSummaryRouting(),
        fallback_endpoint: AGENT_ENDPOINTS.create_image_request,
        fallback_mode: fallbackMode
    };
}

function buildPageSseSummaryRouting() {
    return {
        transport: 'page_sse',
        endpoint: PAGE_SSE_ENDPOINT,
        route_mode: 'page_sse',
        image_backend: normalizeImageBackendForPage(requestBody?.image_backend),
        stream_mode: requestBody?.stream_mode || null,
        streaming_strategy: requestBody?.streaming_strategy || null
    };
}

function buildPageSseScriptFailure(error, diagnostics, timing) {
    const output = {
        ok: false,
        billable: false,
        error: {
            code: error.scriptCode,
            message: errorMessage(error),
            ...(diagnostics ? { diagnostics } : {})
        },
        routing: buildPageSseRouting('manual_after_diagnosis'),
        next_step: '先补齐页面流式 capability 或访问码哈希，再重新执行；不要静默切换到其他端点。'
    };
    return attachSummary(
        output,
        buildFailureSummary({
            errorBody: output,
            routing: output.routing,
            timing,
            idempotencyKey,
            billable: false,
            nextAction: 'fix_capability_or_auth'
        })
    );
}

function buildPageSseRequestRejectedFailure(error, diagnostics, timing) {
    const output = {
        ok: false,
        billable: false,
        error: {
            code: 'page_sse_request_rejected',
            status: error.status,
            message: errorMessage(error),
            ...(diagnostics ? { diagnostics } : {})
        },
        routing: buildPageSseRouting('fix_request_before_retry'),
        next_step: '先修正页面端拒绝的请求参数或鉴权，再重新执行；这类本地 4xx 不应按上游计费失败处理。'
    };
    return attachSummary(
        output,
        buildFailureSummary({
            errorBody: output,
            routing: output.routing,
            timing,
            idempotencyKey,
            billable: false,
            nextAction: 'fix_request_before_retry'
        })
    );
}

function buildBillablePageSseFailure(error, diagnostics, timing) {
    const output = {
        ok: false,
        billable: true,
        error: {
            code: 'page_sse_failed',
            ...buildPageSseFailureStatus(error),
            message: errorMessage(error),
            ...(diagnostics ? { diagnostics } : {})
        },
        routing: buildPageSseRouting('manual_after_diagnosis'),
        next_step:
            '先用 diagnose-request 诊断页面流式失败原因，再用新的 Idempotency-Key 显式选择服务端编排入口或其他诊断路径。'
    };
    return attachSummary(
        output,
        buildFailureSummary({
            errorBody: output,
            routing: output.routing,
            timing,
            idempotencyKey,
            billable: true,
            nextAction: 'diagnose_then_new_idempotency_key'
        })
    );
}

function buildFailureOutput(output, routing) {
    return attachSummary(
        output,
        buildFailureSummary({
            errorBody: output,
            routing,
            timing: completeScriptTiming(scriptTiming),
            idempotencyKey,
            billable: output?.billable !== false,
            nextAction: output?.next_step
        })
    );
}

function buildDimensionCheckFailureOutput(error, routing) {
    return buildFailureOutput(buildDimensionCheckFailureBody(error, routing), routing);
}

async function buildAgentFailureOutput(output, routing) {
    const failure = buildFailureOutput(output, routing);
    const enriched = await enrichFailureWithAgentDiagnostics({
        baseUrl,
        authHeaders,
        idempotencyKey,
        failureOutput: failure,
        summary: failure.summary,
        timeoutMs
    });
    return attachSummary(enriched.failureOutput, enriched.summary);
}

function buildPageSseFailureStatus(error) {
    if (error && typeof error === 'object') {
        if (Number.isInteger(error.streamStatus)) return { status: error.streamStatus };
        if (Number.isInteger(error.status)) return { status: error.status };
    }
    return {};
}

function withPageSseDiagnostics(error, state) {
    error.pageSseDiagnostics = buildPageSseDiagnostics(state);
    return error;
}

function readPageSseDiagnostics(error) {
    if (!error || typeof error !== 'object' || !error.pageSseDiagnostics) return undefined;
    return error.pageSseDiagnostics;
}

function buildPageSseDiagnostics(state) {
    return {
        partial_image_count: state.partialImageCount,
        completed_event_count: state.completedEventCount,
        done_received: state.doneReceived,
        final_image_count: state.completedImages.length,
        ...(state.lastEventType ? { last_upstream_event_type: state.lastEventType } : {})
    };
}

async function runGenerateJob(options = {}) {
    const createEndpoint = options.createEndpoint || AGENT_ENDPOINTS.create_generate_job;
    const routing = options.routing || { transport: 'agent_job_polling', endpoint: createEndpoint };
    let lastResult;
    let lastRetryAfter = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const { response, result } = await fetchJson(`${baseUrl}${createEndpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey,
                ...authHeaders()
            },
            body: JSON.stringify(requestBody),
            timeoutMs
        });

        if (response.ok) {
            const jobResult = await pollJobResult(result?.job);
            await writeSuccessOutputAndExit(enrichImageUrls(jobResult), routing, completeScriptTiming(scriptTiming));
        }

        const retryAfter = parseRetryAfterValue(response.headers.get('retry-after'));
        lastResult = result;
        lastRetryAfter = retryAfter;
        if (!shouldRetry(result) || attempt === maxAttempts) break;
        await sleep(retryAfter);
    }

    console.error(JSON.stringify(buildFailureOutput({ ...lastResult, retry_after: lastRetryAfter }, routing), null, 2));
    process.exit(1);
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
    let lastRetryAfter = job.retry_after_seconds || 1;

    while (Date.now() < deadlineMs) {
        const { response, result } = await fetchJson(resultUrl, {
            headers: authHeaders(),
            timeoutMs
        });
        if (response.ok) return result;

        const retryAfter = parseRetryAfterValue(response.headers.get('retry-after')) || lastRetryAfter;
        lastResult = result;
        lastRetryAfter = retryAfter;
        if (result?.error?.code !== 'request_in_progress' || !result?.error?.retryable) break;
        await sleep(retryAfter);
    }

    console.error(
        JSON.stringify(
            buildFailureOutput(
                { ...lastResult, retry_after: lastRetryAfter },
                { transport: 'agent_job_polling', endpoint: buildAgentJobResultPath(job.id) }
            ),
            null,
            2
        )
    );
    process.exit(1);
}

async function runContractCheck(capabilitiesValue) {
    const checks = [];
    checks.push(await checkContractEndpoint(AGENT_ENDPOINTS.generate));

    if (shouldRequireServerOrchestrationContract()) {
        checks.push(await checkContractEndpoint(readRequiredOrchestrationEndpoint(capabilitiesValue)));
    } else if (supportsServerOrchestration(capabilitiesValue)) {
        checks.push(await checkContractEndpoint(readOrchestrationEndpoint(capabilitiesValue)));
    }

    if (supportsJobPolling(capabilitiesValue)) {
        checks.push(await checkContractEndpoint(AGENT_ENDPOINTS.create_generate_job));
    }

    if (supportsPageSse(capabilitiesValue)) {
        const pageSse = capabilitiesValue?.agent_streaming?.page_sse;
        if (pageSse?.auth?.required === true && !passwordHash) {
            checks.push({
                endpoint: PAGE_SSE_ENDPOINT,
                skipped: true,
                reason: '页面 SSE 需要 passwordHash；contract-check 在未提供 GPT_IMAGE_APP_PASSWORD_HASH 时跳过。'
            });
        } else {
            checks.push(await checkPageSseContract());
        }
    }

    console.log(JSON.stringify({ ok: true, billable: false, checks }, null, 2));
}

async function checkContractEndpoint(endpoint) {
    const { response, result } = await fetchJson(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders()
        },
        body: JSON.stringify(requestBody),
        timeoutMs
    });
    if (response.status !== 400 || result?.error?.code !== 'idempotency_key_required') {
        console.error(
            JSON.stringify({ ok: false, billable: false, endpoint, status: response.status, result }, null, 2)
        );
        process.exit(1);
    }
    return { endpoint, status: response.status, error_code: result.error.code };
}

async function checkPageSseContract() {
    const formData = new FormData();
    formData.append('mode', 'generate');
    formData.append('prompt', 'contract check');
    formData.append('model', requestBody.model);
    formData.append('n', String(requestBody.n));
    formData.append('size', requestBody.size);
    formData.append('quality', requestBody.quality);
    formData.append('output_format', requestBody.output_format);
    formData.append('response_mode', requestBody.response_mode);
    formData.append('clientRequestId', 'x'.repeat(pageSseClientRequestIdMaxLength + 1));
    if (passwordHash) formData.append('passwordHash', passwordHash);
    const { response, text } = await fetchJson(`${baseUrl}${PAGE_SSE_ENDPOINT}`, {
        method: 'POST',
        body: formData,
        timeoutMs
    });
    if (response.status !== 400 || !text.includes('clientRequestId')) {
        console.error(
            JSON.stringify(
                { ok: false, billable: false, endpoint: PAGE_SSE_ENDPOINT, status: response.status, text },
                null,
                2
            )
        );
        process.exit(1);
    }
    return {
        endpoint: PAGE_SSE_ENDPOINT,
        status: response.status,
        error_code: 'page_sse_client_request_id_too_long'
    };
}

function readOrchestrationEndpoint(capabilitiesValue) {
    const endpoint = capabilitiesValue?.orchestration?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
        console.error(
            JSON.stringify(
                {
                    ok: false,
                    billable: false,
                    error: {
                        code: 'invalid_orchestration_endpoint',
                        message: 'capabilities.orchestration.endpoint 必须是以 / 开头的路径。'
                    },
                    orchestration: capabilitiesValue?.orchestration ?? null
                },
                null,
                2
            )
        );
        process.exit(1);
    }
    return endpoint;
}

function shouldRequireServerOrchestrationContract() {
    return options.routeMode === 'auto' && shouldPreferServerOrchestration(requestBody);
}

function readRequiredOrchestrationEndpoint(capabilitiesValue) {
    if (!supportsServerOrchestration(capabilitiesValue)) {
        console.error(
            JSON.stringify(
                {
                    ok: false,
                    billable: false,
                    error: {
                        code: 'orchestration_required',
                        message:
                            '默认 generate 需要 capabilities.orchestration.supported=true 且 transport_selection=server_owned。'
                    },
                    orchestration: capabilitiesValue?.orchestration ?? null
                },
                null,
                2
            )
        );
        process.exit(1);
    }
    return readOrchestrationEndpoint(capabilitiesValue);
}

async function fetchJson(url, init) {
    try {
        const response = await fetchWithTimeout(url, init);
        const text = await response.text();
        const result = parseJsonResponse(text, response.ok, url);
        return { response, result, text };
    } catch (error) {
        const message = errorMessage(error);
        if (message.startsWith(`请求失败：${url}。`)) {
            throw error;
        }
        throw new Error(`请求失败：${url}。${message}`);
    }
}

async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? timeoutMs);
    try {
        const fetchInit = { ...init };
        delete fetchInit.timeoutMs;
        return await fetch(url, { ...fetchInit, signal: controller.signal });
    } catch (error) {
        const message = errorMessage(error);
        throw new Error(`请求失败：${url}。${message}`);
    } finally {
        clearTimeout(timeout);
    }
}

function readErrorFromJsonText(text) {
    let result;
    try {
        result = parseJsonResponse(text, false, '');
    } catch {
        return undefined;
    }
    if (typeof result?.error === 'string') return result.error;
    if (typeof result?.error?.message === 'string') return result.error.message;
    return undefined;
}

function parseJsonResponse(text, isOk, url) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (error) {
        if (!isOk) return null;
        const message = errorMessage(error);
        throw new Error(`响应不是有效 JSON：${url}。${message}`);
    }
}

function shouldRetry(result) {
    return Boolean(result?.error?.retryable);
}

function supportsJobPolling(capabilitiesValue) {
    return Boolean(
        capabilitiesValue?.agent_jobs?.supported === true && capabilitiesValue.agent_jobs.mode === 'job_polling'
    );
}

function supportsServerOrchestration(capabilitiesValue) {
    return Boolean(
        capabilitiesValue?.orchestration?.supported === true &&
        capabilitiesValue.orchestration.transport_selection === 'server_owned'
    );
}

function supportsPageSse(capabilitiesValue) {
    return Boolean(capabilitiesValue?.agent_streaming?.page_sse?.supported === true);
}

function shouldUseServerOrchestration(capabilitiesValue, request, routeMode) {
    if (routeMode !== 'auto' || !shouldPreferServerOrchestration(request)) return false;
    if (!supportsServerOrchestration(capabilitiesValue)) {
        throw new Error('服务 capabilities 未声明 orchestration.supported=true，不能调用统一生成入口。');
    }
    return true;
}

function shouldUseJobPolling(capabilitiesValue, routeMode) {
    if (routeMode !== 'job') return false;
    if (!supportsJobPolling(capabilitiesValue)) {
        throw new Error('服务 capabilities 未声明 agent_jobs.supported=true，不能调用 job endpoint。');
    }
    return true;
}

function shouldUsePageSse(capabilitiesValue, request, routeMode) {
    if (routeMode === 'agent' || routeMode === 'job') return false;
    if (!isPageSseAllowed(request)) {
        if (routeMode === 'page_sse') {
            throw new Error('stream_mode=non_stream 或 streaming_strategy=off 时不能强制使用页面 SSE。');
        }
        return false;
    }
    if (routeMode === 'page_sse') {
        assertPageSseReady(capabilitiesValue);
        return true;
    }
    return false;
}

function shouldPreferServerOrchestration(request) {
    return true;
}

function isPageSseAllowed(request) {
    const streamingStrategy = request.streaming_strategy ?? request.streamingStrategy;
    const streamMode = request.stream_mode ?? request.streamMode;
    return streamingStrategy !== 'off' && streamMode !== 'non_stream';
}

function createScriptError(code, message) {
    const error = new Error(message);
    error.scriptCode = code;
    return error;
}

function isScriptError(error) {
    return Boolean(error && typeof error === 'object' && typeof error.scriptCode === 'string');
}

function createPageSseHttpError(status, detail) {
    const message = detail ? `页面 SSE 请求失败，状态码 ${status}：${detail}` : `页面 SSE 请求失败，状态码 ${status}。`;
    const error = new Error(message);
    error.status = status;
    return error;
}

function isPageSseRequestRejected(error) {
    return Boolean(
        error &&
        typeof error === 'object' &&
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status < 500
    );
}

function printUsage() {
    console.error('用法：generate-image.mjs [options] <prompt>');
    console.error('默认只输出 dry-run；添加 --allow-billable 才会真实生图。');
    console.error(
        '常用参数：--model --size --quality --n --format --output-compression --response-mode --image-backend --responses-model --gpt-model --thinking --prompt-optimization --force-web --force-request --stream-mode --streaming-strategy --partial-images --share --share-expires-minutes --dimension-check --sse-log --timeout-ms --base-url --prompt-file --idempotency-key --check-remote --page-sse --agent --job --no-job(兼容别名)'
    );
    console.error(
        '契约检查：GPT_IMAGE_AGENT_CONTRACT_CHECK=1 generate-image.mjs 或 generate-image.mjs --contract-check'
    );
}
