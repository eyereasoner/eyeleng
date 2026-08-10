'use strict';

const { parseRdfDocument } = require('./rdfSyntax.js');
const { iri, termKey, RDF_TYPE, RDF_FIRST, RDF_REST, RDF_NIL } = require('./term.js');

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

const SH_TARGET_NODE = `${SH}targetNode`;
const SH_TARGET_CLASS = `${SH}targetClass`;
const SH_TARGET_SUBJECTS_OF = `${SH}targetSubjectsOf`;
const SH_TARGET_OBJECTS_OF = `${SH}targetObjectsOf`;
const SH_TARGET = `${SH}target`;
const SH_PATH = `${SH}path`;
const SH_INVERSE_PATH = `${SH}inversePath`;
const SH_ALTERNATIVE_PATH = `${SH}alternativePath`;
const SH_ZERO_OR_MORE_PATH = `${SH}zeroOrMorePath`;
const SH_ONE_OR_MORE_PATH = `${SH}oneOrMorePath`;
const SH_ZERO_OR_ONE_PATH = `${SH}zeroOrOnePath`;
const SH_CLASS = `${SH}class`;
const SH_CLOSED = `${SH}closed`;
const SH_SPARQL = `${SH}sparql`;
const SH_NODE = `${SH}node`;
const SH_PROPERTY = `${SH}property`;
const SH_NOT = `${SH}not`;
const SH_AND = `${SH}and`;
const SH_OR = `${SH}or`;
const SH_XONE = `${SH}xone`;
const SH_QUALIFIED_VALUE_SHAPE = `${SH}qualifiedValueShape`;
const SH_EQUALS = `${SH}equals`;
const SH_DISJOINT = `${SH}disjoint`;
const SH_LESS_THAN = `${SH}lessThan`;
const SH_LESS_THAN_OR_EQUALS = `${SH}lessThanOrEquals`;
const RDFS_CLASS = `${RDFS}Class`;
const RDFS_SUBCLASS_OF = `${RDFS}subClassOf`;

const SHAPE_LINK_PREDICATES = new Set([
  SH_NODE,
  SH_PROPERTY,
  SH_NOT,
  SH_QUALIFIED_VALUE_SHAPE,
]);
const SHAPE_LIST_PREDICATES = new Set([SH_AND, SH_OR, SH_XONE]);
const DATA_PREDICATE_PARAMS = new Set([SH_EQUALS, SH_DISJOINT, SH_LESS_THAN, SH_LESS_THAN_OR_EQUALS]);

async function createShaclShapeEngine(shapes, options = {}) {
  const document = typeof shapes === 'string'
    ? await parseRdfDocument(shapes, {
      filename: options.shapesFilename || options.filename || '<shapes.ttl>',
      baseIRI: options.shapesBaseIRI || options.baseIRI || null,
      contentType: options.shapesContentType,
    })
    : normalizeShapesDocument(shapes);

  const [{ default: Validator }, dataModelModule, datasetModule, sparqlModule] = await Promise.all([
    import('shacl-engine/Validator.js'),
    import('@rdfjs/data-model'),
    import('@rdfjs/dataset'),
    options.shaclSparql === false ? Promise.resolve(null) : import('shacl-engine/sparql.js'),
  ]);
  const dataFactory = dataModelModule.default || dataModelModule;
  const datasetFactory = datasetModule.default || datasetModule;
  // shacl-engine's report materializer calls factory.dataset(), while the
  // standalone @rdfjs/data-model factory intentionally implements only the
  // RDF/JS DataFactory surface. Compose the two without mutating either
  // dependency's singleton export.
  const factory = Object.create(dataFactory);
  factory.dataset = datasetFactory.dataset.bind(datasetFactory);
  const shapesDataset = document.dataset || datasetFactory.dataset(document.quads || []);
  const validatorOptions = { factory, ...(options.shaclValidatorOptions || {}) };
  if (sparqlModule) {
    if (!validatorOptions.validations) validatorOptions.validations = sparqlModule.validations;
    if (!validatorOptions.targetResolvers) validatorOptions.targetResolvers = sparqlModule.targetResolvers;
  }
  const validator = new Validator(shapesDataset, validatorOptions);

  return new ShaclShapeEngine({ document, validator, factory, datasetFactory, options });
}

class ShaclShapeEngine {
  constructor({ document, validator, factory, datasetFactory, options }) {
    this.document = document;
    this.validator = validator;
    this.factory = factory;
    this.datasetFactory = datasetFactory;
    this.options = options || {};
    this.graph = new ShapeGraph(document.triples || []);
    this._dependencyCache = new Map();
  }

  dependencies(shapeIRI) {
    if (this._dependencyCache.has(shapeIRI)) return this._dependencyCache.get(shapeIRI);
    const result = shapeDependencies(this.graph, iri(shapeIRI));
    this._dependencyCache.set(shapeIRI, result);
    return result;
  }

  async validate(graph, options = {}) {
    const dataset = this.datasetFactory.dataset((graph || []).map((triple) => internalTripleToQuad(triple, this.factory)));
    const selectedShapes = options.shapeIRIs && options.shapeIRIs.length
      ? options.shapeIRIs.map((shapeIRI) => ({ terms: [this.factory.namedNode(shapeIRI)] }))
      : undefined;
    return this.validator.validate({ dataset }, selectedShapes);
  }

  async eligibleFocusNodes(shapeIRI, context = {}) {
    const dataDataset = this.datasetFactory.dataset((context.graph || []).map((triple) => internalTripleToQuad(triple, this.factory)));
    const shapeTerm = this.factory.namedNode(shapeIRI);
    const targets = resolveCoreTargets(this.graph, iri(shapeIRI), context.graph || []);

    if (this.graph.objects(iri(shapeIRI), SH_TARGET).length > 0) {
      if (typeof this.options.customTargetResolver === 'function') {
        const extra = await this.options.customTargetResolver(shapeIRI, context);
        for (const node of extra || []) targets.set(termKey(normalizeInternalNode(node)), normalizeInternalNode(node));
      } else {
        throw new Error(`Shape <${shapeIRI}> uses sh:target; provide customTargetResolver for custom/SPARQL targets`);
      }
    }

    const eligible = [];
    for (const internalNode of targets.values()) {
      const focus = internalTermToRdfJs(internalNode, this.factory);
      const report = await this.validator.validate(
        { dataset: dataDataset, terms: [focus] },
        [{ terms: [shapeTerm] }],
      );
      if (report.conforms) eligible.push(internalNode);
    }
    return eligible;
  }
}

function normalizeShapesDocument(shapes) {
  if (!shapes) throw new Error('SHACL shapes are required');
  if (Array.isArray(shapes.triples) && Array.isArray(shapes.quads)) return shapes;
  if (shapes.dataset && typeof shapes.dataset[Symbol.iterator] === 'function') {
    const quads = Array.from(shapes.dataset);
    const { rdfJsTermToTerm } = require('./rdfSyntax.js');
    return {
      baseIRI: shapes.baseIRI || null,
      prefixes: { ...(shapes.prefixes || {}) },
      triples: quads.map((quad) => ({ s: rdfJsTermToTerm(quad.subject), p: rdfJsTermToTerm(quad.predicate), o: rdfJsTermToTerm(quad.object) })),
      quads,
      imports: [],
      dataset: shapes.dataset,
    };
  }
  throw new Error('shapes must be RDF source text, a parsed RDF document, or { dataset }');
}

function resolveCoreTargets(shapeGraph, shape, dataTriples) {
  const out = new Map();
  const add = (node) => out.set(termKey(node), node);

  for (const node of shapeGraph.objects(shape, SH_TARGET_NODE)) add(node);
  for (const classTerm of shapeGraph.objects(shape, SH_TARGET_CLASS)) {
    for (const triple of dataTriples) {
      if (isIri(triple.p, RDF_TYPE) && classMatches(triple.o, classTerm, dataTriples)) add(triple.s);
    }
  }
  for (const predicate of shapeGraph.objects(shape, SH_TARGET_SUBJECTS_OF)) {
    if (predicate.type !== 'iri') continue;
    for (const triple of dataTriples) if (isIri(triple.p, predicate.value)) add(triple.s);
  }
  for (const predicate of shapeGraph.objects(shape, SH_TARGET_OBJECTS_OF)) {
    if (predicate.type !== 'iri') continue;
    for (const triple of dataTriples) if (isIri(triple.p, predicate.value)) add(triple.o);
  }

  // SHACL implicit class target: a shape that is itself an rdfs:Class targets its instances.
  if (shapeGraph.objects(shape, RDF_TYPE).some((term) => isIri(term, RDFS_CLASS))) {
    for (const triple of dataTriples) {
      if (isIri(triple.p, RDF_TYPE) && classMatches(triple.o, shape, dataTriples)) add(triple.s);
    }
  }
  return out;
}

function classMatches(actualClass, targetClass, dataTriples) {
  if (sameTerm(actualClass, targetClass)) return true;
  if (!actualClass || actualClass.type !== 'iri' || !targetClass || targetClass.type !== 'iri') return false;
  const seen = new Set([actualClass.value]);
  const queue = [actualClass.value];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const triple of dataTriples) {
      if (!isIri(triple.p, RDFS_SUBCLASS_OF) || !triple.s || triple.s.type !== 'iri' || triple.s.value !== current || !triple.o || triple.o.type !== 'iri') continue;
      if (triple.o.value === targetClass.value) return true;
      if (!seen.has(triple.o.value)) {
        seen.add(triple.o.value);
        queue.push(triple.o.value);
      }
    }
  }
  return false;
}

function shapeDependencies(graph, rootShape) {
  const predicates = new Set();
  let wildcard = false;
  const seenShapes = new Set();
  const seenPaths = new Set();

  function visitShape(shape) {
    const key = termKey(shape);
    if (seenShapes.has(key)) return;
    seenShapes.add(key);

    for (const classTerm of graph.objects(shape, SH_TARGET_CLASS)) {
      if (classTerm) { predicates.add(RDF_TYPE); predicates.add(RDFS_SUBCLASS_OF); }
    }
    if (graph.objects(shape, RDF_TYPE).some((term) => isIri(term, RDFS_CLASS))) { predicates.add(RDF_TYPE); predicates.add(RDFS_SUBCLASS_OF); }
    for (const predicate of graph.objects(shape, SH_TARGET_SUBJECTS_OF)) if (predicate.type === 'iri') predicates.add(predicate.value);
    for (const predicate of graph.objects(shape, SH_TARGET_OBJECTS_OF)) if (predicate.type === 'iri') predicates.add(predicate.value);
    if (graph.objects(shape, SH_TARGET).length > 0) wildcard = true;
    if (truthyLiteral(graph.objects(shape, SH_CLOSED)[0])) wildcard = true;
    if (graph.objects(shape, SH_SPARQL).length > 0) wildcard = true;
    if (graph.objects(shape, SH_CLASS).length > 0) { predicates.add(RDF_TYPE); predicates.add(RDFS_SUBCLASS_OF); }

    for (const path of graph.objects(shape, SH_PATH)) visitPath(path);
    for (const parameter of DATA_PREDICATE_PARAMS) {
      for (const predicate of graph.objects(shape, parameter)) if (predicate.type === 'iri') predicates.add(predicate.value);
    }
    for (const link of SHAPE_LINK_PREDICATES) for (const nested of graph.objects(shape, link)) visitShape(nested);
    for (const link of SHAPE_LIST_PREDICATES) {
      for (const listHead of graph.objects(shape, link)) {
        for (const nested of graph.list(listHead)) visitShape(nested);
      }
    }
  }

  function visitPath(path) {
    const key = termKey(path);
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    if (path.type === 'iri') {
      predicates.add(path.value);
      return;
    }
    for (const nested of graph.objects(path, SH_INVERSE_PATH)) visitPath(nested);
    for (const nested of graph.objects(path, SH_ZERO_OR_MORE_PATH)) visitPath(nested);
    for (const nested of graph.objects(path, SH_ONE_OR_MORE_PATH)) visitPath(nested);
    for (const nested of graph.objects(path, SH_ZERO_OR_ONE_PATH)) visitPath(nested);
    for (const listHead of graph.objects(path, SH_ALTERNATIVE_PATH)) for (const nested of graph.list(listHead)) visitPath(nested);
    if (graph.isListHead(path)) for (const nested of graph.list(path)) visitPath(nested);
  }

  visitShape(rootShape);
  return { predicates: Array.from(predicates).sort(), wildcard };
}

class ShapeGraph {
  constructor(triples) {
    this.triples = triples || [];
    this.bySubject = new Map();
    for (const triple of this.triples) {
      const key = termKey(triple.s);
      if (!this.bySubject.has(key)) this.bySubject.set(key, []);
      this.bySubject.get(key).push(triple);
    }
  }

  objects(subject, predicate) {
    return (this.bySubject.get(termKey(subject)) || [])
      .filter((triple) => isIri(triple.p, predicate))
      .map((triple) => triple.o);
  }

  isListHead(term) {
    return isIri(term, RDF_NIL) || this.objects(term, RDF_FIRST).length === 1;
  }

  list(head) {
    const out = [];
    const seen = new Set();
    let node = head;
    while (!isIri(node, RDF_NIL)) {
      const key = termKey(node);
      if (seen.has(key)) throw new Error('Cycle in SHACL RDF list');
      seen.add(key);
      const first = this.objects(node, RDF_FIRST);
      const rest = this.objects(node, RDF_REST);
      if (first.length !== 1 || rest.length !== 1) throw new Error('Malformed SHACL RDF list');
      out.push(first[0]);
      node = rest[0];
    }
    return out;
  }
}

function truthyLiteral(term) {
  if (!term || term.type !== 'literal') return false;
  return term.value === true || term.value === 'true' || term.value === 1 || term.value === '1';
}

function sameTerm(a, b) {
  return termKey(a) === termKey(b);
}

function isIri(term, value) {
  return !!term && term.type === 'iri' && term.value === value;
}

function normalizeInternalNode(node) {
  if (node && node.type) return node;
  if (typeof node === 'string') return iri(node);
  if (node && node.termType) {
    const { rdfJsTermToTerm } = require('./rdfSyntax.js');
    return rdfJsTermToTerm(node);
  }
  throw new Error('Unsupported SHACL focus node');
}

function internalTripleToQuad(triple, factory) {
  return factory.quad(
    internalTermToRdfJs(triple.s, factory),
    internalTermToRdfJs(triple.p, factory),
    internalTermToRdfJs(triple.o, factory),
    triple.graph ? internalTermToRdfJs(triple.graph, factory) : factory.defaultGraph(),
  );
}

function internalTermToRdfJs(term, factory) {
  if (!term) return factory.defaultGraph();
  if (term.type === 'iri') return factory.namedNode(term.value);
  if (term.type === 'blank') return factory.blankNode(term.value);
  if (term.type === 'var') return factory.variable(term.value);
  if (term.type === 'triple') return factory.quad(
    internalTermToRdfJs(term.s, factory),
    internalTermToRdfJs(term.p, factory),
    internalTermToRdfJs(term.o, factory),
  );
  if (term.type === 'literal') {
    const lexical = typeof term.value === 'boolean' ? (term.value ? 'true' : 'false') : String(term.value);
    if (term.lang) {
      // RDF/JS 1.2 factories may support directional language literals; fall back to normal language literals.
      if (term.langDir) {
        try { return factory.literal(lexical, { language: term.lang, direction: term.langDir }); } catch (_) { /* fall through */ }
      }
      return factory.literal(lexical, term.lang);
    }
    return term.datatype ? factory.literal(lexical, factory.namedNode(term.datatype)) : factory.literal(lexical);
  }
  throw new Error(`Unsupported Eyeleng term type ${term.type || typeof term}`);
}

module.exports = {
  createShaclShapeEngine,
  ShaclShapeEngine,
  shapeDependencies,
  resolveCoreTargets,
  internalTermToRdfJs,
  internalTripleToQuad,
  constants: { SH, SH_TARGET_NODE, SH_TARGET_CLASS, SH_TARGET_SUBJECTS_OF, SH_TARGET_OBJECTS_OF, SH_TARGET, SH_PATH },
};
