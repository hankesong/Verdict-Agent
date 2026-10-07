import type { AgentGraphEvent } from '@verdict/protocol';
import { escape as e } from '../view';
import { reason } from './presentation';
import './journey.css';

const stageLabels:Record<string,string>={WALLET_SESSION:'钱包会话',TRANSACTION_INTENT:'交易登记',BALANCE_OBSERVATION:'余额检查',NONCE_OBSERVATION:'交易序号检查',HARD_RULE:'规则检查',RPC_PREFLIGHT:'链上预执行',PI_REVIEW:'Agent 复核',PERMIT:'执行许可',BROADCAST:'交易广播',RECEIPT:'回执核对',POST_STATE:'执行后状态核对',EVIDENCE:'证据保存',EVIDENCE_REPLAY:'证据复验'};
const stateLabels:Record<string,string>={LOCKED:'参数已锁定',OBSERVED:'已观测',PASSED:'检查通过',ALLOW:'允许',BLOCK:'已拦截',UNCERTAIN:'无法确定',WAITING_SIGNATURE:'等待签名',CONSUMED:'许可已消费',PENDING:'等待核对',BROADCAST:'已广播',RECEIPT_CONFIRMED:'回执已确认',RECEIPT_FAILED:'交易执行失败',POST_STATE_RECHECKED:'已核对',SAVED:'已保存',UNKNOWN:'未知',UNVERIFIABLE:'不可复验',CANCELLED:'已取消',INTERRUPTED:'已中断',ERROR:'失败',STOPPED:'已停止',RUNNING:'进行中',COMPLETED:'完成'};
function tone(event:AgentGraphEvent){return ['BLOCK','FAIL','ERROR','RECEIPT_FAILED'].includes(event.status)?'bad':['UNCERTAIN','UNKNOWN','UNVERIFIABLE','INTERRUPTED','CANCELLED','STOPPED'].includes(event.status)?'warn':['WAITING_SIGNATURE','PENDING','RUNNING'].includes(event.status)?'waiting':'neutral';}
const svgNS='http://www.w3.org/2000/svg';
type Point={x:number;y:number};

export function mountJourneyRoute(root:HTMLElement,onSelect:(eventId:string)=>void){
  root.innerHTML='<div class="wallet-route" role="region" aria-label="交易审查路线"><svg class="wallet-route-lines" aria-hidden="true"><g class="wallet-route-paths"></g><g class="wallet-route-parcel" hidden><circle r="17" fill="#f4eee1" stroke="#e0d4bd"/><path d="m0-10 10 5v11L0 12-10 6V-5z" fill="#e5d1af" stroke="#987648" stroke-width="1.2"/><path d="m-10-5 10 5 10-5M0 0v12m-5-20 10 5v5" fill="none" stroke="#987648" stroke-width="1.2"/></g></svg><ol class="wallet-route-steps" aria-label="审查步骤"></ol><p class="wallet-route-empty">等待行动记录…</p></div>';
  const container=root.querySelector<HTMLElement>('.wallet-route')!,list=root.querySelector<HTMLOListElement>('ol')!,svg=root.querySelector<SVGSVGElement>('svg')!,paths=root.querySelector<SVGGElement>('.wallet-route-paths')!,parcel=root.querySelector<SVGGElement>('.wallet-route-parcel')!,empty=root.querySelector<HTMLElement>('.wallet-route-empty')!;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  type Motion={from:string;to:string;elapsed:number;duration:number};
  let events:AgentGraphEvent[]=[],key='',settledId:string|null=null,motion:Motion|null=null;
  let frame=0,layoutFrame=0,lastFrame=0,dwell=0,animateMode=false,visible=false,width=0,height=0;
  let points:Point[]=[],segments:Array<SVGPathElement|null>=[];
  function stopFrame(){cancelAnimationFrame(frame);frame=0;lastFrame=0;}
  function place(point:Point){
    parcel.removeAttribute('hidden');
    // SVG transform attributes use unitless coordinates, including intermediate frames.
    parcel.setAttribute('transform',`translate(${point.x} ${point.y})`);
  }
  function mark(index:number){
    if(!events[index]||!points[index])return;
    settledId=events[index].eventId;place(points[index]);
    for(const [i,item] of [...list.children].entries()){
      item.classList.toggle('current',i===index);
      if(i===index)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');
    }
  }
  function paintMotion(){
    if(!motion)return;
    const index=events.findIndex(event=>event.eventId===motion!.to),path=segments[index];
    if(index<1||events[index-1].eventId!==motion.from||!path){motion=null;return;}
    const t=Math.min(1,motion.elapsed/motion.duration),distance=t*t*(3-2*t)*path.getTotalLength();
    place(path.getPointAtLength(distance));
  }
  function tick(now:number){
    frame=0;if(!visible||!animateMode||reduced.matches)return;
    const delta=lastFrame?Math.min(64,now-lastFrame):0;lastFrame=now;
    if(motion){
      motion.elapsed+=delta;paintMotion();
      if(motion&&motion.elapsed>=motion.duration){
        const index=events.findIndex(event=>event.eventId===motion!.to);
        motion=null;mark(index);dwell=200;
      }
    }else{
      dwell=Math.max(0,dwell-delta);
      const index=events.findIndex(event=>event.eventId===settledId),next=index+1,path=segments[next];
      if(dwell===0&&next<events.length&&path){
        motion={from:events[index].eventId,to:events[next].eventId,elapsed:0,duration:Math.max(420,Math.min(1200,path.getTotalLength()*2))};
      }
    }
    const next=events.findIndex(event=>event.eventId===settledId)+1;
    if(motion||(next<events.length&&segments[next]))frame=requestAnimationFrame(tick);
    else lastFrame=0;
  }
  function resume(){if(!frame&&visible&&events.length&&animateMode&&!reduced.matches){lastFrame=0;frame=requestAnimationFrame(tick);}}
  function layout(){
    const bounds=container.getBoundingClientRect();visible=bounds.width>0&&container.offsetHeight>0;
    if(!visible){stopFrame();return;}
    const columns=bounds.width>=900?4:bounds.width>=660?3:bounds.width>=450?2:1;
    container.dataset.columns=String(columns);list.style.setProperty('--route-columns',String(columns));
    for(const [i,item] of [...list.children].entries()){
      const row=Math.floor(i/columns),col=i%columns;
      (item as HTMLElement).style.gridColumn=String(row%2?columns-col:col+1);
      (item as HTMLElement).style.gridRow=String(row+1);
    }
    points=[...list.children].map(item=>{const box=item.getBoundingClientRect();return columns===1?{x:20,y:box.top-bounds.top+box.height/2}:{x:box.left-bounds.left+box.width/2,y:box.top-bounds.top-20};});
    svg.setAttribute('viewBox',`0 0 ${bounds.width} ${container.offsetHeight}`);paths.replaceChildren();segments=[];
    points.forEach((b,i)=>{
      const a=points[i-1],prior=events[i-1];
      if(!a||events[i].sequence!==prior.sequence+1||(events[i].parentEventId&&events[i].parentEventId!==prior.eventId)){segments.push(null);return;}
      const path=document.createElementNS(svgNS,'path');let d=`M${a.x} ${a.y}`;
      if(columns===1||a.y===b.y)d+=` L${b.x} ${b.y}`;
      else{const x=Math.floor((i-1)/columns)%2?18:bounds.width-18,inside=x>a.x?-12:12;d+=` H${x+inside} Q${x} ${a.y} ${x} ${a.y+12} V${b.y-12} Q${x} ${b.y} ${x+inside} ${b.y} H${b.x}`;}
      path.setAttribute('d',d);paths.append(path);segments.push(path);
    });
    // Layout may replace paths while moving. Keep the same leg and elapsed time.
    if(!animateMode||reduced.matches){stopFrame();motion=null;dwell=0;mark(events.length-1);return;}
    if(motion){paintMotion();}
    if(!motion){const index=events.findIndex(event=>event.eventId===settledId);mark(index<0?0:index);}
    resume();
  }
  function scheduleLayout(){cancelAnimationFrame(layoutFrame);layoutFrame=requestAnimationFrame(layout);}
  const observer=new ResizeObserver(([entry])=>{if(entry.contentRect.width!==width||entry.contentRect.height!==height){width=entry.contentRect.width;height=entry.contentRect.height;scheduleLayout();}});observer.observe(container);
  reduced.addEventListener('change',scheduleLayout);
  list.addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-event-id]');if(button)onSelect(button.dataset.eventId!);});
  return {
    update(reviewId:string,incoming:AgentGraphEvent[],animate:boolean){
      if(key!==reviewId){stopFrame();key=reviewId;events=[];points=[];segments=[];settledId=null;motion=null;dwell=0;list.replaceChildren();paths.replaceChildren();parcel.setAttribute('hidden','');empty.hidden=false;}
      const modeChanged=animateMode!==animate;animateMode=animate;
      if(incoming.length===events.length&&incoming.every((event,i)=>event===events[i])&&!modeChanged)return;
      events=[...incoming].sort((a,b)=>a.sequence-b.sequence);empty.hidden=events.length>0;
      const existing=new Map([...list.children].map(node=>[(node as HTMLElement).dataset.eventId,node]));
      for(const [index,event] of events.entries()){
        let item=existing.get(event.eventId) as HTMLLIElement|undefined;
        if(!item){
          item=document.createElement('li');item.dataset.eventId=event.eventId;item.dataset.sequence=String(event.sequence);item.dataset.status=event.status;item.dataset.tone=tone(event);
          item.innerHTML=`<button type="button" data-event-id="${e(event.eventId)}" aria-label="第 ${event.sequence} 步 ${e(stageLabels[event.stage??'']??'审查活动')} · ${e(stateLabels[event.status]??event.status)}"><span class="wallet-step-heading"><span>${String(event.sequence).padStart(2,'0')}</span><span>${e(event.source??'')}</span></span><strong>${e(stageLabels[event.stage??'']??'审查活动')}</strong><span class="wallet-step-state">${e(stateLabels[event.status]??event.status)}</span><time datetime="${e(event.at)}">${e(new Date(event.at).toLocaleTimeString('zh-CN',{hour12:false}))}</time>${event.reasonCode?`<span class="wallet-step-reason">${e(reason(event.reasonCode))}</span>`:''}</button>`;
        }
        if(list.children[index]!==item)list.insertBefore(item,list.children[index]??null);
      }
      scheduleLayout();
    },
    destroy(){stopFrame();cancelAnimationFrame(layoutFrame);observer.disconnect();reduced.removeEventListener('change',scheduleLayout);},
  };
}
