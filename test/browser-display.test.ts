import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { BrowserTransport, planDisplay, type DisplayDeps } from "../src/browser-transport.js";

const headed = { headless: false, autoXvfb: true };

test("macOS and Windows use their own display, never Xvfb", () => {
  for (const platform of ["darwin", "win32"] as const) {
    assert.deepEqual(planDisplay({ ...headed, platform, env: {} }), { kind: "none" });
  }
});

test("Linux without DISPLAY starts Xvfb; DISPLAY, headless or FOODPANDA_XVFB=0 skip it", () => {
  assert.deepEqual(planDisplay({ ...headed, platform: "linux", env: {} }), { kind: "xvfb" });
  assert.deepEqual(planDisplay({ ...headed, platform: "linux", env: { DISPLAY: ":0" } }), {
    kind: "existing",
    display: ":0",
  });
  assert.deepEqual(planDisplay({ headless: true, autoXvfb: true, platform: "linux", env: {} }), { kind: "none" });
  assert.deepEqual(planDisplay({ headless: false, autoXvfb: false, platform: "linux", env: {} }), { kind: "none" });
});

/** A fake child process: emits what a real spawn would, after spawn() returns. */
function fakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  (child as any).kill = () => true;
  return child;
}

function ensureDisplay(t: BrowserTransport): Promise<string | undefined> {
  return (t as any).ensureDisplay();
}

test("a missing Xvfb (spawn ENOENT) is an error from the call, not a crash", async () => {
  let spawned = 0;
  const deps: DisplayDeps = {
    platform: "linux",
    env: {},
    config: () => headed,
    socketExists: () => false,
    pollMs: 1,
    spawn: () => {
      spawned++;
      const child = fakeChild();
      // Node reports ENOENT asynchronously as an 'error' event: unhandled, it kills the process.
      setImmediate(() => child.emit("error", Object.assign(new Error("spawn Xvfb ENOENT"), { code: "ENOENT" })));
      return child;
    },
  };
  await assert.rejects(ensureDisplay(new BrowserTransport(deps)), /Could not start Xvfb \(Xvfb is not installed\)/);
  assert.equal(spawned, 1);
});

test("on macOS a headed browser does not spawn anything", async () => {
  const t = new BrowserTransport({
    platform: "darwin",
    env: {},
    config: () => headed,
    spawn: () => assert.fail("must not spawn Xvfb on macOS"),
  });
  assert.equal(await ensureDisplay(t), undefined);
});

test("on Linux the Xvfb display is used once its socket appears", async () => {
  let up = false;
  const child = fakeChild();
  const t = new BrowserTransport({
    platform: "linux",
    env: {},
    config: () => headed,
    pollMs: 1,
    socketExists: (p) => p === "/tmp/.X11-unix/X99" && up,
    spawn: (cmd, args) => {
      assert.equal(cmd, "Xvfb");
      assert.equal(args[0], ":99");
      setImmediate(() => (up = true));
      return child;
    },
  });
  assert.equal(await ensureDisplay(t), ":99");
  // A later error from the running Xvfb is handled too.
  assert.ok(child.listenerCount("error") > 0);
});
