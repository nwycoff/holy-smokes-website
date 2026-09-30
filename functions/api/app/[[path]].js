import { handleApp } from '../../../server/customer-app/index.mjs';
export const onRequest = context => handleApp(context);
