import { Config } from '../lib/index.js';
import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * The gate the installer and profile startup actually run. It short-circuits
 * peers when `engines.dsh` exists, so both paths are asserted below to keep
 * them from drifting apart.
 *
 * Resolved from this package first, then from the `dsh` on PATH so a bare
 * checkout still exercises the real gate instead of silently skipping.
 * Skipped only when no dsh is installed at all.
 */
async function loadGate() {
    try {
        const { evaluatePluginCompatibility } = await import('@deepseek-ai/dsh-app-boot');
        return evaluatePluginCompatibility;
    } catch {
        // fall through to a dsh installation
    }
    try {
        const { execFileSync } = await import('node:child_process');
        const { realpathSync } = await import('node:fs');
        const entry = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim());
        const root = path.dirname(path.dirname(entry)); // <node>/lib/node_modules/@deepseek-ai/dsh
        const gate = await import(
            'file://' + path.join(root, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')
        );
        return gate.evaluatePluginCompatibility;
    } catch {
        return null;
    }
}

const gate = await loadGate();

// Not skipped on purpose: a skip here would let CI stay green while the three
// gate assertions below never ran, which is the failure mode they exist to catch.
test('the runtime compatibility gate is reachable', () => {
    assert.ok(
        gate,
        'no dsh installation found; these assertions need the real gate ' +
            '(install @deepseek-ai/dsh, or put dsh on PATH)'
    );
});

test('the runtime gate accepts every DSH line this plugin supports', { skip: !gate && 'no gate' }, () => {
    // Versions below were run against the full test suite: every dsh-tools
    // 0.2.1-alpha.1 .. 0.2.3-alpha.2 crossed with schemastery 3.18.5 / 3.19.0,
    // plus 0.2.3-alpha.2 with the 3.20.0-alpha.1 it ships.
    for (const version of ['0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.5', '0.2.3-alpha.2']) {
        assert.equal(gate(manifest, {}, version), undefined, `expected ${version} to be accepted`);
    }
});

test('the runtime gate rejects what was never tested', { skip: !gate && 'no gate' }, () => {
    // 0.2.1-rc.4 is below the declared floor; 0.3.0 prereleases move to a new
    // cordis line. `<0.3.0-0` is what keeps those prereleases out under the
    // gate's includePrerelease.
    for (const version of ['0.2.1-rc.4', '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0']) {
        assert.notEqual(gate(manifest, {}, version), undefined, `expected ${version} to be rejected`);
    }
});

test('engines.dsh and the dsh-tools peer agree on every version', { skip: !gate && 'no gate' }, () => {
    // The gate ignores peers while engines.dsh exists, so a peer range that
    // disagrees is dead code that silently drifts. Assert the two paths match.
    const withoutEngines = structuredClone(manifest);
    delete withoutEngines.engines.dsh;
    for (const version of ['0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-rc.5', '0.2.3-alpha.2', '0.3.0-rc.1', '0.3.0']) {
        const installed = { '@deepseek-ai/dsh-tools': version };
        assert.equal(
            Boolean(gate(manifest, installed, version)),
            Boolean(gate(withoutEngines, installed, version)),
            `engines.dsh and the dsh-tools peer disagree on ${version}`
        );
    }
});

test('keeps DSH runtime packages out of dependencies to avoid a second instance', () => {
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.devDependencies['@deepseek-ai/schemastery'], '~3.19.0');
    assert.equal(manifest.devDependencies['@deepseek-ai/dsh-tools'], '0.2.2-rc.5');
});

test('declares its runtime peers as host-provided and never auto-installed', () => {
    assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '~3.18.5 || ~3.19.0');
    // The plugin imports cordis only through `ctx`, never as a module.
    assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], undefined);
    // Required peers would make pnpm install a second copy, which is the
    // duplication `dependencies` was moved out of; both must stay optional.
    assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional, true);
    assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/schemastery'].optional, true);
});

test('publishes only runtime files', () => {
    assert.deepEqual(manifest.files, ['lib', 'cordis.patch.yml', 'README.md']);
});

test('ships a standard YAML patch without executable tags', () => {
    const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
    assert.doesNotMatch(patch, /!!js/);
    const [entry] = yaml.load(patch);
    assert.deepEqual(entry.insert, [
        { id: 'visual-journal-dsh-plugin', name: '@visual-journal/dsh-plugin', config: {} }
    ]);
});

test('config defaults keep approval on and the base URL unset', () => {
    assert.deepEqual(Config({}), { timeoutMs: 900_000, approval: 'ask', attachImages: true, maxBatchItems: 8 });
    assert.throws(() => Config({ approval: 'always' }));
    assert.throws(() => Config({ maxBatchItems: 99 }));
});
