import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {issueQR,revokeQR,createQRServer} from './qr-auth.mjs';

test('QR exchange issues secure session, preserves no raw token, and revocation invalidates it',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'verdict-qr-')),file=join(dir,'state.json'),origin='https://verdict.example';
 const issued=issueQR(file,origin),token=new URL(issued.url).hash.slice(1),server=createQRServer(file);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.ok(!readFileSync(file,'utf8').includes(token));
  assert.equal((await fetch(base+'/check')).status,401);
  const page=await fetch(base+'/login');assert.equal(page.status,200);assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  assert.ok((await page.text()).includes("history.replaceState(null,'','/login')"));
  const exchange=(value,from=origin)=>fetch(base+'/exchange',{method:'POST',headers:{'Content-Type':'application/json',Origin:from},body:JSON.stringify({token:value})});
  assert.equal((await exchange(token,'https://evil.example')).status,403);
  assert.equal((await exchange('x'.repeat(43))).status,401);
  const response=await exchange(token);assert.equal(response.status,200);
  const header=response.headers.get('set-cookie');assert.match(header,/HttpOnly; Secure; SameSite=Strict/);
  const cookie=header.split(';')[0];assert.equal((await fetch(base+'/check',{headers:{Cookie:cookie}})).status,204);
  assert.equal((await fetch(base+'/check',{headers:{Cookie:cookie+'x'}})).status,401);
  assert.equal((await fetch(base+'/check',{headers:{Cookie:cookie+'; '+cookie}})).status,401);
  const fresh=issueQR(file,origin);assert.notEqual(fresh.id,issued.id);
  revokeQR(file,issued.id);assert.equal((await exchange(token)).status,401);assert.equal((await fetch(base+'/check',{headers:{Cookie:cookie}})).status,401);
  const saved=JSON.parse(readFileSync(file,'utf8'));saved.grants[0].expiresAt=Date.now()-1;writeFileSync(file,JSON.stringify(saved));
  assert.equal((await exchange(new URL(fresh.url).hash.slice(1))).status,401);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true});}
});
