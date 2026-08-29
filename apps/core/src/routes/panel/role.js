
import { createBaseRouter } from '@/config/base-router';
import { checkPermission } from '@/middlewares/checkPermission.js';
import * as roleCont from '@/controllers/panel/role.controller';

const router = createBaseRouter()

router.get('/fetch', checkPermission('read', 'Role'), roleCont.fetch);

router.post('/create', checkPermission('create', 'Role'), roleCont.create);

router.post('/update', checkPermission('update', 'Role'), roleCont.update);

router.get('/lookup', checkPermission('lookup', 'Role'), roleCont.lookup)

export default router