import { handleCrm } from '../../../server/crm/index.mjs';
export const onRequest = context => handleCrm(context);
