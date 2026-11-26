type Translate = (key: string, values?: Record<string, string | number>) => string;

export const superApiReferralUrl = 'https://gpt2image.superapi.buzz/';

export type ApiErrorSummary = {
    message: string;
    status?: number;
    code?: string;
    /**
     * 是否还存在其它可切换的渠道。只有单渠道时不能再建议「切换渠道」，
     * 否则给出一条用户根本执行不了的建议。
     */
    hasAlternativeChannel?: boolean;
};

export type ApiErrorNotice = {
    message: string;
    links: Array<{
        label: string;
        url: string;
    }>;
};

export function buildUserFacingApiErrorMessage(options: ApiErrorSummary & { t: Translate }): string {
    const advice = buildApiErrorAdvice(options.status, options.code, options.t, options.hasAlternativeChannel);
    if (!advice) return options.message;

    return options.t('error.apiFailedWithAdvice', {
        message: options.message,
        advice
    });
}

export function buildBatchPartialFailureMessage(options: {
    failed: number;
    total: number;
    errors: ApiErrorSummary[];
    t: Translate;
    hasAlternativeChannel?: boolean;
}): string {
    const reasons = options.errors
        .map(
            (error, index) =>
                `${index + 1}. ${buildUserFacingApiErrorMessage({
                    message: error.message,
                    status: error.status,
                    code: error.code,
                    t: options.t,
                    hasAlternativeChannel: options.hasAlternativeChannel
                })}`
        )
        .join(' ');

    return options.t('error.batchPartialFailureDetailed', {
        failed: options.failed,
        total: options.total,
        reasons
    });
}

export function buildApiErrorNotice(message: string): ApiErrorNotice {
    return { message, links: [] };
}

function buildApiErrorAdvice(
    status: number | undefined,
    code: string | undefined,
    t: Translate,
    hasAlternativeChannel?: boolean
): string | null {
    // 单渠道部署时，「切换可用渠道」是用户执行不了的建议，换成可执行的说法。
    const allowChannelSwitch = hasAlternativeChannel !== false;
    if (code === 'upstream_quota_exhausted') {
        return allowChannelSwitch ? t('error.adviceQuota') : t('error.adviceQuotaSingleChannel');
    }
    if (code === 'upstream_content_policy') return t('error.adviceContentPolicy');
    if (code === 'channel_unavailable') {
        return allowChannelSwitch ? t('error.adviceChannelUnavailable') : t('error.adviceChannelUnavailableSingle');
    }
    if (code === 'validation_error') return t('error.adviceValidation');
    if (status === 401 || status === 403) return t('error.adviceAuth');
    if (status === 429) return t('error.adviceRateLimit');
    if (status === 524) return t('error.adviceCloudflare', { url: superApiReferralUrl });
    if (isUpstreamStatus(status)) {
        return allowChannelSwitch ? t('error.adviceUpstream') : t('error.adviceUpstreamSingleChannel');
    }
    return null;
}

export function classifyApiErrorCode(code: unknown, message: string): string | undefined {
    const normalizedCode = typeof code === 'string' && code.trim() ? code.trim() : undefined;
    if (normalizedCode?.toUpperCase() === 'INSUFFICIENT_BALANCE') return 'upstream_quota_exhausted';
    if (normalizedCode === 'upstream_response_format') return 'upstream_unavailable';
    if (normalizedCode) return normalizedCode;
    const normalized = message.toLowerCase();
    if (normalized.includes('insufficient_balance') || normalized.includes('insufficient account balance')) {
        return 'upstream_quota_exhausted';
    }
    // 上游内容安全拒绝（OpenAI 原文 "rejected by the safety system" 及常见中转措辞）。
    // 这类错误重试相同提示词无效，必须让用户看到真实原因并改写提示词。
    if (
        normalized.includes('safety system') ||
        normalized.includes('rejected by the safety') ||
        normalized.includes('content policy') ||
        normalized.includes('content_policy') ||
        normalized.includes('内容审核') ||
        normalized.includes('敏感内容')
    ) {
        return 'upstream_content_policy';
    }
    if (normalized.includes('健康渠道') && (normalized.includes('没有支持') || normalized.includes('没有可用'))) {
        return 'channel_unavailable';
    }
    return undefined;
}

function isUpstreamStatus(status: number | undefined): boolean {
    return (
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        status === 520 ||
        status === 522 ||
        status === 523
    );
}
