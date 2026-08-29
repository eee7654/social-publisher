
import { createBaseRouter } from '@/config/base-router';
import { checkPermission } from '@/middlewares/checkPermission.js';
import * as userCont from '@/controllers/panel/user.controller';

const router = createBaseRouter()

router.get('/', checkPermission('read', 'User'), userCont.fetch)

router.post('/', checkPermission('create', 'User'), userCont.create)

router.patch('/:id', userCont.updateUser);

router.post('/update', userCont.updateProfile);



export default router