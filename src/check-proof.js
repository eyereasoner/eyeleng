// Proof checking for SPARQL 1.2 RL proof documents.
//
// A proof document says what was concluded and why. Checking it means
// re-performing every inference it records against the rule set it claims to
// come from. The specification is eyeron's `docs/proof-checking.md`, and
// this is its SRL reading; eyeron's `src/proof/` is the reference
// implementation that document specifies.
//
// A checker does not reason. It never searches for a derivation the writer
// failed to record, and it never runs the engine; it only verifies what is
// written. Four conditions decide validity:
//
//   C1 Resolution     -- every use resolves to a step's conclusion or to a
//                        statement the rule set gives.
//   C2 Well-founded   -- no conclusion is used by its own derivation.
//   C3 Justification  -- every step cites a rule, and re-applying that rule
//                        under the bindings the step recorded yields exactly
//                        this conclusion from exactly these uses.
//   C4 Coverage       -- every claim has a step or is given.
'use strict';

const { parse } = require('./parser');

const PE = 'https://eyereasoner.github.io/pe#';
const RDF_REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies';

function termKey(term) {
  if (!term) return '<none>';
  switch (term.type) {
    case 'iri': return `<${term.value}>`;
    case 'blank': return `_:${term.value}`;
    case 'var': return `?${term.value}`;
    case 'triple': return `<<(${termKey(term.s)} ${termKey(term.p)} ${termKey(term.o)})>>`;
    case 'literal': return `"${term.value}"^^${term.datatype || ''}@${term.lang || ''}`;
    default: return JSON.stringify(term);
  }
}

function tripleKey(t) {
  return t ? `${termKey(t.s)}\t${termKey(t.p)}\t${termKey(t.o)}` : '<none>';
}

function peLocalName(term) {
  return term && term.type === 'iri' && term.value.startsWith(PE) ? term.value.slice(PE.length) : null;
}

// One-way matching of a rule's pattern against a recorded statement. Only
// the pattern's variables bind: the step may not instantiate itself to meet
// the rule halfway. A blank node in a rule body is matched the same way,
// because the label a rule writes is not the label the data carries.
function matchTerm(pattern, target, bindings) {
  let name = null;
  if (pattern && pattern.type === 'var') name = `?${pattern.value}`;
  else if (pattern && pattern.type === 'blank') name = `_:${pattern.value}`;
  if (name != null) {
    if (Object.prototype.hasOwnProperty.call(bindings, name)) return termKey(bindings[name]) === termKey(target);
    bindings[name] = target;
    return true;
  }
  if (pattern && target && pattern.type === 'triple' && target.type === 'triple') {
    return matchTriple(pattern, target, bindings);
  }
  return termKey(pattern) === termKey(target);
}

function matchTriple(pattern, target, bindings) {
  return matchTerm(pattern.s, target.s, bindings)
    && matchTerm(pattern.p, target.p, bindings)
    && matchTerm(pattern.o, target.o, bindings);
}

function instantiate(term, binding) {
  if (term && term.type === 'var') return Object.prototype.hasOwnProperty.call(binding, term.value) ? binding[term.value] : term;
  return term;
}

function instantiateTriple(pattern, binding) {
  return { s: instantiate(pattern.s, binding), p: instantiate(pattern.p, binding), o: instantiate(pattern.o, binding) };
}

function isGround(triple) {
  return ![triple.s, triple.p, triple.o].some((term) => term && term.type === 'var');
}

// The document, read as the abstract model. A step is a node reifying its own
// conclusion; everything else in `DATA` is a claim.
function readProofDocument(proofText) {
  const document = parse(proofText);
  const steps = new Map();
  const bindingNodes = new Map();
  const stepNodes = new Set();

  for (const triple of document.data) {
    if (triple.p.type === 'iri' && triple.p.value === RDF_REIFIES && triple.o && triple.o.type === 'triple') {
      stepNodes.add(termKey(triple.s));
      steps.set(termKey(triple.s), {
        id: termKey(triple.s),
        conclusion: { s: triple.o.s, p: triple.o.p, o: triple.o.o },
        rule: null,
        bindings: {},
        uses: [],
        detail: null,
      });
    }
  }
  for (const triple of document.data) {
    const local = peLocalName(triple.p);
    if (local !== 'var' && local !== 'value') continue;
    const node = bindingNodes.get(termKey(triple.s)) || {};
    node[local] = triple.o;
    bindingNodes.set(termKey(triple.s), node);
  }
  for (const triple of document.data) {
    const local = peLocalName(triple.p);
    if (local == null) continue;
    const step = steps.get(termKey(triple.s));
    if (!step) continue;
    if (local === 'rule') step.rule = Number(triple.o.value);
    else if (local === 'binding') {
      const node = bindingNodes.get(termKey(triple.o));
      if (node && node.var) step.bindings[String(node.var.value)] = node.value;
    } else if (local === 'uses') step.uses.push(triple.o);
    else step.detail = `carries unknown proof vocabulary pe:${local}`;
  }

  const bookkeeping = new Set([...bindingNodes.keys()]);
  const claims = document.data.filter((triple) => {
    if (peLocalName(triple.p) != null) return false;
    if (triple.p.type === 'iri' && triple.p.value === RDF_REIFIES) return false;
    return !stepNodes.has(termKey(triple.s)) && !bookkeeping.has(termKey(triple.s));
  });

  return { steps: [...steps.values()], byId: steps, claims };
}


// C2: following what a step used never leads back to it.
function checkWellFounded(steps, byConclusion, failures) {
  const OPEN = 1;
  const DONE = 2;
  const state = new Map();
  const edgesOf = (step) => step.uses
    .map((use) => (use.type === 'triple' ? byConclusion.get(tripleKey({ s: use.s, p: use.p, o: use.o })) : byId(steps, use)))
    .filter(Boolean);

  for (const start of steps) {
    if (state.get(start)) continue;
    state.set(start, OPEN);
    const stack = [{ step: start, edges: null, index: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.edges == null) frame.edges = edgesOf(frame.step);
      if (frame.index >= frame.edges.length) {
        state.set(frame.step, DONE);
        stack.pop();
        continue;
      }
      const next = frame.edges[frame.index++];
      if (state.get(next) === DONE) continue;
      if (state.get(next) === OPEN) {
        failures.push({
          condition: 'C2',
          conclusion: tripleKey(next.conclusion),
          detail: 'is used, directly or indirectly, by its own derivation',
        });
        state.set(next, DONE);
        continue;
      }
      state.set(next, OPEN);
      stack.push({ step: next, edges: null, index: 0 });
    }
  }
}

function byId(steps, term) {
  const wanted = termKey(term);
  return steps.find((step) => step.id === wanted) || null;
}

// What a `pe:uses` entry names: a step, by its node, or a statement, by its
// own triple term.
function useStatement(use, steps) {
  if (use.type === 'triple') return { s: use.s, p: use.p, o: use.o };
  const step = byId(steps, use);
  return step ? step.conclusion : null;
}

// C3 for a rule step: re-apply the cited rule under the bindings the step
// recorded. The rule comes from the *rule set*, never from the document -- a
// proof cannot be made valid by restating the rule it used.
//
// The engine records a premise only when instantiating it leaves nothing
// unbound, so the comparison drops the same ones rather than expecting the
// step to carry them.
function checkRuleStep(step, rules, steps) {
  if (!Number.isInteger(step.rule)) return 'cites no rule';
  const rule = rules[step.rule - 1];
  if (!rule) return `cites rule ${step.rule}, which the rule set does not have`;

  // The engine records a premise only when instantiating it leaves nothing
  // unbound, so the comparison drops the same ones rather than expecting the
  // step to carry them.
  const premises = rule.body
    .filter((clause) => clause.type === 'triple')
    .map((clause) => clause.triple)
    .filter((pattern) => isGround(instantiateTriple(pattern, step.bindings)));

  const used = step.uses.map((use) => useStatement(use, steps));
  if (used.some((statement) => statement == null)) return 'uses something that is neither a step nor a statement';
  if (premises.length !== used.length) {
    return `uses ${used.length} premise(s), but rule ${step.rule} yields ${premises.length} under these bindings`;
  }

  // One environment across every premise and the head, so a variable the
  // bindings did not mention is still forced to take one consistent value.
  const bindings = {};
  for (const [name, value] of Object.entries(step.bindings)) bindings[`?${name}`] = value;

  for (let i = 0; i < premises.length; i++) {
    if (!matchTriple(premises[i], used[i], bindings)) {
      return `premise ${i + 1} is ${tripleKey(used[i])}, but rule ${step.rule} requires ${tripleKey(premises[i])}`;
    }
  }

  const concluded = rule.head.some((pattern) => matchTriple(pattern, step.conclusion, { ...bindings }));
  if (!concluded) return `does not follow from rule ${step.rule}: it concludes none of what this step claims`;
  return null;
}

// Check `proofText` against the rule set it claims to come from.
//
// `program` is the *compiled* rule set, with `IMPORTS` resolved, because a
// step cites a rule by its number there. `baseGraph` supplies statements the
// run was given rather than told -- `--data` input, or a message log --
// which a use may resolve to just as it resolves to a `DATA` fact.
function checkProofDocument(program, proofText, options = {}) {
  const { steps, claims } = readProofDocument(proofText);
  const rules = program.rules || [];
  const failures = [];
  let verified = 0;

  const byConclusion = new Map();
  for (const step of steps) {
    if (!byConclusion.has(tripleKey(step.conclusion))) byConclusion.set(tripleKey(step.conclusion), step);
  }
  // A statement the rule set gives outright, which a use may resolve to
  // without a step of its own.
  const given = new Set((program.data || []).map(tripleKey));
  for (const triple of options.baseGraph || []) given.add(tripleKey(triple));

  // A blank node's label is not an identifier: it is local to the document
  // that wrote it, so the same statement can reach the checker labelled
  // differently than the run labelled it. Where labels do not settle it, a
  // statement counts as given when some given statement corresponds to it
  // with blank nodes matched consistently -- which is what a reader does.
  const givenStatements = [...(program.data || []), ...(options.baseGraph || [])];
  const correspondsToGiven = (statement) => {
    if (!hasBlank(statement)) return false;
    return givenStatements.some((candidate) => matchBlanks(candidate, statement));
  };

  const resolves = (statement) => statement != null
    && (byConclusion.has(tripleKey(statement)) || given.has(tripleKey(statement)) || correspondsToGiven(statement));

  // C1.
  for (const step of steps) {
    for (const use of step.uses) {
      const statement = useStatement(use, steps);
      if (!resolves(statement)) {
        failures.push({
          condition: 'C1',
          conclusion: tripleKey(step.conclusion),
          detail: `uses ${statement ? tripleKey(statement) : termKey(use)}, which is neither a step's conclusion nor given by the rule set`,
        });
      }
    }
  }

  // C2.
  checkWellFounded(steps, byConclusion, failures);

  // C3.
  for (const step of steps) {
    if (step.detail) {
      failures.push({ condition: 'C3', conclusion: tripleKey(step.conclusion), detail: step.detail });
      continue;
    }
    const detail = checkRuleStep(step, rules, steps);
    if (detail) failures.push({ condition: 'C3', conclusion: tripleKey(step.conclusion), detail });
    else verified++;
  }

  // C4.
  for (const claim of claims) {
    if (!resolves(claim)) {
      failures.push({
        condition: 'C4',
        conclusion: tripleKey(claim),
        detail: 'claimed, but no step concludes it and the rule set does not give it',
      });
    }
  }

  return { steps: steps.length, verified, claims: claims.length, failures, valid: failures.length === 0 };
}

function hasBlank(term) {
  if (!term) return false;
  if (term.type === 'blank') return true;
  if (term.type === 'triple') return hasBlank(term.s) || hasBlank(term.p) || hasBlank(term.o);
  if (term.s || term.p || term.o) return hasBlank(term.s) || hasBlank(term.p) || hasBlank(term.o);
  return false;
}

// Do two statements correspond with blank nodes matched consistently?
// Everything else must be equal: only labels are allowed to differ.
function matchBlanks(left, right, mapping = new Map()) {
  const term = (a, b) => {
    if (a && b && a.type === 'blank' && b.type === 'blank') {
      const seen = mapping.get(a.value);
      if (seen !== undefined) return seen === b.value;
      mapping.set(a.value, b.value);
      return true;
    }
    if (a && b && a.type === 'triple' && b.type === 'triple') return matchBlanks(a, b, mapping);
    return termKey(a) === termKey(b);
  };
  return term(left.s, right.s) && term(left.p, right.p) && term(left.o, right.o);
}

// The verdict line the specification requires. Every SRL step is checked --
// there are no trusted justifications here, because a rule application is
// all this format records.
function verdict(report) {
  if (!report.valid) return `invalid: ${report.failures.length} failure(s)`;
  return `checked: ${report.steps} steps`;
}

module.exports = { checkProofDocument, readProofDocument, verdict, termKey, tripleKey };
