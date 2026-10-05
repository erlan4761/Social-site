import { describe, expect, it } from 'vitest';
import { tagFromParam, tagsIn } from './hashtags';

describe('разбор хэштегов', () => {
  it('ключ без регистра и «ё», подпись — как написано; без повторов', () => {
    expect(tagsIn('#Плёнка, #ПЛЕНКА и #ночь.')).toEqual([
      { tag: 'пленка', label: 'плёнка' },
      { tag: 'ночь', label: 'ночь' },
    ]);
  });

  it('не тег: номер, середина слова, якорь адреса, один знак', () => {
    expect(tagsIn('#1 a#b site.ru/#about &#39; #я')).toEqual([]);
  });

  it('не больше десяти', () => {
    expect(tagsIn(Array.from({ length: 12 }, (_, i) => `#тег${i}`).join(' '))).toHaveLength(10);
  });

  it('из адреса: решётка и регистр не важны, мусор — null', () => {
    expect(tagFromParam('#Плёнка')).toBe('пленка');
    expect(tagFromParam('пленка')).toBe('пленка');
    expect(tagFromParam('12')).toBeNull();
    expect(tagFromParam('#!')).toBeNull();
  });
});
