import type { ReactNode } from 'react';

/**
 * Свёртка `ё → е`. Ровно тот же `replace`, что стоит в `server/src/search.js`
 * и в триггерах FTS-индекса: набравший «пленка» обязан найти «плёнку».
 * Замена посимвольная 1:1, длина строки не меняется — поэтому смещения,
 * найденные в свёрнутой копии, годятся для резки исходного текста.
 */
export const foldSearchText = (value: string) => value.replace(/ё/g, 'е').replace(/Ё/g, 'Е');

/**
 * Термы запроса. Правила повторяют `ftsQuery()`: свёртка `ё`, нижний регистр,
 * разбиение по не-буквам, потолок в восемь слов. Мусорный запрос («***», одни
 * пробелы, `a-b`) даёт пустой массив — подсвечивать нечего, и это не сбой.
 */
export function searchTerms(raw: string): string[] {
  return foldSearchText(raw)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length > 0)
    .slice(0, 8);
}

/**
 * Режет текст на куски и оборачивает совпадения в `<mark>`.
 *
 * Возвращает React-узлы, а **не** строку с разметкой: тело записи — это
 * пользовательский ввод, и склейка подсветки строкой с последующим
 * `dangerouslySetInnerHTML` была бы обычным XSS. Побочная выгода того же
 * решения: `<` и `&`, набранные человеком, остаются на экране символами,
 * а не превращаются в теги и сущности.
 *
 * Подсвечивается слово целиком, хотя поиск ищет по началу слова: запрос
 * «проявк» находит «проявка», и подсвеченный корень с хвостом «а» вне
 * подсветки читался бы как сбой отрисовки, а не как объяснение правил поиска.
 */
export function highlight(text: string, terms: string[]): ReactNode[] {
  if (terms.length === 0 || text.length === 0) return [text];

  // Свёрнутая копия нужна только чтобы найти границы слов и сравнить их с
  // термами; на экран идут куски исходного `text`, с сохранённой «ё».
  const folded = foldSearchText(text);
  // Литерал объявлен внутри функции намеренно: у глобальной регулярки живёт
  // `lastIndex`, и общий экземпляр на втором вызове начал бы читать с середины.
  // Граница слова — та же, что у токенизатора `unicode61` на сервере.
  const word = /[\p{L}\p{N}_]+/gu;

  const nodes: ReactNode[] = [];
  let cut = 0;
  let match: RegExpExecArray | null;

  while ((match = word.exec(folded)) !== null) {
    // Регистр приводим у одного слова, а не у всей строки: у пары символов
    // (турецкая «İ») нижний регистр длиннее верхнего, и смещения бы съехали.
    if (!terms.some((term) => match![0].toLowerCase().startsWith(term))) continue;

    const start = match.index;
    const end = start + match[0].length;
    if (start > cut) nodes.push(text.slice(cut, start));
    nodes.push(<mark key={start}>{text.slice(start, end)}</mark>);
    cut = end;
  }

  if (cut < text.length) nodes.push(text.slice(cut));
  return nodes;
}
