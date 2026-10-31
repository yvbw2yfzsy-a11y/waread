# SECURITY_TESTS – Lesebestätigungs- und Sicherheitsprüfung

Stand: Oktober 2026 · Gilt für: waread (Node.js/TypeScript, Baileys)

## 0. Worum es geht

waread darf gegenüber WhatsApp **selbst nie etwas senden**. Die Bibliothek (Baileys) sendet dagegen unvermeidlich einiges mit, was beim Empfang und bei jeder Verbindung anfällt: Empfangsquittungen (bei waread vom Typ `inactive`, nicht die typlose Zustellung), Prekey-Uploads, Init-Abfragen, ein `presence unavailable` beim Öffnen und mehr. Die vollständige Liste mit Quellen und Einschränkungen steht in `docs/VERKEHR.md`. Aus dem Code folgt: keine Lesebestätigung (blaue Haken), kein „abgespielt“ (blaues Mikrofon), keinen bewusst gesetzten Online-Status, keine Tippanzeige, keine Nachrichten.

Diese Zusage kommt aus dem Code: Die dafür nötigen Aufrufe sind nicht vorhanden. Das ist belastbar, aber **kein Versprechen von WhatsApp**. Ein Fehler in der Bibliothek, ein verändertes Standardverhalten nach einem Update oder ein Protokollwechsel könnten es ändern. Deshalb gibt es drei Prüfschichten:

| Schicht | Was | Wie oft | Aufwand |
| --- | --- | --- | --- |
| 1. Vorab-Checkliste („Gate“) | Code-Scan auf verbotene WhatsApp-Aufrufe, Abhängigkeiten, automatisierte Tests | bei jedem Build und vor jedem Einspielen einer Version | Minuten, automatisiert |
| 2. Zweitnummer-Test | Echtprüfung mit zwei Konten: Sieht der Absender wirklich nur „zugestellt“? | siehe Abschnitt 3 | etwa 30 Minuten, manuell |
| 3. Sicherheits-Baseline | Rechte, systemd-Härtung, Netzbindung, Login, Header, Logs | bei Installation und nach Änderungen an Deployment oder Web-Dienst | etwa 30 Minuten |

**Wichtig:** Kein Teil dieser Prüfungen ersetzt die anderen. Der Code-Scan findet nur, was im eigenen Quellcode steht. Der Zweitnummer-Test findet auch Verhalten, das in der Bibliothek steckt, ist aber nur eine Stichprobe.

### Begriffe

| Begriff | Bedeutung |
| --- | --- |
| **Konto A** | Die Testnummer. Ist als verknüpftes Gerät mit dem Pi (bzw. der Testinstanz) gekoppelt. |
| **Konto B** | Ein zweites Handy mit eigenem WhatsApp-Konto. Es ist der „Absender“ und beobachtet, was bei ihm ankommt. |
| **Hauptkonto** | Dein eigenes Konto. Kommt erst nach bestandenem Test ins Spiel. |
| **Testinstanz** | Eine waread-Installation, die nur mit Konto A gekoppelt ist (der Pi in der Testphase, später ein separater Aufbau, siehe 3.2). |

---

## 1. Vorab-Checkliste („Gate“)

Das Gate muss **vollständig grün** sein, bevor (a) der Zweitnummer-Test beginnt und (b) eine Version auf dem Pi aktiviert wird, die Ingest-Code oder Abhängigkeiten ändert. Eine rote Zeile bricht ab.

| Nr. | Prüfung | Bestanden, wenn |
| --- | --- | --- |
| G1 | **Code-Scan auf verbotene WhatsApp-Aufrufe**: `npm run check:no-send`, siehe 1.1 | Exit-Code 0, 34 von 34 Prüfungen grün (Quellcode von `services/ingest/src`; einzige Ausnahme: die Profilbild-Abfrage in `waLib.ts`, siehe `docs/PROFILBILDER.md`); zusätzlich die Gegenprobe mit `grep` über das gebaute Ergebnis |
| G2 | **Verhaltenstest „Fake-Verbindung“**: `npm test -w waread-ingest` (u. a. `test/waLib.test.ts` und `test/service.e2e.test.ts`, siehe [TEST_CHECKLIST.md](TEST_CHECKLIST.md), Abschnitt F) | grün; die Hülle reicht nur `ev.on`, `ev.off`, `end` und die Profilbild-Abfrage (`profilePicture`) des Sockets durch, die Verbindungsoptionen stimmen |
| G3 | **Abhängigkeiten festgeschrieben und unverdächtig**, siehe 1.2 | `package-lock.json` vorhanden, Paket `baileys` mit exakter Version, kein Fremd-Fork |
| G4 | **Änderungen der Bibliothek angesehen** (nur bei Bibliotheksupdate) | Release-Notes und Unterschied der Lock-Datei gelesen; besonders auf neue Standardwerte bei Verbindungsoptionen und automatisch gesendete Meldungen geachtet |
| G5 | **Verbindungsoptionen unverändert** | Der Teil des Ingest-Codes, der die Verbindung zur Bibliothek aufbaut (`createSocket` in `services/ingest/src/waLib.ts`, dort u. a. `markOnlineOnConnect: false`), unterscheidet sich nicht von der zuletzt bestandenen Prüfung – oder die Änderung ist begründet und dokumentiert |
| G6 | **Automatisierte Tests insgesamt grün** | `npm test` im Projektordner besteht (db, ingest, web, cleanup); übersprungene Tests sind sichtbar und begründet. Weitere Zeilen: [TEST_CHECKLIST.md](TEST_CHECKLIST.md) |

### 1.1 Wie der Code-Scan eingebunden ist

Der Scan ist der Test `services/ingest/test/no-send-calls.test.ts` (Hilfscode: `test/support/scanForbidden.ts`). Aufruf im Projektordner:

```bash
npm run check:no-send        # Exit-Code 0 = bestanden; ungleich 0 = Fund oder Fehler
```

Er prüft per Syntaxbaum (AST) **jeden Bezeichner und jeden bezeichnerartigen String** in `services/ingest/src/` und schlägt fehl, wenn ein Wort `read`, `presence` oder `send` darin vorkommt oder der Name auf einer Liste ausgehender Bibliotheksfunktionen steht (z. B. `logout`, `query`, `groupMetadata`, `chatModify`). Einzige Ausnahme: `readFileSync` (lokale Dateien, kein WhatsApp-Bezug). Zusätzlich prüft er, dass die Hülle `waLib.ts` nur `ev.on`, `ev.off` und `end` vom Socket benutzt und dass nur `waLib.ts` die Bibliothek einbindet.

| Stelle | Wann | Wirkung bei Fund | Stand |
| --- | --- | --- | --- |
| **1. Normaler Testlauf** | `npm test` (Projektordner) bzw. `npm test -w waread-ingest` | Testlauf schlägt fehl | umgesetzt |
| **2. Beim Bauen** | `npm run build` führt vor dem Übersetzen des Ingest-Dienstes `prebuild` aus, das den Scan startet | Bau bricht mit Exit-Code 1 ab, bevor übersetzt wird; ohne erfolgreichen Bau entsteht keine Release | umgesetzt und mit einer absichtlichen Sabotage-Probe geprüft |
| **3. Auf dem Pi vor dem Umschalten** | gegen `/opt/waread/releases/<version>/` | – | **nicht automatisiert.** `waread-update` führt keinen Scan aus, und im Release fehlen `typescript` und `tsx` (`npm run prune:prod`), die der Test braucht. Auf dem Pi bleibt nur die grobe Gegenprobe mit `grep` (siehe unten). Das Tor des Updaters betrifft nur die Version von `baileys` (MAINTENANCE.md, 5.1). |

Hinweise:

- **Gebautes Ergebnis.** Was auf dem Pi läuft, ist das gebaute JavaScript. Der AST-Scan prüft den Quelltext; weil das Ergebnis aus genau diesem Quelltext übersetzt wird und `prebuild` vor jedem Bau läuft, ist beides gekoppelt. Eine direkte Prüfung von `dist/` leistet nur die `grep`-Gegenprobe.
- **Nur eigenen Code prüfen, nicht `node_modules`.** Die Bibliothek *definiert* die verbotenen Funktionen naturgemäß. Entscheidend ist, dass **unser** Code sie nicht aufruft.
- **Umfang.** Der Scan deckt `services/ingest/src` ab. Der Web-Dienst, der Cleanup und die Datenbankschicht haben keinen Zugang zur WhatsApp-Bibliothek; das prüft B11 (Abschnitt 5), nicht der Scan.
- **Ein roter Scan wird nie „übersteuert“.** Ist ein Fund ein Fehlalarm, wird die Regel in `scanForbidden.ts` (mit Begründung) angepasst, nicht der Scan übersprungen.
- **Grenze, ehrlich benannt:** Ein statischer Scan sieht nicht, was die Bibliothek (Baileys) **intern** an WhatsApp sendet, z. B. Zustellquittungen, Verbindungs- und Schlüsselverkehr. Dafür gibt es die Hülle mit Freigabeliste, den Verhaltenstest G2 und den Zweitnummer-Test. Auch dynamisch zusammengesetzte Aufrufe wie `sock[name](…)` lassen sich nicht in jedem Fall erkennen; die Hülle gibt dem restlichen Code den rohen Socket aber gar nicht erst in die Hand.
- **Der Namens-Scan ist ein Hilfsnetz, nicht die tragende Schicht (F18).** Eine Prüfung mit 36 Umgehungsversuchen ließ den Namens-Scan allein bei 22 durch. Tragend ist die **Hülle** (`checkShell`: der rohe Socket wird nur als `raw.ev.on`, `raw.ev.off`, `raw.end` benutzt, `WaSocket` hat genau `ev` und `end`) zusammen mit der **aufzeichnenden Socket-Attrappe** der Tests: Sie meldet jeden Zugriff auf den Socket außer `ev.on`, `ev.off` und `end` (z. B. `sendPresenceUpdate`) und lässt Tests daran scheitern, statt dass ein `TypeError` von einem Fangnetz geschluckt wird.

**Sabotage-Probe (einmal pro Scan-Änderung und einmal pro Quartal):** In einer **Wegwerfkopie** (nie im echten Projektordner) absichtlich einen verbotenen Aufruf einfügen und prüfen, dass der Scan rot wird:

```bash
PROBE=$(mktemp -d) && cp -a . "$PROBE/waread" && cd "$PROBE/waread"
printf '\nexport const probe = (s: any) => s.readMessages([])\n' >> services/ingest/src/timing.ts
npm run check:no-send; echo "Exit-Code: $?"     # erwartet: ungleich 0, genau eine Prüfung rot
npm run build -w waread-ingest; echo "Exit-Code: $?"   # erwartet: 1, Bau bricht ab
cd - && rm -rf "$PROBE"
```

Ein Scan, der nie rot werden kann, ist wertlos. (Stand dieser Lieferung: die Probe wurde mit genau diesem Aufruf ausgeführt, siehe `docs/MERGE_NOTES.md`.)

**Notbehelf (ersetzt den Scan nicht):** Falls der Scan einmal nicht verfügbar ist, kann folgende grobe Gegenprobe im Projektordner laufen. Die Namen sind Baileys-Funktionen nach heutigem Kenntnisstand; bei jedem Bibliotheksupdate gegen die tatsächliche API prüfen. Die Liste ist **nicht vollständig**.

```bash
grep -RInE '(readMessages|sendReceipt|sendReceipts|sendPresenceUpdate|presenceSubscribe|sendMessage|relayMessage|chatModify|markOnlineOnConnect|ws\.send)' \
  services/ db/ cleanup/ --include='*.ts' --include='*.js' --exclude-dir=node_modules --exclude-dir=test
```

Jeder Treffer muss erklärbar sein. Erwartet sind genau zwei Treffer, beide `markOnlineOnConnect: false`: `services/ingest/src/waLib.ts` und `services/ingest/dist/waLib.js`. Alles andere ist ein Befund.

### 1.2 Abhängigkeiten prüfen

Im Projektordner (dort liegt das Wurzel-`package.json` der Workspaces):

```bash
# Baileys: genau die erwartete Version, aus dem Original-Paket
npm ls baileys

# In services/ingest/package.json steht die Version ohne ^ oder ~ (fest)
grep -n '"baileys"' services/ingest/package.json

# Bekannter Schadfall (Fork "lotusbail") darf nicht vorkommen
npm ls --all 2>/dev/null | grep -i lotusbail && echo "STOPP: lotusbail gefunden" || echo "ok: nicht enthalten"
```

Erwartung: Das Paket heißt exakt `baileys`; die Version entspricht der letzten bestandenen Prüfung (oder dem bewusst geprüften Update). Im Lieferstand steht dort `7.0.0-rc14`. **Diese Version habe ich nicht gegen die Registry geprüft** (in der Bauumgebung war die npm-Registry gesperrt); prüfe sie vor dem ersten Bau selbst. Installiert wird auf dem Build-Rechner ausschließlich mit `npm ci`, nie mit `npm update`. **`package-lock.json` liegt dieser Lieferung nicht bei:** der erste `npm install` erzeugt sie; danach gehört sie in die Versionsverwaltung, und ab dann gilt `npm ci`. Hintergrund: Das Konzept nennt manipulierte Baileys-Forks als reales Risiko.

---

## 2. Voraussetzungen für den Zweitnummer-Test

Der Test ist nur aussagekräftig, wenn die Ausgangslage stimmt. Falsche Einstellungen führen zu einem **falsch-positiven Ergebnis** („bestanden“, obwohl blaue Haken gar nicht sichtbar gewesen wären). Deshalb vor dem Start alles abhaken:

- [ ] **Konto A** ist über den QR-Code mit der Testinstanz verknüpft; Status in waread: „verbunden“.
- [ ] **Konto A:** *Einstellungen → Datenschutz → Lesebestätigungen* ist **AN**. (Ist sie AUS, wären bei Einzelchats blaue Haken ohnehin unterdrückt, und eine versehentliche Lesebestätigung bliebe unentdeckt.)
- [ ] **Konto A:** *Datenschutz → Zuletzt online & Online* steht auf **Alle** (für „Zuletzt online“ und „Wer kann sehen, wenn ich online bin“). Sonst bleibt eine Online-Anzeige für B unsichtbar.
- [ ] **Konto B:** *Lesebestätigungen* ist **AN**. (Ist sie AUS, sieht B auch bei anderen keine blauen Haken.)
- [ ] **Das Handy von A bleibt unberührt:** WhatsApp wird dort während des Tests nicht geöffnet, der Chat mit B nicht angesehen, keine Benachrichtigung angetippt. Sonst sieht B echte blaue Haken – und der Test ist wertlos. Bildschirm gesperrt lassen.
- [ ] **Handy von B** hat WhatsApp und eine stabile Verbindung; Bildschirm bleibt während der Beobachtung an.
- [ ] **Gate G1–G6** (Abschnitt 1) ist grün.
- [ ] Ein Zettel oder eine Kopie der Protokollvorlage (Anhang A) liegt bereit.

> Konto B kann auch ein Handy mit WhatsApp Business sein. Entscheidend ist nur, dass B die Nachrichteninfo (Zugestellt / Gelesen / Abgespielt) sehen kann.

---

## 3. Durchführung: Schritt für Schritt

### 3.1 Der Ablauf

**Schritt 1 – Ausgangslage festhalten**

Auf dem Pi:

```bash
readlink /opt/waread/current              # waread-Version
systemctl is-active waread-ingest waread-web
npm ls baileys                            # im Projektordner bzw. im Release-Ordner /opt/waread/current
```

Notiere Version, Uhrzeit und den Anlass (Erstinbetriebnahme, Neustart, Wiederverbindung, Bibliotheksupdate …). In waread: Status „verbunden“.

**Schritt 2 – Positivkontrolle (macht den Test aussagefähig)**

1. B schickt an A einen kurzen Text („Kontrolle“) und eine Sprachnachricht.
2. Nimm **das echte Handy von A**, öffne den Chat mit B und spiele die Sprachnachricht ab.
3. B muss jetzt **blaue Haken** und ein **blaues Mikrofon** sehen.
4. Danach auf dem Handy von A: Chat verlassen, WhatsApp vollständig schließen, Bildschirm sperren.

Sieht B hier **keine** blauen Haken, ist eine der Lesebestätigungs-Einstellungen falsch. Test abbrechen, Einstellungen korrigieren, bei Schritt 2 neu beginnen. Ein „nur graue Haken“-Ergebnis wäre sonst bedeutungslos.

**Schritt 3 – Testnachrichten senden (B → A)**

Schreibe in jede Nachricht eine erkennbare Kennung, z. B. `T1`, `T2` …, damit du sie auf B später zuordnen kannst.

| Kennung | Nachricht | Kommentar |
| --- | --- | --- |
| T1 | Text im Einzelchat | |
| T2 | Foto mit Bildunterschrift | |
| T3 | Sprachnachricht, mindestens 10 Sekunden | lang genug, dass „abgespielt“ klar erkennbar wäre |
| T4 | B legt eine Gruppe „waread-test“ mit A an und schreibt dort einen Text | Falls WhatsApp mehr als zwei Mitglieder verlangt, ein drittes Konto hinzufügen |
| T5 | Sprachnachricht in der Gruppe | Gruppen haben eigene Lese-Logik |
| T6 *(erweitert)* | Dokument (z. B. PDF) und kurzes Video | Diese werden erst auf Tipp geladen – anderer Codepfad |
| T7 *(erweitert)* | Antwort auf eine Nachricht, eine Reaktion (Emoji), eine bearbeitete und eine „für alle gelöschte“ Nachricht | kommen als Ereignisse an |

**Schritt 4 – In waread alles bedienen, was ein Nutzer tun kann**

Öffne waread auf dem iPhone oder am Rechner und gehe alles durch. Das Ziel ist, **jeden Codepfad auszulösen**, der Anzeigen, Abspielen oder Speichern berührt:

- Chat-Liste ansehen, den Chat mit B öffnen (Text wird nach etwa einer Sekunde im sichtbaren Bereich lokal „gesehen“).
- Foto antippen, Vollbild, wischen, zoomen, **speichern** (Zu Fotos hinzufügen bzw. Download-Knopf).
- Sprachnachricht **bis zum Ende abspielen**, Tempo 1,5x und 2x, vor- und zurückspulen.
- Gruppe öffnen, Sprachnachricht in der Gruppe abspielen.
- Bei T6: Dokument und Video auf Tipp laden und öffnen bzw. herunterladen.
- „Alle als gesehen“ drücken.
- Eine Volltextsuche ausführen und einen Treffer öffnen.
- Einstellungen → Verbindung ansehen.
- Browser-Tab in den Hintergrund legen und wieder öffnen (Live-Kanal verbindet neu).

Prüfe in waread selbst: „neu“ (gelb) verschwindet, „angehört“ wechselt – **rein lokal**.

Notiere die **Uhrzeit des letzten Bedienschritts**. Ab jetzt läuft die Wartezeit.

**Schritt 5 – Zehn Minuten warten**

Nichts mehr bedienen. Der Zeitraum ist bewusst lang, damit auch verzögerte oder gesammelt gesendete Meldungen (Zeitgeber, Stapelverarbeitung) sichtbar werden.

Auf B: Chat mit A geöffnet lassen, Bildschirm an. Alle paar Minuten die Kopfzeile ansehen: Steht dort **„online“** oder **„schreibt …“ / „nimmt Sprachnachricht auf …“**? Das darf nicht vorkommen.

**Schritt 6 – Auf B auswerten**

Für jede Testnachricht auf B: Nachricht gedrückt halten bzw. antippen → **Info**. Erwartung:

| Nachricht | Erwartet auf B | **Durchgefallen**, wenn … |
| --- | --- | --- |
| T1 Text | zwei **graue** Haken; Info: „Zugestellt“ mit Zeit, „Gelesen“ leer | blaue Haken oder „Gelesen“ mit Zeit |
| T2 Foto | wie T1 | blaue Haken oder „Gelesen“ |
| T3 Sprachnachricht | **graues** Mikrofon, graue Doppelhaken; Info: „Zugestellt“, **„Abgespielt“ leer** | blaues Mikrofon oder „Abgespielt“ mit Zeit |
| T4 Gruppentext | Info: A unter „Zugestellt an“, **nicht** unter „Gelesen von“ | A erscheint unter „Gelesen von“ |
| T5 Gruppen-Sprachnachricht | A nur unter „Zugestellt“, nicht unter „Abgespielt von“ | A erscheint unter „Abgespielt von“ |
| T6/T7 (falls gesendet) | nur Zustellung | jegliche Lese-/Abspielanzeige |
| Kopfzeile von A auf B | weder „online“ noch „schreibt …“ in den zehn Minuten | eines von beiden erscheint |

**Jeder einzelne Fund = durchgefallen.** Es gibt keinen Teilerfolg.

**Schritt 7 – Zusatzbeobachtung: Benachrichtigungen (kein Bestehens-Kriterium)**

Das Konzept nennt als offenen Punkt, ob eine Verbindung als verknüpftes Gerät die Benachrichtigungen auf dem Telefon beeinflusst. Sende von B eine weitere Nachricht, während das Handy von A gesperrt ist, und beobachte, ob auf A **weiterhin eine Benachrichtigung** erscheint. Notiere das Ergebnis im Protokoll. Das ist ein Komfort-Befund, kein Lesebestätigungs-Befund; er entscheidet über die Verbindungsoptionen (siehe G5).

**Schritt 8 – Optional: Zählung ausgehender Meldungsarten**

Das Konzept sieht vor, dass der Dienst jede ausgehende Meldungsart mitzählt. Diese Umsetzung hat dafür einen **Zähler für die Testinstanz** (`count_outgoing_nodes = true`, ab Werk aus; Beschreibung, Ausgabe und Grenzen in `docs/VERKEHR.md`). Er zählt nur die Art der Knoten (nie Inhalte) und schlägt **keinen Alarm**: Die Bibliothek sendet unvermeidlich mehr als die Empfangsquittung, ein Alarm bei „allem anderen“ würde ständig auslösen. Schalte ihn für die Zweitnummer-Prüfung ein, werte die Zeilen `lib_node_out` aus und trage die gezählten Arten ins Protokoll ein. Erscheinen nach dem Start keine Zeilen, zählt der Zähler nicht (andere Bibliotheksversion?), dann trage „nicht verfügbar“ ein – keine Scheinprüfung. Das ist eine bekannte Lücke; sie ist der Grund, warum der Zweitnummer-Test unverzichtbar bleibt.

**Schritt 9 – Protokollieren**

Vorlage in Anhang A ausfüllen und ablegen (nicht in einem öffentlichen Repository, siehe unten). Ergebnis: **BESTANDEN**, **DURCHGEFALLEN** oder **UNGÜLTIG** (eine Voraussetzung aus Abschnitt 2 wurde verletzt, z. B. A hat den Chat geöffnet).

### 3.2 Wann der Test läuft

Der Test läuft **immer gegen die Testinstanz mit Konto A**, nie gegen das Hauptkonto: Am Hauptkonto lässt sich ein Fehlverhalten nicht zurücknehmen (ein blauer Haken ist nicht widerrufbar).

| Auslöser | Besonderheit im Ablauf |
| --- | --- |
| **Erstinbetriebnahme** | Vollständig, **bevor** das Hauptkonto gekoppelt wird. |
| **Nach Neustart** | Zuerst `sudo systemctl restart waread-ingest`, danach (separat) ein Neustart des Pi mit `sudo reboot`. Jeweils warten, bis „verbunden“ angezeigt wird, dann Schritte 2–9. Zusätzlich: Dienst stoppen, B sendet T1 und T3, Dienst starten – so wird die **Nachlieferung** nach einer Pause mitgeprüft (ein eigener Codepfad). |
| **Nach Wiederverbindung** | Verbindungsabbruch bewusst herbeiführen (INSTALL.md, Abschnitt 12), B sendet **während** des Abbruchs T1 und T3, danach Verbindung wiederherstellen und Schritte 2–9. Nachgelieferte Nachrichten gehören in die Auswertung. |
| **Vor jedem Update der Bibliothek** | Gate (Abschnitt 1), dann Test mit der **neuen** Version in der Testinstanz (siehe unten). Erst bei „bestanden“ wird die Version auf dem Produktivsystem aktiviert. |
| **Nach Rücksprung auf eine alte Version** | Nur, wenn sich dabei die Bibliotheksversion ändert. |
| **Empfehlung: regelmäßig** | Etwa vierteljährlich und nach größeren WhatsApp-App-Updates auf dem Telefon, weil sich Protokollverhalten ändern kann, ohne dass sich dein Code ändert. (Empfehlung dieser Anleitung, kein Wert aus dem Konzept.) |

**Testinstanz bei laufendem Hauptkonto.** Sobald das Hauptkonto am Pi hängt, darf die Testversion **nicht** dieselben Sitzungsdaten nutzen (nur eine Verbindung pro Sitzung, sonst drohen Abmeldungen). Zwei saubere Wege:

1. **Separater Rechner** (Linux/macOS mit Node.js) mit eigener Installation und eigener, mit Konto A gekoppelter Sitzung.
2. **Zeitweise Umstellung des Pi auf Konto A** (Hauptkonto abmelden, Sitzungsdaten leeren, Konto A koppeln; Vorgehen siehe INSTALL.md, Abschnitt 10, Unterpunkt „Kontowechsel“). Aufwändiger, weil danach das Hauptkonto neu gekoppelt werden muss.

**Niemals** den Ordner `/var/lib/waread/auth/` kopieren oder auf einen anderen Rechner übertragen. Pfade (`[paths]`) und Port (`[web] port`) sind in `config.toml` einstellbar, und die Umgebungsvariable `WAREAD_CONFIG` wählt eine andere Konfigurationsdatei. Ein Zweitaufbau auf demselben Pi wurde **nicht** ausprobiert (zwei Instanzen teilen sich sonst Units und Pfade); der separate Rechner ist der einfachere Weg.

---

## 4. Bei Durchfall

1. **Sofort stoppen:** `sudo systemctl stop waread-ingest`.
2. **Gerät abmelden:** Am Handy von A *Einstellungen → Verknüpfte Geräte* → den Pi abmelden.
3. **Hauptkonto nicht koppeln.** Läuft bereits eine Version mit dem Hauptkonto, die durchgefallen ist: ebenfalls stoppen und am Handy abmelden. Bereits gesendete blaue Haken lassen sich nicht zurücknehmen.
4. **Befund dokumentieren:** Welche Nachricht, welche Anzeige, Version, Bibliotheksversion, Uhrzeit.
5. **Ursache eingrenzen:** Gate-Ergebnis erneut ansehen; Unterschied zur letzten bestandenen Version (Ingest-Code, Verbindungsoptionen, Bibliothek, Lock-Datei).
6. **Beheben oder zurückrollen** (INSTALL.md, Abschnitt 15). Danach den **vollständigen** Test wiederholen.
7. Wenn ein Fund auf Bibliotheksverhalten zurückgeht, das nicht abstellbar ist, ist das Projekt in dieser Konfiguration nicht freizugeben. Die Alternative laut Konzept ist ein Wechsel der Bibliothek mit denselben Tests.

---

## 5. Sicherheits-Baseline-Prüfung

Zum Abhaken nach der Installation und nach Änderungen am Deployment. Platzhalter: `<BASIS>` = `http://<Pi-IP>/waread` (über Nginx) bzw. `http://127.0.0.1:8780` (direkt am Dienst; Port = `[web] port`).

> **Feste Werte aus `services/web/routes.md`:** Login `POST <BASIS>/api/login` mit JSON `{"password":"…"}`; Cookie `waread_session`; geschützte Routen antworten ohne Sitzung mit `401 {"error":"unauthorized"}`; Medien unter `<BASIS>/api/media/<messageId>` (Vorschau: `?thumb=1`). Standard-Port des Web-Dienstes: **8780** (Festlegung dieses Pakets, in `config.toml` unter `[web] port` änderbar).
>
> **Hinweis zum Cookie-Pfad:** `cookie_path` steht in `config/config.example.toml` (und damit in einer frisch angelegten `config.toml`) auf `/waread/`; der Standard im Code wäre `/`. Prüfungen mit Cookie (B5, B7) laufen deshalb über Nginx (`http://<Pi-IP>/waread`). Direkt gegen `127.0.0.1:8780` sendet `curl -b` das Cookie nicht mit, weil der Pfad nicht passt.

### B1 – Systembenutzer

```bash
getent passwd waread            # Shell: /usr/sbin/nologin (oder /bin/false)
sudo passwd -S waread           # zweites Feld "L" (gesperrt) oder "NP"
sudo -u waread touch /etc/waread-schreibtest 2>&1    # erwartet: Permission denied
```

### B2 – Dateirechte

```bash
sudo stat -c '%a %U:%G %n' /etc/waread/config.toml /var/lib/waread /var/lib/waread/auth
sudo find /var/lib/waread/auth -type f ! -perm 0600      # erwartet: keine Ausgabe
sudo find /var/lib/waread/auth -type d ! -perm 0700      # erwartet: keine Ausgabe
sudo -u nobody cat /var/lib/waread/db/waread.db 2>&1 | head -n 1   # erwartet: Permission denied
```

Erwartet: `config.toml` 640, `/var/lib/waread` 700, Dateien in `auth/` 600, Verzeichnis 700.

### B3 – systemd-Härtung

```bash
for u in waread-ingest waread-web waread-cleanup waread-cleanup-vacuum; do
  echo "== $u"
  systemctl show "$u.service" -p User -p NoNewPrivileges -p ProtectSystem -p ProtectHome \
    -p PrivateTmp -p ReadWritePaths -p MemoryMax -p Nice -p IOSchedulingClass
done
systemctl show waread-web.service -p IPAddressDeny -p IPAddressAllow
systemctl show waread-cleanup.service -p IPAddressDeny
```

Erwartet für **alle vier**: `User=waread`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `ReadWritePaths=/var/lib/waread`, `MemoryMax` eine Zahl (nicht `infinity`; Soll: Ingest 512M, Web 256M, Cleanup und VACUUM 256M, jeweils in Byte ausgegeben). `Nice=15` und `IOSchedulingClass=idle` (bzw. `3`) für Ingest, Cleanup und VACUUM. Optional als Orientierung: `systemd-analyze security waread-web.service`.

**Kein ausgehender Verkehr für den Web-Dienst** (Vorgabe des Konzepts): `waread-web.service` setzt `IPAddressDeny=any` und `IPAddressAllow=localhost`, Cleanup und VACUUM setzen `IPAddressDeny=any`. Erwartet: `IPAddressDeny` ist nicht leer, `IPAddressAllow` des Web-Dienstes enthält Loopback (`127.0.0.0/8`). Wie `systemctl show` die Schlüsselwörter `any` und `localhost` ausgibt, habe ich nicht geprüft. **Diese Direktiven sind nicht auf einem Pi getestet.** Funktionsprobe: `curl -s http://127.0.0.1:8780/healthz` antwortet, und `http://<Pi-IP>/waread/` lädt über Nginx. Antwortet Nginx mit 502, zuerst die zwei Zeilen in `waread-web.service` entfernen (siehe `deploy/README.md`). Der Ingest-Dienst hat bewusst keine IP-Sperre; er muss zu WhatsApp verbinden.

### B4 – Netzbindung

```bash
sudo ss -ltnp | grep -E ':8780\b'      # erwartet: 127.0.0.1:8780, NICHT 0.0.0.0 oder [::]  (Port aus [web] port)
```

Von einem **anderen** Rechner im Heimnetz: `curl -m 5 http://<Pi-IP>:8780/` – erwartet: Verbindung abgelehnt bzw. keine Antwort. Über Nginx (`http://<Pi-IP>/waread/`) ist der Dienst im Heimnetz erreichbar, das ist so gewollt. **Manuell:** Im Router prüfen, dass **keine** Portweiterleitung auf den Pi besteht.

### B5 – Login, Rate-Limit, Cookie

Geschützte Routen ohne Anmeldung (eine bekannte Route aus den Browser-Entwicklerwerkzeugen einsetzen):

```bash
curl -s -w '\n%{http_code}\n' "<BASIS>/api/status"    # erwartet: {"error":"unauthorized"} und 401
```

Cookie-Eigenschaften (Passwort nicht auf der Kommandozeile stehen lassen):

```bash
read -rs PW; printf '{"password":"%s"}' "$PW" | \
  curl -si -c /tmp/waread-cookies.txt -X POST -H 'Content-Type: application/json' \
       --data-binary @- "<BASIS>/api/login" | grep -i '^set-cookie'; unset PW
```

Erwartet: Cookie `waread_session` mit `HttpOnly` und `SameSite=Strict`, `Path=/waread/` (laut Beispielkonfiguration); bei HTTPS (Nginx meldet `X-Forwarded-Proto: https`) zusätzlich `Secure`. Ohne HTTPS fehlt `Secure` bei `cookie_secure = "auto"` – das ist erwartet, kein Befund, aber ein Grund, im Heimnetz HTTPS zu erwägen.

Rate-Limit (**Achtung:** sperrt danach eventuell auch dich eine Weile):

```bash
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'Content-Type: application/json' \
       -d '{"password":"falsch"}' "<BASIS>/api/login"
done; echo
```

Erwartet: fünfmal `401`, danach `429` mit Header `Retry-After` (Limit laut `routes.md`: 5 Versuche je 15 Minuten und Client-IP; hinter Nginx zählt die Adresse aus `X-Forwarded-For`). Die Sperre löst sich nach Ablauf der Zeit; ein erfolgreicher Login setzt den Zähler zurück.

### B6 – Header und externe Ressourcen

```bash
curl -s -D - -o /dev/null "<BASIS>/" | grep -i -E 'content-security-policy|x-content-type-options'
curl -s -D - -o /dev/null "<BASIS>/api/gibt-es-nicht" | grep -i -E 'content-security-policy|x-content-type-options'
curl -s  "<BASIS>/" | grep -Eoi '(src|href)="https?://[^"]+"' || echo "ok: keine externen Ressourcen"
```

Erwartet: `default-src 'self'; script-src 'self'; style-src 'self'; …; object-src 'none'; frame-ancestors 'none'` in der Policy, `nosniff`, die Header auch auf Fehlerantworten, keine externen Skripte, Schriften oder Bilder in der ausgelieferten Oberfläche. Medien und Dokumente tragen zusätzlich `default-src 'none'; sandbox`.

### B7 – Medienroute

Mit der Cookie-Datei aus B5 (`-b`) und einer Medien-URL `<BASIS>/api/media/<messageId>` (die Nachrichten-ID steht in den Entwicklerwerkzeugen unter *Netzwerk*), im Folgenden `<MEDIA-URL>`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "<MEDIA-URL>"                       # ohne Cookie: erwartet 401
curl -s -D - -o /dev/null -b /tmp/waread-cookies.txt -H 'Range: bytes=0-99' "<MEDIA-URL>"
```

Erwartet: mit Cookie `206 Partial Content`, `Content-Range`, ein **fester** `Content-Type` (z. B. `audio/mp4`, `image/jpeg`), `X-Content-Type-Options: nosniff`. Für ein **Dokument**: `Content-Disposition: attachment`. Danach `rm /tmp/waread-cookies.txt`.

### B8 – Schadinhalte

Sende von B an A (Testkonto): einen Text `<script>alert(1)</script> <img src=x onerror=alert(1)>`, außerdem ein Dokument namens `test.html` mit einem harmlosen `<script>document.title='X'</script>`. Erwartet: Der Text erscheint **als Text**, es öffnet sich kein Dialog; das Dokument wird **als Download** angeboten (`Content-Disposition: attachment`, `application/octet-stream`), nie im Browser ausgeführt. Hinweis: Der Originalname eines Dokuments hat im Datenbankschema keinen Platz (nicht umgesetzt, kein Eintrag in Oberfläche und Suche). Er steckt nur bereinigt im Dateinamen auf der Platte (`<id>__<name>`) und erscheint als Download-Name; geprüft wird hier das Auslieferungsverhalten.

### B9 – Keine Link-Vorschau, kein Abruf

Auf einem zweiten Rechner im Heimnetz: `python3 -m http.server 8099`. B sendet an A die Nachricht `http://<IP-dieses-Rechners>:8099/linktest`. In waread ansehen (nicht antippen). Erwartet: **kein Zugriff** im Log des Python-Servers. Nach Beenden des Servers: `Strg+C`.

### B10 – Keine Inhalte in Logs

Sende von B an A eine Nachricht mit der Kennung `ZZLOGTEST4711` im Text, eine Foto-Bildunterschrift `ZZLOGTEST4711` und ein Dokument mit `ZZLOGTEST4711` im Dateinamen. In waread einmal nach `ZZSUCHTEST9` suchen. Dann:

```bash
sudo journalctl --since "-30 min" --no-pager | grep -c -E 'ZZLOGTEST4711|ZZSUCHTEST9'    # erwartet: 0
sudo sh -c "grep -c -E 'ZZLOGTEST4711|ZZSUCHTEST9' /var/log/nginx/*.log" 2>/dev/null         # erwartet: 0 je Datei
```

Findet sich der **Suchbegriff** im Nginx-Zugriffslog (Suchanfragen laufen als `GET /waread/api/search?q=…`), ist das ein Befund für die Nginx-Konfiguration: Der mitgelieferte Ausschnitt `deploy/nginx/waread.conf` setzt in beiden Locations `access_log off;`. Fehlt diese Zeile in deiner eingebundenen Fassung oder protokolliert ein übergeordneter Block trotzdem, abschalten oder ein Format ohne Abfrageteil verwenden.

### B11 – Kein Sendepfad im Web-Dienst

```bash
# im Quellcode des Web-Dienstes
grep -RIn 'whiskeysockets\|baileys' services/web/ cleanup/ db/ --include='*.ts' --include='*.js' --include='package.json' \
  --exclude-dir=node_modules --exclude-dir=dist \
  && echo "BEFUND: Web-Dienst, Cleanup oder DB-Schicht bindet die WhatsApp-Bibliothek ein" || echo "ok"
```

Erwartet: kein Treffer. Web-Dienst, Cleanup und Datenbankschicht sollen **keine** WhatsApp-Bibliothek kennen; dann können sie auch nichts senden. (Nur `services/ingest` darf `baileys` einbinden, und dort nur `waLib.ts`.)

### B12 – Sitzungsschlüssel nicht in Sicherungen (manuell)

Konfiguration jeder eingesetzten Datensicherung ansehen (Systemabbild, rsync, restic, Borg, Router-NAS …): `/var/lib/waread` muss ausgeschlossen sein, auch wenn ein übergeordneter Pfad wie `/var/lib` oder `/` gesichert wird. Ergebnis im Protokoll vermerken.

### B13 – Craft unverändert

Nach Installation bzw. Änderung: Vorher/Nachher-Vergleich laut [INSTALL.md](INSTALL.md), Abschnitt 13.

---

## Anhang A – Protokollvorlage

```text
ZWEITNUMMER-TEST – PROTOKOLL

Datum / Uhrzeit:
Durchgeführt von:
Anlass:  [ ] Erstinbetriebnahme  [ ] Neustart  [ ] Wiederverbindung
         [ ] Bibliotheksupdate   [ ] Rücksprung [ ] Routine
waread-Version (readlink /opt/waread/current):
Baileys-Version (npm ls baileys):

GATE
G1 Code-Scan bestanden (npm run check:no-send):  [ ]
G2 Verhaltenstest Fake-Verbindung grün:           [ ]
G3 Abhängigkeiten geprüft (lotusbail nicht da):   [ ]
G4 Änderungen der Bibliothek gesichtet / n.a.:    [ ]
G5 Verbindungsoptionen unverändert / begründet:   [ ]
G6 Automatisierte Tests grün:                     [ ]

VORAUSSETZUNGEN
A: Lesebestätigungen AN [ ]   Zuletzt online + Online = Alle [ ]
B: Lesebestätigungen AN [ ]
Handy A blieb unberührt (WhatsApp nicht geöffnet): [ ]
Positivkontrolle: B sah blaue Haken [ ]  blaues Mikrofon [ ]

ABLAUF
Letzter Bedienschritt in waread um:        Auswertung auf B um:   (>= 10 min)

ERGEBNIS JE NACHRICHT (nur graue Haken? Info: nur "Zugestellt"?)
T1 Text:                     [ ] ok  [ ] FEHLER
T2 Foto:                     [ ] ok  [ ] FEHLER
T3 Sprachnachricht:          [ ] ok  [ ] FEHLER  (Mikrofon grau?)
T4 Gruppentext:              [ ] ok  [ ] FEHLER
T5 Gruppen-Sprachnachricht:  [ ] ok  [ ] FEHLER
T6 Dokument/Video:           [ ] ok  [ ] FEHLER  [ ] nicht gesendet
T7 Antwort/Reaktion/Edit/Löschen: [ ] ok [ ] FEHLER [ ] nicht gesendet
Kopfzeile von A auf B: kein "online" / "schreibt ..."  [ ] ok  [ ] FEHLER
Benachrichtigung auf Handy A weiterhin erhalten: [ ] ja  [ ] nein  (nur Beobachtung)
Zähler ausgehender Meldungsarten: [ ] nur Quittungen  [ ] nicht verfügbar

GESAMTERGEBNIS:  [ ] BESTANDEN   [ ] DURCHGEFALLEN   [ ] UNGÜLTIG
Bemerkungen / Befunde:
```

Die Protokolle enthalten keine Nachrichteninhalte, nur Kennungen und Ergebnisse. Bewahre sie trotzdem nicht öffentlich auf.
