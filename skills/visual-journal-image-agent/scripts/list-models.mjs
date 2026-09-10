#!/usr/bin/env node
import {
    errorMessage,
    loadPrivateAgentEnvFile,
    readConfiguredPositiveInteger,
    readOptionValue,
    resolveAgentToken,
    resolvePlaygroundBaseUrl
} from './lib/script-utils.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;

loadPrivateAgentEnvFile();

let options;
try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
        process.exit(0);
    }
} catch (error) {
    console.error(errorMessage(error));
    printUsage();
    process.exit(2);
}

let baseUrlInfo;
try {
    baseUrlInfo = resolvePlaygroundBaseUrl(options.baseUrl, process.env);
} catch (error) {
    console.error(errorMessage(error));
    process.exit(2);
}

const endpoint = `/api/agent/models${options.probe ? '?probe=true' : ''}`;
const agentToken = resolveAgentToken();
const authHeaders = agentToken
    ? { Authorization: `Bearer ${agentToken}` }
    : process.env.GPT_IMAGE_APP_PASSWORD_HASH
      ? { 'X-App-Password-Hash': process.env.GPT_IMAGE_APP_PASSWORD_HASH }
      : {};

try {
    const result = await fetchModelDirectory(baseUrlInfo.baseUrl, endpoint, authHeaders, options.timeoutMs);
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        printHumanReadableDirectory(result, options.probe);
    }
} catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
}

function parseArgs(argv) {
    const parsed = { baseUrl: undefined, json: false, probe: false, timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--base-url') parsed.baseUrl = readOptionValue(argv, (index += 1), arg);
        else if (arg === '--timeout-ms') parsed.timeoutMs = readOptionValue(argv, (index += 1), arg);
        else if (arg === '--json') parsed.json = true;
        else if (arg === '--probe') parsed.probe = true;
        else if (arg === '--help' || arg === '-h') parsed.help = true;
        else throw new Error(`未知参数：${arg}`);
    }
    const timeoutMs = readConfiguredPositiveInteger(parsed.timeoutMs, '--timeout-ms', DEFAULT_TIMEOUT_MS);
    if (timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`--timeout-ms 不能超过 ${MAX_TIMEOUT_MS}。`);
    }
    parsed.timeoutMs = timeoutMs;
    return parsed;
}

async function fetchModelDirectory(baseUrl, endpoint, headers, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const initialUrl = new URL(endpoint.replace(/^\/+/, ''), `${baseUrl.replace(/\/$/, '')}/`);
    let requestUrl = initialUrl;
    try {
        let response;
        for (let redirectCount = 0; ; redirectCount += 1) {
            response = await fetch(requestUrl, {
                headers,
                signal: controller.signal,
                redirect: 'manual'
            });
            if (response.status < 300 || response.status >= 400) break;

            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) throw new Error(`模型目录请求失败：服务返回了没有 Location 的重定向（状态码 ${response.status}）。`);
            const redirectedUrl = new URL(location, requestUrl);
            if (redirectedUrl.origin !== initialUrl.origin) {
                throw new Error('模型目录请求失败：拒绝跨源重定向，以免向其他站点发送鉴权信息。');
            }
            if (redirectCount >= MAX_REDIRECTS) {
                throw new Error(`模型目录请求失败：重定向次数超过 ${MAX_REDIRECTS} 次。`);
            }
            requestUrl = redirectedUrl;
        }
        let result;
        try {
            result = await response.json();
        } catch {
            throw new Error(`模型目录请求失败：服务返回非 JSON（状态码 ${response.status}）。`);
        }
        if (!response.ok || !isModelDirectory(result)) {
            const message =
                typeof result?.error?.message === 'string' ? result.error.message : `状态码 ${response.status}`;
            throw new Error(`模型目录请求失败：${message}`);
        }
        return result;
    } catch (error) {
        if (controller.signal.aborted) throw new Error(`模型目录请求超时（${timeoutMs} 毫秒）。`);
        if (error instanceof Error && error.message.startsWith('模型目录请求失败：')) throw error;
        throw new Error(`模型目录请求失败：${errorMessage(error)}`);
    } finally {
        clearTimeout(timer);
    }
}

function isModelDirectory(value) {
    return (
        value &&
        typeof value === 'object' &&
        value.ok === true &&
        typeof value.default_model === 'string' &&
        Array.isArray(value.known_models) &&
        Array.isArray(value.channels) &&
        value.channels.every(
            (channel) =>
                channel &&
                typeof channel === 'object' &&
                typeof channel.id === 'string' &&
                Array.isArray(channel.models) &&
                typeof channel.probe_status === 'string'
        )
    );
}

function printHumanReadableDirectory(directory, probe) {
    console.log(`默认模型：${directory.default_model}`);
    console.log(
        `已知模型：${
            directory.known_models
                .map((model) => model?.id)
                .filter((id) => typeof id === 'string')
                .join(', ') || '无'
        }`
    );
    for (const channel of directory.channels) {
        const suffix =
            channel.probe_status === 'ok'
                ? `（${channel.models.join(', ') || '无模型'}）`
                : `（${channel.probe_status}）`;
        console.log(`渠道 ${channel.id}: ${suffix}`);
    }
    console.log(probe ? '来源：渠道 /models 实时探测' : '来源：项目和配置声明；使用 --probe 进行实时探测');
}

function printUsage() {
    console.error(
        '用法：node list-models.mjs [--probe] [--json] [--base-url URL] [--timeout-ms 毫秒]\n' +
            '默认只读取服务端声明；--probe 会主动探测已配置渠道的 /models。'
    );
}
