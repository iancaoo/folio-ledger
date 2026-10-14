import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sampleFund, sampleEntity } from './fixtures';

async function main() {
  const credentials=JSON.parse(readFileSync('.runtime/dev-credentials.json','utf8'));
  const base='http://127.0.0.1:13000/api/';
  const login=await fetch(base+'auth:signIn',{method:'POST',headers:{'Content-Type':'application/json','X-Authenticator':'basic'},body:JSON.stringify({account:credentials.admin_email,password:credentials.admin_password})});
  assert.equal(login.status,200); const token=(await login.json()).data.token;
  const auth={Authorization:`Bearer ${token}`,'X-Role':'root','X-Authenticator':'basic','Content-Type':'application/json'};
  async function api(action: string,payload?: any,key=randomUUID()) {
    const response=await fetch(base+'finance:'+action,{method:payload?'POST':'GET',headers:auth,body:payload?JSON.stringify({...payload,request_key:key}):undefined});
    const result=await response.json(); assert.equal(response.status,200,JSON.stringify(result.errors));return action.startsWith('list?')?{rows:result.data,...result.meta}:result.data;
  }
  assert.equal((await api('metadata')).demo_mode,true);
  const input=sampleFund('BROWSER-QUERY-FIXTURE'); const template=input.share_classes[0];
  input.share_classes=Array.from({length:205},(_,i)=>({values:{...template.values,isin:`BROWSER-QUERY-SHARE-${String(i).padStart(3,'0')}`,class_label:`Q${i}`},terms:{...template.terms}}));
  const created=await api('saveFund',input,'browser-query-fund-v1'); const fund=await api(`fund?id=${created.fund_id}`);
  const share=fund.share_classes.find(row=>row.isin==='BROWSER-QUERY-SHARE-000');
  const entity=await api('saveEntity',sampleEntity('BROWSER-QUERY-CLIENT','完整查询专用主体'),'browser-query-entity-v1');
  const names=Array.from({length:205},(_,i)=>`模拟完整查询专用基准-${String(i).padStart(3,'0')}`);
  for (const [i,name] of names.entries()) await api('saveBenchmark',{values:{name,category:'分页模拟'}},`browser-query-benchmark-v1-${i}`);
  let old=await api(`seriesAt?data_type=nav&parent_id=${share.id}&date=1990-01-01`);
  await api('saveSeries',{data_type:'nav',expected_revision:old?.technical_revision??null,values:{share_class_id:share.id,nav_date:'1990-01-01',nav_per_unit:'1.25'}});
  for (let i=0;i<205;i++) {
    const date=new Date(Date.UTC(2000,0,1+i)).toISOString().slice(0,10);
    await api('saveSeries',{data_type:'nav',expected_revision:null,values:{share_class_id:share.id,nav_date:date,nav_per_unit:'1.25'}},`browser-query-nav-v1-${i}`);
  }
  await api('saveTrade',{values:{entity_id:entity.id,share_class_id:share.id,transaction_type:'初次申购',confirmation_date:'1989-12-31',currency:'USD',amount:'7',confirmed_units:'7'}},'browser-query-trade-v1');
  assert.equal((await api(`list?table=fund_navs&share_class_id=${share.id}&page_size=200`)).rows.some(row=>row.nav_date==='1990-01-01'),false);
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1500,height:1100},reducedMotion:'reduce',storageState:{cookies:[],origins:[{origin:'http://127.0.0.1:13000',localStorage:[{name:'NOCOBASE_TOKEN',value:token},{name:'NOCOBASE_AUTH',value:'basic'},{name:'NOCOBASE_ROLE',value:'root'},{name:'NOCOBASE_LOCALE',value:'zh-CN'}]}]}});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const dialog=()=>page.getByRole('dialog').last();
  async function search(container:any,label:string,value:string) {const input=container.getByLabel(label,{exact:true});await input.fill(value);await input.press('Enter');}
  async function choose(container:any,label:string,text:string) {
    const node=container.getByLabel(label,{exact:true}).first();const input=await node.evaluate(element=>element.tagName==='INPUT')?node:node.locator('input').first();
    await input.fill(text);await input.press('ArrowDown');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:text}).first().click();
  }
  try {
    await page.goto('http://127.0.0.1:13000/admin/finance');await page.getByRole('tab',{name:'基准',exact:true}).click();
    const table=page.locator('[data-finance-table="benchmarks"]');
    await search(table,'基准定义搜索','模拟完整查询专用基准-');await table.getByText('共 205 条',{exact:true}).waitFor();
    await table.locator('.ant-pagination-item-21').click();await table.getByRole('button',{name:names[0],exact:true}).waitFor();
    const pageResponse=await api('list?table=benchmarks&search='+encodeURIComponent('模拟完整查询专用基准-')+'&page=21&page_size=10');assert.equal(pageResponse.rows.length,5);
    await table.screenshot({path:'docs/verification/M4完整分页.png',animations:'disabled'});
    await table.getByRole('button',{name:names[0],exact:true}).click();await dialog().getByLabel('基准名称',{exact:true}).waitFor();assert.equal(await dialog().getByLabel('基准名称',{exact:true}).inputValue(),names[0]);
    await dialog().getByRole('button',{name:'Close',exact:true}).click();
    console.log('PASS browser: last page of 205 benchmark definitions remains accessible and opens the correct record');

    await page.getByRole('tab',{name:'净值与收益',exact:true}).click();await page.getByRole('button',{name:'录入净值',exact:true}).click();
    await choose(dialog(),'基金份额','BROWSER-QUERY-SHARE-000');
    await dialog().getByLabel('日期',{exact:true}).fill('1990-01-01');await dialog().getByLabel('数值（收益率按百分数填写）',{exact:true}).fill('2.5');
    await dialog().getByRole('button',{name:/^保\s*存$/}).click();await dialog().getByText('覆盖同日记录',{exact:true}).waitFor();await dialog().getByText(/原值 1.25，新值 2.5/).waitFor();
    await page.waitForTimeout(250);await dialog().screenshot({path:'docs/verification/M4旧净值覆盖.png',animations:'disabled'});
    await dialog().getByRole('button',{name:/确\s*定|OK/}).click();await page.getByRole('dialog',{name:'录入净值／收益',exact:true}).waitFor({state:'hidden'});await page.getByRole('dialog').last().waitFor({state:'hidden'});
    const overwritten=await api(`seriesAt?data_type=nav&parent_id=${share.id}&date=1990-01-01`);assert.equal(overwritten.nav_per_unit,'2.5');
    assert.equal((await api(`list?table=fund_navs&share_class_id=${share.id}&date_from=1990-01-01&date_to=1990-01-01`)).count,1);
    console.log('PASS browser: remote ISIN lookup finds an old share; same-day overwrite detects a NAV beyond the first 200 records');

    await page.getByRole('tab',{name:'持仓核对',exact:true}).click();const positions=page.locator('[data-finance-table="positionList"]');
    await search(positions,'持仓搜索','完整查询专用主体');await positions.getByText('共 1 条',{exact:true}).waitFor();
    await positions.getByLabel('持仓截至日期',{exact:true}).fill('1990-01-01');await positions.getByRole('cell',{name:'17.50',exact:true}).waitFor();
    await positions.getByRole('button',{name:'赎回',exact:true}).click();
    await dialog().locator('.ant-select-selection-item').filter({hasText:'完整查询专用主体'}).waitFor();await dialog().locator('.ant-select-selection-item').filter({hasText:'BROWSER-QUERY-SHARE-000'}).waitFor();
    assert.equal(await dialog().getByLabel('确认日期',{exact:true}).inputValue(),new Date().toISOString().slice(0,10));
    await dialog().getByRole('button',{name:'Close',exact:true}).click();
    console.log('PASS browser: holdings filters retain exact historic valuation and hydrate both redemption references');

    await page.getByRole('tab',{name:'净值与收益',exact:true}).click();await page.getByRole('button',{name:'录入净值',exact:true}).click();
    let release:()=>void=()=>{};let intercepted:()=>void=()=>{};const delayed=new Promise<void>(resolve=>release=resolve);const requested=new Promise<void>(resolve=>intercepted=resolve);
    await page.route('**/api/finance:lookup*',async route=>{if(new URL(route.request().url()).searchParams.get('search')==='BROWSER-QUERY-SHARE-202'){intercepted();await delayed;}await route.continue();});
    const selector=dialog().getByLabel('基金份额',{exact:true});await selector.fill('BROWSER-QUERY-SHARE-202');await Promise.race([requested,new Promise((_,reject)=>{setTimeout(()=>reject(new Error('Delayed lookup was not requested')),8000).unref();})]);await selector.fill('BROWSER-QUERY-SHARE-203');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:'BROWSER-QUERY-SHARE-203'}).waitFor();release();await page.waitForTimeout(400);
    assert.equal(await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:'BROWSER-QUERY-SHARE-202'}).count(),0);
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:'BROWSER-QUERY-SHARE-203'}).click();await page.unroute('**/api/finance:lookup*');
    await dialog().getByRole('button',{name:'Close',exact:true}).click();
    await dialog().getByRole('button',{name:'放弃本次修改',exact:true}).click();
    console.log('PASS browser: slow previous searches cannot replace the latest reference results');
    assert.deepEqual(errors,[]);
    writeFileSync('.runtime/browser-query-result.json',JSON.stringify({passed:true,checks:4,timestamp:new Date().toISOString(),benchmark_count:205,share_count:205,nav_count:206,fund_id:fund.fund.id,entity_id:entity.id},null,2));
  } catch(error){await page.screenshot({path:'.runtime/browser-query-failure.png',fullPage:true});console.error((await page.locator('body').innerText()).slice(-4500));throw error;}
  finally{await browser.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
