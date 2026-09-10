import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MAX_RETRY_AFTER_SECONDS = 60;
const DIGITS_PATTERN = /^\d+$/;
const IMAGE_SIZE_PATTERN = /^(\d+)x(\d+)$/;
const LEGACY_IMAGE_SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
const LEGACY_IMAGE_MODELS = new Set(['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5']);
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
export const DEFAULT_PLAYGROUND_BASE_URL = 'http://localhost:4783';
const DEFAULT_PRIVATE_AGENT_ENV_FILE = '.env.agent.local';
const PRIVATE_AGENT_ENV_PREFIX = 'GPT_IMAGE_';
const PRIVATE_AGENT_ENV_NAMES = new Set(['AGENT_API_TOKEN']);
const DISABLE_PRIVATE_AGENT_ENV_VALUES = new Set(['0', 'false', 'no']);

export function loadPrivateAgentEnvFile(options = {}) {
    const env = options.env || process.env;
    if (isPrivateAgentEnvLoadingDisabled(env)) {
        return { loaded: false, skipped: true, reason: 'disabled_by_env' };
    }
    const cwd = options.cwd || process.cwd();
    const filePath = options.filePath || findPrivateAgentEnvFile(cwd);
    if (!existsSync(filePath)) {
        return { loaded: false, skipped: true, reason: 'file_not_found', path: filePath };
    }
    const entries = parsePrivateAgentEnvContent(readFileSync(filePath, 'utf8'));
    const appliedNames = [];
    for (const { name, value } of entries) {
        if (!name.startsWith(PRIVATE_AGENT_ENV_PREFIX) && !PRIVATE_AGENT_ENV_NAMES.has(name)) continue;
        if (env[name] !== undefined) continue;
        env[name] = value;
        appliedNames.push(name);
    }
    return {
        loaded: true,
        path: filePath,
        applied_names: appliedNames
    };
}

export function resolveAgentToken(env = process.env) {
    return env.GPT_IMAGE_AGENT_TOKEN || env.AGENT_API_TOKEN || '';
}

export function readOptionValue(argv, index, name) {
    const value = argv[index];
    if (!value || value.startsWith('--')) {
        throw new Error(`${name} 需要参数值。`);
    }
    return value;
}

export function readConfiguredPositiveInteger(value, name, fallback) {
    const rawValue = value === undefined || value === null ? '' : String(value).trim();
    if (!rawValue) return fallback;
    if (!DIGITS_PATTERN.test(rawValue)) {
        throw new Error(`${name} 必须是正整数。`);
    }
    const parsed = Number(rawValue);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} 必须是正整数。`);
    }
    return parsed;
}

export function readConfiguredNonNegativeInteger(value, name, fallback) {
    const rawValue = value === undefined || value === null ? '' : String(value).trim();
    if (!rawValue) return fallback;
    if (!DIGITS_PATTERN.test(rawValue)) {
        throw new Error(`${name} 必须是非负整数。`);
    }
    const parsed = Number(rawValue);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${name} 必须是非负整数。`);
    }
    return parsed;
}

export function readCapabilitiesImageTransportTimeoutMs(capabilities, fallback) {
    const value = capabilities?.image_transport?.upstream_timeout_ms;
    if (!Number.isSafeInteger(value) || value < 1) return fallback;
    return Math.max(fallback, value);
}

export function readPartialImages(value, name = 'partial_images') {
    const parsed = readConfiguredNonNegativeInteger(value, name, 2);
    if (parsed < 0 || parsed > 4) {
        throw new Error(`${name} 必须是 0 到 4 的整数。`);
    }
    return parsed;
}

export function resolveCapabilitiesDefaultImageModel(capabilities, fallback = DEFAULT_IMAGE_MODEL) {
    const value = capabilities?.defaults?.model;
    return typeof value === 'string' && /^[^\s]{1,200}$/.test(value.trim()) ? value.trim() : fallback;
}

export function resolveConfiguredDefaultImageModel(env = process.env, fallback = DEFAULT_IMAGE_MODEL) {
    const value = env.OPENAI_IMAGE_MODEL;
    return typeof value === 'string' && /^[^\s]{1,200}$/.test(value.trim()) ? value.trim() : fallback;
}

export function validateAgentGenerateRequestAgainstCapabilities(body, capabilities) {
    assertNumberWithinCapabilities(
        body.n,
        readImageCountLimitForBackend(body.image_backend ?? body.imageBackend, capabilities, 'generate_images'),
        'n'
    );
    const partialImagesRange = resolvePartialImagesValidationRange(body, capabilities, 'generate');
    if (partialImagesRange) assertNumberWithinCapabilities(body.partial_images, partialImagesRange, 'partial_images');
}

export function validateAgentEditRequestAgainstCapabilities(input, capabilities) {
    assertNumberWithinCapabilities(
        input.n,
        readImageCountLimitForBackend(input.image_backend ?? input.imageBackend, capabilities, 'edit_images'),
        'n'
    );
    const partialImagesRange = resolvePartialImagesValidationRange(input, capabilities, 'edit');
    if (partialImagesRange) assertNumberWithinCapabilities(input.partial_images, partialImagesRange, 'partial_images');
    assertEditUploadCount(input, capabilities);
}

const NON_STREAM_PARTIAL_IMAGES_RANGE = { min: 0, max: 4 };

function resolvePartialImagesValidationRange(input, capabilities, operation) {
    if (input.partial_images === undefined || input.partial_images === null || input.partial_images === '')
        return undefined;
    const streamMode = input.stream_mode ?? input.streamMode ?? 'auto';
    const streamingStrategy = input.streaming_strategy ?? input.streamingStrategy ?? 'auto';
    const backend = normalizeImageBackend(input.image_backend ?? input.imageBackend);
    const requestModes = resolveRequestModes(streamMode, streamingStrategy, backend);
    if (requestModes.every((requestMode) => !isStreamingRequestMode(requestMode))) {
        return NON_STREAM_PARTIAL_IMAGES_RANGE;
    }

    const channels = capabilities?.upstream_request_headers?.channels;
    if (!Array.isArray(channels) || channels.length === 0 || !channels.every((channel) => channel?.constraints)) {
        return readPartialImagesLimitForBackend(input.image_backend ?? input.imageBackend, capabilities);
    }

    const candidates = readCapabilityChannelCandidates(input, capabilities, operation, requestModes);
    if (candidates.length === 0) {
        return readPartialImagesLimitForBackend(input.image_backend ?? input.imageBackend, capabilities);
    }

    const ranges = [];
    for (const candidate of candidates) {
        for (const requestMode of candidate.requestModes) {
            ranges.push(
                isStreamingRequestMode(requestMode)
                    ? readChannelPartialImagesRange(candidate.channel, candidate.backend)
                    : NON_STREAM_PARTIAL_IMAGES_RANGE
            );
        }
    }
    return (
        unionNumericRanges(ranges.filter(Boolean)) ||
        readPartialImagesLimitForBackend(input.image_backend ?? input.imageBackend, capabilities)
    );
}

function normalizeImageBackend(value) {
    return value === 'responses' || value === 'responses-image-generation'
        ? 'responses-image-generation'
        : 'images-api';
}

function readPartialImagesLimitForBackend(backend, capabilities) {
    const normalizedBackend =
        backend === 'responses' || backend === 'responses-image-generation'
            ? 'responses-image-generation'
            : 'images-api';
    return capabilities?.limits?.partial_images_by_backend?.[normalizedBackend] || capabilities?.limits?.partial_images;
}

function resolveRequestModes(streamMode, streamingStrategy, backend) {
    const nonStreamRequestMode =
        backend === 'responses-image-generation' ? 'responses-non-stream' : 'images-non-stream';
    const streamingRequestMode = backend === 'responses-image-generation' ? 'responses-sse' : 'images-sse';
    if (streamMode === 'non_stream' || (streamMode === 'auto' && streamingStrategy === 'off')) {
        return [nonStreamRequestMode];
    }
    if (streamMode === 'stream' || streamingStrategy !== 'auto') return [streamingRequestMode];
    return [nonStreamRequestMode, streamingRequestMode];
}

function isStreamingRequestMode(requestMode) {
    return requestMode === 'images-sse' || requestMode === 'responses-sse';
}

function readCapabilityChannelCandidates(input, capabilities, operation, requestModes) {
    const backend = normalizeImageBackend(input.image_backend ?? input.imageBackend);
    const channels = capabilities?.upstream_request_headers?.channels;
    if (!Array.isArray(channels)) return [];
    return channels.flatMap((channel) => {
        if (!channel?.constraints) return [];
        const channelModes = requestModes.filter((requestMode) => channelSupportsRequestMode(channel, requestMode));
        if (
            channelModes.length === 0 ||
            !channelSupportsCommonInput(input, capabilities, channel, operation, backend)
        ) {
            return [];
        }
        return [{ channel, backend, requestModes: channelModes }];
    });
}

function channelSupportsRequestMode(channel, requestMode) {
    if (!Array.isArray(channel.request_modes) || !channel.request_modes.includes(requestMode)) return false;
    if (channel.healthy_request_modes === undefined) return true;
    return Array.isArray(channel.healthy_request_modes) && channel.healthy_request_modes.includes(requestMode);
}

function channelSupportsCommonInput(input, capabilities, channel, operation, backend) {
    const countRange = readChannelImageCountRange(channel, operation, backend);
    if (!countRange || !isIntegerWithinCapabilityRange(input.n, countRange)) return false;
    if (operation === 'edit' && Number.isSafeInteger(input.imageCount)) {
        if (input.imageCount > channel.constraints.upload_images.max) return false;
        // image_sizes contains one source-image size per item, measured in bytes.
        const imageSizes = Array.isArray(input.image_sizes) ? input.image_sizes : [];
        if (
            imageSizes.some(
                (size) =>
                    typeof size === 'number' && size > channel.constraints.upload_images.max_single_mb * 1024 * 1024
            )
        ) {
            return false;
        }
        if (
            channel.constraints.upload_images.max_total_mb !== undefined &&
            imageSizes.length > 0 &&
            imageSizes.reduce((total, size) => total + (typeof size === 'number' ? size : 0), 0) >
                channel.constraints.upload_images.max_total_mb * 1024 * 1024
        ) {
            return false;
        }
    }
    if (input.force_request === true || input.forceRequest === true) return true;
    const model = input.model || capabilities?.defaults?.model || DEFAULT_IMAGE_MODEL;
    if (!isGptImage2Model(model)) return true;
    const gptImage2 = channel.constraints.gpt_image_2;
    const background = input.background || 'auto';
    if (background === 'transparent' && !gptImage2.allow_transparent_background) return false;
    return isGptImage2SizeCompatible(
        input.size || (operation === 'generate' ? '1024x1024' : 'auto'),
        gptImage2,
        capabilities,
        model
    );
}

function isGptImage2Model(model) {
    return model === 'gpt-image-2' || model === 'gpt-image-2-1k';
}

function isGptImage2SizeCompatible(size, constraints, capabilities, model) {
    if (size === 'auto') return true;
    const match = IMAGE_SIZE_PATTERN.exec(String(size));
    if (!match) return false;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return false;
    if (constraints.size_policy === 'positive-integer') return true;
    const limits = capabilities?.model_limits?.[model] || capabilities?.model_limits?.['gpt-image-2'];
    if (!limits) return true;
    const maxEdge = Math.max(width, height);
    const minEdge = Math.min(width, height);
    const pixels = width * height;
    return (
        width % limits.edge_multiple === 0 &&
        height % limits.edge_multiple === 0 &&
        maxEdge <= limits.max_edge &&
        pixels <= limits.max_pixels &&
        pixels >= limits.min_pixels &&
        maxEdge / minEdge <= limits.max_aspect
    );
}

function readChannelImageCountRange(channel, operation, backend) {
    const key = operation === 'generate' ? 'generate_images_by_backend' : 'edit_images_by_backend';
    return (
        channel.constraints?.[key]?.[backend] ||
        (backend === 'images-api' ? channel.constraints?.[`${operation}_images`] : undefined)
    );
}

function readChannelPartialImagesRange(channel, backend) {
    return (
        channel.constraints?.partial_images_by_backend?.[backend] ||
        (backend === 'images-api' ? channel.constraints?.partial_images : undefined)
    );
}

function unionNumericRanges(ranges) {
    const values = ranges.flatMap((range) => {
        const allowedValues = Array.isArray(range.allowedValues)
            ? range.allowedValues
            : Array.isArray(range.allowed_values)
              ? range.allowed_values
              : undefined;
        return allowedValues || Array.from({ length: range.max - range.min + 1 }, (_, index) => range.min + index);
    });
    const normalized = Array.from(new Set(values.filter(Number.isSafeInteger))).sort((left, right) => left - right);
    if (normalized.length === 0) return undefined;
    const min = normalized[0];
    const max = normalized[normalized.length - 1];
    return normalized.length === max - min + 1 ? { min, max } : { min, max, allowedValues: normalized };
}

function assertEditUploadCount(input, capabilities) {
    const channels = capabilities?.upstream_request_headers?.channels;
    if (Array.isArray(channels) && channels.length > 0 && channels.every((channel) => channel?.constraints)) {
        const max = Math.max(...channels.map((channel) => channel.constraints.upload_images.max));
        assertMaxCountWithinCapabilities(input.imageCount, max, 'image');
        return;
    }
    assertMaxCountWithinCapabilities(input.imageCount, capabilities?.limits?.upload_images?.max, 'image');
}

function readImageCountLimitForBackend(backend, capabilities, legacyField) {
    const normalizedBackend =
        backend === 'responses' || backend === 'responses-image-generation'
            ? 'responses-image-generation'
            : 'images-api';
    return (
        capabilities?.limits?.[`${legacyField}_by_backend`]?.[normalizedBackend] || capabilities?.limits?.[legacyField]
    );
}

function assertNumberWithinCapabilities(value, limits, fieldName) {
    if (value === undefined || value === null || !limits) return;
    const allowedValues = Array.isArray(limits.allowedValues)
        ? limits.allowedValues
        : Array.isArray(limits.allowed_values)
          ? limits.allowed_values
          : undefined;
    if (allowedValues && !allowedValues.includes(value)) {
        throw new Error(`${fieldName} 必须是当前 capabilities 允许的值之一：${allowedValues.join(', ')}。`);
    }
    const min = limits.min;
    const max = limits.max;
    const hasMin = Number.isSafeInteger(min);
    const hasMax = Number.isSafeInteger(max);
    if (hasMin && hasMax && (value < min || value > max)) {
        throw new Error(`${fieldName} 必须在当前 capabilities 允许的 ${min} 到 ${max} 之间。`);
    }
    if (hasMin && value < min) {
        throw new Error(`${fieldName} 不能小于当前 capabilities 允许的最小值 ${min}。`);
    }
    if (hasMax && value > max) {
        throw new Error(`${fieldName} 不能大于当前 capabilities 允许的最大值 ${max}。`);
    }
}

function isIntegerWithinCapabilityRange(value, limits) {
    if (!Number.isSafeInteger(value) || !limits) return false;
    const allowedValues = Array.isArray(limits.allowedValues)
        ? limits.allowedValues
        : Array.isArray(limits.allowed_values)
          ? limits.allowed_values
          : undefined;
    if (allowedValues && !allowedValues.includes(value)) return false;
    const min = limits.min;
    const max = limits.max;
    if (Number.isSafeInteger(min) && value < min) return false;
    if (Number.isSafeInteger(max) && value > max) return false;
    return true;
}

function assertMaxCountWithinCapabilities(value, max, fieldName) {
    if (value === undefined || value === null || !Number.isSafeInteger(max)) return;
    if (value > max) {
        throw new Error(`${fieldName} 数量不能超过当前 capabilities 允许的 ${max}。`);
    }
}

export function normalizeBaseUrl(value) {
    const normalized = String(value || '')
        .trim()
        .replace(/\/+$/, '');
    let parsed;
    try {
        parsed = new URL(normalized);
    } catch {
        throw new Error('base URL 必须是有效的 http/https 绝对 URL。');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('base URL 必须使用 http 或 https。');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('base URL 不能包含凭据、查询参数或片段。');
    }
    return normalized;
}

export function resolvePlaygroundBaseUrl(explicitBaseUrl, env = process.env) {
    if (explicitBaseUrl) {
        return {
            baseUrl: normalizeBaseUrl(explicitBaseUrl),
            source: 'user_provided',
            interactive_confirmation_required: false
        };
    }
    if (env.GPT_IMAGE_PLAYGROUND_URL) {
        return {
            baseUrl: normalizeBaseUrl(env.GPT_IMAGE_PLAYGROUND_URL),
            source: 'GPT_IMAGE_PLAYGROUND_URL',
            interactive_confirmation_required: true
        };
    }
    return {
        baseUrl: DEFAULT_PLAYGROUND_BASE_URL,
        source: 'default_local_probe',
        interactive_confirmation_required: true
    };
}

export function normalizeOutputFormat(value) {
    return value.toLowerCase() === 'jpg' ? 'jpeg' : value.toLowerCase();
}

export function assertValidImageSizeForModel(value, model, label = 'size') {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} 必须是字符串。`);
    }
    if (!isGptImage2Model(model)) {
        if (!LEGACY_IMAGE_MODELS.has(model)) {
            if (value === 'auto') return value;
            const size = parseImageSizeValue(value);
            if (!size) throw new Error(`${label} 必须是 auto 或 WIDTHxHEIGHT。`);
            assertPositiveIntegerDimensions(size.width, size.height, label);
            return value;
        }
        if (!LEGACY_IMAGE_SIZES.has(value)) {
            throw new Error(`${label} 对自定义模型 ${model} 无效；请使用 auto、1024x1024、1536x1024 或 1024x1536。`);
        }
        return value;
    }
    if (value === 'auto') return value;
    const size = parseImageSizeValue(value);
    if (!size) throw new Error(`${label} 必须是 auto 或 WIDTHxHEIGHT。`);
    assertPositiveIntegerDimensions(size.width, size.height, label);
    return value;
}

export function parseImageSizeValue(value) {
    if (typeof value !== 'string') return undefined;
    const match = IMAGE_SIZE_PATTERN.exec(value);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

export function readMaxImageEdge(value) {
    const size = parseImageSizeValue(value);
    return size ? Math.max(size.width, size.height) : 0;
}

export function parseRetryAfterValue(value, fallback = 1) {
    if (!value || !/^\d+$/.test(value)) return clampRetryAfterSeconds(fallback);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) return MAX_RETRY_AFTER_SECONDS;
    return clampRetryAfterSeconds(parsed);
}

export function sleep(seconds) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function clampRetryAfterSeconds(value) {
    if (!Number.isFinite(value)) return MAX_RETRY_AFTER_SECONDS;
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.round(value)));
}

export function resolveSameOriginUrl(baseUrl, value, label) {
    const base = new URL(baseUrl);
    const resolved = new URL(value, `${baseUrl}/`);
    if (resolved.origin !== base.origin) {
        throw new Error(`${label} 指向不同 origin，拒绝携带鉴权头访问。`);
    }
    return resolved.toString();
}

export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function isPrivateAgentEnvLoadingDisabled(env) {
    return DISABLE_PRIVATE_AGENT_ENV_VALUES.has(
        String(env.GPT_IMAGE_AGENT_LOAD_ENV_FILE || '')
            .trim()
            .toLowerCase()
    );
}

function findPrivateAgentEnvFile(cwd) {
    const start = resolve(cwd);
    let current = start;
    while (true) {
        const candidate = join(current, DEFAULT_PRIVATE_AGENT_ENV_FILE);
        if (existsSync(candidate)) return candidate;
        if (isPrivateAgentEnvSearchBoundary(current) || dirname(current) === current) {
            return join(start, DEFAULT_PRIVATE_AGENT_ENV_FILE);
        }
        current = dirname(current);
    }
}

function isPrivateAgentEnvSearchBoundary(directory) {
    return (
        existsSync(join(directory, '.git')) || isPlaygroundProjectRoot(directory) || isStandaloneSkillRoot(directory)
    );
}

function isPlaygroundProjectRoot(directory) {
    return (
        existsSync(join(directory, 'package.json')) &&
        existsSync(join(directory, 'skills/visual-journal-image-agent/SKILL.md'))
    );
}

function isStandaloneSkillRoot(directory) {
    return (
        existsSync(join(directory, 'SKILL.md')) &&
        existsSync(join(directory, 'scripts')) &&
        !isPlaygroundProjectRoot(dirname(dirname(directory)))
    );
}

function parsePrivateAgentEnvContent(content) {
    const entries = [];
    for (const line of content.split(/\r?\n/)) {
        const parsed = parsePrivateAgentEnvLine(line);
        if (parsed) entries.push(parsed);
    }
    return entries;
}

function parsePrivateAgentEnvLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return undefined;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return undefined;
    return { name: match[1], value: parsePrivateAgentEnvValue(match[2].trim()) };
}

function parsePrivateAgentEnvValue(value) {
    if (value.length < 2) return value;
    if (value.startsWith('"') || value.startsWith("'")) return parseQuotedPrivateAgentEnvValue(value);
    return stripPrivateAgentEnvComment(value).trim();
}

function parseQuotedPrivateAgentEnvValue(value) {
    const quote = value[0];
    const closeIndex = value.indexOf(quote, 1);
    if (closeIndex < 0) return value.slice(1);
    return value.slice(1, closeIndex);
}

function stripPrivateAgentEnvComment(value) {
    const index = value.search(/\s#/);
    if (index < 0) return value;
    return value.slice(0, index);
}

function assertPositiveIntegerDimensions(width, height, label) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error(`${label} 的宽度和高度必须是正数。`);
    }
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
        throw new Error(`${label} 的宽度和高度必须是整数。`);
    }
}
