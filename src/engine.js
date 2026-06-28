'use strict';

const { TripleStore, bindingKey, instantiateTerm } = require('./store.js');
const { tripleKey, termKey, termEquals, blankNode, tripleTerm } = require('./term.js');
const { evalExpression, booleanValue, asTerm } = require('./builtins.js');
const { analyze } = require('./analyze.js');
const { BackwardProver, preferredBackwardPredicates, ruleIsBackwardOriented } = require('./backward.js');

function evaluate(program, options = {}) {
  const maxIterations = options.maxIterations ?? 10000;
  const evalOptions = { ...options, baseIRI: options.baseIRI || program.baseIRI || null, now: options.now || new Date(), __bnodeLabels: options.__bnodeLabels || new Map() };
  const store = new TripleStore(program.data);
  const inputKeys = new Set(program.data.map(tripleKey));
  const inferred = [];
  const trace = [];
  let iterations = 0;
  let ruleApplications = 0;
  const perRule = program.rules.map((rule, index) => ({
    name: rule.name || `rule#${index + 1}`,
    applications: 0,
    added: 0,
    runOnce: !!rule.runOnce,
    backward: false,
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
  const relaxedRecursiveRunOnce = options.relaxedRecursion === false
    ? new Set()
    : recursiveTermGenerationRuleIndexes(analysis);
  const hybridBackwardPredicates = options.hybrid || options.backwardBodyCalls
    ? preferredBackwardPredicates(program, options)
    : new Set();
  const hybridBackwardRules = new Set();
  if (hybridBackwardPredicates.size > 0) {
    for (let ruleIndex = 0; ruleIndex < program.rules.length; ruleIndex += 1) {
      if (ruleIsBackwardOriented(program.rules[ruleIndex], hybridBackwardPredicates)) hybridBackwardRules.add(ruleIndex);
    }
  }
  const hybridStats = hybridBackwardPredicates.size > 0 ? emptyBackwardStats() : null;
  for (const ruleIndex of hybridBackwardRules) perRule[ruleIndex].backward = true;
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
    hybridBackwardPredicates,
    hybridBackwardRules,
    hybridStats,
  };

  for (let layerIndex = 0; layerIndex < layerIndexes.length; layerIndex += 1) {
    const layer = layerIndexes[layerIndex];
    const forwardLayer = hybridBackwardRules.size > 0 ? layer.filter((ruleIndex) => !hybridBackwardRules.has(ruleIndex)) : layer;
    const ordinary = forwardLayer.filter((ruleIndex) => !program.rules[ruleIndex].runOnce || relaxedRecursiveRunOnce.has(ruleIndex));
    const runOnce = forwardLayer.filter((ruleIndex) => program.rules[ruleIndex].runOnce && !relaxedRecursiveRunOnce.has(ruleIndex));

    if (runOnce.length > 0) {
      iterations += 1;
      for (const ruleIndex of runOnce) {
        baseContext.layer = layerIndex + 1;
        baseContext.iteration = iterations;
        const added = applyRuleOnce(program, store, ruleIndex, baseContext);
        ruleApplications += added.applications;
      }
    }

    baseContext.layer = layerIndex + 1;
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
    input: program.data.slice(),
    inferred,
    closure: store.values(),
    iterations,
    layers: layerIndexes.map((layer) => layer.map((ruleIndex) => perRule[ruleIndex].name)),
    ruleApplications,
    perRule,
    trace,
    hybridStats,
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

  const bodyContext = prepareBodyContext(program, store, context);
  const bodyBindings = rule.body.length === 1 && rule.body[0].type === 'triple' && !shouldUseBackwardForTriple(rule.body[0].triple, {}, bodyContext)
    ? store.match(rule.body[0].triple, {})
    : evaluateBodyStream(rule.body, store, {}, bodyContext);

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
          });
        }
      }
    }
  }

  if (bodyContext.backwardProver && context.hybridStats) mergeBackwardStats(context.hybridStats, bodyContext.backwardProver.stats);
  return { applications, added };
}

function prepareBodyContext(program, store, context) {
  if (!context.hybridBackwardPredicates || context.hybridBackwardPredicates.size === 0) return context;
  return {
    ...context,
    backwardProver: new BackwardProver(program, {
      ...context,
      store,
      allowedPredicates: context.hybridBackwardPredicates,
    }),
  };
}

function emptyBackwardStats() {
  return { mode: 'hybrid', goals: 0, facts: 0, rules: 0, memoHits: 0, memoStores: 0, maxDepth: 0 };
}

function mergeBackwardStats(total, item) {
  if (!total || !item) return;
  total.goals += item.goals || 0;
  total.facts += item.facts || 0;
  total.rules += item.rules || 0;
  total.memoHits += item.memoHits || 0;
  total.memoStores += item.memoStores || 0;
  total.maxDepth = Math.max(total.maxDepth || 0, item.maxDepth || 0);
}

function recursiveTermGenerationRuleIndexes(analysis) {
  const out = new Set();
  if (!analysis || !analysis.dependency || !analysis.diagnostics) return out;
  const byName = new Map((analysis.dependency.rules || []).map((rule) => [rule.name, rule.index]));
  for (const diagnostic of analysis.diagnostics) {
    if (diagnostic.code !== 'recursive-assignment-rule') continue;
    if (byName.has(diagnostic.rule)) out.add(byName.get(diagnostic.rule));
  }
  return out;
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
  if (index >= clauses.length) {
    yield initialBinding;
    return;
  }

  const clause = clauses[index];
  if (clause.type === 'triple') {
    const seen = new Set();
    for (const matched of store.match(clause.triple, initialBinding)) {
      const key = bindingKey(matched);
      seen.add(key);
      yield* evaluateBodyStream(clauses, store, matched, options, index + 1);
    }
    if (shouldUseBackwardForTriple(clause.triple, initialBinding, options)) {
      for (const matched of options.backwardProver.solveTriple(clause.triple, initialBinding)) {
        const key = bindingKey(matched);
        if (seen.has(key)) continue;
        seen.add(key);
        yield* evaluateBodyStream(clauses, store, matched, options, index + 1);
      }
    }
    return;
  }

  if (clause.type === 'path') {
    for (const matched of store.matchPath(clause.triple, initialBinding)) {
      yield* evaluateBodyStream(clauses, store, matched, options, index + 1);
    }
    return;
  }

  if (clause.type === 'filter') {
    try {
      if (booleanValue(evalExpression(clause.expr, initialBinding, options))) {
        yield* evaluateBodyStream(clauses, store, initialBinding, options, index + 1);
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
        yield* evaluateBodyStream(clauses, store, { ...initialBinding, [clause.variable]: value }, options, index + 1);
      } else if (termEquals(initialBinding[clause.variable], value)) {
        yield* evaluateBodyStream(clauses, store, initialBinding, options, index + 1);
      }
    } catch (_) {
      // The SRL evaluation sketch drops a solution when assignment evaluation errors.
    }
    return;
  }

  if (clause.type === 'not') {
    if (!bodyHasAny(clause.body, store, initialBinding, options)) {
      yield* evaluateBodyStream(clauses, store, initialBinding, options, index + 1);
    }
    return;
  }

  throw new Error(`Unsupported body clause ${clause.type}`);
}

function shouldUseBackwardForTriple(pattern, binding, options = {}) {
  if (!options.backwardProver || !options.hybridBackwardPredicates || options.hybridBackwardPredicates.size === 0) return false;
  const predicate = instantiateTerm(pattern.p, binding);
  return !!(predicate && predicate.type === 'iri' && options.hybridBackwardPredicates.has(predicate.value));
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

module.exports = { evaluate, evaluateBody, uniqueBindings };
