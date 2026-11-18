import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTAIN_INSPECTION_EVENT, setCaptainInspection } from '../src/inspection.ts';

const id = 'captain-session';

test('inspection handshake requires a synchronous compatible receiver', async () => {
  for (const events of [undefined, { emit() {} }, {
    emit(_name, request) { queueMicrotask(() => request.reply(Promise.resolve())); },
  }, { emit(_name, request) { request.reply(undefined); } }]) {
    await assert.rejects(setCaptainInspection(events, id, true), /compatible live Paj receiver/);
  }
});

test('inspection handshake awaits activation and revocation acknowledgements', async () => {
  for (const enabled of [true, false]) {
    let finish;
    let settled = false;
    const pending = new Promise(resolve => { finish = resolve; });
    const handshake = setCaptainInspection({ emit(name, request) {
      assert.equal(name, CAPTAIN_INSPECTION_EVENT);
      assert.equal(request.piSessionId, id);
      assert.equal(request.enabled, enabled);
      request.reply(pending);
    } }, id, enabled).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    finish();
    await handshake;
    assert.equal(settled, true);
  }
});

test('inspection handshake propagates registry rejection', async () => {
  await assert.rejects(setCaptainInspection({ emit(_name, request) {
    request.reply(Promise.reject(new Error('Registry rejected session')));
  } }, id, true), /Registry rejected session/);
});
