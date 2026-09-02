'use strict';

const { TripleStore, bindingKey, instantiateTerm } = require('./store.js');
const { tripleKey, termKey, termEquals, iri, blankNode, literal, tripleTerm } = require('./term.js');
const { evalExpression, booleanValue, asTerm } = require('./builtins.js');
const { analyze } = require('./analyze.js');

function evaluate(program, options = {}) {
  const maxIterations = options.maxIterations ?? 10000;
  const evalOptions = { ...options, baseIRI: options.baseIRI || program.baseIRI || null, now: options.now || new Date(), __bnodeLabels: options.__bnodeLabels || new Map() };
  const baseData = (program.baseData || []).slice();
  const ruleData = (program.data || []).slice();
  const store = new TripleStore([...baseData, ...ruleData]);
  // SPARQL-RL ground data is the external base graph only. DATA blocks are
  // rule-set facts and therefore belong to the inference graph.
  const groundStore = new TripleStore(baseData);
  const inputKeys = new Set(baseData.map(tripleKey));
  const inferred = [];
  const inferredKeys = new Set();
  for (const triple of ruleData) {
    const key = tripleKey(triple);
    if (!inputKeys.has(key) && !inferredKeys.has(key)) { inferred.push(triple); inferredKeys.add(key); }
  }
  const trace = options.trace || options.prove ? [] : null;
  let iterations = 0;
  let ruleApplications = 0;
  const perRule = program.rules.map((rule, index) => ({
    name: rule.name || `rule#${index + 1}`,
    applications: 0,
    added: 0,
    runOnce: !!rule.runOnce,
  }));

  const analysis = options.analysis || analyze(program, options);
  if (analysis.errors && analysis.errors.length > 0 && !options.ignoreAnalysisErrors) {
    throw new Error(`Analysis failed: ${analysis.errors.map((error) => error.message).join('; ')}`);
  }
  const layerIndexes = analysis.dependency && analysis.dependency.layerIndexes
    ? analysis.dependency.layerIndexes
    : [program.rules.map((_, index) => index)];
  const recursiveLayerFlags = computeRecursiveLayerFlags(
    layerIndexes,
    analysis.dependency ? analysis.dependency.edges : [],
  );
  const baseContext = {
    ...evalOptions,
    maxIterations,
    inputKeys,
    inferred,
    trace,
    perRule,
    layer: 0,
    iteration: 0,
    startingIterations: 0,
    recursiveLayer: false,
    groundStore,
  };

  for (let layerIndex = 0; layerIndex < layerIndexes.length; layerIndex += 1) {
    const layer = layerIndexes[layerIndex];
    baseContext.layer = layerIndex + 1;
    const ordinary = layer.filter((ruleIndex) => !program.rules[ruleIndex].runOnce);
    const runOnce = layer.filter((ruleIndex) => program.rules[ruleIndex].runOnce);

    if (runOnce.length > 0) {
      iterations += 1;
      for (const ruleIndex of runOnce) {
        baseContext.iteration = iterations;
        const added = applyRuleOnce(program, store, ruleIndex, baseContext);
        ruleApplications += added.applications;
      }
    }

    baseContext.startingIterations = iterations;
    baseContext.recursiveLayer = recursiveLayerFlags[layerIndex];
    const ordinaryResult = runRulesToFixpoint(program, store, ordinary, baseContext);
    iterations = ordinaryResult.iterations;
    ruleApplications += ordinaryResult.ruleApplications;
  }

  return {
    baseIRI: program.baseIRI,
    version: program.version || null,
    imports: program.imports || [],
    prefixes: program.prefixes,
    input: baseData,
    data: ruleData,
    inferred,
    closure: store.values(),
    iterations,
    layers: layerIndexes.map((layer) => layer.map((ruleIndex) => perRule[ruleIndex].name)),
    ruleApplications,
    perRule,
    trace: trace || [],
    groundStore,
  };
}


async function evaluateAsync(program, options = {}) {
  const maxIterations = options.maxIterations ?? 10000;
  const evalOptions = { ...options, baseIRI: options.baseIRI || program.baseIRI || null, now: options.now || new Date(), __bnodeLabels: options.__bnodeLabels || new Map() };
  const baseData = (program.baseData || []).slice();
  const ruleData = (program.data || []).slice();
  const store = new TripleStore([...baseData, ...ruleData]);
  // SPARQL-RL ground data is the external base graph only. DATA blocks are
  // rule-set facts and therefore belong to the inference graph.
  const groundStore = new TripleStore(baseData);
  const inputKeys = new Set(baseData.map(tripleKey));
  const inferred = [];
  const inferredKeys = new Set();
  for (const triple of ruleData) {
    const key = tripleKey(triple);
    if (!inputKeys.has(key) && !inferredKeys.has(key)) { inferred.push(triple); inferredKeys.add(key); }
  }
  const trace = options.trace || options.prove ? [] : null;
  let iterations = 0;
  let ruleApplications = 0;
  const perRule = program.rules.map((rule, index) => ({
    name: rule.name || `rule#${index + 1}`,
    applications: 0,
    added: 0,
    runOnce: !!rule.runOnce,
  }));

  const analysis = options.analysis || analyze(program, options);
  if (analysis.errors && analysis.errors.length > 0 && !options.ignoreAnalysisErrors) {
    throw new Error(`Analysis failed: ${analysis.errors.map((error) => error.message).join('; ')}`);
  }
  const layerIndexes = analysis.dependency && analysis.dependency.layerIndexes
    ? analysis.dependency.layerIndexes
    : [program.rules.map((_, index) => index)];
  const recursiveLayerFlags = computeRecursiveLayerFlags(
    layerIndexes,
    analysis.dependency ? analysis.dependency.edges : [],
  );
  const baseContext = {
    ...evalOptions,
    maxIterations,
    inputKeys,
    inferred,
    trace,
    perRule,
    layer: 0,
    iteration: 0,
    startingIterations: 0,
    recursiveLayer: false,
    groundStore,
  };

  for (let layerIndex = 0; layerIndex < layerIndexes.length; layerIndex += 1) {
    const layer = layerIndexes[layerIndex];
    baseContext.layer = layerIndex + 1;
    const ordinary = layer.filter((ruleIndex) => !program.rules[ruleIndex].runOnce);
    const runOnce = layer.filter((ruleIndex) => program.rules[ruleIndex].runOnce);

    if (runOnce.length > 0) {
      iterations += 1;
      for (const ruleIndex of runOnce) {
        baseContext.iteration = iterations;
        const added = applyRuleOnce(program, store, ruleIndex, baseContext);
        ruleApplications += added.applications;
      }
    }

    baseContext.startingIterations = iterations;
    baseContext.recursiveLayer = recursiveLayerFlags[layerIndex];
    const ordinaryResult = runRulesToFixpoint(program, store, ordinary, baseContext);
    iterations = ordinaryResult.iterations;
    ruleApplications += ordinaryResult.ruleApplications;
  }

  return {
    baseIRI: program.baseIRI,
    version: program.version || null,
    imports: program.imports || [],
    prefixes: program.prefixes,
    input: baseData,
    data: ruleData,
    inferred,
    closure: store.values(),
    iterations,
    layers: layerIndexes.map((layer) => layer.map((ruleIndex) => perRule[ruleIndex].name)),
    ruleApplications,
    perRule,
    trace: trace || [],
    groundStore,
  };
}

function runRulesToFixpoint(program, store, ruleIndexes, context) {
  if (ruleIndexes.length === 0) return { iterations: context.startingIterations, ruleApplications: 0 };

  // A stratum may contain only acyclic rule components. Such rules only need a
  // single pass after lower strata have reached their fixpoints; spending an
  // extra no-change pass per layer makes deep taxonomies look non-terminating.
  if (!context.recursiveLayer) {
    const iteration = context.startingIterations + 1;
    let ruleApplications = 0;
    for (const ruleIndex of ruleIndexes) {
      context.iteration = iteration;
      const applied = applyRuleOnce(program, store, ruleIndex, context);
      ruleApplications += applied.applications;
    }
    return { iterations: iteration, ruleApplications };
  }

  let iterations = context.startingIterations;
  let localIterations = 0;
  let ruleApplications = 0;

  while (localIterations < context.maxIterations) {
    localIterations += 1;
    iterations += 1;
    let addedInIteration = 0;

    for (const ruleIndex of ruleIndexes) {
      context.iteration = iterations;
      const applied = applyRuleOnce(program, store, ruleIndex, context);
      addedInIteration += applied.added;
      ruleApplications += applied.applications;
    }

    if (addedInIteration === 0) break;
  }

  if (localIterations >= context.maxIterations) {
    throw new Error(`Reached maxIterations=${context.maxIterations} within layer ${context.layer}; rules may not terminate`);
  }

  return { iterations, ruleApplications };
}

function computeRecursiveLayerFlags(layerIndexes, edges = []) {
  const flags = Array(layerIndexes.length).fill(false);
  const layerOfRule = new Map();
  for (let layerIndex = 0; layerIndex < layerIndexes.length; layerIndex += 1) {
    for (const ruleIndex of layerIndexes[layerIndex]) layerOfRule.set(ruleIndex, layerIndex);
  }
  for (const edge of edges) {
    const fromLayer = layerOfRule.get(edge.from);
    if (fromLayer === undefined) continue;
    if (fromLayer === layerOfRule.get(edge.to)) flags[fromLayer] = true;
  }
  return flags;
}


function applyRuleOnce(program, store, ruleIndex, context) {
  const rule = program.rules[ruleIndex];
  let applications = 0;
  let added = 0;
  const dedupeBindings = rule.body.some((clause) => clause.type === 'path');
  const seenBindings = dedupeBindings ? new Set() : null;
  const headBlankLabels = collectHeadBlankLabels(rule.head);

  const bodyStore = rule.groundData ? context.groundStore : store;
  const bodyContext = { ...context };
  if (!context.trace && headBlankLabels.size === 0 && rule.body.every((clause) => clause.type === 'triple')) {
    bodyContext.retainedBodyVariables = collectVariables(rule.head);
  }
  const initialBindings = [{}];
  const bodyBindings = evaluateRuleBodyBindings(rule, bodyStore, bodyContext, initialBindings);

  for (const binding of bodyBindings) {
    if (seenBindings) {
      const key = bindingKey(binding);
      if (seenBindings.has(key)) continue;
      seenBindings.add(key);
    }
    applications += 1;
    context.perRule[ruleIndex].applications += 1;

    const headBlankMap = headBlankLabels.size > 0 ? new Map() : null;
    const skolemKey = headBlankMap ? skolemizationKey(ruleIndex, binding) : null;
    for (const head of rule.head) {
      const triple = instantiateHeadTriple(head, binding, headBlankLabels, headBlankMap, skolemKey);
      if (!triple) continue;
      if (store.add(triple)) {
        added += 1;
        context.perRule[ruleIndex].added += 1;
        if (!context.inputKeys.has(tripleKey(triple))) context.inferred.push(triple);
        if (context.trace) {
          context.trace.push({
            layer: context.layer,
            iteration: context.iteration,
            rule: rule.name || `rule#${ruleIndex + 1}`,
            triple,
            binding,
            uses: proofUses(rule.body, binding),
          });
        }
      }
    }
  }

  return { applications, added };
}

function* evaluateRuleBodyBindings(rule, bodyStore, bodyContext, initialBindings) {
  for (const initialBinding of initialBindings) {
    if (rule.body.length === 1 && rule.body[0].type === 'triple') {
      yield* bodyStore.match(rule.body[0].triple, initialBinding);
    } else {
      yield* evaluateBodyStream(rule.body, bodyStore, initialBinding, bodyContext);
    }
  }
}

function proofUses(body, binding) {
  return body
    .filter((clause) => clause.type === 'triple')
    .map((clause) => ({
      s: instantiateTerm(clause.triple.s, binding),
      p: instantiateTerm(clause.triple.p, binding),
      o: instantiateTerm(clause.triple.o, binding),
    }))
    .filter((triple) => ![triple.s, triple.p, triple.o].some((term) => term && term.type === 'var'));
}

function instantiateHeadTriple(pattern, binding, headBlankLabels, headBlankMap, skolemKey) {
  const s = instantiateHeadTerm(pattern.s, binding, headBlankLabels, headBlankMap, skolemKey);
  const p = instantiateHeadTerm(pattern.p, binding, headBlankLabels, headBlankMap, skolemKey);
  const o = instantiateHeadTerm(pattern.o, binding, headBlankLabels, headBlankMap, skolemKey);
  if (!s || !p || !o) return null;
  if (p.type !== 'iri') return null;
  return { s, p, o };
}

function instantiateHeadTerm(term, binding, headBlankLabels, headBlankMap, skolemKey) {
  if (term.type === 'var') return binding[term.value] || null;
  if (term.type === 'blank' && headBlankLabels.has(term.value)) {
    let label = headBlankMap.get(term.value);
    if (!label) {
      label = `sk_${deterministicSkolemIdFromKey(`${skolemKey}|${term.value}`).replace(/-/g, '_')}`;
      headBlankMap.set(term.value, label);
    }
    return blankNode(label);
  }
  if (term.type === 'triple') {
    const s = instantiateHeadTerm(term.s, binding, headBlankLabels, headBlankMap, skolemKey);
    const p = instantiateHeadTerm(term.p, binding, headBlankLabels, headBlankMap, skolemKey);
    const o = instantiateHeadTerm(term.o, binding, headBlankLabels, headBlankMap, skolemKey);
    if (!s || !p || !o) return null;
    return tripleTerm(s, p, o);
  }
  return term;
}

function collectHeadBlankLabels(head) {
  const labels = new Set();
  for (const triple of head || []) {
    collectBlankLabelsFromTerm(triple.s, labels);
    collectBlankLabelsFromTerm(triple.p, labels);
    collectBlankLabelsFromTerm(triple.o, labels);
  }
  return labels;
}

function collectBlankLabelsFromTerm(term, labels) {
  if (!term) return;
  if (term.type === 'blank') {
    labels.add(term.value);
    return;
  }
  if (term.type === 'triple') {
    collectBlankLabelsFromTerm(term.s, labels);
    collectBlankLabelsFromTerm(term.p, labels);
    collectBlankLabelsFromTerm(term.o, labels);
  }
}

function skolemizationKey(ruleIndex, binding) {
  let out = `rule:${ruleIndex}`;
  for (const name of Object.keys(binding).sort()) {
    const value = binding[name];
    out += `|${name}=${value ? termKey(value) : 'unbound'}`;
  }
  return out;
}

function deterministicSkolemIdFromKey(key) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  let h3 = 0x811c9dc5;
  let h4 = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + 1; h2 = Math.imul(h2, 0x01000193) >>> 0;
    h3 ^= c + 2; h3 = Math.imul(h3, 0x01000193) >>> 0;
    h4 ^= c + 3; h4 = Math.imul(h4, 0x01000193) >>> 0;
  }
  return [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
}


function evaluateBody(clauses, store, initialBinding = {}, options = {}) {
  const bindings = [];
  const seen = new Set();
  for (const binding of evaluateBodyStream(clauses, store, initialBinding, options)) {
    const key = bindingKey(binding);
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push(binding);
  }
  return bindings;
}

function* evaluateBodyStream(clauses, store, initialBinding = {}, options = {}, index = 0) {
  const plannedClauses = options.trace ? clauses : planBodyClauses(clauses);
  if (index >= plannedClauses.length) {
    yield initialBinding;
    return;
  }
  const stack = [{
    index,
    iterator: evaluateBodyClause(plannedClauses[index], store, initialBinding, options),
  }];
  const dropAfter = options.retainedBodyVariables
    ? bodyVariableLastUses(plannedClauses, options.retainedBodyVariables)
    : null;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const next = frame.iterator.next();
    if (next.done) {
      stack.pop();
      continue;
    }
    const binding = dropAfter ? dropBindingVariables(next.value, dropAfter[frame.index]) : next.value;
    const nextIndex = frame.index + 1;
    if (nextIndex >= plannedClauses.length) {
      yield binding;
      continue;
    }
    stack.push({
      index: nextIndex,
      iterator: evaluateBodyClause(plannedClauses[nextIndex], store, binding, options),
    });
  }
}
function planBodyClauses(clauses) {
  const planned = [];
  for (let index = 0; index < clauses.length;) {
    const tuple = listTuplePatternAt(clauses, index);
    if (tuple) {
      planned.push({ type: 'listTuple', tuple });
      index += 7;
    } else {
      planned.push(clauses[index]);
      index += 1;
    }
  }
  return planned;
}
function listTuplePatternAt(clauses, index) {
  const group = clauses.slice(index, index + 7);
  if (group.length !== 7 || group.some((clause) => clause.type !== 'triple')) return null;
  const triples = group.map((clause) => clause.triple);
  const [first1, rest1, first2, rest2, first3, rest3, relation] = triples;
  if (!isPredicate(first1, 'first') || !isPredicate(rest1, 'rest')
    || !isPredicate(first2, 'first') || !isPredicate(rest2, 'rest')
    || !isPredicate(first3, 'first') || !isPredicate(rest3, 'rest')) return null;
  if (!sameVariable(first1.s, rest1.s) || !sameVariable(rest1.o, first2.s)
    || !sameVariable(first2.s, rest2.s) || !sameVariable(rest2.o, first3.s)
    || !sameVariable(first3.s, rest3.s) || !sameVariable(first1.s, relation.s)) return null;
  if (!rest3.o || rest3.o.type !== 'iri' || rest3.o.value !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil') return null;
  return { s: first1.s, p: relation.p, o: relation.o, items: [first1.o, first2.o, first3.o] };
}
function isPredicate(triple, localName) {
  return triple.p && triple.p.type === 'iri'
    && triple.p.value === `http://www.w3.org/1999/02/22-rdf-syntax-ns#${localName}`;
}
function sameVariable(left, right) {
  return left && right && left.type === 'var' && right.type === 'var' && left.value === right.value;
}
function bodyVariableLastUses(clauses, retainedVariables) {
  const lastUse = new Map();
  for (let index = 0; index < clauses.length; index += 1) {
    for (const name of collectVariables(clauses[index])) lastUse.set(name, index);
  }
  const dropAfter = Array.from({ length: clauses.length }, () => []);
  for (const [name, index] of lastUse) {
    if (!retainedVariables.has(name)) dropAfter[index].push(name);
  }
  return dropAfter;
}
function collectVariables(value, variables = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return variables;
  seen.add(value);
  if (value.type === 'var' && typeof value.value === 'string') {
    variables.add(value.value);
    return variables;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVariables(item, variables, seen);
  } else {
    for (const item of Object.values(value)) collectVariables(item, variables, seen);
  }
  return variables;
}
function dropBindingVariables(binding, names) {
  if (names.length === 0 || !names.some((name) => Object.hasOwn(binding, name))) return binding;
  const projected = { ...binding };
  for (const name of names) delete projected[name];
  return projected;
}
function* evaluateBodyClause(clause, store, initialBinding, options) {
  if (clause.type === 'listTuple') {
    yield* store.matchListTuple(clause.tuple, initialBinding);
    return;
  }
  if (clause.type === 'triple') {
    yield* store.match(clause.triple, initialBinding);
    return;
  }

  if (clause.type === 'path') {
    for (const matched of store.matchPath(clause.triple, initialBinding)) {
      yield matched;
    }
    return;
  }

  if (clause.type === 'filter') {
    try {
      if (booleanValue(evalExpression(clause.expr, initialBinding, options))) {
        yield initialBinding;
      }
    } catch (_) {
      // SPARQL-style FILTER errors reject the current solution.
    }
    return;
  }

  if (clause.type === 'set' || clause.type === 'bind') {
    try {
      const value = asTerm(evalExpression(clause.expr, initialBinding, options));
      if (!initialBinding[clause.variable]) {
        yield { ...initialBinding, [clause.variable]: value };
      } else if (termEquals(initialBinding[clause.variable], value)) {
        yield initialBinding;
      }
    } catch (_) {
      // The SRL evaluation sketch drops a solution when assignment evaluation errors.
    }
    return;
  }

  if (clause.type === 'not') {
    const negationStore = clause.groundData ? (options.groundStore || store) : store;
    if (!bodyHasAny(clause.body, negationStore, initialBinding, options)) {
      yield initialBinding;
    }
    return;
  }

  throw new Error(`Unsupported body clause ${clause.type}`);
}

function bodyHasAny(clauses, store, initialBinding, options) {
  for (const _ of evaluateBodyStream(clauses, store, initialBinding, options)) return true;
  return false;
}

function uniqueBindings(bindings) {
  const seen = new Set();
  const out = [];
  for (const binding of bindings) {
    const key = bindingKey(binding);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(binding);
    }
  }
  return out;
}

module.exports = { evaluate, evaluateAsync, evaluateBody, uniqueBindings };
