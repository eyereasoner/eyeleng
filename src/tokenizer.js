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
  function startsWith(text) { return source.startsWith(text, i); }
  function advance() {
    const ch = source[i++];
    if (ch === '\n') { line += 1; column = 1; }
    else column += 1;
    return ch;
  }
  function token(type, value, startLine, startColumn, extra = {}) {
    tokens.push({ type, value, line: startLine, column: startColumn, ...extra });
  }
  function syntax(message, startLine, startColumn) {
    throw new SyntaxErrorWithLocation(message, { line: startLine, column: startColumn, filename });
  }

  function readNumericLiteral() {
    let value = '';
    const start = i;
    while (i < source.length && isDigitCode(source.charCodeAt(i))) { i += 1; column += 1; }
    if (source[i] === '.' && isDigitCode(source.charCodeAt(i + 1))) {
      i += 1; column += 1;
      while (i < source.length && isDigitCode(source.charCodeAt(i))) { i += 1; column += 1; }
    }
    value = source.slice(start, i);
    if (current() === 'e' || current() === 'E') {
      const saveI = i;
      const saveLine = line;
      const saveColumn = column;
      let exponent = advance();
      if (current() === '+' || current() === '-') exponent += advance();
      if (isDigitCode(source.charCodeAt(i))) {
        while (i < source.length && isDigitCode(source.charCodeAt(i))) exponent += advance();
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
        if (!isHexCode(source.charCodeAt(i))) syntax(`Invalid \\${esc} escape`, startLine, startColumn);
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
        if (!isHexCode(source.charCodeAt(i))) syntax(`Invalid \\${esc} escape`, startLine, startColumn);
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
    if (isWhitespaceCode(source.charCodeAt(i))) { advance(); continue; }
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
      const wordStart = i;
      advance();
      while (i < source.length && isLangTagCode(source.charCodeAt(i))) { i += 1; column += 1; }
      const value = source.slice(wordStart, i);
      if (!/^@[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--[A-Za-z]+)?$/.test(value)) syntax(`Invalid language tag ${value}`, startLine, startColumn);
      token('word', value, startLine, startColumn);
      continue;
    }

    if (ch === '?' || ch === '$') {
      const varStart = i;
      advance();
      while (i < source.length && isVarNameCode(source.charCodeAt(i))) { i += 1; column += 1; }
      if (i - varStart === 1) syntax('Expected variable name', startLine, startColumn);
      token('variable', source.slice(varStart + 1, i), startLine, startColumn);
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

    const wordStart = i;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\' && source[i + 1] !== undefined) {
        i += 2;
        column += 2;
        continue;
      }
      const code = source.charCodeAt(i);
      if (isWhitespaceCode(code) || '{}()[],;|'.includes(c) || '=<>+-*/!^~'.includes(c)) break;
      if (c === '.') {
        const n = source[i + 1];
        if (n === undefined || isWhitespaceCode(n.charCodeAt(0)) || '{}()[],;|'.includes(n) || '=<>+-*/!^~'.includes(n)) break;
      }
      if (c === '#') break;
      i += 1;
      column += 1;
    }
    if (i === wordStart) syntax(`Unexpected character ${JSON.stringify(ch)}`, startLine, startColumn);

    const value = source.slice(wordStart, i);
    if (/^[+-]?(?:(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d+)$/.test(value)) token('number', Number(value), startLine, startColumn);
    else token('word', value, startLine, startColumn);
  }

  tokens.push({ type: 'eof', value: '<eof>', line, column, filename });
  return tokens;
}


function isDigitCode(code) {
  return code >= 48 && code <= 57;
}

function isHexCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isWhitespaceCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isLangTagCode(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45;
}

function isVarNameCode(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 45;
}

function startsNumericLiteral(source, i) {
  const ch = source[i];
  const next = source[i + 1];
  if (isDigitCode(ch.charCodeAt(0))) return true;
  if (ch === '.' && next !== undefined && isDigitCode(next.charCodeAt(0))) return true;
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
