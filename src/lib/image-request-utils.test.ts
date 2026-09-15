import {
    assertMaskCompatibility,
    assertSafeApiOverride,
    readBackground,
    readEditQuality,
    readGenerateQuality,
    readImageFiles,
    readMaskFile,
    readModel,
    readOutputCompression,
    readOutputFormat,
    readPlainHttpApiBaseUrlAllowlist,
    readSize,
    resolveDefaultImageModel,
    validateApiBaseUrl
} from './image-request-utils';
import { IMAGE_UPSTREAM_PROFILES } from './image-upstream-profile';
import { isLoopbackIpAddress, isPublicIpAddress, isSyntheticDnsIpAddress } from './network-security';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';

describe('image request quality defaults', () => {
    it('defaults image generation to high quality', () => {
        assert.equal(readGenerateQuality(new FormData()), 'high');
    });

    it('keeps image editing quality on auto by default', () => {
        assert.equal(readEditQuality(new FormData()), 'auto');
    });
});

describe('custom image models', () => {
    it('accepts non-empty custom model names', () => {
        const formData = new FormData();
        formData.set('model', 'gpt-image-2-1k');
        assert.equal(readModel(formData), 'gpt-image-2-1k');
    });
});

describe('configured image model defaults', () => {
    it('uses OPENAI_IMAGE_MODEL for omitted form and agent defaults', () => {
        assert.equal(resolveDefaultImageModel({ OPENAI_IMAGE_MODEL: 'gpt-image-2-1k' }), 'gpt-image-2-1k');
        assert.equal(resolveDefaultImageModel({ OPENAI_IMAGE_MODEL: '  custom-image-model  ' }), 'custom-image-model');
        assert.equal(resolveDefaultImageModel({ OPENAI_IMAGE_MODEL: 'x'.repeat(201) }), 'gpt-image-2');
        assert.equal(resolveDefaultImageModel({}), 'gpt-image-2');
    });

    it('applies the configured model when a form omits model', () => {
        const original = process.env.OPENAI_IMAGE_MODEL;
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2-1k';
        try {
            assert.equal(readModel(new FormData()), 'gpt-image-2-1k');
        } finally {
            if (original === undefined) delete process.env.OPENAI_IMAGE_MODEL;
            else process.env.OPENAI_IMAGE_MODEL = original;
        }
    });
});

describe('image output defaults', () => {
    it('defaults output format to high-quality webp', () => {
        const formData = new FormData();
        const outputFormat = readOutputFormat(formData);

        assert.equal(outputFormat, 'webp');
        assert.equal(readOutputCompression(formData, outputFormat), 100);
    });

    it('does not add output compression for png output', () => {
        const formData = new FormData();
        formData.set('output_format', 'png');
        const outputFormat = readOutputFormat(formData);

        assert.equal(outputFormat, 'png');
        assert.equal(readOutputCompression(formData, outputFormat), undefined);
    });
});

describe('validateApiBaseUrl', () => {
    it('accepts https and local http OpenAI-compatible base URLs', () => {
        assert.doesNotThrow(() => validateApiBaseUrl('https://api.openai.com/v1'));
        assert.doesNotThrow(() => validateApiBaseUrl('http://localhost:4783/v1'));
        assert.doesNotThrow(() => validateApiBaseUrl('http://127.0.0.1:4783/v1'));
        assert.doesNotThrow(() => validateApiBaseUrl('http://[::1]:4783/v1'));
        assert.doesNotThrow(() => validateApiBaseUrl('http://[::ffff:7f00:1]:4783/v1'));
        assert.doesNotThrow(() => validateApiBaseUrl('http://[::ffff:0:7f00:1]:4783/v1'));
        assert.doesNotThrow(() => validateApiBaseUrl('http://[0:0:0:0:0:ffff:7f00:1]:4783/v1'));
        assert.doesNotThrow(() => validateApiBaseUrl('http://loopback.localhost:4783/v1'));
    });

    it('rejects remote plain-http API base URLs by default', () => {
        assert.throws(() => validateApiBaseUrl('http://api.j3gb.com/v1'), /HTTPS/);
        assert.throws(() => validateApiBaseUrl('http://192.168.1.2/v1'), /HTTPS/);
    });

    it('accepts explicitly allowlisted remote plain-http API base URLs', () => {
        assert.doesNotThrow(() =>
            validateApiBaseUrl('http://api.j3gb.com/v1', {
                allowedPlainHttpBaseUrls: ['http://api.j3gb.com/v1']
            })
        );
    });

    it('rejects malformed plain-http allowlist entries instead of silently ignoring them', () => {
        assert.deepEqual(readPlainHttpApiBaseUrlAllowlist(' http://api.j3gb.com/v1 , '), ['http://api.j3gb.com/v1']);
        assert.throws(
            () => readPlainHttpApiBaseUrlAllowlist('https://api.j3gb.com/v1'),
            /第 1 项必须是无凭据、无查询参数和无片段的 http URL/
        );
        assert.throws(
            () => readPlainHttpApiBaseUrlAllowlist('http://api.j3gb.com/v1?token=secret'),
            /第 1 项必须是无凭据、无查询参数和无片段的 http URL/
        );
        assert.throws(() => readPlainHttpApiBaseUrlAllowlist('not-a-url'), /第 1 项必须是有效的 http URL/);
    });

    it('rejects non-http protocols', () => {
        assert.throws(() => validateApiBaseUrl('ftp://api.example.com/v1'), /http 或 https/);
    });

    it('rejects credentials, query strings, and fragments', () => {
        assert.throws(() => validateApiBaseUrl('https://user:pass@example.com/v1'), /用户名或密码/);
        assert.throws(() => validateApiBaseUrl('https://example.com/v1?token=one'), /查询参数或片段/);
        assert.throws(() => validateApiBaseUrl('https://example.com/v1#key'), /查询参数或片段/);
    });
});

describe('assertSafeApiOverride', () => {
    it('rejects a request-level URL when the server would proxy it', () => {
        assert.throws(
            () =>
                assertSafeApiOverride('sk-request', 'https://attacker.example/v1', {
                    upstreamProxyConfigured: true
                }),
            /请求级自定义 API URL.*服务端上游代理/
        );
    });

    it('keeps request-level URLs available without a server proxy', () => {
        assert.doesNotThrow(() => assertSafeApiOverride('sk-request', 'https://api.example/v1'));
        assert.doesNotThrow(() => assertSafeApiOverride('', ''));
    });
});

describe('isLoopbackIpAddress', () => {
    it('recognizes native and IPv4-mapped loopback forms', () => {
        for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:0:7f00:1']) {
            assert.equal(isLoopbackIpAddress(address), true, address);
        }
    });

    it('does not treat private non-loopback addresses as loopback', () => {
        for (const address of ['0.0.0.0', '10.0.0.1', '::', '::ffff:0a00:1', '::ffff:ac10:1']) {
            assert.equal(isLoopbackIpAddress(address), false, address);
        }
    });
});

describe('isPublicIpAddress', () => {
    it('normalizes bracketed IPv6 addresses before applying reserved-range checks', () => {
        assert.equal(isPublicIpAddress('[2001:4860:4860::8888]'), true);
        assert.equal(isPublicIpAddress('[::ffff:172.16.0.1]'), false);
    });
});

describe('isSyntheticDnsIpAddress', () => {
    it('recognizes only the RFC 2544 benchmarking range', () => {
        assert.equal(isSyntheticDnsIpAddress('198.18.1.24'), true);
        assert.equal(isSyntheticDnsIpAddress('[198.19.255.254]'), true);
        assert.equal(isSyntheticDnsIpAddress('198.17.1.24'), false);
        assert.equal(isSyntheticDnsIpAddress('10.0.0.1'), false);
        assert.equal(isSyntheticDnsIpAddress('::ffff:198.18.1.24'), false);
    });
});

describe('readImageFiles', () => {
    it('accepts only documented image_0 through image_9 upload fields', () => {
        const formData = new FormData();
        formData.append('avatar', makePngFile('ignored-avatar.png'));
        formData.append('image_backend', 'responses-image-generation');
        formData.append('image_streaming_strategy', 'force-sse');
        formData.append('image_1', makePngFile('accepted-1.png'));
        formData.append('image_9', makePngFile('accepted-9.png'));

        assert.deepEqual(
            readImageFiles(formData).map((file) => file.name),
            ['accepted-1.png', 'accepted-9.png']
        );
    });

    it('rejects undocumented image-like upload fields instead of ignoring them', () => {
        const formData = new FormData();
        formData.append('image_foo', makePngFile('ignored-foo.png'));
        formData.append('image_0', makePngFile('accepted-0.png'));

        assert.throws(() => readImageFiles(formData), /图片字段 image_foo 无效/);
    });

    it('rejects zero-padded and out-of-range image upload fields', () => {
        const formData = new FormData();
        formData.append('image_01', makePngFile('ignored-01.png'));
        formData.append('image_10', makePngFile('ignored-10.png'));

        assert.throws(() => readImageFiles(formData), /图片字段 image_01 无效/);
    });

    it('rejects documented image fields when their value is not a file', () => {
        const formData = new FormData();
        formData.append('image_0', 'not-a-file');

        assert.throws(() => readImageFiles(formData), /image_0 必须是图片文件/);
    });

    it('returns uploaded images sorted by numeric field index', () => {
        const formData = new FormData();
        formData.append('image_1', makePngFile('second.png'));
        formData.append('image_0', makePngFile('first.png'));

        assert.deepEqual(
            readImageFiles(formData).map((file) => file.name),
            ['first.png', 'second.png']
        );
    });

    it('rejects duplicate image upload fields', () => {
        const formData = new FormData();
        formData.append('image_0', makePngFile('first.png'));
        formData.append('image_0', makePngFile('duplicate.png'));

        assert.throws(() => readImageFiles(formData), /图片字段 image_0 重复/);
    });

    it('uses Matsca upload limits from the upstream profile', () => {
        const validFormData = new FormData();
        validFormData.append('image_7', makePngFile('accepted-7.png'));
        assert.deepEqual(
            readImageFiles(validFormData, IMAGE_UPSTREAM_PROFILES.matsca).map((file) => file.name),
            ['accepted-7.png']
        );

        const outOfRangeFormData = new FormData();
        outOfRangeFormData.append('image_8', makePngFile('rejected-8.png'));
        assert.throws(() => readImageFiles(outOfRangeFormData, IMAGE_UPSTREAM_PROFILES.matsca), /image_0 到 image_7/);

        const oversizedFormData = new FormData();
        oversizedFormData.append(
            'image_0',
            new File([Buffer.alloc(10 * 1024 * 1024 + 1)], 'oversized.png', { type: 'image/png' })
        );
        assert.throws(() => readImageFiles(oversizedFormData, IMAGE_UPSTREAM_PROFILES.matsca), /10 MB/);
    });

    it('rejects source image formats outside the documented PNG, JPEG, and WebP contract', () => {
        const formData = new FormData();
        formData.append('image_0', new File(['image'], 'source.gif', { type: 'image/gif' }));

        assert.throws(() => readImageFiles(formData), /PNG、JPEG 或 WebP/);
    });
});

describe('Matsca upstream image parameter compatibility', () => {
    it('allows transparent gpt-image-2 backgrounds only with the Matsca profile', () => {
        const formData = new FormData();
        formData.append('background', 'transparent');

        assert.throws(() => readBackground(formData, 'gpt-image-2'), /不支持 transparent/);
        assert.equal(readBackground(formData, 'gpt-image-2', IMAGE_UPSTREAM_PROFILES.matsca), 'transparent');
    });

    it('allows arbitrary positive integer gpt-image-2 sizes only with the Matsca profile', () => {
        const formData = new FormData();
        formData.append('size', '123x456');

        assert.throws(() => readSize(formData, 'size', '1024x1024', 'gpt-image-2'), /无效/);
        assert.equal(readSize(formData, 'size', '1024x1024', 'gpt-image-2', IMAGE_UPSTREAM_PROFILES.matsca), '123x456');
    });

    it('applies gpt-image-2 size and background rules to the default 1K model alias', () => {
        const sizeFormData = new FormData();
        sizeFormData.append('size', '123x456');
        const backgroundFormData = new FormData();
        backgroundFormData.append('background', 'transparent');

        assert.throws(() => readSize(sizeFormData, 'size', '1024x1024', 'gpt-image-2-1k'), /无效/);
        assert.equal(
            readSize(sizeFormData, 'size', '1024x1024', 'gpt-image-2-1k', IMAGE_UPSTREAM_PROFILES.matsca),
            '123x456'
        );
        assert.throws(() => readBackground(backgroundFormData, 'gpt-image-2-1k'), /不支持 transparent/);
        assert.equal(
            readBackground(backgroundFormData, 'gpt-image-2-1k', IMAGE_UPSTREAM_PROFILES.matsca),
            'transparent'
        );
    });

    it('allows explicit force_request to bypass local gpt-image-2 size and background profile limits', () => {
        const sizeFormData = new FormData();
        sizeFormData.append('size', '512x512');
        const backgroundFormData = new FormData();
        backgroundFormData.append('background', 'transparent');

        assert.throws(() => readSize(sizeFormData, 'size', '1024x1024', 'gpt-image-2'), /总像素/);
        assert.equal(
            readSize(sizeFormData, 'size', '1024x1024', 'gpt-image-2', IMAGE_UPSTREAM_PROFILES['openai-compatible'], {
                forceRequest: true
            }),
            '512x512'
        );
        assert.equal(
            readBackground(backgroundFormData, 'gpt-image-2', IMAGE_UPSTREAM_PROFILES['openai-compatible'], {
                forceRequest: true
            }),
            'transparent'
        );
    });

    it('does not let force_request bypass non gpt-image-2 size allowlists', () => {
        const formData = new FormData();
        formData.append('size', '512x512');

        assert.throws(
            () =>
                readSize(formData, 'size', '1024x1024', 'gpt-image-1', IMAGE_UPSTREAM_PROFILES['openai-compatible'], {
                    forceRequest: true
                }),
            /gpt-image-1 无效/
        );
    });

    it('applies provider-defined positive WxH sizing to custom models', () => {
        const valid = new FormData();
        valid.append('size', '2048x2048');
        assert.equal(readSize(valid, 'size', '1024x1024', 'custom-image-model'), '2048x2048');

        const invalid = new FormData();
        invalid.append('size', 'wide');
        assert.throws(() => readSize(invalid, 'size', '1024x1024', 'custom-image-model'), /auto 或 WxH/);

        const nonPositive = new FormData();
        nonPositive.append('size', '0x2048');
        assert.throws(() => readSize(nonPositive, 'size', '1024x1024', 'custom-image-model'), /正整数/);
    });

    it('keeps the local resource budget active when force_request is enabled', () => {
        const formData = new FormData();
        formData.append('size', '100000x100000');

        assert.throws(
            () =>
                readSize(formData, 'size', '1024x1024', 'custom-image-model', IMAGE_UPSTREAM_PROFILES.matsca, {
                    forceRequest: true
                }),
            /单边最大值/
        );
    });

    it('uses the Matsca single upload limit for masks too', () => {
        const formData = new FormData();
        formData.append('mask', new File([Buffer.alloc(10 * 1024 * 1024 + 1)], 'mask.png', { type: 'image/png' }));

        assert.throws(() => readMaskFile(formData, IMAGE_UPSTREAM_PROFILES.matsca), /10 MB/);
    });
});

describe('assertMaskCompatibility', () => {
    it('accepts a PNG mask with transparent pixels and matching source dimensions', async () => {
        await assert.doesNotReject(
            assertMaskCompatibility(makePngFile('mask.png', makeRgbaPng({ alpha: 0 })), [makePngFile('source.png')])
        );
    });

    it('rejects PNG masks without transparent pixels', async () => {
        await assert.rejects(
            assertMaskCompatibility(makePngFile('mask.png', makeRgbaPng({ alpha: 255 })), [makePngFile('source.png')]),
            /mask 必须包含透明区域/
        );
    });

    it('rejects masks whose dimensions do not match the first source image', async () => {
        await assert.rejects(
            assertMaskCompatibility(makePngFile('mask.png', makeRgbaPng({ width: 2, height: 1, alpha: 0 })), [
                makePngFile('source.png')
            ]),
            /mask 尺寸/
        );
    });

    it('wraps corrupt PNG mask pixel data as a validation error', async () => {
        await assert.rejects(
            assertMaskCompatibility(makePngFile('mask.png', makeRgbaPng({ alpha: 0, corruptIdat: true })), [
                makePngFile('source.png')
            ]),
            /mask PNG 像素数据无法解压/
        );
    });
});

function makePngFile(name: string, bytes: BlobPart = Buffer.from(PNG_BASE64, 'base64')): File {
    return new File([bytes], name, { type: 'image/png' });
}

function makeRgbaPng(input: { width?: number; height?: number; alpha: number; corruptIdat?: boolean }): Buffer {
    const width = input.width ?? 1;
    const height = input.height ?? 1;
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let offset = 1; offset < row.length; offset += 4) {
        row[offset] = 255;
        row[offset + 1] = 255;
        row[offset + 2] = 255;
        row[offset + 3] = input.alpha;
    }
    return Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        makePngChunk('IHDR', Buffer.from([0, 0, 0, width, 0, 0, 0, height, 8, 6, 0, 0, 0])),
        makePngChunk(
            'IDAT',
            input.corruptIdat
                ? Buffer.from('not-zlib-data')
                : deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))
        ),
        makePngChunk('IEND', Buffer.alloc(0))
    ]);
}

function makePngChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNk+A8AAwMBASp7pYQAAAAASUVORK5CYII=';
