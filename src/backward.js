'use strict';

const { TripleStore, bindingKey } = require('./store.js');
const { tripleKey, termKey, termEquals } = require('./term.js');
const { evalExpression, booleanValue, asTerm } = require('./builtins.js');

function backwardQuery(program, querySpec, options = {}) {
  const planner = planBackwardQuery(program, querySpec, options);
  if (!planner.ok) return { ok: false, reason: planner.reason };
  const prover = new BackwardProver(program, { ...options, allowedRuleIndexes: planner.ruleIndexes });
  const bindings = uniqueBindings(Array.from(prover.solveBody(querySpec.body, {})));
  return { ok: true, bindings, stats: prover.stats, plan: planner };
}

function planBackwardQuery(program, querySpec, options = {}) {
  const clauses = querySpec && Array.isArray(querySpec.body) ? querySpec.body : [];
  if (!bodySupported(clauses, options)) return { ok: false, reason: 'query body contains clauses not supported by the backward prover yet' };

  const reachable = reachableBackwardRuleIndexes(program, clauses, options);
  for (const ruleIndex of reachable.ruleIndexes) {
    const rule = (program.rules || [])[ruleIndex];
    if (!ruleSupported(rule, options)) return { ok: false, reason: `reachable rule ${rule.name || '<anonymous>'} is not supported by the backward prover yet` };
  }
  return { ok: true, ruleIndexes: reachable.ruleIndexes, predicates: reachable.predicates };
}

function bodySupported(clauses, options = {}) {
  for (const clause of clauses || []) {
    if (clause.type === 'triple' || clause.type === 'filter' || clause.type === 'set' || clause.type === 'bind') continue;
    if (clause.type === 'not') {
      if (options.backwardNegation === false) return false;
      if (!bodySupported(clause.body, options)) return false;
      continue;
    }
    return false;
  }
  return true;
}

function ruleSupported(rule, options = {}) {
  if (!Array.isArray(rule.head) || rule.head.length === 0) return false;
  for (const head of rule.head) {
    if (!head || !head.p || head.p.type !== 'iri') return false;
    if (containsBlank(head.s) || containsBlank(head.p) || containsBlank(head.o)) return false;
  }
  return bodySupported(rule.body || [], options);
}

class BackwardProver {
  constructor(program, options = {}) {
    this.program = program;
    this.options = options;
    this.store = options.store || new TripleStore(program.data || []);
    this.maxDepth = options.backwardMaxDepth || options.maxDepth || 10000;
    this.solutionLimit = options.backwardSolutionLimit || options.solutionLimit || 1000000;
    this.allowedPredicates = normalizePredicateSet(options.allowedPredicates || options.backwardPredicates || null);
    this.allowedRuleIndexes = normalizeRuleIndexSet(options.allowedRuleIndexes || null);
    this.ruleHeads = indexRuleHeads(program.rules || [], { allowedPredicates: this.allowedPredicates, allowedRuleIndexes: this.allowedRuleIndexes });
    this.memo = new Map();
    this.active = new Set();
    this.freshCounter = 0;
    this.solutionCount = 0;
    this.stats = {
      mode: 'backward',
      goals: 0,
      facts: 0,
      rules: 0,
      memoHits: 0,
      memoStores: 0,
      maxDepth: 0,
    };
  }

  *solveBody(clauses, binding = {}, depth = 0, index = 0) {
    if (depth > this.maxDepth) throw new Error(`Reached backwardMaxDepth=${this.maxDepth}; backward query may not terminate`);
    this.stats.maxDepth = Math.max(this.stats.maxDepth, depth);
    if (this.solutionCount >= this.solutionLimit) return;
    if (index >= clauses.length) {
      this.solutionCount += 1;
      yield resolveBinding(binding);
      return;
    }

    const clause = clauses[index];
    if (clause.type === 'triple') {
      for (const matched of this.solveTriple(clause.triple, binding, depth + 1)) {
        yield* this.solveBody(clauses, matched, depth + 1, index + 1);
      }
      return;
    }

    if (clause.type === 'filter') {
      try {
        if (booleanValue(evalExpression(clause.expr, resolveBinding(binding), this.options))) {
          yield* this.solveBody(clauses, binding, depth + 1, index + 1);
        }
      } catch (_) {
        // SPARQL-style FILTER errors reject the current solution.
      }
      return;
    }

    if (clause.type === 'set' || clause.type === 'bind') {
      try {
        const resolved = resolveBinding(binding);
        const value = asTerm(evalExpression(clause.expr, resolved, this.options));
        const next = unifyTerms({ type: 'var', value: clause.variable }, value, binding);
        if (next) yield* this.solveBody(clauses, next, depth + 1, index + 1);
      } catch (_) {
        // Assignment errors drop the current solution.
      }
      return;
    }

    if (clause.type === 'not') {
      let found = false;
      for (const _ of this.solveBody(clause.body, { ...binding }, depth + 1, 0)) { found = true; break; }
      if (!found) yield* this.solveBody(clauses, binding, depth + 1, index + 1);
      return;
    }

    throw new Error(`Unsupported backward body clause ${clause.type}`);
  }

  *solveTriple(pattern, binding = {}, depth = 0) {
    if (depth > this.maxDepth) throw new Error(`Reached backwardMaxDepth=${this.maxDepth}; backward query may not terminate`);
    this.stats.goals += 1;
    const resolvedPattern = resolvePattern(pattern, binding);
    const key = `${goalKey(resolvedPattern)}@store:${this.store.version || 0}`;
    const entry = this.memo.get(key);
    if (entry && entry.complete) {
      this.stats.memoHits += 1;
      for (const answer of entry.answers) {
        const next = unifyTriples(pattern, answer, binding);
        if (next) yield next;
      }
      return;
    }
    if (this.active.has(key)) return;

    const answers = [];
    const answerKeys = new Set();
    this.active.add(key);
    try {
      for (const fact of this.factCandidates(resolvedPattern, binding)) {
        const next = unifyTriples(pattern, fact, binding);
        if (!next) continue;
        rememberAnswer(answers, answerKeys, pattern, next);
        this.stats.facts += 1;
        yield next;
      }

      for (const item of this.ruleCandidates(resolvedPattern)) {
        const suffix = `__b${++this.freshCounter}_${item.ruleIndex}`;
        const freshHead = freshTriple(item.head, suffix);
        const next = unifyTriples(pattern, freshHead, binding);
        if (!next) continue;
        const freshBody = (item.rule.body || []).map((clause) => freshClause(clause, suffix));
        for (const solved of this.solveBody(freshBody, next, depth + 1, 0)) {
          rememberAnswer(answers, answerKeys, pattern, solved);
          this.stats.rules += 1;
          yield solved;
        }
      }
    } finally {
      this.active.delete(key);
    }

    this.memo.set(key, { complete: true, answers });
    this.stats.memoStores += 1;
  }

  factCandidates(pattern, binding) {
    return this.store.candidates(pattern, binding);
  }

  ruleCandidates(pattern) {
    const predicate = pattern.p && pattern.p.type === 'iri' ? pattern.p.value : null;
    if (predicate) return this.ruleHeads.byPredicate.get(predicate) || [];
    return this.ruleHeads.all;
  }
}

function indexRuleHeads(rules, options = {}) {
  const allowedPredicates = options.allowedPredicates || null;
  const allowedRuleIndexes = options.allowedRuleIndexes || null;
  const byPredicate = new Map();
  const all = [];
  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
    if (allowedRuleIndexes && !allowedRuleIndexes.has(ruleIndex)) continue;
    const rule = rules[ruleIndex];
    for (let headIndex = 0; headIndex < (rule.head || []).length; headIndex += 1) {
      const head = rule.head[headIndex];
      if (!head || !head.p || head.p.type !== 'iri') continue;
      if (allowedPredicates && !allowedPredicates.has(head.p.value)) continue;
      const item = { ruleIndex, headIndex, rule, head };
      all.push(item);
      const bucket = byPredicate.get(head.p.value);
      if (bucket) bucket.push(item);
      else byPredicate.set(head.p.value, [item]);
    }
  }
  return { byPredicate, all };
}

function freshClause(clause, suffix) {
  if (clause.type === 'triple') return { ...clause, triple: freshTriple(clause.triple, suffix) };
  if (clause.type === 'filter') return { ...clause, expr: freshExpr(clause.expr, suffix) };
  if (clause.type === 'set' || clause.type === 'bind') return { ...clause, variable: freshVarName(clause.variable, suffix), expr: freshExpr(clause.expr, suffix) };
  if (clause.type === 'not') return { ...clause, body: clause.body.map((item) => freshClause(item, suffix)) };
  return clause;
}

function freshTriple(triple, suffix) {
  return { s: freshTerm(triple.s, suffix), p: freshTerm(triple.p, suffix), o: freshTerm(triple.o, suffix) };
}

function freshTerm(term, suffix) {
  if (!term) return term;
  if (term.type === 'var') return { type: 'var', value: freshVarName(term.value, suffix) };
  if (term.type === 'triple') return { type: 'triple', s: freshTerm(term.s, suffix), p: freshTerm(term.p, suffix), o: freshTerm(term.o, suffix) };
  return term;
}

function freshExpr(expr, suffix) {
  if (!expr) return expr;
  if (expr.type === 'var') return { ...expr, name: freshVarName(expr.name, suffix) };
  if (expr.type === 'term') return { ...expr, value: freshTerm(expr.value, suffix) };
  if (expr.type === 'unary') return { ...expr, expr: freshExpr(expr.expr, suffix) };
  if (expr.type === 'binary') return { ...expr, left: freshExpr(expr.left, suffix), right: freshExpr(expr.right, suffix) };
  if (expr.type === 'call') return { ...expr, args: expr.args.map((arg) => freshExpr(arg, suffix)) };
  if (expr.type === 'list') return { ...expr, items: expr.items.map((item) => freshExpr(item, suffix)) };
  return expr;
}

function freshVarName(name, suffix) {
  return `${name}${suffix}`;
}

function resolvePattern(pattern, binding) {
  return { s: resolveTerm(pattern.s, binding, false), p: resolveTerm(pattern.p, binding, false), o: resolveTerm(pattern.o, binding, false) };
}

function resolveBinding(binding) {
  const out = {};
  for (const name of Object.keys(binding)) out[name] = resolveTerm(binding[name], binding, false);
  return out;
}

function resolveTerm(term, binding, preserveUnbound = true, seen = new Set()) {
  if (!term) return term;
  if (term.type === 'var') {
    const name = term.value;
    if (seen.has(name)) return preserveUnbound ? term : { type: 'var', value: name };
    if (!Object.prototype.hasOwnProperty.call(binding, name)) return preserveUnbound ? term : { type: 'var', value: name };
    seen.add(name);
    return resolveTerm(binding[name], binding, preserveUnbound, seen);
  }
  if (term.type === 'triple') {
    return {
      type: 'triple',
      s: resolveTerm(term.s, binding, preserveUnbound, new Set(seen)),
      p: resolveTerm(term.p, binding, preserveUnbound, new Set(seen)),
      o: resolveTerm(term.o, binding, preserveUnbound, new Set(seen)),
    };
  }
  return term;
}

function unifyTriples(left, right, binding) {
  let next = unifyTerms(left.s, right.s, binding);
  if (!next) return null;
  next = unifyTerms(left.p, right.p, next);
  if (!next) return null;
  return unifyTerms(left.o, right.o, next);
}

function unifyTerms(left, right, binding) {
  const a = resolveTerm(left, binding);
  const b = resolveTerm(right, binding);
  if (a.type === 'var' && b.type === 'var' && a.value === b.value) return binding;
  if (a.type === 'var') return bindVariable(a.value, b, binding);
  if (b.type === 'var') return bindVariable(b.value, a, binding);
  if (a.type === 'triple' || b.type === 'triple') {
    if (a.type !== 'triple' || b.type !== 'triple') return null;
    let next = unifyTerms(a.s, b.s, binding);
    if (!next) return null;
    next = unifyTerms(a.p, b.p, next);
    if (!next) return null;
    return unifyTerms(a.o, b.o, next);
  }
  return termEquals(a, b) ? binding : null;
}

function bindVariable(name, term, binding) {
  const existing = binding[name];
  if (existing) return unifyTerms(existing, term, binding);
  if (term.type === 'var' && term.value === name) return binding;
  return { ...binding, [name]: term };
}

function rememberAnswer(answers, answerKeys, pattern, binding) {
  const triple = {
    s: resolveTerm(pattern.s, binding),
    p: resolveTerm(pattern.p, binding),
    o: resolveTerm(pattern.o, binding),
  };
  if (triple.s.type === 'var' || triple.p.type === 'var' || triple.o.type === 'var') return;
  const key = tripleKey(triple);
  if (answerKeys.has(key)) return;
  answerKeys.add(key);
  answers.push(triple);
}

function goalKey(pattern) {
  return `${safeTermKey(pattern.s)} ${safeTermKey(pattern.p)} ${safeTermKey(pattern.o)}`;
}

function safeTermKey(term) {
  return term && term.type === 'var' ? '_' : termKey(term);
}

function uniqueBindings(bindings) {
  const seen = new Set();
  const out = [];
  for (const binding of bindings) {
    const resolved = resolveBinding(binding);
    const key = bindingKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function containsBlank(term) {
  if (!term) return false;
  if (term.type === 'blank') return true;
  if (term.type === 'triple') return containsBlank(term.s) || containsBlank(term.p) || containsBlank(term.o);
  return false;
}



function reachableBackwardRuleIndexes(program, rootClauses, options = {}) {
  const rules = program.rules || [];
  const headIndex = new Map();
  const allHeadPredicates = new Set();
  const allRuleIndexes = new Set();
  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
    const rule = rules[ruleIndex];
    for (const head of rule.head || []) {
      if (!head || !head.p || head.p.type !== 'iri') continue;
      allRuleIndexes.add(ruleIndex);
      allHeadPredicates.add(head.p.value);
      if (!headIndex.has(head.p.value)) headIndex.set(head.p.value, new Set());
      headIndex.get(head.p.value).add(ruleIndex);
    }
  }

  const predicates = new Set();
  const ruleIndexes = new Set();
  const work = [];
  const enqueue = (predicate) => {
    if (!predicate) {
      for (const item of allHeadPredicates) enqueue(item);
      return;
    }
    if (predicates.has(predicate)) return;
    predicates.add(predicate);
    work.push(predicate);
  };

  for (const predicate of bodyPredicateDemands(rootClauses || [])) enqueue(predicate);

  while (work.length > 0) {
    const predicate = work.shift();
    const indexes = headIndex.get(predicate);
    if (!indexes) continue;
    for (const ruleIndex of indexes) {
      if (ruleIndexes.has(ruleIndex)) continue;
      ruleIndexes.add(ruleIndex);
      const rule = rules[ruleIndex];
      for (const needed of bodyPredicateDemands(rule.body || [])) enqueue(needed);
    }
  }

  return { ruleIndexes, predicates };
}

function bodyPredicateDemands(clauses) {
  const out = [];
  for (const clause of clauses || []) {
    if (clause.type === 'triple') {
      out.push(predicateDemand(clause.triple.p));
      continue;
    }
    if (clause.type === 'not') {
      out.push(...bodyPredicateDemands(clause.body || []));
    }
  }
  return out;
}

function predicateDemand(term) {
  return term && term.type === 'iri' ? term.value : null;
}

function normalizePredicateSet(value) {
  if (!value) return null;
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean));
}

function normalizeRuleIndexSet(value) {
  if (!value) return null;
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return null;
}

function supportedBackwardPredicates(program, options = {}) {
  const explicit = normalizePredicateSet(options.backwardPredicates || options.hybridPredicates || null);
  const byPredicate = new Map();
  for (const rule of program.rules || []) {
    const predicates = new Set();
    for (const head of rule.head || []) {
      if (head && head.p && head.p.type === 'iri') predicates.add(head.p.value);
    }
    for (const predicate of predicates) {
      if (!byPredicate.has(predicate)) byPredicate.set(predicate, []);
      byPredicate.get(predicate).push(rule);
    }
  }

  const supported = new Set();
  for (const [predicate, rules] of byPredicate) {
    if (explicit && !explicit.has(predicate)) continue;
    if (rules.length > 0 && rules.every((rule) => ruleSupported(rule, options))) supported.add(predicate);
  }
  return supported;
}

function preferredBackwardPredicates(program, options = {}) {
  const explicit = normalizePredicateSet(options.hybridPredicates || null);
  if (explicit) return supportedBackwardPredicates(program, { ...options, hybridPredicates: explicit });
  const supported = supportedBackwardPredicates(program, options);
  const preferred = new Set();
  for (const rule of program.rules || []) {
    if (!ruleIsFunctionLike(rule)) continue;
    for (const head of rule.head || []) {
      if (head && head.p && head.p.type === 'iri' && supported.has(head.p.value)) preferred.add(head.p.value);
    }
  }
  return preferred;
}

function ruleIsFunctionLike(rule) {
  return (rule.body || []).some((clause) => clause.type === 'set' || clause.type === 'bind');
}

function ruleHeadPredicates(rule) {
  const predicates = new Set();
  for (const head of rule.head || []) {
    if (!head || !head.p || head.p.type !== 'iri') return null;
    predicates.add(head.p.value);
  }
  return predicates;
}

function ruleIsBackwardOriented(rule, predicates) {
  if (!predicates || predicates.size === 0) return false;
  const heads = ruleHeadPredicates(rule);
  if (!heads || heads.size === 0) return false;
  for (const predicate of heads) if (!predicates.has(predicate)) return false;
  return true;
}

module.exports = {
  BackwardProver,
  backwardQuery,
  planBackwardQuery,
  supportedBackwardPredicates,
  preferredBackwardPredicates,
  reachableBackwardRuleIndexes,
  ruleIsBackwardOriented,
  ruleSupported,
  resolveBinding,
};
