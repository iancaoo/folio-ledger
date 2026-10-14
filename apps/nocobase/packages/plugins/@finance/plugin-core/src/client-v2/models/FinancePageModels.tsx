import React from 'react';
import type { DefaultStructure } from '@nocobase/flow-engine';
import { BlockModel } from '@nocobase/client-v2';
import { FinanceWorkspace } from '../../client/Workspace';
import { tExpr } from '../locale';

function pageModel(page: string, label: string, icon: string): typeof BlockModel {
  class FinancePageModel<T = DefaultStructure> extends BlockModel<T> {
    renderComponent() {
      return <FinanceWorkspace embeddedPage={page} />;
    }
  }
  FinancePageModel.define({ label: tExpr(label), icon });
  return FinancePageModel;
}

export const FinanceHomeBlockModel = pageModel('home', 'Finance 总览', 'DashboardOutlined');
export const FinanceDraftsBlockModel = pageModel('drafts', 'Finance 个人草稿', 'FormOutlined');
export const FinanceFundsBlockModel = pageModel('funds', 'Finance 基金列表', 'FundOutlined');
export const FinanceSeriesBlockModel = pageModel('series', 'Finance 净值与收益', 'LineChartOutlined');
export const FinanceCompositionsBlockModel = pageModel('compositions', 'Finance 成分核对', 'ApartmentOutlined');
export const FinanceDocumentsBlockModel = pageModel('documents', 'Finance 文档附件', 'FileOutlined');
export const FinanceEntitiesBlockModel = pageModel('entities', 'Finance 客户与主体', 'TeamOutlined');
export const FinancePositionsBlockModel = pageModel('positions', 'Finance 持仓核对', 'PieChartOutlined');
export const FinanceTradesBlockModel = pageModel('trades', 'Finance 交易录入', 'SwapOutlined');
export const FinanceImportsBlockModel = pageModel('imports', 'Finance 导入中心', 'ImportOutlined');
export const FinanceQualityBlockModel = pageModel('quality', 'Finance 数据质量', 'CheckCircleOutlined');
export const FinanceExportBlockModel = pageModel('export', 'Finance 数据导出', 'ExportOutlined');
export const FinanceSettingsBlockModel = pageModel('settings', 'Finance 设置概览', 'SettingOutlined');
export const FinanceOptionsBlockModel = pageModel('options', 'Finance 字段候选配置', 'UnorderedListOutlined');
export const FinanceBenchmarksBlockModel = pageModel('benchmarks', 'Finance 基准数据', 'LineChartOutlined');
export const FinanceFundRegisterBlockModel = pageModel('fund-register', 'Finance 基金资料管理', 'DatabaseOutlined');
