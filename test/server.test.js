const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHmac}=require('node:crypto');
const {createServer}=require('../src/server');
const {DEFAULT_NDI_KNOWLEDGE}=require('../src/business-knowledge');

function request(server,path,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const address=server.address();const req=http.request({host:'127.0.0.1',port:address.port,path,method,headers:{...(body?{'content-type':'application/json'}:{}),...headers}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));});req.setTimeout(3000,()=>req.destroy(new Error(`HTTP timeout ${method} ${path}`)));req.on('error',reject);if(body)req.write(body);req.end();});}
function closeServer(server){return new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});}

test('proxy trust is scoped to the configured ingress IP',()=>{
  const app=createServer({config:{nodeEnv:'production',baseUrl:'https://botndi.example',trustProxy:'192.168.0.80'},repository:{},auth:{}});
  const trusted=app.get('trust proxy fn');
  assert.equal(trusted('192.168.0.80'),true);
  assert.equal(trusted('192.168.0.81'),false);
});

test('health, dashboard auth, static UI, same-origin login, CSRF and logout are enforced',async t=>{
  let token='';let logoutCalls=0;const config={nodeEnv:'test',baseUrl:'http://localhost',tebar:{}};
  const repository={healthCheck:async()=>{},getRuntimeState:async()=>({settings:{schedule:{},hashtags:[],businessKnowledge:DEFAULT_NDI_KNOWLEDGE},businessKnowledge:DEFAULT_NDI_KNOWLEDGE,businessKnowledgeApproved:false,contentStrategyReady:false,contentStrategyReason:'Penerbitan menunggu mesin kategori dan gaya konten Fase B.',facts:[],history:[],automationEnabled:false}),listSlots:async()=>[],listActivity:async()=>[],listAudit:async()=>[],saveSettings:async x=>x,saveKnowledge:async x=>({knowledge:x,approved:true}),setAutomationEnabled:async()=>{},};
  const auth={login:async()=>({token:'a'.repeat(43),csrfToken:'b'.repeat(43),expiresAt:new Date(Date.now()+3600000),admin:{id:1,email:'x@example.test'}}),authenticate:async value=>value===token?{admin:{id:1,email:'x@example.test'},csrfToken:'b'.repeat(43)}:null,logout:async value=>{assert.equal(value,'a'.repeat(43));logoutCalls++;token='';}};
  const app=createServer({config,repository,auth,services:{getProviderStatus:async()=>({connected:false}),getClickMetric:async()=>({available:true,value:12,reason:null}),schedulerStatus:()=>({enabled:true,lastErrorCode:'INTERNAL_DETAIL'})}});
  const server=require('node:http').createServer(app);const listening=new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});server.listen(0,'127.0.0.1');await listening;t.after(()=>closeServer(server));
  config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await request(server,'/health/live')).status,200);const ready=await request(server,'/health/ready');assert.equal(ready.status,200);assert.deepEqual(JSON.parse(ready.body),{status:'ready'});
  const malformedCookie=await request(server,'/api/session',{headers:{cookie:'bot_ndi_admin=%E0%A4%A'}});assert.equal(malformedCookie.status,200);assert.deepEqual(JSON.parse(malformedCookie.body),{authenticated:false});
  assert.equal((await request(server,'/api/dashboard')).status,401);
  const staticPage=await request(server,'/');assert.equal(staticPage.status,200);assert.match(staticPage.body,/Panel Threads/);assert.equal(staticPage.headers['x-frame-options'],'DENY');assert.match(staticPage.body,/name="hours"[^>]*min="0"/);assert.match(staticPage.body,/name="minutes"[^>]*min="0"[^>]*max="59"/);assert.match(staticPage.body,/Minimal 1 menit/);assert.match(staticPage.body,/name="hashtags"/);assert.match(staticPage.body,/name="companyName"/);assert.match(staticPage.body,/name="ctaUrl"/);assert.match(staticPage.body,/Website Resmi \/ CTA URL/);assert.doesNotMatch(staticPage.body,/name="gameWhitelist"|name="priceMode"|name="trackedTopup"|name="trackedAccount"|Tautan top-up berpelacak|Game top-up yang disetujui/i);assert.doesNotMatch(staticPage.body,/id="active-days"|name="activeStart"|name="activeEnd"/);assert.match(staticPage.body,/22:00 WIB/);
  assert.equal((await request(server,'/api/session/login',{method:'POST',headers:{origin:'https://evil.test'},body:'{}'})).status,403);
  const login=await request(server,'/api/session/login',{method:'POST',headers:{origin:config.baseUrl},body:JSON.stringify({email:'x',password:'y'})});assert.equal(login.status,200);token='a'.repeat(43);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  const dashboard=await request(server,'/api/dashboard',{headers:{cookie}});assert.equal(dashboard.status,200);assert.deepEqual(JSON.parse(dashboard.body).metrics.clicks,{available:true,value:12,reason:null});
  const onboarding=JSON.parse(dashboard.body).onboarding;
  assert.deepEqual(onboarding.filter(item=>item.required).map(item=>item.key),['contentStrategy','knowledge','thread','ai']);
  assert.equal(onboarding[0].complete,false);
  assert.ok(onboarding.every(item=>item.required===true));
  const knowledge=await request(server,'/api/knowledge',{method:'PUT',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'b'.repeat(43)},body:JSON.stringify({...DEFAULT_NDI_KNOWLEDGE,ctaUrl:'https://portfolio.example.test/ndi'})});
  assert.equal(knowledge.status,200,knowledge.body);assert.deepEqual(JSON.parse(knowledge.body).knowledge.services,DEFAULT_NDI_KNOWLEDGE.services);assert.equal(JSON.parse(knowledge.body).knowledge.ctaUrl,'https://portfolio.example.test/ndi');
  const badCsrf=await request(server,'/api/automation/pause',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'wrong'},body:'{}'});assert.equal(badCsrf.status,403);
  const nonAsciiCsrf=await request(server,'/api/automation/pause',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'é'+'b'.repeat(42)},body:'{}'});assert.equal(nonAsciiCsrf.status,403);assert.deepEqual(JSON.parse(nonAsciiCsrf.body),{error:'CSRF_REJECTED'});
  const goodCsrf=await request(server,'/api/automation/pause',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'b'.repeat(43)},body:'{}'});assert.equal(goodCsrf.status,200);assert.equal(JSON.parse(goodCsrf.body).message,'Automasi dijeda. Pembatalan berhasil: 0; perlu ditinjau: 0.');
  const logoutWithoutCsrf=await request(server,'/api/session/logout',{method:'POST',headers:{origin:config.baseUrl,cookie}});assert.equal(logoutWithoutCsrf.status,403);assert.equal(logoutCalls,0);
  const logout=await request(server,'/api/session/logout',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'b'.repeat(43)}});assert.equal(logout.status,200);assert.deepEqual(JSON.parse(logout.body),{ok:true});assert.equal(logoutCalls,1);
  assert.match(logout.headers['set-cookie'][0],/bot_ndi_admin=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
  assert.deepEqual(JSON.parse((await request(server,'/api/session',{headers:{cookie}})).body),{authenticated:false});
  assert.equal((await request(server,'/api/learning/candidates',{headers:{cookie}})).status,404);
  assert.equal((await request(server,'/api/templates',{headers:{cookie}})).status,404);
});

test('unexpected server error codes are hidden while integration availability errors remain actionable',async t=>{
  const config={nodeEnv:'test',baseUrl:'http://localhost',tebar:{}};
  let failure=Object.assign(new Error('database details'),{code:'ER_ACCESS_DENIED_ERROR'});
  const services={configuration:{getActive:async()=>{throw failure;},history:async()=>[]},configurationValidators:{}};
  const auth={authenticate:async()=>({admin:{id:1},csrfToken:'c'.repeat(43)})};
  const server=http.createServer(createServer({config,repository:{},auth,services}));
  server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));
  const headers={cookie:'bot_ndi_admin=token'};
  let response=await request(server,'/api/integrations',{headers});
  assert.equal(response.status,500);assert.deepEqual(JSON.parse(response.body),{error:'INTERNAL_ERROR'});
  failure=Object.assign(new Error('unavailable'),{code:'CONFIG_UNAVAILABLE',status:503});
  response=await request(server,'/api/integrations',{headers});
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{error:'CONFIG_UNAVAILABLE'});
});

test('login rate limiting returns the shared throttle Retry-After delay',async t=>{
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const repository={};
  const auth={
    login:async()=>{throw Object.assign(new Error('LOGIN_RATE_LIMITED'),{code:'LOGIN_RATE_LIMITED',status:429,retryAfterSeconds:43});},
    authenticate:async()=>null,
  };
  const server=http.createServer(createServer({config,repository,auth}));
  server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));
  config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const response=await request(server,'/api/session/login',{method:'POST',headers:{origin:config.baseUrl},body:JSON.stringify({email:'admin@example.test',password:'wrong'})});
  assert.equal(response.status,429);
  assert.equal(response.headers['retry-after'],'43');
  assert.deepEqual(JSON.parse(response.body),{error:'LOGIN_RATE_LIMITED'});
});

test('NDI settings and knowledge validate before persistence; legacy facts are archived',async t=>{
  let settingsWrites=0,knowledgeWrites=0,factWrites=0;const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};const repo={saveSettings:async settings=>{settingsWrites++;return settings;},saveKnowledge:async knowledge=>{knowledgeWrites++;return{knowledge,approved:true};},saveFact:async()=>{factWrites++;}};const auth={authenticate:async()=>({admin:{id:1},csrfToken:'c'.repeat(43)})};
  const app=createServer({config,repository:repo,auth});const server=require('node:http').createServer(app);const listening=new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});server.listen(0,'127.0.0.1');await listening;t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:'bot_ndi_admin='+encodeURIComponent('x'.repeat(43)),'x-csrf-token':'c'.repeat(43)};
  const invalid=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({schedule:{hours:0,minutes:0}})});assert.equal(invalid.status,400);
  const minute=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({schedule:{hours:0,minutes:1},hashtags:[' #Bot NDI ','##botndi']})});assert.equal(minute.status,200);assert.equal(JSON.parse(minute.body).schedule.intervalMinutes,1);assert.deepEqual(JSON.parse(minute.body).hashtags,['#BotNDI']);
  const hourly=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({schedule:{intervalHours:1}})});assert.equal(hourly.status,200);assert.equal(JSON.parse(hourly.body).schedule.intervalMinutes,60);
  const invalidHashtag=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({hashtags:['#bad/tag']})});assert.equal(invalidHashtag.status,400);
  const badLegacyFields=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({gameWhitelist:['Mobile Legends'],trackedLinks:{topup:'https://shop.example.test'}})});assert.equal(badLegacyFields.status,200);assert.equal(Object.hasOwn(JSON.parse(badLegacyFields.body),'gameWhitelist'),false);assert.equal(Object.hasOwn(JSON.parse(badLegacyFields.body),'trackedLinks'),false);
  const invalidKnowledge=await request(server,'/api/knowledge',{method:'PUT',headers,body:JSON.stringify({...DEFAULT_NDI_KNOWLEDGE,ctaUrl:'http://unsafe.example.test'})});assert.equal(invalidKnowledge.status,400);assert.equal(knowledgeWrites,0);
  const validKnowledge=await request(server,'/api/knowledge',{method:'PUT',headers,body:JSON.stringify({...DEFAULT_NDI_KNOWLEDGE,ctaUrl:'https://portfolio.example.test/ndi'})});assert.equal(validKnowledge.status,200);assert.equal(JSON.parse(validKnowledge.body).knowledge.ctaUrl,'https://portfolio.example.test/ndi');assert.equal(knowledgeWrites,1);
  const archived=await request(server,'/api/facts/topup',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',price:'Rp 30.000'}})});assert.equal(archived.status,410);assert.equal(JSON.parse(archived.body).error,'LEGACY_FACTS_ARCHIVED');assert.equal(factWrites,0);
  assert.equal(settingsWrites,3);
  const appSource=require('node:fs').readFileSync(require.resolve('../public/app.js'),'utf8');assert.match(appSource,/const knowledge = \{[\s\S]*companyName: value\(form, 'companyName'\)/);assert.match(appSource,/const settings = \{ schedule: state\.data\.settings\?\.schedule \|\| \{\}, hashtags: lines\(value\(form, 'hashtags'\)\) \}/);assert.match(appSource,/api\('\/api\/knowledge'/);assert.match(appSource,/ctaUrl: value\(form, 'ctaUrl'\)\.trim\(\)/);assert.doesNotMatch(appSource,/api\(['"`]\/api\/(?:templates|learning)\//);
});

test('automation enable requires scheduler and triggers an immediate durable dispatch',async t=>{
  const now=new Date();let enabledCalls=0;let dispatchCalls=0;
  const settings={schedule:{intervalMinutes:60},hashtags:['#BotNDI'],businessKnowledge:DEFAULT_NDI_KNOWLEDGE};
  const repository={
    getRuntimeState:async()=>({settings,businessKnowledge:DEFAULT_NDI_KNOWLEDGE,businessKnowledgeApproved:true,contentStrategyReady:true,automationEnabled:false}),
    setAutomationEnabled:async(enabled)=>{enabledCalls++;assert.equal(enabled,true);return{changed:true,firstPostAt:now.toISOString(),immediate:true};},
  };
  const auth={authenticate:async()=>({admin:{id:8},csrfToken:'c'.repeat(43)})};
  const services={externalIntegrationsEnabled:true,aiConfigured:true,getProviderStatus:async()=>({connected:true}),schedulerStatus:()=>({enabled:true}),triggerScheduler:async()=>{dispatchCalls++;return{claimed:1,published:1};}};
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const app=createServer({config,repository,auth,services});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,'x-csrf-token':'c'.repeat(43)};
  const response=await request(server,'/api/automation/enable',{method:'POST',headers,body:'{}'});
  assert.equal(response.status,200,response.body);assert.equal(enabledCalls,1);assert.equal(dispatchCalls,1);
  assert.deepEqual(JSON.parse(response.body),{enabled:true,firstPostAt:now.toISOString(),immediate:true});
});

test('automation enable requires the Phase B content strategy and all other NDI readiness checks',async t=>{
  const now=new Date();let settings={schedule:{intervalMinutes:60},hashtags:['#NusaDataIndonesia'],businessKnowledge:{...DEFAULT_NDI_KNOWLEDGE,ctaUrl:'https://portfolio.example.test/ndi'}};let connected=true;let aiConfigured=true;let approved=true;let contentStrategyReady=true;let writes=0;
  const repository={getRuntimeState:async()=>({settings,businessKnowledge:settings.businessKnowledge,businessKnowledgeApproved:approved,contentStrategyReady,automationEnabled:false}),setAutomationEnabled:async()=>{writes++;return{changed:true,firstPostAt:now.toISOString(),immediate:true};}};
  const auth={authenticate:async()=>({admin:{id:8},csrfToken:'c'.repeat(43)})};
  const services={externalIntegrationsEnabled:true,aiConfigured:true,getProviderStatus:async()=>({connected}),schedulerStatus:()=>({enabled:true}),triggerScheduler:async()=>{}};
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const app=createServer({config,repository,auth,services});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,'x-csrf-token':'c'.repeat(43)};
  const activate=()=>request(server,'/api/automation/enable',{method:'POST',headers,body:'{}'});
  assert.equal((await activate()).status,200,'editable arbitrary HTTPS CTA is accepted');assert.equal(writes,1);
  contentStrategyReady=false;const strategyBlocked=await activate();assert.equal(strategyBlocked.status,409);assert.equal(JSON.parse(strategyBlocked.body).error,'CONTENT_STRATEGY_NOT_READY');assert.equal(writes,1,'Phase B readiness must block activation before changing automation state');
  contentStrategyReady=true;
  approved=false;assert.equal((await activate()).status,409,'knowledge must be reviewed');
  approved=true;settings={...settings,businessKnowledge:{...settings.businessKnowledge,ctaUrl:'http://unsafe.example.test'}};assert.equal((await activate()).status,409,'CTA must be HTTPS');
  settings={...settings,businessKnowledge:{...DEFAULT_NDI_KNOWLEDGE,ctaUrl:'https://portfolio.example.test/ndi'}};connected=false;assert.equal((await activate()).status,409,'Threads account must be connected');
  connected=true;services.aiConfigured=false;assert.equal((await activate()).status,409,'AI provider must be configured');
  assert.equal(writes,1,'failed required gates must not enable automation');
});

test('automation enable starts immediately even if the previous session posted under one hour ago',async t=>{
  const firstPostAt=new Date().toISOString();let dispatchCalls=0;
  const settings={schedule:{intervalMinutes:60},hashtags:['#BotNDI'],businessKnowledge:DEFAULT_NDI_KNOWLEDGE};
  const repository={getRuntimeState:async()=>({settings,businessKnowledge:DEFAULT_NDI_KNOWLEDGE,businessKnowledgeApproved:true,contentStrategyReady:true,automationEnabled:false}),setAutomationEnabled:async()=>({changed:true,firstPostAt,immediate:true})};
  const auth={authenticate:async()=>({admin:{id:8},csrfToken:'c'.repeat(43)})};
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const app=createServer({config,repository,auth,services:{externalIntegrationsEnabled:true,aiConfigured:true,getProviderStatus:async()=>({connected:true}),schedulerStatus:()=>({enabled:true}),triggerScheduler:async()=>{dispatchCalls++;}}});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,'x-csrf-token':'c'.repeat(43)};
  const response=await request(server,'/api/automation/enable',{method:'POST',headers,body:'{}'});
  assert.equal(response.status,200,response.body);assert.equal(dispatchCalls,1);
  assert.deepEqual(JSON.parse(response.body),{enabled:true,firstPostAt,immediate:true});
});

test('automation enable is rejected when recurring scheduler is disabled',async t=>{
  let writes=0;
  const repository={getRuntimeState:async()=>({settings:{},automationEnabled:false}),setAutomationEnabled:async()=>{writes++;}};
  const auth={authenticate:async()=>({admin:{id:8},csrfToken:'c'.repeat(43)})};
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const app=createServer({config,repository,auth,services:{externalIntegrationsEnabled:true,schedulerStatus:()=>({enabled:false})}});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,'x-csrf-token':'c'.repeat(43)};
  const response=await request(server,'/api/automation/enable',{method:'POST',headers,body:'{}'});
  assert.equal(response.status,503);assert.equal(JSON.parse(response.body).error,'SCHEDULER_DISABLED');assert.equal(writes,0);
});

test('automation, webhook, and error-notification paths stay blocked until external integrations are explicitly enabled',async t=>{
  let providerChecks=0,enabledWrites=0,dispatchCalls=0,webhookCalls=0,notifications=0,flushCalls=0;
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',externalIntegrationsEnabled:false,schedulerEnabled:true,tebar:{webhookSecret:'test-webhook-secret'}};
  const repository={
    getRuntimeState:async()=>{throw Object.assign(new Error('mock database failure'),{code:'MOCK_FAILURE',status:500});},
    listFacts:async()=>({}),listSlots:async()=>[],listActivity:async()=>[],listAudit:async()=>[],
    setAutomationEnabled:async()=>{enabledWrites++;return{changed:true};},
    applyWebhookEvent:async()=>{webhookCalls++;return true;},
  };
  const auth={authenticate:async()=>({admin:{id:8},csrfToken:'c'.repeat(43)})};
  const services={
    externalIntegrationsEnabled:false,
    aiConfigured:true,
    getProviderStatus:async()=>{providerChecks++;return{connected:true};},
    schedulerStatus:()=>({enabled:true}),
    triggerScheduler:async()=>{dispatchCalls++;},
    notify:async()=>{notifications++;},
    flushNotifications:async()=>{flushCalls++;},
  };
  const server=http.createServer(createServer({config,repository,auth,services}));
  server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,'x-csrf-token':'c'.repeat(43)};

  const activate=await request(server,'/api/automation/enable',{method:'POST',headers,body:'{}'});
  assert.equal(activate.status,503);assert.deepEqual(JSON.parse(activate.body),{error:'EXTERNAL_INTEGRATIONS_DISABLED'});
  const webhook=await request(server,'/webhooks/tebar',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(webhook.status,503);assert.deepEqual(JSON.parse(webhook.body),{error:'EXTERNAL_INTEGRATIONS_DISABLED'});
  const failure=await request(server,'/api/dashboard',{headers:{cookie:headers.cookie}});
  assert.equal(failure.status,500);assert.equal(notifications,0);
  assert.equal(providerChecks,0);assert.equal(enabledWrites,0);assert.equal(dispatchCalls,0);assert.equal(webhookCalls,0);assert.equal(flushCalls,0);

  config.externalIntegrationsEnabled=true;services.externalIntegrationsEnabled=true;
  const webhookBody=Buffer.from(JSON.stringify({id:'evt-enabled',type:'post.failed',profile_id:'profile-1',data:{post_id:'post-1',status:'failed'}}));
  const timestamp=Math.floor(Date.now()/1000);
  const signature=createHmac('sha256','test-webhook-secret').update(`${timestamp}.`).update(webhookBody).digest('hex');
  const enabledWebhook=await request(server,'/webhooks/tebar',{method:'POST',headers:{'content-type':'application/json','Tebar-Signature':`t=${timestamp},v1=${signature}`},body:webhookBody});
  assert.equal(enabledWebhook.status,200);assert.deepEqual(JSON.parse(enabledWebhook.body),{received:true,duplicate:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(webhookCalls,1);assert.equal(flushCalls,1);
});

test('admin management requires authentication and CSRF, supports create/update, and blocks self-deactivation',async t=>{
  const admins=[{id:1,email:'one@example.test',active:true},{id:2,email:'two@example.test',active:true}];const calls=[];
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const repository={listAdmins:async()=>admins,createAdmin:async input=>{calls.push(['create',input]);return{id:3,email:input.email,active:true};},updateAdmin:async(id,changes,actor)=>{calls.push(['update',id,changes,actor]);return{...admins.find(a=>a.id===id),...changes};}};
  const auth={authenticate:async()=>({admin:{id:1,email:'one@example.test'},csrfToken:'c'.repeat(43)}),createAdmin:async input=>{calls.push(['auth-create',input]);return{id:3,email:input.email,active:true};},updateAdmin:async(id,changes,actor)=>{calls.push(['auth-update',id,changes,actor]);return{ id,email:changes.email||'two@example.test',active:changes.active??true,credentialsChanged:changes.email!==undefined||changes.password!==undefined};}};
  const app=createServer({config,repository,auth});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const cookie=`${require('../src/server').COOKIE}=${'x'.repeat(43)}`;const base={cookie};
  assert.equal((await request(server,'/api/admins')).status,401);
  const list=await request(server,'/api/admins',{headers:base});assert.equal(list.status,200);assert.equal(JSON.parse(list.body).admins.length,2);
  const invalid=await request(server,'/api/admins',{method:'POST',headers:{...base,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)},body:JSON.stringify({email:'bad@example.test',password:'long enough password',active:false})});assert.equal(invalid.status,400);
  const noCsrf=await request(server,'/api/admins',{method:'POST',headers:{...base,origin:config.baseUrl},body:JSON.stringify({email:'new@example.test',password:'long enough password'})});assert.equal(noCsrf.status,403);
  const created=await request(server,'/api/admins',{method:'POST',headers:{...base,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)},body:JSON.stringify({email:'new@example.test',password:'long enough password'})});assert.equal(created.status,201);assert.equal(JSON.parse(created.body).admin.email,'new@example.test');
  const selfOff=await request(server,'/api/admins/1',{method:'PATCH',headers:{...base,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)},body:JSON.stringify({active:false})});assert.equal(selfOff.status,409);assert.equal(calls.length,1);
  const changed=await request(server,'/api/admins/2',{method:'PATCH',headers:{...base,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)},body:JSON.stringify({email:'changed@example.test',password:'long enough password'})});assert.equal(changed.status,200);assert.equal(JSON.parse(changed.body).sessionRevoked,false);
  const selfChanged=await request(server,'/api/admins/1',{method:'PATCH',headers:{...base,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)},body:JSON.stringify({email:'one-updated@example.test'})});assert.equal(selfChanged.status,200);assert.equal(JSON.parse(selfChanged.body).sessionRevoked,true);assert.match(selfChanged.headers['set-cookie'][0],/Max-Age=0/);
});

test('legacy template and learning endpoints are not exposed by the NDI dashboard',async t=>{
  let repositoryCalls=0;const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const repository={listTemplates:async()=>{repositoryCalls++;return[];},createTemplate:async()=>{repositoryCalls++;},getRuntimeState:async()=>{repositoryCalls++;return{};}};
  const auth={authenticate:async()=>({admin:{id:7},csrfToken:'c'.repeat(43)})};
  const app=createServer({config,repository,auth});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)};
  for (const path of ['/api/templates','/api/templates/legacy','/api/learning/candidates','/api/learning/rules']) {
    assert.equal((await request(server,path,{headers})).status,404,path);
  }
  assert.equal(repositoryCalls,0,'legacy content endpoints must not access persisted legacy rows');
});

test('readiness failure response remains minimal when dependencies are unavailable',async t=>{
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const repository={healthCheck:async()=>{throw new Error('database unavailable');}};
  const app=createServer({config,repository,auth:{},services:{schedulerStatus:()=>({lastErrorCode:'INTERNAL_DETAIL'})}});
  const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const response=await request(server,'/health/ready');
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{status:'not_ready'});
});

test('readiness requires the scheduler when configured without exposing scheduler details',async t=>{
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{},schedulerEnabled:true};
  const repository={healthCheck:async()=>{}};
  const services={schedulerStatus:()=>({enabled:false,lastErrorCode:'sensitive-detail'})};
  const server=http.createServer(createServer({config,repository,auth:{},services}));
  server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));
  let response=await request(server,'/health/ready');
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{status:'not_ready'});
  services.schedulerStatus=()=>({enabled:true,lastErrorCode:'sensitive-detail'});
  response=await request(server,'/health/ready');
  assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),{status:'ready'});
  services.schedulerStatus=()=>{throw new Error('sensitive-detail');};
  response=await request(server,'/health/ready');
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{status:'not_ready'});
  delete services.schedulerStatus;
  response=await request(server,'/health/ready');
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{status:'not_ready'});
  config.schedulerEnabled=false;
  response=await request(server,'/health/ready');
  assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),{status:'ready'});
});
