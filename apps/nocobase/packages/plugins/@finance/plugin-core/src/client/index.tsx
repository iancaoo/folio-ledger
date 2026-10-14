import navigation from '../shared/navigation.json';
import { Plugin } from '@nocobase/client';
import { FinanceWorkspace } from './Workspace';

export default class FinanceClientPlugin extends Plugin {
  async load() {
    const loaders = Object.fromEntries(navigation.map(page => [page.model, {
      loader: () => import('../client-v2/models/FinancePageModels').then(models => ({ default: models[page.model] })),
    }]));
    this.flowEngine.registerModelLoaders(loaders);
    this.app.router.add('admin.finance', { path: '/admin/finance', Component: FinanceWorkspace });
  }
}
