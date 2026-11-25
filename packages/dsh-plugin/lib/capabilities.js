import { AGENT_ENDPOINTS } from './client.js';

/**
 * Read the server's capability document. Capabilities are the single source of
 * truth for limits, so the plugin never copies ranges or field enumerations.
 */
export async function requestCapabilities(client) {
    const response = await client.request(AGENT_ENDPOINTS.capabilities);
    return requireObject(response, 'capabilities');
}

/** Read the model directory without probing upstream channels. */
export async function requestModels(client) {
    return client.request(AGENT_ENDPOINTS.models);
}

/**
 * Validate one `NumericRange` from capabilities, including the optional
 * `allowedValues` set that a mixed-channel deployment uses for discrete ranges.
 */
export function readNumericRange(value, label) {
    const range = requireObject(value, label);
    const { min, max } = range;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
        throw new Error(`capabilities 的 ${label} 不是有效的整数范围。`);
    }
    let allowedValues;
    if (range.allowedValues !== undefined) {
        if (!Array.isArray(range.allowedValues) || range.allowedValues.length === 0) {
            throw new Error(`capabilities 的 ${label}.allowedValues 必须是非空整数数组。`);
        }
        if (!range.allowedValues.every((entry) => Number.isInteger(entry))) {
            throw new Error(`capabilities 的 ${label}.allowedValues 必须只包含整数。`);
        }
        allowedValues = [...range.allowedValues].sort((left, right) => left - right);
    }
    return { min, max, ...(allowedValues === undefined ? {} : { allowedValues }) };
}

/** Intersect two validated ranges; a value must satisfy both to be usable. */
export function intersectRanges(base, extra, label) {
    const min = Math.max(base.min, extra.min);
    const max = Math.min(base.max, extra.max);
    if (min > max) throw new Error(`capabilities 的 ${label} 范围不相交，当前部署无法满足该组合。`);
    if (base.allowedValues === undefined)
        return {
            min,
            max,
            ...(extra.allowedValues === undefined
                ? {}
                : { allowedValues: extra.allowedValues.filter((value) => value >= min && value <= max) })
        };
    if (extra.allowedValues === undefined) {
        return { min, max, allowedValues: base.allowedValues.filter((value) => value >= min && value <= max) };
    }
    const allowedValues = base.allowedValues.filter((value) => extra.allowedValues.includes(value));
    if (allowedValues.length === 0) throw new Error(`capabilities 的 ${label} 没有同时满足两个来源的取值。`);
    return { min, max, allowedValues };
}

/** Assert one requested integer against a validated range. */
export function assertRangeValue(value, range, label) {
    if (!Number.isInteger(value)) throw new Error(`${label} 必须是整数。`);
    if (value < range.min || value > range.max) {
        throw new Error(`${label} 必须在 ${range.min} 到 ${range.max} 之间，当前为 ${value}。`);
    }
    if (range.allowedValues !== undefined && !range.allowedValues.includes(value)) {
        throw new Error(`${label} 只能是 ${range.allowedValues.join('、')} 之一，当前为 ${value}。`);
    }
    return value;
}

/**
 * Resolve the effective range for one field, intersecting the general range
 * with the backend-specific one. A named backend without its own range is
 * rejected instead of silently inheriting the general range.
 */
export function resolveBackendRange(limits, generalKey, backendKey, imageBackend, label) {
    const general = readNumericRange(limits[generalKey], `limits.${generalKey}`);
    const backend = normalizeNonEmpty(imageBackend);
    if (!backend) return general;
    const byBackend = requireObject(limits[backendKey], `limits.${backendKey}`);
    const specific = byBackend[backend];
    if (specific === undefined) {
        throw new Error(`capabilities 的 limits.${backendKey} 未声明 image_backend=${backend} 的范围。`);
    }
    return intersectRanges(general, readNumericRange(specific, `limits.${backendKey}.${backend}`), label);
}

/**
 * Validate the request against capabilities before any billable call. Only
 * fields actually present in the request are checked; the server remains the
 * final authority for everything else.
 */
export function assertGenerateWithinCapabilities(request, capabilities) {
    const limits = requireObject(requireObject(capabilities, 'capabilities').limits, 'capabilities.limits');
    const imageBackend = normalizeNonEmpty(request.image_backend);
    if (request.n !== undefined) {
        assertRangeValue(
            request.n,
            resolveBackendRange(limits, 'generate_images', 'generate_images_by_backend', imageBackend, 'n'),
            'n'
        );
    }
    if (request.partial_images !== undefined) {
        assertRangeValue(
            request.partial_images,
            resolveBackendRange(limits, 'partial_images', 'partial_images_by_backend', imageBackend, 'partial_images'),
            'partial_images'
        );
    }
}

/** Read the upload budget used by the edit tool, in bytes. */
export function readUploadLimits(capabilities) {
    const limits = requireObject(requireObject(capabilities, 'capabilities').limits, 'capabilities.limits');
    const uploadImages = requireObject(limits.upload_images, 'limits.upload_images');
    if (!Number.isInteger(uploadImages.max) || uploadImages.max < 1) {
        throw new Error('capabilities 的 limits.upload_images.max 无效。');
    }
    const perFileMb = limits.max_upload_mb;
    if (typeof perFileMb !== 'number' || !(perFileMb > 0)) {
        throw new Error('capabilities 的 limits.max_upload_mb 无效。');
    }
    const totalMb =
        typeof limits.max_total_upload_mb === 'number' ? limits.max_total_upload_mb : perFileMb * uploadImages.max;
    return {
        maxFiles: uploadImages.max,
        maxFileBytes: Math.floor(perFileMb * 1024 * 1024),
        maxTotalBytes: Math.floor(totalMb * 1024 * 1024)
    };
}

/** The declared default image backend, used only to label results. */
export function readDefaults(capabilities) {
    const defaults = requireObject(requireObject(capabilities, 'capabilities').defaults, 'capabilities.defaults');
    return {
        model: defaults.model,
        imageBackend: defaults.image_backend,
        streamMode: defaults.stream_mode,
        partialImages: defaults.partial_images
    };
}

function requireObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Visual Journal 的 ${label} 响应不是对象。`);
    }
    return value;
}

function normalizeNonEmpty(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
