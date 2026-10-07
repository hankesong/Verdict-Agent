import { z } from 'zod';
import { WalletMetaSchema, WalletAddressSchema, WalletReviewSchema, WalletGraphPageSchema, WalletEvidenceReplaySchema, type WalletReview, type WalletIntent, type AgentGraphEvent } from '@verdict/protocol';
import { primary, secondary, request as realRequest, MetaSchema } from '../api';
import { escape as e, short } from '../view';
import { symbol } from '../shell';
import { discoverWallets, GuardedWallet, type WalletChoice } from './provider';
import { signaturePad } from './signature';
import { tokenCall } from './contract';
import { mountJourneyRoute } from './journey';
import { paymentLayout } from './payment-layout';
import { paymentPresetStore, type PaymentPreset } from './payment-presets';
import { actualPayment, paymentComparison, paymentMilestones, confirmationSummary, observationSummary, intentRecipient } from './payment-details';
import './payment.css';
import { createExperience, demoRecipient } from './demo';
import { experienceAvailable, experienceMode as demoMode, experienceURL } from './experience-mode';
import { reason, statuses, parseUnits, formatUnits, graphRows } from './presentation';

const RecentSchema = z.object({ id:z.string().uuid(), to:WalletAddressSchema, amount:z.string(), symbol:z.string(), status:z.string(), at:z.number(), label:z.string().max(80).optional(), chainId:z.string().optional(), txHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() });
type Recent = z.infer<typeof RecentSchema>;
const historyKey = 'verdict-wallet-history:' + primary;
const wait = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));

export function mountWalletUI(root:HTMLElement) {
  const demo=demoMode?createExperience():null;
  const request:typeof realRequest=(base,path,body,timeout)=>demo?demo.api(path,body):realRequest(base,path,body,timeout);
  root.innerHTML=paymentLayout();
  const $=<T extends HTMLElement=HTMLElement>(id:string)=>root.querySelector<T>('#'+id)!;
  const journey=mountJourneyRoute($('route-map-shell'),eventId=>{
    for(const row of $('journey-events').querySelectorAll<HTMLElement>('[data-event-id]')){
      const selected=row.dataset.eventId===eventId;row.classList.toggle('route-selected',selected);
      if(selected){row.querySelector('details')!.open=true;row.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
    }
  });
  const presets=paymentPresetStore('verdict-payment-presets:'+primary,!demoMode);
  let presetSession:{account:string;chainId:string}|null=null;
  let draftScope:WalletIntent|null=null;
  let selectedPreset:PaymentPreset|null=null,reviewLabel='',screen:'compose'|'records'|'review'='compose';
  let receiptTask:{id:string;attempts:number;started:number;state:'active'|'done'|'stopped';timer?:ReturnType<typeof setTimeout>;pending:boolean}|null=null;
  let meta:z.infer<typeof WalletMetaSchema>|null=null, review:WalletReview|null=null;

  let busy=false, signing=false, ownedId:string|null=null, signedId:string|null=null;
  let events:AgentGraphEvent[]=[], txHash:string|null=null, epoch=0, signatureReady=false, signatureBinding='';
  let recent:Recent[]=[];
  try {if(!demoMode)recent=z.array(RecentSchema).max(100).parse(JSON.parse(localStorage.getItem(historyKey)??'[]'));}catch{}
  const choices=new Map<string,WalletChoice>();
  const error=(value:unknown='')=>{const text=value instanceof Error?value.message:String(value);$('wallet-error').hidden=!text;$('wallet-error').textContent=text;};
  const wallet=new GuardedWallet((path,body)=>request(primary,path,body),()=>{
    ownedId=null;signatureBinding='';signatureReady=false;pad?.clear();$('wallet-balance').textContent='余额 —';
    if(selectedPreset&&(selectedPreset.account!==wallet.account||selectedPreset.chainId!==wallet.chainId))selectedPreset=null;
    if(draftScope&&(draftScope.account!==wallet.account||draftScope.chainId!==wallet.chainId))draftScope=null;
    updateSession();if(review)draw();
  });
  const pad=signaturePad($<HTMLCanvasElement>('signature-canvas'),ready=>{
    signatureReady=ready;signatureBinding=ready?(review?.transactionDigest??''):'';
    $('signature-placeholder').hidden=ready;$('signature-status').textContent=ready?'已签写':'待签写';updateSignature();
  });
  const network=()=>meta?.networks.find(n=>n.chainId===wallet.chainId);
  const networkFor=(r:WalletReview)=>meta?.networks.find(n=>n.chainId===r.transaction.chainId);
  const nativeSymbol=(r?:WalletReview)=> (r?networkFor(r):network())?.nativeSymbol??((r?.transaction.chainId??wallet.chainId)==='0x3c8'?'tBOT':(r?.transaction.chainId??wallet.chainId)==='0x1'?'ETH':'原生币');
  const operation=()=>$<HTMLSelectElement>('wallet-operation').value;
  const symbolFor=(r?:WalletReview)=>r?.intent.operation==='contract_call'?'最小单位':nativeSymbol(r);
  const amountFor=(r:WalletReview)=>actualPayment(r).amount;
  const destinationFor=(r:WalletReview)=>{const recipient=actualPayment(r).recipient;return /^0x[0-9a-fA-F]{40}$/.test(recipient)?recipient:r.transaction.to;};
  const networkName=(chainId:string)=>meta?.networks.find(n=>n.chainId===chainId)?.name??`Chain ${BigInt(chainId)}`;
  function showScreen(next:'compose'|'records'){
    screen=next;$('transfer-home').hidden=false;$('transfer-track').hidden=true;
    $('payment-compose').hidden=next!=='compose';$('payment-records').hidden=next!=='records';
    for(const button of root.querySelectorAll<HTMLButtonElement>('[data-payment-tab]')){button.classList.toggle('active',button.dataset.paymentTab===next);button.setAttribute('aria-selected',String(button.dataset.paymentTab===next));}
    updateOperation();renderRecords();
  }
  function renderRecords(){
    $('payment-record-count').textContent=String(recent.length);
    const filter=$<HTMLSelectElement>('payment-record-filter').value;
    const classify=(status:string)=>['BLOCKED','UNCERTAIN','INTERRUPTED','EXPIRED','REJECTED'].includes(status)?'attention':['SUCCESS','FAIL'].includes(status)?'done':status==='UNKNOWN'||status==='CONSUMED'?'waiting':'other';
    const items=recent.filter(item=>filter==='all'||classify(item.status)===filter);
    $('payment-record-list').innerHTML=items.length?items.map(item=>`<a class="payment-record" href="#wallet?review=${e(item.id)}"><div><strong>${e(item.label||'付款')}</strong><code>${e(item.to)}</code><time>${e(new Date(item.at).toLocaleString('zh-CN',{hour12:false}))}</time></div><span class="record-amount">${e(item.amount)} ${e(item.symbol)}</span><span class="record-status ${classify(item.status)}">${e(statuses[item.status]??item.status)}</span></a>`).join(''):'<div class="records-empty">暂无付款记录</div>';
  }
  function renderScope(){
    let amount=$<HTMLInputElement>('wallet-amount').value||'—',fee=$<HTMLInputElement>('wallet-fee').value||'—';
    const recipient=selectedPreset?.recipient??(draftScope?intentRecipient(draftScope):$<HTMLInputElement>('wallet-recipient').value||'待填写');
    if(selectedPreset){amount=formatUnits(selectedPreset.maxValueWei);fee=formatUnits(selectedPreset.maxTotalFeeWei);}
    else if(draftScope){amount=draftScope.operation==='native_transfer'?formatUnits(draftScope.maxValueWei):draftScope.contractAction.amount;fee=formatUnits(draftScope.maxTotalFeeWei);}
    $('scope-preview').innerHTML=`<div class="scope-preview"><dl><dt>付款对象</dt><dd><b>${e(selectedPreset?.label||$<HTMLInputElement>('payment-label').value||'本次付款')}</b></dd><dt>收款地址</dt><dd>${e(recipient)}</dd><dt>${selectedPreset||draftScope?.operation==='native_transfer'?'付款金额上限':'本次金额'}</dt><dd>${e(amount)} ${e(operation()==='native_transfer'?nativeSymbol():'最小单位')}</dd><dt>最高网络费用</dt><dd>${e(fee)} ${e(nativeSymbol())}</dd>${selectedPreset?'<dt>条件来源</dt><dd>本机保存 · 提交前核对</dd>':draftScope?'<dt>条件来源</dt><dd>上次提交的付款条件</dd>':''}</dl></div>`;
    $('preset-clear').hidden=!selectedPreset&&!draftScope;
    $<HTMLInputElement>('wallet-fee').readOnly=!!selectedPreset||!!draftScope;
  }
  function renderPresets(){
    const available=presets.list(wallet.account,wallet.chainId);
    $('preset-list').innerHTML=available.length?available.map(p=>`<div class="preset-item ${selectedPreset?.id===p.id?'selected':''}"><button type="button" data-preset="${p.id}"><strong>${e(p.label)}</strong><code>${e(short(p.recipient))}</code><small>上限 ${e(formatUnits(p.maxValueWei))} ${e(nativeSymbol())}</small></button><button type="button" class="preset-remove" data-remove-preset="${p.id}" aria-label="移除 ${e(p.label)}">×</button></div>`).join(''):`<div class="preset-empty">${wallet.account?'暂无常用付款条件':'连接钱包后选择常用付款条件'}</div>`;
  }
  function choosePreset(id:string){
    if(busy||signing)return;
    const p=presets.list(wallet.account,wallet.chainId).find(p=>p.id===id);if(!p)return;
    draftScope=null;selectedPreset=structuredClone(p);$<HTMLSelectElement>('wallet-operation').value='native_transfer';updateOperation();
    $<HTMLInputElement>('payment-label').value=p.label;$<HTMLInputElement>('wallet-recipient').value=p.recipient;$<HTMLInputElement>('wallet-amount').value='';$<HTMLInputElement>('wallet-fee').value=formatUnits(p.maxTotalFeeWei);renderPresets();renderScope();
  }
  function stopReceiptTracking(){if(receiptTask?.timer)clearTimeout(receiptTask.timer);receiptTask=null;}
  function renderTracking(){
    $('receipt-tracking').textContent=receiptTask&&receiptTask.id===review?.reviewId?(receiptTask.state==='active'?`本页查询链上结果 · ${receiptTask.attempts} / 12`:receiptTask.state==='stopped'?'查询已暂停，可继续查询':''):'';
  }
  function updateOperation(){
    const enabled=!!meta?.supportedOperations.includes('contract_call');
    $('operation-switch').hidden=!enabled;
    if(!enabled)$<HTMLSelectElement>('wallet-operation').value='native_transfer';
    const op=operation(),contract=op!=='native_transfer';
    $('token-fields').hidden=!contract;$<HTMLInputElement>('wallet-token').disabled=!contract;$<HTMLInputElement>('wallet-token').required=contract;
    $('transfer-title').textContent=screen==='records'?'付款记录':op==='erc20_approve'?'新建授权':'新建付款';
    $('recipient-label').textContent=op==='erc20_approve'?'授权对象':'收款地址';
    $('amount-label').textContent=contract?'数量（最小单位）':'付款金额';
    $<HTMLInputElement>('wallet-amount').placeholder=contract?'0':'0.00';
    $('operation-type').textContent=op==='erc20_approve'?'ERC-20 授权':contract?'ERC-20 转账':'原生币';
    $('wallet-symbol').textContent=contract?'最小单位':wallet.account?nativeSymbol():'—';
    $('wallet-balance').hidden=contract;$('wallet-limit').hidden=contract;
  }
  function updateSession(){
    const n=network(),s=wallet.account?short(wallet.account):'连接钱包';
    document.querySelector('#wallet-top-account')!.textContent=s;
    $('form-account').textContent=s;$('form-network').textContent=wallet.account?(demoMode?'模拟钱包 · '+(n?.name??'BOT Chain Testnet'):(n?.name??'当前网络未配置')):'选择发送账户';
    $('aside-network').textContent=n?.name??'未连接';$('wallet-symbol').textContent=wallet.account?symbolFor():'—';$('fee-symbol').textContent=wallet.account?symbolFor():'—';
    let status=!meta?'审查服务未连接':!meta.configured?'审查服务未配置':meta.reviewSchemaVersion!=='wallet-review-v2'||!meta.confirmationRequired?'审查接口版本不兼容':!wallet.account?'请先连接钱包':!n?.ready?'当前网络不可用':'';
    $('wallet-form-status').textContent=status;$('wallet-form-status').hidden=!status;
    $<HTMLButtonElement>('wallet-submit').disabled=busy||!meta?.configured||meta.reviewSchemaVersion!=='wallet-review-v2'||!meta.confirmationRequired||!wallet.account||!n?.ready;
    $<HTMLFieldSetElement>('wallet-fields').disabled=busy;
    if(n){if(!$<HTMLInputElement>('wallet-fee').value)$<HTMLInputElement>('wallet-fee').value=formatUnits(n.maxTotalFeeWei);$('wallet-limit').textContent=`单笔上限 ${formatUnits(n.maxValueWei)} ${symbolFor()}`;}
    $('wallet-disconnect').hidden=!wallet.account;updateOperation();renderPresets();renderScope();
  }
  function saveHistory(){
    if(review){const old=recent.find(x=>x.id===review!.reviewId);recent=[{id:review.reviewId,label:reviewLabel||old?.label,chainId:review.transaction.chainId,to:destinationFor(review),amount:amountFor(review),symbol:symbolFor(review),status:review.receiptReport?.receiptStatus??(txHash?'UNKNOWN':review.status),at:review.createdAt,...((txHash??old?.txHash)?{txHash:txHash??old!.txHash}: {})},...recent.filter(x=>x.id!==review!.reviewId)].sort((a,b)=>b.at-a.at).slice(0,40);}
    try{if(!demoMode)localStorage.setItem(historyKey,JSON.stringify(recent));}catch{}
    const list=document.querySelector('#wallet-history')!;
    document.querySelector('#history-count')!.textContent=String(recent.length);
    list.innerHTML=recent.length?recent.map(r=>`<a class="history-item ${review?.reviewId===r.id?'selected':''}" href="#wallet?review=${e(r.id)}"><span class="history-icon">${symbol('arrow')}</span><span><b>${e(r.label||`${r.amount} ${r.symbol}`)}</b><small>${e(short(r.to))}</small></span><i class="history-status ${r.status==='SUCCESS'?'good':['BLOCKED','FAIL','REJECTED'].includes(r.status)?'bad':''}" title="${e(statuses[r.status]??r.status)}"></i></a>`).join(''):'<p class="history-empty">暂无操作记录</p>';
    renderRecords();
  }
  function updateSignature(){
    const r=review,remaining=r?.expiresAt?Math.max(0,Math.ceil((r.expiresAt-Date.now())/1000)):0;
    const allowed=!!r&&r.status==='ALLOWED'&&ownedId===r.reviewId&&signedId!==r.reviewId&&!!wallet.account&&remaining>0&&!txHash&&!signing;
    $('signature-section').hidden=!allowed;
    $<HTMLButtonElement>('wallet-sign').disabled=!allowed||!signatureReady||signatureBinding!==r?.transactionDigest;
    $('permit-expiry').textContent=remaining>0?`${remaining}s`:'已过期';
    if(r?.status==='ALLOWED'&&!remaining&&!txHash&&!signing){$('track-status').textContent='审查已过期';$('track-reason').textContent='请重新审查';$('decision-result').innerHTML='<span class="decision-icon warn">!</span><h2>审查已过期</h2><p>请重新审查后签名。</p>';if(!$('track-actions').childElementCount)actions();}
  }
  function actions(){
    if(!review)return;
    const running=['QUEUED','REVIEWING'].includes(review.status);
    const cancellable=['QUEUED','REVIEWING','ALLOWED','BLOCKED','UNCERTAIN'].includes(review.status)&&!txHash&&!signing;
    const canSign=review.status==='ALLOWED'&&ownedId===review.reviewId&&signedId!==review.reviewId&&Date.now()<(review.expiresAt??0);
    $('track-actions').innerHTML=signing?'<p class="waiting-wallet">等待钱包确认…</p>':txHash&&review.intent.operation==='contract_call'?'<p class="waiting-wallet">回执核对未覆盖</p>':txHash&&review.transaction.chainId!=='0x3c8'?'<p class="waiting-wallet">当前网络的回执核对未覆盖</p>':txHash?(review.evidenceRef?'':'<button class="product-secondary" id="receipt-recheck">继续查询链上结果</button>'):running?'':canSign?'':'<button class="product-secondary" id="review-again">重新审查</button><button class="product-quiet" id="review-edit">修改付款</button>';
    if(cancellable)$('track-actions').insertAdjacentHTML('beforeend','<button class="product-quiet" id="review-cancel">取消本次付款</button>');
    $('review-cancel')?.addEventListener('click',async()=>{try{const id=review!.reviewId;await request(primary,`/api/wallet/reviews/${id}/cancel`,{});epoch++;ownedId=null;pad.clear();review=WalletReviewSchema.parse(await request(primary,`/api/wallet/reviews/${id}`));await loadGraph();draw();}catch(x){error(x);}});
    $('review-again')?.addEventListener('click',()=>{if(!wallet.account){openWallet();return;}if(review){fillReview();void submit();}});
    $('review-edit')?.addEventListener('click',()=>void edit());
    $('receipt-recheck')?.addEventListener('click',()=>void reportReceipt());
  }
  function draw(){
    if(!review)return;const r=review,n=networkFor(r),receipt=r.receiptReport;
    $('transfer-home').hidden=screen==='review';$('transfer-track').hidden=screen!=='review';
    $('track-amount').textContent=`${amountFor(r)} ${symbolFor(r)}`;$('track-to').textContent=destinationFor(r);$('track-network').textContent=n?.name??`Chain ${BigInt(r.transaction.chainId)}`;
    $('tracking-title').textContent=r.intent.operation==='contract_call'&&r.intent.contractAction.kind==='erc20_approve'?'授权进度':reviewLabel||'付款进度';
    $('track-payee-label').textContent=reviewLabel||'本次付款';
    $('payment-milestones').innerHTML=paymentMilestones(r,!!txHash);
    $('payment-comparison').innerHTML=paymentComparison(r,nativeSymbol(r),networkName);
    $('confirmation-summary').innerHTML=!txHash&&r.status==='ALLOWED'?confirmationSummary(r,nativeSymbol(r),networkName(r.transaction.chainId)):'';
    $('observation-summary').innerHTML=observationSummary(r,txHash);
    const contract=r.intent.operation==='contract_call';
    $('contract-summary').hidden=!contract;
    $('contract-summary').innerHTML=contract?`<dt>代币合约</dt><dd>${e(r.transaction.to)}</dd><dt>操作</dt><dd>${e(r.intent.operation==='contract_call'?r.intent.contractAction.kind:'')}</dd><dt>目标地址</dt><dd>${e(destinationFor(r))}</dd><dt>数量（最小单位）</dt><dd>${e(amountFor(r))}</dd>`:'';
    const status=signing?'等待钱包确认':txHash?(receipt?statuses[receipt.receiptStatus]:contract?'已提交 · 回执未核对':'等待回执'):statuses[r.status]??r.status;
    $('track-status').textContent=status;$('track-source').textContent=demoMode?'UI_MOCK':r.reviewer.source==='TEST_TRANSPORT'?'TEST_TRANSPORT':n?.chainId==='0x3c8'?'BOT Testnet':'LIVE';
    $('demo-mode-badge').hidden=!demoMode;
    $('track-reason').textContent=reason(receipt?.error??r.reason);$('track-id').textContent=short(r.reviewId);$('track-id').title=r.reviewId;
    const bad=['BLOCKED','UNCERTAIN','INTERRUPTED'].includes(r.status)||['FAIL','REJECTED'].includes(receipt?.receiptStatus??'');
    $('track-status').dataset.tone=bad?'warn':receipt?.receiptStatus==='SUCCESS'?'good':'neutral';
    journey.update(r.reviewId,events,ownedId===r.reviewId);
    $('decision-result').innerHTML=receipt?.receiptStatus==='SUCCESS'?'<span class="decision-icon good">✓</span><h2>交易已确认</h2>':receipt?.receiptStatus==='FAIL'?'<span class="decision-icon warn">!</span><h2>交易执行失败</h2>':receipt?.receiptStatus==='REJECTED'?'<span class="decision-icon warn">!</span><h2>交易与审查不匹配</h2>':txHash?`<span class="decision-icon">↗</span><h2>交易已提交</h2><p>${contract?'回执核对未覆盖':'等待链上回执'}</p>`:r.status==='ALLOWED'?'<span class="decision-icon good">✓</span><h2>本次检查通过</h2><p>核对本笔付款，再手写确认</p>':`<span class="decision-icon ${bad?'warn':''}">${bad?'!':symbol('shield')}</span><h2>${e(statuses[r.status]??r.status)}</h2><p>${e(reason(r.reason))}</p>${['BLOCKED','UNCERTAIN'].includes(r.status)?'<p class="signature-blocked">未进入签名</p>':''}`;
    $('confirmation-record').hidden=!r.userConfirmedAt;
    $('confirmation-record').innerHTML=r.userConfirmedAt?`<span>用户确认</span><time>${e(new Date(r.userConfirmedAt).toLocaleString('zh-CN',{hour12:false}))}</time><small>本次交易 · CLIENT_DECLARED</small>`:'';
    const open=new Set([...$('journey-events').querySelectorAll<HTMLLIElement>('li')].filter(x=>x.querySelector('details')?.open).map(x=>x.dataset.eventId));
    $('journey-events').innerHTML=events.length?graphRows(events):'<li class="journey-empty">等待行动记录…</li>';
    for(const li of $('journey-events').querySelectorAll<HTMLLIElement>('li'))if(open.has(li.dataset.eventId))li.querySelector('details')!.open=true;
    $('checks-count').textContent=String(r.checks.length);
    $('wallet-checks').innerHTML=r.checks.map(c=>`<details class="wallet-check"><summary><span>${e(reason(c.reason))}</span><b class="${c.status==='PASS'?'good-text':'warn-text'}">${e(c.status)}</b></summary><dl><dt>来源</dt><dd>${e(c.source)}</dd>${Object.entries(c.facts).filter(([k])=>k!=='coverage').map(([k,v])=>`<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('')}</dl></details>`).join('');
    $('wallet-receipt').innerHTML=txHash?`<dl class="receipt-fields"><dt>交易哈希</dt><dd>${e(txHash)}</dd>${receipt?.blockNumber?`<dt>区块</dt><dd>${BigInt(receipt.blockNumber).toString()}</dd>`:''}${receipt?.gasUsed?`<dt>Gas used</dt><dd>${BigInt(receipt.gasUsed).toString()}</dd>`:''}</dl>`:'';
    $('wallet-evidence').innerHTML=r.evidenceRef?`<div class="evidence-actions"><button id="evidence-download" class="product-quiet">下载审查证据 ↓</button><button id="evidence-replay" class="product-quiet">第二实例复验 ↗</button><p id="wallet-replay-result" role="status"></p></div>`:'';
    $('evidence-download')?.addEventListener('click',()=>void evidenceAction(false));$('evidence-replay')?.addEventListener('click',()=>void evidenceAction(true));
    actions();updateSignature();saveHistory();renderTracking();
  }
  async function loadGraph(){
    if(!review)return;const id=review.reviewId,generation=epoch;
    try{let cursor=0;for(const event of events){if(event.sequence!==cursor+1)break;cursor=event.sequence;}
      let conflict=false;
      while(true){
      const page=WalletGraphPageSchema.parse(await request(primary,`/api/wallet/reviews/${id}/graph?after=${cursor}`));
      if(generation!==epoch||review?.reviewId!==id)return;
      if(page.walletReviewId!==id||page.events.some(ev=>ev.walletReviewId!==id||ev.agentId!==page.agentId||ev.graphRunId!==page.graphRunId||ev.traceId!==page.traceId))throw Error('行动记录不匹配');
      const map=new Map(events.map(ev=>[ev.sequence,ev]));for(const ev of page.events){const old=map.get(ev.sequence);if(old&&JSON.stringify(old)!==JSON.stringify(ev)){conflict=true;continue;}if(!old)map.set(ev.sequence,ev);}
      events=[...map.values()].sort((a,b)=>a.sequence-b.sequence);
      if(!page.hasMore)break;if(page.nextCursor<=cursor)throw Error('行动记录游标异常');cursor=page.nextCursor;
    }
    if(conflict)throw Error('行动记录存在冲突');
    if(events.some((ev,index)=>ev.sequence!==index+1||(index>0&&ev.parentEventId&&ev.parentEventId!==events[index-1].eventId)))throw Error('行动记录不完整');
    $('graph-error').hidden=true;}catch(x){if(generation!==epoch||review?.reviewId!==id)return;$('graph-error').hidden=false;$('graph-error').textContent=x instanceof Error?x.message:'行动记录暂不可用';}
  }
  async function poll(owned:boolean){
    if(!review)return;const generation=epoch,id=review.reviewId;
    try{for(let i=0;i<400;i++){
      const next=owned?await wallet.poll():WalletReviewSchema.parse(await request(primary,`/api/wallet/reviews/${id}`));
      if(generation!==epoch)return;review=next;await loadGraph();if(generation!==epoch)return;draw();
      if(!['QUEUED','REVIEWING'].includes(next.status)&&!(demoMode&&txHash&&!next.receiptReport))return;await wait(500);
    }error('审查仍在进行，请刷新查看。');}catch(x){if(generation===epoch)error('连接中断，已保留本次操作。点击刷新继续查询。');}
  }
  async function submit(){
    if(busy||signing)return;error();
    try{
      if(!wallet.account||!wallet.chainId)throw Error('请先连接钱包');
      const to=WalletAddressSchema.parse($<HTMLInputElement>('wallet-recipient').value.trim()),fee=parseUnits($<HTMLInputElement>('wallet-fee').value.trim());
      const op=operation(),amount=$<HTMLInputElement>('wallet-amount').value.trim();
      let transaction, intent:WalletIntent;
      if(op==='native_transfer'){
        const value=parseUnits(amount);if(value<=0n)throw Error('转账金额必须大于零');
        transaction={chainId:wallet.chainId,from:wallet.account,to,value:'0x'+value.toString(16),data:'0x'};
        intent={chainId:wallet.chainId,account:wallet.account,recipient:selectedPreset?.recipient??to,maxValueWei:selectedPreset?.maxValueWei??value.toString(),maxTotalFeeWei:selectedPreset?.maxTotalFeeWei??fee.toString(),operation:'native_transfer'};
        if(!selectedPreset&&draftScope?.operation==='native_transfer')intent=structuredClone(draftScope);
      }else{
        if(!meta?.supportedOperations.includes('contract_call'))throw Error('合约审查未启用');
        if(op!=='erc20_transfer'&&op!=='erc20_approve')throw Error('操作不支持');
        const token=WalletAddressSchema.parse($<HTMLInputElement>('wallet-token').value.trim()),data=tokenCall(op,to,amount);
        transaction={chainId:wallet.chainId,from:wallet.account,to:token,value:'0x0',data};
        intent={chainId:wallet.chainId,account:wallet.account,recipient:token,maxValueWei:'0',maxTotalFeeWei:fee.toString(),operation:'contract_call',functionSelector:op==='erc20_approve'?'0x095ea7b3':'0xa9059cbb',contractAction:op==='erc20_approve'?{kind:op,spender:to,amount}:{kind:op,recipient:to,amount}};
        if(draftScope?.operation==='contract_call')intent=structuredClone(draftScope);
      }
      stopReceiptTracking();reviewLabel=$<HTMLInputElement>('payment-label').value.trim();busy=true;updateSession();pad.clear();signedId=null;epoch++;txHash=null;events=[];review=null;ownedId=null;$('transfer-track').hidden=true;$('transfer-home').hidden=false;
      const generation=epoch;
      const r=await wallet.review(transaction,intent);
      if(generation!==epoch){await request(primary,`/api/wallet/reviews/${r.reviewId}/cancel`,{});return;}
      review=r;ownedId=r.reviewId;screen='review';draw();location.hash=`wallet?review=${r.reviewId}`;await poll(true);
    }catch(x){error(x instanceof z.ZodError?'请输入有效的收款地址':x);}finally{busy=false;updateSession();}
  }
  function fillReview(){if(!review)return;draftScope=structuredClone(review.intent);selectedPreset=null;$<HTMLInputElement>('payment-label').value=reviewLabel;$<HTMLSelectElement>('wallet-operation').value=review.intent.operation==='contract_call'?review.intent.contractAction.kind:'native_transfer';updateOperation();$<HTMLInputElement>('wallet-token').value=review.intent.operation==='contract_call'?review.transaction.to:'';$<HTMLInputElement>('wallet-recipient').value=destinationFor(review);$<HTMLInputElement>('wallet-amount').value=amountFor(review);$<HTMLInputElement>('wallet-fee').value=formatUnits(review.intent.maxTotalFeeWei);}
  async function edit(fresh=false){
    if(signing){error('请先完成钱包确认。');return;}
    if(busy&&!review){error('正在确认提交结果，请稍候。');return;}
    try{if(ownedId&&review&&['QUEUED','REVIEWING','ALLOWED'].includes(review.status))await wallet.cancel();}catch(x){error(x);return;}
    if(review&&ownedId&&['QUEUED','REVIEWING','ALLOWED'].includes(review.status)){try{review=WalletReviewSchema.parse(await request(primary,`/api/wallet/reviews/${review.reviewId}`));saveHistory();}catch{}}
    stopReceiptTracking();epoch++;busy=false;pad.clear();if(!fresh)fillReview();else{selectedPreset=null;draftScope=null;$<HTMLFormElement>('wallet-form').reset();}
    review=null;ownedId=null;txHash=null;events=[];screen='compose';$('transfer-home').hidden=false;$('transfer-track').hidden=true;error();updateSession();saveHistory();showScreen('compose');location.hash='wallet';
  }
  async function reportReceipt(automatic=false){
    if(!review||!txHash||review.intent.operation==='contract_call'||review.transaction.chainId!=='0x3c8')return;
    const id=review.reviewId,generation=epoch,reportedHash=txHash;
    if(receiptTask?.id===id&&receiptTask.pending)return;
    if(!automatic||receiptTask?.id!==id){stopReceiptTracking();receiptTask={id,attempts:0,started:Date.now(),state:'active',pending:false};}
    const task=receiptTask!;
    if(task.attempts>=12||Date.now()-task.started>120000){task.state='stopped';renderTracking();return;}
    task.attempts++;task.pending=true;renderTracking();
    try{
      const path=review.receiptReport&&!demoMode?`/api/wallet/reviews/${id}/receipt/recheck`:`/api/wallet/reviews/${id}/broadcast`;
      const next=WalletReviewSchema.parse(await request(primary,path,review.receiptReport&&!demoMode?{}:{txHash:reportedHash},45000));
      if(generation!==epoch||receiptTask!==task||review?.reviewId!==id)return;
      if(next.reviewId!==id||(next.receiptReport&&next.receiptReport.txHash!==reportedHash))throw Error('回执记录与本次付款不符');
      review=next;await loadGraph();if(generation!==epoch)return;error();
    }catch(x){
      if(generation!==epoch||receiptTask!==task)return;
      try{const current=WalletReviewSchema.parse(await request(primary,`/api/wallet/reviews/${id}`));if(current.reviewId===id&&generation===epoch)review=current;}catch{}
      if(generation!==epoch||receiptTask!==task)return;
      error('尚未核实链上结果，交易哈希已保留。'+(x instanceof Error?x.message:''));
    }finally{task.pending=false;}
    if(generation!==epoch||receiptTask!==task||review?.reviewId!==id)return;
    const finished=!!review.evidenceRef||review.receiptReport?.receiptStatus==='REJECTED'||(demoMode&&review.receiptReport?.receiptStatus==='SUCCESS');
    task.state=finished?'done':task.attempts>=12||Date.now()-task.started>=120000?'stopped':'active';
    draw();
    if(task.state==='active')task.timer=setTimeout(()=>void reportReceipt(true),demoMode?750:3000);
  }
  async function evidenceAction(replay:boolean){
    if(demoMode||!review?.evidenceRef)return;const id=review.evidenceRef;
    try{
      if(replay){
        const [first,other]=await Promise.all([request(primary,'/api/meta'),request(secondary,'/api/meta')]);
        if(MetaSchema.parse(first).instanceId===MetaSchema.parse(other).instanceId)throw Error('第二实例配置指向当前实例');
        const packet=await request(primary,`/api/wallet/evidence/${id}`);
        const response=WalletEvidenceReplaySchema.parse(await request(secondary,'/api/wallet/evidence/replay',{packet}));
        if(review?.evidenceRef===id)$('wallet-replay-result').textContent=`${response.status==='MATCH'?'链上观察复验一致':response.status==='MISMATCH'?'链上观察不一致':'复验尚未核实'} · ${reason(response.reason)}`;
      }else{
        const response=await fetch(`${primary}/api/wallet/evidence/${id}`,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('证据下载失败');
        const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download=`${id}.wallet.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }
    }catch(x){error(x);}
  }
  function openWallet(){if(demoMode)return;const dialog=$<HTMLDialogElement>('wallet-dialog');if(!dialog.open)dialog.showModal();}
  if(!demoMode)discoverWallets(choice=>{choices.set(choice.id,choice);$('wallet-discovery-empty').hidden=choices.size>0;const button=document.createElement('button');button.className='wallet-choice';button.type='button';button.innerHTML=`${symbol('wallet')}<span>${e(choice.name)}</span><span>↗</span>`;button.onclick=async()=>{
    button.disabled=true;$('wallet-connect-error').hidden=true;
    try{await wallet.connect(choice.provider,choice.id);$<HTMLDialogElement>('wallet-dialog').close();updateSession();const account=wallet.account,chain=wallet.chainId;
      try{const balance=await choice.provider.request({method:'eth_getBalance',params:[account,'latest']});if(account===wallet.account&&chain===wallet.chainId&&typeof balance==='string'&&/^0x[0-9a-f]+$/i.test(balance))$('wallet-balance').textContent=`余额 ${formatUnits(balance)} ${symbolFor()}`;}catch{$('wallet-balance').textContent='余额 —';}
    }catch(x){$('wallet-connect-error').hidden=false;$('wallet-connect-error').textContent=x instanceof Error?x.message:'钱包连接失败';}finally{button.disabled=false;}
  };$('wallet-choices').append(button);});
  $('wallet-connect-card').onclick=openWallet;document.querySelector<HTMLButtonElement>('#wallet-open')!.onclick=openWallet;
  $('wallet-dialog-close').onclick=()=>$<HTMLDialogElement>('wallet-dialog').close();
  $('wallet-disconnect').onclick=()=>{wallet.disconnect();$('wallet-balance').textContent='余额 —';$<HTMLDialogElement>('wallet-dialog').close();};
  $('signature-clear').onclick=()=>pad.clear();$('wallet-operation').onchange=()=>{selectedPreset=null;draftScope=null;pad.clear();updateOperation();renderPresets();renderScope();};
  $('wallet-sign').onclick=async()=>{
    if(!review||!signatureReady||signatureBinding!==review.transactionDigest||ownedId!==review.reviewId||signing)return;
    const r=review;signing=true;pad.clear();signedId=r.reviewId;error();draw();
    try{txHash=await wallet.send(r,true);saveHistory();signing=false;await loadGraph();draw();await reportReceipt();}catch(x){signing=false;ownedId=null;error('签名或发送未完成，请检查钱包记录后重新审查。'+(x instanceof Error?x.message:''));await loadGraph();draw();}
  };
  $('payment-today').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
  for(const button of root.querySelectorAll<HTMLButtonElement>('[data-payment-tab]'))button.onclick=()=>showScreen(button.dataset.paymentTab as 'compose'|'records');
  $('payment-record-filter').onchange=renderRecords;
  $('track-records').onclick=()=>{showScreen('records');location.hash='wallet';};
  $('wallet-form').addEventListener('input',renderScope);
  $('preset-clear').onclick=()=>{selectedPreset=null;draftScope=null;renderPresets();renderScope();};
  $('preset-list').onclick=event=>{const target=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(target?.dataset.preset)choosePreset(target.dataset.preset);if(target?.dataset.removePreset){try{presets.remove(target.dataset.removePreset);if(selectedPreset?.id===target.dataset.removePreset)selectedPreset=null;renderPresets();renderScope();}catch{error('未能更新本机付款条件');}}};
  $('preset-add').onclick=()=>{
    if(busy||signing)return;
    if(!wallet.account||!wallet.chainId){openWallet();return;}
    if(operation()!=='native_transfer'){error('当前付款条件仅支持保存原生币收款信息');return;}
    presetSession={account:wallet.account,chainId:wallet.chainId};
    $<HTMLInputElement>('preset-label').value=$<HTMLInputElement>('payment-label').value;
    $<HTMLInputElement>('preset-recipient').value=$<HTMLInputElement>('wallet-recipient').value;
    $<HTMLInputElement>('preset-limit').value=selectedPreset?formatUnits(selectedPreset.maxValueWei):$<HTMLInputElement>('wallet-amount').value;
    $<HTMLInputElement>('preset-fee').value=$<HTMLInputElement>('wallet-fee').value;
    $('preset-network').textContent=network()?.name??wallet.chainId;$('preset-account').textContent=wallet.account;$('preset-error').hidden=true;
    $<HTMLDialogElement>('preset-dialog').showModal();
  };
  $('preset-close').onclick=()=>$<HTMLDialogElement>('preset-dialog').close();
  $('preset-form').onsubmit=event=>{event.preventDefault();try{
    if(!wallet.account||!wallet.chainId)throw Error('请重新连接钱包');
    if(presetSession?.account!==wallet.account||presetSession.chainId!==wallet.chainId)throw Error('钱包账户或网络已变化，请重新保存');
    const preset=presets.add({label:$<HTMLInputElement>('preset-label').value.trim(),account:wallet.account,chainId:wallet.chainId,recipient:WalletAddressSchema.parse($<HTMLInputElement>('preset-recipient').value.trim()),maxValueWei:parseUnits($<HTMLInputElement>('preset-limit').value.trim()).toString(),maxTotalFeeWei:parseUnits($<HTMLInputElement>('preset-fee').value.trim()).toString()});
    $<HTMLDialogElement>('preset-dialog').close();choosePreset(preset.id);
  }catch(x){$('preset-error').hidden=false;$('preset-error').textContent=x instanceof z.ZodError?'请核对名称与收款地址':x instanceof Error?x.message:'保存失败';}};
  $('transfer-edit').onclick=()=>void edit();$('wallet-form').onsubmit=event=>{event.preventDefault();void submit();};
  $('wallet-demo-start').hidden=!experienceAvailable||demoMode;
  $('wallet-demo-start').onclick=()=>location.assign(experienceURL(true));
  $('wallet-refresh').onclick=()=>{error();if(txHash)void reportReceipt();else void poll(ownedId===review?.reviewId);};
  window.addEventListener('verdict:new-transfer',()=>void edit(true));
  const route=async()=>{const id=new URLSearchParams(location.hash.split('?')[1]??'').get('review');if(!location.hash.startsWith('#wallet')||!id)return;if(id===review?.reviewId){screen='review';draw();return;}if(signing){error('请先完成钱包确认。');return;}if(!/^[0-9a-f-]{36}$/i.test(id))return;
    stopReceiptTracking();epoch++;const generation=epoch;busy=false;pad.clear();events=[];ownedId=null;screen='review';selectedPreset=null;draftScope=null;reviewLabel=recent.find(r=>r.id===id)?.label??'';txHash=recent.find(r=>r.id===id)?.txHash??null;error();
    try{const restored=WalletReviewSchema.parse(await request(primary,`/api/wallet/reviews/${id}`));if(generation!==epoch)return;review=restored;txHash=review.receiptReport?.txHash??txHash;draw();await poll(false);if(txHash&&!review.evidenceRef&&review.receiptReport?.receiptStatus!=='REJECTED')void reportReceipt();}catch(x){if(generation===epoch)error(x);}
  };
  window.addEventListener('hashchange',()=>void route());
  const loadMeta=async()=>{try{meta=WalletMetaSchema.parse(await request(primary,'/api/wallet/meta'));updateSession();if(review)draw();}catch{meta=null;updateSession();}};
  document.querySelector('#reconnect')!.addEventListener('click',()=>void loadMeta());
  setInterval(updateSignature,500);saveHistory();updateSession();
  void loadMeta().then(async()=>{
    if(demo){
      location.hash='wallet';
      await wallet.connect(demo.provider,'ui-mock-wallet');
      $<HTMLInputElement>('wallet-recipient').value=demoRecipient;
      $<HTMLInputElement>('wallet-amount').value='0.01';
      $('wallet-balance').textContent='余额 1 tBOT';
      document.querySelector<HTMLButtonElement>('#wallet-open')!.disabled=true;
      $<HTMLButtonElement>('wallet-connect-card').disabled=true;
      $('wallet-sign').querySelector('span')!.textContent='确认并模拟签名';
      await submit();
    }else await route();
  }).catch(error);

}
