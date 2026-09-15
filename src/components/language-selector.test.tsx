import { LanguageSelector } from './language-selector';
import { I18nProvider, useI18n } from '@/lib/i18n';
import { renderInClientDom } from '@/test-utils/react-dom';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

function LocaleMetadataProbe() {
    const { setLocale, t } = useI18n();

    return (
        <>
            <button type='button' data-switch-to-english onClick={() => setLocale('en-US')}>
                {t('app.language')}
            </button>
            <button type='button' data-switch-to-chinese onClick={() => setLocale('zh-CN')}>
                {t('meta.title')}
            </button>
            <output data-locale-metadata-title>{t('meta.title')}</output>
        </>
    );
}

describe('LanguageSelector', { concurrency: false }, () => {
    it('renders the localized accessible selector control', () => {
        const html = renderToStaticMarkup(
            <I18nProvider>
                <LanguageSelector />
            </I18nProvider>
        );

        assert.match(html, /data-language-selector/);
        assert.match(html, /aria-label="语言"/);
        assert.match(html, /data-size="sm"/);
    });

    it('delegates supported select values to the locale setter', async () => {
        const source = await readFile(new URL('./language-selector.tsx', import.meta.url), 'utf8');

        assert.match(source, /function isLocale\(value: string\): value is Locale/);
        assert.match(
            source,
            /onValueChange=\{\(nextLocale\) => \{\s*if \(isLocale\(nextLocale\)\) \{\s*setLocale\(nextLocale\);/
        );
        assert.match(source, /<SelectItem value='zh-CN'>\{t\('app\.languageChinese'\)\}<\/SelectItem>/);
        assert.match(source, /<SelectItem value='en-US'>\{t\('app\.languageEnglish'\)\}<\/SelectItem>/);
    });

    it('synchronizes browser metadata after the locale provider changes', async () => {
        const view = await renderInClientDom(
            <I18nProvider>
                <LocaleMetadataProbe />
            </I18nProvider>
        );

        try {
            const englishControl = view.container.querySelector<HTMLButtonElement>('[data-switch-to-english]');
            assert.ok(englishControl, 'missing test locale control');
            assert.equal(englishControl.textContent, '语言');
            await view.click(englishControl);

            assert.equal(window.localStorage.getItem('gptImagePlaygroundLocale'), 'en-US');
            assert.equal(document.documentElement.lang, 'en-US');
            assert.equal(document.title, 'Visual Journal | AI Image Workspace');
            assert.equal(
                document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
                'Visual Journal is an AI image workspace for generating, editing, and managing images.'
            );
            assert.equal(
                view.container.querySelector('[data-locale-metadata-title]')?.textContent,
                'Visual Journal | AI Image Workspace'
            );

            const chineseControl = view.container.querySelector<HTMLButtonElement>('[data-switch-to-chinese]');
            assert.ok(chineseControl, 'missing test locale reset control');
            await view.click(chineseControl);
        } finally {
            await view.cleanup();
        }
    });
});
