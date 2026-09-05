import { registerIntegrationAdapter } from '../../../integrations/registry.js';
import { publishToYouTube } from './adapter.js';

registerIntegrationAdapter('publishing', 'publishing.youtube', () => ({ publish: publishToYouTube }));

export { publishToYouTube };
