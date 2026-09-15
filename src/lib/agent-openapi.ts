import {
    AGENT_BACKGROUNDS,
    AGENT_IMAGE_BACKENDS,
    AGENT_JOB_STATES,
    AGENT_MODERATIONS,
    AGENT_MODELS,
    AGENT_OUTPUT_FORMATS,
    AGENT_PAGE_SSE_AGENT_USAGE,
    AGENT_QUALITIES,
    AGENT_RESPONSE_MODES,
    AGENT_STREAM_MODES,
    AGENT_STREAMING_STRATEGIES,
    AGENT_UPSTREAM_SSE_EDIT_REQUEST_FIELDS,
    AGENT_UPSTREAM_SSE_GENERATE_REQUEST_FIELDS,
    AGENT_UPSTREAM_SSE_ACTIVATION_STRATEGIES,
    type AgentAuthScheme,
    type AgentRoutingStrength,
    type AgentRoutingTransport,
    buildAgentCapabilities,
    getAgentNonStreamPartialImagesRange,
    readAgentPublicBaseUrl,
    type NumericRange
} from './agent-api-contracts';
import { AGENT_ENDPOINTS } from './agent-api-paths.mjs';
import { CHANNEL_REQUEST_MODES } from './channel-request-mode';
import { MAX_MODEL_NAME_LENGTH, MAX_PROMPT_LENGTH } from './image-request-utils';

type AgentOpenApiSecurityRequirement = { BearerAuth: [] } | { AppPasswordHash: [] };

function buildAgentOpenApiSecurity(schemes: readonly AgentAuthScheme[]): AgentOpenApiSecurityRequirement[] {
    return schemes.map((scheme) => (scheme === 'bearer' ? { BearerAuth: [] } : { AppPasswordHash: [] }));
}

function buildAgentOpenApiSecuritySchemes(schemes: readonly AgentAuthScheme[]) {
    const securitySchemes: Record<string, { type: string; scheme?: string; in?: string; name?: string }> = {};
    if (schemes.includes('bearer')) {
        securitySchemes.BearerAuth = {
            type: 'http',
            scheme: 'bearer'
        };
    }
    if (schemes.includes('x-app-password-hash')) {
        securitySchemes.AppPasswordHash = {
            type: 'apiKey',
            in: 'header',
            name: 'X-App-Password-Hash'
        };
    }
    return securitySchemes;
}

function buildImageBackendRangeSchema(limits: Record<(typeof AGENT_IMAGE_BACKENDS)[number], NumericRange>) {
    return {
        type: 'object',
        required: [...AGENT_IMAGE_BACKENDS],
        properties: Object.fromEntries(
            AGENT_IMAGE_BACKENDS.map((backend) => [
                backend,
                {
                    type: 'object',
                    required: ['min', 'max'],
                    properties: {
                        min: { type: 'integer', const: limits[backend].min },
                        max: { type: 'integer', const: limits[backend].max },
                        ...(limits[backend].allowedValues
                            ? {
                                  allowedValues: {
                                      type: 'array',
                                      items: { type: 'integer' },
                                      const: [...limits[backend].allowedValues]
                                  }
                              }
                            : {})
                    },
                    additionalProperties: false
                }
            ])
        ),
        additionalProperties: false
    };
}

function buildNumericRangeSchema() {
    return {
        type: 'object',
        required: ['min', 'max'],
        properties: {
            min: { type: 'integer' },
            max: { type: 'integer' },
            allowedValues: { type: 'array', items: { type: 'integer' } }
        },
        additionalProperties: false
    };
}

function buildNonStreamPartialImagesCondition(hasAutomaticNonStreamChannel: boolean) {
    const defaultOrAutoStreamMode = {
        anyOf: [
            { not: { required: ['stream_mode'] } },
            {
                properties: { stream_mode: { const: 'auto' } },
                required: ['stream_mode']
            }
        ]
    };
    const offStrategy = {
        properties: { streaming_strategy: { enum: ['off'] } },
        required: ['streaming_strategy']
    };
    const autoStrategy = {
        anyOf: [
            { not: { required: ['streaming_strategy'] } },
            {
                properties: { streaming_strategy: { enum: ['auto'] } },
                required: ['streaming_strategy']
            }
        ]
    };
    return {
        anyOf: [
            {
                properties: { stream_mode: { const: 'non_stream' } },
                required: ['stream_mode']
            },
            { allOf: [defaultOrAutoStreamMode, offStrategy] },
            ...(hasAutomaticNonStreamChannel ? [{ allOf: [defaultOrAutoStreamMode, autoStrategy] }] : [])
        ]
    };
}

export function buildAgentOpenApiDocument(env: Record<string, string | undefined>) {
    const capabilities = buildAgentCapabilities(env);
    const maxGenerateImageCount = capabilities.limits.generate_images.max;
    const maxEditImageCount = capabilities.limits.edit_images.max;
    const maxSourceImageCount = capabilities.limits.upload_images.max;
    const nonStreamPartialImagesSchemaRange = getAgentNonStreamPartialImagesRange();
    const configuredChannels = capabilities.upstream_request_headers.channels;
    const assumeLegacyNonStreamChannel = configuredChannels.length === 0;
    const hasImagesAutomaticNonStreamChannel =
        assumeLegacyNonStreamChannel ||
        configuredChannels.some((channel) => channel.request_modes.includes('images-non-stream'));
    const hasResponsesAutomaticNonStreamChannel =
        assumeLegacyNonStreamChannel ||
        configuredChannels.some((channel) => channel.request_modes.includes('responses-non-stream'));
    const responsesNonStreamPartialImagesCondition = buildNonStreamPartialImagesCondition(
        hasResponsesAutomaticNonStreamChannel
    );
    const imagesNonStreamPartialImagesCondition = buildNonStreamPartialImagesCondition(
        hasImagesAutomaticNonStreamChannel
    );
    const supportsTransparentBackground =
        capabilities.upstream_profile.activeConstraints.gptImage2.allowTransparentBackground ||
        capabilities.upstream_request_headers.channels.some(
            (channel) => channel.constraints.gpt_image_2.allow_transparent_background
        );
    const supportedBackgrounds = supportsTransparentBackground
        ? AGENT_BACKGROUNDS
        : AGENT_BACKGROUNDS.filter((value) => value !== 'transparent');
    const jsonContent = (schemaRef: string) => ({
        content: {
            'application/json': {
                schema: { $ref: schemaRef }
            }
        }
    });
    const agentSecurity = buildAgentOpenApiSecurity(capabilities.auth.schemes);
    const securitySchemes = buildAgentOpenApiSecuritySchemes(capabilities.auth.schemes);
    const commonAgentErrors = {
        '401': jsonContent('#/components/schemas/AgentError'),
        '403': jsonContent('#/components/schemas/AgentError'),
        '415': jsonContent('#/components/schemas/AgentError'),
        '429': jsonContent('#/components/schemas/AgentError'),
        '502': jsonContent('#/components/schemas/AgentError')
    };
    return {
        openapi: '3.1.0',
        info: {
            title: 'Visual Journal Image Agent API',
            version: capabilities.api_version
        },
        servers: [{ url: readAgentPublicBaseUrl(env) }],
        paths: {
            [AGENT_ENDPOINTS.capabilities]: {
                get: {
                    summary: '获取机器可读的 Agent API 能力信息',
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentCapabilities')
                    }
                }
            },
            [AGENT_ENDPOINTS.models]: {
                get: {
                    summary:
                        '默认列出项目、配置和渠道声明的模型；使用 probe=true 显式探测渠道 /models（探测需要 Agent 或已验证页面会话鉴权）',
                    security: agentSecurity.length ? [...agentSecurity, {}] : [],
                    parameters: [
                        {
                            name: 'probe',
                            in: 'query',
                            required: false,
                            schema: { type: 'boolean', default: false }
                        }
                    ],
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentModelDirectory'),
                        '401': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.openapi]: {
                get: {
                    summary: '获取 Agent API 的 OpenAPI 文档',
                    responses: {
                        '200': { description: 'OpenAPI 文档' }
                    }
                }
            },
            [AGENT_ENDPOINTS.generate]: {
                post: {
                    summary: '为 Agent 生成图片',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
                    requestBody: {
                        required: true,
                        ...jsonContent('#/components/schemas/GenerateRequest')
                    },
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentImageResponse'),
                        '400': jsonContent('#/components/schemas/AgentError'),
                        '409': {
                            ...jsonContent('#/components/schemas/AgentError'),
                            headers: {
                                'Retry-After': { schema: { type: 'integer', minimum: 1 } }
                            }
                        },
                        ...commonAgentErrors,
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.edit]: {
                post: {
                    summary: '为 Agent 编辑图片',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
                    requestBody: {
                        required: true,
                        content: {
                            'multipart/form-data': {
                                schema: { $ref: '#/components/schemas/EditRequest' }
                            }
                        }
                    },
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentImageResponse'),
                        '400': jsonContent('#/components/schemas/AgentError'),
                        '409': {
                            ...jsonContent('#/components/schemas/AgentError'),
                            headers: {
                                'Retry-After': { schema: { type: 'integer', minimum: 1 } }
                            }
                        },
                        ...commonAgentErrors,
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.create_image_request]: {
                post: {
                    summary: '提交服务端编排的 Agent 图片生成意图',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
                    requestBody: {
                        required: true,
                        ...jsonContent('#/components/schemas/GenerateRequest')
                    },
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentJobStatusResponse'),
                        '202': {
                            ...jsonContent('#/components/schemas/AgentJobStatusResponse'),
                            headers: {
                                'Retry-After': { schema: { type: 'integer', minimum: 1 } }
                            }
                        },
                        '400': jsonContent('#/components/schemas/AgentError'),
                        '409': jsonContent('#/components/schemas/AgentError'),
                        ...commonAgentErrors,
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.create_generate_job]: {
                post: {
                    summary: '创建 Agent 图片生成 job',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
                    requestBody: {
                        required: true,
                        ...jsonContent('#/components/schemas/GenerateRequest')
                    },
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentJobStatusResponse'),
                        '202': {
                            ...jsonContent('#/components/schemas/AgentJobStatusResponse'),
                            headers: {
                                'Retry-After': { schema: { type: 'integer', minimum: 1 } }
                            }
                        },
                        '400': jsonContent('#/components/schemas/AgentError'),
                        '409': jsonContent('#/components/schemas/AgentError'),
                        ...commonAgentErrors,
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.job]: {
                get: {
                    summary: '获取 Agent job 状态',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/JobId' }],
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentJobStatusResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '404': jsonContent('#/components/schemas/AgentError'),
                        '410': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.job_result]: {
                get: {
                    summary: '获取 Agent job 结果',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/JobId' }],
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentImageResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '403': jsonContent('#/components/schemas/AgentError'),
                        '404': jsonContent('#/components/schemas/AgentError'),
                        '409': {
                            ...jsonContent('#/components/schemas/AgentError'),
                            headers: {
                                'Retry-After': { schema: { type: 'integer', minimum: 1 } }
                            }
                        },
                        '410': jsonContent('#/components/schemas/AgentError'),
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '429': jsonContent('#/components/schemas/AgentError'),
                        '502': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.artifact_metadata]: {
                get: {
                    summary: '获取产物元数据',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/ArtifactId' }],
                    responses: {
                        '200': jsonContent('#/components/schemas/ArtifactMetadataResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '404': jsonContent('#/components/schemas/AgentError')
                    }
                },
                delete: {
                    summary: '删除产物',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/ArtifactId' }],
                    responses: {
                        '200': jsonContent('#/components/schemas/DeleteArtifactResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '404': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.artifact_content]: {
                get: {
                    summary: '下载产物内容',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/ArtifactId' }],
                    responses: {
                        '200': {
                            description: '图片二进制内容',
                            content: {
                                'image/png': { schema: { type: 'string', format: 'binary' } },
                                'image/jpeg': { schema: { type: 'string', format: 'binary' } },
                                'image/webp': { schema: { type: 'string', format: 'binary' } }
                            }
                        },
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '404': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.artifact_share]: {
                post: {
                    summary: '为 Agent 产物创建浏览器可访问的分享链接',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/ArtifactId' }],
                    requestBody: {
                        required: false,
                        ...jsonContent('#/components/schemas/CreateArtifactShareRequest')
                    },
                    responses: {
                        '201': jsonContent('#/components/schemas/ArtifactShareResponse'),
                        '400': jsonContent('#/components/schemas/AgentError'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '404': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.page_request_feedback_batch]: {
                post: {
                    summary: '批量读取页面请求的结果反馈',
                    security: agentSecurity,
                    requestBody: {
                        required: true,
                        ...jsonContent('#/components/schemas/PageRequestFeedbackBatchRequest')
                    },
                    responses: {
                        '200': jsonContent('#/components/schemas/PageRequestFeedbackBatchResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.page_request_feedback]: {
                get: {
                    summary: '读取页面请求的结果反馈',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/PageRequestId' }],
                    responses: {
                        '200': jsonContent('#/components/schemas/PageRequestFeedbackResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.channel_health_diagnostics]: {
                get: {
                    summary: '读取当前进程的渠道健康诊断快照',
                    description:
                        '只读返回当前进程内存中的渠道、凭证和请求方式状态；不会为了读取而初始化路由或启动恢复探测，因此不会触发上游探测或图片生成，也不代表真实上游可用性。',
                    security: agentSecurity,
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentChannelHealthDiagnosticsResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.agent_request_diagnostics_lookup]: {
                get: {
                    summary: '按 request_id 或 idempotency_key 读取 Agent state 请求诊断',
                    security: agentSecurity,
                    parameters: [
                        {
                            name: 'request_id',
                            in: 'query',
                            required: false,
                            schema: { type: 'string', minLength: 1, maxLength: 200 }
                        },
                        {
                            name: 'idempotency_key',
                            in: 'query',
                            required: false,
                            schema: { type: 'string', minLength: 1, maxLength: 200 }
                        }
                    ],
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentRequestDiagnosticsLookupResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '404': jsonContent('#/components/schemas/AgentRequestDiagnosticsLookupResponse'),
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.agent_request_diagnostics]: {
                get: {
                    summary: '按 request_id 读取 Agent state 请求诊断',
                    security: agentSecurity,
                    parameters: [{ $ref: '#/components/parameters/AgentRequestId' }],
                    responses: {
                        '200': jsonContent('#/components/schemas/AgentRequestDiagnosticsLookupResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '404': jsonContent('#/components/schemas/AgentRequestDiagnosticsLookupResponse'),
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.page_request_diagnostics_batch]: {
                post: {
                    summary: '批量读取页面请求的日志诊断摘要',
                    security: agentSecurity,
                    requestBody: {
                        required: true,
                        ...jsonContent('#/components/schemas/PageRequestDiagnosticsBatchRequest')
                    },
                    responses: {
                        '200': jsonContent('#/components/schemas/PageRequestDiagnosticsBatchResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            },
            [AGENT_ENDPOINTS.page_request_diagnostics]: {
                get: {
                    summary: '读取页面请求的日志诊断摘要',
                    security: agentSecurity,
                    parameters: [
                        { $ref: '#/components/parameters/PageRequestId' },
                        {
                            name: 'filename',
                            in: 'query',
                            required: false,
                            schema: { type: 'array', items: { type: 'string' } },
                            style: 'form',
                            explode: true
                        }
                    ],
                    responses: {
                        '200': jsonContent('#/components/schemas/PageRequestDiagnosticsResponse'),
                        '401': jsonContent('#/components/schemas/AgentError'),
                        '422': jsonContent('#/components/schemas/AgentError'),
                        '500': jsonContent('#/components/schemas/AgentError')
                    }
                }
            }
        },
        components: {
            securitySchemes,
            parameters: {
                IdempotencyKey: {
                    name: 'Idempotency-Key',
                    in: 'header',
                    required: true,
                    schema: { type: 'string', minLength: 1, maxLength: 200 }
                },
                ArtifactId: {
                    name: 'id',
                    in: 'path',
                    required: true,
                    schema: { type: 'string', minLength: 1 }
                },
                JobId: {
                    name: 'id',
                    in: 'path',
                    required: true,
                    schema: { type: 'string', minLength: 1 }
                },
                AgentRequestId: {
                    name: 'id',
                    in: 'path',
                    required: true,
                    schema: { type: 'string', minLength: 1, maxLength: 200 }
                },
                PageRequestId: {
                    name: 'id',
                    in: 'path',
                    required: true,
                    schema: { type: 'string', minLength: 1, maxLength: 200 }
                }
            },
            schemas: {
                AgentModelDirectory: {
                    type: 'object',
                    required: ['ok', 'default_model', 'known_models', 'channels', 'probe'],
                    properties: {
                        ok: { type: 'boolean', const: true },
                        default_model: { type: 'string' },
                        known_models: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['id', 'source', 'custom', 'status', 'size_policy', 'strict_dimensions'],
                                properties: {
                                    id: { type: 'string' },
                                    source: {
                                        type: 'string',
                                        enum: ['project_default', 'project_known', 'configured']
                                    },
                                    custom: { type: 'boolean' },
                                    status: {
                                        type: 'string',
                                        enum: ['declared', 'verified_usable', 'known_unavailable']
                                    },
                                    size_policy: {
                                        type: 'string',
                                        enum: ['provider_defined', 'legacy_allowlist']
                                    },
                                    strict_dimensions: { type: 'boolean' }
                                },
                                additionalProperties: false
                            }
                        },
                        channels: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: [
                                    'id',
                                    'configured',
                                    'declared_models',
                                    'model_allowlist_configured',
                                    'models',
                                    'probe_status'
                                ],
                                properties: {
                                    id: { type: 'string' },
                                    host: { type: 'string' },
                                    configured: { type: 'boolean' },
                                    declared_models: { type: 'array', items: { type: 'string' } },
                                    model_allowlist_configured: { type: 'boolean' },
                                    model_allowlist_state: {
                                        type: 'string',
                                        enum: ['unrestricted', 'restricted', 'mixed', 'redacted']
                                    },
                                    models: { type: 'array', items: { type: 'string' } },
                                    probe_status: { type: 'string', enum: ['not_probed', 'ok', 'failed'] },
                                    http_status: { type: 'integer' },
                                    error_code: {
                                        type: 'string',
                                        enum: [
                                            'missing_base_url',
                                            'missing_api_key',
                                            'request_failed',
                                            'invalid_response',
                                            'upstream_error'
                                        ]
                                    }
                                },
                                additionalProperties: false
                            }
                        },
                        probe: {
                            type: 'object',
                            required: ['requested', 'timeout_ms'],
                            properties: {
                                requested: { type: 'boolean' },
                                timeout_ms: { type: 'integer', minimum: 1 }
                            },
                            additionalProperties: false
                        }
                    },
                    additionalProperties: false
                },
                AgentCapabilities: {
                    type: 'object',
                    required: [
                        'api_version',
                        'schema_version',
                        'auth',
                        'endpoints',
                        'image_transport',
                        'upstream_profile',
                        'upstream_request_headers',
                        'request_mode_controls',
                        'defaults',
                        'limits',
                        'force_request_controls',
                        'model_limits',
                        'agent_streaming',
                        'orchestration',
                        'routing_rules',
                        'agent_jobs',
                        'supported',
                        'model_directory',
                        'storage',
                        'page_request_diagnostics',
                        'agent_request_diagnostics',
                        'channel_health_diagnostics',
                        'idempotency'
                    ],
                    properties: {
                        api_version: { type: 'string' },
                        schema_version: { type: 'string' },
                        auth: {
                            type: 'object',
                            required: ['required', 'schemes'],
                            properties: {
                                required: { type: 'boolean', const: capabilities.auth.required },
                                schemes: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    const: capabilities.auth.schemes
                                }
                            }
                        },
                        endpoints: { type: 'object', additionalProperties: { type: 'string' } },
                        image_transport: { $ref: '#/components/schemas/ImageTransportCapabilities' },
                        upstream_request_headers: {
                            type: 'object',
                            required: ['default', 'channels'],
                            properties: {
                                default: { $ref: '#/components/schemas/UpstreamRequestHeaderSummary' },
                                channels: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        required: [
                                            'id',
                                            'upstream_proxy',
                                            'request_modes',
                                            'request_mode_priority',
                                            'request_headers',
                                            'constraints'
                                        ],
                                        properties: {
                                            id: { type: 'string' },
                                            upstream_proxy: { $ref: '#/components/schemas/UpstreamProxySummary' },
                                            request_modes: {
                                                type: 'array',
                                                items: { type: 'string', enum: CHANNEL_REQUEST_MODES }
                                            },
                                            request_mode_priority: {
                                                type: 'array',
                                                items: { type: 'string', enum: CHANNEL_REQUEST_MODES }
                                            },
                                            request_headers: {
                                                $ref: '#/components/schemas/UpstreamRequestHeaderSummary'
                                            },
                                            constraints: { $ref: '#/components/schemas/AgentChannelConstraints' },
                                            healthy_request_modes: {
                                                type: 'array',
                                                items: { type: 'string', enum: CHANNEL_REQUEST_MODES }
                                            }
                                        },
                                        additionalProperties: false
                                    }
                                }
                            },
                            additionalProperties: false
                        },
                        request_mode_controls: { $ref: '#/components/schemas/AgentRequestModeControls' },
                        upstream_profile: {
                            type: 'object',
                            required: [
                                'activeProfile',
                                'serverProfile',
                                'serverProfileMixed',
                                'serverConstraintsMixed',
                                'serverConstraintsByProfile',
                                'requestProfile',
                                'activeConstraints',
                                'serverConstraints',
                                'requestConstraints'
                            ],
                            properties: {
                                activeProfile: {
                                    type: 'string',
                                    enum: ['openai-compatible', 'matsca'],
                                    const: capabilities.upstream_profile.activeProfile
                                },
                                serverProfile: {
                                    type: 'string',
                                    enum: ['openai-compatible', 'matsca'],
                                    const: capabilities.upstream_profile.serverProfile
                                },
                                serverProfileMixed: {
                                    type: 'boolean',
                                    const: capabilities.upstream_profile.serverProfileMixed
                                },
                                serverConstraintsMixed: {
                                    type: 'boolean',
                                    const: capabilities.upstream_profile.serverConstraintsMixed
                                },
                                serverConstraintsByProfile: {
                                    type: 'array',
                                    items: { $ref: '#/components/schemas/ImageUpstreamProfile' }
                                },
                                requestProfile: {
                                    type: 'string',
                                    enum: ['openai-compatible', 'matsca'],
                                    const: capabilities.upstream_profile.requestProfile
                                },
                                activeConstraints: { $ref: '#/components/schemas/ImageUpstreamProfile' },
                                serverConstraints: { $ref: '#/components/schemas/ImageUpstreamProfile' },
                                requestConstraints: { $ref: '#/components/schemas/ImageUpstreamProfile' }
                            },
                            additionalProperties: false
                        },
                        defaults: {
                            type: 'object',
                            required: [
                                'model',
                                'response_mode',
                                'state_backend',
                                'image_backend',
                                'stream_mode',
                                'streaming_strategy',
                                'partial_images'
                            ],
                            properties: {
                                model: { type: 'string', minLength: 1, maxLength: 200 },
                                response_mode: { type: 'string', enum: AGENT_RESPONSE_MODES },
                                state_backend: { type: 'string', enum: ['memory', 'sqlite', 'postgres'] },
                                image_backend: { type: 'string', enum: AGENT_IMAGE_BACKENDS },
                                stream_mode: { type: 'string', enum: AGENT_STREAM_MODES },
                                streaming_strategy: { type: 'string', enum: AGENT_STREAMING_STRATEGIES },
                                partial_images: {
                                    type: 'integer',
                                    minimum: capabilities.limits.partial_images.min,
                                    maximum: capabilities.limits.partial_images.max,
                                    ...(capabilities.limits.partial_images.allowedValues
                                        ? { enum: [...capabilities.limits.partial_images.allowedValues] }
                                        : {})
                                }
                            }
                        },
                        limits: {
                            type: 'object',
                            required: [
                                'max_prompt_length',
                                'max_images',
                                'generate_images',
                                'edit_images',
                                'generate_images_by_backend',
                                'edit_images_by_backend',
                                'upload_images',
                                'max_upload_mb',
                                ...(capabilities.limits.max_total_upload_mb !== undefined
                                    ? ['max_total_upload_mb']
                                    : []),
                                'partial_images',
                                'partial_images_by_backend',
                                'upstream_profile',
                                'upstream_profile_mixed'
                            ],
                            properties: {
                                max_prompt_length: { type: 'integer', const: capabilities.limits.max_prompt_length },
                                max_images: { type: 'integer', const: capabilities.limits.max_images },
                                generate_images: {
                                    type: 'object',
                                    required: ['min', 'max'],
                                    properties: {
                                        min: { type: 'integer', const: capabilities.limits.generate_images.min },
                                        max: { type: 'integer', const: capabilities.limits.generate_images.max },
                                        ...(capabilities.limits.generate_images.allowedValues
                                            ? {
                                                  allowedValues: {
                                                      type: 'array',
                                                      items: { type: 'integer' },
                                                      const: [...capabilities.limits.generate_images.allowedValues]
                                                  }
                                              }
                                            : {})
                                    },
                                    additionalProperties: false
                                },
                                edit_images: {
                                    type: 'object',
                                    required: ['min', 'max'],
                                    properties: {
                                        min: { type: 'integer', const: capabilities.limits.edit_images.min },
                                        max: { type: 'integer', const: capabilities.limits.edit_images.max },
                                        ...(capabilities.limits.edit_images.allowedValues
                                            ? {
                                                  allowedValues: {
                                                      type: 'array',
                                                      items: { type: 'integer' },
                                                      const: [...capabilities.limits.edit_images.allowedValues]
                                                  }
                                              }
                                            : {})
                                    },
                                    additionalProperties: false
                                },
                                generate_images_by_backend: buildImageBackendRangeSchema(
                                    capabilities.limits.generate_images_by_backend
                                ),
                                edit_images_by_backend: buildImageBackendRangeSchema(
                                    capabilities.limits.edit_images_by_backend
                                ),
                                upload_images: {
                                    type: 'object',
                                    required: ['max'],
                                    properties: {
                                        max: { type: 'integer', const: capabilities.limits.upload_images.max }
                                    },
                                    additionalProperties: false
                                },
                                max_upload_mb: { type: 'number', const: capabilities.limits.max_upload_mb },
                                ...(capabilities.limits.max_total_upload_mb !== undefined
                                    ? {
                                          max_total_upload_mb: {
                                              type: 'number',
                                              const: capabilities.limits.max_total_upload_mb
                                          }
                                      }
                                    : {}),
                                partial_images: {
                                    type: 'object',
                                    required: ['min', 'max'],
                                    properties: {
                                        min: { type: 'integer', const: capabilities.limits.partial_images.min },
                                        max: { type: 'integer', const: capabilities.limits.partial_images.max },
                                        ...(capabilities.limits.partial_images.allowedValues
                                            ? {
                                                  allowedValues: {
                                                      type: 'array',
                                                      items: { type: 'integer' },
                                                      const: [...capabilities.limits.partial_images.allowedValues]
                                                  }
                                              }
                                            : {})
                                    },
                                    additionalProperties: false
                                },
                                partial_images_by_backend: {
                                    type: 'object',
                                    required: ['images-api', 'responses-image-generation'],
                                    properties: {
                                        'images-api': {
                                            type: 'object',
                                            required: ['min', 'max'],
                                            properties: {
                                                min: {
                                                    type: 'integer',
                                                    const: capabilities.limits.partial_images_by_backend['images-api']
                                                        .min
                                                },
                                                max: {
                                                    type: 'integer',
                                                    const: capabilities.limits.partial_images_by_backend['images-api']
                                                        .max
                                                },
                                                ...(capabilities.limits.partial_images_by_backend['images-api']
                                                    .allowedValues
                                                    ? {
                                                          allowedValues: {
                                                              type: 'array',
                                                              items: { type: 'integer' },
                                                              const: [
                                                                  ...capabilities.limits.partial_images_by_backend[
                                                                      'images-api'
                                                                  ].allowedValues
                                                              ]
                                                          }
                                                      }
                                                    : {})
                                            },
                                            additionalProperties: false
                                        },
                                        'responses-image-generation': {
                                            type: 'object',
                                            required: ['min', 'max'],
                                            properties: {
                                                min: {
                                                    type: 'integer',
                                                    const: capabilities.limits.partial_images_by_backend[
                                                        'responses-image-generation'
                                                    ].min
                                                },
                                                max: {
                                                    type: 'integer',
                                                    const: capabilities.limits.partial_images_by_backend[
                                                        'responses-image-generation'
                                                    ].max
                                                },
                                                ...(capabilities.limits.partial_images_by_backend[
                                                    'responses-image-generation'
                                                ].allowedValues
                                                    ? {
                                                          allowedValues: {
                                                              type: 'array',
                                                              items: { type: 'integer' },
                                                              const: [
                                                                  ...capabilities.limits.partial_images_by_backend[
                                                                      'responses-image-generation'
                                                                  ].allowedValues
                                                              ]
                                                          }
                                                      }
                                                    : {})
                                            },
                                            additionalProperties: false
                                        }
                                    },
                                    additionalProperties: false
                                },
                                upstream_profile: {
                                    type: 'string',
                                    enum: ['openai-compatible', 'matsca'],
                                    const: capabilities.limits.upstream_profile
                                },
                                upstream_profile_mixed: {
                                    type: 'boolean',
                                    const: capabilities.limits.upstream_profile_mixed
                                }
                            },
                            additionalProperties: false
                        },
                        model_limits: { $ref: '#/components/schemas/AgentModelLimits' },
                        model_directory: {
                            type: 'object',
                            required: ['endpoint', 'probe_query', 'default_model', 'semantics'],
                            properties: {
                                endpoint: { type: 'string', const: capabilities.model_directory.endpoint },
                                probe_query: { type: 'string', const: capabilities.model_directory.probe_query },
                                default_model: { type: 'string', const: capabilities.model_directory.default_model },
                                semantics: { type: 'string', const: capabilities.model_directory.semantics }
                            },
                            additionalProperties: false
                        },
                        force_request_controls: {
                            type: 'object',
                            required: ['field', 'cli_flag', 'default', 'effect', 'still_enforced', 'intended_for'],
                            properties: {
                                field: { type: 'string', const: capabilities.force_request_controls.field },
                                cli_flag: { type: 'string', const: capabilities.force_request_controls.cli_flag },
                                default: { type: 'boolean', const: false },
                                effect: { type: 'string', const: capabilities.force_request_controls.effect },
                                still_enforced: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    const: capabilities.force_request_controls.still_enforced
                                },
                                intended_for: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    const: capabilities.force_request_controls.intended_for
                                }
                            },
                            additionalProperties: false
                        },
                        agent_streaming: { $ref: '#/components/schemas/AgentStreamingCapabilities' },
                        orchestration: { $ref: '#/components/schemas/AgentOrchestrationCapabilities' },
                        routing_rules: { $ref: '#/components/schemas/AgentRoutingRules' },
                        agent_jobs: { $ref: '#/components/schemas/AgentJobCapabilities' },
                        supported: {
                            type: 'object',
                            required: [
                                'models',
                                'output_formats',
                                'response_modes',
                                'qualities',
                                'backgrounds',
                                'moderations',
                                'legacy_sizes',
                                'image_backends',
                                'enabled_image_backends',
                                'image_backend_requirements',
                                'request_modes',
                                'streaming_strategies',
                                'stream_modes'
                            ],
                            properties: {
                                models: { type: 'array', items: { type: 'string', enum: AGENT_MODELS } },
                                output_formats: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_OUTPUT_FORMATS }
                                },
                                response_modes: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_RESPONSE_MODES }
                                },
                                qualities: { type: 'array', items: { type: 'string', enum: AGENT_QUALITIES } },
                                backgrounds: { type: 'array', items: { type: 'string', enum: AGENT_BACKGROUNDS } },
                                moderations: { type: 'array', items: { type: 'string', enum: AGENT_MODERATIONS } },
                                legacy_sizes: { type: 'array', items: { type: 'string' } },
                                image_backends: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_IMAGE_BACKENDS }
                                },
                                enabled_image_backends: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_IMAGE_BACKENDS }
                                },
                                image_backend_requirements: {
                                    type: 'object',
                                    additionalProperties: { $ref: '#/components/schemas/ImageBackendRequirement' }
                                },
                                request_modes: {
                                    type: 'array',
                                    items: { type: 'string', enum: CHANNEL_REQUEST_MODES }
                                },
                                streaming_strategies: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_STREAMING_STRATEGIES }
                                },
                                stream_modes: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_STREAM_MODES }
                                }
                            }
                        },
                        storage: {
                            type: 'object',
                            required: ['image_storage_mode', 'postgres_configured'],
                            properties: {
                                image_storage_mode: { type: 'string' },
                                postgres_configured: { type: 'boolean' }
                            }
                        },
                        page_request_diagnostics: {
                            $ref: '#/components/schemas/AgentPageRequestDiagnosticsCapabilities'
                        },
                        agent_request_diagnostics: {
                            $ref: '#/components/schemas/AgentRequestDiagnosticsCapabilities'
                        },
                        channel_health_diagnostics: {
                            $ref: '#/components/schemas/AgentChannelHealthDiagnosticsCapabilities'
                        },
                        idempotency: { type: 'object' }
                    }
                },
                AgentModelLimits: {
                    type: 'object',
                    description:
                        '已知模型的专用约束。未列出的自定义模型由渠道 provider manifest 或上游 API 决定尺寸、背景和能力。',
                    required: ['gpt-image-2', 'gpt-image-2-1k', 'provider_defined'],
                    properties: {
                        'gpt-image-2': {
                            type: 'object',
                            required: [
                                'max_edge',
                                'max_pixels',
                                'edge_multiple',
                                'max_aspect',
                                'min_pixels',
                                'size_policy',
                                'allow_transparent_background',
                                'recommended_presets',
                                'large_image_risk'
                            ],
                            properties: {
                                max_edge: { type: 'integer', minimum: 1 },
                                max_pixels: { type: 'integer', minimum: 1 },
                                edge_multiple: { type: 'integer', minimum: 1 },
                                max_aspect: { type: ['number', 'null'], minimum: 1 },
                                min_pixels: { type: 'integer', minimum: 1 },
                                size_policy: { type: 'string', enum: ['provider_defined', 'openai-compatible'] },
                                allow_transparent_background: { type: 'boolean' },
                                recommended_presets: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        required: ['name', 'size', 'purpose'],
                                        properties: {
                                            name: { type: 'string' },
                                            size: { type: 'string' },
                                            purpose: { type: 'string' }
                                        }
                                    }
                                },
                                large_image_risk: {
                                    type: 'object',
                                    required: ['applies_to', 'guidance'],
                                    properties: {
                                        applies_to: { type: 'array', items: { type: 'string' } },
                                        guidance: { type: 'string' }
                                    }
                                }
                            },
                            additionalProperties: false
                        },
                        'gpt-image-2-1k': {
                            type: 'object',
                            required: [
                                'max_edge',
                                'max_pixels',
                                'edge_multiple',
                                'max_aspect',
                                'min_pixels',
                                'size_policy',
                                'allow_transparent_background',
                                'recommended_presets',
                                'large_image_risk'
                            ],
                            properties: {
                                max_edge: { type: 'integer', minimum: 1 },
                                max_pixels: { type: 'integer', minimum: 1 },
                                edge_multiple: { type: 'integer', minimum: 1 },
                                max_aspect: { type: ['number', 'null'], minimum: 1 },
                                min_pixels: { type: 'integer', minimum: 1 },
                                size_policy: { type: 'string', enum: ['provider_defined', 'openai-compatible'] },
                                allow_transparent_background: { type: 'boolean' },
                                recommended_presets: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        required: ['name', 'size', 'purpose'],
                                        properties: {
                                            name: { type: 'string' },
                                            size: { type: 'string' },
                                            purpose: { type: 'string' }
                                        },
                                        additionalProperties: false
                                    }
                                },
                                large_image_risk: {
                                    type: 'object',
                                    required: ['applies_to', 'guidance'],
                                    properties: {
                                        applies_to: { type: 'array', items: { type: 'string' } },
                                        guidance: { type: 'string' }
                                    },
                                    additionalProperties: false
                                }
                            },
                            additionalProperties: false
                        },
                        provider_defined: {
                            type: 'object',
                            description: '所有 provider-defined 模型共享的本地尺寸与像素预算。',
                            required: ['max_edge', 'max_pixels'],
                            properties: {
                                max_edge: { type: 'integer', minimum: 1 },
                                max_pixels: { type: 'integer', minimum: 1 }
                            },
                            additionalProperties: false
                        }
                    }
                },
                ImageUpstreamProfile: {
                    type: 'object',
                    required: ['id', 'generateCount', 'editCount', 'partialImages', 'upload', 'gptImage2'],
                    properties: {
                        id: { type: 'string', enum: ['openai-compatible', 'matsca'] },
                        providerManifest: {
                            type: 'object',
                            additionalProperties: true
                        },
                        generateCount: {
                            type: 'object',
                            required: ['min', 'max'],
                            properties: {
                                min: { type: 'integer', minimum: 1 },
                                max: { type: 'integer', minimum: 1 },
                                allowedValues: { type: 'array', items: { type: 'integer', minimum: 1 } }
                            },
                            additionalProperties: false
                        },
                        editCount: {
                            type: 'object',
                            required: ['min', 'max'],
                            properties: {
                                min: { type: 'integer', minimum: 1 },
                                max: { type: 'integer', minimum: 1 },
                                allowedValues: { type: 'array', items: { type: 'integer', minimum: 1 } }
                            },
                            additionalProperties: false
                        },
                        partialImages: {
                            type: 'object',
                            required: ['min', 'max'],
                            properties: {
                                min: { type: 'integer', minimum: 0 },
                                max: { type: 'integer', minimum: 0 },
                                allowedValues: { type: 'array', items: { type: 'integer', minimum: 0 } }
                            },
                            additionalProperties: false
                        },
                        upload: {
                            type: 'object',
                            required: ['maxImages', 'maxSingleBytes'],
                            properties: {
                                maxImages: { type: 'integer', minimum: 1 },
                                maxSingleBytes: { type: 'integer', minimum: 1 },
                                maxTotalBytes: { type: 'integer', minimum: 1 }
                            },
                            additionalProperties: false
                        },
                        gptImage2: {
                            type: 'object',
                            required: ['allowTransparentBackground', 'sizePolicy'],
                            properties: {
                                allowTransparentBackground: { type: 'boolean' },
                                sizePolicy: { type: 'string', enum: ['openai-compatible', 'positive-integer'] }
                            },
                            additionalProperties: false
                        }
                    },
                    additionalProperties: false
                },
                AgentChannelConstraints: {
                    type: 'object',
                    required: [
                        'generate_images',
                        'edit_images',
                        'partial_images',
                        'generate_images_by_backend',
                        'edit_images_by_backend',
                        'partial_images_by_backend',
                        'upload_images',
                        'gpt_image_2'
                    ],
                    properties: {
                        generate_images: buildNumericRangeSchema(),
                        edit_images: buildNumericRangeSchema(),
                        partial_images: buildNumericRangeSchema(),
                        generate_images_by_backend: {
                            type: 'object',
                            properties: Object.fromEntries(
                                AGENT_IMAGE_BACKENDS.map((backend) => [backend, buildNumericRangeSchema()])
                            ),
                            additionalProperties: false
                        },
                        edit_images_by_backend: {
                            type: 'object',
                            properties: Object.fromEntries(
                                AGENT_IMAGE_BACKENDS.map((backend) => [backend, buildNumericRangeSchema()])
                            ),
                            additionalProperties: false
                        },
                        partial_images_by_backend: {
                            type: 'object',
                            properties: Object.fromEntries(
                                AGENT_IMAGE_BACKENDS.map((backend) => [backend, buildNumericRangeSchema()])
                            ),
                            additionalProperties: false
                        },
                        upload_images: {
                            type: 'object',
                            required: ['max', 'max_single_mb'],
                            properties: {
                                max: { type: 'integer', minimum: 1 },
                                max_single_mb: { type: 'number', minimum: 0 },
                                max_total_mb: { type: 'number', minimum: 0 }
                            },
                            additionalProperties: false
                        },
                        gpt_image_2: {
                            type: 'object',
                            required: ['allow_transparent_background', 'size_policy'],
                            properties: {
                                allow_transparent_background: { type: 'boolean' },
                                size_policy: { type: 'string', enum: ['openai-compatible', 'positive-integer'] }
                            },
                            additionalProperties: false
                        }
                    },
                    additionalProperties: false
                },
                ImageBackendRequirement: {
                    type: 'object',
                    required: ['supported', 'enabled', 'required_env', 'missing_env'],
                    properties: {
                        supported: { type: 'boolean', const: true },
                        enabled: { type: 'boolean' },
                        required_env: { type: 'array', items: { type: 'string' } },
                        missing_env: { type: 'array', items: { type: 'string' } },
                        incompatible_constraints: { type: 'array', items: { type: 'string' } },
                        streaming_incompatible_constraints: { type: 'array', items: { type: 'string' } }
                    },
                    additionalProperties: false
                },
                AppLogRetentionMetadata: {
                    type: 'object',
                    required: [
                        'storage',
                        'max_entries',
                        'default_max_entries',
                        'min_entries',
                        'max_configured_entries',
                        'configured_by',
                        'persisted_across_process_restart',
                        'loss_modes',
                        'bounded',
                        'not_agent_state_backend'
                    ],
                    properties: {
                        storage: {
                            type: 'string',
                            const: capabilities.page_request_diagnostics.retention.storage
                        },
                        max_entries: {
                            type: 'integer',
                            minimum: 1,
                            const: capabilities.page_request_diagnostics.retention.max_entries
                        },
                        default_max_entries: {
                            type: 'integer',
                            minimum: 1,
                            const: capabilities.page_request_diagnostics.retention.default_max_entries
                        },
                        min_entries: {
                            type: 'integer',
                            minimum: 1,
                            const: capabilities.page_request_diagnostics.retention.min_entries
                        },
                        max_configured_entries: {
                            type: 'integer',
                            minimum: 1,
                            const: capabilities.page_request_diagnostics.retention.max_configured_entries
                        },
                        configured_by: {
                            type: 'string',
                            const: capabilities.page_request_diagnostics.retention.configured_by
                        },
                        persisted_across_process_restart: { type: 'boolean', const: true },
                        loss_modes: {
                            type: 'array',
                            items: { type: 'string' },
                            const: capabilities.page_request_diagnostics.retention.loss_modes
                        },
                        bounded: { type: 'boolean', const: true },
                        not_agent_state_backend: { type: 'boolean', const: true }
                    }
                },
                AgentPageRequestDiagnosticsCapabilities: {
                    type: 'object',
                    required: ['supported', 'source', 'endpoints', 'retention', 'no_match_hint'],
                    properties: {
                        supported: { type: 'boolean', const: true },
                        source: { type: 'string', enum: ['app_log'] },
                        endpoints: {
                            type: 'object',
                            required: ['single', 'batch'],
                            properties: {
                                single: { type: 'string', const: AGENT_ENDPOINTS.page_request_diagnostics },
                                batch: { type: 'string', const: AGENT_ENDPOINTS.page_request_diagnostics_batch }
                            }
                        },
                        retention: { $ref: '#/components/schemas/AppLogRetentionMetadata' },
                        no_match_hint: {
                            type: 'string',
                            const: capabilities.page_request_diagnostics.no_match_hint
                        }
                    }
                },
                AgentRequestDiagnosticsRetention: {
                    type: 'object',
                    required: ['storage', 'ttl_seconds', 'bounded', 'loss_modes'],
                    properties: {
                        storage: {
                            type: 'string',
                            const: capabilities.agent_request_diagnostics.retention.storage
                        },
                        ttl_seconds: {
                            type: 'integer',
                            minimum: 1,
                            const: capabilities.agent_request_diagnostics.retention.ttl_seconds
                        },
                        bounded: { type: 'boolean', const: true },
                        loss_modes: {
                            type: 'array',
                            items: { type: 'string' },
                            const: capabilities.agent_request_diagnostics.retention.loss_modes
                        }
                    },
                    additionalProperties: false
                },
                AgentRequestDiagnosticsCapabilities: {
                    type: 'object',
                    required: ['supported', 'source', 'endpoints', 'lookup', 'retention'],
                    properties: {
                        supported: { type: 'boolean', const: true },
                        source: { type: 'string', enum: ['agent_state'] },
                        endpoints: {
                            type: 'object',
                            required: ['lookup', 'single'],
                            properties: {
                                lookup: { type: 'string', const: AGENT_ENDPOINTS.agent_request_diagnostics_lookup },
                                single: { type: 'string', const: AGENT_ENDPOINTS.agent_request_diagnostics }
                            },
                            additionalProperties: false
                        },
                        lookup: {
                            type: 'object',
                            required: ['by_request_id', 'by_idempotency_key'],
                            properties: {
                                by_request_id: { type: 'boolean', const: true },
                                by_idempotency_key: { type: 'boolean', const: true }
                            },
                            additionalProperties: false
                        },
                        retention: { $ref: '#/components/schemas/AgentRequestDiagnosticsRetention' }
                    },
                    additionalProperties: false
                },
                AgentChannelHealthDiagnosticsCapabilities: {
                    type: 'object',
                    required: ['supported', 'endpoint', 'source', 'state_scope', 'billable'],
                    properties: {
                        supported: { type: 'boolean', const: true },
                        endpoint: { type: 'string', const: AGENT_ENDPOINTS.channel_health_diagnostics },
                        source: { type: 'string', const: 'in_process_channel_router' },
                        state_scope: { type: 'string', const: 'process_local' },
                        billable: { type: 'boolean', const: false }
                    },
                    additionalProperties: false
                },
                AgentChannelHealthDiagnosticsResponse: {
                    type: 'object',
                    required: ['ok', 'billable', 'source', 'state_scope', 'state_initialized', 'snapshot'],
                    properties: {
                        ok: { type: 'boolean', const: true },
                        billable: { type: 'boolean', const: false },
                        source: { type: 'string', const: 'in_process_channel_router' },
                        state_scope: { type: 'string', const: 'process_local' },
                        state_initialized: { type: 'boolean' },
                        snapshot: { $ref: '#/components/schemas/AgentChannelHealthSnapshot' }
                    },
                    additionalProperties: false
                },
                AgentChannelHealthSnapshot: {
                    type: 'object',
                    required: ['observed_at', 'channels'],
                    properties: {
                        observed_at: { type: 'integer', minimum: 0 },
                        channels: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/AgentChannelHealthChannel' }
                        }
                    },
                    additionalProperties: false
                },
                AgentChannelHealthChannel: {
                    type: 'object',
                    required: [
                        'channel_id',
                        'credential_count',
                        'healthy_credential_count',
                        'unhealthy_credential_count',
                        'state',
                        'probe_required',
                        'upstream_proxy',
                        'credentials'
                    ],
                    properties: {
                        channel_id: { type: 'string' },
                        upstream_proxy: { $ref: '#/components/schemas/UpstreamProxySummary' },
                        credential_count: { type: 'integer', minimum: 0 },
                        healthy_credential_count: { type: 'integer', minimum: 0 },
                        unhealthy_credential_count: { type: 'integer', minimum: 0 },
                        state: { type: 'string', enum: ['healthy', 'cooldown', 'probe_pending'] },
                        probe_required: { type: 'boolean' },
                        credentials: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/AgentChannelHealthCredential' }
                        }
                    },
                    additionalProperties: false
                },
                AgentChannelHealthCredential: {
                    type: 'object',
                    required: ['credential_id', 'state', 'probe_required', 'request_modes'],
                    properties: {
                        credential_id: { type: 'string' },
                        state: { type: 'string', enum: ['healthy', 'cooldown', 'probe_pending'] },
                        cooldown_until: { type: 'integer', minimum: 0 },
                        probe_required: { type: 'boolean' },
                        last_failure: { $ref: '#/components/schemas/AgentChannelHealthFailure' },
                        request_modes: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/AgentChannelHealthRequestMode' }
                        }
                    },
                    additionalProperties: false
                },
                AgentChannelHealthRequestMode: {
                    type: 'object',
                    required: ['mode', 'state', 'probe_required'],
                    properties: {
                        mode: { type: 'string', enum: CHANNEL_REQUEST_MODES },
                        state: { type: 'string', enum: ['healthy', 'cooldown', 'probe_pending'] },
                        cooldown_until: { type: 'integer', minimum: 0 },
                        probe_required: { type: 'boolean' }
                    },
                    additionalProperties: false
                },
                AgentChannelHealthFailure: {
                    type: 'object',
                    required: ['at', 'scope'],
                    properties: {
                        at: { type: 'integer', minimum: 0 },
                        scope: { type: 'string', enum: ['credential', 'channel'] },
                        status: { type: 'integer' },
                        code: { type: 'string' },
                        request_id: { type: 'string' },
                        request_mode: { type: 'string', enum: CHANNEL_REQUEST_MODES }
                    },
                    additionalProperties: false
                },
                AgentStreamingCapabilities: {
                    type: 'object',
                    required: ['generate', 'edit', 'upstream_sse', 'page_sse'],
                    properties: {
                        generate: { $ref: '#/components/schemas/AgentEndpointStreamingCapability' },
                        edit: { $ref: '#/components/schemas/AgentEndpointStreamingCapability' },
                        upstream_sse: {
                            type: 'object',
                            required: [
                                'supported',
                                'mode',
                                'endpoint',
                                'request_fields',
                                'request_fields_by_mode',
                                'image_backends',
                                'enabled_image_backends',
                                'streaming_strategies',
                                'stream_modes',
                                'activation_strategies',
                                'final_response_contract'
                            ],
                            properties: {
                                supported: { type: 'boolean', const: true },
                                mode: { type: 'string', enum: ['internal_upstream_sse'] },
                                endpoint: { type: 'string' },
                                request_fields: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    const: AGENT_UPSTREAM_SSE_GENERATE_REQUEST_FIELDS
                                },
                                request_fields_by_mode: {
                                    type: 'object',
                                    required: ['generate', 'edit'],
                                    properties: {
                                        generate: {
                                            type: 'array',
                                            items: { type: 'string' },
                                            const: AGENT_UPSTREAM_SSE_GENERATE_REQUEST_FIELDS
                                        },
                                        edit: {
                                            type: 'array',
                                            items: { type: 'string' },
                                            const: AGENT_UPSTREAM_SSE_EDIT_REQUEST_FIELDS
                                        }
                                    }
                                },
                                image_backends: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_IMAGE_BACKENDS }
                                },
                                enabled_image_backends: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_IMAGE_BACKENDS }
                                },
                                streaming_strategies: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_STREAMING_STRATEGIES }
                                },
                                stream_modes: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_STREAM_MODES }
                                },
                                activation_strategies: {
                                    type: 'array',
                                    items: { type: 'string', enum: AGENT_UPSTREAM_SSE_ACTIVATION_STRATEGIES }
                                },
                                final_response_contract: { type: 'string', enum: ['AgentImageResponse'] }
                            }
                        },
                        page_sse: {
                            type: 'object',
                            required: [
                                'supported',
                                'mode',
                                'endpoint',
                                'contract',
                                'transport_contract',
                                'auth',
                                'client_request_id',
                                'agent_usage'
                            ],
                            properties: {
                                supported: { type: 'boolean', const: true },
                                mode: { type: 'string', enum: ['form_data_sse'] },
                                endpoint: { type: 'string' },
                                contract: { type: 'string', enum: ['page_ui_only'] },
                                transport_contract: { type: 'string', enum: ['page_form_data_sse'] },
                                auth: {
                                    type: 'object',
                                    required: ['required', 'schemes', 'form_field'],
                                    properties: {
                                        required: {
                                            type: 'boolean',
                                            const: capabilities.agent_streaming.page_sse.auth.required
                                        },
                                        schemes: {
                                            type: 'array',
                                            items: { type: 'string', enum: ['form-password-hash'] },
                                            const: capabilities.agent_streaming.page_sse.auth.schemes
                                        },
                                        form_field: { type: 'string', const: 'passwordHash' }
                                    }
                                },
                                client_request_id: {
                                    type: 'object',
                                    required: ['form_field', 'source_header', 'max_length'],
                                    properties: {
                                        form_field: { type: 'string', const: 'clientRequestId' },
                                        source_header: { type: 'string', const: 'Idempotency-Key' },
                                        max_length: {
                                            type: 'integer',
                                            const: capabilities.agent_streaming.page_sse.client_request_id.max_length
                                        }
                                    }
                                },
                                agent_usage: {
                                    type: 'string',
                                    enum: [AGENT_PAGE_SSE_AGENT_USAGE]
                                }
                            }
                        }
                    }
                },
                AgentRoutingRules: {
                    type: 'object',
                    required: [
                        'high_resolution_edit',
                        'complex_ui_batch',
                        'long_image_recovery',
                        'agent_generate_small_smoke',
                        'page_sse_generate_diagnostics',
                        'retry_recovery'
                    ],
                    properties: {
                        high_resolution_edit: { $ref: '#/components/schemas/AgentRoutingRule' },
                        complex_ui_batch: { $ref: '#/components/schemas/AgentRoutingRule' },
                        long_image_recovery: { $ref: '#/components/schemas/AgentRoutingRule' },
                        agent_generate_small_smoke: { $ref: '#/components/schemas/AgentRoutingRule' },
                        page_sse_generate_diagnostics: { $ref: '#/components/schemas/AgentRoutingRule' },
                        retry_recovery: {
                            type: 'object',
                            required: ['reuse_failed_idempotency_key', 'new_attempt_guidance'],
                            properties: {
                                reuse_failed_idempotency_key: { type: 'boolean', const: false },
                                new_attempt_guidance: { type: 'string' }
                            }
                        }
                    }
                },
                AgentRoutingRule: {
                    type: 'object',
                    required: ['when', 'conditions', 'endpoint', 'transport', 'strength', 'action', 'reason'],
                    properties: {
                        when: { type: 'array', items: { type: 'string' } },
                        conditions: { $ref: '#/components/schemas/AgentRoutingCondition' },
                        endpoint: { type: 'string' },
                        transport: {
                            type: 'string',
                            enum: ['agent_json', 'agent_job_polling', 'page_sse'] satisfies AgentRoutingTransport[]
                        },
                        strength: {
                            type: 'string',
                            enum: ['default', 'recommended', 'explicit'] satisfies AgentRoutingStrength[]
                        },
                        action: { $ref: '#/components/schemas/AgentRoutingAction' },
                        reason: { type: 'string' }
                    }
                },
                AgentRoutingCondition: {
                    type: 'object',
                    required: ['operation'],
                    properties: {
                        operation: {
                            type: 'string',
                            enum: ['generate', 'edit', 'generate_or_edit']
                        },
                        max_edge: {
                            type: 'object',
                            required: ['operator', 'value'],
                            properties: {
                                operator: { type: 'string', enum: ['gt', 'lte'] },
                                value: { type: 'integer', minimum: 1 }
                            }
                        },
                        batch: { type: 'boolean' },
                        single_request: { type: 'boolean' },
                        explicit_page_sse: { type: 'boolean' },
                        complex_ui: { type: 'boolean' },
                        long_image: { type: 'boolean' },
                        resume_or_recover: { type: 'boolean' }
                    },
                    additionalProperties: false
                },
                AgentRoutingAction: {
                    type: 'object',
                    required: [
                        'endpoint',
                        'transport',
                        'strength',
                        'requires_new_idempotency_key_on_retry',
                        'no_automatic_fallback'
                    ],
                    properties: {
                        endpoint: { type: 'string' },
                        transport: {
                            type: 'string',
                            enum: ['agent_json', 'agent_job_polling', 'page_sse'] satisfies AgentRoutingTransport[]
                        },
                        strength: {
                            type: 'string',
                            enum: ['default', 'recommended', 'explicit'] satisfies AgentRoutingStrength[]
                        },
                        fallback_endpoint: { type: 'string' },
                        fallback_mode: {
                            type: 'string',
                            enum: ['manual_after_diagnosis', 'fix_request_before_retry']
                        },
                        requires_new_idempotency_key_on_retry: { type: 'boolean' },
                        no_automatic_fallback: { type: 'boolean' }
                    },
                    additionalProperties: false
                },
                AgentEndpointStreamingCapability: {
                    type: 'object',
                    required: ['supported', 'mode', 'endpoint'],
                    properties: {
                        supported: { type: 'boolean', const: false },
                        mode: { type: 'string', enum: ['non_streaming_only'] },
                        endpoint: { type: 'string' }
                    }
                },
                AgentJobCapabilities: {
                    type: 'object',
                    required: ['supported', 'mode', 'intended_for', 'endpoints', 'states', 'current_guidance'],
                    properties: {
                        supported: { type: 'boolean', const: true },
                        mode: { type: 'string', enum: ['job_polling'] },
                        intended_for: { type: 'array', items: { type: 'string' } },
                        endpoints: {
                            type: 'object',
                            required: ['create_generate_job', 'get_job', 'get_job_result'],
                            properties: {
                                create_generate_job: { type: 'string' },
                                get_job: { type: 'string' },
                                get_job_result: { type: 'string' }
                            }
                        },
                        states: { type: 'array', items: { type: 'string', enum: AGENT_JOB_STATES } },
                        current_guidance: { type: 'string' }
                    }
                },
                AgentOrchestrationCapabilities: {
                    type: 'object',
                    required: [
                        'supported',
                        'policy',
                        'endpoint',
                        'client_contract',
                        'transport_selection',
                        'result_mode',
                        'hidden_controls',
                        'diagnostics',
                        'current_guidance'
                    ],
                    properties: {
                        supported: { type: 'boolean', const: true },
                        policy: {
                            type: 'string',
                            enum: ['server_orchestrated_generate_v1']
                        },
                        endpoint: { type: 'string', const: AGENT_ENDPOINTS.create_image_request },
                        client_contract: { type: 'string', enum: ['intent_only'] },
                        transport_selection: { type: 'string', enum: ['server_owned'] },
                        result_mode: { type: 'string', enum: ['job_polling'] },
                        hidden_controls: { type: 'array', items: { type: 'string' } },
                        diagnostics: {
                            type: 'object',
                            required: ['job_result', 'request_lookup'],
                            properties: {
                                job_result: { type: 'string', const: AGENT_ENDPOINTS.job_result },
                                request_lookup: {
                                    type: 'string',
                                    const: AGENT_ENDPOINTS.agent_request_diagnostics_lookup
                                }
                            },
                            additionalProperties: false
                        },
                        current_guidance: { type: 'string' }
                    },
                    additionalProperties: false
                },
                GenerateRequest: {
                    type: 'object',
                    required: ['prompt'],
                    allOf: [
                        {
                            if: {
                                properties: {
                                    image_backend: { const: 'responses-image-generation' }
                                },
                                required: ['image_backend']
                            },
                            then: {
                                properties: {
                                    n: {
                                        type: 'integer',
                                        minimum:
                                            capabilities.limits.generate_images_by_backend['responses-image-generation']
                                                .min,
                                        maximum:
                                            capabilities.limits.generate_images_by_backend['responses-image-generation']
                                                .max,
                                        ...(capabilities.limits.generate_images_by_backend['responses-image-generation']
                                            .allowedValues
                                            ? {
                                                  enum: [
                                                      ...capabilities.limits.generate_images_by_backend[
                                                          'responses-image-generation'
                                                      ].allowedValues
                                                  ]
                                              }
                                            : {}),
                                        default:
                                            capabilities.limits.generate_images_by_backend['responses-image-generation']
                                                .min
                                    }
                                },
                                allOf: [
                                    {
                                        if: responsesNonStreamPartialImagesCondition,
                                        then: {
                                            properties: {
                                                partial_images: {
                                                    type: 'integer',
                                                    minimum: nonStreamPartialImagesSchemaRange.min,
                                                    maximum: nonStreamPartialImagesSchemaRange.max,
                                                    default: capabilities.defaults.partial_images
                                                }
                                            }
                                        }
                                    },
                                    {
                                        if: {
                                            not: responsesNonStreamPartialImagesCondition
                                        },
                                        then: {
                                            properties: {
                                                partial_images: {
                                                    type: 'integer',
                                                    minimum:
                                                        capabilities.limits.partial_images_by_backend[
                                                            'responses-image-generation'
                                                        ].min,
                                                    maximum:
                                                        capabilities.limits.partial_images_by_backend[
                                                            'responses-image-generation'
                                                        ].max,
                                                    ...(capabilities.limits.partial_images_by_backend[
                                                        'responses-image-generation'
                                                    ].allowedValues
                                                        ? {
                                                              enum: [
                                                                  ...capabilities.limits.partial_images_by_backend[
                                                                      'responses-image-generation'
                                                                  ].allowedValues
                                                              ]
                                                          }
                                                        : {}),
                                                    default: capabilities.defaults.partial_images
                                                }
                                            }
                                        }
                                    }
                                ]
                            }
                        },
                        {
                            if: {
                                not: {
                                    properties: {
                                        force_request: { const: true }
                                    },
                                    required: ['force_request']
                                }
                            },
                            then: {
                                properties: {
                                    background: { type: 'string', enum: supportedBackgrounds }
                                }
                            }
                        },
                        {
                            if: {
                                allOf: [
                                    {
                                        not: {
                                            properties: {
                                                image_backend: { const: 'responses-image-generation' }
                                            },
                                            required: ['image_backend']
                                        }
                                    },
                                    { not: imagesNonStreamPartialImagesCondition }
                                ]
                            },
                            then: {
                                properties: {
                                    partial_images: {
                                        type: 'integer',
                                        minimum: capabilities.limits.partial_images.min,
                                        maximum: capabilities.limits.partial_images.max,
                                        ...(capabilities.limits.partial_images.allowedValues
                                            ? { enum: [...capabilities.limits.partial_images.allowedValues] }
                                            : {}),
                                        default: capabilities.defaults.partial_images
                                    }
                                }
                            }
                        }
                    ],
                    properties: {
                        prompt: { type: 'string', maxLength: MAX_PROMPT_LENGTH },
                        model: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 200,
                            default: capabilities.defaults.model
                        },
                        n: {
                            type: 'integer',
                            minimum: capabilities.limits.generate_images.min,
                            maximum: maxGenerateImageCount,
                            ...(capabilities.limits.generate_images.allowedValues
                                ? { enum: [...capabilities.limits.generate_images.allowedValues] }
                                : {})
                        },
                        size: { type: 'string' },
                        quality: { type: 'string', enum: AGENT_QUALITIES, default: 'high' },
                        output_format: { type: 'string', enum: AGENT_OUTPUT_FORMATS },
                        output_compression: { type: 'integer', minimum: 0, maximum: 100 },
                        background: { type: 'string', enum: AGENT_BACKGROUNDS },
                        moderation: { type: 'string', enum: AGENT_MODERATIONS },
                        response_mode: { type: 'string', enum: AGENT_RESPONSE_MODES, default: 'path' },
                        image_backend: {
                            type: 'string',
                            enum: AGENT_IMAGE_BACKENDS,
                            default: 'images-api'
                        },
                        responsesModel: {
                            type: 'string',
                            maxLength: MAX_MODEL_NAME_LENGTH,
                            description:
                                'Responses image_generation 顶层模型；仅适用于 image_backend=responses-image-generation。'
                        },
                        thinking: {
                            type: 'string',
                            enum: ['minimal', 'none', 'low', 'medium', 'high', 'xhigh']
                        },
                        promptOptimization: { type: 'boolean' },
                        force_web: { type: 'boolean' },
                        force_request: {
                            type: 'boolean',
                            description:
                                '显式强制请求上游，跳过本服务本地 upstream profile 尺寸/背景限制；鉴权、幂等键、渠道白名单和安全校验仍然生效。'
                        },
                        streaming_strategy: {
                            type: 'string',
                            enum: AGENT_STREAMING_STRATEGIES,
                            default: 'auto'
                        },
                        stream_mode: {
                            type: 'string',
                            enum: AGENT_STREAM_MODES,
                            default: 'auto'
                        },
                        partial_images: {
                            type: 'integer',
                            minimum: nonStreamPartialImagesSchemaRange.min,
                            maximum: nonStreamPartialImagesSchemaRange.max,
                            default: capabilities.defaults.partial_images
                        }
                    }
                },
                EditRequest: {
                    type: 'object',
                    required: ['prompt'],
                    anyOf: Array.from({ length: maxSourceImageCount }, (_, index) => ({
                        required: [`image_${index}`]
                    })),
                    allOf: [
                        {
                            if: { not: imagesNonStreamPartialImagesCondition },
                            then: {
                                properties: {
                                    partial_images: {
                                        type: 'integer',
                                        minimum: capabilities.limits.partial_images.min,
                                        maximum: capabilities.limits.partial_images.max,
                                        ...(capabilities.limits.partial_images.allowedValues
                                            ? { enum: [...capabilities.limits.partial_images.allowedValues] }
                                            : {}),
                                        default: capabilities.defaults.partial_images
                                    }
                                }
                            }
                        }
                    ],
                    description: `Agent edit 返回最终 JSON。请求必须至少提供一个 image_0..image_${maxSourceImageCount - 1} 源图字段。高分辨率 edit 默认优先使用页面端 /api/images form-data SSE；页面流式有问题时可显式回退到 Agent edit 诊断或执行。`,
                    properties: {
                        prompt: { type: 'string', maxLength: MAX_PROMPT_LENGTH },
                        model: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 200,
                            default: capabilities.defaults.model
                        },
                        n: {
                            type: 'integer',
                            minimum: capabilities.limits.edit_images.min,
                            maximum: maxEditImageCount,
                            ...(capabilities.limits.edit_images.allowedValues
                                ? { enum: [...capabilities.limits.edit_images.allowedValues] }
                                : {})
                        },
                        size: { type: 'string', default: 'auto' },
                        quality: { type: 'string', enum: AGENT_QUALITIES, default: 'auto' },
                        response_mode: { type: 'string', enum: AGENT_RESPONSE_MODES, default: 'path' },
                        stream_mode: { type: 'string', enum: AGENT_STREAM_MODES, default: 'auto' },
                        streaming_strategy: {
                            type: 'string',
                            enum: AGENT_STREAMING_STRATEGIES,
                            default: 'auto'
                        },
                        force_request: {
                            type: 'boolean',
                            description:
                                '显式强制请求上游，跳过本服务本地 upstream profile 尺寸限制；鉴权、幂等键、渠道白名单、图片数量、partial_images、文件大小和 mask 校验仍然生效。'
                        },
                        partial_images: {
                            type: 'integer',
                            minimum: nonStreamPartialImagesSchemaRange.min,
                            maximum: nonStreamPartialImagesSchemaRange.max,
                            default: capabilities.defaults.partial_images
                        },
                        ...Object.fromEntries(
                            Array.from({ length: maxSourceImageCount }, (_, index) => [
                                `image_${index}`,
                                { type: 'string', format: 'binary' }
                            ])
                        ),
                        mask: { type: 'string', format: 'binary' }
                    }
                },
                AgentArtifact: {
                    type: 'object',
                    required: [
                        'id',
                        'filename',
                        'content_url',
                        'metadata_url',
                        'output_format',
                        'mime_type',
                        'size_bytes',
                        'width',
                        'height'
                    ],
                    properties: {
                        id: { type: 'string' },
                        filename: { type: 'string' },
                        content_url: { type: 'string' },
                        metadata_url: { type: 'string' },
                        output_format: { type: 'string', enum: AGENT_OUTPUT_FORMATS },
                        mime_type: { type: 'string' },
                        size_bytes: { type: 'integer', minimum: 0 },
                        width: { type: ['integer', 'null'] },
                        height: { type: ['integer', 'null'] },
                        b64_json: { type: 'string' }
                    }
                },
                AgentImageResponse: {
                    type: 'object',
                    required: ['request_id', 'idempotency_key', 'cached', 'images', 'created_at'],
                    properties: {
                        request_id: { type: 'string' },
                        idempotency_key: { type: 'string' },
                        cached: { type: 'boolean' },
                        images: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/AgentArtifact' }
                        },
                        usage: { type: 'object' },
                        created_at: { type: 'string', format: 'date-time' },
                        timing: { $ref: '#/components/schemas/AgentImageResponseTiming' },
                        execution: { $ref: '#/components/schemas/AgentImageResponseExecution' }
                    }
                },
                AgentImageResponseTiming: {
                    type: 'object',
                    required: ['started_at', 'completed_at', 'elapsed_ms', 'server_elapsed_ms'],
                    properties: {
                        started_at: { type: 'string', format: 'date-time' },
                        completed_at: { type: 'string', format: 'date-time' },
                        elapsed_ms: { type: 'integer', minimum: 0 },
                        server_elapsed_ms: { type: 'integer', minimum: 0 }
                    },
                    additionalProperties: false
                },
                ChannelRequestModeDecision: {
                    type: 'object',
                    required: ['requested_backend', 'fallback_applied'],
                    properties: {
                        requested_backend: { type: 'string', enum: AGENT_IMAGE_BACKENDS },
                        candidate_channel_request_modes: {
                            type: 'array',
                            items: { type: 'string', enum: CHANNEL_REQUEST_MODES }
                        },
                        request_mode_priority: {
                            type: 'array',
                            items: { type: 'string', enum: CHANNEL_REQUEST_MODES }
                        },
                        preferred_channel_request_mode: { type: 'string', enum: CHANNEL_REQUEST_MODES },
                        fallback_channel_request_mode: { type: 'string', enum: CHANNEL_REQUEST_MODES },
                        selected_channel_request_mode: { type: 'string', enum: CHANNEL_REQUEST_MODES },
                        fallback_applied: { type: 'boolean' },
                        selected_channel_id: { type: 'string' },
                        upstream_host: { type: 'string' },
                        no_channel_reason: { type: 'string' }
                    },
                    additionalProperties: false
                },
                AgentImageResponseExecution: {
                    type: 'object',
                    required: [
                        'transport',
                        'endpoint',
                        'route_mode',
                        'operation',
                        'image_backend',
                        'stream_mode',
                        'streaming_strategy',
                        'channel_request_mode_fallback_applied',
                        'route_decision',
                        'request_headers'
                    ],
                    properties: {
                        transport: { type: 'string', enum: ['agent_json', 'agent_job_polling', 'page_sse'] },
                        endpoint: { type: 'string' },
                        route_mode: { type: 'string', enum: ['agent', 'job', 'page_sse'] },
                        operation: { type: 'string', enum: ['generate', 'edit'] },
                        image_backend: { type: 'string', enum: AGENT_IMAGE_BACKENDS },
                        stream_mode: { type: 'string', enum: AGENT_STREAM_MODES },
                        streaming_strategy: { type: 'string', enum: AGENT_STREAMING_STRATEGIES },
                        channel_request_mode: { type: 'string', enum: CHANNEL_REQUEST_MODES },
                        channel_request_mode_fallback_applied: { type: 'boolean' },
                        route_decision: { $ref: '#/components/schemas/ChannelRequestModeDecision' },
                        selected_channel_id: { type: 'string' },
                        upstream_host: { type: 'string' },
                        request_headers: { $ref: '#/components/schemas/UpstreamRequestHeaderSummary' }
                    },
                    additionalProperties: false
                },
                AgentJobStatusResponse: {
                    type: 'object',
                    required: ['job'],
                    properties: {
                        job: {
                            type: 'object',
                            required: [
                                'id',
                                'request_id',
                                'idempotency_key',
                                'mode',
                                'state',
                                'created_at',
                                'updated_at',
                                'expires_at'
                            ],
                            properties: {
                                id: { type: 'string' },
                                request_id: { type: 'string' },
                                idempotency_key: { type: 'string' },
                                mode: { type: 'string', enum: ['generate', 'edit'] },
                                state: { type: 'string', enum: AGENT_JOB_STATES },
                                created_at: { type: 'string', format: 'date-time' },
                                updated_at: { type: 'string', format: 'date-time' },
                                expires_at: { type: 'string', format: 'date-time' },
                                result_url: { type: 'string' },
                                retry_after_seconds: { type: 'integer', minimum: 1 },
                                error: {
                                    type: 'object',
                                    required: ['code', 'message', 'retryable'],
                                    properties: {
                                        code: { type: 'string' },
                                        message: { type: 'string' },
                                        retryable: { type: 'boolean' },
                                        retry_after_seconds: { type: 'integer', minimum: 1 },
                                        details: { type: 'object' },
                                        upstream_status: { type: 'integer' },
                                        diagnostics: { $ref: '#/components/schemas/AgentErrorDiagnostics' }
                                    }
                                }
                            }
                        }
                    }
                },
                ArtifactMetadataResponse: {
                    type: 'object',
                    required: ['artifact'],
                    properties: {
                        artifact: { $ref: '#/components/schemas/AgentArtifact' }
                    }
                },
                CreateArtifactShareRequest: {
                    type: 'object',
                    properties: {
                        expires_in_minutes: {
                            oneOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }],
                            description: '分享有效期分钟数；null 表示不过期，省略时使用服务端默认值。'
                        },
                        access_code: {
                            anyOf: [
                                { type: 'string', pattern: '^\\s*$' },
                                { type: 'string', minLength: 8, maxLength: 128 }
                            ],
                            description: '可选访问码；省略或空白字符串表示公开分享。'
                        }
                    },
                    additionalProperties: false
                },
                ArtifactShareResponse: {
                    type: 'object',
                    required: [
                        'artifact_id',
                        'token',
                        'share_url',
                        'direct_content_url',
                        'expires_at',
                        'access_code_required'
                    ],
                    properties: {
                        artifact_id: { type: 'string' },
                        token: { type: 'string', pattern: '^[a-f0-9]{24}$' },
                        share_url: { type: 'string' },
                        direct_content_url: { type: 'string' },
                        expires_at: {
                            oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }]
                        },
                        access_code_required: { type: 'boolean' }
                    },
                    additionalProperties: false
                },
                DeleteArtifactResponse: {
                    type: 'object',
                    required: ['deleted', 'id'],
                    properties: {
                        deleted: { type: 'boolean' },
                        id: { type: 'string' }
                    }
                },
                ResultFeedback: {
                    type: 'object',
                    required: ['target_type', 'target_id', 'value', 'source', 'updated_at'],
                    properties: {
                        target_type: { type: 'string', enum: ['page_request', 'agent_request', 'agent_artifact'] },
                        target_id: { type: 'string' },
                        value: { type: 'string', enum: ['usable', 'needs_revision'] },
                        source: { type: 'string', enum: ['webui', 'agent'] },
                        updated_at: { type: 'string', format: 'date-time' },
                        note: { type: 'string', maxLength: 500 }
                    }
                },
                FeedbackTarget: {
                    type: 'object',
                    required: ['type', 'id'],
                    properties: {
                        type: { type: 'string', enum: ['page_request'] },
                        id: { type: 'string' }
                    }
                },
                PageRequestFeedbackBatchRequest: {
                    type: 'object',
                    required: ['ids'],
                    properties: {
                        ids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } }
                    }
                },
                PageRequestFeedbackBatchResponse: {
                    type: 'object',
                    required: ['targets', 'feedback'],
                    properties: {
                        targets: { type: 'array', items: { $ref: '#/components/schemas/FeedbackTarget' } },
                        feedback: { type: 'array', items: { $ref: '#/components/schemas/ResultFeedback' } }
                    }
                },
                PageRequestFeedbackResponse: {
                    type: 'object',
                    required: ['target', 'feedback'],
                    properties: {
                        target: { $ref: '#/components/schemas/FeedbackTarget' },
                        feedback: {
                            oneOf: [{ $ref: '#/components/schemas/ResultFeedback' }, { type: 'null' }]
                        }
                    }
                },
                PageRequestDiagnosticsBatchRequest: {
                    type: 'object',
                    required: ['ids'],
                    properties: {
                        ids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
                        filenames: { type: 'array', maxItems: 20, items: { type: 'string' } }
                    }
                },
                AgentRequestDiagnosticsLookupResponse: {
                    type: 'object',
                    required: ['found'],
                    properties: {
                        found: { type: 'boolean' },
                        diagnostics: { $ref: '#/components/schemas/AgentRequestDiagnostics' }
                    },
                    additionalProperties: false
                },
                AgentRequestDiagnostics: {
                    type: 'object',
                    required: [
                        'request',
                        'timeline',
                        'artifacts',
                        'state_backend',
                        'diagnostics_retention',
                        'diagnostics_boundary'
                    ],
                    properties: {
                        request: { $ref: '#/components/schemas/AgentRequestDiagnosticsRequest' },
                        timeline: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/AgentRequestTimelineEvent' }
                        },
                        artifacts: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/AgentRequestDiagnosticsArtifact' }
                        },
                        response: { $ref: '#/components/schemas/AgentRequestDiagnosticsResponseSummary' },
                        error: { $ref: '#/components/schemas/AgentRequestDiagnosticsErrorSummary' },
                        feedback: { $ref: '#/components/schemas/ResultFeedback' },
                        state_backend: { type: 'string', enum: ['memory', 'sqlite', 'postgres'] },
                        diagnostics_retention: { $ref: '#/components/schemas/AgentRequestDiagnosticsRetention' },
                        diagnostics_boundary: {
                            type: 'object',
                            required: [
                                'source',
                                'not_page_request_log',
                                'raw_request_json_redacted',
                                'api_key_redacted'
                            ],
                            properties: {
                                source: { type: 'string', enum: ['agent_state'] },
                                not_page_request_log: { type: 'boolean', const: true },
                                raw_request_json_redacted: { type: 'boolean', const: true },
                                api_key_redacted: { type: 'boolean', const: true }
                            },
                            additionalProperties: false
                        }
                    },
                    additionalProperties: false
                },
                AgentRequestDiagnosticsRequest: {
                    type: 'object',
                    required: [
                        'request_id',
                        'idempotency_key',
                        'mode',
                        'status',
                        'cached',
                        'created_at',
                        'updated_at',
                        'expires_at'
                    ],
                    properties: {
                        request_id: { type: 'string' },
                        idempotency_key: { type: 'string' },
                        mode: { type: 'string', enum: ['generate', 'edit'] },
                        status: { type: 'string', enum: ['pending', 'running', 'succeeded', 'failed', 'orphaned'] },
                        cached: { type: 'boolean' },
                        created_at: { type: 'string', format: 'date-time' },
                        updated_at: { type: 'string', format: 'date-time' },
                        expires_at: { type: 'string', format: 'date-time' },
                        locked_until: { type: 'string', format: 'date-time' }
                    },
                    additionalProperties: false
                },
                AgentRequestTimelineEvent: {
                    type: 'object',
                    required: ['at', 'event'],
                    properties: {
                        at: { type: 'string', format: 'date-time' },
                        event: { type: 'string', enum: ['created', 'updated', 'locked_until', 'expires'] }
                    },
                    additionalProperties: false
                },
                AgentRequestDiagnosticsArtifact: {
                    type: 'object',
                    required: [
                        'id',
                        'filename',
                        'content_url',
                        'metadata_url',
                        'output_format',
                        'mime_type',
                        'size_bytes',
                        'width',
                        'height',
                        'model',
                        'created_at'
                    ],
                    properties: {
                        id: { type: 'string' },
                        filename: { type: 'string' },
                        content_url: { type: 'string' },
                        metadata_url: { type: 'string' },
                        output_format: { type: 'string' },
                        mime_type: { type: 'string' },
                        size_bytes: { type: 'integer', minimum: 0 },
                        width: { type: ['integer', 'null'] },
                        height: { type: ['integer', 'null'] },
                        model: { type: 'string' },
                        created_at: { type: 'string', format: 'date-time' }
                    },
                    additionalProperties: false
                },
                AgentRequestDiagnosticsResponseSummary: {
                    type: 'object',
                    required: [
                        'request_id',
                        'idempotency_key',
                        'cached',
                        'image_count',
                        'artifact_ids',
                        'content_urls',
                        'created_at'
                    ],
                    properties: {
                        request_id: { type: 'string' },
                        idempotency_key: { type: 'string' },
                        cached: { type: 'boolean' },
                        image_count: { type: 'integer', minimum: 0 },
                        artifact_ids: { type: 'array', items: { type: 'string' } },
                        content_urls: { type: 'array', items: { type: 'string' } },
                        created_at: { type: 'string', format: 'date-time' },
                        timing: { $ref: '#/components/schemas/AgentImageResponseTiming' },
                        execution: { $ref: '#/components/schemas/AgentImageResponseExecution' }
                    },
                    additionalProperties: false
                },
                AgentRequestDiagnosticsErrorSummary: {
                    type: 'object',
                    required: ['code', 'message', 'retryable'],
                    properties: {
                        code: { type: 'string' },
                        message: { type: 'string' },
                        retryable: { type: 'boolean' },
                        upstream_status: { type: 'integer' },
                        diagnostics: { $ref: '#/components/schemas/AgentErrorDiagnostics' }
                    },
                    additionalProperties: false
                },
                PageRequestDiagnosticsBatchItem: {
                    allOf: [
                        { $ref: '#/components/schemas/PageRequestDiagnosticsResponse' },
                        {
                            type: 'object',
                            required: ['client_request_id'],
                            properties: {
                                client_request_id: { type: 'string' }
                            }
                        }
                    ]
                },
                PageRequestDiagnosticsBatchResponse: {
                    type: 'object',
                    required: ['targets', 'diagnostics_retention', 'diagnostics'],
                    properties: {
                        targets: { type: 'array', items: { $ref: '#/components/schemas/FeedbackTarget' } },
                        diagnostics_retention: { $ref: '#/components/schemas/AppLogRetentionMetadata' },
                        diagnostics: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/PageRequestDiagnosticsBatchItem' }
                        }
                    }
                },
                PageRequestDiagnosticsResponse: {
                    type: 'object',
                    required: ['scope', 'matched_log_count', 'events', 'diagnostics_retention'],
                    properties: {
                        scope: {
                            type: 'object',
                            required: ['request_ids', 'filenames', 'filename_matched_request_ids', 'copy_text'],
                            properties: {
                                request_ids: { type: 'array', items: { type: 'string' } },
                                filenames: { type: 'array', items: { type: 'string' } },
                                filename_matched_request_ids: { type: 'array', items: { type: 'string' } },
                                copy_text: { type: 'string' }
                            }
                        },
                        matched_log_count: { type: 'integer', minimum: 0 },
                        events: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/PageRequestDiagnosticEvent' }
                        },
                        diagnostics_retention: { $ref: '#/components/schemas/AppLogRetentionMetadata' },
                        diagnostics_note: { $ref: '#/components/schemas/PageRequestDiagnosticsNote' }
                    }
                },
                PageRequestDiagnosticsNote: {
                    type: 'object',
                    required: ['code', 'message', 'retention'],
                    properties: {
                        code: { type: 'string', enum: ['no_matching_logs_in_retention_window'] },
                        message: { type: 'string' },
                        retention: { $ref: '#/components/schemas/AppLogRetentionMetadata' }
                    }
                },
                PageRequestDiagnosticEvent: {
                    type: 'object',
                    required: ['id', 'at', 'level', 'message'],
                    properties: {
                        id: { type: 'integer' },
                        at: { type: 'string', format: 'date-time' },
                        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
                        message: { type: 'string' },
                        client_request_id: { type: 'string' },
                        filenames: { type: 'array', items: { type: 'string' } },
                        diagnostics: { $ref: '#/components/schemas/PageRequestDiagnosticContext' }
                    }
                },
                PageRequestDiagnosticContext: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        providerDialect: { type: 'string' },
                        normalizedEventCount: { type: 'number' },
                        reason: { type: 'string' },
                        channel_id: { type: 'string' },
                        image_backend: { type: 'string' },
                        operation: { type: 'string' },
                        stream_mode: { type: 'string' },
                        streamingStrategy: { type: 'string' },
                        streaming_strategy: { type: 'string' },
                        partialImages: { type: 'number' },
                        partial_images: { type: 'number' },
                        upstream_status: { type: 'number' },
                        upstream_event_type: { type: 'string' },
                        transport_error: { type: 'boolean' }
                    }
                },
                AgentError: {
                    type: 'object',
                    required: ['error'],
                    properties: {
                        error: {
                            type: 'object',
                            required: ['code', 'message', 'retryable', 'request_id'],
                            properties: {
                                code: { type: 'string' },
                                message: { type: 'string' },
                                retryable: { type: 'boolean' },
                                retry_after_seconds: { type: 'integer', minimum: 1 },
                                details: { type: 'object' },
                                upstream_status: { type: 'integer' },
                                diagnostics: { $ref: '#/components/schemas/AgentErrorDiagnostics' },
                                request_id: { type: 'string' }
                            }
                        }
                    }
                },
                AgentErrorDiagnostics: {
                    type: 'object',
                    properties: {
                        elapsed_ms: { type: 'integer', minimum: 0 },
                        channel_request_mode: { type: 'string', enum: CHANNEL_REQUEST_MODES },
                        channel_request_mode_fallback_applied: { type: 'boolean' },
                        route_decision: { $ref: '#/components/schemas/ChannelRequestModeDecision' },
                        selected_channel_id: { type: 'string' },
                        upstream_host: { type: 'string' },
                        upstream_status: { type: 'integer' },
                        upstream_event_type: { type: 'string' },
                        partial_image_count: { type: 'integer', minimum: 0 },
                        transport_error: { type: 'boolean' },
                        transport_error_kind: {
                            type: 'string',
                            enum: [
                                'dns',
                                'tls',
                                'connect_timeout',
                                'connection_refused',
                                'socket_closed',
                                'upstream_timeout',
                                'sse_final_missing',
                                'fetch_failed',
                                'unknown_transport'
                            ]
                        },
                        retry_after_seconds: { type: 'integer', minimum: 1 },
                        retry_after_ms: { type: 'integer', minimum: 0 },
                        cooldown_until: { type: 'string', format: 'date-time' },
                        cooldown_target: {
                            type: 'object',
                            required: ['channel_id'],
                            properties: {
                                channel_id: { type: 'string' },
                                credential_id: { type: 'string' },
                                request_mode: { type: 'string', enum: CHANNEL_REQUEST_MODES }
                            },
                            additionalProperties: false
                        },
                        channel_cooldown_scope: { type: 'string', enum: ['credential', 'channel'] },
                        response_headers: {
                            type: 'object',
                            additionalProperties: { type: 'string' }
                        }
                    },
                    additionalProperties: false
                },
                UpstreamRequestHeaderSummary: {
                    type: 'object',
                    required: [
                        'user_agent_effective',
                        'has_extra_headers',
                        'allowed_header_names',
                        'configured_header_names'
                    ],
                    properties: {
                        user_agent_effective: { type: 'string' },
                        has_extra_headers: { type: 'boolean' },
                        allowed_header_names: {
                            type: 'array',
                            items: { type: 'string' }
                        },
                        configured_header_names: {
                            type: 'array',
                            items: { type: 'string' }
                        }
                    },
                    additionalProperties: false
                },
                AgentRequestModeControls: {
                    type: 'object',
                    required: [
                        'source',
                        'global_env',
                        'channel_env_pattern',
                        'global_priority_env',
                        'channel_priority_env_pattern',
                        'default_priority',
                        'default_priority_policy',
                        'mutable_at_runtime',
                        'agent_client_policy',
                        'final_gate_command',
                        'smoke_gate_commands'
                    ],
                    properties: {
                        source: { type: 'string', const: 'admin_env_whitelist' },
                        global_env: { type: 'string' },
                        channel_env_pattern: { type: 'string' },
                        global_priority_env: { type: 'string' },
                        channel_priority_env_pattern: { type: 'string' },
                        default_priority: {
                            type: 'array',
                            items: { type: 'string', enum: CHANNEL_REQUEST_MODES }
                        },
                        default_priority_policy: { type: 'string', const: 'lowest_cost_first' },
                        mutable_at_runtime: { type: 'boolean', const: false },
                        agent_client_policy: { type: 'string', const: 'diagnostics_only' },
                        final_gate_command: { type: 'string' },
                        smoke_gate_commands: {
                            type: 'object',
                            additionalProperties: {
                                type: 'array',
                                items: { type: 'string' }
                            }
                        }
                    },
                    additionalProperties: false
                },
                ImageTransportCapabilities: {
                    type: 'object',
                    required: [
                        'upstream_timeout_ms',
                        'stream_data_interval_timeout_ms',
                        'upstream_max_retries',
                        'upstream_proxy',
                        'tun_mode'
                    ],
                    properties: {
                        upstream_timeout_ms: {
                            type: 'integer',
                            minimum: 1,
                            const: capabilities.image_transport.upstream_timeout_ms
                        },
                        stream_data_interval_timeout_ms: {
                            type: 'integer',
                            minimum: 0,
                            const: capabilities.image_transport.stream_data_interval_timeout_ms
                        },
                        upstream_max_retries: {
                            type: 'integer',
                            minimum: 0,
                            const: capabilities.image_transport.upstream_max_retries
                        },
                        upstream_proxy: {
                            $ref: '#/components/schemas/UpstreamProxySummary'
                        },
                        tun_mode: {
                            type: 'string',
                            enum: ['disabled', 'synthetic-dns'],
                            const: capabilities.image_transport.tun_mode
                        }
                    },
                    additionalProperties: false
                },
                UpstreamProxySummary: {
                    type: 'object',
                    required: ['configured'],
                    properties: {
                        configured: { type: 'boolean' },
                        protocol: { type: 'string', enum: ['http', 'https'] }
                    },
                    additionalProperties: false
                }
            }
        }
    };
}
