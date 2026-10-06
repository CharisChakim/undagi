// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import test from "node:test";

import { isLoopbackHostname, refusalOf } from "./localOnly.ts";

test("a page served from this machine reaches the API", () => {
  assert.equal(refusalOf("localhost:3000", "http://localhost:3000", true), null);
  assert.equal(refusalOf("127.0.0.1:41234", "http://127.0.0.1:41234", true), null);
  assert.equal(refusalOf("[::1]:3000", "http://[::1]:3000", true), null);
  // Same-origin GETs, EventSource and non-browser clients send no Origin.
  assert.equal(refusalOf("localhost:3000", undefined, true), null);
});

test("a rebinding hostname is refused even with a matching Origin", () => {
  assert.notEqual(refusalOf("evil.example:3000", "http://evil.example:3000", true), null);
  assert.notEqual(refusalOf("evil.example:3000", undefined, true), null);
  assert.notEqual(refusalOf("localhost.evil.example:3000", undefined, true), null);
});

test("a request from another site is refused", () => {
  assert.notEqual(refusalOf("localhost:3000", "https://evil.example", true), null);
  assert.notEqual(refusalOf("localhost:3000", "http://localhost:5173", true), null);
  assert.notEqual(refusalOf("localhost:3000", "null", true), null);
  assert.notEqual(refusalOf(undefined, undefined, true), null);
});

test("a server opened to the network accepts any Host but still checks Origin", () => {
  assert.equal(refusalOf("192.168.1.83:3000", "http://192.168.1.83:3000", false), null);
  assert.notEqual(refusalOf("192.168.1.83:3000", "https://evil.example", false), null);
});

test("only loopback names count as this machine", () => {
  for (const name of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
    assert.equal(isLoopbackHostname(name), true, name);
  }
  for (const name of ["0.0.0.0", "::", "192.168.1.83", "localhost.evil.example", "evil.example"]) {
    assert.equal(isLoopbackHostname(name), false, name);
  }
});
