import { Plugin } from '@nocobase/client';
import { FinanceWorkspace } from './Workspace';

export default class FinanceClientPlugin extends Plugin {
  async load() {
    this.app.router.add('admin.finance', { path: '/admin/finance', Component: FinanceWorkspace });
  }
}
