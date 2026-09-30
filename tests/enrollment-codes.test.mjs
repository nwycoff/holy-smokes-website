import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { enrollmentCode, normalizeEnrollmentCode, withEnrollmentCode } from '../server/customer-app/enrollment.mjs';
import { hash } from '../server/customer-app/http.mjs';

const sequence = (...samples) => values => {
  assert.ok(samples.length, 'random sample consumed only as expected');
  values[0] = samples.shift(); return values;
};
test('numeric codes preserve zeroes and discard biased uint32 tail', () => {
  assert.equal(enrollmentCode(sequence(0)), '00000000');
  assert.equal(enrollmentCode(sequence(1234567)), '01234567');
  assert.equal(enrollmentCode(sequence(4199999999)), '99999999');
  assert.equal(enrollmentCode(sequence(4200000000, 4294967295, 12345678)), '12345678');
  assert.throws(() => enrollmentCode(v => { v[0] = 4294967295; }), { code: 'ENROLLMENT_BUSY' });
});
test('accepts eight digits with optional separator and still-valid legacy formats only', () => {
  for (const value of ['01234567', '0123 4567', '0123-4567', ' 0123 4567 '])
    assert.equal(normalizeEnrollmentCode(value), '01234567');
  for (const value of [12345678, null, '', '1234567', '123456789', 'abcd efgh', '0123  4567', '0123\n4567', '１２３４５６７８'])
    assert.equal(normalizeEnrollmentCode(value), null);
  assert.equal(normalizeEnrollmentCode('abcd-1234-ef56-7890-abcd'), 'ABCD1234EF567890ABCD');
});
test('collisions cannot overwrite another customer, including races after the precheck', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE app_enrollments(code_hash TEXT PRIMARY KEY, customer_id TEXT UNIQUE, expires_at INTEGER)');
  const env = { APP_LIMIT_SECRET: 'synthetic-secret-longer-than-thirty-two-characters', APP_DB: {
    prepare(sql) { return { bind(...v) { return { async first() { return db.prepare(sql).get(...v); } }; } }; }
  } };
  const firstHash = await hash(env.APP_LIMIT_SECRET, 'enroll:00000001');
  db.prepare('INSERT INTO app_enrollments VALUES (?,?,?)').run(firstHash, 'existing', 99999);
  let calls = 0;
  const issued = await withEnrollmentCode(env, async codeHash => {
    if (++calls === 1) db.prepare('INSERT INTO app_enrollments VALUES (?,?,?)').run(codeHash, 'concurrent', 99999);
    db.prepare(`INSERT INTO app_enrollments VALUES (?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET code_hash=excluded.code_hash`).run(codeHash, 'new', 99999);
    return 'created';
  }, sequence(1, 2, 3));
  assert.equal(issued.code, '0000 0003'); assert.equal(issued.result, 'created');
  assert.equal(calls, 2); assert.equal(db.prepare('SELECT count(*) n FROM app_enrollments').get().n, 3);
  assert.equal(db.prepare('SELECT customer_id FROM app_enrollments WHERE code_hash=?').get(firstHash).customer_id, 'existing');
  await assert.rejects(withEnrollmentCode(env, () => assert.fail('must not overwrite'), sequence(1, 1, 1, 1, 1)), { code: 'ENROLLMENT_BUSY' });
  let failedCalls = 0;
  await assert.rejects(withEnrollmentCode(env, async () => { failedCalls++; throw new Error('audit unavailable'); }, sequence(4)), /audit unavailable/);
  assert.equal(failedCalls, 1); db.close();
});
