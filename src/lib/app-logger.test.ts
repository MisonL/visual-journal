import {
    appLogger,
    clearAppLogEntriesForTest,
    readAppLogRetentionMetadata,
    readAppLogEntries,
    readPersistedAppLogEntriesForTest,
    setAppLogPersistenceForTest,
    subscribeAppLogs
} from './app-logger';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const originalLogLevel = process.env.APP_LOG_LEVEL;
const originalMaxEntries = process.env.APP_LOG_MAX_ENTRIES;
const originalNodeEnv = process.env.NODE_ENV;
const originalTestLogFileName = process.env.APP_LOG_TEST_FILE_NAME;
const originalTestConsoleMirror = process.env.APP_LOG_TEST_CONSOLE_MIRROR;
const originalDebug = console.debug;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;
const nodeEnvKey: string = 'NODE_ENV';
const testLogFileNameKey = 'APP_LOG_TEST_FILE_NAME';
const testConsoleMirrorEnv = 'APP_LOG_TEST_CONSOLE_MIRROR';
const sourcePath = fileURLToPath(new URL('./app-logger.ts', import.meta.url));

beforeEach(async () => {
    process.env[nodeEnvKey] = 'test';
    process.env[testConsoleMirrorEnv] = 'true';
    process.env[testLogFileNameKey] =
        `app-logger-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`;
    setAppLogPersistenceForTest(true);
    clearAppLogEntriesForTest();
});

afterEach(async () => {
    clearAppLogEntriesForTest();
    setAppLogPersistenceForTest(false);
    if (originalLogLevel === undefined) {
        delete process.env.APP_LOG_LEVEL;
    } else {
        process.env.APP_LOG_LEVEL = originalLogLevel;
    }
    if (originalMaxEntries === undefined) {
        delete process.env.APP_LOG_MAX_ENTRIES;
    } else {
        process.env.APP_LOG_MAX_ENTRIES = originalMaxEntries;
    }
    if (originalNodeEnv === undefined) {
        delete process.env[nodeEnvKey];
    } else {
        process.env[nodeEnvKey] = originalNodeEnv;
    }
    if (originalTestLogFileName === undefined) {
        delete process.env[testLogFileNameKey];
    } else {
        process.env[testLogFileNameKey] = originalTestLogFileName;
    }
    if (originalTestConsoleMirror === undefined) {
        delete process.env[testConsoleMirrorEnv];
    } else {
        process.env[testConsoleMirrorEnv] = originalTestConsoleMirror;
    }
    console.debug = originalDebug;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
});

it('keeps the test log override scoped to the fixed app log directory', () => {
    console.info = () => {};
    process.env[testLogFileNameKey] = path.join('..', 'outside.jsonl');
    clearAppLogEntriesForTest();

    appLogger.info('scoped test log override');

    assert.equal(readAppLogEntries().at(-1)?.message, 'scoped test log override');
});

it('exposes the app log retention boundary for diagnostic contracts', () => {
    assert.deepEqual(readAppLogRetentionMetadata({ APP_LOG_MAX_ENTRIES: '10' }), {
        storage: 'bounded_local_jsonl',
        max_entries: 100,
        default_max_entries: 300,
        min_entries: 100,
        max_configured_entries: 5000,
        configured_by: 'APP_LOG_MAX_ENTRIES',
        persisted_across_process_restart: true,
        loss_modes: ['entry_evicted_by_max_entries', 'log_level_filter', 'local_log_file_missing_or_cleared']
    });
});

it('keeps runtime log file operations out of Next standalone tracing', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const tracedRuntimeFileOperations = [
        'fs.readFileSync(/* turbopackIgnore: true */ logFile',
        'fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(logFile)',
        'fs.writeFileSync(/* turbopackIgnore: true */ logFile',
        /fs\.appendFileSync\(\s*\/\* turbopackIgnore: true \*\/ logFile/,
        'fs.rmSync(/* turbopackIgnore: true */ logFile',
        'fs.promises.readFile(/* turbopackIgnore: true */ logFile'
    ];

    for (const operation of tracedRuntimeFileOperations) {
        const hasOperation = typeof operation === 'string' ? source.includes(operation) : operation.test(source);
        assert.ok(hasOperation, `missing standalone tracing guard: ${String(operation)}`);
    }
});

describe('appLogger', { concurrency: false }, () => {
    it('uses warn as the production default log level', () => {
        const calls: string[] = [];
        delete process.env.APP_LOG_LEVEL;
        process.env[nodeEnvKey] = 'production';
        console.info = (message?: unknown) => {
            calls.push(`info:${String(message)}`);
        };
        console.warn = (message?: unknown) => {
            calls.push(`warn:${String(message)}`);
        };

        appLogger.info('hidden info');
        appLogger.warn('visible warning');

        assert.deepEqual(calls, ['warn:visible warning']);
    });

    it('normalizes configured log level before filtering messages', () => {
        const calls: string[] = [];
        process.env.APP_LOG_LEVEL = ' ERROR ';
        console.warn = (message?: unknown) => {
            calls.push(`warn:${String(message)}`);
        };
        console.error = (message?: unknown) => {
            calls.push(`error:${String(message)}`);
        };

        appLogger.warn('hidden warning');
        appLogger.error('visible error');

        assert.deepEqual(calls, ['error:visible error']);
    });

    it('falls back to the default level for invalid configured values', () => {
        const calls: string[] = [];
        process.env.APP_LOG_LEVEL = 'verbose';
        process.env[nodeEnvKey] = 'production';
        console.info = (message?: unknown) => {
            calls.push(`info:${String(message)}`);
        };
        console.warn = (message?: unknown) => {
            calls.push(`warn:${String(message)}`);
        };

        appLogger.info('hidden info');
        appLogger.warn('visible warning');

        assert.deepEqual(calls, ['warn:visible warning']);
    });

    it('passes context only when it is provided', () => {
        const calls: unknown[][] = [];
        process.env.APP_LOG_LEVEL = 'debug';
        console.info = (...args: unknown[]) => {
            calls.push(args);
        };

        appLogger.info('plain message');
        appLogger.info('context message', { requestId: 'req-1' });

        assert.deepEqual(calls, [['plain message'], ['context message', { requestId: 'req-1' }]]);
    });

    it('keeps test diagnostics when test console mirroring is disabled', () => {
        const calls: unknown[][] = [];
        const received: string[] = [];
        process.env[testConsoleMirrorEnv] = 'false';
        console.error = (...args: unknown[]) => {
            calls.push(args);
        };
        const unsubscribe = subscribeAppLogs((entry) => {
            received.push(`${entry.level}:${entry.message}`);
        });

        appLogger.error('expected test diagnostic', { requestId: 'req-test-diagnostic' });
        unsubscribe();

        assert.deepEqual(calls, []);
        assert.equal(readAppLogEntries().at(-1)?.message, 'expected test diagnostic');
        assert.deepEqual(received, ['error:expected test diagnostic']);
    });

    it('keeps console mirroring enabled outside test mode when the test-only switch is false', () => {
        const calls: unknown[][] = [];
        process.env[nodeEnvKey] = 'production';
        process.env.APP_LOG_LEVEL = 'error';
        process.env[testConsoleMirrorEnv] = 'false';
        console.error = (...args: unknown[]) => {
            calls.push(args);
        };

        appLogger.error('production diagnostic');

        assert.deepEqual(calls, [['production diagnostic']]);
    });

    it('allows debug messages at debug level', () => {
        const calls: unknown[][] = [];
        process.env.APP_LOG_LEVEL = 'debug';
        console.debug = (...args: unknown[]) => {
            calls.push(args);
        };

        appLogger.debug('debug message', { requestId: 'req-2' });

        assert.deepEqual(calls, [['debug message', { requestId: 'req-2' }]]);
    });

    it('stores emitted entries for live log subscribers', () => {
        const received: string[] = [];
        process.env.APP_LOG_LEVEL = 'info';
        console.info = () => {};
        const unsubscribe = subscribeAppLogs((entry) => {
            received.push(`${entry.level}:${entry.message}`);
        });

        appLogger.info('visible info', { requestId: 'req-3' });
        unsubscribe();
        appLogger.info('after unsubscribe');

        const entries = readAppLogEntries();
        assert.equal(entries.length, 2);
        const firstEntry = entries[0];
        assert.ok(firstEntry);
        assert.equal(firstEntry.level, 'info');
        assert.equal(firstEntry.message, 'visible info');
        assert.equal(typeof firstEntry.context, 'string');
        assert.equal(firstEntry.clientRequestId, undefined);
        assert.ok(firstEntry.context);
        assert.match(firstEntry.context, /"requestId": "req-3"/);
        assert.deepEqual(received, ['info:visible info']);
    });

    it('promotes client request ids into a structured log field', () => {
        process.env.APP_LOG_LEVEL = 'info';
        console.info = () => {};

        appLogger.info('request scoped message', { clientRequestId: 'client-req-1', requestId: 'upstream-req-1' });

        const [entry] = readAppLogEntries();
        assert.equal(entry.clientRequestId, 'client-req-1');
        assert.match(entry.context || '', /"clientRequestId": "client-req-1"/);
    });

    it('promotes filenames into a structured log field', () => {
        process.env.APP_LOG_LEVEL = 'info';
        console.info = () => {};

        appLogger.info('saved images', {
            clientRequestId: 'client-req-2',
            filenames: ['image-a.png', 'image-b.png']
        });

        const [entry] = readAppLogEntries();
        assert.deepEqual(entry.filenames, ['image-a.png', 'image-b.png']);
    });

    it('normalizes request ids and filenames before storing structured log fields', () => {
        process.env.APP_LOG_LEVEL = 'info';
        console.info = () => {};

        appLogger.info('dirty structured context', {
            clientRequestId: ' client-req-trimmed ',
            filenames: [' image-a.png ', '', 'image-a.png', ' image-b.png ', 1]
        });

        const [entry] = readAppLogEntries();
        assert.equal(entry.clientRequestId, 'client-req-trimmed');
        assert.deepEqual(entry.filenames, ['image-a.png', 'image-b.png']);
    });

    it('hydrates entries from the persisted jsonl log file', async () => {
        process.env.APP_LOG_LEVEL = 'info';
        console.info = () => {};

        appLogger.info('persisted message', {
            clientRequestId: 'client-req-3',
            filenames: ['persisted.png']
        });
        clearAppLogEntriesForTest({ preservePersistedFile: true });

        const entries = readAppLogEntries();

        assert.equal(entries.length, 1);
        assert.equal(entries[0].message, 'persisted message');
        assert.equal(entries[0].clientRequestId, 'client-req-3');
        assert.deepEqual(entries[0].filenames, ['persisted.png']);
    });

    it('normalizes structured fields when hydrating persisted jsonl log entries', async () => {
        const logFile = path.join(
            os.tmpdir(),
            'visual-journal-app-logs',
            process.env[testLogFileNameKey] ?? 'app-test.log.jsonl'
        );
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(
            logFile,
            `${JSON.stringify({
                id: 1,
                at: '2026-05-12T00:00:00.000Z',
                level: 'info',
                message: 'dirty persisted message',
                clientRequestId: ' persisted-req ',
                filenames: [' persisted.png ', '', 'persisted.png', 1]
            })}\n`,
            'utf8'
        );
        clearAppLogEntriesForTest({ preservePersistedFile: true });

        const entries = readAppLogEntries();

        assert.equal(entries.length, 1);
        assert.equal(entries[0].clientRequestId, 'persisted-req');
        assert.deepEqual(entries[0].filenames, ['persisted.png']);
    });

    it('keeps only the newest 300 entries in the persisted log file', async () => {
        process.env.APP_LOG_LEVEL = 'info';
        console.info = () => {};

        for (let index = 0; index < 305; index++) {
            appLogger.info(`message ${index}`);
        }

        const entries = await readPersistedAppLogEntriesForTest();
        assert.equal(entries.length, 300);
        assert.equal(entries[0].message, 'message 5');
        assert.equal(entries[299].message, 'message 304');
    });

    it('uses APP_LOG_MAX_ENTRIES for larger diagnostic windows', async () => {
        process.env.APP_LOG_LEVEL = 'info';
        process.env.APP_LOG_MAX_ENTRIES = '350';
        console.info = () => {};

        for (let index = 0; index < 360; index++) {
            appLogger.info(`message ${index}`);
        }

        const entries = await readPersistedAppLogEntriesForTest();
        assert.equal(entries.length, 350);
        assert.equal(entries[0].message, 'message 10');
        assert.equal(entries[349].message, 'message 359');
    });

    it('clamps tiny APP_LOG_MAX_ENTRIES values to keep diagnostics useful', async () => {
        process.env.APP_LOG_LEVEL = 'info';
        process.env.APP_LOG_MAX_ENTRIES = '10';
        console.info = () => {};

        for (let index = 0; index < 120; index++) {
            appLogger.info(`message ${index}`);
        }

        const entries = await readPersistedAppLogEntriesForTest();
        assert.equal(entries.length, 100);
        assert.equal(entries[0].message, 'message 20');
    });

    it('does not store messages filtered out by the configured log level', () => {
        delete process.env.APP_LOG_LEVEL;
        process.env[nodeEnvKey] = 'production';
        console.info = () => {
            throw new Error('filtered info should not be written');
        };
        const entriesBefore = readAppLogEntries();

        appLogger.info('hidden info');

        assert.deepEqual(readAppLogEntries(), entriesBefore);
    });

    it('continues notifying subscribers when one subscriber throws', () => {
        const received: string[] = [];
        const errors: unknown[][] = [];
        process.env.APP_LOG_LEVEL = 'info';
        console.info = () => {};
        console.error = (...args: unknown[]) => {
            errors.push(args);
        };
        subscribeAppLogs(() => {
            throw new Error('subscriber failed');
        });
        subscribeAppLogs((entry) => {
            received.push(entry.message);
        });

        appLogger.info('visible info');

        assert.deepEqual(received, ['visible info']);
        assert.equal(errors.length, 1);
    });
});
