'use strict';

class SyntaxErrorWithLocation extends Error {
  constructor(message, token) {
    const suffix = token && token.line ? ` at ${token.filename || '<input>'}:${token.line}:${token.column}` : '';
    super(`${message}${suffix}`);
    this.name = 'SyntaxError';
    this.token = token;
  }
}

function tokenize(source, filenameOrOptions = '<input>') {
  const options = typeof filenameOrOptions === 'object' && filenameOrOptions !== null ? filenameOrOptions : { filename: filenameOrOptions };
  const filename = options.filename || '<input>';
  const strictGrammar = !!options.strictGrammar;
  const tokens = [];
  let i = 0;
  let line = 1;
  let column = 1;

  function current() { return source[i]; }
  function peek(n = 1) { return source[i + n]; }
  function startsWith(text) { return source.slice(i, i + text.length) === text; }
  function advance() {
    const ch = source[i++];
    if (ch === '\n') { line += 1; column = 1; }
    else column += 1;
    return ch;
  }
  function token(type, value, startLine, startColumn, extra = {}) {
    tokens.push({ type, value, line: startLine, column: startColumn, filename, ...extra });
  }
  function syntax(message, startLine, startColumn) {
    throw new SyntaxErrorWithLocation(message, { line: startLine, column: startColumn, filename });
  }

  function readNumericLiteral() {
    let value = '';
    while (i < source.length && /[0-9]/.test(current())) value += advance();
    if (current() === '.' && /[0-9]/.test(peek())) {
      value += advance();
      while (i < source.length && /[0-9]/.test(current())) value += advance();
    }
    if (current() === 'e' || current() === 'E') {
      const saveI = i;
      const saveLine = line;
      const saveColumn = column;
      let exponent = advance();
      if (current() === '+' || current() === '-') exponent += advance();
      if (/[0-9]/.test(current())) {
        while (i < source.length && /[0-9]/.test(current())) exponent += advance();
        value += exponent;
      } else {
        i = saveI;
        line = saveLine;
        column = saveColumn;
      }
    }
    return value;
  }

  function readEscape(startLine, startColumn) {
    advance(); // consume backslash
    const esc = advance();
    if (esc === 'u' || esc === 'U') {
      const length = esc === 'u' ? 4 : 8;
      let hex = '';
      for (let j = 0; j < length; j += 1) {
        if (!/[0-9A-Fa-f]/.test(current() || '')) syntax(`Invalid \\${esc} escape`, startLine, startColumn);
        hex += advance();
      }
      const codePoint = Number.parseInt(hex, 16);
      try { return String.fromCodePoint(codePoint); }
      catch { syntax(`Invalid \\${esc} escape`, startLine, startColumn); }
    }
    if (strictGrammar && !Object.hasOwn(escapeMap, esc)) syntax(`Invalid escape \\${esc}`, startLine, startColumn);
    return escapeValue(esc);
  }

  function readIriChar(startLine, startColumn) {
    if (current() === '\\') {
      advance();
      const esc = advance();
      if (esc !== 'u' && esc !== 'U') syntax(`Invalid IRI escape \\${esc}`, startLine, startColumn);
      const length = esc === 'u' ? 4 : 8;
      let hex = '';
      for (let j = 0; j < length; j += 1) {
        if (!/[0-9A-Fa-f]/.test(current() || '')) syntax(`Invalid \\${esc} escape`, startLine, startColumn);
        hex += advance();
      }
      const codePoint = Number.parseInt(hex, 16);
      try { return String.fromCodePoint(codePoint); }
      catch { syntax(`Invalid \\${esc} escape`, startLine, startColumn); }
    }
    const c = current();
    if (strictGrammar && (/[\u0000-\u0020]/.test(c) || /[<>"{}|^`]/.test(c))) syntax(`Invalid character in IRI reference ${JSON.stringify(c)}`, startLine, startColumn);
    return advance();
  }

  while (i < source.length) {
    const ch = current();
    if (/\s/.test(ch)) { advance(); continue; }
    if (ch === '#') {
      while (i < source.length && current() !== '\n') advance();
      continue;
    }

    const startLine = line;
    const startColumn = column;

    if (startsWith('<<(')) {
      advance(); advance(); advance();
      token('punct', '<<(', startLine, startColumn);
      continue;
    }
    if (startsWith(')>>')) {
      advance(); advance(); advance();
      token('punct', ')>>', startLine, startColumn);
      continue;
    }
    if (startsWith('<<')) {
      advance(); advance();
      token('punct', '<<', startLine, startColumn);
      continue;
    }
    if (startsWith('>>')) {
      advance(); advance();
      token('punct', '>>', startLine, startColumn);
      continue;
    }
    if (startsWith('{|')) {
      advance(); advance();
      token('punct', '{|', startLine, startColumn);
      continue;
    }
    if (startsWith('|}')) {
      advance(); advance();
      token('punct', '|}', startLine, startColumn);
      continue;
    }

    if (ch === '<' && looksLikeIRI(source, i)) {
      let value = '';
      advance();
      while (i < source.length && current() !== '>') value += readIriChar(startLine, startColumn);
      if (current() !== '>') syntax('Unterminated IRI', startLine, startColumn);
      advance();
      token('iri', value, startLine, startColumn);
      continue;
    }

    if ((ch === '"' && startsWith('"""')) || (ch === "'" && startsWith("'''"))) {
      const quote = ch;
      advance(); advance(); advance();
      let value = '';
      while (i < source.length && !startsWith(quote.repeat(3))) {
        if (current() === '\\') {
          value += readEscape(startLine, startColumn);
        } else {
          value += advance();
        }
      }
      if (!startsWith(quote.repeat(3))) syntax('Unterminated long string literal', startLine, startColumn);
      advance(); advance(); advance();
      token('string', value, startLine, startColumn, { long: true, quote });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = '';
      advance();
      while (i < source.length && current() !== quote) {
        if (current() === '\n' || current() === '\r') syntax('Unterminated string literal', startLine, startColumn);
        if (current() === '\\') {
          value += readEscape(startLine, startColumn);
        } else {
          value += advance();
        }
      }
      if (current() !== quote) syntax('Unterminated string literal', startLine, startColumn);
      advance();
      token('string', value, startLine, startColumn, { long: false, quote });
      continue;
    }

    if (ch === '@') {
      let value = advance();
      while (i < source.length && /[A-Za-z0-9-]/.test(current())) value += advance();
      if (!/^@[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--[A-Za-z]+)?$/.test(value)) syntax(`Invalid language tag ${value}`, startLine, startColumn);
      token('word', value, startLine, startColumn);
      continue;
    }

    if (ch === '?' || ch === '$') {
      let value = advance();
      while (i < source.length && /[A-Za-z0-9_\-]/.test(current())) value += advance();
      if (value.length === 1) syntax('Expected variable name', startLine, startColumn);
      token('variable', value.slice(1), startLine, startColumn);
      continue;
    }

    if (startsNumericLiteral(source, i)) {
      const value = readNumericLiteral();
      token('number', Number(value), startLine, startColumn);
      continue;
    }

    const two = ch + peek();
    if ([':=', '!=', '<=', '>=', '&&', '||', '=>', '^^'].includes(two)) {
      advance(); advance();
      token('operator', two, startLine, startColumn);
      continue;
    }

    if ('{}()[].,;|'.includes(ch)) {
      token('punct', advance(), startLine, startColumn);
      continue;
    }

    if ('=<>+-*/!^~'.includes(ch)) {
      token('operator', advance(), startLine, startColumn);
      continue;
    }

    let value = '';
    while (i < source.length) {
      const c = current();
      if (c === '\\' && peek() !== undefined) {
        value += advance();
        value += advance();
        continue;
      }
      if (/\s/.test(c) || '{}()[],;|'.includes(c) || '=<>+-*/!^~'.includes(c)) break;
      if (c === '.') {
        const n = peek();
        if (n === undefined || /\s/.test(n) || '{}()[],;|'.includes(n) || '=<>+-*/!^~'.includes(n)) break;
      }
      if (c === '#') break;
      value += advance();
    }
    if (value.length === 0) syntax(`Unexpected character ${JSON.stringify(ch)}`, startLine, startColumn);

    if (/^[+-]?(?:(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d+)$/.test(value)) token('number', Number(value), startLine, startColumn);
    else token('word', value, startLine, startColumn);
  }

  tokens.push({ type: 'eof', value: '<eof>', line, column, filename });
  return tokens;
}

function startsNumericLiteral(source, i) {
  const ch = source[i];
  const next = source[i + 1];
  if (/[0-9]/.test(ch)) return true;
  if (ch === '.' && /[0-9]/.test(next)) return true;
  return false;
}

function looksLikeIRI(source, i) {
  const next = source[i + 1];
  if (next === undefined || /[\s=]/.test(next)) return false;
  for (let j = i + 1; j < source.length; j += 1) {
    const c = source[j];
    if (c === '>') return true;
    if (/\s/.test(c)) return false;
  }
  return false;
}

const escapeMap = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', "'": "'", '\\': '\\' };

function escapeValue(esc) {
  return escapeMap[esc] ?? esc;
}

module.exports = { tokenize, SyntaxErrorWithLocation };
