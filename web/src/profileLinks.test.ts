import { describe, expect, it } from 'vitest';
import { linkLabel, normalizeLinks } from './profileLinks';

describe('ссылки профиля', () => {
  it('схема дописывается, повторы и пустые убираются', () => {
    expect(normalizeLinks(['t.me/nina', ' ', 'https://t.me/nina', 'http://example.com'])).toEqual({
      links: ['https://t.me/nina', 'http://example.com/'],
    });
  });

  it('не сайт, без домена, больше трёх — ошибка', () => {
    expect(normalizeLinks(['javascript:alert(1)'])).toHaveProperty('error');
    expect(normalizeLinks(['localhost'])).toHaveProperty('error');
    expect(normalizeLinks(['a.ru', 'b.ru', 'c.ru', 'd.ru'])).toHaveProperty('error');
  });

  it('подпись — без схемы, www и косой черты', () => {
    expect(linkLabel('https://www.example.com/')).toBe('example.com');
    expect(linkLabel('https://t.me/nina')).toBe('t.me/nina');
  });
});
