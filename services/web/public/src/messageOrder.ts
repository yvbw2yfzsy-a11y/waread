// Reihenfolge der Nachrichten im Verlauf. Rein (ohne DOM), damit sie sich unter Node testen laesst.
import type { Message } from './types';

/**
 * Fuegt Nachrichten in eine nach Zeit geordnete Liste ein.
 *
 * Der WhatsApp-Zeitstempel hat nur Sekundenaufloesung. Nachrichten derselben Sekunde behalten deshalb die Reihenfolge, in
 * der der Server sie liefert (Ankunftsreihenfolge, `wa_timestamp, rowid`). Frueher entschied bei gleicher Sekunde die
 * Nachrichten-ID: WhatsApp-IDs sind Zufallswerte, so erschienen zwei Nachrichten derselben Sekunde (zum Beispiel ein Text
 * und eine Sprachnachricht) in zufaelliger Reihenfolge. `Array.prototype.sort` ist stabil, die Reihenfolge bleibt also erhalten.
 *
 * `where`: 'start' fuer eine Seite AELTERER Nachrichten (bei gleicher Sekunde stehen sie vor den vorhandenen, weil der Server
 * die Seitengrenze nach Ankunft zieht), sonst 'end'. Bekannte IDs werden an Ort und Stelle ersetzt.
 * Aendert `list` und gibt die neu hinzugekommenen Nachrichten zurueck.
 */
export function mergeMessages(list: Message[], incoming: readonly Message[], where: 'start' | 'end' = 'end'): Message[] {
  const known = new Map(list.map((m, i) => [m.id, i]));
  const fresh: Message[] = [];
  for (const m of incoming) {
    const idx = known.get(m.id);
    if (idx === undefined) {
      known.set(m.id, -1);
      fresh.push(m);
    } else if (idx >= 0) {
      list[idx] = m;
    } else {
      // dieselbe ID kam im selben Stapel zweimal an: die letzte Fassung gilt
      const at = fresh.findIndex((f) => f.id === m.id);
      if (at >= 0) fresh[at] = m;
    }
  }
  if (where === 'start') list.unshift(...fresh);
  else list.push(...fresh);
  list.sort((a, b) => a.waTimestamp - b.waTimestamp);
  return fresh;
}
