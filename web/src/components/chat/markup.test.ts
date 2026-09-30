import { describe, expect, it } from 'vitest';
import { applyMark, firstUrl, markForKey, parseMarkup, plainText, SPOILER_STUB } from './markup';

/** Дерево в короткой записи: так ожидания читаются глазами. */
const show = (text: string) => {
  const walk = (nodes: ReturnType<typeof parseMarkup>): string =>
    nodes
      .map((n) => {
        switch (n.t) {
          case 'text': return n.s;
          case 'url': return `<url ${n.url}>`;
          case 'code': return `<code ${n.s}>`;
          case 'pre': return `<pre ${n.s}>`;
          default: return `<${n.t} ${walk(n.children)}>`;
        }
      })
      .join('');
  return walk(parseMarkup(text));
};

describe('разметка текста', () => {
  it('жирный, курсив, зачёркнутый, спойлер и вложенность', () => {
    expect(show('**жирный** и __курсив__')).toBe('<bold жирный> и <italic курсив>');
    expect(show('~~было~~ ||стало||')).toBe('<strike было> <spoiler стало>');
    expect(show('**жирный __и курсив__**')).toBe('<bold жирный <italic и курсив>>');
  });

  it('знак у пробела, пустое и незакрытое — остаются текстом', () => {
    expect(show('2 ** 3 = 8')).toBe('2 ** 3 = 8');
    expect(show('****')).toBe('****');
    expect(show('**не закрыто')).toBe('**не закрыто');
    expect(show('**снаружи __внутри** хвост')).toBe('<bold снаружи __внутри> хвост');
  });

  it('в коде разметки нет; блок кода — без первой и последней пустой строки', () => {
    expect(show('`**не жирный**` и **жирный**')).toBe('<code **не жирный**> и <bold жирный>');
    expect(show('```\nconst a = 1;\n```')).toBe('<pre const a = 1;>');
    expect(show('`незакрытый код')).toBe('`незакрытый код');
  });

  it('ссылка — целиком, знаки вокруг неё — разметка', () => {
    expect(show('**https://example.com/a__b__c**')).toBe('<bold <url https://example.com/a__b__c>>');
    expect(show('см. https://example.com.')).toBe('см. <url https://example.com>.');
    expect(firstUrl('`https://code.example` и https://real.example')).toBe('https://real.example');
    expect(firstUrl('||https://hidden.example||')).toBeNull();
  });

  it('превью — без знаков, спойлер скрыт; копирование — со спойлером', () => {
    expect(plainText('**Итог:** ||он был убийцей|| `x`')).toBe(`Итог: ${SPOILER_STUB} x`);
    expect(plainText('||тайна||', 'show')).toBe('тайна');
  });

  it('сервер снимает разметку так же, как клиент', async () => {
    // Сервер — отдельный пакет: берём его модуль как есть, через сборщик.
    const modules = import.meta.glob<{ plainText: (s: string) => string }>('../../../../server/src/markup.js');
    const server = await Object.values(modules)[0]();
    for (const s of [
      '**жирный __и курсив__** ~~нет~~',
      '2 ** 3 и ****',
      '**снаружи __внутри** хвост',
      '`**код**` ```\nблок\n``` ||спойлер||',
      '**https://example.com/a__b__c**, ok',
      '@nina **@demo** __snake__case__',
    ]) {
      expect(server.plainText(s)).toBe(plainText(s));
    }
  });
});

describe('оформление в поле ввода', () => {
  it('оборачивает выделение, оставляя пробелы снаружи', () => {
    expect(applyMark('скажи привет всем', 6, 13, '**')).toEqual({ text: 'скажи **привет** всем', start: 8, end: 14 });
  });

  it('повторное нажатие разворачивает', () => {
    expect(applyMark('скажи **привет** всем', 8, 14, '**')).toEqual({ text: 'скажи привет всем', start: 6, end: 12 });
  });

  it('без выделения — пара знаков с кареткой посередине; многострочный код — блоком', () => {
    expect(applyMark('ab', 1, 1, '||')).toEqual({ text: 'a||||b', start: 3, end: 3 });
    expect(applyMark('x\ny', 0, 3, '`').text).toBe('```x\ny```');
  });

  it('горячие клавиши — по клавише, а не по букве раскладки', () => {
    const k = (code: string, shift = false) => markForKey({ key: 'и', code, ctrlKey: true, metaKey: false, shiftKey: shift, altKey: false });
    expect(k('KeyB')).toBe('**');
    expect(k('KeyI')).toBe('__');
    expect(k('KeyX', true)).toBe('~~');
    expect(k('KeyM', true)).toBe('`');
    expect(k('KeyP', true)).toBe('||');
    expect(k('KeyX')).toBeNull();
  });
});
