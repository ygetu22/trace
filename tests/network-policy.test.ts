import assert from "node:assert/strict";
import test from "node:test";
import { isPublicAddress, parseTarget, resolvePublicHost } from "../src/network-policy.ts";

test("URLs must be HTTP(S), with standard ports and no credentials", () => {
  assert.equal(parseTarget(" https://example.com:443/about?view=1 ").href, "https://example.com/about?view=1");
  for (const input of [undefined, "not a url", "file:///etc/passwd", "ftp://example.com", "https://user:pass@example.com", "http://example.com:3120", "https://example.com/" + "a".repeat(2048)]) {
    assert.throws(() => parseTarget(input));
  }
});

test("private, loopback, link-local, reserved, and mapped private addresses are rejected", () => {
  const blockedAddresses = [
    "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.2.1", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "192.0.2.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "2001:db8::1", "::ffff:127.0.0.1",
    "::ffff:10.1.2.3", "::127.0.0.1", "2606:4700:4700::1111%lo0", "invalid",
  ];
  for (const address of blockedAddresses) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("numeric URL variants normalize to blocked loopback addresses", async () => {
  for (const input of ["http://2130706433", "http://0x7f000001", "http://127.1", "http://[::1]", "http://[::ffff:127.0.0.1]"]) {
    await assert.rejects(resolvePublicHost(parseTarget(input).hostname), /public internet/);
  }
});

test("DNS must return only public addresses and supplies a pinned address", async () => {
  await assert.rejects(resolvePublicHost("mixed.example", async () => [
    { address: "1.1.1.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]), /public internet/);
  await assert.rejects(resolvePublicHost("empty.example", async () => []), /public internet/);
  assert.equal(await resolvePublicHost("public.example", async () => [
    { address: "1.1.1.1", family: 4 },
    { address: "8.8.8.8", family: 4 },
  ]), "1.1.1.1");
});
