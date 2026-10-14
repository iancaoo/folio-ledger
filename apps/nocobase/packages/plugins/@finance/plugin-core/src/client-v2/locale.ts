import { tExpr as expression } from '@nocobase/flow-engine';
export const tExpr = (key: string) => expression(key, { ns: '@finance/plugin-core' });
