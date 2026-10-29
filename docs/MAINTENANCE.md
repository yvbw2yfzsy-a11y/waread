# MAINTENANCE – Betrieb und laufende Wartung

Stand: Oktober 2026 · Voraussetzung: waread ist nach [INSTALL.md](INSTALL.md) installiert und der Zweitnummer-Test bestanden ([SECURITY_TESTS.md](SECURITY_TESTS.md)).

## 0. Grundregeln für jeden Eingriff

- **Craft nie anfassen.** `/var/www/craft`, `/var/lib/craft`, `/usr/local/bin/craft-update` und alle Craft-Einheiten sind tabu. Das gilt auch für Aufräumaktionen mit Platzhaltern wie `rm -rf /var/lib/*`.
- **Nginx: `nginx -t`, dann `reload`.** Nie `restart`, nie ohne vorherigen Test.
- **Kein globales Journal-Aufräumen.** `journalctl --vacuum-…` und Einstellungen in `journald.conf` wirken auf das **gesamte** System-Journal, also auch auf Craft und Nginx. Das ist keine waread-Entscheidung; ändere es nur bewusst und für das ganze System.
- **Nur eine Verbindung pro WhatsApp-Sitzung.** Kopiere `/var/lib/waread/auth/` nie auf einen anderen Rechner und starte nie zwei Dienste mit denselben Sitzungsdaten.
- **Keine Inhalte weitergeben.** Wenn du Log-Ausschnitte oder Befehlsausgaben für Hilfe kopierst: vorher durchsehen (siehe Abschnitt 2).

---

## 1. Routine im Überblick

| Wann | Was | Abschnitt |
| --- | --- | --- |
| Täglich (Blick genügt) | Verbindungsstatus in waread („verbunden“?) | 3 |
| Wöchentlich | Dienste, Speicher, freier Platz, Cleanup-Lauf | 3, 4 |
| Monatlich | „Verknüpfte Geräte“ am iPhone ansehen; Handy-Nutzung sicherstellen | 7 |
| Alle paar Monate | Zweitnummer-Test (Routine) | SECURITY_TESTS.md, 3.2 |
| Bei jedem Update | Ablauf aus Abschnitt 5 | 5 |
| Bei Störung | Entscheidungsbaum | 6 |

---

## 2. Logs lesen, ohne Inhalte zu exponieren

### Was im Journal steht – und was nicht

Vorgabe für alle waread-Dienste: Das Journal enthält **nur Ereignistyp, IDs und Fehlercodes**, keine Nachrichtentexte, Bildunterschriften, Dateinamen oder Suchbegriffe. Diese Vorgabe prüft die Baseline B10 in SECURITY_TESTS.md aktiv (Kennung-Test). IDs sind kein Inhalt, aber pseudonyme Bezüge: Gib auch sie nicht öffentlich weiter.

**Cleanup (F17):** Warnungen nennen statt eines Pfads nur den Fehlercode (z. B. `EACCES`) und eine Kurzkennung `pfad#xxxxxxxx`. Im Pfad stecken Chat-Kennung und Dateiname, deshalb steht er nicht im Journal. Die Kurzkennung ist pro Lauf gesalzen: Zeilen desselben Laufs lassen sich zuordnen, die Datei selbst benennt das Journal bewusst nicht (der Lauf zählt sie in `file_errors`). Ein Test mit simulierten Fehlern prüft das. Nur ein **fataler** Fehler beim Start (z. B. ungültige Konfiguration) gibt den Fehlertext aus; er kann Pfade aus der Konfiguration enthalten, aber keine Nachrichten- oder Chat-Daten.

**Grenze:** Für den Web-Dienst gibt es keinen allgemeinen Maskierer wie im Ingest. Der Smoke-Test prüft, dass bekannte Beispielgeheimnisse nicht im Journal landen; ein neues Logfeld mit Inhalt würde dort nur auffallen, wenn dieser Test es zufällig erfasst.

### Befehle

```bash
# Aktueller Zustand eines Dienstes (inkl. letzter Journal-Zeilen)
sudo systemctl status waread-ingest.service --no-pager

# Warnungen und Fehler der letzten 24 Stunden, alle waread-Dienste
sudo journalctl -u waread-ingest -u waread-web -u waread-cleanup -u waread-cleanup-vacuum \
  --since "-24 hours" -p warning --no-pager

# Letzter Aufräumlauf
sudo journalctl -u waread-cleanup --since "-3 hours" --no-pager

# Wie oft hat der Ingest-Dienst heute neu verbunden? (nur Zählen, nichts lesen)
sudo journalctl -u waread-ingest --since today --no-pager | wc -l
```

Vermeide `journalctl -f` in geteilten Bildschirmen oder Bildschirmaufnahmen. Prüfe bei neuen Meldungstypen **einmal**, ob die Zeile Inhalte verrät; wenn ja, ist das ein Fehler im Dienst, den du meldest (und nicht kopierst).

### Log-Stufe nie auf „debug/trace“ stellen (Hauptkonto)

Bibliotheken wie Baileys können auf hoher Protokollstufe ganze Nachrichtenpakete ausgeben. Falls `config.toml` eine Log-Stufe anbietet (siehe `config.example.toml`), bleibt sie auf der Standardstufe. Eine höhere Stufe nur mit dem **Testkonto**, kurz, und im Wissen, dass du Journal-Einträge **nicht gezielt pro Dienst löschen** kannst (siehe Grundregeln).

### Nginx-Zugriffslog

Das Nginx-Log kennt URLs, und Suchanfragen laufen als `GET /waread/api/search?q=…`. Der mitgelieferte Nginx-Ausschnitt (`deploy/nginx/waread.conf`, installiert als `/etc/nginx/snippets/waread.conf`) setzt deshalb in beiden waread-Locations `access_log off;`. Prüfe nach jeder Änderung an Nginx, dass diese beiden Zeilen noch da sind (SECURITY_TESTS.md, Baseline B10). Schaue nicht in Nginx-Logs, um Chats zu „lesen“ – das wäre ohnehin nur Rauschen.

---

## 3. Dienste und Verbindung prüfen

```bash
systemctl is-active waread-ingest waread-web waread-cleanup.timer waread-cleanup-vacuum.timer
systemctl list-timers 'waread*' --no-pager          # nächster und letzter Lauf der Timer (Cleanup stündlich, VACUUM sonntags, Update nur wenn aktiviert)
timedatectl                                          # Uhr synchronisiert?
```

Erwartet: `active`; `waread-cleanup.timer` hat einen „LAST“-Eintrag innerhalb der letzten Stunde (Takt: stündlich, jeweils um :17), `waread-cleanup-vacuum.timer` läuft wöchentlich (sonntags gegen 04:30); die Uhr ist synchronisiert. In waread unter *Einstellungen → Verbindung*: „verbunden“.

---

## 4. Speicherübersicht prüfen

### 4.1 In der App

*Einstellungen → Speicher* zeigt belegten Platz gesamt, je Chat und je Medientyp sowie den freien Platz auf dem Datenträger. Das ist der erste Blick.

### 4.2 Auf dem Pi

```bash
df -h /var/lib/waread                              # freier Platz
sudo du -sh /var/lib/waread/db /var/lib/waread/media /var/lib/waread/auth /var/lib/waread/tmp
sudo ls -lh /var/lib/waread/db/                    # waread.db und die Dateien -wal / -shm
df -h /var/lib/waread/tmp                          # tmpfs-Füllstand, falls eingerichtet
```

Hinweise:

- **Ordnernamen unter `media/`** können Chat-Kennungen enthalten. Zeige oder teile eine Auflistung der Unterordner (`ls` oder `du` ohne `-s`) nicht öffentlich.
- **`waread.db-wal` wächst stark?** Das Konzept sieht vor, dass der Aufräumlauf die WAL-Datei zurücksetzt. Bleibt sie dauerhaft sehr groß (Größenordnung der Datenbank oder mehr), prüfe, ob der Cleanup läuft (Abschnitt 3) und ob ein Dienst dauerhaft eine lange Lese-Transaktion offenhält.
- **Speicherlimit (nur Anzeige, F10):** Die Oberfläche zeigt den Verbrauch gegen das eingestellte Limit an. waread **setzt das Limit nicht durch**: Es wird nichts deswegen gelöscht, und es gibt keinen Hinweis-Zustand. Der Datenträger kann also voll laufen (Folgen: Schreibfehler, Dienst fährt bei nicht speicherbaren Zugangsdaten herunter). Beobachte den Speicher selbst; ist er knapp, senke die Medien-Aufbewahrung oder verschärfe die Download-Regeln (Videos und Dokumente nur auf Tipp).
- **Freier Platz:** Empfehlung dieser Anleitung (kein Wert aus dem Konzept): Halte mindestens etwa 15–20 % des Datenträgers frei und achte darauf, dass auch Craft und das System genug Platz behalten.
- **Datenbank prüfen (Diagnose, selten):**

```bash
sudo -u waread sqlite3 -readonly /var/lib/waread/db/waread.db 'PRAGMA integrity_check;'      # erwartet: ok
```

### 4.3 Arbeitsspeicher

```bash
for u in waread-ingest waread-web; do
  echo "== $u"; systemctl show "$u.service" -p MemoryCurrent -p MemoryMax
done
systemd-cgtop -b -n 1 | grep -E 'waread|Path'
free -h
```

Zielwerte laut Vorgabe: jeder waread-Dienst im Leerlauf unter etwa 150–250 MB. Kurzzeitige Spitzen bei Medien und beim ersten Koppeln sind normal. Wird ein Dienst dauerhaft darüber geführt oder mit `oom-kill` beendet, ist das ein Befund: Version notieren, nicht einfach `MemoryMax` erhöhen, ohne die Ursache zu verstehen (bei Baileys sind Speicherlecks in der Vergangenheit erwähnt worden).

### 4.4 Speicher leeren

In waread: *Einstellungen → Speicher leeren* (Medien eines Chats, alle Medien, alle Nachrichten eines Chats oder alles; jeweils zweistufig bestätigt). Gelöscht wird nur lokal; auf dem iPhone bleibt alles. Neue Nachrichten werden danach weiter gespeichert. Der Umfang **Alles** beauftragt zusätzlich den Ingest, seine gemerkten Anzeigenamen und die Zuordnung Kennung ↔ Telefonnummer zu leeren (F14); der Auftrag bleibt stehen, bis der Ingest läuft. Die Umfänge **Chat** und **Medien** lassen diese Daten bewusst unberührt. Auch die Medienaufgaben des Ingest (mit den Schlüsseln noch nicht geladener Medien) gehören nicht zu diesem Auftrag; sie verschwinden, sobald sie abgearbeitet oder abgelaufen sind.

**Ehrliche Grenze:** `secure_delete` überschreibt gelöschte Inhalte in der Datenbankdatei. Auf SD-Karte oder SSD kann der Datenträger selbst Reste behalten. Wer das ausschließen will, legt das Datenverzeichnis auf ein verschlüsseltes Dateisystem (LUKS).

---

## 5. Updates

### 5.1 Was `waread-update` tut – und was nicht

- **Installiert** wird das Skript von `install.sh` nach `/usr/local/sbin/waread-update` (Besitzer root). Es ist ein eigenständiges Skript und teilt weder Zustand noch Timer mit `craft-update`; es fasst `/usr/local/bin/craft-update`, `/var/lib/craft`, `/var/www/craft` und die Craft-Einheiten nicht an.
- **Ablauf pro Lauf:** Konfiguration lesen (Abschnitt `[update]` in `/etc/waread/config.toml`) → Manifest holen und dessen **Ed25519-Signatur** prüfen → nur eine **neuere** Version akzeptieren (gleiche Version = aktuell, ältere = Downgrade, wird verweigert) → Tarball holen und **SHA-256** gegen das signierte Manifest prüfen → nach `/opt/waread/releases/<version>` entpacken → Bibliothekstor (unten) → `current` atomar umschalten → `waread-ingest` und `waread-web` neu starten → `GET /healthz` prüfen → bei Fehlschlag **automatisch zurück** auf die vorherige Version. Es bleiben die letzten 3 Releases erhalten.
- **Aufruf:**

```bash
sudo waread-update --check                           # nur prüfen, ob ein Update da ist; ändert nichts
sudo waread-update                                   # Update einspielen
sudo waread-update --retry                           # eine früher gescheiterte Version erneut versuchen
sudo waread-update --approve-library-change X.Y.Z    # Bibliotheksänderung in genau dieser Version freigeben
```

  Exit-Codes: 0 aktuell/erfolgreich, 1 Fehler oder Rollback, 2 Aufruf- oder Konfigurationsfehler, **3 manuelle Prüfung nötig**.
- **Zustand** (root-eigen, `/opt/waread/state/`): `update.status` (state, time, current_version, target_version, reason), `update.failed-version`, `update.review-version`, `update.lock`. Anzeigen: `sudo cat /opt/waread/state/update.status`.
- **Es gibt keine eingebaute Update-Quelle.** In `config.example.toml` ist `update_source_url = ""` leer. Solange du dort nichts einträgst, tut `waread-update` nichts. Welche Quelle du einträgst und wie du Releases baust und signierst (`deploy/make-release.sh`, Schlüssel, Manifest-Format), ist deine Entscheidung; beschrieben in `deploy/README.md`. Diese Anleitung nennt bewusst keine Adresse.
- **In der Testphase nur von Hand.** Der Timer `waread-update.timer` (täglich gegen 03:00 Europe/Berlin) wird von `install.sh` **nicht aktiviert**. Aktiviere ihn erst nach der Testphase: `sudo systemctl enable --now waread-update.timer`.
- **Bibliothekstor (Stand der Umsetzung):** Vor dem Umschalten vergleicht das Skript in `package-lock.json` die Einträge des Pakets `baileys` (und des früheren Namens `@whiskeysockets/baileys`) zwischen der laufenden und der neuen Version. Ändert sich dort etwas, wird **nichts aktiviert**: Status `manual-review`, Exit-Code 3, Eintrag in `update.review-version`. Nach deiner Prüfung (Abschnitt 5.3) gibst du genau diese Version mit `--approve-library-change X.Y.Z` frei.
- **Grenzen des Tors – bitte ehrlich lesen:** Das Tor vergleicht nur die Version von `baileys` selbst. **Nicht** abgedeckt: Änderungen an Baileys' eigenen Abhängigkeiten, an unserem Ingest-Code und am Node-Hauptwechsel. Auch das Lesebestätigungs-Prüfen ersetzt das Tor nicht: Der Code-Scan (`npm run check:no-send`) läuft beim **Bau** der Release (`prebuild`), nicht im Updater, und er sieht den Verkehr der Bibliothek selbst nicht. Dafür bleibt nur der Zweitnummer-Test (SECURITY_TESTS.md, Abschnitt 3.2). Wer den Timer aktiviert, nimmt in Kauf, dass Releases ohne Änderung an `baileys` ungeprüft eingespielt werden. Wer das nicht will, lässt den Timer aus und nutzt `--check` von Hand.

### 5.2 Ablauf für ein Update (von Hand)

1. **Release-Notes und Unterschied der Lock-Datei lesen.** Hat sich `baileys` oder eine seiner Abhängigkeiten geändert (`diff` der beiden `package-lock.json`)? Wenn ja: Abschnitt 5.3.
2. **Vorbereitung:** Aktuelle `config.toml` sichern (`sudo cp -a /etc/waread/config.toml /etc/waread/config.toml.vor-<version>`), aktive Version notieren (`readlink /opt/waread/current`). Nicht im Moment starker Nutzung updaten.
3. **Gate durchlaufen:** [SECURITY_TESTS.md](SECURITY_TESTS.md), Abschnitt 1, inklusive Code-Scan (`npm run check:no-send`) gegen den entpackten Release-Ordner **vor** dem Umschalten des Symlinks.
4. **Einspielen:** `sudo waread-update` (mit `--approve-library-change X.Y.Z`, wenn das Bibliothekstor angehalten hat) oder von Hand wie in INSTALL.md, Abschnitte 5 und 6 (bauen bzw. Release-Baum, `install.sh`, Symlink atomar).
5. **Neu starten und prüfen:** `sudo systemctl restart waread-ingest waread-web`, Status „verbunden“, ein Text vom Zweitgerät kommt an, `systemctl is-active …`, Journal auf Warnungen.
6. **Craft-Kontrolle** (kurz): `systemctl is-active nginx`, Craft-Seite antwortet; bei Änderungen an Nginx: INSTALL.md, Abschnitt 13.
7. **Beobachten:** Einen Tag lang Status, Speicher und Journal ansehen.
8. **Bei Problemen:** sofort zurückrollen (Abschnitt 8).

### 5.3 Wann ein Bibliotheksupdate **manuell geprüft werden muss**

Immer – mit dem vollständigen Ablauf – in diesen Fällen:

| Auslöser | Warum |
| --- | --- |
| **Version von `baileys` oder seiner Abhängigkeiten ändert sich** (das Tor des Updaters sieht nur `baileys` selbst, siehe 5.1) | Neue Standardwerte oder Verhalten können Meldungen an WhatsApp auslösen, die vorher nicht kamen. |
| **Änderung am Ingest-Code, der die Verbindung aufbaut oder Ereignisse verarbeitet** | Der Code-Scan fängt nur Textmuster; ein Zweitnummer-Test fängt Verhalten. |
| **Wechsel der Node.js-Hauptversion** | Native Module (`better-sqlite3`, `sharp`) werden neu gebaut; Medien-Pipeline testen (TEST_CHECKLIST.md, Abschnitt E). |
| **Neue Hauptversion von `better-sqlite3`, `sharp` oder ffmpeg** | Betrifft Datenbank bzw. Medien, nicht Lesebestätigungen. Automatisierte Tests laufen lassen. |
| **WhatsApp lehnt die alte Bibliotheksversion ab** (Verbindung scheitert, andere Quellen berichten dasselbe) | Zeitdruck verleitet zum ungeprüften Update. Auch dann gilt: erst Test, dann Hauptkonto. |
| **Sicherheitsmeldung zu einem Paket** (Vorfall wie der im Konzept beschriebene Fall „lotusbail“, ein manipulierter Baileys-Fork) | Prüfen, ob das betroffene Paket in der Lock-Datei steht; `npm ls --all` |
| **Verdacht auf geändertes Protokollverhalten** (Sperrmeldungen, auffällige Abmeldungen, Berichte der Bibliotheksbetreuer) | Konto schützen; im Zweifel Betrieb pausieren (Abschnitt 6). |

Reihenfolge: Änderungen ansehen → Gate → Test in der Testinstanz mit Konto A (nicht auf dem Hauptkonto!) → freigeben (`waread-update --approve-library-change X.Y.Z`) → einspielen → beobachten. Details zur Testinstanz: SECURITY_TESTS.md, Abschnitt 3.2.

---

## 6. Vorgehen bei Verbindungsabbruch

Zuerst **ruhig bleiben**: Das iPhone bleibt die Quelle der Wahrheit. Fällt waread aus, gehen keine Nachrichten verloren, du verlierst nur die Lesehilfe. Nicht in kurzen Abständen neu koppeln oder neu starten. (ANNAHME, nicht belegt: Häufige Kopplungen und Verbindungsaufbauten sind vermutlich das auffälligste eigene Verhalten; ob und wie WhatsApp sie bewertet, ist UNBEKANNT.)

### Entscheidungsbaum

1. **waread zeigt „getrennt/verbindet“.**
   - Warten. Das Verbinden versucht es automatisch mit wachsender Wartezeit (etwa 5 Sekunden bis höchstens 10 Minuten). Mehrere Minuten sind normal, bis zur längsten Wartezeit von etwa 10 Minuten zwischen zwei Versuchen. Die Wartezeit wird erst zurückgesetzt, wenn eine Verbindung mindestens 10 Minuten (`stable_after_seconds`) offen blieb; kürzere Verbindungen verkürzen sie nicht (F05).
   - Parallel prüfen: Internet am Pi (`ping -c 3 1.1.1.1` oder eine bekannte Adresse), Uhr (`timedatectl`).
2. **Der Dienst läuft nicht** (`systemctl is-active waread-ingest` ≠ `active`).
   - `sudo systemctl status waread-ingest.service --no-pager` und die letzten Journal-Zeilen ansehen.
   - **Einmal** `sudo systemctl restart waread-ingest.service`. Wiederholt es sich sofort: nicht weiter neu starten, Ursache suchen (Konfiguration, Rechte, voller Datenträger, Speicherlimit).
3. **waread zeigt „Neu verbinden“ / abgemeldet.** Die Sitzung wurde von WhatsApp beendet. Der Dienst fordert nicht selbst neue QR-Codes an: weder nach der Abmeldung noch bei einem späteren Neustart (`auto_pair_on_start = false`, Standard seit F03). Ein neuer QR-Code entsteht nur auf „Neu verbinden“; wer `auto_pair_on_start = true` setzt, bekommt bei jedem Start ohne Sitzung eine neue Kopplungssitzung.
   - **Am Handy** prüfen: Funktioniert WhatsApp normal? Ist der Pi unter *Verknüpfte Geräte* noch aufgeführt?
   - Mögliche Ursachen laut Konzept: Das Handy war länger als etwa 14 Tage unbenutzt (verknüpfte Geräte werden dann abgemeldet; ein Gerät ohne Aktivität wird nach etwa 30 Tagen getrennt – bitte im Hilfecenter von WhatsApp gegenprüfen); du hast das Gerät selbst abgemeldet; es hingen bereits vier verknüpfte Geräte am Konto; WhatsApp hat die Sitzung beendet (auch eine Sperre des Kontos ist möglich).
   - **Ist das Konto eingeschränkt oder gesperrt:** waread **stoppen** (`sudo systemctl stop waread-ingest`) und nicht wiederholt neu koppeln. Hilfe nur über WhatsApp.
   - Ist alles in Ordnung: **einmal** neu koppeln (INSTALL.md, Abschnitt 10). Klappt das nicht, nicht mehrfach in Folge probieren.
4. **Verbindung steht, aber es kommen keine neuen Nachrichten** oder Medien lassen sich nicht entschlüsseln.
   - Mögliche Ursache: Die Bibliotheksversion passt nicht mehr zu WhatsApp (laut Konzept ein bekanntes Dauerthema bei inoffiziellen Bibliotheken).
   - Prüfen, ob die Betreuer der Bibliothek ein Update bzw. einen Hinweis veröffentlicht haben; dann Abschnitt 5.3 (kein ungeprüftes Update).
5. **Nach einem Ausfall des Pi:** WhatsApp stellt Offline-Nachrichten **meist**, aber nicht garantiert nach. Fehlt etwas, steht es auf dem iPhone.
6. **Nach jeder längeren Störung mit Neukopplung oder Neustart:** Zweitnummer-Test **in der Testinstanz** wie in SECURITY_TESTS.md, Abschnitt 3.2 („Nach Neustart / nach Wiederverbindung“). Ein Test am Hauptkonto ist nicht möglich und nicht nötig; die Prüfung gilt dem Verhalten der Software.

---

## 7. Geräte- und Sitzungshygiene

- **Monatlich:** Am iPhone *Einstellungen → Verknüpfte Geräte* ansehen. Es darf nur der Pi (und was du kennst) aufgeführt sein. Ein **unbekanntes Gerät** ist ein Notfall (Abschnitt 9, Fall 1).
- **Handy regelmäßig nutzen.** Wird das Handy länger als etwa 14 Tage nicht benutzt, kann WhatsApp verknüpfte Geräte abmelden (laut Berichten; bitte im Hilfecenter gegenprüfen). Urlaub und lange Pausen einplanen.
- **Nur ein Pi-Gerät.** Der Pi belegt eines der bis zu vier verknüpften Geräte.
- **Notausschalter:** Du kannst den Pi jederzeit am Handy abmelden. Das ist die schnellste Sperre bei Verdacht.
- **Web-Sitzungen ungültig machen (F16):** „Abmelden“ in der Oberfläche löscht nur das Cookie im Browser. Die Sitzungstoken sind zustandslos signiert; ein kopiertes Token bliebe bis zum Ablauf (`session_days`, Standard 30) gültig. Willst du **alle** Web-Sitzungen sofort beenden (z. B. Handy verloren), ändere die Signaturgrundlage: `sudo systemctl stop waread-web && sudo rm /var/lib/waread/session.key && sudo systemctl start waread-web`. Der Dienst legt das Geheimnis neu an, alle alten Token sind dann ungültig (zwingend aus der Konstruktion: andere Signaturschlüssel). Auch das Ein- oder Ausschalten der Passkey-Sperre und `passkey-admin reset` setzen eine neue Sitzungsepoche und beenden alle bestehenden Sitzungen (`services/web/src/passkeys.ts`, `setLock` und `reset`). Das Löschen eines einzelnen Passkeys tut das **nicht**. Eine serverseitige Liste einzelner Sitzungen gibt es nicht; das ist die offene Grenze von F16.

---

## 8. Rücksprung auf eine alte Version

Die vollständige Anleitung steht in [INSTALL.md, Abschnitt 15](INSTALL.md). Kurzfassung:

```bash
readlink /opt/waread/current
ls -1 /opt/waread/releases
sudo ln -s releases/<ALTE-VERSION> /opt/waread/current.new
sudo mv -T /opt/waread/current.new /opt/waread/current
sudo systemctl restart waread-ingest.service waread-web.service
systemctl is-active waread-ingest waread-web
```

Danach: Status „verbunden“, Text vom Zweitgerät kommt an. Wechselt dabei die Bibliotheksversion, gehört der Zweitnummer-Test dazu.

Wichtige Fallen (Details in INSTALL.md): **Datenbankschema** der neueren Version kann mit der alten nicht kompatibel sein (Notausgang: nur die Datenbank verwerfen, **`auth/` behalten**); **Sitzungsformat** kann nach einem Wechsel der Bibliotheks-Hauptversion neues Koppeln erfordern; die **alte Version muss noch unter `releases/` liegen**. Lösche alte Versionen daher nicht sofort.

---

## 9. Notfälle

**Fall 1 – Unbekanntes Gerät unter „Verknüpfte Geräte“ oder Verdacht auf gestohlene Sitzungsschlüssel**

1. Am Handy das unbekannte Gerät **und** den Pi abmelden.
2. `sudo systemctl stop waread-ingest.service waread-web.service`
3. `sudo find /var/lib/waread/auth -mindepth 1 -delete`
4. Passwort für waread ändern; SSH-Zugänge und Schlüssel prüfen; Liste der angemeldeten Benutzer ansehen (`who`, `last -n 20`).
5. Prüfen, wie es dazu kam (z. B. ob ein Paket verändert wurde: Lock-Datei gegen die letzte geprüfte Version vergleichen).
6. Erst nach der Ursachenklärung neu koppeln.

**Fall 2 – Verdacht, dass waread eine Lesebestätigung gesendet hat**

1. `sudo systemctl stop waread-ingest.service`; am Handy den Pi abmelden.
2. Befund festhalten (Zeit, Chat, Version).
3. Vorgehen wie SECURITY_TESTS.md, Abschnitt 4. Blaue Haken lassen sich nicht zurücknehmen; weitere vermeiden.

**Fall 3 – Pi wird ausgemustert oder weitergegeben**

1. Am Handy den Pi abmelden.
2. Dienste stoppen und deaktivieren: `sudo systemctl disable --now waread-ingest waread-web waread-cleanup.timer waread-cleanup-vacuum.timer waread-update.timer`.
3. `/var/lib/waread` löschen. Auf SD-Karte oder SSD kann der Datenträger Reste behalten; sicherer ist ein verschlüsseltes Dateisystem von Anfang an oder ein physisches Vernichten bzw. vollständiges Überschreiben des Datenträgers.

**Fall 4 – waread soll vorübergehend pausieren**

`sudo systemctl stop waread-ingest.service` genügt. Die Weboberfläche zeigt weiter die gespeicherten Nachrichten, der Cleanup läuft weiter. Am Handy bleibt der Pi verknüpft; nach etwa 14 Tagen Handy-Inaktivität (siehe Abschnitt 7) kann die Verknüpfung ablaufen.

---

## 10. Regelmäßige Selbstkontrolle (Checkliste)

- [ ] Verbindungsstatus „verbunden“
- [ ] `systemctl is-active` für `waread-ingest`, `waread-web` und die Timer `waread-cleanup.timer`, `waread-cleanup-vacuum.timer`
- [ ] Letzter Cleanup-Lauf in den letzten ~Stunden
- [ ] Freier Platz auf dem Datenträger
- [ ] Speicherverbrauch der Dienste im Zielbereich
- [ ] Keine unerwarteten Warnungen im Journal
- [ ] „Verknüpfte Geräte“ am iPhone: nur bekannte Geräte (monatlich)
- [ ] Craft-Seite erreichbar (kurz)
- [ ] Nächster Zweitnummer-Test terminiert (alle paar Monate bzw. vor Updates)
