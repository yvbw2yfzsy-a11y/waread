import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chatName } from '../src/chatLabel.ts';

describe('chatName', () => {
  it('ein vorhandener Name gewinnt immer', () => {
    assert.equal(chatName('491701234567@s.whatsapp.net', 'Anna', false), 'Anna');
    assert.equal(chatName('99887766@lid', 'Bert', false), 'Bert');
    assert.equal(chatName('1203@g.us', 'Familie', true), 'Familie');
  });

  it('Nummern-Chat ohne Namen zeigt die Nummer mit Plus', () => {
    assert.equal(chatName('491701234567@s.whatsapp.net', undefined, false), '+491701234567');
    assert.equal(chatName('491701234567@s.whatsapp.net', '', false), '+491701234567');
    assert.equal(chatName('491701234567@s.whatsapp.net', '491701234567', false), '+491701234567', 'API-Rueckfall auf die Kennung');
  });

  it('eine LID ist KEINE Telefonnummer: kein Plus, "Unbekannter Kontakt" mit den letzten vier Ziffern', () => {
    assert.equal(chatName('99887766@lid', undefined, false), 'Unbekannter Kontakt …7766');
    assert.equal(chatName('99887766@lid', '99887766', false), 'Unbekannter Kontakt …7766');
    assert.equal(chatName('123456789012345@lid', '', false), 'Unbekannter Kontakt …2345');
    assert.ok(!chatName('99887766@lid', undefined, false).startsWith('+'));
  });

  it('kurze oder leere LID-Kennung', () => {
    assert.equal(chatName('12@lid', undefined, false), 'Unbekannter Kontakt …12');
    assert.equal(chatName('@lid', undefined, false), 'Unbekannter Kontakt');
  });

  it('Gruppe ohne Namen', () => {
    assert.equal(chatName('1203@g.us', undefined, true), 'Unbenannte Gruppe');
    assert.equal(chatName('1203@g.us', '1203', true), 'Unbenannte Gruppe');
  });

  it('andere Kennungen bleiben, wie sie sind', () => {
    assert.equal(chatName('abc@s.whatsapp.net', undefined, false), 'abc');
    assert.equal(chatName('12345@s.whatsapp.net', undefined, false), '12345', 'unter 6 Ziffern keine Nummer');
  });
});
