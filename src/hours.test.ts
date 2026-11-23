// Run: node src/hours.test.ts
import assert from "node:assert/strict";
import { hoursStatus, parseHours } from "./hours.ts";

const google = parseHours("Monday: 8 AM–5 PM; Tuesday: 8 AM–5 PM; Wednesday: 8 AM–12 PM, 1–5 PM; Thursday: 8 AM–5 PM; Friday: 8 AM–5 PM; Saturday: 9 AM–1 PM; Sunday: Closed")!;
assert.deepEqual(google.get(1), [[480, 1020]]);
assert.deepEqual(google.get(3), [[480, 720], [780, 1020]]);
assert.deepEqual(google.get(0), []);
assert.equal(hoursStatus(google, 1, 600).text, "Open now · closes 5 PM");
assert.equal(hoursStatus(google, 1, 420).text, "Closed · opens 8 AM");
assert.equal(hoursStatus(google, 3, 740).text, "Closed · opens 1 PM");
assert.equal(hoursStatus(google, 6, 840).text, "Closed · opens Mon 8 AM");
assert.equal(hoursStatus(google, 0, 600).text, "Closed · opens tomorrow 8 AM");

const short = parseHours("Mon-Fri 8am-5pm, Sat 9-1")!;
assert.deepEqual(short.get(5), [[480, 1020]]);
assert.deepEqual(short.get(6), [[540, 780]]);
assert.equal(short.has(0), false);

assert.equal(hoursStatus(parseHours("Open 24 hours")!, 2, 200).text, "Open 24 hours");
assert.deepEqual(parseHours('{"Monday": "8AM-5PM", "Sunday": "Closed"}')!.get(1), [[480, 1020]]);
assert.deepEqual(parseHours('[{"day":"Friday","hours":"10 AM to 2 AM"}]')!.get(5), [[600, 120]]);
assert.equal(hoursStatus(parseHours('[{"day":"Friday","hours":"10 AM to 2 AM"}]')!, 6, 60).text, "Open now · closes 2 AM");
assert.equal(parseHours("call anytime"), null);
console.log("hours: all checks pass");
