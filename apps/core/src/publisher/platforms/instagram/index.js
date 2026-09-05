import { registerIntegrationAdapter } from '../../../integrations/registry.js';
import { instagramPublisherAdapter, InstagramPublisherAdapter } from './adapter.js';
import { MetaApiClient, getMetaApiClient } from './api.js';
import { classifyMetaError, InstagramAdapterError } from './errors.js';
import { reconcileInstagramJob } from './reconciliation.js';
import * as constants from './constants.js';

// Register with the integration kernel
registerIntegrationAdapter('publishing', 'publishing.instagram', ({ provider, integrationConfig }) => {
  return instagramPublisherAdapter;
});

export {
  instagramPublisherAdapter,
  InstagramPublisherAdapter,
  MetaApiClient,
  getMetaApiClient,
  classifyMetaError,
  InstagramAdapterError,
  reconcileInstagramJob,
  constants,
};
