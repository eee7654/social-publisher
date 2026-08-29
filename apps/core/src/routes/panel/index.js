import sessionRoutes from './session';
import userRoutes from './user';
import roleRoutes from './role';
import organRoutes from './organ';
import { createBaseRouter } from "@/config/base-router.js";

const panelRouter = createBaseRouter({ auth: true });

panelRouter.use('/session', sessionRoutes);
panelRouter.use('/users', userRoutes);
panelRouter.use('/roles', roleRoutes);
panelRouter.use('/organs', organRoutes);


export default panelRouter;