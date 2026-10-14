import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sampleFund, sampleEntity, sampleProprietary } from './fixtures';

async function main(){
 const credentials=JSON.parse(readFileSync('.runtime/dev-credentials.json','utf8'));
 const base='http://127.0.0.1:13000/api/';
 const signed=await fetch(base+'auth:signIn',{method:'POST',headers:{'Content-Type':'application/json','X-Authenticator':'basic'},body:JSON.stringify({account:credentials.admin_email,password:credentials.admin_password})});assert.equal(signed.status,200);
 const token=(await signed.json()).data.token;const auth={Authorization:`Bearer ${token}`,'X-Role':'root','X-Authenticator':'basic','Content-Type':'application/json'};
 async function api(action:string,payload?:any){const response=await fetch(base+'finance:'+action,{method:payload?'POST':'GET',headers:auth,body:payload?JSON.stringify({...payload,request_key:randomUUID()}):undefined});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return action.startsWith('list?')?{rows:data.data,...data.meta}:data.data;}
 assert.equal((await api('metadata')).demo_mode,true);const suffix=Date.now();
 const saved=await api('saveFund',sampleFund(`浏览器质量-${suffix}`));const fund=await api('fund?id='+saved.fund_id);const share=fund.share_classes[0];
 const entity=await api('saveEntity',sampleEntity(`QUALITY-${suffix}`,`质量主体-${suffix}`));
 const trade=await api('saveTrade',{values:{entity_id:entity.id,share_class_id:share.id,confirmation_date:'2026-01-01',transaction_type:'初次申购',confirmed_units:'100',amount:'100',currency:'USD'}});
 await api('saveSeries',{data_type:'returns',expected_revision:null,values:{share_class_id:share.id,return_date:'2026-01-02',mtd_return:'0.0123456789',estimate_label:null}});
 const parent=await api('saveFund',{...sampleProprietary(`浏览器质量成分-${suffix}`),compositions:[{valuation_date:'2026-01-02',items:[{child_share_class_id:share.id,units:null}]}]});
 const future=await api('saveTrade',{values:{entity_id:entity.id,share_class_id:fund.share_classes[1].id,confirmation_date:'2040-01-01',transaction_type:'初次申购',confirmed_units:'5',amount:'5',currency:'USD'}});
 const bench=await api('saveBenchmark',{values:{name:`模拟质量未来基准-${suffix}`}});await api('saveSeries',{data_type:'benchmark',expected_revision:null,values:{benchmark_id:bench.id,value_date:'2040-01-01',index_value:'123.4567890123456789'}});
 const originalName=`模拟质量定位-${suffix}.csv`;
 const text='日期,数值\n'+Array.from({length:45},(_,i)=>new Date(Date.UTC(2020,0,i+1)).toISOString().slice(0,10)+','+(i===44?'bad':'1.25')).join('\n');
 const upload=await api('stageImport',{data_type:'nav',share_class_id:fund.share_classes[1].id,original_name:originalName,content_base64:Buffer.from(text).toString('base64')});let batch:any;
 for(let i=0;i<100;i++){batch=await api('importBatch?id='+upload.batch_id);if(batch.batch.status==='staged')break;await new Promise(resolve=>setTimeout(resolve,30));}
 const preview=await api('previewImport',{batch_id:upload.batch_id,technical_revision:batch.batch.technical_revision,mapping:{date:'日期',value:'数值'}});
 batch=await api('importBatch?id='+upload.batch_id);assert.equal(batch.batch.status,'needs_correction');const errorRow=batch.rows[44];
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1600,height:1150},reducedMotion:'reduce',storageState:{cookies:[],origins:[{origin:'http://127.0.0.1:13000',localStorage:[{name:'NOCOBASE_TOKEN',value:token},{name:'NOCOBASE_AUTH',value:'basic'},{name:'NOCOBASE_ROLE',value:'root'},{name:'NOCOBASE_LOCALE',value:'zh-CN'}]}]}});
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));const dialog=()=>page.getByRole('dialog').last();const quality=()=>page.locator('[data-finance-quality]');
 async function search(text:string){const input=quality().getByLabel('质量问题搜索',{exact:true});await input.fill(text);await input.press('Enter');}
 async function category(text:string){await quality().getByRole('button',{name:new RegExp('^'+text+' ·')}).click();}
 async function select(label:string,text:string){const input=dialog().getByLabel(label,{exact:true});await input.focus();await input.press('ArrowDown');const controls=await input.getAttribute('aria-controls');await page.locator('.ant-select-dropdown').filter({has:page.locator(`[id="${controls}"]`)}).locator('.ant-select-item-option').filter({hasText:new RegExp('^'+text+'$')}).click();}
 async function rowFor(code:string,recordId:string){return quality().locator(`tr[data-row-key="${code}:${recordId}"]`);}
 try{
  await page.goto('http://127.0.0.1:13000/admin/finance');await page.getByRole('tab',{name:'数据质量',exact:true}).click();
  await quality().getByLabel('质量检查业务日',{exact:true}).fill('2026-01-02');await search(fund.fund.short_name);await category('持仓无净值');
  const missing=quality().locator(`tr[data-row-key="missing_nav:${entity.id}:${share.id}"]`);await missing.getByRole('button',{name:'补录净值',exact:true}).click();
  assert.equal(await dialog().getByLabel('日期',{exact:true}).inputValue(),'2026-01-02');await dialog().locator('.ant-select-selection-item').filter({hasText:share.isin}).waitFor();await dialog().getByLabel('数值（收益率按百分数填写）',{exact:true}).fill('1.25');
  await dialog().getByRole('button',{name:/^保\s*存$/}).click();await page.getByRole('dialog').last().waitFor({state:'hidden'});await quality().getByText('当前筛选下未发现上述问题',{exact:true}).waitFor();
  assert.equal((await api('positions?entity_id='+entity.id+'&as_of=2026-01-02'))[0].market_value,'125');console.log('PASS browser: missing NAV opens exact share/date and saving clears issue with updated holdings');

  await category('收益标记缺失');const unknown=quality().getByRole('row').filter({hasText:'估算标记未填写'});await unknown.getByRole('button',{name:'核对／修正',exact:true}).click();
  assert.equal(await dialog().getByLabel('数值（收益率按百分数填写）',{exact:true}).inputValue(),'1.23456789');await select('是否预估','否');await dialog().getByRole('button',{name:/^保\s*存$/}).click();await dialog().getByText('覆盖同日记录',{exact:true}).waitFor();await dialog().getByRole('button',{name:/确\s*定|OK/}).click();await page.getByRole('dialog').last().waitFor({state:'hidden'});await quality().getByText('当前筛选下未发现上述问题',{exact:true}).waitFor();
  const returned=await api(`seriesAt?data_type=returns&parent_id=${share.id}&date=2026-01-02`);assert.equal(returned.mtd_return,'0.0123456789');assert.equal(returned.estimate_label,'否');console.log('PASS browser: unknown return marker is corrected without changing exact return');

  await search(`浏览器质量成分-${suffix}`);await category('成分缺数');const missingUnits=quality().getByRole('row').filter({hasText:'缺少成分份额'});await missingUnits.getByRole('button',{name:'核对／修正',exact:true}).click();
  await dialog().getByLabel('成分份额',{exact:true}).fill('100');await dialog().getByRole('button',{name:'保存基金资料版本',exact:true}).click();await dialog().getByRole('button',{name:'确认保存资料版本',exact:true}).click();await page.getByRole('dialog').last().waitFor({state:'hidden'});await quality().getByText('当前筛选下未发现上述问题',{exact:true}).waitFor();
  assert.equal((await api('versions?fund_id='+parent.fund_id)).length,2);console.log('PASS browser: composition problem targets the existing aggregate and saves one reviewed version');

  await search(originalName);await category('导入错误');const importIssue=quality().getByRole('row').filter({hasText:'第 46 行'});await importIssue.getByRole('button',{name:'打开批次纠错',exact:true}).click();
  const cell=page.getByLabel('第 46 行 数值',{exact:true});await cell.waitFor();assert.equal(await cell.inputValue(),'bad');assert.equal(await page.locator(`[data-finance-import-rows] tr[data-row-key="${errorRow.id}"].finance-target-row`).count(),1);
  await page.getByRole('tabpanel',{name:'导入与纠错',exact:true}).screenshot({path:'docs/verification/M4质量来源定位.png',animations:'disabled'});
  await cell.fill('2.50');await page.getByRole('button',{name:'重新校验并预览',exact:true}).click();await page.getByText('可提交',{exact:true}).waitFor();await page.getByRole('tab',{name:'数据质量',exact:true}).click();await quality().getByText('当前筛选下未发现上述问题',{exact:true}).waitFor();console.log('PASS browser: import issue opens page three and highlights exact source row; correction removes the error');

  await search('自营基金页面');await category('枚举待确认');const option=quality().getByRole('row').filter({hasText:'自营基金页面 · 基金策略详情'});await option.getByRole('button',{name:'维护候选值',exact:true}).click();await dialog().getByText(/自营基金页面 第 25 行/).waitFor();assert.equal(await dialog().getByRole('checkbox').isChecked(),false);await dialog().getByRole('button',{name:'Close',exact:true}).click();console.log('PASS browser: pending source enum opens its exact settings without auto-confirming business choices');

  await page.getByRole('tab',{name:'数据质量',exact:true}).click();await search(fund.fund.short_name);await category('未来日期数据');const futureRow=await rowFor('future:transactions',future.id);await futureRow.getByRole('button',{name:'核对／修正',exact:true}).click();assert.equal(await dialog().getByLabel('确认日期',{exact:true}).inputValue(),'2040-01-01');await dialog().getByLabel('确认日期',{exact:true}).fill('2026-01-02');await dialog().getByRole('button',{name:'保存并生效',exact:true}).click();await page.getByRole('dialog').last().waitFor({state:'hidden'});await quality().getByText('当前筛选下未发现上述问题',{exact:true}).waitFor();
  await search(`模拟质量未来基准-${suffix}`);await quality().getByRole('button',{name:'核对／修正',exact:true}).click();await dialog().getByRole('button',{name:'删除错误记录',exact:true}).click();await dialog().getByText(/原数值 123.4567890123456789/).waitFor();await dialog().getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('dialog').last().waitFor({state:'hidden'});await quality().getByText('当前筛选下未发现上述问题',{exact:true}).waitFor();assert.equal((await api('list?table=benchmarks&id='+bench.id)).count,1);console.log('PASS browser: future trade date is editable and wrong benchmark date can be explicitly deleted without deleting definition');

  const sourceName=`模拟质量已提交来源-${suffix}.csv`;
  const sourceUpload=await api('stageImport',{data_type:'returns',share_class_id:fund.share_classes[1].id,original_name:sourceName,content_base64:Buffer.from(text.replace('bad','2.50')).toString('base64')});let sourceBatch:any;
  for(let i=0;i<100;i++){sourceBatch=await api('importBatch?id='+sourceUpload.batch_id);if(sourceBatch.batch.status==='staged')break;await new Promise(resolve=>setTimeout(resolve,30));}
  await api('previewImport',{batch_id:sourceUpload.batch_id,technical_revision:sourceBatch.batch.technical_revision,mapping:{date:'日期',value:'数值',value_mode:'percent'}});sourceBatch=await api('importBatch?id='+sourceUpload.batch_id);
  await api('commitImport',{batch_id:sourceUpload.batch_id,technical_revision:sourceBatch.batch.technical_revision,preview_token:sourceBatch.batch.preview.token});
  await search(fund.fund.short_name);await category('收益标记缺失');const sourced=quality().getByRole('row').filter({hasText:'第 46 行'});await sourced.getByRole('button',{name:/第 46 行/}).click();
  const sourceRow=page.locator(`[data-finance-import-rows] tr[data-row-key="${sourceBatch.rows[44].id}"].finance-target-row`);await sourceRow.waitFor();assert.ok((await sourceRow.innerText()).includes('2.50'));assert.equal(await sourceRow.locator('input').count(),0);await page.getByText('已提交 45 行',{exact:true}).waitFor();
  console.log('PASS browser: committed return provenance opens the exact third-page original row in a read-only batch');
  await page.getByRole('tab',{name:'数据质量',exact:true}).click();
  await search('');await category('未来日期数据');await quality().getByRole('button',{name:'刷新检查',exact:true}).click();await quality().locator(`tr[data-row-key="${sourceUpload.batch_id}"]`).waitFor();await page.setViewportSize({width:1600,height:1900});await quality().locator(`tr[data-row-key="${sourceUpload.batch_id}"]`).scrollIntoViewIfNeeded();await quality().screenshot({path:'docs/verification/M4数据质量工作台.png',animations:'disabled'});
  assert.deepEqual(errors,[]);writeFileSync('.runtime/browser-quality-result.json',JSON.stringify({passed:true,checks:7,timestamp:new Date().toISOString(),fund_id:fund.fund.id,parent_fund_id:parent.fund_id,entity_id:entity.id,import_batch_id:upload.batch_id,source_row:46},null,2));
 }catch(error){await page.screenshot({path:'.runtime/browser-quality-failure.png',fullPage:true});console.error((await page.locator('body').innerText()).slice(-6000));throw error;}finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
