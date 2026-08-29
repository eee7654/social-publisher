
import { createBaseRouter } from '@/config/base-router';
import * as sessionCont from '@/controllers/panel/session.controller'

const router = createBaseRouter()

router.get('/', sessionCont.fetch);

export default router