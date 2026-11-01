// Anzeigename eines Chats. Rein (ohne DOM), damit er sich unter Node testen laesst.

/**
 * Die API faellt auf den lokalen Teil der Kennung zurueck, wenn ein Chat keinen Namen hat; hier wird daraus etwas Lesbares.
 *
 * Eine LID (`...@lid`) ist eine WhatsApp-interne Kennung und KEINE Telefonnummer. Sie wurde frueher mit vorangestelltem "+"
 * wie eine Nummer angezeigt. Jetzt steht dort "Unbekannter Kontakt" mit den letzten vier Ziffern, damit sich mehrere
 * unbekannte Kontakte in der Liste unterscheiden lassen.
 */
export function chatName(id: string, name: string | undefined, isGroup: boolean): string {
  const idName = id.split('@')[0] ?? id;
  if (name === undefined || name === '' || name === idName) {
    if (isGroup) return 'Unbenannte Gruppe';
    if (id.endsWith('@lid')) return idName ? `Unbekannter Kontakt …${idName.slice(-4)}` : 'Unbekannter Kontakt';
    return /^\d{6,}$/.test(idName) ? `+${idName}` : idName || id;
  }
  return name;
}
