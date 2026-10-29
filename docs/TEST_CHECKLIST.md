# TEST_CHECKLIST – Ist waread ausreichend automatisiert getestet?

Stand: Oktober 2026

Dies ist eine **Prüfliste, keine Testsammlung**. Sie enthält keine Tests, sondern legt fest, **was** automatisierte Tests belegen müssen, damit man ihnen vertrauen kann. Wer die Tests geschrieben hat, trägt zu jeder Zeile den Nachweis ein (Testdatei und Testname). Wer prüft, hakt ab.

Die Liste deckt vier Komponenten ab: **Datenbank-Schicht (`db/`)**, **Ingest-Dienst (`services/ingest/`)**, **Cleanup-Dienst (`cleanup/`)** und **Web-Backend (`services/web/src/`)**. Was sich nicht automatisieren lässt, steht in Abschnitt I.

## So wird die Liste benutzt

Für jede Zeile gelten **drei Fragen**:

1. **Gibt es einen Test dafür?** (Nachweis eintragen)
2. **Läuft er grün** – in einer sauberen Umgebung, ohne Netzwerk und ohne echtes WhatsApp?
3. **Wird er rot, wenn man das Verhalten absichtlich kaputt macht?** Ein Test, der nicht rot werden kann, belegt nichts. Für die kritischen Zeilen gibt es dafür die Sabotage-Proben in Abschnitt J.

| Kürzel | Bedeutung |
| --- | --- |
| **K** | kritisch: muss vorhanden und grün sein, sonst keine Freigabe |
| **W** | wichtig: Lücke nur mit schriftlicher Begründung |
| **N** | wünschenswert |
| Status | ☐ offen · ✔ vorhanden und grün · ✖ vorhanden, aber rot · ➖ bewusst nicht anwendbar (Begründung notieren) |

**Allgemeine Anforderungen an alle Tests:** Sie laufen ohne Internet, ohne echte WhatsApp-Verbindung, in einem temporären Verzeichnis (nie in `/var/lib/waread`), mit einer **steuerbaren Uhr** (keine Abhängigkeit von der echten Zeit oder von `sleep`) und lassen keine Dateien zurück. **Übersprungene Tests** (z. B. wenn ffmpeg fehlt) müssen im Ergebnis **sichtbar als „übersprungen“** erscheinen, nicht still als „grün“.

---

## A. Allgemein

| ID | Prüfpunkt | Prio | Nachweis | Status |
| --- | --- | --- | --- | --- |
| A1 | Ein einziger dokumentierter Befehl startet alle Tests (`npm test` im Projektordner); er funktioniert auf einer frischen Kopie des Projekts nach `npm ci` (bzw. dem ersten `npm install`, solange es keine Lock-Datei gibt). | K | | ☐ |
| A2 | Die Tests brauchen kein Netzwerk (z. B. Lauf mit gesperrtem Netz bleibt grün). | K | | ☐ |
| A3 | Alle Tests nutzen temporäre Verzeichnisse und eine injizierte Uhr; keine festen Pfade unter `/var/lib/waread`. | K | | ☐ |
| A4 | Übersprungene Tests werden gezählt und im Ergebnis ausgewiesen. | W | | ☐ |
| A5 | Die Tests laufen reproduzierbar (zwei Läufe hintereinander, auch in anderer Reihenfolge, liefern dasselbe). | W | | ☐ |
| A6 | Der Testlauf schreibt **keine** Nachrichtentexte, Dateinamen oder Bildunterschriften in sein Ergebnis-Log (Testdaten enthalten erkennbare Marker, die nicht in Logs auftauchen dürfen). | W | | ☐ |
| A7 | Der Code-Scan (`npm run check:no-send`) ist Teil des Standard-Testlaufs (siehe F). | K | | ☐ |
| A8 | Kritische Module (Hülle um die Bibliothek, Löschpfad im Cleanup, Authentifizierung im Web) haben vollständige Zweigabdeckung. Prozentwerte für das Gesamtprojekt sind nur ein Hinweis, kein Ziel. | W | | ☐ |

---

## B. Datenbank-Schicht (`db/`)

| ID | Prüfpunkt | Prio | Nachweis | Status |
| --- | --- | --- | --- | --- |
| B1 | **Migration von leer:** Eine neue leere Datenbank wird auf die aktuelle Schemaversion gebracht; alle Tabellen (laut Konzept `chats`, `messages`, `media`, `messages_fts`, `settings`) existieren. | K | | ☐ |
| B2 | **Migration von jeder älteren Version** mit gefüllten Daten: Daten bleiben erhalten, Suchindex bleibt konsistent. | K | | ☐ |
| B3 | **Wiederholte Migration** ist wirkungslos (idempotent). | K | | ☐ |
| B4 | **Schreibschutz bei Fehler:** Eine fehlschlagende Migration lässt die Datenbank im alten, benutzbaren Zustand (Rollback). | W | | ☐ |
| B5 | **Pragma-Einstellungen:** WAL-Modus, `synchronous=NORMAL`, Fremdschlüssel an, `secure_delete` an, Wartezeit bei gesperrter Datenbank gesetzt (`busy_timeout`). | W | | ☐ |
| B6 | **Zugriff in Kürze:** Nachrichten, Chats und Medien lassen sich anlegen, lesen und aktualisieren; Rückgabewerte sind typisiert und vollständig. | K | | ☐ |
| B7 | **Volltextindex bleibt konsistent:** Einfügen, Ändern (Bearbeiten), Löschen einer Nachricht führen zu passenden Einträgen in `messages_fts`; kein Eintrag ohne Nachricht, keine Nachricht ohne Eintrag. | K | | ☐ |
| B8 | **Transaktion:** Schlägt der Index-Schritt fehl, wird auch die Nachricht nicht geschrieben (alles oder nichts). | K | | ☐ |
| B9 | **Suche:** Präfixsuche („Schul“ findet „Schule“), Umlaut-/Diakritika-Toleranz, Teilwortsuche („bahn“ in „Straßenbahn“), Textausschnitt im Treffer. | W | | ☐ |
| B10 | **Suche mit Sonderzeichen:** Eingaben wie `"`, `*`, `AND`, `NEAR`, `-`, `(`, unausgewogene Anführungszeichen und leere Eingabe führen zu einem sauberen Ergebnis oder einer kontrollierten Fehlermeldung – nie zu einem Absturz oder zu freier FTS-Syntax. | K | | ☐ |
| B11 | **Filter:** nach Chat, Typ, Zeitraum, „nur neue“ – einzeln und kombiniert. | W | | ☐ |
| B12 | **Lokale Zustände:** `seen_at` und `played_at` werden nur lokal gesetzt, sind idempotent (zweites Setzen ändert nichts) und beeinflussen keine anderen Felder. | K | | ☐ |
| B13 | **Einstellungen:** Aufbewahrung nimmt nur 1, 3, 7, 14 oder 30 Tage an; andere Werte werden abgelehnt. Standard ist 3. Medien-Aufbewahrung getrennt einstellbar. | K | | ☐ |
| B14 | **Parameterisierung:** Eingaben mit SQL-Zeichen (`'`, `;`, `--`) verändern nie die Abfrage (Injektionsprobe). | K | | ☐ |
| B15 | **Gleichzeitiger Zugriff:** Ein Schreiber (Ingest) und ein Leser (Web) arbeiten gleichzeitig auf derselben Datei ohne „database is locked“-Fehler (im Rahmen von `busy_timeout`). | W | | ☐ |
| B16 | **Seitenweises Lesen:** Paginierung liefert stabile, überschneidungsfreie Seiten, auch wenn gleichzeitig neue Nachrichten eintreffen. | W | | ☐ |

---

## C. Dedupe-Verhalten

| ID | Prüfpunkt | Prio | Nachweis | Status |
| --- | --- | --- | --- | --- |
| C1 | **Dieselbe Nachricht zweimal** (gleiche Kennung) führt zu **einer** Zeile und **einem** Suchindex-Eintrag. | K | | ☐ |
| C2 | **Erneute Zustellung nach Wiederverbindung** erzeugt keine Dopplung und löst **keinen zweiten Medien-Download** aus. | K | | ☐ |
| C3 | **Überschneidung durch Verlaufs-Sync beim ersten Koppeln:** Nachrichten, die sowohl im Verlauf als auch live ankommen, erscheinen einmal. | K | | ☐ |
| C4 | **Schlüssel des Dedupe:** Der Test deckt **jede Komponente** des in der DB-Schicht dokumentierten Schlüssels ab (gleiche Kennung in verschiedenen Chats, eingehend vs. am Telefon gesendet → je nach Dokumentation getrennt oder gleich). | K | | ☐ |
| C5 | **Reihenfolge-Unabhängigkeit:** Kommen Ereignisse „bearbeitet“, „gelöscht“ oder „Reaktion“ **vor** der Originalnachricht oder zu einer unbekannten Nachricht an, entsteht kein Absturz und kein falscher Zustand. | W | | ☐ |
| C6 | **Bearbeitet / gelöscht:** Eine Bearbeitung ändert Text und Suchindex der vorhandenen Nachricht; „für alle gelöscht“ zeigt nur den Hinweis „gelöscht“ (Standard laut Konzept) und entfernt den alten Inhalt aus dem Index. | W | | ☐ |
| C7 | **Zeitstempel-Regel:** Eine Nachricht mit einem WhatsApp-Zeitstempel **älter als die Aufbewahrung** wird nicht gespeichert; Grenzfall genau auf der Grenze und eine Sekunde davor/danach. | K | | ☐ |
| C8 | **Uhrabweichung:** Ein Zeitstempel in der Zukunft führt nicht zu Absturz oder falscher Löschung. | N | | ☐ |

---

## D. Ingest-Dienst (`services/ingest/`)

Alle Tests in diesem Abschnitt laufen gegen eine **Fake-Verbindung** (ein steuerbares Ersatzobjekt für die Bibliothek), nie gegen WhatsApp.

| ID | Prüfpunkt | Prio | Nachweis | Status |
| --- | --- | --- | --- | --- |
| D1 | **Nachrichtentypen** werden korrekt abgebildet: Text, Foto, Sprachnachricht, Dokument, Video, Sticker, Antwort, unbekannter Typ (→ Platzhalter statt Absturz). | K | | ☐ |
| D2 | **Einzel- und Gruppenchats** inkl. Absendername in Gruppen; eigene, am Telefon gesendete Nachrichten als „ausgehend“. | W | | ☐ |
| D3 | **Fehlerisolation:** Eine fehlerhafte Nachricht bricht die Verarbeitung der nächsten nicht ab; der Dienst läuft weiter. | K | | ☐ |
| D4 | **Verbindungszustände:** verbunden, getrennt, abgemeldet werden korrekt in den für die Oberfläche sichtbaren Status übersetzt. | W | | ☐ |
| D5 | **Wiederverbindung mit Backoff:** Die Wartezeit wächst von etwa 5 Sekunden bis höchstens etwa 10 Minuten, **nie** eine enge Schleife (mit künstlicher Uhr testen). Erfolgreiches Verbinden setzt die Wartezeit zurück. | K | | ☐ |
| D6 | **Abmeldung durch WhatsApp:** Der Dienst **stoppt** und fordert nicht automatisch neue QR-Codes an; Status „Neu verbinden“. | K | | ☐ |
| D7 | **Begrenzte Nebenläufigkeit:** höchstens 2 gleichzeitige Downloads, höchstens 1 gleichzeitige Umwandlung (Zähler im Test). | K | | ☐ |
| D8 | **Warteschlange begrenzt:** Bei Überlauf werden Aufträge kontrolliert verworfen oder verzögert, ohne Speicherwachstum ohne Grenze. | W | | ☐ |
| D9 | **Größenlimits:** Ein zu großer Download wird abgebrochen und als nicht geladen markiert; Videos und Dokumente werden nur auf Anforderung geladen. | K | | ☐ |
| D10 | **Abgelaufene Medien-Links:** Status „abgelaufen“, **kein** Endlos-Wiederholen. | W | | ☐ |
| D11 | **Logging-Hygiene:** Mit Testnachrichten, deren Text, Bildunterschrift und Dateiname einen Marker enthalten, taucht der Marker in **keiner** Logzeile auf (Logger-Aufzeichnung im Test auswerten). Es erscheinen nur Ereignistyp, IDs, Fehlercodes. | K | | ☐ |
| D12 | **Verlauf beim ersten Koppeln:** Große Mengen alter Nachrichten (z. B. mehrere tausend, überwiegend älter als die Aufbewahrung) werden verworfen, ohne Medien zu laden, in Paketen geschrieben, ohne dass der Speicher unbegrenzt wächst. | W | | ☐ |
| D13 | **Profilbilder:** Ein fehlender oder fehlschlagender Avatar-Abruf stört den Betrieb nicht. | N | | ☐ |

---

## E. Medien-Pipeline (mit einer Testdatei)

Die Tests erzeugen ihre Testdateien selbst (z. B. eine kurze Sinus-Datei per ffmpeg, ein kleines Bild); es werden keine echten Mediendaten benötigt.

| ID | Prüfpunkt | Prio | Nachweis | Status |
| --- | --- | --- | --- | --- |
| E1 | **Opus → AAC:** Eine Opus-Testdatei wird umgewandelt; die Ergebnisdatei ist gültig (ffprobe: Codec AAC, Dauer ungefähr gleich, abspielbarer Container). | K | | ☐ |
| E2 | **Speicherort und Status:** Ergebnis liegt in `media/<chat>/<datum>/`; in der Datenbank steht Dateipfad, MIME-Typ, Größe, Dauer und Status „geladen“. | K | | ☐ |
| E3 | **Zeitlimit:** Hängt ffmpeg (z. B. künstlich blockierender Ersatz), wird der Prozess nach dem Zeitlimit beendet; Status „Fehler“, keine Teildatei bleibt liegen. | K | | ☐ |
| E4 | **Defekte Datei:** Eine abgeschnittene oder beschädigte Datei führt zu Status „Fehler“, **kein** Absturz, keine halbfertige Datei im Medienordner. | K | | ☐ |
| E5 | **Miniatur:** Ein Testbild erzeugt die Miniaturen in den erwarteten Größen; EXIF-Ausrichtung wird beachtet; defekte Bilder erzeugen keinen Absturz. | W | | ☐ |
| E6 | **Pfadsicherheit:** Chat-Kennungen und Dateinamen mit `../`, absoluten Pfaden, Nullbytes oder Sonderzeichen führen nie dazu, dass außerhalb von `media/` geschrieben oder gelesen wird. | K | | ☐ |
| E7 | **Dateiname nie ungeprüft:** Gespeicherte Dateinamen werden bereinigt; der ursprüngliche Anzeigename steht nur als Daten in der Datenbank. | W | | ☐ |
| E8 | **Aufräumen im `tmp/`:** Nach Erfolg und nach Fehler bleibt nichts im temporären Ordner zurück. | W | | ☐ |
| E9 | **Sichtbares Überspringen:** Fehlt ffmpeg in der Testumgebung, sind die Tests E1/E3 als „übersprungen“ sichtbar (siehe A4). | W | | ☐ |

---

## F. Lesebestätigungs-Prüfung (kritisch)

Diese Zeilen sichern die unveränderliche Grundregel: **waread sendet nie etwas an WhatsApp zurück.**

| ID | Prüfpunkt | Prio | Nachweis | Status |
| --- | --- | --- | --- | --- |
| F1 | **Code-Scan** auf verbotene WhatsApp-Aufrufe (Lesebestätigung, Online-Status, Tippanzeige, Senden, Chat-Änderungen) existiert, läuft im Standard-Testlauf und liefert bei Fund einen Fehlerstatus. | K | | ☐ |
| F2 | Der Scan prüft den Quellcode von `services/ingest/src`, nicht `node_modules`. **Abweichung von der ursprünglichen Forderung:** Das gebaute JavaScript prüft der Scan nicht; es entsteht aus dem geprüften Quelltext (`prebuild` läuft vor jedem Bau), und die `grep`-Gegenprobe aus SECURITY_TESTS.md, 1.1, deckt `dist/` ab. | K | | ☐ |
| F3 | **Jede** verbotene Funktion der Liste ist mit einem eingepflanzten Beispiel getestet (der Scan schlägt dabei an). | K | | ☐ |
| F4 | **Hülle mit Freigabeliste:** Die Hülle um die Bibliothek erlaubt nur Verbinden, Empfangen und Medien-Download. **Alles andere ist standardmäßig gesperrt** (Freigabeliste, nicht Sperrliste). Der Zugriff auf eine nicht freigegebene Methode schlägt kontrolliert fehl. | K | | ☐ |
| F5 | **Verhaltenstest mit aufzeichnender Fake-Verbindung:** Der Ingest-Dienst verarbeitet einen Querschnitt (alle Nachrichtentypen in Einzel- und Gruppenchats, Medien-Download, Verlaufs-Sync, Wiederverbindung, Abmeldung). Danach gilt: **Die Menge der aufgerufenen Methoden der Fake-Verbindung ist eine Teilmenge der Freigabeliste.** Kein Aufruf von Lesen, Presence, Senden, Chat-Änderung. | K | | ☐ |
| F6 | **Verbindungsoptionen:** Ein Test hält fest, mit welchen Optionen die Verbindung geöffnet wird (u. a. `markOnlineOnConnect` bei Baileys); eine Änderung muss den Test bewusst brechen und begründet werden. | K | | ☐ |
| F7 | **Web-Dienst ohne Bibliothek:** Statische Prüfung, dass `services/web/` die WhatsApp-Bibliothek weder importiert noch als Abhängigkeit führt. | K | | ☐ |
| F8 | **Oberfläche ohne Sendefunktion:** Eine Liste aller Routen des Web-Backends enthält keine schreibende Route in Richtung WhatsApp (nur lokale Zustände: gesehen, angehört, Einstellungen, Löschen). | K | | ☐ |
| F9 | **Eingebundener Scan:** Der Scan ist an den Stellen aus SECURITY_TESTS.md (1.1) aktiv: Testlauf (`npm test`) und Bau (`prebuild`). **Die dritte Stelle (Pi vor dem Umschalten) ist nicht automatisiert**; hier ist ➖ mit dieser Begründung zulässig. | K | | ☐ |
| F10 | **Zähler ausgehender Meldungsarten** (Konzept: sofern die Bibliothek das zulässt): vorhanden und getestet, oder als „nicht verfügbar“ mit Begründung festgehalten. Stand der Lieferung: **nicht umgesetzt** (➖, Begründung in SECURITY_TESTS.md, Schritt 8). | N | | ➖ |

> Der Zweitnummer-Test (SECURITY_TESTS.md) ist **kein Ersatz**, sondern die Ergänzung zu F. F prüft den eigenen Code, der Zweitnummer-Test das echte Verhalten.

---

## G. Cleanup-Dienst (`cleanup/`)

| ID | Prüfpunkt | Prio | Nachweis | Status |
| --- | --- | --- | --- | --- |
| G1 | **Aufbewahrung am WhatsApp-Zeitstempel**, nicht am Empfangszeitpunkt: Eine eben empfangene Nachricht mit altem Zeitstempel wird gelöscht; eine alte, aber vor Kurzem **empfangene** Nachricht mit neuem Zeitstempel nicht. | K | | ☐ |
| G2 | **Grenzfälle der Frist** (genau an der Grenze, eine Sekunde davor/danach) für jeden erlaubten Wert 1/3/7/14/30. | K | | ☐ |
| G3 | **Getrennte Medien-Aufbewahrung:** Medien können früher gelöscht werden als der Text (z. B. Medien 1 Tag, Text 7 Tage); Nachricht bleibt mit Status der Medien. | W | | ☐ |
| G4 | **Reihenfolge je Durchlauf:** Kandidaten wählen → Mediendateien löschen → Zeilen **und** Suchindex in **einer** Transaktion löschen → WAL zurücksetzen → Dateien ohne Datenbankeintrag entfernen. | K | | ☐ |
| G5 | **Absturz-Wiederaufnahme (Crash-Resume):** Der Lauf wird künstlich unterbrochen – (a) nach dem Löschen der Dateien, vor der Transaktion; (b) mitten in der Transaktion; (c) nach der Transaktion, vor der Waisenbereinigung. In **jedem** Fall stellt der **nächste** Lauf den konsistenten Zustand her: keine Zeile mit toter Dateireferenz im Status „geladen“, keine Datei ohne Zeile, kein Suchindex-Eintrag ohne Nachricht. | K | | ☐ |
| G6 | **Idempotenz:** Ein zweiter Lauf unmittelbar danach ändert nichts. Auch auf einer leeren Datenbank läuft er sauber. | K | | ☐ |
| G7 | **Pfadsicherheit beim Löschen:** Ein Datenbankeintrag mit manipuliertem Pfad (`../../…`, absolut, Symlink) führt **nie** zum Löschen außerhalb von `media/`. | K | | ☐ |
| G8 | **Schutzbereiche:** Ein Testlauf mit Köderdateien in `auth/`, `db/` (außer der Datenbank selbst) und außerhalb von `/var/lib/waread` zeigt: Cleanup fasst sie nicht an. | K | | ☐ |
| G9 | **Speicherlimit:** Nicht umgesetzt (F10). Das Limit ist nur eine Anzeige; es wird weder durchgesetzt noch gibt es einen Hinweis-Zustand. Prüfpunkt entfällt, bis das Limit umgesetzt ist. | – | n. a. | ☐ |
| G10 | **Verlängerung der Aufbewahrung** wirkt nur für die Zukunft; Bereits Gelöschtes kommt nicht zurück. | W | | ☐ |
| G11 | **Unabhängigkeit von WhatsApp:** Der Cleanup läuft ohne Ingest und ohne Netzwerk. | K | | ☐ |
| G12 | **Gleichzeitigkeit:** Cleanup und gleichzeitig schreibender Ingest führen zu keinem Absturz („database is locked“ wird abgefangen bzw. wiederholt). | W | | ☐ |
| G13 | **Wöchentliche Wartung:** `VACUUM` läuft nicht im stündlichen Takt, sondern wöchentlich; danach ist die Datenbankdatei kleiner. | N | | ☐ |
| G14 | **Logging-Hygiene** wie D11: nur Anzahlen und Fehlercodes, keine Inhalte. | K | | ☐ |

---

## H. Web-Backend (`services/web/src/`)

| ID | Prüfpunkt | Prio | Nachweis | Status |
| --- | --- | --- | --- | --- |
| H1 | **Zugriffsschutz:** Jede API-Route und jede Medienroute liefert ohne gültige Sitzung 401 (oder die dokumentierte Abweisung) – systematisch **für jede registrierte Route** geprüft (kein Einzelfall-Test). | K | | ☐ |
| H2 | **Login:** Richtiges Passwort → Sitzung; falsches → 401; Argon2id-Prüfung wird tatsächlich verwendet; Hash wird nie in Antworten oder Logs ausgegeben. | K | | ☐ |
| H3 | **Rate-Limit** auf `/api/login`: nach mehreren Fehlversuchen 429 bzw. Sperre; Zurücksetzen nach Ablauf der Zeit (mit künstlicher Uhr). | K | | ☐ |
| H4 | **Sitzungs-Cookie:** `HttpOnly`, `SameSite=Strict`, `Secure` bei HTTPS; „Abmelden“ löscht das Cookie im Browser; ein vorher kopiertes Token bleibt bis zu seinem Ablauf gültig (Sitzungen sind zustandslos, F16). Zu prüfen ist deshalb nur das Löschen des Cookies; alle Sitzungen ungültig machen: siehe MAINTENANCE.md, Abschnitt 7. | K | | ☐ |
| H5 | **Sicherheits-Header** (strenge Content-Security-Policy mit `default-src 'self'`, `X-Content-Type-Options: nosniff`) auf **allen** Antworten, auch Fehlerseiten und Medien. | K | | ☐ |
| H6 | **Medienroute:** fester, aus der Datenbank (nicht aus dem Dateinamen oder dem Inhalt) bestimmter MIME-Typ; Dokumente **immer** mit `Content-Disposition: attachment`; keine Auslieferung von Dateien außerhalb von `media/`. | K | | ☐ |
| H7 | **Pfadangriffe auf Medienroute:** `..`, `%2e%2e`, absolute Pfade, doppelt kodierte Zeichen → 400/404, nie fremde Dateien. | K | | ☐ |
| H8 | **Range-Anfragen:** 206 mit korrektem `Content-Range`, gültiger Bereich am Ende, ungültiger Bereich → 416; mehrere Bereiche bzw. riesige Bereiche werden kontrolliert behandelt. | W | | ☐ |
| H9 | **Keine Seiteneffekte bei GET:** Lesende Anfragen verändern keinen Zustand; „gesehen“, „angehört“, Einstellungen und Löschen laufen über schreibende Methoden. | K | | ☐ |
| H10 | **Speicher leeren:** Die zweistufige Bestätigung wird **serverseitig** erzwungen, nicht nur in der Oberfläche. | K | | ☐ |
| H11 | **Einstellungen validieren:** nur erlaubte Aufbewahrungswerte, begrenzte Zahlen für Limits; ungültige Werte → 400. | K | | ☐ |
| H12 | **Eingaben begrenzt:** Größenlimits für Anfragekörper, Länge der Suchanfrage, Seitengröße. | W | | ☐ |
| H13 | **Ausgabe als Text:** Nachrichtentext, Bildunterschrift, Name, Dateiname mit `<script>` und HTML-Zeichen werden als Text ausgegeben (kein Skript, keine HTML-Interpretation); getestet an den Stellen, an denen die Oberfläche sie anzeigt. | K | | ☐ |
| H14 | **Keine Link-Vorschau:** Das Backend ruft keine URLs aus Nachrichten ab (Test mit lokalem Fake-Server, der **keinen** Zugriff sehen darf). | K | | ☐ |
| H15 | **Live-Kanal (Server-Sent Events):** nur mit Sitzung; Neuverbindung funktioniert; Herzschlag/Abbruch bei getrennten Clients; Begrenzung offener Verbindungen. | W | | ☐ |
| H16 | **Fehlerantworten** enthalten keine Stapelaufrufe, Dateipfade oder Datenbankdetails. | W | | ☐ |
| H17 | **Netzbindung:** Der Dienst bindet nur an `127.0.0.1`. In dieser Umsetzung ist die Adresse eine feste Konstante (`LISTEN_HOST` in `services/web/src/app.ts`) und nicht konfigurierbar; eine Konfiguration mit `0.0.0.0` ist damit gar nicht möglich. | K | | ☐ |
| H18 | **Logging-Hygiene** wie D11: keine Suchbegriffe, Texte, Dateinamen in Logs. | K | | ☐ |
| H19 | **Pfadbewusstsein:** Die Oberfläche funktioniert unter `/waread/` (Unterpfad) ebenso wie unter `/`. | W | | ☐ |

---

## I. Bewusst nicht automatisierbar (manuell zu prüfen)

Diese Punkte lassen sich in einer Testumgebung nicht sinnvoll belegen. Sie sind hier nur aufgeführt, damit sie nicht vergessen werden. Die Verfahren stehen in den anderen Dokumenten.

| Thema | Wo geprüft |
| --- | --- |
| Echtes Verhalten gegenüber WhatsApp (Lesebestätigung, „abgespielt“, Online-Status) | Zweitnummer-Test, [SECURITY_TESTS.md](SECURITY_TESTS.md) |
| QR-Kopplung, Wiederverbindung nach Netzausfall, Abmeldung durch das Handy | [INSTALL.md](INSTALL.md), Abschnitte 10 bis 12 |
| Systemd-Härtung, Dateirechte, Netzbindung, Header über Nginx | SECURITY_TESTS.md, Abschnitt 5 |
| Craft-System unverändert | INSTALL.md, Abschnitt 13 |
| Speicher- und CPU-Last auf dem Pi (`systemd-cgtop`), Dauer der Umwandlung, Datenbankgröße nach drei Tagen | [MAINTENANCE.md](MAINTENANCE.md), Abschnitt 4; im ersten Spike zu messen |
| Safari-Wiedergabe von AAC, Zu-Fotos-hinzufügen, Installation als Web-App | manuell am iPhone |
| Einmal-Ansehen-Medien, Verlaufs-Synchronisation, Nachlieferung nach Ausfall | im ersten Spike zu beobachten (laut Konzept offen) |

**Ausdrückliche Lücke:** Keine der beteiligten Entwicklungssitzungen konnte eine echte WhatsApp-Kopplung testen. Jede Aussage über echtes WhatsApp-Verhalten bleibt bis zum ersten Lauf mit der Testnummer unbelegt.

---

## J. Sabotage-Proben (für alle K-Zeilen empfohlen)

Eine Prüfliste mit grünen Häkchen sagt wenig, wenn die Tests nicht rot werden können. Für die folgenden Fälle in einem **Wegwerf-Zweig** den Fehler **absichtlich einbauen**, den Testlauf starten und erwarten, dass er **rot** wird. Danach den Zweig verwerfen.

| Nr. | Absichtlicher Fehler | Dieser Test muss rot werden |
| --- | --- | --- |
| S1 | Im Ingest-Code einen Aufruf einer verbotenen Funktion einfügen (z. B. Lesebestätigung senden) | F1, F3 und F5 |
| S2 | Hülle um die Bibliothek so ändern, dass eine nicht freigegebene Methode durchgereicht wird | F4, F5 |
| S3 | Verbindungsoption zum Online-Status ändern | F6 |
| S4 | Den eindeutigen Schlüssel der Nachrichten entfernen oder verändern | C1, C4 |
| S5 | Cleanup so ändern, dass er `received_at` statt des WhatsApp-Zeitstempels nutzt | G1 |
| S6 | Im Cleanup die Waisenbereinigung weglassen | G5 |
| S7 | Im Cleanup die Pfadprüfung entfernen | G7 |
| S8 | Den Volltext-Index beim Löschen nicht mitführen | B7, G5 |
| S9 | In einer Route des Web-Backends die Sitzungsprüfung entfernen | H1 |
| S10 | In der Medienroute `Content-Disposition: attachment` für Dokumente entfernen | H6 |
| S11 | Zeitlimit für ffmpeg entfernen | E3 |
| S12 | Nachrichtentext in eine Logzeile schreiben | D11, G14 oder H18 |

Ergebnis dokumentieren: Nummer, erwartete Rotstellen, tatsächlich rot geworden (ja/nein).

---

## K. Gesamtbewertung

**Ausreichend getestet**, wenn:

1. **Alle K-Zeilen** der Abschnitte A bis H sind ✔ (oder ➖ mit tragender Begründung).
2. **Alle Sabotage-Proben** aus Abschnitt J sind durchgeführt und haben die erwarteten Tests rot werden lassen.
3. **W-Zeilen** mit Status ☐ oder ✖ haben eine schriftliche Begründung und einen Plan.
4. Abschnitt I ist dem Betreiber bekannt und die manuellen Prüfungen sind terminiert.

| Komponente | K gesamt | K ✔ | W gesamt | W ✔ | Sabotage-Proben ✔ | Urteil |
| --- | --- | --- | --- | --- | --- | --- |
| A Allgemein | | | | | – | |
| B Datenbank-Schicht | | | | | | |
| C Dedupe | | | | | | |
| D Ingest | | | | | | |
| E Medien-Pipeline | | | | | | |
| F Lesebestätigungs-Prüfung | | | | | | |
| G Cleanup | | | | | | |
| H Web-Backend | | | | | | |

Datum der Prüfung: ________________ Geprüft von: ________________ Version: ________________
