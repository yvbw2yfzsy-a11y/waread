import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeMessages } from '../src/messageOrder.ts';
import type { Message } from '../src/types.ts';

const m = (id: string, ts: number, extra: Partial<Message> = {}): Message => ({ id, chatId: 'c', waTimestamp: ts, fromMe: false, type: 'text', ...extra });
const ids = (l: Message[]): string => l.map((x) => x.id).join(' ');

describe('mergeMessages', () => {
  it('Nachrichten derselben Sekunde behalten die Reihenfolge des Servers, nicht die der IDs', () => {
    // WhatsApp-IDs sind Zufallswerte: "Z..." kam zuerst an, "A..." danach.
    const list: Message[] = [];
    mergeMessages(list, [m('Z9', 100), m('A1', 100), m('M5', 100)]);
    assert.equal(ids(list), 'Z9 A1 M5');
  });

  it('eine spaeter eintreffende Nachricht derselben Sekunde steht hinter den vorhandenen', () => {
    const list = [m('Z9', 100), m('A1', 100)];
    const added = mergeMessages(list, [m('B2', 100)]);
    assert.equal(ids(list), 'Z9 A1 B2');
    assert.equal(ids(added), 'B2');
  });

  it('eine Seite aelterer Nachrichten steht bei gleicher Sekunde VOR den vorhandenen (Seitengrenze mitten in einer Sekunde)', () => {
    const list = [m('late-1', 100), m('late-2', 100), m('x', 101)];
    mergeMessages(list, [m('early-1', 99), m('early-2', 100)], 'start');
    assert.equal(ids(list), 'early-1 early-2 late-1 late-2 x');
  });

  it('ordnet nach Zeit, auch wenn eine Nachricht mit aelterem Zeitstempel spaeter eintrifft', () => {
    const list = [m('a', 100), m('c', 102)];
    mergeMessages(list, [m('b', 101)]);
    assert.equal(ids(list), 'a b c');
  });

  it('bekannte IDs werden an Ort und Stelle ersetzt und nicht als neu gemeldet', () => {
    const list = [m('a', 100), m('b', 100, { text: 'alt' })];
    const added = mergeMessages(list, [m('b', 100, { text: 'neu' })]);
    assert.equal(added.length, 0);
    assert.equal(ids(list), 'a b');
    assert.equal(list[1]?.text, 'neu');
  });

  it('dieselbe ID zweimal im Stapel: es bleibt eine, die letzte Fassung', () => {
    const list: Message[] = [];
    const added = mergeMessages(list, [m('a', 100, { text: '1' }), m('a', 100, { text: '2' })]);
    assert.equal(list.length, 1);
    assert.equal(added.length, 1);
    assert.equal(list[0]?.text, '2');
  });

  it('leere Eingaben aendern nichts', () => {
    const list = [m('a', 100)];
    assert.equal(mergeMessages(list, []).length, 0);
    assert.equal(ids(list), 'a');
  });

  it('viele Nachrichten in einer Sekunde bleiben in Lieferreihenfolge (stabil)', () => {
    const incoming = Array.from({ length: 150 }, (_, i) => m(`id-${String(149 - i).padStart(3, '0')}`, 500));
    const list: Message[] = [];
    mergeMessages(list, incoming);
    assert.deepEqual(list.map((x) => x.id), incoming.map((x) => x.id));
  });
});
