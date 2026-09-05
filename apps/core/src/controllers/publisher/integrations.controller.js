import IntegrationProvider from '@/db/models/core/IntegrationProvider.js';
import IntegrationConfig from '@/db/models/core/IntegrationConfig.js';
import { AppError } from '@/lib/AppError.js';
import { ErrorCodes } from '@/constants/responseCodes.js';
import { buildProviderConfig, toPublicProviderConfig } from '@/integrations/configSerializer.js';

export const listProviders = async (req, res) => {
    const providers = await IntegrationProvider.query()
        .where('domain', 'publishing')
        .where('is_enabled', true)
        .orderBy('display_name', 'asc');

    res.status(200).json({ providers });
};

export const listIntegrationConfigs = async (req, res) => {
    const organizationId = req.orgId;
    if (!organizationId) {
        throw new AppError(400, ErrorCodes.ORG_NOT_FOUND, false, 'Organization context required');
    }

    const configs = await IntegrationConfig.query()
        .where('organization_id', organizationId)
        .whereNull('deleted_at')
        .withGraphFetched('provider')
        .orderBy('created_at', 'desc');

    const serializedConfigs = configs.map(config => {
        const { config: publicConfig, secrets } = toPublicProviderConfig(config.provider.adapter_key, config.config_json);
        return {
            id: config.id,
            provider_id: config.provider_id,
            name: config.name,
            external_account_id: config.external_account_id,
            external_account_name: config.external_account_name,
            status: config.status,
            config_json: publicConfig,
            secrets,
            created_at: config.created_at,
            provider: config.provider
        };
    });

    res.status(200).json({ configs: serializedConfigs });
};

export const createIntegrationConfig = async (req, res) => {
    const organizationId = req.orgId;
    const { provider_id, name, config_json, external_account_id, external_account_name } = req.body;

    if (!organizationId) {
        throw new AppError(400, ErrorCodes.ORG_NOT_FOUND, false, 'Organization context required');
    }

    const provider = await IntegrationProvider.query().findById(provider_id);
    if (!provider || !provider.is_enabled || provider.domain !== 'publishing') {
        throw new AppError(400, ErrorCodes.GEN_INVALID_DATA, false, 'Invalid publishing provider');
    }

    const secureConfigJson = buildProviderConfig({
        adapterKey: provider.adapter_key,
        submitted: config_json || {},
        isCreate: true
    });

    const newConfig = await IntegrationConfig.query().insert({
        provider_id: provider.id,
        organization_id: organizationId,
        name: name || `${provider.display_name} Connection`,
        config_json: secureConfigJson,
        external_account_id: external_account_id || null,
        external_account_name: external_account_name || null,
        created_by: req.user.id,
        status: 'active'
    });

    const { config: publicConfig, secrets } = toPublicProviderConfig(provider.adapter_key, newConfig.config_json);

    res.status(201).json({
        config: {
            ...newConfig,
            config_json: publicConfig,
            secrets
        }
    });
};

export const updateIntegrationConfig = async (req, res) => {
    const organizationId = req.orgId;
    const configId = req.params.id;
    const { name, config_json, external_account_id, external_account_name, status } = req.body;

    if (!organizationId) {
        throw new AppError(400, ErrorCodes.ORG_NOT_FOUND, false, 'Organization context required');
    }

    const existingConfig = await IntegrationConfig.query()
        .where('id', configId)
        .where('organization_id', organizationId)
        .whereNull('deleted_at')
        .withGraphFetched('provider')
        .first();

    if (!existingConfig) {
        throw new AppError(404, ErrorCodes.GEN_NOT_FOUND, false, 'Integration config not found');
    }

    let secureConfigJson = existingConfig.config_json;
    if (config_json !== undefined) {
        secureConfigJson = buildProviderConfig({
            adapterKey: existingConfig.provider.adapter_key,
            submitted: config_json,
            stored: existingConfig.config_json,
            isCreate: false
        });
    }

    const updatedConfig = await IntegrationConfig.query().patchAndFetchById(existingConfig.id, {
        name: name !== undefined ? name : existingConfig.name,
        config_json: secureConfigJson,
        external_account_id: external_account_id !== undefined ? external_account_id : existingConfig.external_account_id,
        external_account_name: external_account_name !== undefined ? external_account_name : existingConfig.external_account_name,
        status: status !== undefined ? status : existingConfig.status,
    });

    const { config: publicConfig, secrets } = toPublicProviderConfig(existingConfig.provider.adapter_key, updatedConfig.config_json);

    res.status(200).json({
        config: {
            ...updatedConfig,
            config_json: publicConfig,
            secrets
        }
    });
};
