import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';

// Run from a built release, as the dedicated service account. Never rewrites existing private state.
const [root, hostname, node] = process.argv.slice(2);
if(!root?.startsWith('/')||!node?.startsWith('/')||!hostname||!/^[a-z0-9.-]+$/.test(hostname))throw Error('Usage: node scripts/deploy/prepare.mjs ABS_ROOT HOSTNAME ABS_NODE');
if(!/^\/[a-zA-Z0-9/_-]+$/.test(root)||!/^\/[a-zA-Z0-9/_.-]+$/.test(node))throw Error('Invalid deployment path');
const shared=resolve(root,'shared'),generated=resolve(root,'generated'),current=resolve(root,'current');
for(const dir of [shared,generated,resolve(shared,'config'),resolve(shared,'keys'),resolve(shared,'instances'),resolve(shared,'logs')])mkdirSync(dir,{recursive:true,mode:0o700});
const writeNew=(path,data)=>{if(!existsSync(path))writeFileSync(path,data,{mode:0o600,flag:'wx'});};
const json=(path,data)=>writeNew(path,JSON.stringify(data,null,2)+'\n');
const fixture=JSON.parse(readFileSync(resolve('fixtures/core/ethereum-mainnet-26134149/snapshot.json'),'utf8'));
const services=[],bindings=[];
for(const [index,variant] of ['wrong-block','wrong-value','valid'].entries()){
 const id='demo-'+variant,keyFile=resolve(shared,'keys',id+'.key');writeNew(keyFile,generatePrivateKey()+'\n');
 const signer=privateKeyToAccount(readFileSync(keyFile,'utf8').trim()).address.toLowerCase(),port=14401+index;
 json(resolve(shared,'config',id+'.json'),{serviceId:id,version:'1',host:'127.0.0.1',port,privateKeyFile:keyFile,dataDir:resolve(shared,'instances',id),fixtureFile:resolve(current,'fixtures/core/ethereum-mainnet-26134149/snapshot.json'),alternateFixtureFile:resolve(current,'fixtures/core/mainnet-corpus/24000000.json'),variant,testFaults:false,delayMs:0});
 services.push({serviceId:id,version:'1',endpoint:`http://127.0.0.1:${port}/deliver`,transport:'signed-http',source:variant==='valid'?'FROZEN':'FAULT_INJECTION',quoteWei:'0',timeoutMs:3000,capabilities:{dataChainIds:['1'],blockHashes:[fixture.header.hash],accounts:fixture.accounts.map(a=>a.address),fields:['balance','nonce','codeHash','storageRoot'],proof:'SUPPORTED',signature:'SUPPORTED',methods:['deliver']}});
 bindings.push({serviceId:id,serviceVersion:'1',identityChainId:'1',signer,validFrom:'0',validUntil:'4102444800',authority:'Operator-generated demo signer, not an RPC provider identity'});
}
for(const [index,id] of ['one','two'].entries()){
 json(resolve(shared,'config',id+'.json'),{instanceId:'verdict-cloud-'+id,host:'127.0.0.1',port:3131+index,dataDir:resolve(shared,'instances',id),corsOrigins:['http://127.0.0.1:5190'],historyMaxAgeMs:86400000,publicationAdapter:'not_configured',wallet:{networks:[{chainId:'0x3c8',name:'BOT Chain Testnet',nativeSymbol:'tBOT',rpcUrlEnv:'VERDICT_WALLET_RPC_URL',maxValueWei:'100000000000000',maxTotalFeeWei:'1000000000000000'}],rpcTimeoutMs:8000,reviewTimeoutMs:90000,permitTtlMs:120000},services,contexts:[{schemaVersion:'1.0.0',contextId:'mainnet-demo',ruleVersion:'eth-account-v1',identityChainId:'1',policy:{id:'signed-account-v1',requireSignature:true,minimumFinality:'any-pinned'},trustedBlock:{dataChainId:'1',blockHash:fixture.header.hash,stateRoot:fixture.header.stateRoot,source:'Operator-pinned reviewed fixture, not independent consensus verification',finality:'historical-checkpoint'},keyBindings:bindings}]});
 writeNew(resolve(shared,id+'.env'),'VERDICT_WALLET_RPC_URL=https://rpc.bohr.life\n');
}
for(const name of ['one','two','demo-wrong-block','demo-wrong-value','demo-valid']){
 const app=name.startsWith('demo-')?'services/demo':'apps/server';
 writeFileSync(resolve(generated,`verdict-${name}.service`),`[Unit]
Description=Verdict ${name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=verdict
Group=verdict
WorkingDirectory=${current}
EnvironmentFile=-${shared}/${name}.env
ExecStart=${node} --use-env-proxy ${current}/${app}/dist/main.js --config ${shared}/config/${name}.json
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${shared}

[Install]
WantedBy=multi-user.target
`,{mode:0o600});
}
const routes=[['one',3131],['two',3132]].map(([name,port])=>`    location /backend/${name}/ {
        proxy_pass http://127.0.0.1:${port}/;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Origin http://127.0.0.1:5190;
        proxy_set_header Authorization "";
        proxy_read_timeout 200s;
        proxy_send_timeout 200s;
        proxy_buffering off;
        limit_req zone=verdict_api burst=40 nodelay;
    }`).join('\n');
writeFileSync(resolve(generated,'verdict-nginx.conf'),`# Independent vhost. Authenticate before forwarding to loopback-only APIs.
map $http_origin $verdict_origin_allowed {
    default 0;
    "" 1;
    "https://${hostname}" 1;
}
limit_req_zone $binary_remote_addr zone=verdict_api:10m rate=10r/s;
server {
    listen 80;
    server_name ${hostname};
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl;
    server_name ${hostname};
    ssl_certificate /etc/letsencrypt/live/${hostname}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${hostname}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    root ${current}/apps/web/dist;
    index index.html;
    auth_basic "Verdict";
    auth_basic_user_file ${root}/access.htpasswd;
    client_max_body_size 2m;
    if ($verdict_origin_allowed = 0) { return 403; }
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;
    add_header X-Frame-Options DENY always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    location ~ /\\. { deny all; }
${routes}
    location / { try_files $uri $uri/ /index.html; }
}
`,{mode:0o600});
console.log('Prepared independent instances, generated demo signers, units and Nginx configuration; existing state preserved.');
