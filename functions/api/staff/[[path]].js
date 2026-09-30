import { handleStaff } from '../../../server/staff/index.mjs';
export const onRequest = context => handleStaff(context);
