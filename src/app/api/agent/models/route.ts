import { assertAgentAuthorized } from '@/lib/agent-auth';
import { buildAgentModelDirectory, probeAgentModelDirectory } from '@/lib/agent-model-directory';
import { createRequestId } from '@/lib/agent-state-store';
import { AgentApiError, agentErrorResponse, normalizeAgentError } from '@/lib/api-error-response';
import { verifyAccessToken } from '@/lib/server-runtime';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
    const probe = request.nextUrl.searchParams.get('probe') === 'true';
    const requestId = createRequestId();
    try {
        const authenticated = authorizeModelRequest(request, probe);
        if (!probe) {
            const directory = buildAgentModelDirectory(process.env);
            if (!authenticated) redactUnauthenticatedDirectory(directory);
            return NextResponse.json(directory, {
                headers: { 'cache-control': 'private, max-age=30' }
            });
        }
        const directory = await probeAgentModelDirectory(process.env);
        return NextResponse.json(directory, {
            headers: { 'cache-control': 'no-store', 'X-Request-Id': requestId }
        });
    } catch (error) {
        return agentErrorResponse(normalizeAgentError(error), requestId);
    }
}

function authorizeModelRequest(request: NextRequest, probe: boolean): boolean {
    const configuredAgentToken = process.env.AGENT_API_TOKEN?.trim();
    const configuredAppPassword = process.env.APP_PASSWORD?.trim();
    if (!configuredAgentToken && !configuredAppPassword) {
        if (probe) {
            throw new AgentApiError({
                code: 'unauthorized',
                message: '模型渠道探测需要配置 AGENT_API_TOKEN 或 APP_PASSWORD。',
                status: 401,
                retryable: false
            });
        }
        return false;
    }
    if (!probe) {
        try {
            assertAgentAuthorized(request.headers);
            return true;
        } catch {
            // Declaration reads remain available without credentials, but only
            // authenticated callers may receive deployment details.
            return false;
        }
    }
    try {
        assertAgentAuthorized(request.headers);
        return true;
    } catch (error) {
        const accessCookie = request.cookies.get('gptImageAccess')?.value;
        // The workbench already proves APP_PASSWORD through this short-lived cookie.
        // Keep AGENT_API_TOKEN as the machine-client credential while allowing the
        // authenticated browser session to discover channel models.
        if (!configuredAppPassword || !verifyAccessToken(accessCookie, configuredAppPassword)) {
            throw error;
        }
        return true;
    }
}

function redactUnauthenticatedDirectory(directory: ReturnType<typeof buildAgentModelDirectory>): void {
    directory.channels.forEach((channel, index) => {
        const hadMixedCredentials = channel.model_allowlist_state === 'mixed';
        // Keep model IDs available so an unauthenticated local workbench can
        // preserve channel/model compatibility, but do not disclose deployment
        // channel names, explicit allowlist markers, or health/probe details.
        channel.id = `channel-${index + 1}`;
        delete channel.host;
        channel.declared_models = [];
        channel.model_allowlist_configured = false;
        // A shared channel may contain both restricted and unrestricted
        // credentials. Keep an anonymous marker so the selector does not
        // mistake retained model IDs for a complete allowlist, without
        // disclosing the concrete credential mix.
        if (hadMixedCredentials) channel.model_allowlist_state = 'redacted';
        else delete channel.model_allowlist_state;
        channel.probe_status = 'not_probed';
        delete channel.http_status;
        delete channel.error_code;
    });
}
