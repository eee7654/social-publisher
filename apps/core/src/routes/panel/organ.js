
import { createBaseRouter } from '@/config/base-router';
import * as organsCont from '@/controllers/panel/organs.controller'
import { checkPermission } from '@/middlewares/checkPermission';

const router = createBaseRouter()

router.get('/', checkPermission('read', 'Organization'), organsCont.fetch);

router.post('/', checkPermission('create', 'Organization'), organsCont.create);

router.patch('/:id', checkPermission('update', 'Organization'), organsCont.update);

router.get('/lookup', checkPermission('read', 'Organization'), organsCont.lookup)

export default router