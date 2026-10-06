import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handleApp } from '../server/customer-app/index.mjs';
import { hash } from '../server/customer-app/http.mjs';
import { normalizeMenu, publicMenu, limitGroup } from '../server/customer-app/growflow.mjs';
import { tapToken } from '../server/crm/campaigns.mjs';
import { encryptPayload, vapidAuthorization, readSubscription, notifyReadyOrders, b64url, fromB64url, READY_MESSAGE } from '../server/customer-app/push.mjs';

// Every migration in order, so tests run against the same schema as a real APP_DB.
const migration = readdirSync(new URL('../app-migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
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
  async function login(sub='auth0|test-one', overrides={}, options={}) {
    subject=sub;claims=overrides;
    const start = await run(options.signup ? 'signup' : 'login',{method:'POST',body:{},cookie:options.cookie || ''}); assert.equal(start.status,303);
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
  const valid=setup(), login=await valid.login();assert.equal(login.response.headers.get('location'),'/app/#setup');
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
test('signup opens Auth0 signup; shop IP supports separate customers while one browser remains bounded', async () => {
  const s = setup();
  const start = await s.run('signup', { method: 'POST', body: {} });
  assert.equal(new URL(start.headers.get('location')).searchParams.get('screen_hint'), 'signup');
  const browser = start.headers.getSetCookie().find(c => c.startsWith('__Host-treehouse_auth_browser=')).split(';')[0];
  for (let i = 1; i < 8; i++) assert.equal((await s.run('login', { method: 'POST', body: {}, cookie: browser })).status, 303);
  assert.equal((await s.run('login', { method: 'POST', body: {}, cookie: browser })).status, 429);
  const shop = setup();
  for (let i = 0; i < 8; i++) assert.ok((await shop.login(`auth0|customer-${i}`)).cookie);
  assert.equal(shop.env.APP_DB.db.prepare('SELECT COUNT(*) n FROM app_users').get().n, 8);
  assert.equal((await shop.run('signup', { method: 'POST', body: {}, headers: { origin: 'https://other.example' } })).status, 403);
});
test('verified signup records the captured source once; old users and tracking outages do not become new signups', async () => {
  const s = setup(); s.env.APP_SIGNUP_TRACKING_ENABLED = 'true';
  const visit = await s.run('signup/visit', { method: 'POST', body: { source: 'bag-card-v1' } });
  const sourceCookie = visit.headers.get('set-cookie').split(';')[0];
  const a = await s.login('auth0|new-person', {}, { cookie: sourceCookie, signup: true });
  assert.ok(a.cookie);
  const recorded = s.env.APP_DB.db.prepare('SELECT source, verified_at, user_id FROM app_signup_visits WHERE user_id IS NOT NULL').all();
  assert.equal(recorded.length, 1); assert.equal(recorded[0].source, 'bag-card-v1'); assert.ok(recorded[0].verified_at);
  await s.login('auth0|new-person', {}, { cookie: sourceCookie });
  assert.equal(s.env.APP_DB.db.prepare('SELECT COUNT(*) n FROM app_signup_visits WHERE user_id IS NOT NULL').get().n, 1);
  const input = { name: 'Synthetic Patient', lastFive: 'ABC-12', identityChecked: true };
  const issued = await (await s.run('staff/enroll', { method: 'POST', body: input, headers: { authorization: `Bearer ${s.env.APP_ENROLLMENT_SECRET}` } })).json();
  const info = await (await s.run('session', { cookie: a.cookie })).json();
  assert.equal((await s.run('enroll', { method: 'POST', body: { code: issued.code }, cookie: a.cookie, headers: { 'x-treehouse-csrf': info.csrf } })).status, 200);
  assert.ok(s.env.APP_DB.db.prepare('SELECT linked_at FROM app_signup_visits WHERE user_id IS NOT NULL').get().linked_at);
  const noTables = setup(); noTables.env.APP_SIGNUP_TRACKING_ENABLED = 'true';
  noTables.env.APP_DB.db.exec('DROP TABLE app_signup_logins; DROP TABLE app_signup_visits;');
  assert.ok((await noTables.login()).cookie); assert.ok(noTables.codes.includes('SIGNUP_TRACKING'));
});
test('verification resend needs a validated unverified login, scoped proof, CSRF, and bounded attempts', async () => {
  const s = setup(); Object.assign(s.env, { APP_AUTH_RESEND_ENABLED: 'true', APP_AUTH_RESEND_DOMAIN: 'test-tenant.auth0.com',
    APP_AUTH_RESEND_CLIENT_ID: 'resend-client', APP_AUTH_RESEND_CLIENT_SECRET: 'synthetic-resend-secret' });
  const original = s.deps.fetch, sent = [];
  s.deps.fetch = async (target, init) => {
    if (init.headers?.['Content-Type'] === 'application/json' && String(target).endsWith('/oauth/token')) {
      const body = JSON.parse(init.body); assert.equal(body.grant_type, 'client_credentials'); assert.equal(body.scope, 'update:users');
      assert.equal(body.client_id, 'resend-client'); sent.push('token');
      return Response.json({ token_type: 'Bearer', access_token: 'temporary-management-token' });
    }
    if (String(target).endsWith('/api/v2/jobs/verification-email')) {
      assert.deepEqual(JSON.parse(init.body), { user_id: 'auth0|needs-email', client_id: 'test-app' }); sent.push('email');
      return Response.json({ type: 'verification_email', status: 'pending' }, { status: 201 });
    }
    return original(target, init);
  };
  const denied = await s.run('verification/resend', { method: 'POST', body: {} }); assert.equal(denied.status, 403); assert.equal(sent.length, 0);
  const unverified = await s.login('auth0|needs-email', { email_verified: false });
  assert.equal(unverified.cookie, ''); assert.equal(unverified.response.headers.get('location'), '/app/#verify-email');
  const cookie = unverified.response.headers.getSetCookie().find(c => c.startsWith('__Host-treehouse_verify=')).split(';')[0];
  const status = await (await s.run('verification/status', { cookie })).json(); assert.equal(status.canResend, true);
  assert.ok(!JSON.stringify(status).includes('needs-email'));
  assert.equal((await s.run('session', { cookie }).then(r => r.json())).signedIn, false);
  const options = { method: 'POST', body: {}, cookie, headers: { 'x-treehouse-csrf': status.csrf } };
  assert.equal((await s.run('verification/resend', { ...options, body: { user_id: 'someone-else' } })).status, 400);
  assert.equal((await s.run('verification/resend', { ...options, headers: { 'x-treehouse-csrf': 'wrong' } })).status, 403);
  const result = await s.run('verification/resend', options); assert.equal(result.status, 200); assert.deepEqual(await result.json(), { requested: true });
  assert.equal(sent.length, 2); assert.equal((await s.run('verification/resend', options)).status, 429); assert.equal(sent.length, 2);
  s.advance(600001); assert.equal((await s.run('verification/resend', options)).status, 403); assert.equal(sent.length, 2);
  assert.equal(s.env.APP_DB.db.prepare('SELECT COUNT(*) n FROM app_sessions').get().n, 0);
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
  assert.equal(issued.status,200);const {code}=await issued.json();assert.match(code,/^[0-9]{4} [0-9]{4}$/);
  assert.ok(!JSON.stringify(s.env.APP_DB.db.prepare('SELECT * FROM app_enrollments').all()).includes(code.replaceAll(' ','')));
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
test('enrollment accepts leading-zero and legacy codes, but enforces account, IP and global guessing limits', async () => {
  for (const code of ['0123 4567', '01234567', '0123-4567', 'ABCD-1234-EF56-7890-ABCD']) {
    const s=setup(), a=await s.login();
    const compact=code.replace(/[ -]/g,'');
    s.env.APP_DB.db.prepare('INSERT INTO app_enrollments VALUES (?,?,?)').run(
      await hash(s.env.APP_LIMIT_SECRET,`enroll:${compact}`),'CustomerOne',s.deps.now()+600000);
    const csrf=(await (await s.run('session',{cookie:a.cookie})).json()).csrf;
    assert.equal((await s.run('enroll',{method:'POST',cookie:a.cookie,body:{code},headers:{'x-treehouse-csrf':csrf}})).status,200);
  }
  for (const rule of ['user','ip','global','day']) {
    const s=setup(),a=await s.login();
    const csrf=(await (await s.run('session',{cookie:a.cookie})).json()).csrf;
    const uid=s.env.APP_DB.db.prepare('SELECT id FROM app_users').get().id;
    const [subject,window,max]=rule==='user' ? [`enroll-user:${uid}`,900000,5]
      : rule==='ip' ? ['enroll-ip:192.0.2.9',900000,50]
      : rule==='day' ? [`enroll-user-day:${uid}`,86400000,20] : ['enroll-global',900000,100];
    const bucket=Math.floor(s.deps.now()/window);
    const limitKey=await hash(s.env.APP_LIMIT_SECRET,`${subject}:${window}:${bucket}`);
    s.env.APP_DB.db.prepare('INSERT INTO rewards_limits VALUES (?,?,?)').run(limitKey,max-1,(bucket+1)*window);
    const attempt=()=>s.run('enroll',{method:'POST',cookie:a.cookie,body:{code:'invalid'},headers:{'x-treehouse-csrf':csrf}});
    assert.equal((await attempt()).status,400); assert.equal((await attempt()).status,429);
    assert.equal(s.env.APP_DB.db.prepare('SELECT customer_id FROM app_users').get().customer_id,null);
    assert.equal((await s.run('session',{cookie:a.cookie})).status,200);
  }
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

const TIERS=[{objectId:'Tier2000',Name:'2000 Points - $150 Off',PointsNeeded:2000,Amount:15000,Type:'Entire Order by Amount'},
  {objectId:'Tier225',Name:'225 Points - $10 Off',PointsNeeded:225,Amount:1000,Type:'Entire Order by Amount'},
  {objectId:'Tier500',Name:'500 Points - $25 Off',PointsNeeded:500,Amount:2500,Type:'Entire Order by Amount'},
  {objectId:'Bad',Name:'',PointsNeeded:0,Amount:5}];
function preorders({ customer = {}, create, status: initialStatus = 'Completed' } = {}) {
  const s=setup(), base=s.deps.fetch, sent=[];let orders=0, status=initialStatus;
  Object.assign(s.env,{APP_PREORDER_ENABLED:'true',APP_PREORDER_TOKEN:'gfr_synthetic_preorder_only'});
  s.deps.fetch=async(target,init)=>{
    const body=init?.body && String(target).endsWith('/graphql') ? JSON.parse(init.body) : null;
    if (body?.query.includes('TreehouseRewardTiers')) {
      sent.push({query:body.query,variables:body.variables,auth:init.headers.Authorization});
      assert.equal(init.headers.Authorization,'Bearer gfr_synthetic_test_only');
      return Response.json({data:{findDiscounts:{edges:TIERS.map(node=>({node}))}}});
    }
    if (!body || !/TreehousePreorder|TreehouseCreatePreorder/.test(body.query)) return base(target,init);
    sent.push({query:body.query,variables:body.variables,auth:init.headers.Authorization});
    if (body.query.includes('TreehousePreorderCustomer')) {
      assert.equal(init.headers.Authorization,'Bearer gfr_synthetic_test_only');
      const license=body.variables.where.OR;
      if (license && !license.some(f=>new RegExp(Object.values(f)[0].matchesRegex,'i').test('PAAA-1234-ABCD')))
        return Response.json({data:{findCustomers:{pageInfo:{hasNextPage:false},edges:[]}}});
      return Response.json({data:{findCustomers:{pageInfo:{hasNextPage:false},edges:[{node:{objectId:'CustomerOne',
        Name:'Synthetic Test Patient',Birthday:'1990-05-06T00:00:00.000Z',CustomerType:'Medical',CurrentPoints:612,
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
  return {...s,sent,mutations,linked,setStatus:x=>{status=x;}};
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
    customer:{id:'CustomerOne',type:'Medical',firstName:'Synthetic Test',lastName:'Patient',dob:'1990-05-06T00:00:00.000Z',medicalLicenseNumber:LICENSE,medicalLicenseExpires:'2099-03-31T00:00:00.000Z'},
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
  s.advance(3600000-(s.deps.now()%3600000)+1000); // Start of an hourly window, whatever the clock says.
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
  // The retired diagnostic switch has no effect: GrowFlow's error text is never logged.
  s.env.APP_DIAGNOSTIC_ERRORS='true';
  reply=()=>Response.json({errors:[{message:'Something broke for Synthetic Patient 1990-05-06',extensions:{code:'X'}}]});
  assert.equal((await a.place(flower(1))).status,503);assert.ok(s.codes.includes('PREORDER_SEND_GROWFLOW_QUERY_OTHER'));
  assert.ok(!s.codes.join(' ').match(/Synthetic|1990|Something broke/));
  assert.equal(s.env.APP_DB.db.prepare("SELECT status FROM app_preorders").get().status,'Unconfirmed');
});
test('HTTP errors from GrowFlow log their status and hold the slot as unconfirmed', async () => {
  const s=preorders({create:()=>Response.json({errors:[{message:'Upstream failed after 12 seconds'}]},{status:500})}), a=await s.linked();
  assert.equal((await a.place(flower(1))).status,503);
  assert.ok(s.codes.includes('PREORDER_SEND_GROWFLOW_HTTP_STATUS_500'));
  assert.equal(s.env.APP_DB.db.prepare("SELECT status FROM app_preorders").get().status,'Unconfirmed');
  s.env.APP_DIAGNOSTIC_ERRORS='true';s.env.APP_DB.db.exec('DELETE FROM app_preorders');
  assert.equal((await a.place(flower(1))).status,503);
  assert.ok(!s.codes.join(' ').includes('Upstream failed'));
});
test('a menu or store with preorders switched off frees the slot and says so', async () => {
  const s=preorders({create:()=>Response.json({errors:[{message:'PreOrders are not allowed for this menu.',extensions:{code:'INTERNAL_SERVER_ERROR'}}]})});
  const a=await s.linked(), res=await a.place(flower(1));
  assert.equal(res.status,503);assert.match((await res.json()).error,/Ordering ahead isn’t available right now/);
  assert.ok(s.codes.includes('PREORDER_SEND_GROWFLOW_QUERY_PREORDERS_OFF'));
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_preorders').get().n,0);
});
test('HTTP 400 validation refusals free the slot immediately', async () => {
  const s=preorders({create:()=>Response.json({errors:[{message:'Variable "$preorder" got invalid value',extensions:{code:'BAD_USER_INPUT'}}]},{status:400})});
  const a=await s.linked();
  assert.equal((await a.place(flower(1))).status,503);
  assert.ok(s.codes.includes('PREORDER_SEND_GROWFLOW_HTTP_VALIDATION'));
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_preorders').get().n,0);
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
  assert.match((await wrong.json()).error,/doesn’t match.*new or renewed license.*update your store record/s);assert.equal(s.mutations().length,0);
  const lookup=s.sent.filter(r=>r.query.includes('TreehousePreorderCustomer')).at(-1).variables.where;
  assert.deepEqual(lookup.objectId,{equalTo:'CustomerOne'});
  assert.deepEqual(Object.keys(lookup.OR[0]),['PatientLicenseNumber']);assert.equal(lookup.OR.length,3);
  const ok=await a.place({...noLicense,license:' paaa1234abcd '});assert.equal(ok.status,200);
  assert.equal(s.mutations()[0].variables.preorder.customer.medicalLicenseNumber,'PAAA1234ABCD');
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_preorders').get().n,1);
  assert.ok(!JSON.stringify(s.env.APP_DB.db.prepare('SELECT * FROM app_preorders').all()).includes('PAAA'));
});
test('license expiry comes from the record (the later of its two dates); missing or expired licenses cannot order', async () => {
  for (const [customer,status,expires] of [[{CustomerStateLicenseExpiration:null,LicenseEffectiveEndDate:{__type:'Date',iso:'2098-01-15T05:00:00.000Z'}},200,'2098-01-15T00:00:00.000Z'],
    [{CustomerStateLicenseExpiration:null},409],[{CustomerStateLicenseExpiration:'2001-01-01T00:00:00.000Z'},409],
    // Renewed card: one date still holds the old card's expiry. The later date counts, either way round.
    [{CustomerStateLicenseExpiration:'2001-01-01T00:00:00.000Z',LicenseEffectiveEndDate:{__type:'Date',iso:'2098-03-01T06:00:00.000Z'}},200,'2098-03-01T00:00:00.000Z'],
    [{CustomerStateLicenseExpiration:'2098-04-01T05:00:00.000Z',LicenseEffectiveEndDate:{__type:'Date',iso:'2001-01-01T06:00:00.000Z'}},200,'2098-04-01T00:00:00.000Z'],
    [{CustomerStateLicenseExpiration:'2001-01-01T00:00:00.000Z',LicenseEffectiveEndDate:'2002-01-01T00:00:00.000Z'},409]]) {
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

// A phone's side of Web Push: its key pair and auth secret, and RFC 8291 decryption.
async function device(endpoint='https://fcm.googleapis.com/fcm/send/synthetic-device') {
  const keys=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const auth=crypto.getRandomValues(new Uint8Array(16));
  const p256dh=new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey));
  return {keys,subscription:{endpoint,expirationTime:null,keys:{p256dh:b64url(p256dh),auth:b64url(auth)}}};
}
async function decrypt(phone, body) {
  const h=async(k,d)=>new Uint8Array(await crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',k,{name:'HMAC',hash:'SHA-256'},false,['sign']),d));
  const cat=(...p)=>{const o=new Uint8Array(p.reduce((n,x)=>n+x.length,0));let i=0;for(const x of p){o.set(x,i);i+=x.length;}return o;};
  const te=new TextEncoder(), salt=body.slice(0,16), idlen=body[20], asPublic=body.slice(21,21+idlen), sealed=body.slice(21+idlen);
  assert.equal(new DataView(body.buffer,body.byteOffset).getUint32(16),4096);
  const asKey=await crypto.subtle.importKey('raw',asPublic,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:asKey},phone.keys.privateKey,256));
  const uaPublic=fromB64url(phone.subscription.keys.p256dh), auth=fromB64url(phone.subscription.keys.auth);
  const ikm=await h(await h(auth,shared),cat(te.encode('WebPush: info\0'),uaPublic,asPublic,new Uint8Array([1])));
  const prk=await h(salt,ikm);
  const cek=(await h(prk,cat(te.encode('Content-Encoding: aes128gcm\0'),new Uint8Array([1])))).slice(0,16);
  const nonce=(await h(prk,cat(te.encode('Content-Encoding: nonce\0'),new Uint8Array([1])))).slice(0,12);
  const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce},await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['decrypt']),sealed));
  assert.equal(plain.at(-1),2);return new TextDecoder().decode(plain.slice(0,-1));
}
async function vapid() {
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  return {pair,publicKey:b64url(await crypto.subtle.exportKey('raw',pair.publicKey)),
    privateJwk:JSON.stringify(await crypto.subtle.exportKey('jwk',pair.privateKey))};
}
async function withPush(options) {
  const s=preorders(options), v=await vapid(), pushes=[], base=s.deps.fetch;
  let pushStatus=201;
  Object.assign(s.env,{APP_PUSH_ENABLED:'true',APP_VAPID_PUBLIC_KEY:v.publicKey,APP_VAPID_PRIVATE_JWK:v.privateJwk,APP_PUSH_SUBJECT:'https://preview.example.test/app/'});
  s.deps.fetch=async(target,init)=>{
    if (new URL(String(target)).hostname==='fcm.googleapis.com') { pushes.push({url:String(target),init}); return new Response('',{status:pushStatus}); }
    return base(target,init);
  };
  return {...s,v,pushes,setPushStatus:x=>{pushStatus=x;}};
}

test('push payloads decrypt on the device and VAPID signatures verify', async () => {
  const phone=await device(), v=await vapid(), env={APP_VAPID_PUBLIC_KEY:v.publicKey,APP_VAPID_PRIVATE_JWK:v.privateJwk,APP_PUSH_SUBJECT:'mailto:owner@example.test'};
  const body=await encryptPayload(readSubscription(phone.subscription),JSON.stringify(READY_MESSAGE));
  assert.deepEqual(JSON.parse(await decrypt(phone,body)),READY_MESSAGE);
  const header=await vapidAuthorization(env,phone.subscription.endpoint,Date.UTC(2026,8,29));
  const [, token, key]=header.match(/^vapid t=([^,]+), k=(.+)$/);assert.equal(key,v.publicKey);
  const [h,c,sig]=token.split('.');const claims=JSON.parse(Buffer.from(c,'base64url'));
  assert.equal(claims.aud,'https://fcm.googleapis.com');assert.equal(claims.sub,'mailto:owner@example.test');
  assert.ok(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},v.pair.publicKey,Buffer.from(sig,'base64url'),new TextEncoder().encode(`${h}.${c}`)));
});
test('only well-formed subscriptions to known push services are accepted', async () => {
  const {subscription}=await device();
  assert.ok(readSubscription(subscription));
  assert.ok(readSubscription({...subscription,endpoint:'https://web.push.apple.com/QGuQyavXutnMH'}));
  for (const bad of [{...subscription,endpoint:'https://attacker.example/push'},{...subscription,endpoint:'http://fcm.googleapis.com/x'},
    {...subscription,endpoint:'https://fcm.googleapis.com:8443/x'},{...subscription,keys:{...subscription.keys,auth:'short'}},
    {...subscription,keys:{...subscription.keys,p256dh:b64url(new Uint8Array(65))}},{...subscription,extra:1}])
    assert.equal(readSubscription(bad),null);
});
test('devices subscribe only when linked and enabled; sign-out everywhere and unlinking remove them', async () => {
  const s=await withPush(), phone=await device();
  assert.equal((await (await s.run('config')).json()).pushKey,s.v.publicKey);
  const a=await s.login(), csrf=(await (await s.run('session',{cookie:a.cookie})).json()).csrf;
  const sub=(body,cookie=a.cookie,token=csrf)=>s.run('push/subscribe',{method:'POST',cookie,body,headers:{'x-treehouse-csrf':token}});
  assert.equal((await sub(phone.subscription)).status,403);
  const b=await s.linked();
  assert.equal((await s.run('push/subscribe',{method:'POST',cookie:b.cookie,body:phone.subscription})).status,403);
  assert.equal((await sub({...phone.subscription,endpoint:'https://attacker.example/x'},b.cookie,b.csrf)).status,400);
  assert.equal((await sub(phone.subscription,b.cookie,b.csrf)).status,200);
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_push_subscriptions').get().n,1);
  assert.equal((await s.run('logout-all',{method:'POST',cookie:b.cookie,body:{},headers:{'x-treehouse-csrf':b.csrf}})).status,200);
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_push_subscriptions').get().n,0);
  s.env.APP_PUSH_ENABLED='false';assert.equal((await (await s.run('config')).json()).pushKey,undefined);
});
test('the notifier sends one encrypted "ready" message per device when GrowFlow marks the order Fulfilled', async () => {
  const s=await withPush({status:'Unfulfilled'}), a=await s.linked(), phone=await device(), other=await device('https://fcm.googleapis.com/fcm/send/old-device');
  await s.run('push/subscribe',{method:'POST',cookie:a.cookie,body:phone.subscription,headers:{'x-treehouse-csrf':a.csrf}});
  await s.run('push/subscribe',{method:'POST',cookie:a.cookie,body:other.subscription,headers:{'x-treehouse-csrf':a.csrf}});
  assert.equal((await a.place(flower(1))).status,200);
  s.advance(60001);assert.deepEqual(await notifyReadyOrders(s.env,s.deps),{checked:1,notified:0});assert.equal(s.pushes.length,0);
  s.env.APP_DB.db.exec("UPDATE app_preorders SET status='Fulfilled'");s.setPushStatus(201);
  // Old device's subscription has expired at the push service.
  const base=s.deps.fetch;s.deps.fetch=async(t,i)=>String(t).includes('old-device')?(s.pushes.push({url:String(t),init:i}),new Response('',{status:410})):base(t,i);
  assert.deepEqual(await notifyReadyOrders(s.env,s.deps),{checked:1,notified:1});
  const sent=s.pushes.find(p=>p.url===phone.subscription.endpoint);
  assert.equal(sent.init.headers['Content-Encoding'],'aes128gcm');assert.match(sent.init.headers.Authorization,/^vapid t=/);
  assert.deepEqual(JSON.parse(await decrypt(phone,sent.init.body)),READY_MESSAGE);
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_push_subscriptions').get().n,1);
  const count=s.pushes.length;s.advance(60001);
  assert.deepEqual(await notifyReadyOrders(s.env,s.deps),{checked:0,notified:0});assert.equal(s.pushes.length,count);
});
test('the notifier skips completed, canceled and old orders, and does nothing without its keys', async () => {
  for (const status of ['Completed','Canceled']) {
    const s=await withPush({status}), a=await s.linked(), phone=await device();
    await s.run('push/subscribe',{method:'POST',cookie:a.cookie,body:phone.subscription,headers:{'x-treehouse-csrf':a.csrf}});
    await a.place(flower(1));s.advance(60001);
    await notifyReadyOrders(s.env,s.deps);assert.equal(s.pushes.length,0);
  }
  const s=await withPush({status:'Fulfilled'}), a=await s.linked(), phone=await device();
  await s.run('push/subscribe',{method:'POST',cookie:a.cookie,body:phone.subscription,headers:{'x-treehouse-csrf':a.csrf}});
  await a.place(flower(1));
  const {APP_VAPID_PRIVATE_JWK,...noKey}=s.env;
  assert.deepEqual(await notifyReadyOrders(noKey,s.deps),{checked:0,notified:0});
  s.advance(12*3600000+1);assert.deepEqual(await notifyReadyOrders(s.env,s.deps),{checked:0,notified:0});assert.equal(s.pushes.length,0);
});

// Places a Fulfilled order for a linked account with the given devices subscribed.
async function readyOrder(phones, respond) {
  const s=await withPush({status:'Unfulfilled'}), a=await s.linked(), base=s.deps.fetch, byDevice={};
  for (const p of phones) await s.run('push/subscribe',{method:'POST',cookie:a.cookie,body:p.subscription,headers:{'x-treehouse-csrf':a.csrf}});
  assert.equal((await a.place(flower(1))).status,200);
  s.setStatus('Fulfilled');s.advance(60001);
  s.deps.fetch=async(t,i)=>{
    const url=String(t);
    if (new URL(url).hostname!=='fcm.googleapis.com') return base(t,i);
    byDevice[url]=(byDevice[url]||0)+1;
    return respond(url,byDevice[url]);
  };
  const delivery=endpoint=>s.env.APP_DB.db.prepare('SELECT state, attempts FROM app_push_deliveries WHERE endpoint=?').get(endpoint);
  return {...s,a,byDevice,delivery,run:()=>notifyReadyOrders(s.env,s.deps),order:()=>s.env.APP_DB.db.prepare('SELECT notified_ready FROM app_preorders').get()};
}

test('a failed push is retried on a later run instead of being lost', async () => {
  const phone=await device(), t=await readyOrder([phone],(url,n)=>new Response('',{status:n===1?503:201}));
  assert.deepEqual(await t.run(),{checked:1,notified:0});
  assert.deepEqual({...t.delivery(phone.subscription.endpoint)},{state:'failed',attempts:1});
  assert.equal(t.order().notified_ready,0);assert.ok(t.codes.includes('PUSH_SEND'));
  await t.run();assert.equal(t.byDevice[phone.subscription.endpoint],1); // Not before its retry time.
  t.advance(60001);assert.deepEqual(await t.run(),{checked:1,notified:1});
  assert.equal(t.byDevice[phone.subscription.endpoint],2);
  assert.deepEqual({...t.delivery(phone.subscription.endpoint)},{state:'sent',attempts:2});
  assert.equal(t.order().notified_ready,1);
});
test('deliveries are tracked per device: only the device that failed is retried', async () => {
  const good=await device('https://fcm.googleapis.com/fcm/send/good'), flaky=await device('https://fcm.googleapis.com/fcm/send/flaky');
  const t=await readyOrder([good,flaky],(url,n)=>new Response('',{status:url.endsWith('flaky')&&n===1?500:201}));
  assert.deepEqual(await t.run(),{checked:1,notified:1});
  t.advance(60001);assert.deepEqual(await t.run(),{checked:1,notified:1});
  assert.equal(t.byDevice[good.subscription.endpoint],1);assert.equal(t.byDevice[flaky.subscription.endpoint],2);
  assert.equal(t.order().notified_ready,1);
});
test('overlapping runs send each device exactly one notification', async () => {
  const phones=[await device('https://fcm.googleapis.com/fcm/send/one'),await device('https://fcm.googleapis.com/fcm/send/two')];
  const t=await readyOrder(phones,async()=>{await new Promise(r=>setTimeout(r,20));return new Response('',{status:201});});
  const results=await Promise.all([t.run(),t.run(),t.run()]);
  assert.equal(results.reduce((n,r)=>n+r.notified,0),2);
  for (const p of phones) assert.equal(t.byDevice[p.subscription.endpoint],1);
  t.advance(600000);await t.run();for (const p of phones) assert.equal(t.byDevice[p.subscription.endpoint],1);
});
test('a run that dies mid-send is retried after its lease expires', async () => {
  const phone=await device();let crash=true;
  const t=await readyOrder([phone],()=>{ if (crash) throw new Error('worker stopped'); return new Response('',{status:201}); });
  // Simulate the Worker being cut off after claiming but before recording the outcome.
  const endpoint=phone.subscription.endpoint;
  t.env.APP_DB.db.prepare("INSERT INTO app_push_deliveries VALUES ((SELECT id FROM app_preorders),?, 'sending',1,?,?)").run(endpoint,t.deps.now()+120000,t.deps.now());
  crash=false;await t.run();assert.equal(t.byDevice[endpoint],undefined);
  t.advance(120001);assert.deepEqual(await t.run(),{checked:1,notified:1});assert.equal(t.byDevice[endpoint],1);
});
test('retries are bounded, and stop once the order is picked up', async () => {
  const phone=await device(), t=await readyOrder([phone],()=>new Response('',{status:500}));
  for (let i=0;i<8;i++) { await t.run(); t.advance(900001); }
  assert.equal(t.byDevice[phone.subscription.endpoint],5);assert.ok(t.codes.includes('PUSH_SEND_GAVE_UP'));
  assert.equal(t.order().notified_ready,1);
  const other=await device(), u=await readyOrder([other],()=>new Response('',{status:500}));
  await u.run();u.setStatus('Completed');u.advance(900001);await u.run();
  assert.equal(u.byDevice[other.subscription.endpoint],1);
});
test('push requests carry a per-order topic so an undelivered copy is replaced, not doubled', async () => {
  const phone=await device();let headers;
  const t=await readyOrder([phone],(url)=>new Response('',{status:201}));
  const inner=t.deps.fetch;t.deps.fetch=async(u,i)=>{ if (String(u).includes('fcm')) headers=i.headers; return inner(u,i); };
  await t.run();assert.match(headers.Topic,/^[0-9a-f]{32}$/);
});

test('reward tiers come from GrowFlow loyalty discounts, sorted, cached and off until enabled', async () => {
  const s=preorders();
  assert.equal((await (await s.run('config')).json()).rewardTiersEnabled,false);assert.equal((await s.run('rewards')).status,503);
  s.env.APP_REWARD_TIERS_ENABLED='true';assert.equal((await (await s.run('config')).json()).rewardTiersEnabled,true);
  const {tiers}=await (await s.run('rewards')).json();
  assert.deepEqual(tiers.map(t=>[t.id,t.points,t.amountCents]),[['Tier225',225,1000],['Tier500',500,2500],['Tier2000',2000,15000]]);
  await s.run('rewards');assert.equal(s.sent.filter(r=>r.query.includes('TreehouseRewardTiers')).length,1);
  const where=s.sent.find(r=>r.query.includes('TreehouseRewardTiers')).query;
  assert.match(where,/IsLoyaltyDiscount: \{ equalTo: true \}/);assert.match(where,/Active: \{ equalTo: true \}/);
});
test('a chosen reward is checked against points and order size, then noted for staff at full price', async () => {
  const s=preorders();s.env.APP_REWARD_TIERS_ENABLED='true';const a=await s.linked();
  const order=(extra,qty=2)=>a.place({...flower(qty),...extra});
  assert.equal((await order({reward:'Tier2000'})).status,409);                 // 612 points < 2000
  assert.equal((await order({reward:'Tier500'},1)).status,409);                // $25 off a $20 order
  assert.equal((await order({reward:'Unknown'})).status,409);
  assert.equal((await order({reward:'../x'})).status,400);
  assert.equal(s.mutations().length,0);
  const res=await order({reward:'Tier500',note:'Call me'});assert.equal(res.status,200);
  assert.equal((await res.json()).order.rewardName,'500 Points - $25 Off');
  const p=s.mutations()[0].variables.preorder;
  assert.equal(p.preOrderTotal,4000);
  assert.equal(p.preOrderNote,'REWARD REQUESTED: 500 Points - $25 Off (612 points at order time). Apply at checkout. | Call me');
  assert.equal((await (await a.status()).json()).order.rewardName,'500 Points - $25 Off');
});
test('rewards cannot be requested while tiers are switched off', async () => {
  const s=preorders(), a=await s.linked();
  assert.equal((await a.place({...flower(2),reward:'Tier225'})).status,409);assert.equal(s.mutations().length,0);
  assert.equal((await a.place(flower(2))).status,200);assert.equal(s.mutations()[0].variables.preorder.preOrderNote,undefined);
});

async function withLicenseMemory(options) {
  const s=preorders(options);
  Object.assign(s.env,{APP_LICENSE_MEMORY_ENABLED:'true',APP_LICENSE_KEY:b64url(crypto.getRandomValues(new Uint8Array(32)))});
  const a=await s.linked(), saved=()=>s.env.APP_DB.db.prepare('SELECT license_enc, license_hint FROM app_users WHERE customer_id=?').get('CustomerOne');
  const reopen=async()=>{ s.advance(30001); await a.status(); }; // Let the open order finish (Completed).
  return {...s,a,saved,reopen,session:async()=>(await s.run('session',{cookie:a.cookie})).json()};
}
test('an opted-in license is saved encrypted after GrowFlow confirms it, and reused without retyping', async () => {
  const s=await withLicenseMemory();
  assert.equal((await (await s.run('config')).json()).licenseMemoryEnabled,true);
  const first=await s.a.place({...flower(1),rememberLicense:true});assert.equal(first.status,200);
  assert.equal((await first.json()).order.licenseHint,'ABCD');
  const row=s.saved();assert.match(row.license_enc,/^v1\./);assert.equal(row.license_hint,'ABCD');
  assert.ok(!row.license_enc.includes('PAAA')&&!row.license_enc.includes('1234'));
  assert.deepEqual(Object.keys(await s.session()).sort(),['csrf','licenseHint','linked','signedIn']);
  assert.equal((await s.session()).licenseHint,'ABCD');
  await s.reopen();const {license,...noLicense}=flower(1);
  assert.equal((await s.a.place({...noLicense,useSavedLicense:true})).status,200);
  assert.equal(s.mutations()[1].variables.preorder.customer.medicalLicenseNumber,LICENSE);
  const lookup=s.sent.filter(r=>r.query.includes('TreehousePreorderCustomer')).at(-1).variables.where;
  assert.ok(lookup.OR,'the saved license is re-checked against GrowFlow');
  const everything=JSON.stringify([s.codes,await (await s.run('config')).text(),await s.session()]);
  assert.ok(!everything.includes('PAAA')&&!everything.includes('1234'));
});
test('nothing is saved without opting in, and typing without "remember" clears a saved copy', async () => {
  const s=await withLicenseMemory();
  assert.equal((await s.a.place(flower(1))).status,200);assert.equal(s.saved().license_enc,null);
  await s.reopen();await s.a.place({...flower(1),rememberLicense:true});assert.ok(s.saved().license_enc);
  await s.reopen();await s.a.place(flower(1));assert.equal(s.saved().license_enc,null);assert.equal(s.saved().license_hint,null);
});
test('a saved license that no longer matches, or cannot be decrypted, is removed and asked for again', async () => {
  const s=await withLicenseMemory();const {license,...noLicense}=flower(1);
  await s.a.place({...flower(1),rememberLicense:true});await s.reopen();
  // Swap in a validly encrypted but wrong number (e.g. the patient renewed their license).
  const {sealLicense}=await import('../server/customer-app/license.mjs');
  const user=s.env.APP_DB.db.prepare('SELECT id FROM app_users WHERE customer_id=?').get('CustomerOne').id;
  s.env.APP_DB.db.prepare('UPDATE app_users SET license_enc=? WHERE id=?').run(await sealLicense(s.env,user,'PZZZ-9999-ZZZZ'),user);
  const res=await s.a.place({...noLicense,useSavedLicense:true});assert.equal(res.status,400);
  assert.match((await res.json()).error,/no longer matches.*new or renewed license.*update your store record/s);assert.equal(s.saved().license_enc,null);assert.equal(s.mutations().length,1);
  // Ciphertext bound to another account (or a rotated key) cannot be opened.
  await s.a.place({...flower(1),rememberLicense:true});await s.reopen();
  s.env.APP_DB.db.prepare('UPDATE app_users SET license_enc=? WHERE id=?').run(await sealLicense(s.env,'someone-else',LICENSE),user);
  assert.equal((await s.a.place({...noLicense,useSavedLicense:true})).status,400);assert.equal(s.saved().license_enc,null);
});
test('customers can forget a saved license; unlinking deletes it; the feature stays off without its key', async () => {
  const s=await withLicenseMemory();
  await s.a.place({...flower(1),rememberLicense:true});
  assert.equal((await s.run('license/forget',{method:'POST',cookie:s.a.cookie,body:{}})).status,403);
  assert.equal((await s.run('license/forget',{method:'POST',cookie:s.a.cookie,body:{},headers:{'x-treehouse-csrf':s.a.csrf}})).status,200);
  assert.equal(s.saved().license_enc,null);
  await s.reopen();await s.a.place({...flower(1),rememberLicense:true});
  await s.run('remove-link',{method:'POST',cookie:s.a.cookie,body:{},headers:{'x-treehouse-csrf':s.a.csrf}});
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_users WHERE license_enc IS NOT NULL').get().n,0);
  const off=preorders(), b=await off.linked(), {license,...noLicense}=flower(1);
  assert.equal((await (await off.run('config')).json()).licenseMemoryEnabled,false);
  assert.equal((await b.place({...flower(1),rememberLicense:true})).status,200);
  assert.equal(off.env.APP_DB.db.prepare('SELECT license_enc FROM app_users').get().license_enc,null);
  off.advance(30001);await b.status();
  assert.equal((await b.place({...noLicense,useSavedLicense:true})).status,400);
  for (const bad of [{...flower(1),useSavedLicense:true},{...flower(1),rememberLicense:'yes'}]) assert.equal((await b.place(bad)).status,400);
});

test('a push subscription cannot be taken over by another account', async () => {
  const s=await withPush(), phone=await device();
  const one=await s.linked();
  assert.equal((await s.run('push/subscribe',{method:'POST',cookie:one.cookie,body:phone.subscription,headers:{'x-treehouse-csrf':one.csrf}})).status,200);
  const other=await s.login('auth0|other-account'), csrf=await s.seed(other.cookie,'CustomerTwo');
  const res=await s.run('push/subscribe',{method:'POST',cookie:other.cookie,body:phone.subscription,headers:{'x-treehouse-csrf':csrf}});
  assert.equal(res.status,409);
  const owner=s.env.APP_DB.db.prepare('SELECT u.customer_id FROM app_push_subscriptions p JOIN app_users u ON u.id=p.user_id').all();
  assert.deepEqual(owner.map(r=>r.customer_id),['CustomerOne']);
  // The owner can refresh its own subscription.
  assert.equal((await s.run('push/subscribe',{method:'POST',cookie:one.cookie,body:phone.subscription,headers:{'x-treehouse-csrf':one.csrf}})).status,200);
});

test('menu cards carry CBD, CBD-rich, photo, plain-text description and price per gram', () => {
  const pkg=(thc,cbd)=>({storageLocation:'Front',isSellable:true,inventoryQty:3,testResults:{uom:'%',totalPotentialPsychoactiveThc:thc,cbd}});
  const input={pricesIncludeTax:true,menuGroups:[{name:'Flower',products:[
    {id:'p1',name:'Eighth',strain:'Calm Day',category:'Flower',cannabisType:'Indica',image:'https://cdn.example.test/p1.jpg',
      description:'<p>Smooth&nbsp;and <b>earthy</b>.</p>',variants:[{weight:3.5,uom:'g',price:2000},{weight:1,uom:'oz',price:14000}],packages:[pkg(4,12)]},
    {id:'p2',name:'Strong One',category:'Flower',image:'javascript:alert(1)',variants:[{price:1500}],packages:[pkg(28,0.1)]},
    {id:'p3',name:'Http Image',category:'Flower',image:'http://cdn.example.test/p3.jpg',variants:[{price:1500}],packages:[pkg(20,null)]}
  ]}]};
  const menu=normalizeMenu(input,'Front',Date.now()), [p1,p2,p3]=['p1','p2','p3'].map(id=>menu.products.find(p=>p.id===id));
  assert.equal(p1.cbdRich,true);assert.deepEqual(p1.cbd,[12,12]);assert.equal(p1.image,'https://cdn.example.test/p1.jpg');
  assert.equal(p1.description,'Smooth and earthy .');assert.equal(p1.flower,true);
  assert.deepEqual(p1.variants.map(v=>[v.grams,v.pricePerGramCents]),[[3.5,571],[28.35,494]]);
  assert.equal(p2.cbdRich,false);assert.equal(p2.image,null);assert.equal(p2.variants[0].pricePerGramCents,null);
  assert.equal(p3.image,null);assert.equal(p3.cbd,null);assert.equal(p3.cbdRich,false);
});

test('availability follows front-room stock in units or grams, and hides sizes stock cannot fill', () => {
  const pkg=(qty,loc='Front')=>({storageLocation:loc,isSellable:true,inventoryQty:qty,testResults:null});
  const menu=normalizeMenu({pricesIncludeTax:true,menuGroups:[{name:'Flower',products:[
    {id:'bulk',name:'Bulk',category:'Flower',uom:'Grams',variants:[{weight:3.5,uom:'g',price:2000},{weight:7,uom:'g',price:3800},{weight:14,uom:'g',price:7000}],
      packages:[pkg(6),pkg(4),pkg(500,'Back')]},
    {id:'jars',name:'Jars',category:'Flower',uom:'Each',variants:[{weight:3.5,uom:'g',price:2500}],packages:[pkg(37)]},
    {id:'gone',name:'Gone',category:'Flower',uom:'Grams',variants:[{weight:3.5,uom:'g',price:2500}],packages:[pkg(2)]}
  ]}]},'Front',Date.now());
  const bulk=menu.products.find(p=>p.id==='bulk'), jars=menu.products.find(p=>p.id==='jars');
  assert.equal(bulk.stockUnits,10);assert.deepEqual(bulk.variants.map(v=>[v.size,v.available]),[['3.5 g',2],['7 g',1]]);
  assert.equal(jars.variants[0].available,37);assert.equal(menu.products.some(p=>p.id==='gone'),false);
  const shown=publicMenu(menu), text=JSON.stringify(shown);
  assert.ok(!text.includes('stockUnits')&&!text.includes('unitsEach'));
  assert.equal(shown.products.find(p=>p.id==='jars').variants[0].available,10);
});
test('orders cannot exceed stock, counting every size of a product together', async () => {
  const s=preorders(), a=await s.linked();
  s.setGF({findMenus:{pricesIncludeTax:true,menuGroups:[{name:'Flower',products:[
    {id:'public-a',name:'A',strain:'Sample Strain',category:'Flower',uom:'Grams',variants:[{weight:3.5,uom:'g',price:2000},{weight:7,uom:'g',price:3800}],
      packages:[{storageLocation:'Front',isSellable:true,inventoryQty:12,testResults:null}]}]}]}});
  const menu=await (await s.run('menu')).json();
  assert.deepEqual(menu.products[0].variants.map(v=>v.available),[3,1]);assert.equal(menu.products[0].stockUnits,undefined);
  s.setGF(null);
  const item=(size,priceCents,qty)=>({productId:'public-a',size,priceCents,qty});
  const over=await a.place({items:[item('3.5 g',2000,2),item('7 g',3800,1)],license:LICENSE}); // 14 g > 12 g
  assert.equal(over.status,409);assert.match((await over.json()).error,/fewer in stock/);assert.equal(s.mutations().length,0);
  assert.equal((await a.place({items:[item('3.5 g',2000,4)],license:LICENSE})).status,409);
  assert.equal((await a.place({items:[item('3.5 g',2000,1),item('7 g',3800,1)],license:LICENSE})).status,200); // 10.5 g
});

test('products are grouped for purchase limits by GrowFlow category type, falling back to the name', () => {
  assert.equal(limitGroup('Flower','Anything'),'flower');assert.equal(limitGroup('','Pre-Rolls'),'flower');
  assert.equal(limitGroup('','Vape Cartridges'),'concentrate');assert.equal(limitGroup('','Gummies'),'edible');
  assert.equal(limitGroup('Edible','Infused Pre-Roll'),'edible'); // Type wins over the name.
  assert.equal(limitGroup('','Drinks'),'edible');assert.equal(limitGroup('','Lotion'),'topical');
  assert.equal(limitGroup('','Seeds'),'seed');assert.equal(limitGroup('','Dab Accessories'),null);assert.equal(limitGroup('','Batteries / Pens'),null);assert.equal(limitGroup('','Papers / Wraps'),null);assert.equal(limitGroup('','Live Badder Buckets - 3.5'),'concentrate');assert.equal(limitGroup('','Infused Pre-Roll'),'flower');assert.equal(limitGroup('','Clones'),'clone');assert.equal(limitGroup('','Accessories'),null);
  const pkg={storageLocation:'Front',isSellable:true,inventoryQty:50,testResults:null};
  const menu=normalizeMenu({pricesIncludeTax:true,menuGroups:[{name:'Edibles and Pre-Rolls',products:[
    {id:'pr',name:'Pre-roll',category:'Pre-Rolls',categoryId:'c1',uom:'Each',unitWeight:1,unitWeightUOM:'Grams',variants:[{price:800}],packages:[pkg]},
    {id:'gum',name:'Gummies',category:'Gummies',categoryId:'c2',uom:'Each',netWeight:56.699,netWeightUOM:'Grams',unitWeight:100,unitWeightUOM:'Milligrams',variants:[{price:1800}],packages:[pkg]},
    {id:'bulk',name:'Bulk',category:'Flower',categoryId:'c3',uom:'Grams',variants:[{weight:3.5,uom:'g',price:2000}],packages:[pkg]},
    {id:'odd',name:'Mystery',category:'Other',categoryId:'c4',uom:'Each',variants:[{price:500}],packages:[pkg]}
  ]}]},'Front',Date.now(),new Map([['c4','Concentrate']]));
  const use=id=>{const p=menu.products.find(x=>x.id===id);return [p.limitGroup,p.variants[0].limitUse];};
  assert.deepEqual(use('pr'),['flower',1]);assert.deepEqual(use('gum'),['edible',2]);   // 56.699 g net = 2 oz
  assert.deepEqual(use('bulk'),['flower',3.5]);assert.deepEqual(use('odd'),['concentrate',null]); // unknown weight
});
test('orders over a store purchase limit are refused with a clear message; limits are off by default', async () => {
  const s=preorders(), a=await s.linked();
  const pkg={storageLocation:'Front',isSellable:true,inventoryQty:100,testResults:null};
  s.setGF({findMenus:{pricesIncludeTax:true,menuGroups:[{name:'Concentrates',products:[
    {id:'public-a',name:'Rosin',category:'Concentrates',uom:'Each',unitWeight:4,unitWeightUOM:'Grams',variants:[{price:2000}],packages:[pkg]}]}]}});
  const item=qty=>({items:[{productId:'public-a',size:'Each',priceCents:2000,qty}],license:LICENSE});
  assert.equal((await (await s.run('config')).json()).purchaseLimits,undefined);
  await s.run('menu');assert.equal(s.calls.filter(c=>String(c.init.body).includes('TreehouseCategoryTypes')).length,0);
  s.env.APP_PURCHASE_LIMITS_ENABLED='true';s.advance(60001);
  const {purchaseLimits}=await (await s.run('config')).json();
  assert.deepEqual([purchaseLimits.flower.max,purchaseLimits.concentrate.max,purchaseLimits.edible.max,purchaseLimits.edible.unit],[84,28,72,'oz']);
  const over=await a.place(item(8)); // 32 g > 28 g
  assert.equal(over.status,409);assert.match((await over.json()).error,/over the store’s 28 g concentrate limit/);
  assert.equal(s.mutations().length,0);
  assert.equal((await a.place(item(7))).status,200); // 28 g
  s.env.APP_PURCHASE_LIMITS='{"concentrate":20}';s.advance(30001);await a.status();
  assert.equal((await a.place(item(7))).status,409);
});

test('orders refused locally (delayed menu) do not use up the per-account attempt limit', async () => {
  const s=preorders(), a=await s.linked();
  s.advance(3600000-(s.deps.now()%3600000)+1000);
  assert.equal((await s.run('menu')).status,200);s.advance(60001);s.setGF({},429,{'retry-after':'1'});
  for (let i=0;i<7;i++) assert.equal((await a.place(flower(1))).status,503); // "menu is updating"
  s.setGF(null);s.advance(60001);
  assert.equal((await a.place(flower(1))).status,200);assert.equal(s.mutations().length,1);
});
test('a failed menu refresh logs why (e.g. a timeout)', async () => {
  const s=setup();assert.equal((await s.run('menu')).status,200);s.advance(60001);
  s.deps.fetch=async()=>{ const e=new Error('The operation timed out'); e.name='TimeoutError'; throw e; };
  const stale=await (await s.run('menu')).json();assert.equal(stale.stale,true);
  assert.ok(s.codes.includes('MENU_REFRESH_GROWFLOW_HTTP_TIMEOUT'),s.codes.join(' '));
});

test('Deals & news is off until enabled, needs a linked account and CSRF, and accepts only known topics', async () => {
  const s=await withPush();
  assert.equal((await (await s.run('config')).json()).marketingEnabled,false);
  const b=await s.linked(), news=(body,headers={'x-treehouse-csrf':b.csrf})=>s.run('marketing',{method:'POST',cookie:b.cookie,body,headers});
  assert.equal((await (await s.run('session',{cookie:b.cookie})).json()).marketing,undefined);
  assert.equal((await news({topics:['events'],source:'account'})).status,503);
  s.env.APP_MARKETING_ENABLED='true';
  assert.equal((await (await s.run('config')).json()).marketingEnabled,true);
  assert.deepEqual((await (await s.run('session',{cookie:b.cookie})).json()).marketing,{topics:[],ask:true});
  const a=await s.login('auth0|test-two'), csrfA=(await (await s.run('session',{cookie:a.cookie})).json()).csrf;
  assert.equal((await s.run('marketing',{method:'POST',cookie:a.cookie,body:{topics:['events'],source:'account'},headers:{'x-treehouse-csrf':csrfA}})).status,403);
  assert.equal((await news({topics:['events'],source:'account'},{})).status,403);
  for (const body of [{topics:['casino'],source:'account'},{topics:['events','events'],source:'account'},{topics:'events',source:'account'},
    {topics:['events'],source:'email'},{topics:['events'],source:'account',extra:1},{dismissed:true,topics:[]}])
    assert.equal((await news(body)).status,400,JSON.stringify(body));
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_marketing_prefs').get().n,0);
});

test('consent is recorded per topic with when and where it changed; turning it off is immediate', async () => {
  const s=await withPush(); s.env.APP_MARKETING_ENABLED='true';
  const b=await s.linked(), news=body=>s.run('marketing',{method:'POST',cookie:b.cookie,body,headers:{'x-treehouse-csrf':b.csrf}});
  const on=await (await news({topics:['events','new_arrivals'],source:'prompt'})).json();
  assert.deepEqual(on.marketing,{topics:['new_arrivals','events'],ask:false});
  await news({topics:['events','new_arrivals'],source:'account'}); // unchanged: not logged again
  const log=()=>s.env.APP_DB.db.prepare('SELECT topics, source FROM app_marketing_consent_log ORDER BY id').all().map(r=>({...r}));
  assert.deepEqual(log(),[{topics:'["new_arrivals","events"]',source:'prompt'}]);
  const first=s.env.APP_DB.db.prepare('SELECT opted_in_at FROM app_marketing_prefs').get().opted_in_at; assert.ok(first);
  s.advance(1000); await news({topics:['new_arrivals'],source:'account'});
  assert.equal(s.env.APP_DB.db.prepare('SELECT opted_in_at FROM app_marketing_prefs').get().opted_in_at,first);
  const off=await (await news({topics:[],source:'account'})).json();
  assert.deepEqual(off.marketing.topics,[]);
  assert.equal(s.env.APP_DB.db.prepare('SELECT opted_in_at FROM app_marketing_prefs').get().opted_in_at,null);
  assert.deepEqual(log().map(r=>r.topics),['["new_arrivals","events"]','["new_arrivals"]','[]']);
  // Unlinking removes the preferences and their history with the account.
  await s.run('remove-link',{method:'POST',cookie:b.cookie,body:{},headers:{'x-treehouse-csrf':b.csrf}});
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_marketing_prefs').get().n,0);
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_marketing_consent_log').get().n,0);
});

test('"Not now" stops the opt-in prompt for 90 days without recording consent', async () => {
  const s=await withPush(); s.env.APP_MARKETING_ENABLED='true';
  const b=await s.linked(), state=async()=>{ const c=(await s.login()).cookie; return (await (await s.run('session',{cookie:c})).json()).marketing; };
  const res=await s.run('marketing',{method:'POST',cookie:b.cookie,body:{dismissed:true},headers:{'x-treehouse-csrf':b.csrf}});
  assert.deepEqual((await res.json()).marketing,{topics:[],ask:false});
  assert.equal(s.env.APP_DB.db.prepare('SELECT count(*) n FROM app_marketing_consent_log').get().n,0);
  s.advance(89*86400000); assert.equal((await state()).ask,false);
  s.advance(2*86400000); assert.equal((await state()).ask,true);
});

test('a tapped Deals & news notification is counted without signing in, only with a valid code', async () => {
  const s=setup(), updates=[];
  s.env.CRM_DB={prepare:sql=>({bind:(...v)=>({run:async()=>{updates.push(v);return {success:true,results:[]};}})})};
  const id='a'.repeat(64), token=await tapToken(s.env,id,'CustomerOne');
  const tap=t=>s.run('tap',{method:'POST',body:{t}});
  assert.equal((await tap(token)).status,200); assert.deepEqual(updates[0].slice(1),[id,'CustomerOne']);
  assert.equal((await tap(token.replace(/.$/,c=>c==='0'?'1':'0'))).status,400);
  assert.equal((await s.run('tap',{method:'POST',body:{t:token},headers:{'sec-fetch-site':'cross-site'}})).status,403);
});

test('a linked customer sees their own welcome-gift code in the app', async () => {
  const s=await withPush(); s.env.APP_MARKETING_ENABLED='true';
  const asked=[];
  s.env.CRM_DB={prepare:sql=>({bind:(...v)=>({first:async()=>{asked.push([sql,v]);
    return /crm_welcome_gifts/.test(sql)?(v[0]==='CustomerOne'?{code:'TH-ABCD'}:null)
      :{value:JSON.stringify({on:true,description:'a sample gift',message:'{code}',endsOn:null})};}})})};
  const b=await s.linked();
  assert.deepEqual((await (await s.run('session',{cookie:b.cookie})).json()).welcomeGift,{code:'TH-ABCD',description:'a sample gift',endsOn:null});
  assert.ok(asked.some(([sql,v])=>/crm_welcome_gifts/.test(sql)&&v[0]==='CustomerOne'));
});

test('customers remove only their own welcome code, signed in and with CSRF', async () => {
  const s=await withPush(), updates=[];
  s.env.CRM_DB={prepare:sql=>({bind:(...v)=>({run:async()=>{updates.push([sql,v]);return {success:true,results:[]};},first:async()=>null})})};
  const b=await s.linked(), dismiss=(headers={'x-treehouse-csrf':b.csrf})=>s.run('welcome/dismiss',{method:'POST',cookie:b.cookie,body:{},headers});
  assert.equal((await dismiss({})).status,403);
  assert.equal((await dismiss()).status,200);
  assert.equal(updates.length,1); assert.equal(updates[0][1][1],'CustomerOne');
  const a=await s.login('auth0|someone-else'), csrfA=(await (await s.run('session',{cookie:a.cookie})).json()).csrf;
  assert.equal((await s.run('welcome/dismiss',{method:'POST',cookie:a.cookie,body:{},headers:{'x-treehouse-csrf':csrfA}})).status,403);
});

test('visit ratings stay off until enabled and need a linked account', async () => {
  const s=await withPush(), b=await s.linked();
  const rate=()=>s.run('feedback/rate',{method:'POST',cookie:b.cookie,body:{orderId:'x',rating:5},headers:{'x-treehouse-csrf':b.csrf}});
  assert.equal((await rate()).status,503);
  assert.equal((await (await s.run('session',{cookie:b.cookie})).json()).feedback,undefined);
  const a=await s.login('auth0|not-linked'), csrfA=(await (await s.run('session',{cookie:a.cookie})).json()).csrf;
  s.env.FEEDBACK_ENABLED='true'; s.env.CRM_DB={prepare:()=>({bind:()=>({first:async()=>null,run:async()=>({results:[]})})}),batch:async()=>[]};
  assert.equal((await s.run('feedback/rate',{method:'POST',cookie:a.cookie,body:{orderId:'x',rating:5},headers:{'x-treehouse-csrf':csrfA}})).status,403);
  assert.deepEqual((await (await s.run('session',{cookie:b.cookie})).json()).feedback,{visit:null,ask:false});
  assert.equal((await rate()).status,409); // no recent visit to rate
});
