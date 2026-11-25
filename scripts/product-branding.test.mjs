import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GIT_DEPLOY_AUTHOR_EMAIL, GIT_DEPLOY_AUTHOR_NAME } from './deploy-hf-space.mjs';
import { HF_SPACE_ID, HF_SPACE_URL } from './hf-space-doctor-utils.mjs';
import { FORMAL_PRODUCT_NAME } from './status.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readRepositoryText(path) {
    return readFileSync(join(repoRoot, path), 'utf8');
}

describe('product branding', () => {
    it('uses the formal product name in Hugging Face metadata and the browser icon', () => {
        const readme = readRepositoryText('README.md');
        const favicon = readRepositoryText('public/favicon.svg');

        assert.match(
            readme,
            /^---\ntitle: 图像手记 \/ Visual Journal\nshort_description: 本地优先的 AI 图片创作工作台\nsdk: docker\napp_port: 4783\n---/m
        );
        assert.match(readme, /HF Space 使用 `visual-journal` 名称，本地容器以 `visual-journal` 命名/);
        assert.match(readme, /`GPT_IMAGE_\*` 环境变量与 API 路径保留旧前缀/);
        assert.doesNotMatch(readme, /HF Space slug、环境变量、API 路径和 Skill 标识继续使用/);
        assert.match(favicon, /<title>图像手记 \/ Visual Journal<\/title>/);
    });

    it('offers an isolated private Hugging Face Space copy without sharing production credentials', () => {
        const readme = readRepositoryText('README.md');

        assert.match(
            readme,
            /https:\/\/huggingface\.co\/new-space\?duplicate=misonL%2Fvisual-journal/
        );
        assert.match(readme, /登录 Hugging Face 后，创建页会预填本 Space 作为复制来源。请在创建页选择 Private；/);
        assert.match(
            readme,
            /`npm run deploy:space` 不会自动定位或更新该私人副本。/
        );
    });

    it('uses the formal product name in access-code guidance and history downloads', () => {
        const translations = readRepositoryText('src/lib/i18n.tsx');
        const page = readRepositoryText('src/app/page.tsx');

        assert.match(translations, /'password\.entryDescription': '请输入访问码以使用图像手记服务。'/);
        assert.match(translations, /'password\.entryDescription': 'Enter the access code to use Visual Journal.'/);
        assert.match(page, /link\.download = `visual-journal-history-\$\{item\.timestamp\}\.zip`;/);
    });

    it('uses Visual Journal identifiers for automated Space maintenance', () => {
        const keepalive = readRepositoryText('scripts/keepalive-hf-space.mjs');

        assert.match(keepalive, /const KEEPALIVE_USER_AGENT = 'visual-journal-keepalive\/1\.0';/);
        assert.match(keepalive, /'User-Agent': KEEPALIVE_USER_AGENT/);
        assert.equal(HF_SPACE_ID, 'misonL/visual-journal');
        assert.equal(HF_SPACE_URL, 'https://misonl-visual-journal.hf.space');
        assert.equal(GIT_DEPLOY_AUTHOR_NAME, 'Visual Journal deploy');
        assert.equal(GIT_DEPLOY_AUTHOR_EMAIL, 'deploy@visual-journal.local');
    });

    it('uses the formal product name in operational status while retaining the package identifier', () => {
        const status = readRepositoryText('scripts/status.mjs');
        const packageJson = JSON.parse(readRepositoryText('package.json'));
        const skill = readRepositoryText('skills/visual-journal-image-agent/SKILL.md');
        const skillConfig = readRepositoryText('skills/visual-journal-image-agent/agents/openai.yaml');

        assert.equal(FORMAL_PRODUCT_NAME, '图像手记 / Visual Journal');
        assert.equal(packageJson.name, 'visual-journal');
        assert.match(skill, /^name: visual-journal-image-agent$/m);
        assert.match(skillConfig, /display_name: "Visual Journal Image Agent API"/);
        assert.match(skillConfig, /\$visual-journal-image-agent/);
        assert.match(status, /product: FORMAL_PRODUCT_NAME,/);
        assert.match(status, /package_name: packageJson\.name,/);
    });
});
