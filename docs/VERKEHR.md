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

Lesebestätigung (blaue Haken), „abgespielt“, Tippanzeige, Nachrichten, Gruppenabfragen, Profilabfragen außer dem Profilbild (siehe unten), Abmelden (`logout`), Statusabfragen, Anruf-Ablehnung. Die Hülle reicht von der Bibliothek nur `ev.on`, `ev.off` und `end` durch. Das schließt **nicht** aus, dass die Bibliothek diese Funktionen intern selbst aufruft; im gelesenen Quelltext tut sie es für die Lese-/Abgespielt-Bestätigung nicht automatisch.

## Was waread nur auf Wunsch auslöst

| Wann | Was | Schalter |
| --- | --- | --- |
| Chat in der Oberfläche geöffnet, letzte Abfrage für diesen Chat älter als `profile_pictures_interval_days` (Standard 7) | eine Profilbild-Abfrage `iq type=get xmlns=w:profile:picture` (`chats.ts`, `profilePictureUrl`), bei sichtbarem Bild dazu ein HTTPS-GET an `pps.whatsapp.net`; mindestens 5 s Abstand, höchstens 100 am Tag, nach 429 ruht der Abruf 24 h | `profile_pictures = true` (ab Werk **aus**), `docs/PROFILBILDER.md` |
| „Medium jetzt laden“ oder Schild an einem ladbaren Medium | ein HTTPS-GET an den Medienhost je Medium | Tipp in der Oberfläche, `docs/VERSION2.md` |
| Einmal-Medien bei Ankunft | ein HTTPS-GET je Einmal-Medium | `store_view_once = true` (ab Werk aus) |

Die Profilbild-Abfrage ist die einzige Anfrage über die WhatsApp-Verbindung, die waread selbst stellen kann. Der Wächter lässt sie nur in `waLib.ts` zu (`WALIB_ONLY_NAMES`), sonst bleibt `profilePictureUrl` verboten.

## Messen statt raten: Zähler für ausgehende Knoten

Für die Testinstanz mit Zweitnummer gibt es einen Zähler (`count_outgoing_nodes = true` in `[ingest]` von `config.toml`; ab Werk **aus**).

- Er hängt am Logger der Bibliothek. Dafür läuft die Bibliothek auf Stufe `trace`; das kostet Rechenzeit und gehört deshalb nicht in den Dauerbetrieb.
- Von jedem ausgehenden Knoten bleibt nur die **Art**: Tag, `type`, `xmlns` (z. B. `receipt:inactive`, `iq:get:usync`, `presence:unavailable`). Text, Kennungen, Nummern und Namen werden verworfen, nie gespeichert oder geloggt. Ein Test belegt das (`test/nodeCounter.test.ts`).
- Ausgabe: im Journal je Art eine Zeile `lib_node_out` mit `kind` und `n` (Summe seit Prozessstart), alle 10 Minuten und beim Beenden. Auswerten: `journalctl -u waread-ingest -o cat | grep lib_node_out`.
- **Grenzen:** Gezählt wird nur, was die Bibliothek über ihren Knoten-Pfad schickt (`logger.trace({ xml, msg: 'xml send' })`, `socket.ts:160-161`). Rohframes (Handshake, Anmeldung) zählt er nicht. Bei einer anderen Bibliotheksversion kann dieser Pfad anders heißen; dann zählt der Zähler stillschweigend nichts. **Prüfe deshalb, dass nach dem Start überhaupt Zeilen erscheinen** (der Ping zählt nicht dazu, siehe oben; ein Receipt oder `iq:get:encrypt` erscheint schon beim Verbinden).
- Der Zähler misst, **was** gesendet wird, nicht wie WhatsApp es bewertet.

## Optionen, die waread setzt

`markOnlineOnConnect: false` (sonst typlose Receipts und `available`), `syncFullHistory: false`, `generateHighQualityLinkPreview: false`, `getMessage: async () => undefined`, `browser: Browsers.ubuntu('Chrome')`. Alle anderen Optionen stehen auf dem Standard der Bibliothek.

## Version 2: was dazukommt (und was nicht)

Stand: 29. Oktober 2026. Keine der Änderungen sendet einen neuen Knoten über den WebSocket. Gesichert ist das nur für den **eigenen** Code (der Wächter `check:no-send` ist unverändert grün, die Hülle `waLib.ts` reicht weiter nur `ev.on`, `ev.off` und `end` durch). Was die Bibliothek selbst sendet, bleibt wie oben beschrieben.

| Funktion | Verkehr | Beleg |
| --- | --- | --- |
| `messages.update` (gelöscht, bearbeitet) | **keiner zusätzlich.** Die Bibliothek erzeugt das Ereignis lokal, wenn sie die Löschung oder Bearbeitung als ohnehin zugestellte Nachricht verarbeitet. Die Quittung je empfangener Fremdnachricht (siehe oben) geht auch ohne waread-Code raus. | `node_modules/baileys/lib/Utils/process-message.js:298-305` (REVOKE), `:364-372` (MESSAGE_EDIT), gelesen, nicht ausgeführt |
| Zitat-Kurztext, `@Name`, Versionen, Schild, Stumm, Formatierung | keiner. Es sind Felder der ohnehin empfangenen Nachricht und lokale Zustände. | Quelltext |
| Einmal-Probe (`viewonce_probe`, Stufe 1) | keiner (nur Journalzeile mit Ja/Nein-Werten). | Quelltext, Test `v2.test.ts` |
| **„Medium jetzt laden“** | **ein HTTPS-Abruf an den Medienhost je Medium**, ausgelöst vom Ingest auf Befehl des Web-Dienstes (der Web-Dienst selbst bleibt ohne ausgehenden Verkehr). Auch das Setzen des Schilds an einer Nachricht mit ladbarem Medium löst einen aus. Kein WebSocket-Knoten (wie jeder Medien-Download); `downloadContentFromMessage` ist nicht auf versteckte Sendeaufrufe geprüft. Ein abgelaufener Link endet mit HTTP 403/404/410 und wird als „bei WhatsApp nicht mehr verfügbar“ vermerkt. Die „Neu-Upload-Anfrage“ an das Telefon wird weiter nie gestellt. | `services/ingest/src/mediaQueue.ts` (`loadDeferred`) |
| **Einmal-Medien speichern** (`store_view_once = true`, Standard aus) | ein HTTPS-Abruf je Einmal-Medium **bei Ankunft**, wie beim Auto-Download. Ob dem Absender dabei etwas angezeigt wird: UNBEKANNT. | `services/ingest/src/messageHandler.ts` |

Für Einmal-Medien ohne Zweitnummer: Stufe 1 (nur lesen, kein Verkehr) zuerst auswerten (`docs/VERSION2.md`, Abschnitt 3), bevor der Schalter eingeschaltet wird. Mit der Testinstanz und dem Knotenzähler (`count_outgoing_nodes`) lässt sich zusätzlich messen, ob dabei etwas anderes als der HTTPS-Abruf ausgesendet wird.
