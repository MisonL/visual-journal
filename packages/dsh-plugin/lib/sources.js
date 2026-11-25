const EDIT_MEDIA_TYPES = Object.freeze({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
});

/**
 * Read edit sources through the Session filesystem provider, so DSH's own
 * working-directory, sandbox, and symlink rules decide what is reachable.
 * Only basenames leave this function; absolute paths never reach tool output.
 */
export async function readEditSources(ctx, exec, { imagePaths, maskPath, limits }) {
    if (!Array.isArray(imagePaths) || imagePaths.length === 0) throw new Error('image_paths 至少需要一张源图。');
    if (imagePaths.length > limits.maxFiles) {
        throw new Error(`image_paths 最多 ${limits.maxFiles} 张，当前为 ${imagePaths.length} 张。`);
    }
    const options = await resolveOptions(ctx, exec);
    let totalBytes = 0;
    const read = async (path, field, { pngOnly }) => {
        const source = await readOne(ctx, exec, path, field, options, limits, pngOnly);
        totalBytes += source.data.byteLength;
        if (totalBytes > limits.maxTotalBytes) {
            throw new Error(`源图总大小超过 ${limits.maxTotalBytes} 字节上限。`);
        }
        return source;
    };
    const images = [];
    for (const [index, path] of imagePaths.entries())
        images.push(await read(path, `image_${index}`, { pngOnly: false }));
    const mask = maskPath === undefined ? undefined : await read(maskPath, 'mask', { pngOnly: true });
    return { images, mask, totalBytes };
}

/** Plan-only view used by dry-run: validates paths and media types without reading bytes. */
export async function inspectEditSources(ctx, exec, { imagePaths, maskPath }) {
    const options = await resolveOptions(ctx, exec);
    const inspect = async (path, field, pngOnly) => {
        const { name, mediaType, size } = await statOne(ctx, path, field, options, pngOnly);
        return { field, name, media_type: mediaType, ...(size === undefined ? {} : { size_bytes: size }) };
    };
    const images = [];
    for (const [index, path] of (imagePaths ?? []).entries()) images.push(await inspect(path, `image_${index}`, false));
    const mask = maskPath === undefined ? undefined : await inspect(maskPath, 'mask', true);
    return { images, ...(mask === undefined ? {} : { mask }) };
}

async function readOne(ctx, exec, path, field, options, limits, pngOnly) {
    const { target, name, mediaType, size } = await statOne(ctx, path, field, options, pngOnly);
    if (size !== undefined && size > limits.maxFileBytes) {
        throw new Error(`${field}（${name}）大小 ${size} 字节超过单图上限 ${limits.maxFileBytes} 字节。`);
    }
    const data = await ctx.fs.readBytes(target, exec.signal, limits.maxFileBytes);
    if (data.byteLength === 0) throw new Error(`${field}（${name}）是空文件。`);
    return { field, name, mediaType, data };
}

async function statOne(ctx, path, field, options, pngOnly) {
    if (typeof path !== 'string' || !path.trim()) throw new Error(`${field} 的路径不能为空。`);
    const entry = await ctx.fs.lstat(path, options);
    if (entry === undefined) throw new Error(`${field} 指向的文件不存在：${basename(path)}`);
    if (entry.type === 'symlink') throw new Error(`${field} 不能是符号链接：${basename(path)}`);
    if (entry.type !== 'file') throw new Error(`${field} 必须是普通文件：${basename(path)}`);
    const target = await ctx.fs.resolve(path, options);
    const name = basename(path);
    const mediaType = EDIT_MEDIA_TYPES[extension(name)];
    if (!mediaType) throw new Error(`${field}（${name}）必须是 PNG、JPEG 或 WebP 图片。`);
    if (pngOnly && mediaType !== 'image/png') throw new Error(`mask（${name}）必须是带透明区域的 PNG。`);
    return { target, name, mediaType, size: entry.size };
}

async function resolveOptions(ctx, exec) {
    if (!ctx.fs) throw new Error('当前 DSH 组合没有挂载文件系统，无法读取源图。');
    const cwd =
        exec.agent === undefined || !ctx.workingDirectory
            ? undefined
            : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    return { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal };
}

function basename(path) {
    return String(path).split(/[\\/]/).filter(Boolean).pop() ?? String(path);
}

function extension(name) {
    const index = name.lastIndexOf('.');
    return index < 0 ? '' : name.slice(index).toLowerCase();
}
