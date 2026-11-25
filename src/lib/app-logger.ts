import { readAppLogRetentionMetadata as readRetentionMetadata } from './app-log-retention';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export {
    APP_LOG_DEFAULT_MAX_ENTRIES,
    APP_LOG_MAX_CONFIGURED_ENTRIES,
    APP_LOG_MAX_ENTRIES_ENV,
    APP_LOG_MIN_ENTRIES,
    APP_LOG_RETENTION_LOSS_MODES,
    APP_LOG_RETENTION_STORAGE,
    readAppLogRetentionMetadata,
    type AppLogRetentionMetadata
} from './app-log-retention';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const LOG_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), 'generated-images', '.app-logs');
const DEFAULT_LOG_FILE_NAME = 'app.log.jsonl';
const TEST_LOG_DIR = path.join(os.tmpdir(), 'visual-journal-app-logs');
const TEST_LOG_FILE_NAME = 'app-test.log.jsonl';
const testLogFileNameOverrideEnv = 'APP_LOG_TEST_FILE_NAME';
const testConsoleMirrorEnv = 'APP_LOG_TEST_CONSOLE_MIRROR';

type LogLevel = (typeof LOG_LEVELS)[number];
type LogContext = string | number | boolean | null | Record<string, unknown> | unknown[];

export type AppLogEntry = {
    id: number;
    at: string;
    level: LogLevel;
    message: string;
    context?: string;
    clientRequestId?: string;
    filenames?: string[];
};

type CachedLogLevel = {
    configuredLevel: string | undefined;
    nodeEnv: string | undefined;
    level: LogLevel;
};

let cachedLogLevel: CachedLogLevel | undefined;
let nextLogId = 1;
const logEntries: AppLogEntry[] = [];
const logSubscribers = new Set<(entry: AppLogEntry) => void>();
let hydratedLogFile: string | undefined;
let persistenceEnabledForTest = false;

function resolveLogFile(): string {
    if (process.env.NODE_ENV === 'test') {
        const overrideName = process.env[testLogFileNameOverrideEnv];
        const fileName =
            overrideName && path.basename(overrideName) === overrideName ? overrideName : TEST_LOG_FILE_NAME;
        return path.join(TEST_LOG_DIR, fileName);
    }
    return path.join(LOG_DIR, DEFAULT_LOG_FILE_NAME);
}

function shouldPersistEntries(): boolean {
    return process.env.NODE_ENV !== 'test' || persistenceEnabledForTest;
}

function shouldMirrorToConsole(): boolean {
    return process.env.NODE_ENV !== 'test' || process.env[testConsoleMirrorEnv] !== 'false';
}

function defaultLogLevel(nodeEnv: string | undefined): LogLevel {
    return nodeEnv === 'production' ? 'warn' : 'info';
}

function resolveLogLevel(configuredLevel: string | undefined, nodeEnv: string | undefined): LogLevel {
    if (!configuredLevel) {
        return defaultLogLevel(nodeEnv);
    }
    const normalizedLevel = configuredLevel.trim().toLowerCase();
    return LOG_LEVELS.includes(normalizedLevel as LogLevel) ? (normalizedLevel as LogLevel) : defaultLogLevel(nodeEnv);
}

function readLogLevel(): LogLevel {
    const configuredLevel = process.env.APP_LOG_LEVEL;
    const nodeEnv = process.env.NODE_ENV;
    if (cachedLogLevel && cachedLogLevel.configuredLevel === configuredLevel && cachedLogLevel.nodeEnv === nodeEnv) {
        return cachedLogLevel.level;
    }
    const level = resolveLogLevel(configuredLevel, nodeEnv);
    cachedLogLevel = { configuredLevel, nodeEnv, level };
    return level;
}

function canLog(level: LogLevel): boolean {
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(readLogLevel());
}

function readMaxLogEntries(): number {
    return readRetentionMetadata().max_entries;
}

function serializeContext(context: unknown): string | undefined {
    if (context === undefined) return undefined;
    if (context instanceof Error) {
        return context.stack || context.message;
    }
    if (typeof context === 'string') return context;
    try {
        return JSON.stringify(context, null, 2);
    } catch {
        return String(context);
    }
}

function readClientRequestId(context: unknown): string | undefined {
    if (!context || typeof context !== 'object' || Array.isArray(context) || context instanceof Error) {
        return undefined;
    }
    const value = (context as Record<string, unknown>).clientRequestId;
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized || undefined;
}

function readFilenames(context: unknown): string[] | undefined {
    if (!context || typeof context !== 'object' || Array.isArray(context) || context instanceof Error) {
        return undefined;
    }
    const value = (context as Record<string, unknown>).filenames;
    if (!Array.isArray(value)) return undefined;
    const filenames = normalizeStringArray(value);
    return filenames.length > 0 ? filenames : undefined;
}

function normalizeStringArray(value: unknown[]): string[] {
    return Array.from(
        new Set(
            value
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.trim())
                .filter((item) => item.length > 0)
        )
    );
}

function parsePersistedEntry(line: string): AppLogEntry | undefined {
    try {
        const parsed = JSON.parse(line) as Partial<AppLogEntry>;
        if (
            typeof parsed.id !== 'number' ||
            typeof parsed.at !== 'string' ||
            !LOG_LEVELS.includes(parsed.level as LogLevel) ||
            typeof parsed.message !== 'string'
        ) {
            return undefined;
        }
        const clientRequestId = readClientRequestId(parsed);
        const filenames = Array.isArray(parsed.filenames) ? normalizeStringArray(parsed.filenames) : [];
        return {
            id: parsed.id,
            at: parsed.at,
            level: parsed.level as LogLevel,
            message: parsed.message,
            ...(typeof parsed.context === 'string' ? { context: parsed.context } : {}),
            ...(clientRequestId ? { clientRequestId } : {}),
            ...(filenames.length > 0 ? { filenames } : {})
        };
    } catch {
        return undefined;
    }
}

function serializePersistedEntries(entries: AppLogEntry[]): string {
    return entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '');
}

function compactEntries() {
    const maxEntries = readMaxLogEntries();
    if (logEntries.length > maxEntries) {
        logEntries.splice(0, logEntries.length - maxEntries);
    }
}

function hydratePersistedEntries() {
    if (!shouldPersistEntries()) return;
    const logFile = resolveLogFile();
    if (hydratedLogFile === logFile) return;
    hydratedLogFile = logFile;

    let fileContent: string;
    try {
        fileContent = fs.readFileSync(/* turbopackIgnore: true */ logFile, 'utf8');
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
            return;
        }
        console.error('读取持久化日志失败。', error);
        return;
    }

    const persistedEntries = fileContent
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map(parsePersistedEntry)
        .filter((entry): entry is AppLogEntry => entry !== undefined)
        .slice(-readMaxLogEntries());

    logEntries.length = 0;
    logEntries.push(...persistedEntries);
    nextLogId = Math.max(0, ...persistedEntries.map((entry) => entry.id)) + 1;
}

function persistEntries(rewrite: boolean) {
    if (!shouldPersistEntries()) return;
    const logFile = resolveLogFile();
    try {
        fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(logFile), { recursive: true });
        if (rewrite) {
            fs.writeFileSync(/* turbopackIgnore: true */ logFile, serializePersistedEntries(logEntries), 'utf8');
            return;
        }
        fs.appendFileSync(
            /* turbopackIgnore: true */ logFile,
            JSON.stringify(logEntries[logEntries.length - 1]) + '\n',
            'utf8'
        );
    } catch (error) {
        console.error('写入持久化日志失败。', error);
    }
}

function appendLogEntry(level: LogLevel, message: string, context?: unknown) {
    hydratePersistedEntries();
    const clientRequestId = readClientRequestId(context);
    const filenames = readFilenames(context);
    const entry: AppLogEntry = {
        id: nextLogId++,
        at: new Date().toISOString(),
        level,
        message,
        ...(context === undefined ? {} : { context: serializeContext(context) }),
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(filenames ? { filenames } : {})
    };
    logEntries.push(entry);
    const needsRewrite = logEntries.length > readMaxLogEntries();
    compactEntries();
    persistEntries(needsRewrite);
    logSubscribers.forEach((subscriber) => {
        try {
            subscriber(entry);
        } catch (error) {
            console.error('日志订阅者处理失败。', error);
        }
    });
}

function writeLog(
    level: LogLevel,
    writer: (message?: unknown, ...optionalParams: unknown[]) => void,
    message: string,
    context?: LogContext | unknown
) {
    if (!canLog(level)) {
        return;
    }
    appendLogEntry(level, message, context);
    if (!shouldMirrorToConsole()) {
        return;
    }
    if (context === undefined) {
        writer(message);
        return;
    }
    writer(message, context);
}

export const appLogger = {
    debug(message: string, context?: unknown) {
        writeLog('debug', console.debug, message, context);
    },
    info(message: string, context?: unknown) {
        writeLog('info', console.info, message, context);
    },
    warn(message: string, context?: unknown) {
        writeLog('warn', console.warn, message, context);
    },
    error(message: string, context?: unknown) {
        writeLog('error', console.error, message, context);
    }
};

export function readAppLogEntries(): AppLogEntry[] {
    hydratePersistedEntries();
    return [...logEntries];
}

export function subscribeAppLogs(subscriber: (entry: AppLogEntry) => void): () => void {
    hydratePersistedEntries();
    logSubscribers.add(subscriber);
    return () => {
        logSubscribers.delete(subscriber);
    };
}

export function clearAppLogEntriesForTest(options: { preservePersistedFile?: boolean } = {}) {
    logEntries.length = 0;
    logSubscribers.clear();
    nextLogId = 1;
    const logFile = hydratedLogFile || resolveLogFile();
    hydratedLogFile = undefined;
    if (!options.preservePersistedFile) {
        try {
            fs.rmSync(/* turbopackIgnore: true */ logFile, { force: true });
        } catch {
            // 测试清理不影响生产路径。
        }
    }
}

export function setAppLogPersistenceForTest(enabled: boolean) {
    persistenceEnabledForTest = enabled;
    hydratedLogFile = undefined;
}

export async function readPersistedAppLogEntriesForTest(): Promise<AppLogEntry[]> {
    const logFile = resolveLogFile();
    try {
        const fileContent = await fs.promises.readFile(/* turbopackIgnore: true */ logFile, 'utf8');
        return fileContent
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0)
            .map(parsePersistedEntry)
            .filter((entry): entry is AppLogEntry => entry !== undefined);
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}
