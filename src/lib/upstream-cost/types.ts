export type ActualCostSource = 'estimate' | 'new-api-log-token' | 'pending' | 'unavailable';

export type ActualCostConfidence = 'exact' | 'high' | 'low' | 'none';

export type UpstreamCostProvider = 'new-api' | 'openai' | 'sub2api' | 'unknown';

export type ActualCostDetails = {
    /** Estimated USD cost calculated from local token pricing when exact upstream billing is unavailable. */
    estimatedUsd?: number;
    /** Actual billed amount reported by the upstream provider, expressed in the declared currency. */
    actualAmount?: number;
    /** Raw upstream quota units when the provider bills in quota rather than direct USD. */
    actualQuota?: number;
    /** Currency semantics for actualAmount and actualQuota. */
    currency: 'usd-equivalent' | 'quota-unit';
    /** Data source used to resolve the cost. */
    source: ActualCostSource;
    /** Confidence level of the resolved cost. */
    confidence: ActualCostConfidence;
    /** Upstream provider whose billing or log data produced this result. */
    upstreamProvider: UpstreamCostProvider;
    /** Upstream billing log primary key when a log row was matched. */
    matchedLogId?: number;
    /** Upstream request id used to match billing logs or correlate pending results. */
    matchedRequestId?: string;
    /** Human-readable explanation for pending, unavailable, or low-confidence results. */
    reason?: string;
};

type UpstreamCostCredentials =
    | {
          apiBaseUrl: string;
          apiKey: string;
          upstreamProxyUrl?: string;
          allowedPlainHttpBaseUrls?: string[];
      }
    | {
          apiBaseUrl?: undefined;
          apiKey?: undefined;
          upstreamProxyUrl?: undefined;
          allowedPlainHttpBaseUrls?: string[];
      };

export type ResolveActualCostInput = UpstreamCostCredentials & {
    model: string;
    startedAtMs: number;
    finishedAtMs: number;
    expectedImageCount: number;
};

export type ActualCostResolver = {
    provider: UpstreamCostProvider;
    resolve(input: ResolveActualCostInput): Promise<ActualCostDetails>;
};
