// "Only if" lines in a call script: `If {{lead_type}} is no website:` with the lines to say indented under it.
// The rule needs a {{variable}}, so ordinary lines like "If they push back:" stay plain labels.
// Rules (any case, quotes optional, several values with commas or "or"):
//   is X / is X, Y or Z / is not X / is empty / is not empty
//   contains X, Y / does not contain X / starts with X
//   is above N / is more than N / > N / is at least N / >= N / is below N / is less than N / < N / is at most N / <= N
export type Condition = { variable: string; op: "is" | "not" | "empty" | "filled" | "contains" | "excludes" | "starts" | ">" | ">=" | "<" | "<="; values: string[] };

const listOf = (text: string) => text.split(/\s*,\s*|\s+or\s+/i).map((value) => value.trim().replace(/^["'“”]+|["'“”]+$/g, "").toLowerCase()).filter(Boolean);

export function parseCondition(line: string): Condition | null {
  const match = line.trim().match(/^(?:only\s+)?if\s+\{\{\s*([^{}]+?)\s*\}\}\s+(.+?):?\s*$/i);
  if (!match) return null;
  const variable = match[1];
  const rule = match[2].trim();
  const pick = (pattern: RegExp, op: Condition["op"]) => { const found = rule.match(pattern); return found ? { variable, op, values: listOf(found[1] || "") } : null; };
  if (/^is\s+(empty|blank|missing)$/i.test(rule) || /^has\s+no\s+value$/i.test(rule)) return { variable, op: "empty", values: [] };
  if (/^is\s+not\s+(empty|blank|missing)$/i.test(rule) || /^has\s+a\s+value$/i.test(rule)) return { variable, op: "filled", values: [] };
  return pick(/^(?:is\s+above|is\s+more\s+than|is\s+over|>)\s*(.+)$/i, ">")
    || pick(/^(?:is\s+at\s+least|>=)\s*(.+)$/i, ">=")
    || pick(/^(?:is\s+below|is\s+less\s+than|is\s+under|<)\s*(.+)$/i, "<")
    || pick(/^(?:is\s+at\s+most|<=)\s*(.+)$/i, "<=")
    || pick(/^(?:does\s+not\s+contain|doesn't\s+contain)\s+(.+)$/i, "excludes")
    || pick(/^contains?\s+(.+)$/i, "contains")
    || pick(/^starts\s+with\s+(.+)$/i, "starts")
    || pick(/^is\s+not\s+(.+)$/i, "not")
    || pick(/^(?:is|=|equals)\s+(.+)$/i, "is");
}

export const isOtherwise = (line: string) => /^(otherwise|else)\s*:?\s*$/i.test(line.trim());

export function checkCondition(condition: Condition, raw: string) {
  const value = raw.trim().toLowerCase();
  const number = Number(value.replace(/[^\d.-]/g, ""));
  const limit = Number(condition.values[0]);
  switch (condition.op) {
    case "empty": return !value;
    case "filled": return Boolean(value);
    case "is": return condition.values.includes(value);
    case "not": return !condition.values.includes(value);
    case "contains": return condition.values.some((part) => value.includes(part));
    case "excludes": return !condition.values.some((part) => value.includes(part));
    case "starts": return condition.values.some((part) => value.startsWith(part));
    case ">": return value !== "" && number > limit;
    case ">=": return value !== "" && number >= limit;
    case "<": return value !== "" && number < limit;
    case "<=": return value !== "" && number <= limit;
  }
}

// Shown to the caller next to a matching block, e.g. "lead_type is no website".
export function describeCondition(condition: Condition) {
  const words: Record<Condition["op"], string> = { is: "is", not: "is not", empty: "is empty", filled: "has a value", contains: "contains", excludes: "doesn't contain", starts: "starts with", ">": "is above", ">=": "is at least", "<": "is below", "<=": "is at most" };
  return `${condition.variable} ${words[condition.op]}${condition.values.length ? ` ${condition.values.join(" or ")}` : ""}`;
}
