#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IPV4_LOOPBACK_PATTERN = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);

/**
 * 读取部署开关，优先新名 `VJ_*`，回退旧名 `GIP_*`。
 *
 * 旧名来自更名前的 gpt-image-playground 时期：外部 Compose 覆盖文件、CI 的
 * `--env` 覆盖和用户 shell 里都可能仍写着旧名。镜像改名后这些配置不会自动
 * 跟着变，保留回退才能让老部署继续启动，而不是静默丢掉访问策略。
 */
function readDeploymentEnv(env, name) {
    const suffixedName = name.replace(/^VJ_/, 'GIP_');
    return env[name] ?? env[suffixedName];
}

export function isLoopbackBindHost(value) {
    const host = value?.trim().toLowerCase();
    return Boolean(host) && (LOOPBACK_HOSTS.has(host) || IPV4_LOOPBACK_PATTERN.test(host));
}

export function assertDockerComposeAccessPolicy(env = process.env) {
    if (readDeploymentEnv(env, 'VJ_COMPOSE_DEPLOYMENT')?.trim().toLowerCase() !== 'true') return;
    if (isLoopbackBindHost(readDeploymentEnv(env, 'VJ_BIND_HOST'))) return;
    if (env.APP_PASSWORD?.trim()) return;

    throw new Error(
        '拒绝以非回环地址发布 Docker 服务：请先在 .env.local 设置 APP_PASSWORD，或将 VJ_BIND_HOST 保持为 127.0.0.1。'
    );
}

async function main() {
    assertDockerComposeAccessPolicy();
    await import('../server.js');
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
