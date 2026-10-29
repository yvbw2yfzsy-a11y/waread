import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRich, type RichNode } from '../src/richtext.ts';

/** Compact notation for assertions: [bold: x], (italic: x), -strike: x-, `code`, <pre>. */
function show(nodes: RichNode[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text': return n.v;
        case 'b': return `[${show(n.c)}]`;
        case 'i': return `(${show(n.c)})`;
        case 's': return `-${show(n.c)}-`;
        case 'code': return `\`${n.v}\``;
        case 'pre': return `<${n.v}>`;
      }
    })
    .join('');
}

describe('parseRich', () => {
  it('formats bold, italic, strikethrough and code', () => {
    assert.equal(show(parseRich('Ich schreibe *fett*, _kursiv_ und ~durchgestrichen~ und `code`.')), 'Ich schreibe [fett], (kursiv) und -durchgestrichen- und `code`.');
  });
  it('nests marks', () => {
    assert.equal(show(parseRich('*fett und _kursiv_*')), '[fett und (kursiv)]');
    assert.equal(show(parseRich('_*beides*_')), '([beides])');
  });
  it('leaves snake_case, 2*3*4, lone marks and URLs alone', () => {
    for (const plain of ['snake_case_name', '2*3*4', 'ein * Stern', 'a_b', 'https://x.example/a_b_c?q=1', 'Preis: 5*', '**', '__', '* leer *']) {
      assert.equal(show(parseRich(plain)), plain, plain);
    }
  });
  it('needs a word start before and punctuation or space after', () => {
    assert.equal(show(parseRich('(*ja*) und *nein*!')), '([ja]) und [nein]!');
    assert.equal(show(parseRich('abc*def*ghi')), 'abc*def*ghi');
  });
  it('does not span lines, and does not format empty or space-padded text', () => {
    assert.equal(show(parseRich('*eins\nzwei*')), '*eins\nzwei*');
    assert.equal(show(parseRich('* nicht fett *')), '* nicht fett *');
  });
  it('code blocks keep their content as typed', () => {
    assert.equal(show(parseRich('vorher ```a *b* _c_``` nachher')), 'vorher <a *b* _c_> nachher');
    assert.equal(show(parseRich('`*kein fett*`')), '`*kein fett*`');
  });
  it('is bounded: deep nesting and long runs of marks terminate', () => {
    parseRich('*'.repeat(5000));
    parseRich('*_~*_~*_~ text ~_*~_*~_*');
    parseRich('_a '.repeat(3000));
  });
});
