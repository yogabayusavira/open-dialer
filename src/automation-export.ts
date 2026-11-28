export type AutomationTrigger = "lead" | "outcome" | "voicemail" | "transcribed";
export type ConditionOp = "is" | "is not" | "contains" | "is empty" | "is not empty";
export type AutomationStep =
  | { type: "if"; field: string; op: ConditionOp; value: string }
  | { type: "say"; text: string }
  | { type: "ask"; prompt: string; field: string }
  | { type: "wait"; amount: number; unit: "minutes" | "hours" | "days" }
  | { type: "email"; to: string; subject: string; body: string }
  | { type: "sms"; text: string }
  | { type: "play"; recordingId: string }
  | { type: "stage"; stage: string }
  | { type: "followup"; days: number };
export type FlowNode = { id: string; step: AutomationStep | null; x: number; y: number };
export type FlowEdge = { from: string; port: "out" | "yes" | "no"; to: string };
export type Automation = { id: string; name: string; on: boolean; trigger: AutomationTrigger; campaigns?: string[]; outcomes?: string[]; nodes?: FlowNode[]; edges?: FlowEdge[]; steps?: AutomationStep[] };

export function flowGraph(item: Automation): { nodes: FlowNode[]; edges: FlowEdge[] } {
  if (item.nodes?.length) return { nodes: item.nodes, edges: item.edges || [] };
  const steps = item.steps || [];
  return {
    nodes: [{ id: "trigger", step: null, x: 0, y: 0 }, ...steps.map((step, index) => ({ id: `s${index}`, step, x: (index + 1) * 300, y: 0 }))],
    edges: steps.map((_, index) => ({ from: index ? `s${index - 1}` : "trigger", port: (index && steps[index - 1]?.type === "if" ? "yes" : "out") as FlowEdge["port"], to: `s${index}` })),
  };
}

export function exampleAutomations(): Automation[] {
  const makeId = () => `au_${globalThis.crypto?.randomUUID?.().replaceAll("-", "") || `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`}`;
  return [
    { id: makeId(), name: "Example · Friendly opening reminder", on: false, trigger: "lead", campaigns: [], nodes: [{ id: "trigger", step: null, x: 0, y: 0 }, { id: "reminder", step: { type: "say", text: "Example: Check the lead's local time and personalize your opening." }, x: 300, y: 0 }], edges: [{ from: "trigger", port: "out", to: "reminder" }] },
    { id: makeId(), name: "Example · Follow up after no answer", on: false, trigger: "outcome", campaigns: [], outcomes: ["No answer"], nodes: [{ id: "trigger", step: null, x: 0, y: 0 }, { id: "followup", step: { type: "followup", days: 2 }, x: 300, y: 0 }], edges: [{ from: "trigger", port: "out", to: "followup" }] },
  ];
}

export function openDialerExport(item: Automation) {
  return { format: "open-dialer-automation", version: 1, automation: item };
}

// n8n can import this diagram, but Open Dialer triggers and actions must be replaced and configured there.
export function n8nTemplate(item: Automation) {
  const graph = flowGraph(item);
  const names = new Map(graph.nodes.map((node, index) => [node.id, node.id === "trigger" ? "SET UP: Open Dialer trigger" : `SET UP: ${node.step?.type || "step"} ${index}`]));
  const nodes = graph.nodes.map((node, index) => {
    const trigger = node.id === "trigger";
    const condition = node.step?.type === "if";
    const details = trigger ? { trigger: item.trigger, campaigns: item.campaigns || [], outcomes: item.outcomes || [] } : node.step;
    return {
      id: `open-dialer-${index}`, name: names.get(node.id)!, position: [node.x, node.y],
      type: trigger ? "n8n-nodes-base.manualTrigger" : condition ? "n8n-nodes-base.if" : "n8n-nodes-base.noOp",
      typeVersion: 1,
      parameters: condition ? { conditions: { string: [{ value1: "", operation: "equal", value2: "" }] } } : {},
      notesInFlow: true,
      notes: `TEMPLATE ONLY: Replace and configure this node before use. Open Dialer settings:\n${JSON.stringify(details, null, 2)}`,
    };
  });
  const connections: Record<string, { main: { node: string; type: "main"; index: number }[][] }> = {};
  for (const edge of graph.edges) {
    const source = names.get(edge.from), target = names.get(edge.to);
    if (!source || !target) continue;
    const output = edge.port === "no" ? 1 : 0;
    const main = (connections[source] ||= { main: [] }).main;
    while (main.length <= output) main.push([]);
    main[output].push({ node: target, type: "main", index: 0 });
  }
  return { name: `${item.name} (Open Dialer template)`, nodes, connections, active: false, settings: { executionOrder: "v1" } };
}
