// Content-type routing in socialPublishers.js (post | story | reel).
//
// The composer + LUMEN-API validation gate story/reel to Facebook/Instagram
// upstream; these tests pin the publisher-side behavior — Meta modules take
// the story/reel code paths with the right Graph API shapes, everything else
// settles as a graceful per-target failure (never a throw, never a stall).
//
// global.fetch is mocked per-test; no network.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { publishers } from "../src/shared/socialPublishers.js";

const realFetch = global.fetch;
let calls = [];

function mockFetch(responders) {
  // responders: array consumed in order; each is { status?, json } or a fn(url, opts)
  let i = 0;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const r = responders[Math.min(i++, responders.length - 1)];
    const spec = typeof r === "function" ? r(String(url), opts) : r;
    return {
      ok: (spec.status || 200) < 400,
      status: spec.status || 200,
      text: async () => JSON.stringify(spec.json ?? {}),
      json: async () => spec.json ?? {},
      headers: { get: () => null },
    };
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { global.fetch = realFetch; });

// ── Facebook ────────────────────────────────────────────────────────────────

test("FB reel settles as unsupported_content_type without any API call", async () => {
  mockFetch([{ json: {} }]);
  const r = await publishers.facebook({
    pageId: "p1", accessToken: "tok", message: "hi", imageUrls: ["http://x/i.png"], contentType: "reel",
  });
  assert.equal(r.ok, false);
  assert.equal(r.error_class, "unsupported_content_type");
  assert.equal(calls.length, 0);
});

test("FB story with no image fails content_policy without any API call", async () => {
  mockFetch([{ json: {} }]);
  const r = await publishers.facebook({ pageId: "p1", accessToken: "tok", message: "hi", contentType: "story" });
  assert.equal(r.ok, false);
  assert.equal(r.error_class, "content_policy");
  assert.equal(calls.length, 0);
});

test("FB story publishes via unpublished photo + photo_stories", async () => {
  mockFetch([
    { json: { id: "photo123" } },              // /photos (published=false)
    { json: { success: true, post_id: "story456" } }, // /photo_stories
  ]);
  const r = await publishers.facebook({
    pageId: "p1", accessToken: "tok", message: "hi", imageUrls: ["http://x/i.png"], contentType: "story",
  });
  assert.equal(r.ok, true);
  assert.equal(r.external_post_id, "story456");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/p1\/photos$/);
  assert.match(String(calls[0].opts.body), /published=false/);
  assert.match(calls[1].url, /\/p1\/photo_stories$/);
  assert.match(String(calls[1].opts.body), /photo_id=photo123/);
});

test("FB plain post still uses the feed/photos flow (regression)", async () => {
  mockFetch([{ json: { id: "post789" } }]);
  const r = await publishers.facebook({
    pageId: "p1", accessToken: "tok", message: "hi", imageUrls: ["http://x/i.png"], contentType: "post",
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/p1\/photos$/);
  assert.match(String(calls[0].opts.body), /published=true/);
});

// ── Instagram ───────────────────────────────────────────────────────────────

test("IG reel without a video fails content_policy without any API call", async () => {
  mockFetch([{ json: {} }]);
  const r = await publishers.instagram({
    igUserId: "ig1", accessToken: "tok", message: "hi", imageUrls: ["http://x/i.png"], contentType: "reel",
  });
  assert.equal(r.ok, false);
  assert.equal(r.error_class, "content_policy");
  assert.equal(calls.length, 0);
});

test("IG reel: REELS container + status poll + publish", async () => {
  mockFetch([
    { json: { id: "c1" } },                    // container
    { json: { status_code: "FINISHED" } },     // status poll
    { json: { id: "media99" } },               // media_publish
  ]);
  const r = await publishers.instagram({
    igUserId: "ig1", accessToken: "tok", message: "my reel",
    videoUrls: ["http://x/v.mp4"], contentType: "reel",
  });
  assert.equal(r.ok, true);
  assert.equal(r.external_post_id, "media99");
  assert.equal(calls.length, 3);
  assert.match(String(calls[0].opts.body), /media_type=REELS/);
  assert.match(String(calls[0].opts.body), /video_url=/);
  assert.match(calls[1].url, /\/c1\?fields=status_code/);
  assert.match(String(calls[2].opts.body), /creation_id=c1/);
});

test("IG story uses STORIES container with image and no caption", async () => {
  mockFetch([
    { json: { id: "c2" } },
    { json: { id: "media55" } },
  ]);
  const r = await publishers.instagram({
    igUserId: "ig1", accessToken: "tok", message: "ignored on stories",
    imageUrls: ["http://x/i.png"], contentType: "story",
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2); // image container needs no status poll
  const body = String(calls[0].opts.body);
  assert.match(body, /media_type=STORIES/);
  assert.match(body, /image_url=/);
  assert.doesNotMatch(body, /caption=/);
});

test("IG reel container stuck in ERROR settles as failure, no publish call", async () => {
  mockFetch([
    { json: { id: "c3" } },
    { json: { status_code: "ERROR" } },
  ]);
  const r = await publishers.instagram({
    igUserId: "ig1", accessToken: "tok", message: "x",
    videoUrls: ["http://x/v.mp4"], contentType: "reel",
  });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[calls.length - 1].url, /media_publish/);
});

test("IG plain post keeps caption + image_url (regression)", async () => {
  mockFetch([
    { json: { id: "c4" } },
    { json: { id: "media77" } },
  ]);
  const r = await publishers.instagram({
    igUserId: "ig1", accessToken: "tok", message: "hello world",
    imageUrls: ["http://x/i.png"], contentType: "post",
  });
  assert.equal(r.ok, true);
  const body = String(calls[0].opts.body);
  assert.match(body, /caption=hello\+world/);
  assert.match(body, /image_url=/);
  assert.doesNotMatch(body, /media_type=/);
});

// ── X / LinkedIn defense in depth ───────────────────────────────────────────

test("X and LinkedIn reject story/reel without any API call", async () => {
  mockFetch([{ json: {} }]);
  for (const [name, args] of [
    ["x", { accessToken: "tok", message: "m", contentType: "story" }],
    ["x", { accessToken: "tok", message: "m", contentType: "reel" }],
    ["linkedin", { accessToken: "tok", authorUrn: "urn:li:organization:1", message: "m", contentType: "story" }],
    ["linkedin", { accessToken: "tok", authorUrn: "urn:li:organization:1", message: "m", contentType: "reel" }],
  ]) {
    const r = await publishers[name](args);
    assert.equal(r.ok, false, `${name} ${args.contentType}`);
    assert.equal(r.error_class, "unsupported_content_type");
  }
  assert.equal(calls.length, 0);
});
