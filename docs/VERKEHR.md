# Was die Bibliothek an WhatsApp schickt (F07)

Stand: Oktober 2026 · Gilt für: waread mit Baileys `7.0.0-rc14`

## Wie belastbar diese Liste ist

- **GESICHERT** ist nur, was im Quelltext der Bibliothek steht (gelesen, nicht ausgeführt). Dateinamen und Zeilen beziehen sich auf `7.0.0-rc14`; mit einer anderen Version kann sich alles ändern.
- **Nichts davon ist gemessen.** Reihenfolge und Häufigkeit auf dem Draht sind aus dem Quelltext abgeleitet.
- Ob und wie WhatsApp einen dieser Knoten bewertet, ist **UNBEKANNT**. Aus der Liste folgt weder „unauffällig“ noch „riskant“.
- „Waread sendet nichts“ gilt für den **eigenen Code** (der Wächter in `test/no-send-calls.test.ts` und die Hülle `waLib.ts` sichern das). Die Bibliothek selbst sendet, siehe unten. Die frühere Formulierung „nur die Zustellbestätigung“ (`SECURITY_TESTS.md`, Abschnitt 0) war zu eng.

## Was unvermeidlich mitgesendet wird (keine Option und kein Aufruf von waread steuert es)

| Wann | Was | Quelle |
| --- | --- | --- |
| jede Verbindung | WebSocket-Aufbau, Noise-Handshake mit `ClientPayload` (Gerätekennung, Plattform, App-Version, Land), `iq encrypt count` (Prekey-Zähler), `iq passive active`, `iq encrypt digest`, `ib unified_session` | `socket.ts`, `validate-connection.ts` |
| jede Verbindung | drei Init-Abfragen (`abt props`, `blocklist`, `privacy`); abschaltbar nur über eine Bibliotheksoption, die waread **nicht** setzt (Folgen ohne Test unbekannt) | `chats.ts` |
| jede Verbindung, wenn der Anzeigename bekannt ist | `presence type=unavailable` | `chats.ts` |
| alle 30 s | Ping (`iq xmlns=w:p`) | `socket.ts` |
| je empfangener Fremdnachricht | Receipt, bei waread vom Typ `inactive` (nicht die typlose „Zustellung“); dazu je nach Fall `sender`, `peer_msg`, `hist_sync` | `messages-recv.ts` |
| je Server-Benachrichtigung | `ack` | `messages-recv.ts`, `stanza-ack.ts` |
| bei Entschlüsselungsfehlern | Retry-Receipt (ab dem 2. Versuch mit Prekeys), höchstens 5 je Nachricht | `messages-recv.ts` |
| bei fehlendem Inhalt einer Nachricht | **Placeholder-Resend:** eine Peer-Nachricht an die eigene Nummer, 2–3 s verzögert. Das ist eine von der Bibliothek ausgelöste Nachricht; waread schaltet sie nicht ab. | `messages-recv.ts`, `messages-send.ts` |
| bei unbekanntem Absender ohne lokale Zuordnung | USync-Abfrage der LID, **ohne Negativ-Cache** (wiederholt sich bei leerer Antwort mit der nächsten Nachricht) | `decode-wa-message.ts`, `lid-mapping.ts` |
| bei Schlüsselmangel (`encrypt count < 5`) oder erstem Start | Prekey-Upload | `socket.ts`, `signal.ts` |
| bei Serverhinweisen (`dirty`, `server_sync`) | Gruppenliste abfragen, App-State-Sync | `groups.ts`, `chats.ts`, `messages-recv.ts` |
| bei jedem `creds.update` ohne `me`, sobald der Anzeigename bekannt ist (F04) | `<presence/>` ohne Typ; der Handler sitzt in der Bibliothek, waread kann ihn nicht abschalten. Was der Server damit macht (z. B. Anzeige „online“), ist UNBEKANNT. | `socket.ts` |
| Mediendownload | kein WebSocket-Knoten, sondern ein HTTPS-GET an den Medienhost | `messages-media.ts`; waread prüft das Ziel (F01) |

## Was waread selbst nie auslöst (vom Wächter und der Hülle gesichert)

Lesebestätigung (blaue Haken), „abgespielt“, Tippanzeige, Nachrichten, Gruppen- und Profilabfragen, Abmelden (`logout`), Statusabfragen, Anruf-Ablehnung. Die Hülle reicht von der Bibliothek nur `ev.on`, `ev.off` und `end` durch. Das schließt **nicht** aus, dass die Bibliothek diese Funktionen intern selbst aufruft; im gelesenen Quelltext tut sie es für die Lese-/Abgespielt-Bestätigung nicht automatisch.

## Messen statt raten: Zähler für ausgehende Knoten

Für die Testinstanz mit Zweitnummer gibt es einen Zähler (`count_outgoing_nodes = true` in `[ingest]` von `config.toml`; ab Werk **aus**).

- Er hängt am Logger der Bibliothek. Dafür läuft die Bibliothek auf Stufe `trace`; das kostet Rechenzeit und gehört deshalb nicht in den Dauerbetrieb.
- Von jedem ausgehenden Knoten bleibt nur die **Art**: Tag, `type`, `xmlns` (z. B. `receipt:inactive`, `iq:get:usync`, `presence:unavailable`). Text, Kennungen, Nummern und Namen werden verworfen, nie gespeichert oder geloggt. Ein Test belegt das (`test/nodeCounter.test.ts`).
- Ausgabe: im Journal je Art eine Zeile `lib_node_out` mit `kind` und `n` (Summe seit Prozessstart), alle 10 Minuten und beim Beenden. Auswerten: `journalctl -u waread-ingest -o cat | grep lib_node_out`.
- **Grenzen:** Gezählt wird nur, was die Bibliothek über ihren Knoten-Pfad schickt (`logger.trace({ xml, msg: 'xml send' })`, `socket.ts:160-161`). Rohframes (Handshake, Anmeldung) zählt er nicht. Bei einer anderen Bibliotheksversion kann dieser Pfad anders heißen; dann zählt der Zähler stillschweigend nichts. **Prüfe deshalb, dass nach dem Start überhaupt Zeilen erscheinen** (der Ping zählt nicht dazu, siehe oben; ein Receipt oder `iq:get:encrypt` erscheint schon beim Verbinden).
- Der Zähler misst, **was** gesendet wird, nicht wie WhatsApp es bewertet.

## Optionen, die waread setzt

`markOnlineOnConnect: false` (sonst typlose Receipts und `available`), `syncFullHistory: false`, `generateHighQualityLinkPreview: false`, `getMessage: async () => undefined`, `browser: Browsers.ubuntu('Chrome')`. Alle anderen Optionen stehen auf dem Standard der Bibliothek.
