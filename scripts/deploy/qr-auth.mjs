import {createServer} from 'node:http';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const COOKIE='__Host-verdict_session';
const digest=value=>createHash('sha256').update(value).digest('hex');
const mac=(key,value)=>createHmac('sha256',key).update(value).digest('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function readState(file){
 const state=JSON.parse(readFileSync(file,'utf8'));
 if(state.version!==1||!/^https:\/\/[a-z0-9.-]+$/.test(state.origin)||!/^[a-f0-9]{64}$/.test(state.secret)||!Array.isArray(state.grants)||state.grants.length>50||state.grants.some(g=>!/^[a-f0-9]{32}$/.test(g.id)||!/^[a-f0-9]{64}$/.test(g.hash)||!Number.isSafeInteger(g.expiresAt)))throw Error('Invalid QR access state');
 return state;
}
function saveState(file,state){
 mkdirSync(dirname(file),{recursive:true,mode:0o700});
 const temporary=file+'.'+randomBytes(8).toString('hex')+'.tmp';
 writeFileSync(temporary,JSON.stringify(state)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,file);
}
export function issueQR(file,origin,hours=24){
 if(!/^https:\/\/[a-z0-9.-]+$/.test(origin)||!Number.isInteger(hours)||hours<1||hours>24)throw Error('Invalid origin or lifetime');
 const state=existsSync(file)?readState(file):{version:1,origin,secret:randomBytes(32).toString('hex'),grants:[]};
 if(state.origin!==origin)throw Error('QR origin mismatch');
 const token=randomBytes(32).toString('base64url'),expiresAt=Date.now()+hours*3600000,id=randomBytes(16).toString('hex');
 state.grants=state.grants.filter(g=>g.expiresAt>Date.now());
 if(state.grants.length>=50)throw Error('Revoke old QR grants first');
 state.grants.push({id,hash:digest(token),expiresAt});saveState(file,state);
 return {url:origin+'/login#'+token,id,expiresAt};
}
export function revokeQR(file,id){
 const state=readState(file);state.grants=state.grants.filter(g=>g.id!==id);saveState(file,state);
}
const loginScript=`const title=document.querySelector('h1'),note=document.querySelector('p');const token=location.hash.slice(1);history.replaceState(null,'','/login');if(!/^[A-Za-z0-9_-]{43}$/.test(token)){title.textContent='登录链接无效';note.textContent='请使用新的登录二维码';}else{fetch('/_login/exchange',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r=>{if(!r.ok)throw Error();location.replace('/#wallet');}).catch(()=>{title.textContent='无法登录';note.textContent='二维码已过期或已撤销，请重新获取';});}`;
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Verdict · 登录</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8faf9;color:#304532;font:16px system-ui,sans-serif}main{text-align:center;padding:36px}b{font-size:32px;letter-spacing:-1px}h1{font-size:20px;font-weight:500;margin:30px 0 12px}p{color:#788674;font-size:14px}a{color:#537d45;display:inline-block;margin-top:25px}</style></head><body><main><b>verdict.</b><h1>正在登录…</h1><p>即将进入付款工作台</p><a href="/">使用账号登录</a></main><script>${loginScript}</script></body></html>`;
const scriptHash=createHash('sha256').update(loginScript).digest('base64');
export function createQRServer(file){
 return createServer(async(req,res)=>{
  const respond=(status,body='',headers={})=>{res.writeHead(status,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',...headers});res.end(body);};
  try{
   if(req.headers.host!=='127.0.0.1'&&!/^127\.0\.0\.1:\d+$/.test(req.headers.host??''))return respond(403);
   if(req.url==='/health')return respond(200,'ok');
   if(req.url==='/login'&&req.method==='GET')return respond(200,html,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`});
   if(req.url==='/check'){
    const state=readState(file),cookies=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));
    if(cookies.length!==1)return respond(401);
    const token=cookies[0].slice(COOKIE.length+1);
    if(token.length>1024)return respond(401);
    const parts=token.split('.');
    if(parts.length!==2||!equal(mac(state.secret,parts[0]),parts[1]))return respond(401);
    const session=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    const grant=state.grants.find(g=>g.id===session.grantId);
    if(!grant||!Number.isSafeInteger(session.expiresAt)||session.expiresAt<=Date.now()||session.expiresAt>grant.expiresAt||grant.expiresAt<=Date.now())return respond(401);
    return respond(204,'',{'X-Verdict-User':'verdict'});
   }
   if(req.url==='/exchange'&&req.method==='POST'){
    const state=readState(file);
    if(req.headers.origin!==state.origin||!req.headers['content-type']?.startsWith('application/json'))return respond(403);
    let data='',size=0;
    for await(const chunk of req){size+=chunk.length;if(size>1024)return respond(413);data+=chunk.toString('utf8');}
    const input=JSON.parse(data);
    if(!input||Object.keys(input).length!==1||!/^[A-Za-z0-9_-]{43}$/.test(input.token??''))return respond(401);
    const grant=state.grants.find(g=>g.expiresAt>Date.now()&&equal(g.hash,digest(input.token)));
    if(!grant)return respond(401);
    const expiresAt=Math.min(grant.expiresAt,Date.now()+8*3600000),payload=Buffer.from(JSON.stringify({grantId:grant.id,expiresAt,nonce:randomBytes(16).toString('hex')})).toString('base64url');
    return respond(200,'{"ok":true}',{'Content-Type':'application/json','Set-Cookie':`${COOKIE}=${payload}.${mac(state.secret,payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor((expiresAt-Date.now())/1000)}`});
   }
   return respond(404);
  }catch{return respond(req.url==='/check'?401:400);}
 });
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,file,arg,value]=process.argv.slice(2);
 if(!file)throw Error('Usage: qr-auth.mjs serve STATE_FILE PORT | issue STATE_FILE HTTPS_ORIGIN HOURS | revoke STATE_FILE GRANT_ID');
 if(command==='issue')console.log(JSON.stringify(issueQR(resolve(file),arg,Number(value??24))));
 else if(command==='revoke'){revokeQR(resolve(file),arg);console.log('QR access revoked.');}
 else if(command==='serve'){
  const server=createQRServer(resolve(file));server.headersTimeout=5000;server.requestTimeout=5000;
  server.listen(Number(arg??3130),'127.0.0.1',()=>console.log('QR login gateway ready.'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
 }else throw Error('Unknown QR command');
}
