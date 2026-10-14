import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

async function main() {
  const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json','utf8'));
  const base = 'http://127.0.0.1:13000/api/';
  const login = await fetch(base+'auth:signIn',{method:'POST',headers:{'Content-Type':'application/json','X-Authenticator':'basic'},body:JSON.stringify({account:credentials.admin_email,password:credentials.admin_password})});
  assert.equal(login.status,200); const token = (await login.json()).data.token;
  const headers = {Authorization:`Bearer ${token}`,'X-Role':'root','X-Authenticator':'basic','Content-Type':'application/json'};
  async function request(action: string, payload?: any) {
    const response = await fetch(base+'finance:'+action,{method:payload?'POST':'GET',headers,body:payload?JSON.stringify({...payload,request_key:randomUUID()}):undefined});
    return {status:response.status,body:await response.json()};
  }
  async function api(action: string,payload?:any) {const result=await request(action,payload);assert.equal(result.status,200,JSON.stringify(result.body));return result.body.data;}
  assert.equal((await api('metadata')).demo_mode,true);
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1500,height:1100},reducedMotion:'reduce',storageState:{cookies:[],origins:[{origin:'http://127.0.0.1:13000',localStorage:[{name:'NOCOBASE_TOKEN',value:token},{name:'NOCOBASE_AUTH',value:'basic'},{name:'NOCOBASE_ROLE',value:'root'},{name:'NOCOBASE_LOCALE',value:'zh-CN'}]}]}});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const dialog=()=>page.getByRole('dialog').last(); const suffix=Date.now();
  async function saveDraft() {
    const response=page.waitForResponse(response=>response.url().includes('finance:saveDraft'));
    await dialog().getByRole('button',{name:'保存草稿并关闭',exact:true}).click();
    const result=await response; assert.equal(result.status(),200,JSON.stringify(await result.json()));
    await page.getByRole('dialog').last().waitFor({state:'hidden'});return (await result.json()).data;
  }
  async function resume(id:string) {
    await page.getByRole('tab',{name:'个人草稿',exact:true}).click();
    await page.locator(`[data-finance-table="drafts"] tr[data-row-key="${id}"]`).getByRole('button',{name:'继续填写',exact:true}).click();
    await dialog().waitFor();
  }
  try {
    await page.goto('http://127.0.0.1:13000/admin/finance');
    await page.getByRole('tab',{name:'基准',exact:true}).click();await page.getByRole('button',{name:'新建基准',exact:true}).click();
    const name=`模拟草稿精度-${suffix}`, exact='123456789012345.123456789000';
    await dialog().getByLabel('基准名称',{exact:true}).fill(name);
    await dialog().getByRole('button',{name:'Close',exact:true}).click();
    await dialog().getByText('表单尚未保存',{exact:true}).waitFor();await dialog().getByRole('button',{name:'继续填写',exact:true}).click();
    assert.equal(await dialog().getByLabel('基准名称',{exact:true}).inputValue(),name);
    await dialog().getByLabel('备注',{exact:true}).fill(exact);
    await dialog().getByRole('button',{name:'Close',exact:true}).click();const first=await saveDraft();
    assert.equal((await request('list?table=benchmarks&search='+encodeURIComponent(name))).body.meta.count,0);
    await page.reload();await resume(first.id);assert.equal(await dialog().getByLabel('备注',{exact:true}).inputValue(),exact);
    await dialog().getByLabel('基准分类',{exact:true}).fill('模拟分类');
    console.log('PASS browser: unsaved exit offers continue/save, incomplete draft survives refresh and preserves exact text');

    let dropped=false;
    await page.route('**/api/finance:saveBenchmark',async route=>{if(!dropped){dropped=true;const result=await route.fetch();assert.equal(result.status(),200);await route.abort('failed');}else await route.continue();});
    await dialog().getByRole('button',{name:/保存基准定义/}).click();await dialog().getByText(/连接中断/).waitFor();
    await dialog().getByRole('button',{name:/保存基准定义/}).click();await page.getByRole('dialog').last().waitFor({state:'hidden'});
    await page.unroute('**/api/finance:saveBenchmark');
    assert.equal((await request('draft?id='+first.id)).status,404);
    const formal=await request('list?table=benchmarks&search='+encodeURIComponent(name));assert.equal(formal.body.meta.count,1);assert.equal(formal.body.data[0].remarks,exact);
    console.log('PASS browser: formal save consumes draft atomically and response-loss retry creates one record');

    const cases=[
      {type:'fund',tab:'基金与份额',button:'新建基金',label:'基金简称',value:`模拟未完成基金-${suffix}`,path:['fund','short_name']},
      {type:'entity',tab:'客户与主体',button:'新建主体',label:'投资主体名称',value:`模拟未完成主体-${suffix}`,path:['entity','legal_name']},
      {type:'trade',tab:'申赎录入',button:'录入申赎',label:'备注',value:`模拟未完成交易-${suffix}`,path:['remarks']},
      {type:'series',tab:'净值与收益',button:'录入收益',label:'数值（收益率按百分数填写）',value:'0.0000000000000001000',path:['value']},
      {type:'benchmarkValue',tab:'基准',button:'录入基准数值',label:'基准数值',value:exact,path:['index_value']},
    ];
    const stored=[];
    for(const item of cases){
      await page.getByRole('tab',{name:item.tab,exact:true}).click();await page.getByRole('button',{name:item.button,exact:true}).click();
      await dialog().getByLabel(item.label,{exact:true}).fill(item.value);const saved=await saveDraft();stored.push({...item,...saved});
      const row=await api('draft?id='+saved.id);assert.equal(row.form_type,item.type);assert.equal(item.path.reduce((value,key)=>value[key],row.content.values),item.value);
    }
    await page.reload();
    for(const item of stored){await resume(item.id);assert.equal(await dialog().getByLabel(item.label,{exact:true}).inputValue(),item.value);await dialog().getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').last().waitFor({state:'hidden'});}
    await page.locator('[data-finance-table="drafts"]').screenshot({path:'docs/verification/M4个人草稿.png',animations:'disabled'});
    console.log('PASS browser: remaining five forms restore incomplete values, associations may remain empty, unchanged close preserves saved draft');

    const stale=await api('saveDraft',{form_type:'benchmark',content:{values:{name:`模拟草稿并发-${suffix}`}}});
    await page.reload();await resume(stale.id);await dialog().getByLabel('基准名称',{exact:true}).fill('本页未保存改动');
    await api('saveDraft',{...stale,form_type:'benchmark',content:{values:{name:'另一会话已保存'}}});
    await dialog().getByRole('button',{name:'保存草稿并关闭',exact:true}).click();await dialog().getByText(/记录已变化/).waitFor();
    assert.equal(await dialog().getByLabel('基准名称',{exact:true}).inputValue(),'本页未保存改动');
    await dialog().getByRole('button',{name:'Close',exact:true}).click();await dialog().getByRole('button',{name:'放弃本次修改',exact:true}).click();await page.getByRole('dialog').last().waitFor({state:'hidden'});
    assert.equal((await api('draft?id='+stale.id)).content.values.name,'另一会话已保存');
    console.log('PASS browser: a stale draft save keeps inputs and cannot replace another session; discard leaves prior draft intact');

    const current=formal.body.data[0];const edit=await api('saveDraft',{form_type:'benchmark',content:{values:{name:current.name,category:current.category,remarks:'草稿中的修改'},editing:{id:current.id,technical_revision:current.technical_revision}}});
    await api('saveBenchmark',{id:current.id,technical_revision:current.technical_revision,values:{name:current.name,category:current.category,remarks:'正式资料已被其他会话修改'}});
    await page.reload();await resume(edit.id);await dialog().getByRole('button',{name:/保存基准定义/}).click();await dialog().getByText(/记录已变化/).waitFor();
    assert.equal((await api('draft?id='+edit.id)).content.editing.technical_revision,current.technical_revision);
    await dialog().getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').last().waitFor({state:'hidden'});
    const row=page.locator(`[data-finance-table="drafts"] tr[data-row-key="${edit.id}"]`);await row.getByRole('button',{name:'删除草稿',exact:true}).click();await dialog().getByRole('button',{name:'删除草稿',exact:true}).click();await page.getByRole('dialog').last().waitFor({state:'hidden'});
    assert.equal((await request('draft?id='+edit.id)).status,404);
    assert.equal((await request('list?table=benchmarks&id='+current.id)).body.data[0].remarks,'正式资料已被其他会话修改');
    console.log('PASS browser: resumed edit retains old business revision, failed formal save preserves draft, explicit draft deletion leaves business data');
    const benchmarkId=current.id;
    await api('saveSeries',{data_type:'benchmark',expected_revision:null,values:{benchmark_id:benchmarkId,value_date:'2026-01-01',index_value:'1.25'}});
    const seriesDraft=await api('saveDraft',{form_type:'benchmarkValue',content:{values:{benchmark_id:benchmarkId,value_date:'2026-01-01',index_value:'2.50000000000000001'}}});
    await page.reload();await resume(seriesDraft.id);
    let seriesDropped=false;
    await page.route('**/api/finance:saveSeries',async route=>{if(!seriesDropped){seriesDropped=true;const result=await route.fetch();assert.equal(result.status(),200);await route.abort('failed');}else await route.continue();});
    await dialog().getByRole('button',{name:'保存基准数值'}).click();await dialog().getByText('覆盖同日基准数值',{exact:true}).waitFor();
    await dialog().getByRole('button',{name:/确\s*定|OK/}).click();
    const seriesModal=page.getByRole('dialog',{name:'录入基准数值',exact:true});await seriesModal.getByText(/连接中断/).waitFor();
    await seriesModal.getByRole('button',{name:'保存基准数值'}).click();await seriesModal.waitFor({state:'hidden'});await page.unroute('**/api/finance:saveSeries');
    const at=await api('seriesAt?data_type=benchmark&parent_id='+benchmarkId+'&date=2026-01-01');assert.equal(at.technical_revision,2);assert.equal(at.index_value,'2.50000000000000001');assert.equal((await request('draft?id='+seriesDraft.id)).status,404);
    console.log('PASS browser: lost same-day overwrite response retries original revision and consumes draft once');
    assert.deepEqual(errors,[]);writeFileSync('.runtime/browser-drafts-result.json',JSON.stringify({passed:true,checks:6,forms:6,timestamp:new Date().toISOString(),draft_ids:stored.map(row=>row.id)},null,2));
  } catch(error){await page.screenshot({path:'.runtime/browser-drafts-failure.png',fullPage:true});console.error((await page.locator('body').innerText()).slice(-5500)); console.error(await page.getByRole('dialog').allTextContents());throw error;}
  finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
