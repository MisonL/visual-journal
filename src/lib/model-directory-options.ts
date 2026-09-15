export const DEFAULT_MODEL_OPTIONS = [
    'gpt-image-2',
    'gpt-image-2-1k',
    'gpt-image-1.5',
    'gpt-image-1',
    'gpt-image-1-mini'
] as const;

type ModelDirectoryEntry = {
    id?: unknown;
};

type ModelDirectoryChannel = {
    declared_models?: unknown;
    model_allowlist_configured?: unknown;
    model_allowlist_state?: unknown;
    models?: unknown;
    probe_status?: unknown;
};

export type ModelDirectoryOptionsInput = {
    default_model?: unknown;
    known_models?: ModelDirectoryEntry[];
    channels?: ModelDirectoryChannel[];
};

export function resolveModelDirectoryOptions(
    directory: ModelDirectoryOptionsInput,
    fallback: readonly string[] = DEFAULT_MODEL_OPTIONS
): string[] {
    const channels = Array.isArray(directory.channels) ? directory.channels : [];
    const channelModels = channels.map(readChannelModels);
    const declaredModelSets = channels.map(readDeclaredChannelModels).filter((models) => models.length > 0);
    const hasConfiguredChannels = channels.length > 0;
    const everyChannelHasAllowlist =
        hasConfiguredChannels &&
        channels.every((channel, index) => hasChannelModelAllowlist(channel, channelModels[index]));
    const declaredModels = uniqueStrings(declaredModelSets.flat());
    const probedModels = uniqueStrings(
        channels.filter((channel) => channel.probe_status === 'ok').flatMap(readChannelModels)
    );
    const defaultModel = readModelId(directory.default_model);

    if (everyChannelHasAllowlist) {
        return uniqueStrings([...declaredModels, ...probedModels]);
    }

    const knownModels = Array.isArray(directory.known_models)
        ? directory.known_models.map((entry) => readModelId(entry?.id)).filter(isNonEmptyString)
        : [];
    const options = hasConfiguredChannels
        ? [...(defaultModel ? [defaultModel] : []), ...fallback, ...knownModels, ...declaredModels, ...probedModels]
        : [...(defaultModel ? [defaultModel] : []), ...fallback, ...knownModels, ...probedModels];
    return uniqueStrings(options);
}

function readChannelModels(channel: ModelDirectoryChannel): string[] {
    return Array.isArray(channel.models) ? channel.models.map(readModelId).filter(isNonEmptyString) : [];
}

function readDeclaredChannelModels(channel: ModelDirectoryChannel): string[] {
    // Redacted declaration responses intentionally keep channel.models while
    // clearing declared_models. Treat an empty declaration list as absent so
    // the retained, non-sensitive model IDs can still constrain the selector.
    if (Array.isArray(channel.declared_models) && channel.declared_models.length > 0) {
        return channel.declared_models.map(readModelId).filter(isNonEmptyString);
    }
    return readChannelModels(channel);
}

function hasChannelModelAllowlist(channel: ModelDirectoryChannel, channelModels: string[]): boolean {
    if (
        channel.model_allowlist_state === 'mixed' ||
        channel.model_allowlist_state === 'unrestricted' ||
        channel.model_allowlist_state === 'redacted'
    )
        return false;
    if (channel.model_allowlist_state === 'restricted') return true;
    if (typeof channel.model_allowlist_configured === 'boolean') {
        if (channel.model_allowlist_configured) return true;
        // Unauthenticated declaration responses redact the explicit allowlist
        // marker but retain the non-sensitive model IDs. An unprobed channel
        // with an explicitly empty declaration list is therefore still a
        // constrained selector. Once a live probe succeeds, `models` contains
        // provider discovery rather than a declaration and must not hide the
        // generic project options.
        return (
            Array.isArray(channel.declared_models) &&
            channel.declared_models.length === 0 &&
            channel.probe_status !== 'ok' &&
            channelModels.length > 0
        );
    }
    // Keep accepting older directory responses that predate the explicit flag.
    // In that shape, a non-empty channel list was the only available allowlist signal.
    return channelModels.length > 0;
}

function readModelId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized && normalized.length <= 200 ? normalized : undefined;
}

function isNonEmptyString(value: string | undefined): value is string {
    return value !== undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
    return Array.from(new Set(values.filter((value) => value.length > 0)));
}
