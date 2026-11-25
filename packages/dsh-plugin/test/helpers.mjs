import { apply, Config } from '../lib/index.js';

export const BASE_URL = 'http://localhost:4783';

export const CAPABILITIES = {
    defaults: { model: 'gpt-image-2', image_backend: 'images-api', stream_mode: 'auto', partial_images: 0 },
    limits: {
        max_prompt_length: 32000,
        generate_images: { min: 1, max: 4 },
        edit_images: { min: 1, max: 4 },
        generate_images_by_backend: {
            'images-api': { min: 1, max: 4 },
            'responses-image-generation': { min: 1, max: 1 }
        },
        partial_images: { min: 0, max: 3 },
        partial_images_by_backend: {
            'images-api': { min: 0, max: 3 },
            'responses-image-generation': { min: 1, max: 3, allowedValues: [1, 3] }
        },
        upload_images: { max: 2 },
        max_upload_mb: 1,
        max_total_upload_mb: 1.5
    }
};

/** A fake DSH composition: tool registry, optional services, listeners, and injection. */
export function createContext({ config = {}, services = {}, injectServices = true } = {}) {
    const tools = new Map();
    const listeners = new Map();
    const skills = [];
    const ctx = {
        tools: {
            register(definition) {
                tools.set(definition.name, definition);
                return () => tools.delete(definition.name);
            }
        },
        on(event, listener) {
            listeners.set(event, listener);
            return () => listeners.delete(event);
        },
        get(name) {
            return services[name];
        },
        inject(deps, callback) {
            if (!injectServices) return;
            if (deps.includes('skills')) {
                callback({ ...ctx, skills: { register: (skill) => (skills.push(skill), () => {}) } });
                return;
            }
            if (deps.every((dep) => services[dep] !== undefined)) {
                callback({ ...ctx, ...Object.fromEntries(deps.map((dep) => [dep, services[dep]])) });
            }
        }
    };
    apply(ctx, Config({ baseUrl: BASE_URL, ...config }));
    return { ctx, tools, listeners, skills };
}

export function exec(overrides = {}) {
    return { signal: new AbortController().signal, callId: 'call-1', ...overrides };
}

export function json(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * Replace global fetch with a router keyed by `METHOD path`. Each handler may be
 * a Response, a function, or an array consumed in order.
 */
export function mockFetch(routes) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method ?? 'GET';
        const key = `${method} ${url.pathname}`;
        calls.push({ method, url: url.toString(), path: url.pathname, headers: init.headers ?? {}, body: init.body });
        let handler = routes[key];
        if (Array.isArray(handler)) handler = handler.length > 1 ? handler.shift() : handler[0];
        if (handler === undefined) return json({ error: { code: 'not_mocked', message: key } }, 599);
        return typeof handler === 'function' ? handler({ url, init, calls }) : handler.clone();
    };
    return {
        calls,
        restore() {
            globalThis.fetch = original;
        }
    };
}

export async function withEnv(values, run) {
    const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await run();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

/** An attachment store that records saved images and returns stable references. */
export function attachmentStore() {
    const saved = [];
    return {
        saved,
        imageLimits: {
            maxImageBytes: 1024,
            maxMessageImageBytes: 4096,
            maxImagesPerMessage: 4,
            mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
        },
        async saveImage(input) {
            saved.push(input);
            return {
                attachmentId: `att-${saved.length}`,
                mediaType: input.mediaType,
                bytes: input.data.byteLength,
                width: 8,
                height: 8,
                name: input.name
            };
        }
    };
}

/** An image-capable model route for attachment gating. */
export function imageAgent(modalities = ['text', 'image']) {
    return {
        agent: { options: { provider: 'p', model: 'm' }, session: { requestHeader: () => undefined } },
        llm: {
            async resolveModelInfo() {
                return { inputModalities: modalities };
            }
        }
    };
}

/** A fake Session filesystem keyed by relative path. */
export function memoryFs(files) {
    return {
        async lstat(path) {
            const entry = files[path];
            if (!entry) return undefined;
            return { version: 'v1', type: entry.type ?? 'file', size: entry.data?.byteLength };
        },
        async resolve(path) {
            return { displayPath: path, targetKey: path };
        },
        async readBytes(target, _signal, maxBytes) {
            const entry = files[target.targetKey];
            if (entry.data.byteLength > maxBytes) throw new Error('FS_TOO_LARGE');
            return entry.data;
        }
    };
}
