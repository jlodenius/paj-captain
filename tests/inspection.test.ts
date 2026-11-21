import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CAPTAIN_INSPECTION_EVENT,
  setCaptainInspection,
} from "../src/inspection.ts";

const id = "captain-session";
interface Request {
  piSessionId: string;
  enabled: boolean;
  reply(result: unknown): void;
}
function receiver(
  handle: (request: Request) => void,
): Pick<ExtensionAPI["events"], "emit"> {
  return {
    emit(name, data) {
      assert.equal(name, CAPTAIN_INSPECTION_EVENT);
      assert.ok(data && typeof data === "object");
      const request = data as Request;
      assert.equal(request.piSessionId, id);
      handle(request);
    },
  };
}

test("inspection handshake requires a synchronous compatible receiver", async () => {
  for (const events of [
    undefined,
    { emit() {} },
    receiver((request) => {
      queueMicrotask(() => request.reply(Promise.resolve()));
    }),
    receiver((request) => {
      request.reply(undefined);
    }),
  ]) {
    await assert.rejects(
      setCaptainInspection(events, id, true),
      /compatible live Paj receiver/,
    );
  }
});

test("inspection handshake awaits activation and revocation acknowledgements", async () => {
  for (const enabled of [true, false]) {
    let finish!: () => void;
    let settled = false;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handshake = setCaptainInspection(
      receiver((request) => {
        assert.equal(request.enabled, enabled);
        request.reply(pending);
      }),
      id,
      enabled,
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    finish();
    await handshake;
    assert.equal(settled, true);
  }
});

test("inspection handshake propagates registry rejection", async () => {
  await assert.rejects(
    setCaptainInspection(
      receiver((request) => {
        request.reply(Promise.reject(new Error("Registry rejected session")));
      }),
      id,
      true,
    ),
    /Registry rejected session/,
  );
});
