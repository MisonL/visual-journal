#!/usr/bin/env node
import { readImageDimensions } from './lib/image-dimensions.mjs';
import { completeScriptTiming, startScriptTiming } from './lib/script-summary.mjs';
import {
  assertValidImageSizeForModel,
  errorMessage,
  loadPrivateAgentEnvFile,
  normalizeBaseUrl,
  normalizeOutputFormat,
  readConfiguredPositiveInteger,
  readOptionValue,
  resolveConfiguredDefaultImageModel
} from './lib/script-utils.mjs';
import dns from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import tls from 'node:tls';

const HEADER_ALLOWLIST = new Set(['content-type', 'date', 'server', 'cf-ray', 'x-request-id', 'retry-after']);
const DEFAULT_USER_AGENT = 'visual-journal/probe';
const OUTPUT_FORMATS = new Set(['png', 'jpeg', 'webp']);
const DEFAULT_OUTPUT_FORMAT = 'webp';
const DEFAULT_OUTPUT_COMPRESSION = 100;
const REQUEST_MODES = ['images-non-stream', 'images-sse', 'responses-non-stream', 'responses-sse'];
const PARTIAL_SSE_EVENT_TYPES = new Set([
  'image_generation.partial_image',
  'image_edit.partial_image',
  'image.generation.chunk',
  'response.image_generation_call.partial_image',
  'agent.partial_image'
]);
const FINAL_SSE_EVENT_TYPES = new Set([
  'image_generation.completed',
  'image_edit.completed',
  'image.generation.result',
  'response.image_generation_call.completed',
  'response.output_item.done',
  'response.completed',
  'agent.completed'
]);
const RESPONSES_FINAL_SSE_EVENT_TYPES = new Set([
  'response.image_generation_call.completed',
  'response.output_item.done',
  'response.completed'
]);
// Values are normalized by lowercasing and replacing underscores before lookup, so alias keys use hyphens only.
const REQUEST_MODE_ALIASES = {
  all: 'all',
  images: 'images-non-stream',
  'images-api': 'images-non-stream',
  'images-api-json': 'images-non-stream',
  'images-api-non-stream': 'images-non-stream',
  'images-json': 'images-non-stream',
  'images-nonstream': 'images-non-stream',
  'images-non-stream': 'images-non-stream',
  'images-stream': 'images-sse',
  'images-api-sse': 'images-sse',
  'images-api-stream': 'images-sse',
  'images-sse': 'images-sse',
  responses: 'responses-non-stream',
  'responses-image-generation': 'responses-non-stream',
  'responses-image-generation-non-stream': 'responses-non-stream',
  'responses-json': 'responses-non-stream',
  'responses-nonstream': 'responses-non-stream',
  'responses-non-stream': 'responses-non-stream',
  'responses-image-generation-sse': 'responses-sse',
  'responses-stream': 'responses-sse',
  'responses-sse': 'responses-sse'
};

loadPrivateAgentEnvFile();
const scriptTiming = startScriptTiming();

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
try {
  baseUrl = normalizeBaseUrl(
    options.baseUrl ||
      process.env.GPT_IMAGE_UPSTREAM_BASE_URL ||
      process.env.OPENAI_API_BASE_URL ||
      'https://api.openai.com/v1'
  );
} catch (error) {
  console.error(errorMessage(error));
  process.exit(2);
}

let upstream;
try {
  upstream = new URL(baseUrl);
} catch {
  console.error(`无效的上游 base URL：${baseUrl}`);
  process.exit(2);
}

const apiKey = process.env.GPT_IMAGE_UPSTREAM_API_KEY || process.env.OPENAI_API_KEY || '';
const userAgent = process.env.OPENAI_UPSTREAM_USER_AGENT || process.env.UPSTREAM_USER_AGENT || DEFAULT_USER_AGENT;
let timeoutMs;
try {
  timeoutMs = readConfiguredPositiveInteger(options.timeoutMs, '--timeout-ms', 30000);
  options.size = assertValidImageSizeForModel(options.size, options.model, '--size');
  if (!OUTPUT_FORMATS.has(normalizeOutputFormat(options.format))) {
    throw new Error('--format 必须是 png、jpeg 或 webp。');
  }
  if (options.outputCompression !== undefined) readOutputCompression(options);
  if (options.saveFirstImagePath && !options.allowBillable) {
    throw new Error('--save-first-image 需要同时传 --allow-billable。');
  }
  if (options.saveFirstImagePath && options.requestModes.length > 1) {
    throw new Error('--save-first-image 只能与单个 --request-mode 一起使用。');
  }
  if (options.connectIp && isIP(options.connectIp) === 0) {
    throw new Error('--connect-ip 必须是有效的 IPv4 或 IPv6 地址。');
  }
} catch (error) {
  console.error(errorMessage(error));
  printUsage();
  process.exit(2);
}

const report = {
  ok: false,
  billable: false,
  base_url: baseUrl,
  upstream_host: upstream.host,
  ...(options.connectIp ? { connect_ip: options.connectIp } : {}),
  api_key_configured: Boolean(apiKey),
  dns: await probeDns(upstream.hostname),
  tls: await probeTls(upstream),
  models: await probeModels()
};

const selectedRequestModes = resolveSelectedRequestModes(options);
if (selectedRequestModes.length > 0) {
  report.request_modes = await probeRequestModes(selectedRequestModes);
  report.billable = Object.values(report.request_modes.modes).some((item) => item.billable === true);
  if (report.request_modes.modes['images-non-stream']?.billable) {
    report.generation = report.request_modes.modes['images-non-stream'];
  }
}

report.ok = Boolean(report.models.ok && (!report.request_modes || report.request_modes.failed.length === 0));
report.summary = buildProbeSummary(report);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

function parseArgs(argv) {
  const parsed = {
    baseUrl: undefined,
    model: resolveConfiguredDefaultImageModel(),
    responsesModel: undefined,
    prompt: 'contract probe',
    size: '1024x1024',
    quality: 'low',
    format: DEFAULT_OUTPUT_FORMAT,
    outputCompression: undefined,
    timeoutMs: undefined,
    saveFirstImagePath: undefined,
    connectIp: undefined,
    requestModes: [],
    allowBillable: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') parsed.baseUrl = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--model') parsed.model = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--responses-model') parsed.responsesModel = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--prompt') parsed.prompt = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--size') parsed.size = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--quality') parsed.quality = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--format' || arg === '--output-format') parsed.format = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--output-compression') parsed.outputCompression = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--timeout-ms') parsed.timeoutMs = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--save-first-image') parsed.saveFirstImagePath = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--connect-ip') parsed.connectIp = readOptionValue(argv, (index += 1), arg);
    else if (arg === '--request-mode' || arg === '--request-modes') {
      const requestModes = readRequestModeList(readOptionValue(argv, (index += 1), arg));
      for (const requestMode of requestModes) {
        if (!parsed.requestModes.includes(requestMode)) parsed.requestModes.push(requestMode);
      }
    } else if (arg === '--allow-billable') parsed.allowBillable = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return parsed;
}

async function probeDns(hostname) {
  if (options.connectIp) {
    return {
      ok: true,
      skipped: true,
      reason: 'connect_ip_override',
      address: options.connectIp,
      address_family: isIP(options.connectIp)
    };
  }
  const startedAt = Date.now();
  try {
    const result = await dns.lookup(hostname);
    return { ok: true, elapsed_ms: Date.now() - startedAt, address_family: result.family };
  } catch (error) {
    return { ok: false, elapsed_ms: Date.now() - startedAt, error: errorMessage(error) };
  }
}

async function probeTls(url) {
  if (url.protocol !== 'https:') {
    return { ok: true, skipped: true, reason: 'non_https_base_url' };
  }
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: options.connectIp || url.hostname,
      port: Number(url.port || 443),
      servername: url.hostname,
      timeout: timeoutMs
    });
    socket.once('secureConnect', () => {
      const protocol = socket.getProtocol() || undefined;
      socket.end();
      resolve({
        ok: true,
        elapsed_ms: Date.now() - startedAt,
        authorized: socket.authorized,
        protocol,
        ...(options.connectIp ? { connect_ip: options.connectIp } : {})
      });
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve({ ok: false, elapsed_ms: Date.now() - startedAt, error: 'TLS handshake timed out.' });
    });
    socket.once('error', (error) => {
      resolve({ ok: false, elapsed_ms: Date.now() - startedAt, error: errorMessage(error) });
    });
  });
}

async function probeModels() {
  const { response, json, text, elapsedMs } = await fetchJson(`${baseUrl}/models`, { method: 'GET' });
  return {
    ok: response.ok,
    status: response.status,
    elapsed_ms: elapsedMs,
    content_type: response.headers.get('content-type') || undefined,
    response_headers: readAllowedHeaders(response.headers),
    ...summarizeModelsJson(json, text)
  };
}

async function probeRequestModes(requestModes) {
  const modes = {};
  for (const requestMode of requestModes) {
    modes[requestMode] = await probeRequestMode(requestMode);
  }
  const passed = REQUEST_MODES.filter((mode) => modes[mode]?.ok === true && modes[mode]?.skipped !== true);
  const failed = REQUEST_MODES.filter((mode) => modes[mode]?.ok === false && modes[mode]?.skipped !== true);
  const skipped = REQUEST_MODES.filter((mode) => modes[mode]?.skipped === true);
  const notSelected = REQUEST_MODES.filter((mode) => !requestModes.includes(mode));
  return {
    requested: requestModes,
    passed,
    failed,
    skipped,
    not_selected: notSelected,
    suggested_channel_config: passed.join(','),
    suggested_env_key: 'OPENAI_CHANNEL_N_REQUEST_MODES',
    modes
  };
}

async function probeRequestMode(requestMode) {
  if (!options.allowBillable) {
    return {
      request_mode: requestMode,
      ok: true,
      skipped: true,
      reason: 'requires --allow-billable'
    };
  }
  if (requestMode === 'images-non-stream' || requestMode === 'images-sse') {
    return await probeImagesMode(requestMode, requestMode === 'images-sse');
  }
  if (requestMode === 'responses-non-stream' || requestMode === 'responses-sse') {
    return await probeResponsesMode(requestMode, requestMode === 'responses-sse');
  }
  return {
    request_mode: requestMode,
    ok: false,
    status: 0,
    elapsed_ms: 0,
    error: 'unsupported_request_mode'
  };
}

async function probeImagesMode(requestMode, stream) {
  const { response, json, text, elapsedMs } = await fetchJson(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      prompt: options.prompt,
      n: 1,
      size: options.size,
      quality: options.quality,
      stream,
      output_format: normalizeOutputFormat(options.format),
      ...(readOutputCompression(options) !== undefined ? { output_compression: readOutputCompression(options) } : {})
    })
  });
  const summary = summarizeModeResponse({
    requestMode,
    response,
    json,
    text,
    elapsedMs,
    stream,
    modeKind: 'images'
  });
  const savedImage = await maybeSaveFirstImage({ summary, response, json, text, modeKind: 'images' });
  const finalSummary = applySaveImageResult(summary, savedImage);
  return {
    request_mode: requestMode,
    billable: true,
    ...finalSummary,
    ...(savedImage ? { saved_image: savedImage } : {})
  };
}

async function probeResponsesMode(requestMode, stream) {
  const responsesModel = resolveResponsesModel();
  if (!responsesModel) {
    return {
      request_mode: requestMode,
      ok: false,
      billable: false,
      status: 0,
      elapsed_ms: 0,
      error: 'missing_responses_model',
      reason: 'missing_responses_model'
    };
  }
  const { response, json, text, elapsedMs } = await fetchJson(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: responsesModel,
      input: options.prompt,
      stream,
      tool_choice: { type: 'image_generation' },
      tools: [
        {
          type: 'image_generation',
          action: 'generate',
          model: options.model,
          size: options.size,
          quality: options.quality,
          output_format: normalizeOutputFormat(options.format),
          ...(readOutputCompression(options) !== undefined
            ? { output_compression: readOutputCompression(options) }
            : {})
        }
      ]
    })
  });
  const summary = summarizeModeResponse({
    requestMode,
    response,
    json,
    text,
    elapsedMs,
    stream,
    modeKind: 'responses'
  });
  const savedImage = await maybeSaveFirstImage({ summary, response, json, text, modeKind: 'responses' });
  const finalSummary = applySaveImageResult(summary, savedImage);
  return {
    request_mode: requestMode,
    billable: true,
    responses_model: responsesModel,
    ...finalSummary,
    ...(savedImage ? { saved_image: savedImage } : {})
  };
}

async function maybeSaveFirstImage({ summary, response, json, text, modeKind }) {
  if (!options.saveFirstImagePath || !summary.ok || !response.ok) return undefined;
  try {
    const image = await readFirstConsumableFinalImageBytes({ response, json, text, modeKind });
    if (!image) throw new Error('未找到可保存的内联或同源图片产物；跨域 URL 需要由部署服务按安全策略下载。');
    const dimensions = readImageDimensions(image.bytes);
    await mkdir(dirname(options.saveFirstImagePath), { recursive: true });
    await writeFile(options.saveFirstImagePath, image.bytes, { flag: 'wx' });
    return {
      ok: true,
      path: options.saveFirstImagePath,
      byte_length: image.bytes.byteLength,
      source: image.source,
      dimensions
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function applySaveImageResult(summary, savedImage) {
  if (!savedImage || savedImage.ok) return summary;
  return {
    ...summary,
    ok: false,
    error: 'save_first_image_failed'
  };
}

async function readFirstConsumableFinalImageBytes({ response, json, text, modeKind }) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) return await readFirstConsumableFinalImageBytesFromSse(text);
  if (modeKind === 'images') return await readFirstConsumableImageBytesFromValue(json?.data);
  const imageCalls = Array.isArray(json?.output) ? json.output.filter(isCompletedResponsesImageCall) : [];
  return await readFirstConsumableImageBytesFromValue(imageCalls);
}

async function readFirstConsumableFinalImageBytesFromSse(text) {
  for (const event of parseSseEvents(text)) {
    const candidates = readFinalImageCandidatesFromSseEvent(event);
    for (const candidate of candidates) {
      const image = await readFirstConsumableImageBytesFromValue(candidate);
      if (image) return image;
    }
  }
  return undefined;
}

async function readFirstConsumableImageBytesFromValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = await readFirstConsumableImageBytesFromValue(item);
      if (image) return image;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes('partial')) continue;
    if (normalizedKey === 'b64_json' && typeof nestedValue === 'string') {
      return decodeImageBase64(nestedValue, normalizedKey);
    }
    if ((normalizedKey === 'result' || normalizedKey === 'url') && typeof nestedValue === 'string') {
      const image = await readImageBytesFromString(nestedValue, normalizedKey);
      if (image) return image;
    }
    const image = await readFirstConsumableImageBytesFromValue(nestedValue);
    if (image) return image;
  }
  return undefined;
}

function parseSseEvents(text) {
  const events = [];
  for (const block of text.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event: '));
    const eventType = eventLine ? eventLine.slice('event: '.length).trim() : undefined;
    const data = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    if (data === '[DONE]') {
      events.push({ eventType, done: true, value: undefined });
      continue;
    }
    events.push({ eventType, done: false, value: parseJson(data) });
  }
  return events;
}

function readFinalImageCandidatesFromSseEvent(event) {
  if (event.done || !event.value || containsPartialImageMarker(event)) return [];
  const eventTypes = readSseEventTypes(event);
  if (eventTypes.some((type) => RESPONSES_FINAL_SSE_EVENT_TYPES.has(type))) {
    return readCompletedResponsesImageCalls(event.value);
  }
  if (eventTypes.some((type) => FINAL_SSE_EVENT_TYPES.has(type))) {
    return readGeneralFinalImageCandidates(event.value);
  }
  return hasUnlabeledFinalImageData(event.value) ? readGeneralFinalImageCandidates(event.value) : [];
}

function readSseEventTypes(event) {
  const eventTypes = [];
  if (typeof event.eventType === 'string' && event.eventType) eventTypes.push(event.eventType);
  if (event.value && typeof event.value === 'object' && typeof event.value.type === 'string') {
    eventTypes.push(event.value.type);
  }
  return eventTypes;
}

function containsPartialImageMarker(event) {
  return readSseEventTypes(event).some((type) => PARTIAL_SSE_EVENT_TYPES.has(type) || type.includes('partial_image'));
}

function readGeneralFinalImageCandidates(value) {
  if (Array.isArray(value?.data)) return value.data;
  return [value];
}

function hasUnlabeledFinalImageData(value) {
  return Array.isArray(value?.data) && value.data.some(hasDirectImagePayload);
}

function hasDirectImagePayload(value) {
  if (!value || typeof value !== 'object') return false;
  return ['b64_json', 'result', 'url'].some((key) => typeof value[key] === 'string' && value[key].trim());
}

function readCompletedResponsesImageCalls(value) {
  const calls = [];
  const visit = (current, isRoot = false) => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!current || typeof current !== 'object') return;
    const type = typeof current.type === 'string' ? current.type : '';
    const status = typeof current.status === 'string' ? current.status : '';
    if (
      (type === 'image_generation_call' || (isRoot && type === 'response.image_generation_call.completed')) &&
      status !== 'failed' &&
      status !== 'pending' &&
      status !== 'in_progress' &&
      hasDirectImagePayload(current)
    ) {
      calls.push(current);
      return;
    }
    for (const key of ['item', 'response', 'output', 'data']) {
      if (current[key] !== undefined) visit(current[key]);
    }
  };
  visit(value, true);
  return calls;
}

function isCompletedResponsesImageCall(value) {
  if (!value || typeof value !== 'object' || value.type !== 'image_generation_call') return false;
  return value.status !== 'failed' && value.status !== 'pending' && value.status !== 'in_progress';
}

async function readImageBytesFromString(value, key) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('data:image/')) return decodeImageDataUrl(trimmed);
  if (isRemoteUrl(trimmed) || key === 'url') {
    if (!isSameOriginUrl(trimmed)) return undefined;
    return await fetchSameOriginImage(trimmed);
  }
  return decodeImageBase64(trimmed, key);
}

function decodeImageDataUrl(value) {
  const match = /^data:image\/[a-z0-9.+-]+;base64,(?<data>[a-z0-9+/=\s]+)$/i.exec(value);
  if (!match?.groups?.data) throw new Error('图片 data URL 格式无效。');
  return decodeImageBase64(match.groups.data, 'data_url');
}

function decodeImageBase64(value, source) {
  return { bytes: Buffer.from(String(value).replace(/\s/g, ''), 'base64'), source };
}

async function fetchSameOriginImage(value) {
  const resolved = new URL(value, baseUrl);
  const { response, bytes } = await fetchBytes(resolved.href);
  if (!response.ok) throw new Error(`下载同源图片产物失败，状态码 ${response.status}。`);
  return { bytes, source: 'same_origin_url' };
}

function summarizeModeResponse(input) {
  const contentType = input.response.headers.get('content-type') || undefined;
  const base = {
    ok: false,
    status: input.response.status,
    elapsed_ms: input.elapsedMs,
    content_type: contentType,
    response_headers: readAllowedHeaders(input.response.headers)
  };
  const disabledMessage = detectResponsesDisabled(input.json, input.text);
  if (disabledMessage) {
    return {
      ...base,
      ok: false,
      category: 'responses_disabled',
      error: disabledMessage
    };
  }
  if (!input.response.ok) {
    return {
      ...base,
      ok: false,
      error: summarizeError(input.json, input.text)
    };
  }
  if (contentType?.includes('text/event-stream')) {
    const streamSummary = summarizeSseText(input.text);
    return {
      ...base,
      ...streamSummary,
      ok: streamSummary.has_consumable_image,
      ...(streamSummary.has_consumable_image
        ? {}
        : { error: readMissingImageError(streamSummary, 'missing_final_image') })
    };
  }
  if (input.modeKind === 'images') {
    const imageSummary = summarizeImageListJson(input.json, input.text);
    return {
      ...base,
      ...imageSummary,
      ok: imageSummary.has_consumable_image,
      ...(imageSummary.has_consumable_image
        ? {}
        : { error: readMissingImageError(imageSummary, 'missing_final_image') })
    };
  }
  const responsesSummary = summarizeResponsesJson(input.json, input.text);
  return {
    ...base,
    ...responsesSummary,
    ok: responsesSummary.has_consumable_image,
    ...(responsesSummary.has_consumable_image
      ? {}
      : { error: readMissingImageError(responsesSummary, 'missing_image_call_result') })
  };
}

function summarizeSseText(text) {
  const eventTypes = [];
  let hasPartialImage = false;
  const imageCapability = createImageCapabilitySummary();
  for (const event of parseSseEvents(text)) {
    if (event.done) {
      eventTypes.push('done');
      continue;
    }
    if (event.eventType) eventTypes.push(event.eventType);
    if (containsPartialImageMarker(event)) hasPartialImage = true;
    for (const candidate of readFinalImageCandidatesFromSseEvent(event)) {
      mergeImageCapability(imageCapability, summarizeConsumableImageValue(candidate));
    }
  }
  return {
    content_type: 'text/event-stream',
    event_types: eventTypes,
    has_partial_image: hasPartialImage,
    ...imageCapability
  };
}

function detectResponsesDisabled(json, text) {
  const error = summarizeError(json, text);
  const message = typeof error === 'object' && error && typeof error.message === 'string' ? error.message : '';
  const normalized = message.toLowerCase();
  if (
    normalized.includes('image generation is not enabled for this group') ||
    (normalized.includes('403') && normalized.includes('image_generation'))
  ) {
    return message || 'image_generation_disabled';
  }
  return undefined;
}

async function fetchJson(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await requestWithConnectIp(url, {
      ...init,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'User-Agent': userAgent,
        ...(init.headers || {})
      },
      signal: controller.signal
    });
    const text = await response.text();
    return { response, text, json: parseJson(text), elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      response: new Response(JSON.stringify({ error: errorMessage(error) }), { status: 599 }),
      text: '',
      json: { error: errorMessage(error) },
      elapsedMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBytes(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await requestWithConnectIp(url, {
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'User-Agent': userAgent
      },
      signal: controller.signal
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { response, bytes };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestWithConnectIp(url, init) {
  const target = new URL(url);
  if (!options.connectIp || target.hostname !== upstream.hostname) return await fetch(url, init);
  const transport = target.protocol === 'https:' ? https : http;
  return await new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: init.method || 'GET',
        headers: init.headers,
        signal: init.signal,
        lookup: (_hostname, lookupOptions, callback) => {
          const family = isIP(options.connectIp);
          if (lookupOptions?.all) {
            callback(null, [{ address: options.connectIp, family }]);
            return;
          }
          callback(null, options.connectIp, family);
        }
      },
      (response) => {
        readIncomingMessage(response).then(
          (body) =>
            resolve(
              new Response(body, {
                status: response.statusCode || 599,
                headers: toResponseHeaders(response.headers)
              })
            ),
          reject
        );
      }
    );
    request.once('error', reject);
    if (init.body) request.write(init.body);
    request.end();
  });
}

async function readIncomingMessage(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function toResponseHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, String(item));
    } else if (value !== undefined) {
      result.set(name, String(value));
    }
  }
  return result;
}

function buildProbeSummary(value) {
  const timing = completeScriptTiming(scriptTiming);
  const configuredHeaderNames = readProbeConfiguredHeaderNames();
  return {
    ok: value.ok,
    billable: Boolean(value.billable),
    started_at: timing.started_at,
    completed_at: timing.completed_at,
    elapsed_ms: timing.elapsed_ms,
    transport: 'upstream_probe',
    endpoint: `${baseUrl}/models`,
    upstream_host: upstream.host,
    ...(options.connectIp ? { connect_ip: options.connectIp } : {}),
    request_modes: value.request_modes || undefined,
    request_headers: {
      user_agent_effective: userAgent,
      has_extra_headers: configuredHeaderNames.some((name) => name !== 'user-agent'),
      allowed_header_names: ['authorization', 'user-agent'],
      configured_header_names: configuredHeaderNames
    },
    retryable: value.ok ? false : undefined,
    next_action: value.ok ? 'done' : 'inspect_dns_tls_models'
  };
}

function resolveSelectedRequestModes(parsed) {
  if (parsed.requestModes.length > 0) return parsed.requestModes;
  return parsed.allowBillable ? ['images-non-stream'] : [];
}

function readProbeConfiguredHeaderNames() {
  const names = [];
  if (apiKey) names.push('authorization');
  if (userAgent !== DEFAULT_USER_AGENT) names.push('user-agent');
  return names.sort();
}

function resolveResponsesModel() {
  return readNonEmptyString(options.responsesModel || process.env.OPENAI_RESPONSES_API_MODEL || '');
}

function summarizeModelsJson(json, text) {
  if (!Array.isArray(json?.data)) {
    return { error: summarizeError(json, text) };
  }
  const firstModel = json.data.find((item) => item && typeof item === 'object' && typeof item.id === 'string');
  return {
    model_count: json.data.length,
    first_model_id: firstModel?.id
  };
}

function summarizeImageListJson(json, text) {
  if (!Array.isArray(json?.data)) {
    return { error: summarizeError(json, text) };
  }
  const firstImage = json.data[0] || {};
  const firstB64 = typeof firstImage.b64_json === 'string' ? firstImage.b64_json : '';
  return {
    image_count: json.data.length,
    first_b64_length: firstB64.length,
    ...summarizeConsumableImageItems(json.data),
    usage: json.usage || undefined
  };
}

function summarizeResponsesJson(json, text) {
  if (!Array.isArray(json?.output)) {
    return { error: summarizeError(json, text) };
  }
  const imageCalls = json.output.filter(isCompletedResponsesImageCall);
  const firstCall = imageCalls[0];
  const firstResult =
    typeof firstCall?.result === 'string' ? firstCall.result : typeof firstCall?.url === 'string' ? firstCall.url : '';
  return {
    output_count: json.output.length,
    first_result_length: firstResult.length,
    ...summarizeConsumableImageItems(imageCalls),
    usage: json.usage || undefined
  };
}

function summarizeConsumableImageItems(items) {
  const summary = createImageCapabilitySummary();
  for (const item of items) {
    mergeImageCapability(summary, summarizeConsumableImageValue(item));
  }
  return summary;
}

function summarizeConsumableImageValue(value) {
  const summary = createImageCapabilitySummary();
  if (Array.isArray(value)) {
    for (const item of value) mergeImageCapability(summary, summarizeConsumableImageValue(item));
    return summary;
  }
  if (!value || typeof value !== 'object') return summary;
  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes('partial')) continue;
    if (normalizedKey === 'b64_json') {
      if (typeof nestedValue === 'string' && nestedValue.length > 0) {
        summary.has_inline_base64 = true;
        summary.has_consumable_image = true;
      }
      continue;
    }
    if ((normalizedKey === 'result' || normalizedKey === 'url') && typeof nestedValue === 'string') {
      updateImageCapabilityFromString(summary, nestedValue, normalizedKey);
      continue;
    }
    mergeImageCapability(summary, summarizeConsumableImageValue(nestedValue));
  }
  return summary;
}

function updateImageCapabilityFromString(summary, value, key) {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('data:image/')) {
    summary.has_inline_base64 = true;
    summary.has_consumable_image = true;
    return;
  }
  if (isRemoteUrl(trimmed) || key === 'url') {
    summary.has_url_result = true;
    if (isSameOriginUrl(trimmed)) {
      summary.has_same_origin_url_result = true;
      summary.has_consumable_image = true;
    } else {
      summary.has_remote_url_result = true;
    }
    return;
  }
  summary.has_inline_base64 = true;
  summary.has_consumable_image = true;
}

function createImageCapabilitySummary() {
  return {
    has_consumable_image: false,
    has_inline_base64: false,
    has_url_result: false,
    has_same_origin_url_result: false,
    has_remote_url_result: false
  };
}

function mergeImageCapability(target, source) {
  target.has_consumable_image ||= Boolean(source.has_consumable_image);
  target.has_inline_base64 ||= Boolean(source.has_inline_base64);
  target.has_url_result ||= Boolean(source.has_url_result);
  target.has_same_origin_url_result ||= Boolean(source.has_same_origin_url_result);
  target.has_remote_url_result ||= Boolean(source.has_remote_url_result);
}

function readMissingImageError(summary, fallback) {
  if (summary?.has_remote_url_result && !summary?.has_consumable_image) return 'url_only_result';
  return fallback;
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isSameOriginUrl(value) {
  try {
    const resolved = new URL(value, baseUrl);
    const base = new URL(baseUrl);
    return (resolved.protocol === 'http:' || resolved.protocol === 'https:') && resolved.origin === base.origin;
  } catch {
    return false;
  }
}

function summarizeError(json, text) {
  const error = json?.error;
  if (typeof error === 'object' && error) {
    return {
      code: typeof error.code === 'string' ? redactProbeSecret(error.code) : undefined,
      type: typeof error.type === 'string' ? redactProbeSecret(error.type) : undefined,
      message: typeof error.message === 'string' ? redactProbeSecret(error.message) : undefined
    };
  }
  return text ? { message: redactProbeSecret(text.slice(0, 500)) } : undefined;
}

function redactProbeSecret(value) {
  if (!apiKey) return value;
  return value.split(apiKey).join('[redacted]');
}

function readAllowedHeaders(headers) {
  const result = {};
  for (const name of HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function readRequestModeList(value) {
  const requestModes = [];
  for (const part of String(value).split(/[\s,]+/)) {
    const normalized = normalizeRequestMode(part);
    if (!normalized) continue;
    if (normalized === 'all') {
      for (const requestMode of REQUEST_MODES) {
        if (!requestModes.includes(requestMode)) requestModes.push(requestMode);
      }
      continue;
    }
    if (!requestModes.includes(normalized)) requestModes.push(normalized);
  }
  if (requestModes.length === 0) {
    throw new Error('--request-mode 至少需要包含一个有效的请求方式。');
  }
  return requestModes;
}

function normalizeRequestMode(value) {
  const normalized = String(value).trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return undefined;
  if (REQUEST_MODES.includes(normalized)) return normalized;
  const aliased = REQUEST_MODE_ALIASES[normalized];
  if (aliased) return aliased;
  throw new Error(`未知请求方式：${value}。必须是 ${REQUEST_MODES.join(', ')} 之一。`);
}

function readNonEmptyString(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return value.trim();
}

function printUsage() {
  console.error('用法：probe-upstream-image.mjs [options]');
  console.error('默认只请求 /models；添加 --allow-billable 才会调用请求方式探测。');
  console.error(
    '常用参数：--base-url --connect-ip --model --responses-model --prompt --size --quality --format --output-compression --timeout-ms --request-mode --save-first-image --allow-billable'
  );
  console.error(
    '可用请求方式：images-non-stream、images-sse、responses-non-stream、responses-sse；可重复传 --request-mode，或传 all。'
  );
}
