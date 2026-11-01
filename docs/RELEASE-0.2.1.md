# Release 0.2.1

Stand: 1. November 2026. Vorgänger: 0.2.0. Gewissheitsstufen: **GEMESSEN** (am laufenden System mit einer Zweitnummer), **GELESEN** (im Quelltext von waread oder der Bibliothek), **VERMUTUNG**.

Dieses Release behebt Fehler, die ein Test mit einem echten Zweitkonto gezeigt hat. Es ändert nichts an `config.toml`, nichts am Schema der gemeinsamen Datenbank und stellt keine zusätzlichen Anfragen an WhatsApp.

## 1. Inhalt

| Fund | Ursache | Änderung |
| --- | --- | --- |
| Eine **Bearbeitung** erschien als neue Zeile „Nicht unterstützter Nachrichtentyp“, die Originalnachricht blieb unverändert. GEMESSEN. | Neuere WhatsApp-Apps schicken Bearbeitungen verschlüsselt als `secretEncryptedMessage` (Typ `MESSAGE_EDIT`). Die Bibliothek (Baileys 7.0.0-rc14, auch die neueste Fassung) meldet das nur als Nachricht. Die Klartext-Bearbeitung (`protocolMessage.editedMessage`, auch in der `editedMessage`-Hülle) funktioniert; `services/ingest/test/baileysEdit.test.ts` belegt es mit der echten Bibliothek für beide Formen. Dass die echte Bearbeitung das verschlüsselte Format trug, ist aus dem Symptom und zwei unabhängigen Referenzimplementierungen (whatsmeow, wacore) abgeleitet: VERMUTUNG mit guter Stütze. | `secretEdit.ts` entschlüsselt sie lokal mit dem Geheimnis der **Originalnachricht** (HKDF-SHA256, AES-256-GCM). Der neue Text erscheint, die alte Fassung landet im Bearbeitungsverlauf. Keine Zeile mehr für die Bearbeitung selbst. |
| Ein **Einmal-Foto** (Einmal-Medium) erschien gar nicht. GEMESSEN. | WhatsApp stellt Einmal-Medien einem verknüpften Gerät live nur als `<unavailable type="view_once"/>` ohne Inhalt zu. waread verwarf das als „ohne Inhalt“. GELESEN (`baileys/lib/Utils/decode-wa-message.js`). | Hinweiszeile „Einmal-Ansehen-Medium (nicht gespeichert)“. Gespeichert werden kann nichts, es gibt keinen Inhalt. |
| Umfragen neuerer Versionen erschienen als „nicht unterstützt“. | `pollCreationMessageV4` und `V5` fehlten in der Liste. | Werden wie andere Umfragen angezeigt. |
| Anheften, Album-Kopfzeile und reine Schlüsselverteilungen erzeugten eine Platzhalterzeile. | Unbekannte Steuernachrichten. | Erzeugen keine Zeile mehr. |
| **Dieselbe Person als zwei Chats** (LID und Nummer). GEMESSEN: 2 solche Chats in den Testdaten. | Die Bibliothek führt LID-Zuordnungen im Schlüsselspeicher (`lid-mapping`); waread nutzte sie nicht, und WhatsApp meldet sie oft nicht. | Die Zuordnung wird dort nachgeschlagen (nur lesend, lokal) und übernommen. `reconcileLidChats()` führt bestehende LID-Chats beim Start, nach dem Verlauf und bei jeder neuen Zuordnung in den Nummern-Chat zusammen (Transaktion, Suchindex bleibt konsistent). Keine Nachricht geht verloren. |
| **Chatnamen** erschienen erst mit der nächsten Nachricht. GELESEN. | Namen wurden nur beim Speichern einer Nachricht in die Chatliste geschrieben. | `renameChat()` zieht die Namen bestehender Chats sofort nach (legt nie einen Chat an) und lädt die Chatliste neu. |
| Nachrichten **derselben Sekunde** standen in zufälliger Reihenfolge. GEMESSEN. | Die Oberfläche sortierte bei gleichem Zeitstempel nach der Nachrichten-ID (Zufallswert). | Stabile Sortierung: Ankunftsreihenfolge des Servers. Bei älteren Seiten stehen deren Nachrichten derselben Sekunde vor den vorhandenen. |
| Eine **LID** erschien als „+Ziffern“ wie eine Telefonnummer. GEMESSEN. | Rückfall der Anzeige auf den lokalen Teil der Kennung. | „Unbekannter Kontakt …1234“ (letzte vier Ziffern). |
| Der **Abspiel-Fortschritt** einer Sprachnachricht ruckelte. GEMESSEN. | Aktualisierung nur über `timeupdate` (etwa 4 mal je Sekunde). | Ein gleitender Punkt, aktualisiert je Bild: 54 verschiedene Positionen in 2 Sekunden statt etwa 8. |
| `connect`, `avatar/refresh` und `played` gingen **ohne Content-Type** durch. GEMESSEN. | Nur `SameSite=Strict` schützte vor Anfragen fremder Seiten; andere Anwendungen auf demselben Rechner (anderer Port) gelten als dieselbe „Site“. | Jede schreibende Anfrage (POST, PUT) verlangt `application/json`, auch ohne Daten. Die Oberfläche sendet das jetzt immer. Ohne Header: 415. |
| Journal | Unbekannte oder verworfene Nachrichten ließen sich nicht einordnen. | Journalzeilen `message_unsupported` und `message_ignored_live` mit **Feldnamen** der Nachricht (z. B. `secretEncryptedMessage:2`), nie Inhalte. |

## 2. Daten und Datenschutz

- `ingest-state.db` (privat, Rechte 0600) bekommt die Tabelle `msg_secrets`: das `messageSecret` je eingegangener Nachricht (32 Byte). Es dient nur zum Lesen einer späteren Bearbeitung derselben Nachricht, liegt wie die Medienschlüssel im privaten Speicher des Ingest, erscheint nie im Journal und nie in der gemeinsamen Datenbank. Aufräumen: Aufbewahrung plus zwei Tage; „Speicher leeren → alles“ und das Abmelden löschen sie mit den Namen.
- Nachrichten, die **vor** diesem Update eintrafen, haben kein Geheimnis. Eine Bearbeitung solcher Nachrichten bleibt ungelesen (Journal `edit_secret_missing`), es entsteht aber auch keine falsche Zeile mehr.
- Die Zusammenführung der LID-Chats läuft beim ersten Start einmal (Journal `lid_chats_merged`). Alle Nachrichten bleiben erhalten; der Chat heißt danach wie der Nummern-Chat.
- Das Schema der gemeinsamen Datenbank ist unverändert (`user_version` bleibt).

## 3. Verkehr

Keine zusätzlichen Knoten und keine zusätzlichen Abrufe. Die Entschlüsselung, das Lesen des Schlüsselspeichers und das Zusammenführen sind lokal. Der Sende-Wächter (`npm run check:no-send`) ist unverändert und grün; die Hülle `waLib.ts` reicht weiter nur `ev.on`, `ev.off`, `end` und `profilePicture` durch. Neu ist dort nur `decodeMessage`, das Bytes liest und nichts sendet.

## 4. Bauen und einspielen

Wie in `docs/RELEASE-0.2.0.md`, Abschnitte 2 und 3. `config.toml` bleibt unverändert. Nach dem Einspielen den Ingest neu starten (macht `waread-update`).

## 5. Prüfen nach dem Einspielen

| Was | Erwartung |
| --- | --- |
| Von einem zweiten Konto eine **neue** Nachricht senden, dann bearbeiten | In der Oberfläche steht der neue Text mit „bearbeitet“, ein Tipp zeigt Original und Fassungen. Journal: `edit_decrypted`, `message_edit_stored`. |
| Ein Einmal-Foto senden | Eine Zeile „Einmal-Ansehen-Medium (nicht gespeichert)“. |
| Bearbeitet sich nichts | Journal prüfen: `edit_secret_missing` (Original kam vor dem Update), `edit_decrypt_failed` (Geheimnis oder JID passt nicht), `edit_without_text`, `message_unsupported` mit `kinds`. Die Feldnamen zeigen, in welcher Form WhatsApp die Bearbeitung schickte. |
| Zwei Chats derselben Person | Nach dem ersten Start nur noch einer. |

## 6. Tests

Sende-Wächter 34, DB-Paket 43, Ingest 448 (445 bestanden, 3 übersprungen, weil `ffmpeg` fehlt), Web-Smoke 347, Passkey 168, Cleanup 38, Frontend 21; die 7 Formatierungstests aus 0.2.0 sind in den 21 Frontend-Tests enthalten. Gemessen mit Node 22.23.4 auf x86_64. Neu gegenüber 0.2.0: Entschlüsselung (Vektor unabhängig mit Python berechnet, Manipulationen, Fälschung durch Fremde, alle Schreibweisen), Handler (Bearbeitung in Einzelchat, Gruppe, eigene Nachricht, Fehlerfälle ohne Zeile), Einmal-Medien live, Zusammenführen und Umbenennen samt Suchindex, Content-Type-Sperre, Reihenfolge, Anzeige der LID.

## 7. Ungeprüft und offen

- **Live-Prüfung von Bearbeitung und Einmal-Foto mit dieser Version steht aus.** Belegt ist beides durch Tests und den Quelltext. Das genaue Format der echten Bearbeitung wurde nicht mitgeschnitten.
- Bekannt, **nicht geändert**:
  - Die Bibliothek sendet bei Namensänderungen im Konto ein `presence` ohne Typ (`socket.js`, `creds.update`). Gemessen: 3 Stück beim Aufbau. Ob das das Konto für Dritte „online“ zeigt, ist UNBEKANNT. Eine Änderung würde den Sende-Wächter oder die Hülle berühren und ist deshalb nicht Teil dieses Releases.
  - Abmelden macht das Sitzungstoken serverseitig nicht ungültig (bis `session_days`); so ist es dokumentiert.
  - Reaktionen und Umfrage-Stimmen werden nicht angezeigt.
  - „Alle als gesehen“ verschwindet, sobald alle neuen Nachrichten eine Sekunde im Bild waren; das gilt nur lokal und entspricht dem Text in den Einstellungen.
  - „Vom Absender gelöscht · Uhrzeit“ zeigt den Zeitpunkt, zu dem waread die Löschung verarbeitet. Bei laufendem Ingest ist das die Löschzeit, nach einem Ausfall der Zeitpunkt des Nachholens.
