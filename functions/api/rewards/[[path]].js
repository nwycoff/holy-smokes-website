import { handleRewards } from '../../../server/rewards.mjs';

export const onRequest = context => handleRewards(context);
