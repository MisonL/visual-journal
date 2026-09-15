export function buildContentSecurityPolicy(nonce: string | undefined, development = false): string {
    const normalizedNonce = nonce?.trim();
    const scriptNonce = normalizedNonce ? " 'nonce-" + normalizedNonce + "' 'strict-dynamic'" : '';
    const developmentEval = development ? " 'unsafe-eval'" : '';
    const developmentLocalSources = development ? ' http://localhost:*' : '';
    return (
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; " +
        "script-src 'self'" +
        scriptNonce +
        developmentEval +
        '; ' +
        "style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:" +
        developmentLocalSources +
        "; font-src 'self' data:; " +
        "connect-src 'self' https:" +
        developmentLocalSources +
        " ws: wss:; frame-src 'self'"
    );
}
