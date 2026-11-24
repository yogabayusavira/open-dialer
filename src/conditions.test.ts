// Run: node src/conditions.test.ts
import assert from "node:assert/strict";
import { checkCondition, isOtherwise, parseCondition } from "./conditions.ts";

const noSite = parseCondition("If {{lead_type}} is no website:")!;
assert.deepEqual(noSite, { variable: "lead_type", op: "is", values: ["no website"] });
assert.equal(checkCondition(noSite, "No Website"), true);
assert.equal(checkCondition(noSite, "free site builder"), false);

const builder = parseCondition('if {{lead_type}} is "free site builder" or social only')!;
assert.deepEqual(builder.values, ["free site builder", "social only"]);
assert.equal(checkCondition(builder, "social only"), true);

const wix = parseCondition("If {{website}} contains wix, godaddy, sites.google:")!;
assert.equal(checkCondition(wix, "https://joesroofing.wixsite.com"), true);
assert.equal(checkCondition(wix, "https://joesroofing.com"), false);

assert.equal(checkCondition(parseCondition("If {{website}} is empty:")!, " "), true);
assert.equal(checkCondition(parseCondition("If {{website}} is not empty:")!, "x"), true);
assert.equal(checkCondition(parseCondition("If {{reviews}} is above 100:")!, "777"), true);
assert.equal(checkCondition(parseCondition("If {{reviews}} > 100")!, "40"), false);
assert.equal(checkCondition(parseCondition("If {{rating}} is at least 4.5:")!, "4.9"), true);
assert.equal(checkCondition(parseCondition("If {{rating}} is below 4:")!, ""), false);
assert.equal(checkCondition(parseCondition("If {{lead_type}} is not no website:")!, "social only"), true);

// Ordinary script lines stay ordinary.
assert.equal(parseCondition("If they push back:"), null);
assert.equal(parseCondition("If you get voicemail, leave a short message."), null);
assert.equal(isOtherwise("Otherwise:"), true);
assert.equal(isOtherwise("Otherwise, ask for the owner."), false);
console.log("conditions: all checks pass");
