import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { exampleAutomations, flowGraph, n8nTemplate, openDialerExport } from "../src/automation-export.ts";

const examples = exampleAutomations();
assert.equal(examples.length, 2);
assert(examples.every((item) => !item.on && item.nodes.length > 1));
const sample = { id: "au_test", name: "Branch test", on: true, trigger: "outcome", campaigns: ["Demo"], outcomes: ["No answer"], steps: [{ type: "if", field: "name", op: "is", value: "Example" }, { type: "followup", days: 2 }] };
assert.deepEqual(openDialerExport(sample).automation, sample);
assert.deepEqual(flowGraph(sample).edges.map((edge) => edge.port), ["out", "yes"]);
const template = n8nTemplate({ ...sample, nodes: [
  { id: "trigger", step: null, x: 0, y: 0 },
  { id: "if", step: sample.steps[0], x: 300, y: 0 },
  { id: "yes", step: sample.steps[1], x: 600, y: -80 },
  { id: "no", step: { type: "stage", stage: "Lost" }, x: 600, y: 80 },
], edges: [{ from: "trigger", port: "out", to: "if" }, { from: "if", port: "yes", to: "yes" }, { from: "if", port: "no", to: "no" }] });
assert.equal(template.active, false);
assert.equal(template.nodes.find((node) => node.name === "SET UP: if 1").type, "n8n-nodes-base.if");
assert.equal(template.connections["SET UP: if 1"].main[0][0].node, "SET UP: followup 2");
assert.equal(template.connections["SET UP: if 1"].main[1][0].node, "SET UP: stage 3");
assert(template.nodes.every((node) => node.notes.includes("TEMPLATE ONLY")));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(template, null, 2));
console.log("Automation examples and export formats passed.");
