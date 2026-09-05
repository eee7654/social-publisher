import { registerIntegrationAdapter } from '../../../integrations/registry.js';
import { publishToLinkedIn } from './adapter.js';

registerIntegrationAdapter('publishing', 'publishing.linkedin', () => ({ publish: publishToLinkedIn }));

export { publishToLinkedIn };
