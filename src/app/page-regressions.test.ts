import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('page state regressions', () => {
    it('keeps the locale selector available before and after entry authentication', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /import \{ LanguageSelector \} from '@\/components\/language-selector';/);
        assert.equal((source.match(/<LanguageSelector \/>/g) ?? []).length, 2);
        assert.match(
            source,
            /\{showEntryLock \? \(\s*<div[^>]*>\s*<div className='absolute top-3 right-4'>\s*<LanguageSelector \/>/
        );
        assert.match(source, /<WorkbenchStatusStrip[\s\S]*?<LanguageSelector \/>/);
    });

    it('keeps auxiliary image actions localized instead of rendering raw API text', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.doesNotMatch(source, /readApiErrorMessage/);
        assert.doesNotMatch(source, /statusText: response\.statusText/);
        assert.match(source, /t\('error\.fetchImage', \{ status: response\.status \}\)/);
        assert.match(source, /response\.status === 401 \? t\('error\.unauthorized'\)/);
        assert.match(source, /createErrorNotice\(t\('error\.clearHistory'\)\)/);
        assert.match(source, /function getLocalizedImageRequestError/);
        assert.match(source, /expected: expected \|\| t\('error\.unknownTargetSize'\)/);
        assert.match(source, /actual: actual \|\| t\('error\.unknownActualSize'\)/);
        assert.match(source, /t\('error\.invalidRequest'\)/);
        assert.match(source, /t\('error\.networkRequest'\)/);
        assert.match(source, /new ApiRequestError\(t\('error\.streaming'\)\)/);
        assert.match(source, /if \(error instanceof BatchPausedError\)/);
        assert.doesNotMatch(source, /new ApiRequestError\(event\.error/);
        assert.doesNotMatch(source, /result\.error \|\|/);
    });

    it('keeps the selected model inside the compatible model directory options', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /const preferredModel =\s*defaultModel && nextOptions\.includes\(defaultModel\)/);
        assert.match(
            source,
            /setGenModel\(\(current\) => \(nextOptions\.includes\(current\) \? current : preferredModel\)\)/
        );
        assert.match(
            source,
            /setEditModel\(\(current\) => \(nextOptions\.includes\(current\) \? current : preferredModel\)\)/
        );
    });

    it('does not replace an explicit model selection with the runtime default', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /genModelExplicitSelectionRef\.current/);
        assert.match(source, /editModelExplicitSelectionRef\.current/);
        assert.match(source, /if \(!genModelExplicitSelectionRef\.current\) \{[\s\S]*?setGenModel/);
        assert.match(source, /if \(!editModelExplicitSelectionRef\.current\) \{[\s\S]*?setEditModel/);
        assert.match(source, /setModel=\{handleGenModelChange\}/);
        assert.match(source, /setEditModel=\{handleEditModelChange\}/);
        assert.match(source, /onModelChange=\{mode === 'generate' \? handleGenModelChange : handleEditModelChange\}/);
    });

    it('does not re-add an incompatible runtime default after model directory resolution', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /modelDirectoryResolvedRef/);
        assert.match(source, /modelDirectoryOptionsRef\.current\.includes\(defaultModel\)/);
        assert.match(source, /modelDirectoryResolvedRef\.current = true/);
        assert.match(source, /modelDirectoryOptionsRef\.current = nextOptions/);
    });

    it('only probes channels after the page access code has been verified', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(
            source,
            /const canProbeModelDirectory = isPasswordRequiredByBackend === true && Boolean\(clientPasswordHash\);/
        );
        assert.match(
            source,
            /if \(!canProbeModelDirectory\) \{\s*return fetchModelDirectory\('\/api\/agent\/models'\);\s*\}/
        );
        assert.match(source, /\}, \[clientPasswordHash, isPasswordRequiredByBackend\]\);/);
    });

    it('passes the unified random inspiration picker and batch prompt setter into the generation form', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const generationFormBlock = source.match(/<GenerationForm([\s\S]*?)failedBatchPrompts=/)?.[1] ?? '';

        assert.ok(generationFormBlock, 'missing generation form props block');
        assert.match(generationFormBlock, /onPickRandomInspiration=\{pickRandomInspirationPrompt\}/);
        assert.match(generationFormBlock, /setBatchPromptText=\{handleBatchPromptTextChange\}/);
        assert.match(generationFormBlock, /isLoading=\{isLoading \|\| isSendingToEdit\}/);
        assert.match(generationFormBlock, /showLoadingState=\{isLoading\}/);
        assert.doesNotMatch(generationFormBlock, /setBatchPromptText=\{setGenBatchPromptText\}/);
    });

    it('gates explicit Responses controls on the current request context, not only the feature flag', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(
            source,
            /shouldAllowResponsesImageBackend\(\{\s*runtimeCapabilities,\s*hasRequestApiOverride\s*\}\)/
        );
        assert.doesNotMatch(
            source,
            /const allowResponsesImageBackend = isResponsesImageBackendRuntimeEnabled\(runtimeCapabilities \?\? \{\}\)/
        );
    });

    it('uses the runtime default backend for form ranges and rejects stale values before requests', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const generationFormBlock = source.match(/<GenerationForm\s([\s\S]*?)\n\s*\/>/)?.[1] ?? '';
        const editingFormBlock = source.match(/<EditingForm\s([\s\S]*?)\n\s*\/>/)?.[1] ?? '';

        assert.ok(generationFormBlock, 'missing generation form props block');
        assert.ok(editingFormBlock, 'missing editing form props block');
        assert.match(generationFormBlock, /defaultImageBackend=\{defaultImageBackend\}/);
        assert.match(editingFormBlock, /defaultImageBackend=\{defaultImageBackend\}/);
        assert.match(
            source,
            /const runtimeDefaultImageBackend = latestRuntimeCapabilities\?\.streaming\?\.defaultBackend;/
        );
        assert.match(source, /const runtimeBackendCompatibility = getImageBackendCompatibility\(/);
        assert.match(source, /runtimeFormData\.image_backend,\s*runtimeDefaultImageBackend/);
        assert.match(source, /if \(!runtimeBackendCompatibility\.compatible\) \{/);
        assert.match(source, /runtimeBackendCompatibility\.errors\.map\(\(error\) => error\.message\)\.join\(' '\)/);
        assert.match(source, /const runtimeCountRange = runtimeBackendCompatibility\.imageCountRange;/);
        assert.match(
            source,
            /t\('error\.imageCountOutOfRange', \{\s*min: runtimeCountRange\.min,\s*max: runtimeCountRange\.max/
        );
        assert.match(source, /const runtimePartialImagesRange = runtimeBackendCompatibility\.partialImagesRange;/);
        assert.match(
            source,
            /t\('error\.partialImagesOutOfRange', \{\s*min: runtimePartialImagesRange\.min,\s*max: runtimePartialImagesRange\.max/
        );
    });

    it('uses one edit upload validator for paste, history reuse, and the final runtime preflight', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /imageFiles: \[\.\.\.editImageFiles, file\],\s*maskFile: editGeneratedMaskFile/);
        assert.match(source, /imageFiles: \[newFile\],\s*upstreamProfile: activeUpstreamProfile/);
        assert.match(
            source,
            /const editFormData = runtimeFormData as EditingFormData;[\s\S]*?maskFile: editFormData\.maskFile,[\s\S]*?upstreamProfile: runtimeUpstreamProfile/
        );
        assert.match(source, /formatEditSourceValidationFailure\(validationFailure, t\)/);
    });

    it('loads permanent filenames only when filesystem cleanup is enabled and forwards batch actions to HistoryPanel', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /webuiImageCleanup\?\.enabled/);
        assert.match(source, /fetch\('\/api\/image-retention'/);
        assert.match(source, /onUpdatePermanentSave=/);
        assert.match(source, /const storageModeUsed = item\.storageModeUsed \?\? 'fs';/);
        assert.match(source, /webui-image-retention:\$\{isPasswordRequiredByBackend \? 'authenticated' : 'public'\}/);
        assert.doesNotMatch(source, /filesystemRetentionScopeKey/);
        assert.match(source, /resultItem\.fileDeleted === true/);
        assert.match(source, /resultItem\.fileAbsent === true/);
        assert.match(
            source,
            /mergeWebuiImageRetentionResults\(\s*current\.filenames,\s*'release',\s*deletionResults\s*\)/
        );
        assert.match(
            source,
            /if \(deletionResults\.some\(\(resultItem\) => !resultItem\.success\)\) \{\s*setError\(createErrorNotice\(t\('error\.deletePartial'\)\)\);\s*\}/
        );
        assert.doesNotMatch(
            source,
            /if \(deletionResults\.some\(\(resultItem\) => !resultItem\.success\)\) \{\s*throw new Error/
        );
    });

    it('treats request-level API key as an override while rejecting base URL-only settings', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const runtimeStatusCall = source.match(/resolveRuntimeHealthStatus\(\{([\s\S]*?)\n\s*\}\)/)?.[1] ?? '';

        assert.match(source, /const hasRequestApiKey = apiSettings\.apiKey\.trim\(\)\.length > 0;/);
        assert.match(source, /const hasRequestApiOverride = hasRequestApiKey;/);
        assert.match(runtimeStatusCall, /hasRequestApiOverride/);
        assert.match(runtimeStatusCall, /imageBackend: activeWorkbenchBackend/);
        assert.match(
            source,
            /if \(settings\.baseUrl && !settings\.apiKey\) \{\s*throw new Error\(t\('api\.urlPairRequired'\)\);\s*\}/
        );
        assert.match(source, /if \(apiSettings\.baseUrl && apiSettings\.apiKey\) \{/);
        assert.doesNotMatch(source, /hasPairedRequestApiOverride/);
    });

    it('cleans stale local request API overrides that only persisted a base URL', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(
            source,
            /function normalizeStoredApiSettings\(settings: Partial<ApiSettings>\): StoredApiSettingsReadResult/
        );
        assert.match(
            source,
            /if \(!apiKey && baseUrl\) \{\s*return \{ settings: emptyApiSettings, shouldPersist: false, shouldRemove: true \};\s*\}/
        );
        assert.match(source, /const storedApiSettings = readStoredApiSettings\(\);/);
        assert.match(
            source,
            /if \(storedApiSettings\.shouldRemove\) \{\s*window\.localStorage\.removeItem\(apiSettingsLocalStorageKey\);\s*\}/
        );
        assert.match(
            source,
            /else if \(storedApiSettings\.shouldPersist\) \{\s*window\.localStorage\.setItem\(apiSettingsLocalStorageKey, JSON\.stringify\(storedApiSettings\.settings\)\);\s*\}/
        );
    });

    it('keeps the API settings dialog mounted so focus can return after closing', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const dialogSource = await readFile(new URL('../components/api-settings-dialog.tsx', import.meta.url), 'utf8');

        assert.match(source, /<ApiSettingsDialog\s+isOpen=\{isApiSettingsDialogOpen\}/);
        assert.doesNotMatch(source, /\{isApiSettingsDialogOpen \? \(\s*<ApiSettingsDialog/);
        assert.match(source, /apiSettingsDialogTriggerRef = React\.useRef<HTMLButtonElement \| null>\(null\)/);
        assert.match(source, /apiSettingsDialogTriggerRef\.current = event\.currentTarget/);
        assert.match(source, /getApiSettingsDialogFocusTarget/);
        assert.match(source, /data-api-settings-trigger/);
        assert.match(source, /getReturnFocusTarget=\{getApiSettingsDialogFocusTarget\}/);
        assert.match(dialogSource, /onCloseAutoFocus=\{\(event\) => \{\s*event\.preventDefault\(\);/);
        assert.match(dialogSource, /getReturnFocusTarget\(\)\?\.focus\(\)/);
    });

    it('shows the current form route in the status strip instead of inferring from server capability modes', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /const activeWorkbenchBackend = usesEditControls \? editImageBackend : genImageBackend;/);
        assert.match(source, /const activeRouteLabel = getWorkbenchRouteLabel\(activeWorkbenchBackend, t\);/);
        assert.match(source, /routeLabel=\{activeRouteLabel\}/);
        assert.doesNotMatch(source, /const activeRequestModeLabel = React\.useMemo/);
    });

    it('labels the selected output count as requested images instead of tasks', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(
            source,
            /const activeRequestedImageCount =\s*mode === 'generate' && workbenchMode === 'batch'\s*\? activeBatchPrompts\.length\s*:\s*mode === 'generate'\s*\? genN\[0\]\s*:\s*editN\[0\];/
        );
        assert.match(
            source,
            /const activeRequestSummaryLabel = t\('workbench\.requestSummary', \{\s*count: activeRequestedImageCount\s*\}\);/
        );
        assert.match(source, /requestSummaryLabel=\{activeRequestSummaryLabel\}/);
        assert.doesNotMatch(source, /workbench\.taskSummary/);
    });

    it('keeps mobile actions fixed normally and scrollable in short creation drawers', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const generationFormSource = await readFile(
            new URL('../components/generation-form.tsx', import.meta.url),
            'utf8'
        );
        const editingFormSource = await readFile(new URL('../components/editing-form.tsx', import.meta.url), 'utf8');
        const styles = await readFile(new URL('./globals.css', import.meta.url), 'utf8');

        assert.match(source, /\[--mobile-action-dock-height:8\.5rem\]/);
        assert.match(source, /pb-\[calc\(var\(--mobile-action-dock-height\)\+env\(safe-area-inset-bottom\)\)\]/);
        assert.match(source, /fixed inset-x-0 top-4 bottom-0 z-50 flex min-h-0 flex-col overflow-hidden/);
        assert.match(source, /lg:overflow-visible/);
        assert.match(source, /pb-\[calc\(1rem\+env\(safe-area-inset-bottom\)\)\]/);
        assert.doesNotMatch(
            source,
            /bottom-\[calc\(var\(--mobile-action-dock-height\)\+env\(safe-area-inset-bottom\)\)\]/
        );
        assert.doesNotMatch(source, /scroll-pb-4/);
        assert.doesNotMatch(source, /overflow-y-auto rounded-t-lg border-t/);
        assert.match(source, /min-h-\[var\(--mobile-action-dock-height\)\]/);
        assert.match(
            source,
            /\{!isMobileCreationDrawerOpen && \(\s*<div className='bg-background border-border fixed right-0 bottom-0 left-0 z-40/
        );
        assert.match(source, /mobile-drawer-form-slot flex min-h-0 w-full flex-1 flex-col lg:h-full/);
        assert.match(source, /mobile-drawer-form-slot/);
        assert.match(source, /mobile-creation-sheet-handle/);
        assert.match(source, /aria-label=\{t\('ux\.closeCreationSheet'\)\}/);
        assert.match(source, /aria-label=\{t\('ux\.closeCreationSheetButton'\)\}/);
        for (const formSource of [generationFormSource, editingFormSource]) {
            assert.match(formSource, /mobile-drawer-form-card/);
            assert.match(formSource, /mobile-drawer-form-frame/);
            assert.match(formSource, /mobile-drawer-form-content/);
        }
        assert.match(styles, /@media \(max-width: 1023px\) and \(max-height: 480px\)/);
        assert.match(styles, /#mobile-creation-sheet\s*\{[\s\S]*?overflow-y: auto;/);
        assert.match(
            styles,
            /#mobile-creation-sheet \.mobile-creation-sheet-handle\s*\{[\s\S]*?background: var\(--card\);/
        );
        assert.match(styles, /\.mobile-drawer-form-content\s*\{[\s\S]*?overflow: visible;/);
    });

    it('moves keyboard mode focus into the newly active non-inert form', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /pendingWorkbenchModeFocusRef = React\.useRef<WorkbenchMode \| null>\(null\)/);
        assert.match(source, /pendingWorkbenchModeFocusRef\.current = nextMode/);
        assert.match(source, /document\.querySelectorAll<HTMLButtonElement>\('\[data-workbench-mode\]'\)/);
        assert.match(source, /candidate\.getClientRects\(\)\.length > 0/);
        assert.match(source, /!candidate\.closest\('\[aria-hidden="true"\], \[inert\]'\)/);
        assert.match(source, /if \(tab\) \{\s*tab\.focus\(\);/);
    });

    it('keeps mobile Escape handling singular and avoids submission focus recovery on desktop resize', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const drawerKeyDownBlock =
            source.match(
                /const handleMobileCreationDrawerKeyDown = React\.useCallback\(([\s\S]*?)\n\s*\);\n\n\s*React\.useEffect\(\(\) => \{\n\s*if \(!isMobileCreationDrawerOpen \|\| typeof document === 'undefined'\) return;/
            )?.[1] ?? '';

        assert.ok(drawerKeyDownBlock, 'missing mobile creation drawer keyboard handler');
        assert.match(drawerKeyDownBlock, /if \(event\.key !== 'Tab'\) return;/);
        assert.doesNotMatch(drawerKeyDownBlock, /event\.key === 'Escape'/);
        assert.match(source, /const closeDrawerOnEscape = \(event: KeyboardEvent\) =>/);
        assert.match(
            source,
            /const closeMobileCreationDrawerAfterSubmit = React\.useCallback\(\(\) => \{\s*if \(!isMobileCreationDrawerOpen\) \{\s*mobileCreationDrawerFocusTargetRef\.current = null;\s*blurActiveMobileTrigger\(\);\s*outputPanelRef\.current\?\.focus\(\);\s*return;/
        );
        assert.match(
            source,
            /if \(desktopMediaQuery\.matches\) \{\s*mobileCreationDrawerFocusTargetRef\.current = null;\s*setIsMobileCreationDrawerOpen\(false\);/
        );
        assert.doesNotMatch(source, /if \(desktopMediaQuery\.matches\) \{\s*closeMobileCreationDrawerAfterSubmit\(\);/);
    });

    it('keeps the mobile drawer backdrop presentational while preserving pointer dismissal', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const styles = await readFile(new URL('./globals.css', import.meta.url), 'utf8');

        assert.match(source, /\{isMobileCreationDrawerOpen && \(\s*<div\s+aria-hidden='true'/);
        assert.match(
            source,
            /className='bg-foreground\/25 fixed inset-0 z-40 lg:hidden'\s*onClick=\{closeMobileCreationDrawer\}/
        );
        assert.doesNotMatch(source, /<button\s+type='button'\s+aria-hidden='true'\s+tabIndex=\{-1\}/);
        assert.doesNotMatch(styles, /\.workbench-shell\s*\{[\s\S]*?isolation\s*:/);
    });

    it('keeps focus inside the mobile drawer and its portalled controls', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /const mobileCreationDrawerPortalSelector =/);
        assert.match(source, /\[data-slot="select-content"\]/);
        assert.match(source, /const keepFocusInMobileCreationDrawer = \(event: FocusEvent\) =>/);
        assert.match(source, /mobileCreationDrawer\.contains\(target\)/);
        assert.match(source, /target\.closest\(mobileCreationDrawerPortalSelector\)/);
        assert.match(source, /document\.addEventListener\('focusin', keepFocusInMobileCreationDrawer\)/);
        assert.match(source, /document\.removeEventListener\('focusin', keepFocusInMobileCreationDrawer\)/);
    });

    it('passes shared inspiration actions into both generation and editing forms', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const generationFormBlock = source.match(/<GenerationForm([\s\S]*?)failedBatchPrompts=/)?.[1] ?? '';
        const editingFormBlock = source.match(/<EditingForm([\s\S]*?)editModel=/)?.[1] ?? '';

        assert.ok(generationFormBlock, 'missing generation form props block');
        assert.ok(editingFormBlock, 'missing editing form props block');
        for (const formBlock of [generationFormBlock, editingFormBlock]) {
            assert.match(formBlock, /onSaveInspiration=\{handleSaveInspiration\}/);
            assert.match(formBlock, /canApplyRandomInspiration=\{hasRandomInspirationPrompt\}/);
            assert.match(formBlock, /onPickRandomInspiration=\{pickRandomInspirationPrompt\}/);
        }
        assert.match(generationFormBlock, /isActive=\{mode === 'generate'\}/);
        assert.match(editingFormBlock, /isActive=\{mode === 'edit'\}/);
        assert.match(editingFormBlock, /showLoadingState=\{isLoading\}/);
        assert.doesNotMatch(source, /handleMobileSaveInspiration/);
        assert.doesNotMatch(source, /handleMobileRandomInspiration/);
        assert.match(source, /mobileCreationDrawerTriggerRef/);
        assert.match(source, /ref=\{mobileCreationDrawerTriggerRef\}/);
        assert.match(
            source,
            /document\.querySelector<HTMLButtonElement>\('\[aria-controls="mobile-creation-sheet"\]'\)/
        );
        assert.match(source, /trigger\?\.focus\(\)/);
        assert.match(source, /mobileCreationDrawerFocusTargetRef\.current = 'trigger'/);
        assert.match(source, /mobileCreationDrawerFocusTargetRef\.current = 'output'/);
        assert.match(source, /closeMobileCreationDrawerAfterSubmit\(\)/);
        assert.match(source, /if \(!isMobileCreationDrawerOpen\) return;/);
        assert.match(source, /event\.key !== 'Escape'/);
        assert.match(source, /document\.addEventListener\('keydown', closeDrawerOnEscape\)/);
        assert.match(source, /\[data-slot="select-content"\], \[role="listbox"\], \[role="menu"\]/);
        assert.match(source, /window\.addEventListener\('resize', closeDrawerOnDesktop\)/);
        assert.match(source, /event\.key !== 'Tab'/);
        assert.match(source, /!element\.closest\('\[aria-hidden="true"\], \[inert\]'\)/);
        assert.match(source, /a\[href\], button:not\(\[disabled\]\).*\[contenteditable="true"\]/);
        assert.match(source, /aria-hidden=\{mode !== 'generate'\}/);
        assert.match(source, /aria-hidden=\{mode !== 'edit'\}/);
        assert.match(source, /inert=\{mode !== 'generate'\}/);
        assert.match(source, /inert=\{mode !== 'edit'\}/);
        assert.match(source, /sendingToEditRef\.current/);
        assert.match(source, /role=\{isMobileCreationDrawerOpen \? 'dialog' : undefined\}/);
        assert.match(source, /aria-modal=\{isMobileCreationDrawerOpen \? true : undefined\}/);
    });

    it('keeps mobile generation announcements outside inert workbench regions', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const announcerIndex = source.indexOf('data-mobile-generation-activity-announcer');
        const inertCanvasIndex = source.indexOf('aria-hidden={isMobileCreationDrawerOpen}', announcerIndex);

        assert.ok(announcerIndex > 0, 'missing mobile generation activity announcer');
        assert.ok(inertCanvasIndex > announcerIndex, 'mobile announcer must precede inert workbench regions');
        assert.match(
            source.slice(announcerIndex, inertCanvasIndex),
            /role='status'[\s\S]*aria-live='polite'[\s\S]*aria-atomic='true'/
        );
    });

    it('clears previous generation activity only after synchronous send-to-edit guards', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const sendToEditBlock = source.match(/const handleSendToEdit = async \(([\s\S]*?)\n\s*try \{/)?.[1] ?? '';
        const alreadyExistsIndex = sendToEditBlock.indexOf('const alreadyExists');
        const imageLimitIndex = sendToEditBlock.indexOf('hasReachedEditSourceImageLimit');
        const activityResetIndex = sendToEditBlock.indexOf('setCompletedGenerationCount(null)');

        assert.ok(sendToEditBlock, 'missing send-to-edit setup block');
        assert.ok(alreadyExistsIndex >= 0, 'missing existing image guard');
        assert.ok(imageLimitIndex > alreadyExistsIndex, 'missing edit image limit guard');
        assert.ok(activityResetIndex > imageLimitIndex, 'generation activity must survive synchronous no-op exits');
        assert.match(
            sendToEditBlock.slice(activityResetIndex),
            /setCompletedGenerationCount\(null\);\s*setStreamingPreviewImages\(new Map\(\)\);\s*setBatchProgress\(null\);\s*setIsSendingToEdit\(true\);/
        );
    });

    it('blocks send-to-edit while a generation request is active', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /if \(isLoading \|\| sendingToEditRef\.current\) return false;/);
        assert.match(source, /<HistoryPanel[\s\S]*?isSendingToEdit=\{isLoading \|\| isSendingToEdit\}/);
    });

    it('prevents narrow mobile layouts from creating horizontal overflow', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /min-h-screen overflow-x-hidden/);
        assert.match(source, /w-full max-w-\[1880px\] min-w-0/);
        assert.match(source, /flex min-w-0 flex-wrap items-center gap-2/);
        assert.match(source, /order-1 flex min-h-\[380px\] min-w-0/);
        assert.match(source, /order-3 min-h-\[17\.5rem\] min-w-0/);
    });

    it('lets keyboard users skip the workbench header', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /href='#workbench-content'/);
        assert.match(source, /focus:not-sr-only/);
        assert.match(source, /id='workbench-content'/);
        assert.match(source, /tabIndex=\{-1\}/);
        assert.match(source, /focus:outline-none/);
        assert.match(source, /t\('app\.skipToMainContent'\)/);
    });

    it('keeps the mobile title readable instead of truncating the brand', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');

        assert.match(source, /flex-1 flex-wrap items-baseline gap-x-3 gap-y-1/);
        assert.match(source, /editorial-title shrink-0 text-2xl/);
        assert.match(source, /text-muted-foreground min-w-0 text-sm/);
        assert.match(source, /flex h-11 w-11 items-center justify-center[^']*lg:h-9 lg:w-9/);
        assert.doesNotMatch(source, /editorial-title truncate text-2xl/);
    });

    it('uses a neutral preview surface without paper decoration', async () => {
        const source = await readFile(new URL('./globals.css', import.meta.url), 'utf8');

        assert.match(source, /\.photo-paper \{\s*min-width: 0;/);
        assert.match(source, /\.photo-paper::before \{\s*content: none;/);
        assert.match(source, /\.preview-gallery-board \{\s*background: var\(--workspace-canvas\);/);
        assert.match(source, /\.preview-gallery-board::before \{\s*content: none;/);
        assert.doesNotMatch(source, /repeating-linear-gradient/);
    });

    it('uses the desktop workspace for an empty preview while keeping compact narrow layouts', async () => {
        const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
        const styles = await readFile(new URL('./globals.css', import.meta.url), 'utf8');

        assert.match(source, /const shouldExpandOutputStage =/);
        assert.match(source, /Boolean\(latestImageBatch\)/);
        assert.match(source, /Boolean\(outputFailureMessage\)/);
        assert.match(source, /mode === 'edit' && Boolean\(editSourceImagePreviewUrls\[0\]\)/);
        assert.match(source, /xl:h-dvh xl:pb-0/);
        assert.match(source, /xl:h-full xl:min-h-0/);
        assert.match(source, /className='workbench-layout grid min-h-0 flex-1 grid-cols-1 gap-4/);
        assert.match(source, /workbench-history-column order-3 min-h-\[17\.5rem\] min-w-0 lg:col-span-2/);
        assert.match(source, /workbench-history-column--contained/);
        assert.doesNotMatch(source, /min-\[1160px\]/);
        assert.match(
            styles,
            /@media \(min-width: 1160px\) \{[\s\S]*?\.workbench-layout \{[\s\S]*?grid-template-columns: minmax\(320px, 340px\) minmax\(0, 1fr\) minmax\(220px, 244px\);/
        );
        assert.match(
            styles,
            /@media \(min-width: 1280px\) \{[\s\S]*?grid-template-columns: minmax\(320px, 360px\) minmax\(0, 1fr\) minmax\(232px, 272px\);/
        );
        assert.match(
            styles,
            /@media \(min-width: 1536px\) \{[\s\S]*?grid-template-columns: minmax\(380px, 424px\) minmax\(780px, 1fr\) minmax\(272px, 304px\);/
        );
        assert.doesNotMatch(source, /xl:flex-none xl:items-start/);
        assert.match(source, /order-1 flex min-h-\[380px\][^']*xl:min-h-0/);
        assert.match(source, /<div className='min-h-0 shrink-0 xl:flex-1'>\s*<ImageOutput/);
        assert.doesNotMatch(source, /shouldExpandOutputStage \? 'min-h-0 flex-1' : 'min-h-0 shrink-0'/);
        assert.doesNotMatch(source, /xl:min-h-\[34rem\]/);
    });
});
