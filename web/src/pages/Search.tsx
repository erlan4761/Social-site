import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, type Author, type PhoneMatch, type Post } from '../api';
import { Monogram } from '../components/Monogram';
import { PostRow } from '../components/PostRow';
import { TrendingTags } from '../components/TrendingTags';
import { tagFromParam, tagPath } from '../hashtags';
import { canPickContacts, pickContactPhones } from '../contacts';
import { searchTerms } from '../highlight';
import { dialOf, formatPhone, looksLikePhone } from '../phone';
import { useSession } from '../session';
import { plural } from '../time';

/** Люди здесь — короткая подсказка сбоку от главного: их полный список живёт
 *  в выпадающем поиске в шапке, и второй бесконечной ленты тут не нужно. */
const PEOPLE_LIMIT = 5;

/** Столько же, сколько сервер оставляет от `q`. Показывать в заголовке больше,
 *  чем реально искали, — мелкая, но неправда. */
const QUERY_LIMIT = 100;

export function Search() {
  const [params] = useSearchParams();
  const { user } = useSession();
  const query = (params.get('q') ?? '').trim().slice(0, QUERY_LIMIT);

  const [posts, setPosts] = useState<Post[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<Author[] | null>(null);
  // По номеру ищут только вошедшие: гостю сервер ответит 401.
  const phoneQuery = user != null && looksLikePhone(query);
  const [byPhone, setByPhone] = useState<PhoneMatch[] | null>(null);

  useEffect(() => {
    if (!query) {
      setPosts([]);
      setTerms([]);
      setCursor(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .searchPosts(query)
      .then((page) => {
        if (cancelled) return;
        setPosts(page.posts);
        setCursor(page.nextCursor);
        // Термы берём из `query` ответа, а не из строки ввода: пока запрос шёл,
        // человек мог набрать в шапке уже другое слово, и подсветка разошлась бы
        // с выдачей. Сниппет сервер не отдаёт намеренно — в индексе лежит
        // свёрнутый текст, и «плёнка» показалась бы там «пленкой».
        setTerms(searchTerms(page.query));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось выполнить поиск');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => {
    if (!query) {
      setPeople(null);
      return;
    }

    let cancelled = false;
    setPeople(null);

    api
      .searchUsers(query)
      .then((res) => !cancelled && setPeople(res.users.slice(0, PEOPLE_LIMIT)))
      // Люди — довесок к записям: их неудача не должна занимать собой экран,
      // на котором главный результат уже показан.
      .catch(() => !cancelled && setPeople([]));

    return () => {
      cancelled = true;
    };
  }, [query]);

  // Набран номер с «+» — ищем человека и по нему. Отдельным блоком: ответ
  // сервера не различает «номера нет» и «не разрешил находить», и подпись
  // под пустым результатом говорит об этом честно.
  useEffect(() => {
    if (!phoneQuery) {
      setByPhone(null);
      return;
    }
    let cancelled = false;
    setByPhone(null);
    api
      .findByPhone([query])
      .then((res) => !cancelled && setByPhone(res.users))
      .catch(() => !cancelled && setByPhone([]));
    return () => {
      cancelled = true;
    };
  }, [query, phoneQuery]);

  const loadMore = useCallback(async () => {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.searchPosts(query, { cursor });
      setPosts((prev) => {
        // Keyset по `id DESC` дублей не даёт, но страховка стоит один Set:
        // между страницами кто-то мог удалить запись и сдвинуть выдачу.
        const seen = new Set(prev.map((post) => post.id));
        return [...prev, ...page.posts.filter((post) => !seen.has(post.id))];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить ещё');
    } finally {
      setLoadingMore(false);
    }
  }, [query, cursor, loadingMore]);

  const patch = useCallback((id: number, changes: Partial<Post>) => {
    setPosts((prev) => prev.map((post) => (post.id === id ? { ...post, ...changes } : post)));
  }, []);

  const remove = useCallback(async (id: number) => {
    const snapshot = posts;
    setPosts((prev) => prev.filter((post) => post.id !== id));
    try {
      await api.deletePost(id);
    } catch (err) {
      setPosts(snapshot);
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить запись');
    }
  }, [posts]);

  // «#плёнка» в строке поиска — скорее всего, тег: ссылка на его ленту сверху.
  const queryTag = query.trim().startsWith('#') ? tagFromParam(query) : null;

  return (
    <>
      <div className="events-top">
        <h1 className="page-title">Поиск</h1>
        <Link className="btn ghost small" to="/">
          Вернуться в ленту
        </Link>
      </div>

      {query ? (
        <p className="search-lede">
          {phoneQuery
            ? `По номеру ${formatPhone(query.replace(/[^\d+]/g, ''))} — человек, если он разрешил находить себя по номеру.`
            : `По запросу «${query}» — записи целиком и люди по имени.`}
        </p>
      ) : (
        <p className="search-lede">
          Наберите слово в строке поиска наверху — найдутся записи, где оно есть. Номер телефона — целиком, с «+» и
          кодом страны.
        </p>
      )}

      {error && <p className="error">{error}</p>}

      {phoneQuery && (
        <section className="search-section" aria-labelledby="search-phone">
          <h2 className="search-section-title" id="search-phone">
            По номеру телефона
          </h2>
          {byPhone === null ? (
            <p className="empty flush">Ищу…</p>
          ) : byPhone.length === 0 ? (
            <p className="empty flush">
              <strong>Никого.</strong>
              Либо этого номера нет в Хронике, либо человек не разрешил находить себя по номеру.
            </p>
          ) : (
            <PeopleList people={byPhone} />
          )}
        </section>
      )}

      {queryTag && (
        <p className="search-lede">
          <Link className="tag-link" to={tagPath(queryTag)}>
            Все записи с тегом #{queryTag}
          </Link>
        </p>
      )}

      {!query && <TrendingTags />}

      {!query && user && canPickContacts() && <FromContacts />}

      {/* Номер — не слово: записи и имена по нему искать незачем. */}
      {!phoneQuery && (
        <section className="search-section" aria-labelledby="search-posts">
          <h2 className="search-section-title" id="search-posts">
            Записи
          </h2>

          {!query ? (
            <p className="empty flush">Поиск идёт по началу слова: «проявк» найдёт и «проявку», и «проявкой».</p>
          ) : loading ? (
            <p className="empty flush">Ищу…</p>
          ) : posts.length === 0 ? (
            <p className="empty flush">
              <strong>Ничего не нашлось.</strong>
              Попробуйте одно слово вместо двух — они ищутся вместе, а не по отдельности.
            </p>
          ) : (
            <div className="rail">
              {posts.map((post) => (
                <PostRow
                  key={post.id}
                  post={post}
                  canDelete={post.author.id === user?.id}
                  highlight={terms}
                  onDelete={(id) => void remove(id)}
                  onPatch={patch}
                />
              ))}
            </div>
          )}

          {cursor != null && (
            <div className="more">
              <button className="btn ghost" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Загружаю…' : 'Показать ещё'}
              </button>
            </div>
          )}
        </section>
      )}

      {query && !phoneQuery && (
        <section className="search-section" aria-labelledby="search-people">
          <h2 className="search-section-title" id="search-people">
            Люди
          </h2>

          {people === null ? (
            <p className="empty flush">Ищу…</p>
          ) : people.length === 0 ? (
            <p className="empty flush">Никого с таким именем нет.</p>
          ) : (
            <PeopleList people={people} />
          )}
        </section>
      )}
    </>
  );
}

function PeopleList({ people }: { people: Author[] }) {
  return (
    <ul className="people-list">
      {people.map((person) => (
        <li key={person.id}>
          <Link className="people-hit" to={`/u/${person.username}`}>
            <Monogram username={person.username} displayName={person.displayName} avatarUrl={person.avatarUrl} size="sm" />
            <span>
              <strong>{person.displayName}</strong>
              <span className="people-handle">@{person.username}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * «Друзья из контактов» — только там, где браузер умеет открыть выбор
 * контактов (Chrome на Android). Человек сам отмечает, кого искать; местные
 * номера дополняются кодом страны его собственного номера.
 */
function FromContacts() {
  const [found, setFound] = useState<PhoneMatch[] | null>(null);
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    setBusy(true);
    setError(null);
    try {
      const { phone } = await api.account();
      const phones = await pickContactPhones(dialOf(phone));
      if (phones.length === 0) return;
      setAsked(phones.length);
      setFound((await api.findByPhone(phones)).users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось открыть контакты');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="search-section" aria-labelledby="search-contacts">
      <h2 className="search-section-title" id="search-contacts">
        Друзья из контактов
      </h2>
      <p className="empty flush">
        Отметьте людей в контактах телефона — покажем, кто из них уже здесь. Адресная книга целиком на сервер не
        уходит.
      </p>
      <button className="btn ghost" type="button" onClick={() => void pick()} disabled={busy}>
        {busy ? 'Ищу…' : 'Выбрать контакты'}
      </button>
      {error && <p className="error">{error}</p>}
      {found && found.length === 0 && (
        <p className="empty flush">
          Из {asked} {plural(asked, 'номера', 'номеров', 'номеров')} никого: либо их нет в Хронике, либо они не разрешили
          находить себя по номеру.
        </p>
      )}
      {found && found.length > 0 && <PeopleList people={found} />}
    </section>
  );
}
