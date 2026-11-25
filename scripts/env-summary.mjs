#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

import { isMainModule, printJson, runCommand } from './command-center-utils.mjs';

const DEFAULT_ENV_FILES = ['.env.local', '.env.real-smoke.local', '.env.agent.local'];
const SECRET_NAME_PATTERN = /(API_?KEY|API_?KEYS|TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE)/i;
const PRIVATE_ENDPOINT_NAME_PATTERN = /PROXY/i;
const URL_NAME_PATTERN = /(BASE_URL|URL|ENDPOINT|HOST)$/i;
const DOCKER_INSPECT_TIMEOUT_MS = 10_000;

export function parseEnvContent(content) {
    const entries = [];
    for (const line of content.split(/\r?\n/)) {
        const parsed = parseEnvLine(line);
        if (parsed) entries.push(parsed);
    }
    return entries;
}

function parseEnvLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return undefined;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return undefined;
    return { name: match[1], value: parseEnvValue(match[2].trim()) };
}

function parseEnvValue(value) {
    if (value.length < 2) return value;
    if (value.startsWith('"') || value.startsWith("'")) {
        return parseQuotedEnvValue(value);
    }
    return stripUnquotedInlineComment(value).trim();
}

function parseQuotedEnvValue(value) {
    const quote = value[0];
    const closeIndex = value.indexOf(quote, 1);
    if (closeIndex < 0) return value.slice(1);
    return value.slice(1, closeIndex);
}

function stripUnquotedInlineComment(value) {
    const index = value.search(/\s#/);
    if (index < 0) return value;
    return value.slice(0, index);
}

export function summarizeEnvEntries(entries) {
    return entries.map(({ name, value }) => summarizeEnvEntry(name, value)).sort((a, b) => a.name.localeCompare(b.name));
}

function summarizeEnvEntry(name, value) {
    const set = value.length > 0;
    const sensitive = SECRET_NAME_PATTERN.test(name) || PRIVATE_ENDPOINT_NAME_PATTERN.test(name);
    const summary = { name, set, sensitive, value_kind: classifyValue(value) };
    if (sensitive && set) {
        summary.item_count = value.split(',').map((item) => item.trim()).filter(Boolean).length;
    }
    if (!sensitive && set && URL_NAME_PATTERN.test(name)) {
        const endpoint = summarizeEndpoint(value);
        summary.value_kind = endpoint.kind;
        summary.url = endpoint;
    }
    return summary;
}

function classifyValue(value) {
    if (!value) return 'empty';
    if (/^(true|false)$/i.test(value)) return 'boolean';
    if (/^\d+$/.test(value)) return 'integer';
    if (isHttpUrl(value)) return 'url';
    if (value.includes(',')) return 'list';
    return 'non_empty';
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function summarizeUrl(value) {
    try {
        const url = new URL(value);
        return {
            valid: true,
            protocol: url.protocol.replace(':', ''),
            host: url.host,
            has_path: url.pathname !== '/',
            has_query: Boolean(url.search),
            has_fragment: Boolean(url.hash),
            has_credentials: Boolean(url.username || url.password)
        };
    } catch {
        return { valid: false };
    }
}

function summarizeEndpoint(value) {
    if (isHttpUrl(value)) return { ...summarizeUrl(value), kind: 'url' };
    const host = summarizeHost(value);
    if (host.valid) return { ...host, kind: 'host' };
    return { valid: false, kind: classifyValue(value) };
}

function summarizeHost(value) {
    if (!/^[A-Za-z0-9._-]+(?::\d+)?$/.test(value)) return { valid: false };
    try {
        const url = new URL(`http://${value}`);
        return {
            valid: true,
            protocol: null,
            host: url.host,
            has_path: false,
            has_query: false,
            has_fragment: false,
            has_credentials: false
        };
    } catch {
        return { valid: false };
    }
}

export function summarizeEnvFile(filePath) {
    if (!existsSync(filePath)) return { type: 'file', path: filePath, exists: false, variables: [] };
    const entries = parseEnvContent(readFileSync(filePath, 'utf8'));
    return {
        type: 'file',
        path: filePath,
        exists: true,
        variable_count: entries.length,
        variables: summarizeEnvEntries(entries)
    };
}

export function summarizeDockerEnv(containerName) {
    const result = runCommand('docker', ['inspect', containerName, '--format', '{{json .Config.Env}}'], {
        timeoutMs: DOCKER_INSPECT_TIMEOUT_MS
    });
    if (!result.ok) {
        return {
            type: 'docker_container',
            container: containerName,
            ok: false,
            error: summarizeDockerInspectFailure(result)
        };
    }
    const entries = parseDockerEnvOutput(result.stdout);
    return {
        type: 'docker_container',
        container: containerName,
        ok: true,
        variable_count: entries.length,
        variables: summarizeEnvEntries(entries)
    };
}

function summarizeDockerInspectFailure(result) {
    return {
        message: result.error || 'docker inspect failed',
        status: result.status,
        signal: result.signal || undefined
    };
}

export function parseDockerEnvOutput(output) {
    const values = JSON.parse(output);
    if (!Array.isArray(values)) throw new Error('docker inspect did not return an env array');
    return values.map((line) => {
        const index = String(line).indexOf('=');
        if (index < 0) return { name: String(line), value: '' };
        return { name: String(line).slice(0, index), value: String(line).slice(index + 1) };
    });
}

function parseArgs(argv) {
    const options = { files: [], containers: [], help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--file') options.files.push({ path: readOptionValue(argv, (index += 1), arg), optional: false });
        else if (arg === '--file-if-exists') options.files.push({ path: readOptionValue(argv, (index += 1), arg), optional: true });
        else if (arg === '--container') options.containers.push(readOptionValue(argv, (index += 1), arg));
        else throw new Error(`Unknown option: ${arg}`);
    }
    if (options.files.length === 0 && options.containers.length === 0) {
        options.files.push(...DEFAULT_ENV_FILES.map((path) => ({ path, optional: false })));
    }
    return options;
}

function readOptionValue(argv, index, name) {
    const value = argv[index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
}

function printHelp() {
    console.log(`Usage:
  node scripts/env-summary.mjs
  node scripts/env-summary.mjs --file .env.local --container visual-journal
  node scripts/env-summary.mjs --file-if-exists .env.agent.local

Output is always redacted. It reports variable names, whether values are set, secret item counts, and URL hosts only.`);
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const sources = [
        ...options.files
            .filter((file) => !file.optional || existsSync(file.path))
            .map((file) => summarizeEnvFile(file.path)),
        ...options.containers.map((containerName) => summarizeDockerEnv(containerName))
    ];
    printJson({
        ok: sources.every((source) => source.ok !== false),
        redacted: true,
        sources
    });
    if (sources.some((source) => source.ok === false)) process.exit(1);
}

try {
    if (isMainModule(import.meta.url, process.argv[1])) main();
} catch (error) {
    printJson({ ok: false, redacted: true, error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
}
