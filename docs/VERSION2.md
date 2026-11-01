# Version 2: Schild, gelöscht und bearbeitet, Einmal-Medien, „Medium jetzt laden“

Stand: 29. Oktober 2026. Dieses Dokument gehört zu den Änderungen auf dem Branch `claude/waread-design-features-5qn19p`.
Es hält fest, **was neu ist, was beim Einspielen auf dem Pi zu tun ist, was zusätzlichen Verkehr zu WhatsApp erzeugt und was ungeprüft ist**.

Gewissheitsstufen: **GESICHERT** = im Code gelesen oder durch einen Testlauf belegt. **VERMUTUNG** = plausibel, nicht belegt (mit Angabe, was fehlt).
**UNBEKANNT** = nicht beurteilbar (mit Grund).

## 1. Was neu ist

| Bereich | Änderung |
| --- | --- |
| Layout | Ab 900 px Breite hatte die Gridzeile keine feste Höhe: Bei langer Chatliste lagen Navigation und Fußleiste unterhalb des Fensters (gemessen, Chromium). Behoben mit `grid-template-rows: minmax(0, 1fr)`. |
| Zitate | Antworten zeigen Absender und Text der zitierten Nachricht. Der Server liest sie vom Original (Join auf `reply_to`); fehlt es, nutzt er das Kurzzitat, das der Ingest beim Speichern der Antwort ablegt (`reply_text`, `reply_sender`, `reply_type`). |
| Gelöscht | Der Ingest abonniert `messages.update`. „Für alle gelöscht“ setzt `deleted` und `deleted_at`. Die Nachricht bleibt lesbar und trägt die Beschriftung „Vom Absender gelöscht · Uhrzeit“. |
| Bearbeitet | Jede Bearbeitung legt die alte Fassung in `message_versions` ab. An der Nachricht steht „bearbeitet“; ein Tipp öffnet Original, Fassungen und Aktuell mit den Zeiten. |
| Schild | `messages.protected_at`. Geschützte Nachrichten, ihre Medien und Versionen löscht kein automatischer Lauf und kein „Speicher leeren“ ohne ausdrückliche Zusatzfreigabe (Abschnitt 4). |
| Einmal-Medien | Kennzeichnung `view_once`, Probe im Journal, Speichern hinter dem Schalter `store_view_once` (Standard aus; Abschnitt 3). |
| Medium jetzt laden | Der Ingest behält die Schlüssel nicht geladener Medien im privaten Speicher. Ein Tipp legt den Befehl `load_media` ab; der Ingest holt genau dieses Medium. |
| Sichern | Foto, Datei, Sprachnachricht und Video lassen sich auf dem Gerät sichern (Teilen-Blatt, sonst Download). |
| Medien-Platzhalter | Sie nennen Art, Größe und den Grund. Vorher stand bei jedem Video mit Regel „Aus“ fälschlich „nach Ablauf der Aufbewahrung gelöscht“. |
| Chatliste | Dauer von Sprachnachrichten, Absender in Gruppenvorschauen, lesbarer Name namenloser Gruppen, Initialen, stumme Chats. |
| Sprachnachricht | Geschwindigkeitstaste rechts neben der kürzeren Audiospur (mindestens 44 × 40 px). |
| Dokumente | Der Originalname wird angezeigt; der Download trägt ihn (vorher mit vorangestellter Nachrichten-ID). |
| Sticker | Ein WebP-Bild ohne Text wird als Sticker dargestellt (Heuristik). |
| Text | `*fett*`, `_kursiv_`, `~durchgestrichen~`, `` `code` ``; `@Nummer` wird mit bekanntem Namen ersetzt (Ingest, lokal). |
| Sonst | Chat-Leiste „N neue Nachrichten · Alle als gesehen“ statt schwebender Pille, Offline-Hinweis im Chat, Stumm-Knopf, Symbol für den Startbildschirm, ehrlichere Texte zu „sendet nichts“. |

Gekennzeichnet wird ausschließlich mit **Beschriftung und Symbol, nicht mit Farbe** (Entscheidung des Nutzers). „Neu“ bleibt gelb.

## 2. Beim Einspielen auf dem Pi

1. **Gesamtes Release einspielen, nie einzelne Dienste.** Die Datenbank wird beim Start von Ingest und Web auf Version 2 gehoben (`user_version` 1 → 2, nur `ADD COLUMN` und neue Tabellen). Der Cleanup-Dienst migriert nie.
2. **`/etc/waread/config.toml` von Hand ergänzen.** Eine vorhandene Konfiguration wird nie überschrieben. In ihr steht aus der Erstinstallation `hide_deleted_content = true`. Dann bleibt der Text gelöschter Nachrichten verborgen (nur der Hinweis erscheint). Zum Anzeigen: `hide_deleted_content = false` und den Web-Dienst neu starten (`sudo systemctl restart waread-web`).
3. `store_view_once` und `max_mb_forced` sind optional (Standard: aus bzw. 500 MB). Neue Schlüssel stehen in `config/config.example.toml`.
4. Nginx und die systemd-Units ändern sich nicht. Der Web-Dienst bleibt ohne ausgehenden Verkehr (`IPAddressDeny=any`).

**Warnung vor einem Rücksprung auf Version 1 (`docs/MAINTENANCE.md`, Abschnitt 8):** Der alte Cleanup-Dienst kennt das Schild nicht und löscht geschützte Nachrichten. Ingest und Web der alten Fassung weigern sich zwar, eine Version-2-Datenbank zu öffnen (`user_version 2, dieser Code kennt nur bis 1`), der alte Cleanup aber prüft das nicht. Vor einem Rücksprung die Cleanup-Timer anhalten (`sudo systemctl stop waread-cleanup.timer waread-cleanup-vacuum.timer`) und die Datenbank sichern.

## 3. Einmal-Medien

Bisher speicherte der Ingest sie absichtlich nicht (Hinweistext „Einmal-Ansehen-Medium (nicht gespeichert)“). Der Nutzer will sie speichern können.

- **Ob WhatsApp den Schlüssel für Einmal-Medien an dieses verknüpfte Gerät liefert: UNBEKANNT.** Es war keine Zweitnummer verfügbar, und es gab kein WhatsApp-Konto in der Entwicklungsumgebung. Aus dem Gedächtnis (nicht geprüft) zeigt WhatsApp auf verknüpften Geräten „auf dem Handy öffnen“.
- **Stufe 1 (eingebaut, kein zusätzlicher Verkehr):** Bei jeder Einmal-Nachricht schreibt der Ingest eine Journalzeile `viewonce_probe` mit Ja/Nein-Werten (`has_key`, `has_direct_path`, `has_url`, `has_sha`, `kind`, `stored`). Es steht kein Inhalt und kein Schlüssel im Journal. Auswerten, nachdem dir jemand ein Einmal-Foto und eine Einmal-Sprachnachricht geschickt hat:

  ```bash
  journalctl -u waread-ingest -o cat | grep viewonce_probe
  ```

  Steht überall `"has_key":false`, liefert WhatsApp den Schlüssel nicht, und der Schalter nützt nichts.
- **Live eintreffende Einmal-Medien (ergänzt mit 0.2.3):** WhatsApp stellt sie dem verknüpften Gerät nur als `<unavailable type="view_once"/>` zu, ohne Inhalt und ohne Schlüssel. GEMESSEN: Beim Test mit dem Zweitkonto zu 0.2.1 und in der Rückmeldung des Nutzers zu 0.2.2 erschien nur die Hinweiszeile. Die Journalzeile lautet dann `"kind":"unknown"`, `"has_key":false`, `"unavailable":true` (bis 0.2.2 fehlte sie für diesen Fall). Weder der Schalter noch „Jetzt laden“ helfen, denn es gibt nichts zu laden. Die Bibliothek fragt für diesen Fall auch nicht beim Handy nach (`baileys/lib/Utils/decode-wa-message.js` setzt nur `key.isViewOnce`, `Socket/messages-recv.js` fordert einen Placeholder-Resend nur bei anderen fehlenden oder nicht entschlüsselbaren Inhalten an; GELESEN). In der Oberfläche steht „Einmal-Medium (nur auf dem Handy zu öffnen)“.
- **Stufe 2 (nur bei `has_key: true`):** In `config.toml` unter `[ingest]` `store_view_once = true` setzen, `sudo systemctl restart waread-ingest`. Der Ingest lädt dann Einmal-Medien **bei Ankunft** wie jedes Auto-Download-Medium (ein HTTPS-Abruf je Medium, gleiche Regeln: Art, Größe). Die Journalzeile zeigt `"stored":true`; das Ergebnis des Abrufs steht wie bei allen Medien als `media_ready` bzw. `media_final` im Journal. Ob die Datei noch beim WhatsApp-Server liegt, wenn die Person sie am Handy schon geöffnet hat, ist UNBEKANNT; nur ein Abruf sofort bei Ankunft hat Aussicht auf Erfolg.
- **Kennzeichnung in der Oberfläche:** „Einmal-Foto“, „Einmal-Video“, „Einmal-Sprachnachricht“ als Beschriftung mit Symbol, dazu der Hinweis im Menü, dass der Absender „einmal“ wollte. Gespeicherte Einmal-Medien lassen sich beliebig oft ansehen oder anhören, sichern und mit dem Schild schützen.
- **Offen gelassen:** Der Schalter bleibt aus, bis du die Journalzeile gesehen hast. Das ist die vorsichtigste Wahl ohne Zweitnummer. Dass der Absender nichts davon erfährt, ist VERMUTUNG: waread sendet weder Lesebestätigung noch „abgespielt“; was WhatsApp dem Absender bei Einmal-Medien anzeigt, ist UNBEKANNT.

Der Absender erwartet bei Einmal-Medien, dass sie nicht bleiben. Der Schalter kehrt diese frühere Entscheidung des Projekts bewusst um; sie ist die des Nutzers.

## 4. Schild: die ausdrückliche Ausnahme von der kurzen Aufbewahrung

**Das Schild hebelt die Aufbewahrung (Standard 3 Tage) für die geschützten Nachrichten aus.** Das ist gewollt und die einzige Ausnahme.

- **Setzen:** Auf die Nachricht tippen, „Mit Schild schützen“ (oder das Schild-Symbol in der Bildansicht). Fehlt die Mediendatei und liegen die Schlüssel bereit, lädt der Ingest sie zugleich (ein HTTPS-Abruf).
- **Wirkung an allen vier Löschstellen** (jede hat Tests): `cleanup/cleanup.ts` (Nachrichten, Medien-Ablauf, Probelauf), `db/client.ts` `deleteExpired`, `services/web/src/queries.ts` `deleteChatData` und die Medien-Warteschlange des Ingest (ein geschütztes Medium läuft nicht ab). Der Orphan-Sweep fasst geschützte Dateien nicht an, weil sie in der Datenbank verzeichnet sind.
- **Speicher leeren** hat zwei Wege. „Ohne geschützte“ lässt sie stehen. „Auch geschützte“ ist der einzige Weg, sie zu löschen: eigener Bestätigungstext mit Zahl und Größe, „kein Backup“, eigenes Wort `GESCHÜTZTE LÖSCHEN`. Die Schnittstelle verlangt dafür `includeProtected` mit genau dem Wert `true`.
- **Kein Backup.** `/var/lib/waread` gehört nicht in Sicherungen (`jobStore.ts`). Fällt die Speicherkarte aus, sind geschützte Nachrichten weg. Der Speicher wächst mit jeder geschützten Nachricht; das Speicherlimit der Einstellungen ist weiter nur eine Anzeige. Die Einstellungen nennen Zahl und Größe der geschützten Nachrichten.
- **Sicherheit:** Mehr sensible Daten liegen länger auf dem Pi. Ob die Speicherkarte verschlüsselt ist: UNBEKANNT. Passwort, Passkey-Sperre, CSP und das Netzverbot des Web-Dienstes sind unverändert.

## 5. Zusätzlicher Verkehr zu WhatsApp

Version 2 sendet **keine** neuen Nachrichten, Quittungen, Presence- oder sonstigen WebSocket-Knoten. `messages.update` ist ein Empfangsereignis, das die Bibliothek lokal aus ohnehin empfangenen Nachrichten erzeugt (`process-message.js`, gelesen).

| Funktion | Verkehr |
| --- | --- |
| Alles in der Oberfläche (Zitate, Verlauf, Schild, Stumm, Formatierung, Layout) | keiner |
| Löschen/Bearbeiten erkennen | keiner zusätzlich |
| Einmal-Probe (Stufe 1) | keiner |
| **Medium jetzt laden** (auch beim Setzen des Schilds an einer Nachricht mit ladbarem Medium) | **ein HTTPS-Abruf an den Medienhost (`*.whatsapp.net`) je Medium, vom Ingest ausgelöst, nur auf Wunsch.** Laut `docs/VERKEHR.md` ist der Medien-Download kein WebSocket-Knoten. `downloadContentFromMessage` ist nicht auf versteckte Sendeaufrufe geprüft. |
| **Einmal-Medien speichern** (`store_view_once = true`) | ein HTTPS-Abruf je Einmal-Medium bei Ankunft, wie beim Auto-Download |

Der Sende-Wächter (`npm run check:no-send`, 32 Prüfungen) ist unverändert grün; die Hülle `waLib.ts` reicht weiter nur `ev.on`, `ev.off` und `end` durch.

## 6. Was geprüft ist und was nicht

Geprüft (Testlauf in der Entwicklungsumgebung, Node 22, Chromium):
- Datenbank 34, Ingest 338, Cleanup 38, Web-Smoke 317, Passkey 168, Formatierung 7 Prüfungen.
- Browsertests `e2e-frontend.mjs` (16) und `e2e-frontend-v2.mjs` (52), darunter das Zwei-Spalten-Layout mit 21 Chats (ohne die CSS-Zeile schlägt der Test fehl: Seite 1897 px statt 900 px hoch).
- Die Tests `service.e2e.test.ts` decken den Weg „Ereignis → Datenbank → Befehl → Download → fertig“ mit einer gefälschten Bibliothek ab.

**Nicht geprüft:**
- Safari/WebKit und ein echtes iPhone: Teilen-Blatt (Web Share API mit Datei), Verhalten als Startbildschirm-App, Dynamic Island (alle Kopfzeilen nutzen `env(safe-area-inset-top)`, Chromium kennt keine Sicherheitsränder), Auswahlfelder, Audio.
- Echte WhatsApp-Daten: Ob Löschungen und Bearbeitungen so ankommen, wie der Quelltext der Bibliothek es erwarten lässt, ob Zitate und Erwähnungen die erwarteten Felder tragen (`contextInfo.quotedMessage`, `mentionedJid`), ob Einmal-Medien Schlüssel enthalten.
- Echter Pi, Nginx davor, ffmpeg, Speicherkarte.
- Die Dauer, die Medienlinks bei WhatsApp gültig bleiben (bestimmt, wie lange „Medium jetzt laden“ funktioniert): UNBEKANNT.
- Die Sticker-Erkennung ist eine Heuristik (WebP ohne Text).

## 7. Abweichungen von den ersten Vorschlägen (`VORSCHLAEGE.md`)

- Statt eines gelben Rahmens für Einmal-Medien und eines rötlichen Hintergrunds für gelöschte Nachrichten: **nur Beschriftung** (auf Wunsch des Nutzers; Gelb heißt „neu“).
- Geschwindigkeitstaste **rechts** neben der Audiospur (nicht darunter), Audiospur dafür 30 statt 42 Balken.
- Der obere Rand für die Dynamic Island war schon vorhanden und ist unverändert.
- Neu gegenüber dem Papier: die Schnittstelle `POST api/media/:id/load` und der Befehlskanal `ingest_commands` (Web → Ingest), weil der Web-Dienst nie selbst Verkehr erzeugen darf.
