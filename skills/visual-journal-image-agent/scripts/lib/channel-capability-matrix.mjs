import { normalizeBaseUrl } from './script-utils.mjs';

export const CHANNEL_CAPABILITY_REQUEST_MODES = Object.freeze([
  'images-non-stream',
  'images-sse',
  'responses-non-stream',
  'responses-sse'
]);

export const DEFAULT_CHANNEL_CAPABILITY_REQUEST_MODE_PRIORITY = Object.freeze([
  'images-non-stream',
  'images-sse',
  'responses-non-stream',
  'responses-sse'
]);

export const DEFAULT_ENABLED_CHANNEL_REQUEST_MODES = Object.freeze(['images-non-stream']);

const CHANNEL_CAPABILITY_REQUEST_MODE_ALIASES = Object.freeze({
  'images-api': 'images-non-stream',
  'images-api-json': 'images-non-stream',
  'images-json': 'images-non-stream',
  'images-nonstream': 'images-non-stream',
  'responses-api': 'responses-non-stream',
  'responses-api-json': 'responses-non-stream',
  'responses-json': 'responses-non-stream',
  'responses-nonstream': 'responses-non-stream'
});

const CONTROL_CHARACTER_PATTERN = /[\u0000\r\n]/;
const SAFE_UNQUOTED_ENV_VALUE_PATTERN = /^[A-Za-z0-9._/:,@%+=-]+$/;

export function resolveUpstreamApiKey(env = process.env) {
  const preferred = readNonEmptyString(env.GPT_IMAGE_UPSTREAM_API_KEY);
  if (preferred) return { value: preferred, source: 'GPT_IMAGE_UPSTREAM_API_KEY' };

  const fallback = readNonEmptyString(env.OPENAI_API_KEY);
  if (fallback) return { value: fallback, source: 'OPENAI_API_KEY' };

  return { value: '', source: undefined };
}

export function validateChannelApiKey(value) {
  if (!readNonEmptyString(value)) return { ok: false, reason: 'missing_api_key' };
  if (CONTROL_CHARACTER_PATTERN.test(value)) return { ok: false, reason: 'invalid_api_key_characters' };
  if (value.includes(',')) return { ok: false, reason: 'api_key_contains_comma' };
  return { ok: true };
}

export function validateChannelId(value) {
  const normalized = readNonEmptyString(value);
  if (!normalized) return { ok: false, reason: 'missing_channel_id' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
    return { ok: false, reason: 'invalid_channel_id' };
  }
  return { ok: true, value: normalized };
}

export function createDefaultChannelId(hostname, channelIndex) {
  const hostPart = String(hostname || 'upstream')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `channel-${channelIndex}-${hostPart || 'upstream'}`;
}

export function parseCapabilityRequestModes(value, fieldName = 'request_modes') {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  const normalized = [];
  for (const valuePart of values) {
    const valueText = String(valuePart).trim().toLowerCase().replace(/_/g, '-');
    if (!valueText) continue;
    if (valueText === 'all') {
      for (const requestMode of CHANNEL_CAPABILITY_REQUEST_MODES) {
        if (!normalized.includes(requestMode)) normalized.push(requestMode);
      }
      continue;
    }
    const requestMode = CHANNEL_CAPABILITY_REQUEST_MODE_ALIASES[valueText] || valueText;
    if (!CHANNEL_CAPABILITY_REQUEST_MODES.includes(requestMode)) {
      throw new Error(`invalid_${fieldName}`);
    }
    if (!normalized.includes(requestMode)) normalized.push(requestMode);
  }
  if (normalized.length === 0) throw new Error(`missing_${fieldName}`);
  return normalized;
}

export function buildCapabilityMatrix(input) {
  const report = isRecord(input.probeReport) ? input.probeReport : {};
  const requestModes = isRecord(report.request_modes) ? report.request_modes : {};
  const modeReports = isRecord(requestModes.modes) ? requestModes.modes : {};
  const requested = Array.isArray(requestModes.requested) ? requestModes.requested : [];
  const enabledRequestModes = normalizeRequestModes(input.enabledRequestModes || DEFAULT_ENABLED_CHANNEL_REQUEST_MODES);
  const requestModeSelection = Array.isArray(input.enabledRequestModes) ? 'explicit' : 'default';
  const modes = {};
  const passed = [];
  const failed = [];
  const skipped = [];

  for (const requestMode of CHANNEL_CAPABILITY_REQUEST_MODES) {
    const mode = isRecord(modeReports[requestMode]) ? modeReports[requestMode] : undefined;
    const summary = summarizeMode(requestMode, mode, input.redactText);
    modes[requestMode] = summary;
    if (summary.status === 'passed') passed.push(requestMode);
    else if (summary.status === 'skipped') skipped.push(requestMode);
    else failed.push(requestMode);
  }

  const models = summarizePreflight(report.models, input.redactText);
  const coverageComplete =
    CHANNEL_CAPABILITY_REQUEST_MODES.every((requestMode) => requested.includes(requestMode)) &&
    CHANNEL_CAPABILITY_REQUEST_MODES.every((requestMode) => isRecord(modeReports[requestMode]));
  const passedSet = new Set(passed);
  const enabledNotPassed = enabledRequestModes.filter((requestMode) => !passedSet.has(requestMode));
  const enabledPassed = enabledRequestModes.filter((requestMode) => passedSet.has(requestMode));
  const testedResponsesModes = passed.filter((requestMode) => requestMode.startsWith('responses-'));
  const enabledResponsesModes = enabledRequestModes.filter((requestMode) => requestMode.startsWith('responses-'));
  const responsesModel = readResponsesModel(modeReports, testedResponsesModes);
  const imageBackend = resolveDefaultImageBackend(enabledRequestModes);
  const blockingReasons = [];

  if (!input.allowBillable) blockingReasons.push('billable_verification_required');
  if (input.allowBillable && input.billableConfirmed !== true) blockingReasons.push('billable_confirmation_required');
  if (!models.ok) blockingReasons.push('models_preflight_failed');
  if (!coverageComplete) blockingReasons.push('incomplete_request_mode_matrix');
  if (!input.apiKeyValid) blockingReasons.push(input.apiKeyError || 'missing_api_key');
  if (passed.length === 0) blockingReasons.push('no_consumable_image_mode');
  if (enabledNotPassed.length > 0) blockingReasons.push('enabled_request_modes_not_passed');
  if (passed.length > 0 && enabledPassed.length === 0) blockingReasons.push('no_enabled_request_mode');
  if (enabledResponsesModes.length > 0 && !responsesModel) blockingReasons.push('missing_responses_model');

  return {
    requested: [...CHANNEL_CAPABILITY_REQUEST_MODES],
    coverage_complete: coverageComplete,
    fully_supported: passed.length === CHANNEL_CAPABILITY_REQUEST_MODES.length,
    passed,
    failed,
    skipped,
    modes,
    preflight: {
      dns: summarizePreflight(report.dns, input.redactText),
      tls: summarizePreflight(report.tls, input.redactText),
      models
    },
    configuration: {
      ready: blockingReasons.length === 0,
      blocking_reasons: blockingReasons,
      request_modes: enabledRequestModes,
      tested_request_modes: passed,
      enabled_request_modes: enabledRequestModes,
      default_enabled_request_modes: [...DEFAULT_ENABLED_CHANNEL_REQUEST_MODES],
      request_mode_selection: requestModeSelection,
      request_mode_priority: orderRequestModesByDefaultPriority(enabledRequestModes),
      tested_request_mode_priority: orderRequestModesByDefaultPriority(passed),
      ...(imageBackend ? { image_backend: imageBackend, streaming_strategy: 'auto' } : {}),
      responses_backend_required: enabledResponsesModes.length > 0,
      responses_model: enabledResponsesModes.length > 0 ? responsesModel || undefined : undefined,
      tested_responses_model: responsesModel || undefined
    }
  };
}

export function buildChannelEnvConfig(input) {
  const channelIndex = readPositiveChannelIndex(input.channelIndex);
  const channelId = readRequiredEnvValue(input.channelId, 'channel_id');
  assertValidChannelId(channelId);
  const baseUrl = normalizeBaseUrl(readRequiredEnvValue(input.baseUrl, 'base_url'));
  const apiKey = readRequiredEnvValue(input.apiKey, 'api_key');
  assertValidChannelApiKey(apiKey);
  const requestModes = normalizeRequestModes(input.requestModes);
  const requestModePriority = normalizeRequestModes(input.requestModePriority || requestModes);
  assertRequestModePrioritySubset(requestModePriority, requestModes);
  const responsesModel = readNonEmptyString(input.responsesModel);
  const hasResponsesMode = requestModes.some((requestMode) => requestMode.startsWith('responses-'));
  const imageBackend = resolveDefaultImageBackend(requestModes);
  const plainHttpAllowlistValue = resolvePlainHttpAllowlistValue(baseUrl, input.allowPlainHttp);

  if (hasResponsesMode && !responsesModel) {
    throw new Error('missing_responses_model');
  }
  if (!imageBackend) throw new Error('missing_image_backend');

  const prefix = `OPENAI_CHANNEL_${channelIndex}`;
  const lines = [
    '# Generated after a billable upstream capability matrix probe.',
    '# This file contains credentials. Keep it private and do not commit it.',
    `${prefix}_ID=${serializeEnvValue(channelId)}`,
    `${prefix}_BASE_URL=${serializeEnvValue(baseUrl)}`,
    `${prefix}_API_KEYS=${serializeEnvValue(apiKey)}`,
    `${prefix}_REQUEST_MODES=${serializeEnvValue(requestModes.join(','))}`,
    `${prefix}_REQUEST_MODE_PRIORITY=${serializeEnvValue(requestModePriority.join(','))}`,
    `IMAGE_GENERATION_BACKEND=${serializeEnvValue(imageBackend)}`,
    'IMAGE_STREAMING_STRATEGY=auto'
  ];

  if (plainHttpAllowlistValue) {
    lines.push(`OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS=${serializeEnvValue(plainHttpAllowlistValue)}`);
  }

  if (hasResponsesMode) {
    lines.push('ENABLE_RESPONSES_IMAGE_BACKEND=true');
    lines.push(`OPENAI_RESPONSES_API_MODEL=${serializeEnvValue(responsesModel)}`);
  }

  return `${lines.join('\n')}\n`;
}

export function buildRedactedChannelEnvPreview(input) {
  const channelIndex = readPositiveChannelIndex(input.channelIndex);
  const requestModes = normalizeRequestModes(input.requestModes);
  const requestModePriority = normalizeRequestModes(input.requestModePriority || requestModes);
  const imageBackend = resolveDefaultImageBackend(requestModes);
  const channelId = readRequiredEnvValue(input.channelId, 'channel_id');
  assertValidChannelId(channelId);
  assertRequestModePrioritySubset(requestModePriority, requestModes);
  const baseUrl = normalizeBaseUrl(readRequiredEnvValue(input.baseUrl, 'base_url'));
  const plainHttpAllowlistValue = resolvePlainHttpAllowlistValue(baseUrl, input.allowPlainHttp);
  if (!imageBackend) throw new Error('missing_image_backend');
  const prefix = `OPENAI_CHANNEL_${channelIndex}`;
  const lines = [
    `${prefix}_ID=${serializeEnvValue(channelId)}`,
    `${prefix}_BASE_URL=${serializeEnvValue(baseUrl)}`,
    `${prefix}_API_KEYS=[redacted]`,
    `${prefix}_REQUEST_MODES=${serializeEnvValue(requestModes.join(','))}`,
    `${prefix}_REQUEST_MODE_PRIORITY=${serializeEnvValue(requestModePriority.join(','))}`,
    `IMAGE_GENERATION_BACKEND=${serializeEnvValue(imageBackend)}`,
    'IMAGE_STREAMING_STRATEGY=auto'
  ];

  if (plainHttpAllowlistValue) {
    lines.push(`OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS=${serializeEnvValue(plainHttpAllowlistValue)}`);
  }

  if (requestModes.some((requestMode) => requestMode.startsWith('responses-'))) {
    lines.push('ENABLE_RESPONSES_IMAGE_BACKEND=true');
    lines.push(
      `OPENAI_RESPONSES_API_MODEL=${serializeEnvValue(readRequiredEnvValue(input.responsesModel, 'responses_model'))}`
    );
  }

  return lines;
}

export function redactKnownSecrets(value, secrets) {
  const normalizedSecrets = Array.from(new Set(secrets.map(readNonEmptyString).filter(Boolean)));
  if (typeof value === 'string') {
    return normalizedSecrets.reduce((result, secret) => result.split(secret).join('[redacted]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactKnownSecrets(item, normalizedSecrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [key, redactKnownSecrets(nestedValue, normalizedSecrets)])
  );
}

function summarizeMode(requestMode, mode, redactText) {
  if (!mode) {
    return {
      request_mode: requestMode,
      status: 'failed',
      ok: false,
      billable: false,
      reason: 'not_reported'
    };
  }

  const skipped = mode.skipped === true;
  const passed = mode.ok === true && !skipped && mode.billable === true;
  const status = skipped ? 'skipped' : passed ? 'passed' : 'failed';
  const result = {
    request_mode: requestMode,
    status,
    ok: mode.ok === true,
    billable: mode.billable === true,
    ...(skipped ? { skipped: true } : {}),
    ...(readSafeInteger(mode.status) !== undefined ? { upstream_status: mode.status } : {}),
    ...(readSafeInteger(mode.elapsed_ms) !== undefined ? { elapsed_ms: mode.elapsed_ms } : {}),
    ...(readNonEmptyString(mode.category) ? { category: redact(mode.category, redactText) } : {}),
    ...(readNonEmptyString(mode.reason) ? { reason: redact(mode.reason, redactText) } : {}),
    ...(readErrorText(mode.error) ? { error: redact(readErrorText(mode.error), redactText) } : {}),
    ...(mode.has_consumable_image === true ? { has_consumable_image: true } : {}),
    ...(mode.has_remote_url_result === true ? { has_remote_url_result: true } : {}),
    ...(mode.has_same_origin_url_result === true ? { has_same_origin_url_result: true } : {})
  };
  return result;
}

function summarizePreflight(value, redactText) {
  if (!isRecord(value)) return { ok: false, reason: 'not_reported' };
  return {
    ok: value.ok === true,
    ...(value.skipped === true ? { skipped: true } : {}),
    ...(readSafeInteger(value.status) !== undefined ? { status: value.status } : {}),
    ...(readSafeInteger(value.elapsed_ms) !== undefined ? { elapsed_ms: value.elapsed_ms } : {}),
    ...(readNonEmptyString(value.reason) ? { reason: redact(value.reason, redactText) } : {}),
    ...(readErrorText(value.error) ? { error: redact(readErrorText(value.error), redactText) } : {})
  };
}

function readResponsesModel(modeReports, responsesModes) {
  for (const requestMode of responsesModes) {
    const model = readNonEmptyString(modeReports[requestMode]?.responses_model);
    if (model) return model;
  }
  return '';
}

function orderRequestModesByDefaultPriority(requestModes) {
  const allowed = new Set(requestModes);
  return DEFAULT_CHANNEL_CAPABILITY_REQUEST_MODE_PRIORITY.filter((requestMode) => allowed.has(requestMode));
}

function resolveDefaultImageBackend(requestModes) {
  if (requestModes.some((requestMode) => requestMode.startsWith('images-'))) return 'images-api';
  if (requestModes.some((requestMode) => requestMode.startsWith('responses-'))) return 'responses-image-generation';
  return undefined;
}

export function assertPlainHttpBaseUrlAllowed(baseUrl, allowPlainHttp = false) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' || isLoopbackHostname(parsed.hostname)) return;
  if (allowPlainHttp !== true) {
    throw new Error('远程明文 HTTP 上游默认被拒绝；确认目标可信后显式添加 --allow-plain-http。');
  }
}

function resolvePlainHttpAllowlistValue(baseUrl, allowPlainHttp) {
  assertPlainHttpBaseUrlAllowed(baseUrl, allowPlainHttp);
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' || isLoopbackHostname(parsed.hostname)) return undefined;
  return baseUrl;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function normalizeRequestModes(value) {
  const modes = Array.isArray(value) ? value : [];
  const normalized = CHANNEL_CAPABILITY_REQUEST_MODES.filter((requestMode) => modes.includes(requestMode));
  if (normalized.length === 0) throw new Error('missing_request_modes');
  return normalized;
}

function assertValidChannelId(value) {
  if (!validateChannelId(value).ok) {
    throw new Error('channel_id 只能包含字母、数字、点、下划线和连字符，且长度不超过 64。');
  }
}

function assertValidChannelApiKey(value) {
  const validation = validateChannelApiKey(value);
  if (!validation.ok) {
    throw new Error(`api_key 无效：${validation.reason}。`);
  }
}

function assertRequestModePrioritySubset(priority, requestModes) {
  const allowed = new Set(requestModes);
  const unsupported = priority.filter((requestMode) => !allowed.has(requestMode));
  if (unsupported.length > 0) {
    throw new Error(`request_mode_priority 包含未启用的请求方式：${unsupported.join(', ')}。`);
  }
}

function readPositiveChannelIndex(value) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error('invalid_channel_index');
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error('invalid_channel_index');
  return parsed;
}

function readRequiredEnvValue(value, label) {
  const normalized = readNonEmptyString(value);
  if (!normalized || CONTROL_CHARACTER_PATTERN.test(normalized)) throw new Error(`invalid_${label}`);
  return normalized;
}

function serializeEnvValue(value) {
  const normalized = readRequiredEnvValue(value, 'env_value');
  return SAFE_UNQUOTED_ENV_VALUE_PATTERN.test(normalized) ? normalized : JSON.stringify(normalized);
}

function readSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readErrorText(value) {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return '';
}

function redact(value, redactText) {
  return typeof redactText === 'function' ? redactText(value) : value;
}

function readNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
