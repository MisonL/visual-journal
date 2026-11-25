import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('Docker build context', () => {
    it('keeps the tracked real-upstream smoke template available to containerized tests', async () => {
        const [
            dockerignore,
            dockerfile,
            gitignore,
            realSmokeTemplate,
            compose,
            postgresCompose,
            tunCompose,
            ciWorkflow
        ] = await Promise.all([
            readFile(new URL('../.dockerignore', import.meta.url), 'utf8'),
            readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
            readFile(new URL('../.gitignore', import.meta.url), 'utf8'),
            readFile(new URL('../.env.real-smoke.example', import.meta.url), 'utf8'),
            readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8'),
            readFile(new URL('../docker-compose.postgres.yml', import.meta.url), 'utf8'),
            readFile(new URL('../docker-compose.tun.yml', import.meta.url), 'utf8'),
            readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
        ]);

        assert.match(dockerignore, /^\.gitignore$/m);
        assert.match(dockerignore, /^!\.gitignore$/m);
        assert.match(dockerignore, /^\.env\.\*$/m);
        assert.match(dockerignore, /^!\.env\.real-smoke\.example$/m);
        assert.match(dockerfile, /^COPY \. \.$/m);
        assert.match(dockerfile, /^COPY vendor\/brace-expansion-compat \.\/vendor\/brace-expansion-compat$/m);
        assert.match(
            dockerfile,
            /^COPY --from=builder --chown=node:node \/app\/scripts\/docker-entrypoint\.mjs \.\/scripts\/docker-entrypoint\.mjs$/m
        );
        assert.match(dockerfile, /^HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD /m);
        assert.match(dockerfile, /^LABEL org\.opencontainers\.image\.revision=\$VCS_REF$/m);
        assert.match(gitignore, /^!\.env\.real-smoke\.example$/m);
        assert.match(realSmokeTemplate, /^IMAGE_REAL_SMOKE_TIMEOUT_MS=240000$/m);
        assert.match(compose, /^      - "\$\{VJ_BIND_HOST:-127\.0\.0\.1\}:\$\{VJ_PORT:-4783\}:4783"$/m);
        assert.doesNotMatch(compose, /^      - "4783:4783"$/m);
        assert.match(compose, /^name: visual-journal$/m);
        assert.match(compose, /^    image: visual-journal:\$\{VJ_IMAGE_TAG:-local\}$/m);
        assert.match(compose, /^    container_name: visual-journal$/m);
        assert.match(postgresCompose, /^      AGENT_DATABASE_URL: ""$/m);
        assert.match(postgresCompose, /^      AGENT_DB_PASSWORD: ""$/m);
        assert.match(postgresCompose, /^      AGENT_DB_PASSWORD_FILE: \/run\/secrets\/postgres_password$/m);
        assert.doesNotMatch(postgresCompose, /gpt-image-playground-customer:postgres/);
        assert.doesNotMatch(postgresCompose, /^    ports:/m);
        assert.match(tunCompose, /^      OPENAI_TUN_MODE: synthetic-dns$/m);
        assert.match(ciWorkflow, /--env VJ_COMPOSE_DEPLOYMENT=true --env VJ_BIND_HOST=127\.0\.0\.1/);
        assert.match(ciWorkflow, /for attempt in \{1\.\.120\}; do/);
        assert.match(ciWorkflow, /attempt %s\/120/);
        assert.match(ciWorkflow, /if \(\( attempt < 120 \)\); then\n\s+sleep 1/);
    });
});
