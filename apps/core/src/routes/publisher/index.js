import { createRouter } from "next-connect";
import { requireAuth } from "@/middlewares/requireAuth.js";
import { checkPermission } from "@/middlewares/checkPermission.js";
import * as integrationsController from "@/controllers/publisher/integrations.controller.js";

const publisherRouter = createRouter();

publisherRouter.use(requireAuth);

publisherRouter.get(
    '/providers',
    integrationsController.listProviders
);

publisherRouter.get(
    '/integrations',
    checkPermission('read', 'IntegrationConfig'),
    integrationsController.listIntegrationConfigs
);

publisherRouter.post(
    '/integrations',
    checkPermission('create', 'IntegrationConfig'),
    integrationsController.createIntegrationConfig
);

publisherRouter.put(
    '/integrations/:id',
    checkPermission('update', 'IntegrationConfig'),
    integrationsController.updateIntegrationConfig
);

export default publisherRouter;
