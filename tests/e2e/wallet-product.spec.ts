import {test,expect,type Page} from '@playwright/test';
const account='0x'+'1'.repeat(40),recipient='0x'+'2'.repeat(40),txHash='0x'+'a'.repeat(64);
async function wallet(page:Page){
  await page.addInitScript(({account,txHash})=>{
    const listeners:Record<string,Function[]>={};
    const state={account,chain:'0x3c8',sends:0,reject:false,change(){state.chain='0x1';for(const listener of listeners.chainChanged??[])listener(state.chain);}};
    (window as any).__walletTest=state;
    const provider={request:async({method,params}:{method:string;params?:unknown[]})=>{
      if(method==='eth_requestAccounts'||method==='eth_accounts')return [state.account];
      if(method==='eth_chainId')return state.chain;
      if(method==='eth_getBalance')return '0xf4240';
      if(method==='eth_sendTransaction'){state.sends++;if(state.reject)throw Error('User rejected the request');return txHash;}
      throw Error('Unsupported test-only wallet method: '+method);
    },on(event:string,listener:Function){(listeners[event]??=[]).push(listener);},removeListener(event:string,listener:Function){listeners[event]=(listeners[event]??[]).filter(x=>x!==listener);}};
    window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'test-wallet',name:'Test wallet'},provider}})));
  },{account,txHash});
  await page.goto('/');await page.locator('#wallet-open').click();await page.getByRole('button',{name:'Test wallet'}).click();
  await expect(page.locator('#wallet-submit')).toBeEnabled();
}
async function review(page:Page){await page.locator('#wallet-recipient').fill(recipient);await page.locator('#wallet-amount').fill('0.0000000000000001');await page.locator('#wallet-submit').click();await expect(page.getByRole('heading',{name:'本次检查通过'})).toBeVisible();}
async function signName(page:Page){const canvas=page.locator('#signature-canvas');await canvas.scrollIntoViewIfNeeded();const b=(await canvas.boundingBox())!;await page.mouse.move(b.x+30,b.y+45);await page.mouse.down();for(const [x,y] of [[48,35],[43,67],[70,54],[92,30],[88,78],[117,50]])await page.mouse.move(b.x+x,b.y+y,{steps:3});await page.mouse.up();}

test('home has no fabricated wallet, mobile navigation and empty signature state',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  await expect(page.getByRole('heading',{name:'新建付款',exact:true})).toBeVisible();await expect(page.locator('#wallet-submit')).toBeDisabled();
  await page.locator('#wallet-open').click();await expect(page.getByText('未发现浏览器钱包')).toBeVisible();await page.getByRole('button',{name:'关闭钱包选择'}).click();
  await page.getByRole('button',{name:'切换侧栏'}).click();await expect(page.getByRole('navigation',{name:'最近操作'})).toBeVisible();await page.getByRole('button',{name:'切换侧栏'}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('real review waits for handwriting, clear disables, wallet submission is separate and receipt restores',async({page})=>{
  const errors:string[]=[];page.on('pageerror',x=>errors.push(x.message));await wallet(page);await review(page);
  expect(await page.evaluate(()=>(window as any).__walletTest.sends)).toBe(0);await expect(page.locator('#wallet-sign')).toBeDisabled();
  await signName(page);await expect(page.locator('#wallet-sign')).toBeEnabled();await page.getByRole('button',{name:'清除',exact:true}).click();await expect(page.locator('#wallet-sign')).toBeDisabled();
  let receiptRechecks=0;
  page.on('request',r=>{if(r.url().endsWith('/receipt/recheck'))receiptRechecks++;});
  await page.route('**/api/wallet/reviews/*/broadcast',async route=>{
    const response=await route.fetch(),observed=await response.json();
    await route.fulfill({json:{...observed,evidenceRef:undefined,postState:undefined,receiptReport:{...observed.receiptReport,receiptStatus:'UNKNOWN',postStateStatus:'NOT_CHECKED',error:'RECEIPT_NOT_FOUND'}}});
  },{times:1});
  await signName(page);await page.screenshot({path:'.local/frontend-qa/review-desktop.png',fullPage:true});await page.locator('#wallet-sign').click();
  await expect(page.locator('#track-status')).toHaveText('等待链上结果');
  await expect(page.locator('#observation-summary')).toContainText('未保存');

  await expect(page.getByRole('heading',{name:'交易已确认'})).toBeVisible();expect(await page.evaluate(()=>(window as any).__walletTest.sends)).toBe(1);
  await expect(page.locator('#journey-events')).toContainText('证据已保存');await expect(page.locator('#wallet-history .history-item')).toHaveCount(1);
  const cards=page.locator('.wallet-route-steps > li');
  await expect(cards).toHaveCount(await page.locator('#journey-events > li').count());
  await expect(cards.last()).toHaveAttribute('data-status','SAVED');
  await expect(page.locator('.wallet-route-steps [data-status=RECEIPT_CONFIRMED]')).toHaveCount(1);
  await expect(page.locator('.wallet-route-steps [data-status=PASS]')).toHaveCount(0);
  await page.locator('.route-card').screenshot({path:'.local/frontend-qa/journey-desktop.png'});
  await page.setViewportSize({width:390,height:844});await expect(page.locator('.wallet-route')).toHaveAttribute('data-columns','1');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.route-card').screenshot({path:'.local/frontend-qa/journey-mobile.png'});
  await page.reload();await expect(page.getByRole('heading',{name:'交易已确认'})).toBeVisible();await expect(page.locator('#signature-section')).toBeHidden();
  expect(receiptRechecks).toBeGreaterThanOrEqual(1);expect(errors).toEqual([]);
});
test('changing account or chain invalidates handwritten confirmation without sending',async({page})=>{
  await wallet(page);await review(page);await signName(page);await expect(page.locator('#wallet-sign')).toBeEnabled();await page.evaluate(()=>(window as any).__walletTest.change());
  await expect(page.locator('#signature-section')).toBeHidden();expect(await page.evaluate(()=>(window as any).__walletTest.sends)).toBe(0);
});
test('unsupported amount shows real rule failure and no signature bypass',async({page})=>{
  await wallet(page);await page.locator('#wallet-recipient').fill(recipient);await page.locator('#wallet-amount').fill('1');await page.locator('#wallet-submit').click();
  await expect(page.getByRole('heading',{name:'发现风险'})).toBeVisible();await expect(page.locator('#track-reason')).toContainText('金额超过单笔上限');await expect(page.locator('#signature-section')).toBeHidden();
  expect(await page.evaluate(()=>(window as any).__walletTest.sends)).toBe(0);
});
test('wallet refusal consumes handwriting and requires a fresh review',async({page})=>{
  await wallet(page);await review(page);await signName(page);await page.evaluate(()=>(window as any).__walletTest.reject=true);await page.locator('#wallet-sign').click();
  await expect(page.locator('#wallet-error')).toContainText('签名或发送未完成');await expect(page.locator('#signature-section')).toBeHidden();await expect(page.getByRole('button',{name:'重新审查',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'重新审查',exact:true}).click();await expect(page.locator('#signature-section')).toBeVisible();await expect(page.locator('#wallet-sign')).toBeDisabled();
});
test('history is read-only after reload and transport failures resume the same review',async({page})=>{
  await wallet(page);await review(page);const url=page.url();await page.reload();await expect(page.getByRole('heading',{name:'本次检查通过'})).toBeVisible();await expect(page.locator('#signature-section')).toBeHidden();expect(page.url()).toBe(url);
  await page.route('**/api/wallet/reviews/*',r=>r.abort(),{times:1});await page.locator('#wallet-refresh').click();await expect(page.locator('#wallet-error')).toContainText('连接中断');await page.locator('#wallet-refresh').click();await expect(page.locator('#wallet-error')).toBeHidden();
});
test('narrow review shows real events, signatures, and reduced motion without overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});await wallet(page);await review(page);await signName(page);await expect(page.locator('#wallet-sign')).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.local/frontend-qa/review-mobile.png',fullPage:true});
});

test('lost review response retries the same request without creating a duplicate review',async({page})=>{
  await wallet(page);let original='';let firstReview='';
  await page.route('**/api/wallet/reviews',async route=>{original=route.request().postDataJSON().clientRequestId;const response=await route.fetch();firstReview=(await response.json()).reviewId;await route.abort();},{times:1});
  await page.locator('#wallet-recipient').fill(recipient);await page.locator('#wallet-amount').fill('0.0000000000000001');await page.locator('#wallet-submit').click();await expect(page.locator('#wallet-error')).toBeVisible();
  const retry=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/wallet/reviews'));await page.locator('#wallet-submit').click();expect((await retry).postDataJSON().clientRequestId).toBe(original);await expect(page.getByRole('heading',{name:'本次检查通过'})).toBeVisible();expect(page.url()).toContain(firstReview);await expect(page.locator('#wallet-history .history-item')).toHaveCount(1);
});

test('v2 confirms exact review once and sends no name or ink, including lost confirmation recovery',async({page,request})=>{
  await wallet(page);await review(page);let confirms=0;let payload:any;
  await page.route('**/api/wallet/reviews/*/confirm',async route=>{confirms++;payload=route.request().postDataJSON();await route.fetch();await route.abort();},{times:1});
  await signName(page);await page.locator('#wallet-sign').click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__walletTest.sends)).toBe(1);
  expect(confirms).toBe(1);expect(Object.keys(payload).sort()).toEqual(['account','chainId','confirmationNonce','handwritingAcknowledged','transactionDigest','walletSessionId','walletSessionRevision'].sort());expect(payload.handwritingAcknowledged).toBe(true);
  const id=new URL(page.url()).hash.split('review=')[1];const r=await(await request.get(`http://127.0.0.1:3122/api/wallet/reviews/${id}`)).json();expect(r.schemaVersion).toBe('wallet-review-v2');expect(r.userConfirmedAt).toBeGreaterThan(0);expect(r.status).toBe('CONSUMED');
});

for(const approve of [false,true])test(`v2 ERC20 ${approve?'approval':'transfer'} uses independent intent, confirms and keeps receipt uncovered`,async({page})=>{
  await wallet(page);await page.locator('#wallet-operation').selectOption(approve?'erc20_approve':'erc20_transfer');
  await page.locator('#wallet-token').fill('0x'+'3'.repeat(40));await page.locator('#wallet-recipient').fill('0x'+(approve?'4':'2').repeat(40));await page.locator('#wallet-amount').fill('100');
  const creating=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/wallet/reviews'));await page.locator('#wallet-submit').click();const body=(await creating).postDataJSON();expect(body.schemaVersion).toBe('wallet-review-v2');expect(body.transaction.to).toBe('0x'+'3'.repeat(40));expect(body.transaction.value).toBe('0x0');expect(body.intent.contractAction.amount).toBe('100');expect(body.transaction.data.slice(0,10)).toBe(approve?'0x095ea7b3':'0xa9059cbb');
  await expect(page.getByRole('heading',{name:'本次检查通过'})).toBeVisible();await expect(page.locator('#contract-summary')).toContainText('100');
  const broadcasts:string[]=[];page.on('request',r=>{if(r.url().endsWith('/broadcast'))broadcasts.push(r.url());});
  await signName(page);await page.locator('#wallet-sign').click();await expect(page.getByRole('heading',{name:'交易已提交'})).toBeVisible();await expect(page.locator('#decision-result')).toContainText('回执核对未覆盖');expect(broadcasts).toEqual([]);await expect(page.locator('#wallet-evidence')).toBeEmpty();
});

test('contract entry hides when backend disables it and unknown spender cannot sign',async({page})=>{
  await page.route('**/api/wallet/meta',async route=>{const response=await route.fetch();await route.fulfill({json:{...await response.json(),supportedOperations:['native_transfer']}});},{times:1});
  await wallet(page);await expect(page.locator('#operation-switch')).toBeHidden();await page.locator('#reconnect').click();await expect(page.locator('#operation-switch')).toBeVisible();
  await page.locator('#wallet-operation').selectOption('erc20_approve');await page.locator('#wallet-token').fill('0x'+'3'.repeat(40));await page.locator('#wallet-recipient').fill('0x'+'5'.repeat(40));await page.locator('#wallet-amount').fill('100');await page.locator('#wallet-submit').click();
  await expect(page.locator('#track-reason')).toContainText('授权对象未在允许范围内');await expect(page.locator('#signature-section')).toBeHidden();expect(await page.evaluate(()=>(window as any).__walletTest.sends)).toBe(0);
});

test('parcel route retains every backend step and links to its evidence without writes',async({page,request})=>{
  await wallet(page);await review(page);
  const id=new URL(page.url()).hash.split('review=')[1];
  const graph=async()=>await(await request.get(`http://127.0.0.1:3122/api/wallet/reviews/${id}/graph?after=0`)).json();
  const before=await graph();
  const cards=page.locator('.wallet-route-steps > li');
  await expect(cards).toHaveCount(before.events.length);
  expect(await cards.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-event-id')))).toEqual(before.events.map((e:any)=>e.eventId));
  await expect(page.locator('.wallet-route-steps [data-status=WAITING_SIGNATURE]')).toContainText('等待签名');
  const event=before.events.find((e:any)=>e.stage==='BALANCE_OBSERVATION');
  await page.locator(`.wallet-route-steps button[data-event-id="${event.eventId}"]`).click();
  await expect(page.locator(`#journey-events li[data-event-id="${event.eventId}"] details`)).toHaveAttribute('open','');
  const writes:string[]=[];page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  await page.reload();await expect(cards).toHaveCount(before.events.length);await expect(cards.last()).toHaveClass(/current/);expect(writes).toEqual([]);
});

test('parcel visits each received step in sequence with motion enabled',async({page})=>{
  await page.emulateMedia({reducedMotion:'no-preference'});await wallet(page);
  await page.evaluate(()=>{
    const route=document.querySelector('.wallet-route-steps')!;
    (window as any).__routeVisits=[];
    new MutationObserver(()=>{const seq=route.querySelector('.current')?.getAttribute('data-sequence'),visits=(window as any).__routeVisits;if(seq&&visits.at(-1)!==seq)visits.push(seq);}).observe(route,{subtree:true,attributes:true,attributeFilter:['class']});
  });
  await review(page);const count=await page.locator('.wallet-route-steps > li').count();
  await expect(page.locator('.wallet-route-steps > li').last()).toHaveClass(/current/,{timeout:10000});
  expect(await page.evaluate(()=>(window as any).__routeVisits)).toEqual(Array.from({length:count},(_,i)=>String(i+1)));
  expect(await page.evaluate(()=>(window as any).__walletTest.sends)).toBe(0);
});

test('parcel route loads all pages, keeps gap warnings and recovers missing events without inventing links',async({page,request})=>{
  await wallet(page);await review(page);const id=new URL(page.url()).hash.split('review=')[1];
  const source=await(await request.get(`http://127.0.0.1:3122/api/wallet/reviews/${id}/graph?after=0`)).json();
  const cursors:number[]=[];let gap=true;
  await page.route(`**/api/wallet/reviews/${id}/graph?*`,route=>{
    const after=Number(new URL(route.request().url()).searchParams.get('after'));cursors.push(after);
    const remaining=source.events.filter((ev:any)=>ev.sequence>after&&(!gap||ev.sequence!==2)),events=remaining.slice(0,2);
    return route.fulfill({json:{...source,events,hasMore:remaining.length>2,nextCursor:events.at(-1)?.sequence??after}});
  });
  await page.reload();await expect(page.locator('#graph-error')).toContainText('行动记录不完整');
  await expect(page.locator('.wallet-route-steps > li')).toHaveCount(source.events.length-1);
  await expect(page.locator('.wallet-route-paths > path')).toHaveCount(source.events.length-3);
  gap=false;await page.locator('#wallet-refresh').click();await expect(page.locator('#graph-error')).toBeHidden();
  await expect(page.locator('.wallet-route-steps > li')).toHaveCount(source.events.length);
  expect(await page.locator('.wallet-route-steps > li').evaluateAll(nodes=>nodes.map(n=>Number(n.getAttribute('data-sequence'))))).toEqual(source.events.map((ev:any)=>ev.sequence));
  await expect(page.locator('.wallet-route-paths > path')).toHaveCount(source.events.length-1);
  expect(cursors).toContain(1);expect(cursors.some(c=>c>2)).toBe(true);
});

test('local experience runs without backend or injected wallet, preserves real history, and exits cleanly',async({page})=>{
  const requests:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))requests.push(r.url());});
  await page.route('**/api/**',route=>route.abort());
  await page.addInitScript(()=>{
    (window as any).__realWalletCalls=0;
    (window as any).__discoveryCalls=0;
    (window as any).ethereum={request(){(window as any).__realWalletCalls++;throw Error('A real wallet must not be called during UI_MOCK');}};
    window.addEventListener('eip6963:requestProvider',()=>{(window as any).__discoveryCalls++;});
    localStorage.setItem('verdict-wallet-history:http://127.0.0.1:3122','[{"private":"unchanged"}]');
  });
  await page.goto('/?experience=1#wallet');
  await expect(page.locator('#demo-mode-badge')).toBeVisible();
  await expect(page.locator('#track-amount')).toHaveText('0.01 tBOT');
  await expect(page.getByRole('heading',{name:'本次检查通过'})).toBeVisible({timeout:12000});
  await expect(page.locator('.wallet-route-steps > li')).toHaveCount(7);
  await expect(page.locator('#wallet-sign')).toBeDisabled();
  await page.screenshot({path:'.local/frontend-qa/experience.png',fullPage:true});
  await signName(page);await expect(page.locator('#wallet-sign')).toBeEnabled();await page.locator('#wallet-sign').click();
  await expect(page.getByRole('heading',{name:'交易已确认'})).toBeVisible({timeout:10000});
  await expect(page.locator('.wallet-route-steps > li')).toHaveCount(13);
  await expect(page.locator('#wallet-evidence')).toBeEmpty();
  expect(requests).toEqual([]);
  expect(await page.evaluate(()=>(window as any).__realWalletCalls)).toBe(0);
  expect(await page.evaluate(()=>(window as any).__discoveryCalls)).toBe(0);
  expect(await page.evaluate(()=>localStorage.getItem('verdict-wallet-history:http://127.0.0.1:3122'))).toBe('[{"private":"unchanged"}]');
  await page.reload();await expect(page.locator('#track-amount')).toHaveText('0.01 tBOT');await expect(page.locator('#signature-section')).toBeVisible({timeout:12000});await expect(page.locator('#wallet-sign')).toBeDisabled();
  await page.getByRole('link',{name:'退出体验'}).click();await expect(page).toHaveURL(/\/#wallet$/);await expect(page.locator('#wallet-submit')).toBeDisabled();await expect(page.locator('#demo-mode-badge')).toBeHidden();
});

test('experience entry is reachable from audit and fits on mobile',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/#task');await page.getByRole('link',{name:'体验流程'}).click();
  await expect(page).toHaveURL(/experience=1/);await expect(page.locator('#demo-mode-badge')).toBeVisible();
  await expect(page.locator('.wallet-route')).toHaveAttribute('data-columns','1');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('streaming route keeps in-flight position, pauses at stops and follows the curved connector',async({page})=>{
  await page.emulateMedia({reducedMotion:'no-preference'});await page.goto('/');
  const result=await page.evaluate(async()=>{
    const modulePath='/src/wallet/journey.ts';
    const {mountJourneyRoute}=await import(modulePath);
    const root=document.createElement('div');root.style.cssText='width:1000px;position:absolute;top:0;left:0;background:white;z-index:10000';document.body.append(root);
    const component=mountJourneyRoute(root,()=>{});
    const reviewId='motion-check';
    const events=Array.from({length:5},(_,i)=>({graphVersion:'1.0.0',eventId:`motion-${i+1}`,sequence:i+1,at:new Date().toISOString(),agentId:'motion',runId:null,actionId:`action-${i+1}`,actionOrder:i+1,previousActionId:i?`action-${i}`:null,toolCallId:null,tool:null,phase:'EXECUTION',status:'OBSERVED',modelSource:'TEST_TRANSPORT',stage:'BALANCE_OBSERVATION',source:'RPC',parentEventId:i?`motion-${i}`:null}));
    component.update(reviewId,events.slice(0,2),true);
    const samples:Array<{at:number;x:number;y:number;current:string|null}>=[];
    const started=performance.now();
    await new Promise<void>(resolve=>{
      const sample=()=>{
        const at=performance.now()-started;
        // Repeat graph polling and append later stops while the parcel is still on its first leg.
        if(at>80&&at<480)component.update(reviewId,structuredClone(events.slice(0,Math.min(5,2+Math.floor(at/80)))),true);
        const transform=root.querySelector<SVGGElement>('.wallet-route-parcel')!.transform.baseVal.consolidate();
        if(transform)samples.push({at,x:transform.matrix.e,y:transform.matrix.f,current:root.querySelector('li.current')?.getAttribute('data-sequence')??null});
        if(at<4200)requestAnimationFrame(sample);else resolve();
      };requestAnimationFrame(sample);
    });
    const paths=[...root.querySelectorAll<SVGPathElement>('.wallet-route-paths path')];
    const first=paths[0],start=first.getPointAtLength(0),end=first.getPointAtLength(first.getTotalLength());
    const firstLeg=samples.filter(s=>s.current==='1');
    const backwards=firstLeg.slice(1).map((s,i)=>firstLeg[i].x-s.x);
    const stop=samples.filter(s=>Math.hypot(s.x-end.x,s.y-end.y)<.1);
    const turn=paths[3],turnLength=turn.getTotalLength();
    const turnSamples=samples.filter(s=>s.current==='4');
    const turnPoints=Array.from({length:401},(_,i)=>turn.getPointAtLength(turnLength*i/400));
    const turnError=Math.max(...turnSamples.map(s=>Math.min(...turnPoints.map(p=>Math.hypot(s.x-p.x,s.y-p.y)))));
    const visits=[...new Set(samples.map(s=>s.current))];
    const output={intermediate:firstLeg.filter(s=>s.x>start.x+3&&s.x<end.x-3).length,backwards:Math.max(0,...backwards),dwell:stop.length?stop.at(-1)!.at-stop[0].at:0,turnError,turnSamples:turnSamples.length,turnReachesEdge:turnSamples.some(s=>s.x>root.clientWidth-25),visits};
    component.destroy();root.remove();return output;
  });
  expect(result.intermediate).toBeGreaterThan(5);
  expect(result.backwards).toBeLessThan(1);
  expect(result.dwell).toBeGreaterThan(120);
  expect(result.turnSamples).toBeGreaterThan(5);
  expect(result.turnError).toBeLessThan(2);
  expect(result.turnReachesEdge).toBe(true);
  expect(result.visits).toEqual(['1','2','3','4','5']);
});


test('saved local payment conditions remain separate from a changed draft; cancellation and corrected attempt are both retained',async({page})=>{
  await wallet(page);
  await page.locator('#payment-label').fill('纸张供应商');await page.locator('#wallet-recipient').fill(recipient);
  await page.locator('#wallet-amount').fill('0.000000000000001');
  await page.getByRole('button',{name:'＋ 保存付款条件'}).click();
  await page.getByRole('button',{name:'确认并保存到本机'}).click();
  await expect(page.locator('#scope-preview')).toContainText('付款金额上限');
  await expect(page.locator('#scope-preview')).toContainText(recipient);
  const changed='0x'+'9'.repeat(40);await page.locator('#wallet-recipient').fill(changed);await page.locator('#wallet-amount').fill('0.0000000000000016');
  const creating=page.waitForRequest(r=>r.url().endsWith('/api/wallet/reviews')&&r.method()==='POST');
  await page.locator('#wallet-submit').click();const input=(await creating).postDataJSON();
  expect(input.intent.recipient).toBe(recipient);expect(input.transaction.to).toBe(changed);expect(input.intent.maxValueWei).toBe('1000');expect(BigInt(input.transaction.value)).toBe(1600n);
  await expect(page.getByRole('heading',{name:'发现风险'})).toBeVisible();await expect(page.locator('#payment-comparison .comparison-row.mismatch')).toHaveCount(2);
  await expect(page.locator('#decision-result')).toContainText('未进入签名');await expect(page.locator('#signature-section')).toBeHidden();
  const originalURL=page.url();await page.screenshot({path:'.local/frontend-qa/payment-difference.png',fullPage:true});
  await page.getByRole('button',{name:'取消本次付款'}).click();await expect(page.locator('#track-status')).toHaveText('已取消');
  await page.locator('#transfer-edit').click();await page.locator('#wallet-recipient').fill(recipient);await page.locator('#wallet-amount').fill('0.0000000000000008');await page.locator('#wallet-submit').click();
  await expect(page.getByRole('heading',{name:'本次检查通过'})).toBeVisible();
  await expect(page.locator('#confirmation-summary')).toContainText(recipient);await expect(page.locator('#wallet-sign')).toBeDisabled();
  await page.locator('#track-records').click();await expect(page.locator('.payment-record')).toHaveCount(2);await expect(page.locator('#payment-record-list')).toContainText('已取消');
  await page.goto(originalURL);await expect(page.locator('#track-status')).toHaveText('已取消');await expect(page.locator('#payment-comparison .comparison-row.mismatch')).toHaveCount(2);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'.local/frontend-qa/payment-difference-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>(window as any).__walletTest.sends)).toBe(0);
});

test('receipt observation retries are bounded and an unknown result never becomes a payment failure',async({page,request})=>{
  await wallet(page);await review(page);const id=new URL(page.url()).hash.split('review=')[1];
  const base=await(await request.get(`http://127.0.0.1:3122/api/wallet/reviews/${id}`)).json();
  const pending={...base,status:'CONSUMED',receiptReport:{txHash,transactionFound:false,receiptStatus:'UNKNOWN',blockNumber:null,blockHash:null,gasUsed:null,error:'TX_NOT_FOUND',postStateStatus:'NOT_CHECKED'}};
  let retries=0;
  await page.route(`**/api/wallet/reviews/${id}`,r=>r.fulfill({json:pending}));
  await page.route(`**/api/wallet/reviews/${id}/receipt/recheck`,r=>{retries++;return r.fulfill({json:pending});});
  await page.clock.install();await page.reload();await expect.poll(()=>retries).toBe(1);
  for(let attempt=2;attempt<=12;attempt++){await page.clock.fastForward(3100);await expect.poll(()=>retries).toBe(attempt);}
  await expect(page.locator('#receipt-tracking')).toContainText('查询已暂停');await expect(page.locator('#track-status')).toHaveText('等待链上结果');
  await page.clock.fastForward(30000);expect(retries).toBe(12);await expect(page.getByRole('heading',{name:'交易执行失败'})).toHaveCount(0);
});
