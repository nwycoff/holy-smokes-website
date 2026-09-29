import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApp } from '../server/customer-app/index.mjs';
import { hash } from '../server/customer-app/http.mjs';
import { normalizeMenu } from '../server/customer-app/growflow.mjs';

const migration = ['0001_customer_app.sql', '0002_customer_app_preorders.sql']
  .map(name => readFileSync(new URL(`../app-migrations/${name}`, import.meta.url), 'utf8')).join('\n');
class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('PRAGMA foreign_keys = ON'); this.db.exec(migration); }
  prepare(sql) {
    const db = this.db;
    return { bind(...values) {
      return { async first() { return db.prepare(sql).get(...values) || null; }, async run() {
        const stmt = db.prepare(sql); const results = stmt.columns().length ? stmt.all(...values) : (stmt.run(...values), []);
        return { success: true, results };
      } };
    } };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const rows = []; for (const s of statements) rows.push(await s.run()); this.db.exec('COMMIT'); return rows; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
const keypair = await crypto.subtle.generateKey({ name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
  publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256' }, true, ['sign','verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keypair.publicKey), kid:'local-test-key', alg:'RS256', use:'sig' };
const b64 = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
async function sign(payload) {
  const input = `${b64({alg:'RS256',kid:'local-test-key'})}.${b64(payload)}`;
  return `${input}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keypair.privateKey,new TextEncoder().encode(input))).toString('base64url')}`;
}
function syntheticMenu() {
  const pkg = (location, sellable = true, qty = 2, thc = 25) => ({ storageLocation:location,isSellable:sellable,inventoryQty:qty,
    testResults:{uom:'%',totalPotentialPsychoactiveThc:thc} });
  return {pricesIncludeTax:true,menuGroups:[{name:'Screen 1 - Flower',products:[
    {id:'public-a',name:'Internal Flower Title',brand:'Sample Brand',strain:'Sample Strain',category:'Flower',cannabisType:'Hybrid',variants:[{weight:3.5,uom:'g',price:2000}],
      packages:[pkg('Front',true,2,25),pkg('Back',false,50,99)]},
    {id:'public-b',name:'Back only',category:'Flower',variants:[{price:100}],packages:[pkg('Back')]},
    {id:'public-c',name:'Not sellable',category:'Flower',variants:[{price:100}],packages:[pkg('Front',false)]},
    {id:'public-d',name:'Legacy unassigned',category:'Flower',variants:[{price:100}],packages:[pkg(null)]},
    {id:'public-e',name:'Zero stock',category:'Flower',variants:[{price:100}],packages:[pkg('Front',true,0)]}
  ]}]};
}
function setup() {
  let now = Date.now(), nonce, subject = 'auth0|test-one', claims = {}, gfStatus = 200, gfHeaders = {}, gfData;
  const calls = [], codes = [];
  const env = { APP_ENABLED:'true',APP_ALLOWED_HOSTS:'preview.example.test',APP_DB:new D1(),
    APP_LIMIT_SECRET:'synthetic-application-secret-longer-than-32-characters',
    APP_ENROLLMENT_SECRET:'synthetic-owner-enrollment-secret-longer-than-32',
    APP_AUTH_ISSUER:'https://test-tenant.auth0.com/',APP_AUTH_CLIENT_ID:'test-app',APP_AUTH_CLIENT_SECRET:'test-client-secret',
    APP_GROWFLOW_TOKEN:'gfr_synthetic_test_only',GROWFLOW_ORG:'integrations',
    APP_MENU_ENABLED:'true',APP_MENU_KEY:'test-menu-key',APP_FRONT_LOCATION:'Front',
    GROWFLOW_PATIENT_ID_FIELDS:'PatientLicenseNumber,MedicalLicenseNumber,CustomerStateLicense' };
  const deps = {now:()=>now,report:code=>codes.push(code),fetch:async (target,init) => {
    const url = String(target); calls.push({url,init}); assert.equal(init.redirect,'manual');
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({keys:[jwk]});
    if (url.endsWith('/oauth/token')) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('client_id'),'test-app'); assert.equal(body.get('client_secret'),'test-client-secret');
      assert.ok(body.get('code_verifier')); assert.equal(body.get('redirect_uri'),'https://preview.example.test/api/app/callback');
      const time = Math.floor(Date.now()/1000);
      const id_token = await sign({iss:env.APP_AUTH_ISSUER,sub:subject,aud:'test-app',iat:time,exp:time+300,auth_time:time,nonce,
        email_verified:true,email:'synthetic@example.test',...claims});
      return Response.json({access_token:'temporary-provider-token',token_type:'Bearer',expires_in:300,id_token});
    }
    assert.equal(url,'https://retail.growflow.com/c/integrations/graphql');
    assert.equal(init.headers.Authorization,'Bearer gfr_synthetic_test_only');
    const request = JSON.parse(init.body);
    const data = gfData || (request.query.includes('findMenus') ? {findMenus:syntheticMenu()} : {findCustomers:{pageInfo:{hasNextPage:false},edges:[{node:{objectId:'CustomerOne',CurrentPoints:123.5}}]}});
    return Response.json({data},{status:gfStatus,headers:gfHeaders});
  }};
  async function run(route, {method='GET',body,headers={},cookie='',origin='https://preview.example.test'}={}) {
    const work = [];
    const response = await handleApp({env,request:new Request(`${origin}/api/app/${route}`,{method,
      headers:{origin,'sec-fetch-site':'same-origin','cf-connecting-ip':'192.0.2.9','content-type':'application/json',cookie,...headers},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})}),waitUntil:p=>work.push(p)},deps);
    await Promise.all(work); return response;
  }
  async function login(sub='auth0|test-one', overrides={}) {
    subject=sub;claims=overrides;
    const start = await run('login',{method:'POST',body:{}}); assert.equal(start.status,303);
    const url = new URL(start.headers.get('location')); nonce=url.searchParams.get('nonce');
    assert.equal(url.searchParams.get('code_challenge_method'),'S256'); assert.equal(url.searchParams.get('scope'),'openid email');
    const state=url.searchParams.get('state'), cookie=start.headers.getSetCookie()[0].split(';')[0];
    const finish = await run(`callback?code=synthetic-code&state=${state}`,{cookie,headers:{'sec-fetch-site':'cross-site'}});
    const sessionCookie=finish.headers.getSetCookie().find(c=>c.startsWith('__Host-treehouse_session='))?.split(';')[0] || '';
    return {response:finish,cookie:sessionCookie,state,loginCookie:cookie};
  }
  async function seed(cookie, customer='CustomerOne') {
    const info = await (await run('session',{cookie})).json();
    const raw=cookie.split('=')[1], key=await hash(env.APP_LIMIT_SECRET,`session:${raw}`);
    const row=env.APP_DB.db.prepare('SELECT user_id FROM app_sessions WHERE token_hash=?').get(key);
    env.APP_DB.db.prepare('UPDATE app_users SET customer_id=? WHERE id=?').run(customer,row.user_id);
    return info.csrf;
  }
  return {env,deps,calls,codes,run,login,seed,advance:ms=>{now+=ms;},setGF:(data,status=200,headers={})=>{gfData=data;gfStatus=status;gfHeaders=headers;}};
}

test('customer app defaults off; exact HTTPS hostname; config never exposes secrets', async () => {
  const s=setup();s.env.APP_ENABLED='false';assert.equal((await (await s.run('config')).json()).enabled,false);
  assert.equal((await s.run('points')).status,503);
  s.env.APP_ENABLED='true';assert.equal((await s.run('points',{origin:'https://other.example.test'})).status,503);
  const body=await (await s.run('config')).text();assert.ok(!body.includes('secret'));assert.ok(!body.includes('gfr_'));
});
test('real OIDC processing checks PKCE, nonce, issuer, audience, verification and signature', async () => {
  const valid=setup(), login=await valid.login();assert.equal(login.response.headers.get('location'),'/app/#rewards');
  assert.ok(login.cookie);assert.match(login.response.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);
  assert.deepEqual(Object.keys(await (await valid.run('session',{cookie:login.cookie})).json()).sort(),['csrf','linked','signedIn']);
  for (const claims of [{nonce:'wrong'},{iss:'https://attacker.example/'},{aud:'other-client'},{email_verified:false},{exp:1}]) {
    const s=setup(), result=await s.login('auth0|test',claims);assert.equal(result.cookie,'');
    assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_sessions').get().n,0);
  }
});
test('callback state is bound to the browser and can be used only once', async () => {
  const s=setup(), a=await s.login();
  const repeat=await s.run(`callback?code=again&state=${a.state}`,{cookie:a.loginCookie});
  assert.equal(repeat.headers.get('location'),'/app/#login-error');
  const missing=await s.run('callback?code=stolen&state=wrong');assert.equal(missing.headers.get('location'),'/app/#login-error');
  assert.equal(s.calls.filter(c=>c.url.endsWith('/oauth/token')).length,1);
});
test('tampered ID-token signature cannot create a session', async () => {
  const s=setup(), request=s.deps.fetch;
  s.deps.fetch=async(target,init)=>{
    const response=await request(target,init);
    if (!String(target).endsWith('/oauth/token')) return response;
    const data=await response.json(),parts=data.id_token.split('.');
    const signature=Buffer.from(parts[2],'base64url');signature[0]^=255;parts[2]=signature.toString('base64url');
    return Response.json({...data,id_token:parts.join('.')});
  };
  const result=await s.login();assert.equal(result.cookie,'');
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_users').get().n,0);
});
test('session secret rotation revokes old cookies without orphaning the customer link', async () => {
  const s=setup(),a=await s.login();await s.seed(a.cookie);
  s.env.APP_LIMIT_SECRET='rotated-synthetic-secret-longer-than-32-characters';
  assert.equal((await (await s.run('session',{cookie:a.cookie})).json()).signedIn,false);
  const b=await s.login();const info=await (await s.run('session',{cookie:b.cookie})).json();
  assert.equal(info.linked,true);assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_users').get().n,1);
});
test('login refuses missing/foreign Origin and never starts from GET', async () => {
  const s=setup();assert.equal((await s.run('login')).status,405);
  assert.equal((await s.run('login',{method:'POST',body:{},headers:{origin:'https://other.example'}})).status,403);
  assert.equal((await s.run('login',{method:'POST',body:{},headers:{origin:'null'}})).status,403);assert.equal(s.calls.length,0);
});
test('a login alone cannot read points and clients cannot choose customer IDs', async () => {
  const s=setup();assert.equal((await s.run('points')).status,401);
  const a=await s.login();assert.equal((await s.run('points',{cookie:a.cookie})).status,403);
  await s.seed(a.cookie);
  assert.equal((await s.run('points?customerId=other',{cookie:a.cookie})).status,400);
  const response=await s.run('points',{cookie:a.cookie});assert.equal(response.status,200);
  const value=await response.json();assert.equal(value.points,123.5);assert.deepEqual(Object.keys(value).sort(),['checkedAt','points']);
  const vars=JSON.parse(s.calls.at(-1).init.body).variables;
  assert.deepEqual(vars.where.objectId,{equalTo:'CustomerOne'});assert.equal(vars.where.IsDeleted.notEqualTo,true);
  assert.match(response.headers.get('cache-control'),/no-store/);
});
test('customer mismatch, null balances, incomplete and ambiguous records fail closed', async () => {
  for (const connection of [
    {pageInfo:{hasNextPage:false},edges:[{node:{objectId:'OtherRecord',CurrentPoints:900}}]},
    {pageInfo:{hasNextPage:false},edges:[{node:{objectId:'CustomerOne',CurrentPoints:null}}]},
    {pageInfo:{hasNextPage:true},edges:[{node:{objectId:'CustomerOne',CurrentPoints:900}}]},
    {pageInfo:{hasNextPage:false},edges:[]}
  ]) {
    const s=setup(),a=await s.login();await s.seed(a.cookie);s.setGF({findCustomers:connection});
    const res=await s.run('points',{cookie:a.cookie});assert.equal(res.status,503);assert.ok(!(await res.text()).includes('900'));
  }
});
test('staff enrollment is privileged, code is hashed, expires and cannot link two accounts', async () => {
  const s=setup(),a=await s.login(),b=await s.login('auth0|two');
  const input={name:'Synthetic Patient',lastFive:'ABC-12',identityChecked:true};
  assert.equal((await s.run('staff/enroll',{method:'POST',body:input})).status,401);
  const issued=await s.run('staff/enroll',{method:'POST',body:input,headers:{authorization:`Bearer ${s.env.APP_ENROLLMENT_SECRET}`}});
  assert.equal(issued.status,200);const {code}=await issued.json();
  assert.ok(!JSON.stringify(s.env.APP_DB.db.prepare('SELECT * FROM app_enrollments').all()).includes(code.replaceAll('-','')));
  const csrf=(await (await s.run('session',{cookie:a.cookie})).json()).csrf;
  assert.equal((await s.run('enroll',{method:'POST',cookie:a.cookie,body:{code}})).status,403);
  assert.equal((await s.run('enroll',{method:'POST',cookie:a.cookie,body:{code},headers:{'x-treehouse-csrf':csrf}})).status,200);
  const csrfB=(await (await s.run('session',{cookie:b.cookie})).json()).csrf;
  assert.equal((await s.run('enroll',{method:'POST',cookie:b.cookie,body:{code},headers:{'x-treehouse-csrf':csrfB}})).status,400);
  assert.equal((await s.run('points',{cookie:b.cookie})).status,403);
  assert.equal((await s.run('staff/enroll',{method:'POST',body:input,headers:{authorization:`Bearer ${s.env.APP_ENROLLMENT_SECRET}`}})).status,409);
});
test('expired enrollment cannot claim a record; issuing a new code invalidates the previous one', async () => {
  const s=setup(),a=await s.login();
  const issue=async()=> (await (await s.run('staff/enroll',{method:'POST',body:{name:'Synthetic Patient',lastFive:'ABC12',identityChecked:true},
    headers:{authorization:`Bearer ${s.env.APP_ENROLLMENT_SECRET}`}})).json()).code;
  const old=await issue(), fresh=await issue();
  const csrf=(await (await s.run('session',{cookie:a.cookie})).json()).csrf;
  const claim=code=>s.run('enroll',{method:'POST',cookie:a.cookie,body:{code},headers:{'x-treehouse-csrf':csrf}});
  assert.equal((await claim(old)).status,400);s.advance(600001);assert.equal((await claim(fresh)).status,400);
});
test('logout requires CSRF; logout-all revokes other sessions; sessions expire after seven days', async () => {
  const s=setup(),a=await s.login(),b=await s.login();const csrf=await s.seed(a.cookie);
  assert.equal((await s.run('logout-all',{method:'POST',cookie:a.cookie,body:{}})).status,403);
  assert.equal((await s.run('logout-all',{method:'POST',cookie:a.cookie,body:{},headers:{'x-treehouse-csrf':csrf}})).status,200);
  assert.equal((await (await s.run('session',{cookie:b.cookie})).json()).signedIn,false);
  const c=await s.login();s.advance(7*86400000+1);assert.equal((await s.run('points',{cookie:c.cookie})).status,401);
});
test('removing app connection requires recent login and removes every app session', async () => {
  const s=setup(),a=await s.login(),b=await s.login();const csrf=await s.seed(a.cookie);
  const res=await s.run('remove-link',{method:'POST',cookie:a.cookie,body:{},headers:{'x-treehouse-csrf':csrf}});assert.equal(res.status,200);
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_users').get().n,0);
  assert.equal((await (await s.run('session',{cookie:b.cookie})).json()).signedIn,false);
  const c=await s.login();const csrfC=await s.seed(c.cookie);s.advance(900001);
  assert.equal((await s.run('remove-link',{method:'POST',cookie:c.cookie,body:{},headers:{'x-treehouse-csrf':csrfC}})).status,403);
});
test('menu includes positive sellable front and explicitly unassigned stock', () => {
  const menu=normalizeMenu(syntheticMenu(),'front',Date.now());assert.equal(menu.products.length,2);
  assert.ok(menu.products.some(p=>p.id==='public-d'));
  const p=menu.products.find(p=>p.id==='public-a');assert.equal(p.name,'Sample Strain');assert.equal(p.brand,'Sample Brand');assert.deepEqual(p.thc,[25,25]);
  assert.equal(p.variants[0].priceCents,2000);assert.equal(p.category,'Flower');
  assert.ok(!JSON.stringify(menu).includes('inventoryQty'));assert.ok(!JSON.stringify(menu).includes('storageLocation'));
});
test('package eligibility rejects back, other rooms, missing fields and unusable stock', () => {
  for (const changes of [
    {storageLocation:'Back'}, {storageLocation:'Other'}, {storageLocation:undefined},
    {storageLocation:''}, {storageLocation:{}}, {isSellable:false}, {isSellable:undefined},
    {inventoryQty:0}, {inventoryQty:-1}, {inventoryQty:NaN}, {inventoryQty:'2'}
  ]) {
    const input=syntheticMenu(), product=input.menuGroups[0].products[3];
    input.menuGroups[0].products=[product];
    Object.assign(product.packages[0],changes);
    assert.equal(normalizeMenu(input,'Front',Date.now()).products.length,0);
  }
});
test('THC uses eligible front and legacy packages and excludes back or non-sellable tests', () => {
  const input=syntheticMenu(), product=input.menuGroups[0].products[0];
  input.menuGroups[0].products=[product];
  const pkg=(storageLocation,isSellable,inventoryQty,thc)=>({storageLocation,isSellable,inventoryQty,
    testResults:{uom:'%',totalPotentialPsychoactiveThc:thc}});
  product.packages.push(pkg(null,true,3,28),pkg('Back',true,5,90),pkg(null,false,5,80),pkg(null,true,0,70));
  assert.deepEqual(normalizeMenu(input,'Front',Date.now()).products[0].thc,[25,28]);
});
test('menu cache and lock share updates across visitors, show delayed data briefly, then hide it', async () => {
  const s=setup();const first=await s.run('menu');assert.equal(first.status,200);await s.run('menu');
  assert.equal(s.calls.length,1);s.advance(60001);s.setGF({},429,{'retry-after':'120'});
  const stale=await (await s.run('menu')).json();assert.equal(stale.stale,true);assert.equal(s.calls.length,2);
  await s.run('menu');assert.equal(s.calls.length,2);s.advance(300001);assert.equal((await s.run('menu')).status,503);
});
test('API backoff honors quota headers and limits prevent repeated patient requests', async () => {
  const s=setup(),a=await s.login();await s.seed(a.cookie);s.setGF(null,200,{'ratelimit-remaining':'20','ratelimit-reset':'120'});
  assert.equal((await s.run('points',{cookie:a.cookie})).status,200);
  const calls=s.calls.length;assert.equal((await s.run('points',{cookie:a.cookie})).status,503);assert.equal(s.calls.length,calls);
  s.advance(120001);s.setGF(null);
  for(let i=0;i<10;i++) assert.equal((await s.run('points',{cookie:a.cookie})).status,200);
  assert.equal((await s.run('points',{cookie:a.cookie})).status,429);
});
test('upstream redirects and diagnostic failures never leak secrets or trigger retries', async () => {
  const s=setup(),a=await s.login();await s.seed(a.cookie);let count=0;
  s.deps.fetch=async()=>{count++;return new Response(null,{status:302,headers:{Location:'https://attacker.example/secret'}});};
  s.deps.report=()=>{throw new Error('secret diagnostic body');};
  const response=await s.run('points',{cookie:a.cookie});assert.equal(response.status,503);assert.equal(count,1);
  assert.ok(!(await response.text()).includes('secret'));
});

function preorders({ customer = {}, create, status = 'Completed' } = {}) {
  const s=setup(), base=s.deps.fetch, sent=[];let orders=0;
  Object.assign(s.env,{APP_PREORDER_ENABLED:'true',APP_PREORDER_TOKEN:'gfr_synthetic_preorder_only'});
  s.deps.fetch=async(target,init)=>{
    const body=init?.body && String(target).endsWith('/graphql') ? JSON.parse(init.body) : null;
    if (!body || !/TreehousePreorder|TreehouseCreatePreorder/.test(body.query)) return base(target,init);
    sent.push({query:body.query,variables:body.variables,auth:init.headers.Authorization});
    if (body.query.includes('TreehousePreorderCustomer')) {
      assert.equal(init.headers.Authorization,'Bearer gfr_synthetic_test_only');
      const license=body.variables.where.OR;
      if (license && !license.some(f=>new RegExp(Object.values(f)[0].matchesRegex,'i').test('PAAA-1234-ABCD')))
        return Response.json({data:{findCustomers:{pageInfo:{hasNextPage:false},edges:[]}}});
      return Response.json({data:{findCustomers:{pageInfo:{hasNextPage:false},edges:[{node:{objectId:'CustomerOne',
        Name:'Synthetic Test Patient',Birthday:'1990-05-06T00:00:00.000Z',CustomerType:'Medical',
        CustomerStateLicenseExpiration:'2099-03-31T00:00:00.000Z',LicenseEffectiveEndDate:null,...customer}}]}}});
    }
    assert.equal(init.headers.Authorization,'Bearer gfr_synthetic_preorder_only');
    if (body.query.includes('preorderStatus'))
      return Response.json({data:{preorderStatus:{success:true,order:{id:body.variables.orderId,orderNumber:'1042',status}}}});
    orders++;
    return create ? create() : Response.json({data:{createPreorder:{success:true,order:{id:`GFOrder${orders}`,orderNumber:`${1041+orders}`,status:'New'}}}});
  };
  const mutations=()=>sent.filter(r=>r.query.includes('createPreorder'));
  async function linked() {
    const a=await s.login(), csrf=await s.seed(a.cookie);
    const place=(body,headers={'x-treehouse-csrf':csrf})=>s.run('preorder/place',{method:'POST',cookie:a.cookie,body,headers});
    return {...a,csrf,place,status:()=>s.run('preorder',{cookie:a.cookie})};
  }
  return {...s,sent,mutations,linked};
}
const LICENSE='PAAA-1234-ABCD';
const flower = (qty=2, extra={}) => ({items:[{productId:'public-a',size:'3.5 g',priceCents:2000,qty,...extra}],license:LICENSE});

test('preorders stay off until enabled with a separate token and require a linked account', async () => {
  const s=preorders();
  s.env.APP_PREORDER_TOKEN=s.env.APP_GROWFLOW_TOKEN;assert.equal((await (await s.run('config')).json()).preorderEnabled,false);
  s.env.APP_PREORDER_TOKEN='gfr_synthetic_preorder_only';s.env.APP_PREORDER_ENABLED='false';
  assert.equal((await (await s.run('config')).json()).preorderEnabled,false);
  s.env.APP_PREORDER_ENABLED='true';assert.equal((await (await s.run('config')).json()).preorderEnabled,true);
  assert.equal((await s.run('preorder')).status,401);
  const a=await s.login(), csrf=(await (await s.run('session',{cookie:a.cookie})).json()).csrf;
  assert.equal((await s.run('preorder/place',{method:'POST',cookie:a.cookie,body:flower(),headers:{'x-treehouse-csrf':csrf}})).status,403);
  const b=await s.linked();assert.equal((await b.place(flower(),{})).status,403);
  assert.equal(s.mutations().length,0);
});
test('preorder is rebuilt from the menu and linked record, sent with the preorder token, and not stored in detail', async () => {
  const s=preorders(), a=await s.linked();
  const res=await a.place({...flower(),note:'Call when\nready'});assert.equal(res.status,200);
  const {order}=await res.json();
  assert.deepEqual(order,{orderNumber:'1042',status:'New',open:true,totalCents:4000,itemCount:2,createdAt:order.createdAt});
  const [m]=s.mutations();assert.equal(m.variables.menuKey,'test-menu-key');
  assert.deepEqual(m.variables.preorder,{preOrderType:'Pickup',preOrderTotal:4000,
    customer:{id:'CustomerOne',type:'Medical',firstName:'Synthetic Test',lastName:'Patient',dob:'1990-05-06T00:00:00.000Z',medicalLicenseNumber:LICENSE,medicalLicenseExpires:'2099-03-31'},
    orderItems:[{productId:'public-a',qty:2,weight:3.5}],nameForOrder:'Synthetic Test Patient',preOrderNote:'Call when ready'});
  const stored=JSON.stringify(s.env.APP_DB.db.prepare('SELECT * FROM app_preorders').all());
  assert.ok(!/Synthetic|1990|public-a|Call when|PAAA|1234/.test(stored));
  assert.ok(!s.codes.join(' ').includes('1234'));
  assert.equal((await (await a.status()).json()).order.orderNumber,'1042');
});
test('preorder input is validated and client prices are checked, never trusted', async () => {
  const s=preorders(), a=await s.linked();
  for (const body of [{},{items:[]},{...flower(),license:5},flower(11),flower(0),flower(1.5),flower(2,{extra:true}),{...flower(),total:1},
    {items:[...flower(1).items,...flower(1).items]},{items:[{productId:'../x',size:'3.5 g',priceCents:2000,qty:1}]},
    {...flower(),note:'x'.repeat(201)}]) assert.equal((await a.place(body)).status,400);
  assert.equal((await a.place({items:[...flower(6).items,{productId:'public-d',size:'Each',priceCents:100,qty:5}]})).status,400);
  assert.equal((await a.place(flower(1,{priceCents:1}))).status,409);
  assert.equal((await a.place(flower(1,{size:'7 g'}))).status,409);
  assert.equal((await a.place({items:[{productId:'public-b',size:'Each',priceCents:100,qty:1}]})).status,409);
  assert.equal(s.mutations().length,0);
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_preorders').get().n,0);
  assert.equal((await a.place(flower(1))).status,200);
});
test('order attempts that reach GrowFlow are limited per account', async () => {
  const s=preorders({status:'Canceled'}), a=await s.linked();
  for (let i=0;i<5;i++) { assert.equal((await a.place(flower(1))).status,200); s.advance(30001); await a.status(); }
  assert.equal((await a.place(flower(1))).status,429);assert.equal(s.mutations().length,5);
});
test('a fulfilled (packed) order stays open until checkout', async () => {
  const s=preorders({status:'Fulfilled'}), a=await s.linked();
  assert.equal((await a.place(flower(1))).status,200);s.advance(30001);
  const {order}=await (await a.status()).json();assert.equal(order.status,'Fulfilled');assert.equal(order.open,true);
  assert.equal((await a.place(flower(1))).status,409);
});
test('one open order at a time; a completed order frees the slot', async () => {
  const s=preorders(), a=await s.linked();
  assert.equal((await a.place(flower(1))).status,200);
  const again=await a.place(flower(1));assert.equal(again.status,409);assert.match((await again.json()).error,/already have an order/);
  assert.equal(s.mutations().length,1);
  s.advance(30001);
  const {order}=await (await a.status()).json();assert.equal(order.status,'Completed');assert.equal(order.open,false);
  assert.equal((await a.place(flower(1))).status,200);assert.equal(s.mutations().length,2);
});
test('a request that may have reached GrowFlow blocks retries until staff can check', async () => {
  let fail=true;
  const s=preorders({create:()=>{ if (fail) throw new Error('timeout'); return Response.json({data:{createPreorder:{success:true,order:{id:'GFOrder2',orderNumber:'1043',status:'New'}}}}); }});
  const a=await s.linked();
  const res=await a.place(flower(1));assert.equal(res.status,503);assert.match((await res.json()).error,/call the shop/);
  fail=false;assert.equal((await a.place(flower(1))).status,409);assert.equal(s.mutations().length,1);
  assert.equal((await (await a.status()).json()).order.status,'Unconfirmed');
  s.advance(1800001);assert.equal((await a.place(flower(1))).status,200);assert.equal(s.mutations().length,2);
});
test('failed sends log a fixed category; refused operations free the slot, uncertain ones do not', async () => {
  let reply=()=>Response.json({errors:[{message:'Variable "$preorder" got invalid value; secret-detail',extensions:{code:'BAD_USER_INPUT'}}]});
  const s=preorders({create:()=>reply()}), a=await s.linked();
  const res=await a.place(flower(1));assert.equal(res.status,503);assert.ok(!(await res.text()).includes('secret-detail'));
  assert.ok(s.codes.includes('PREORDER_SEND_GROWFLOW_QUERY_VALIDATION'));assert.ok(!s.codes.join(' ').includes('secret'));
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_preorders').get().n,0);
  reply=()=>Response.json({errors:[{message:'Insufficient Permissions'}]});
  assert.equal((await a.place(flower(1))).status,503);assert.ok(s.codes.includes('PREORDER_SEND_GROWFLOW_QUERY_PERMISSION'));
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_preorders').get().n,0);
  assert.ok(!s.codes.some(c=>c.startsWith('GROWFLOW_ERROR_DETAIL')));
  s.env.APP_DIAGNOSTIC_ERRORS='true';
  reply=()=>Response.json({errors:[{message:'Something broke mid-way for 1990-05-06\nand more',extensions:{code:'X'}}]});
  assert.equal((await a.place(flower(1))).status,503);assert.ok(s.codes.includes('PREORDER_SEND_GROWFLOW_QUERY_OTHER'));
  assert.ok(s.codes.includes('GROWFLOW_ERROR_DETAIL X: Something broke mid-way for ####-##-## and more'));
  assert.equal(s.env.APP_DB.db.prepare("SELECT status FROM app_preorders").get().status,'Unconfirmed');
});
test('HTTP errors from GrowFlow log their status and hold the slot as unconfirmed', async () => {
  const s=preorders({create:()=>Response.json({errors:[{message:'Upstream failed after 12 seconds'}]},{status:500})}), a=await s.linked();
  assert.equal((await a.place(flower(1))).status,503);
  assert.ok(s.codes.includes('PREORDER_SEND_GROWFLOW_HTTP_STATUS_500'));
  assert.ok(!s.codes.some(c=>c.startsWith('GROWFLOW_ERROR_DETAIL')));
  assert.equal(s.env.APP_DB.db.prepare("SELECT status FROM app_preorders").get().status,'Unconfirmed');
  s.env.APP_DIAGNOSTIC_ERRORS='true';s.env.APP_DB.db.exec('DELETE FROM app_preorders');
  assert.equal((await a.place(flower(1))).status,503);
  assert.ok(s.codes.includes('GROWFLOW_ERROR_DETAIL HTTP 500 -: Upstream failed after ## seconds'));
});
test('refused or rate-limited preorders release the slot for another try', async () => {
  let reply=()=>Response.json({data:{createPreorder:{success:false,order:null}}});
  const s=preorders({create:()=>reply()}), a=await s.linked();
  assert.equal((await a.place(flower(1))).status,409);
  reply=()=>new Response('{}',{status:429,headers:{'retry-after':'1'}});
  assert.equal((await a.place(flower(1))).status,503);
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_preorders').get().n,0);
});
test('incomplete customer records cannot place orders', async () => {
  for (const customer of [{Name:'Cher'},{Birthday:null},{Birthday:'not a date'},{CustomerType:''},{CustomerType:'Wholesale'},{objectId:'Other'}]) {
    const s=preorders({customer}), a=await s.linked();
    assert.equal((await a.place(flower(1))).status,409);assert.equal(s.mutations().length,0);
  }
});
test('orders are refused while the menu is delayed', async () => {
  const s=preorders(), a=await s.linked();
  assert.equal((await s.run('menu')).status,200);s.advance(60001);s.setGF({},429,{'retry-after':'1'});
  assert.equal((await a.place(flower(1))).status,503);assert.equal(s.mutations().length,0);
});

test('medical preorders need the customer’s own license number, checked by GrowFlow and never stored', async () => {
  const s=preorders(), a=await s.linked(), {license,...noLicense}=flower(1);
  const missing=await a.place(noLicense);assert.equal(missing.status,400);assert.match((await missing.json()).error,/medical license number/);
  for (const bad of ['PAAA','PAAA 1234 ABCD!','--PAAA1234']) assert.equal((await a.place({...noLicense,license:bad})).status,400);
  const wrong=await a.place({...noLicense,license:'PZZZ-9999-ZZZZ'});assert.equal(wrong.status,400);
  assert.match((await wrong.json()).error,/doesn’t match/);assert.equal(s.mutations().length,0);
  const lookup=s.sent.filter(r=>r.query.includes('TreehousePreorderCustomer')).at(-1).variables.where;
  assert.deepEqual(lookup.objectId,{equalTo:'CustomerOne'});
  assert.deepEqual(Object.keys(lookup.OR[0]),['PatientLicenseNumber']);assert.equal(lookup.OR.length,3);
  const ok=await a.place({...noLicense,license:' paaa1234abcd '});assert.equal(ok.status,200);
  assert.equal(s.mutations()[0].variables.preorder.customer.medicalLicenseNumber,'PAAA1234ABCD');
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_preorders').get().n,1);
  assert.ok(!JSON.stringify(s.env.APP_DB.db.prepare('SELECT * FROM app_preorders').all()).includes('PAAA'));
});
test('license expiry comes from the record; missing or expired licenses cannot order', async () => {
  for (const [customer,status,expires] of [[{CustomerStateLicenseExpiration:null,LicenseEffectiveEndDate:{__type:'Date',iso:'2098-01-15T00:00:00.000Z'}},200,'2098-01-15'],
    [{CustomerStateLicenseExpiration:null},409],[{CustomerStateLicenseExpiration:'2001-01-01T00:00:00.000Z'},409]]) {
    const s=preorders({customer}), a=await s.linked(), res=await a.place(flower(1));
    assert.equal(res.status,status);
    if (expires) assert.equal(s.mutations()[0].variables.preorder.customer.medicalLicenseExpires,expires);
    else { assert.equal(s.mutations().length,0);assert.match((await res.json()).error,/ask your budtender to update it/); }
  }
});
test('recreational customers can order without a license number', async () => {
  const s=preorders({customer:{CustomerType:'Recreational'}}), a=await s.linked(), {license,...noLicense}=flower(1);
  assert.equal((await a.place(noLicense)).status,200);
  assert.equal(s.mutations()[0].variables.preorder.customer.medicalLicenseNumber,undefined);
});
